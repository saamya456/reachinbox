import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import { logger } from '../../lib/logger.js';
import { getRedisConnection } from '../../queue/connection.js';

// Redis-backed send coordination shared by every worker process.
//
// All state lives in Redis and every decision is made inside a Lua script
// (atomic on the Redis server) using the Redis server clock (TIME), so workers
// on different hosts neither race nor disagree about time.
//
// Two steps per email:
//
// 1. reserve (hourly limit + planned spacing). Hourly windows are fixed,
//    aligned to the clock (window = floor(t / windowMs)). Per sender and window
//    a hash holds { count, cursor }; per campaign and window a hash holds
//    { count }. Reserving checks both counts against their limits and, if the
//    window has room, takes slot = max(now, windowStart, cursor), then sets
//    cursor = slot + delay and increments both counts, all in one script. If the
//    window is full (sender or campaign limit), or the spacing cursor has run
//    past its end, the next window is tried. The reservation is stored per
//    email (resv:<emailId> = slot), so asking again returns the same slot and
//    never counts twice. Because checking and incrementing happen in one
//    script, N concurrent reservations against limit L can never exceed L.
//
// 2. acquire (minimum delay at send time). Immediately before SMTP, the gate
//    script checks the email's reservation and the sender's gate
//    (the earliest time the next send may start). It succeeds only if
//    now >= slot and now >= gate, then sets gate = now + delay and consumes the
//    reservation. So no two sends from one sender are authorized less than
//    `delay` apart, whatever worker or process they run in.
//
// A reservation whose window has already elapsed (the job ran late, e.g. after
// an outage) is dropped by acquire and a fresh one is made in the current
// window, so a limit is never exceeded by late sends.
//
// Expiry: window hashes expire one window after their window ends,
// reservations expire one window after their slot, and the gate expires
// `delay + windowMs` after the last send. Stale state therefore cannot block
// sending permanently. A slot is consumed when it is reserved; it is never
// refunded (not on SMTP rejection, not on a crash), which is conservative.

export const HOUR_MS = 60 * 60 * 1000;

export type LimitScope = 'sender' | 'campaign' | 'spacing';

export interface SlotRequest {
  emailId: string;
  senderId: string;
  campaignId: string;
  delayMs: number;
  senderHourlyLimit: number;
  campaignHourlyLimit: number;
}

export type SlotDecision =
  | { kind: 'acquired'; at: Date }
  | {
      kind: 'deferred';
      until: Date;
      // true: pushed to a later window because a limit (or spacing) filled the current one.
      limited: boolean;
      scope?: LimitScope;
      // true only for the first email pushed out of this sender/campaign window.
      notify: boolean;
      limitedWindowStart?: Date;
    };

export interface SendRateLimiterOptions {
  redis?: Redis;
  keyPrefix?: string;
  windowMs?: number;
  // Waits up to this long are done in-process; longer ones re-delay the job.
  maxInlineWaitMs?: number;
  // How many windows ahead a reservation may look.
  maxWindows?: number;
}

const RESERVE_SCRIPT = `
local prefix, sid, cid, eid = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
local delay = tonumber(ARGV[5])
local slimit = tonumber(ARGV[6])
local climit = tonumber(ARGV[7])
local windowMs = tonumber(ARGV[8])
local maxWindows = tonumber(ARGV[9])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local stag = prefix .. ':{s:' .. sid .. '}'
local resvKey = stag .. ':resv:' .. eid

local existing = redis.call('GET', resvKey)
if existing then
  return { 'existing', existing, tostring(now), '0', '', '0' }
end

local w0 = math.floor(now / windowMs)
local scope = ''
for i = 0, maxWindows - 1 do
  local w = w0 + i
  local wstart = w * windowMs
  local wend = wstart + windowMs
  local skey = stag .. ':w:' .. w
  local ckey = prefix .. ':c:' .. cid .. ':w:' .. w
  local scount = tonumber(redis.call('HGET', skey, 'count') or '0')
  local ccount = tonumber(redis.call('HGET', ckey, 'count') or '0')
  local blocked
  if scount >= slimit then
    blocked = 'sender'
  elseif ccount >= climit then
    blocked = 'campaign'
  else
    local cursor = tonumber(redis.call('HGET', skey, 'cursor') or '0')
    local slot = math.max(now, wstart, cursor)
    if slot < wend then
      redis.call('HINCRBY', skey, 'count', 1)
      redis.call('HSET', skey, 'cursor', slot + delay)
      redis.call('PEXPIREAT', skey, wend + windowMs)
      redis.call('HINCRBY', ckey, 'count', 1)
      redis.call('PEXPIREAT', ckey, wend + windowMs)
      redis.call('SET', resvKey, slot, 'PX', math.max(1, slot - now) + windowMs)
      local notify = 0
      if i > 0 then
        local nkey = stag .. ':w:' .. w0
        if scope == 'campaign' then nkey = prefix .. ':c:' .. cid .. ':w:' .. w0 end
        notify = redis.call('HSETNX', nkey, 'notified_' .. scope, 1)
        redis.call('PEXPIREAT', nkey, (w0 + 2) * windowMs)
      end
      return { 'reserved', tostring(slot), tostring(now), tostring(i), scope, tostring(notify) }
    end
    blocked = 'spacing'
  end
  if i == 0 then scope = blocked end
end
return { 'exhausted', tostring((w0 + maxWindows) * windowMs), tostring(now), tostring(maxWindows), scope, '0' }
`;

const ACQUIRE_SCRIPT = `
local prefix, sid, eid = ARGV[1], ARGV[2], ARGV[3]
local delay = tonumber(ARGV[4])
local windowMs = tonumber(ARGV[5])

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local stag = prefix .. ':{s:' .. sid .. '}'
local resvKey = stag .. ':resv:' .. eid
local gateKey = stag .. ':gate'

local resv = redis.call('GET', resvKey)
if not resv then
  return { 'no_reservation', '0', tostring(now) }
end
local slot = tonumber(resv)
if math.floor(slot / windowMs) < math.floor(now / windowMs) then
  redis.call('DEL', resvKey)
  return { 'stale', '0', tostring(now) }
end
if now < slot then
  return { 'wait', tostring(slot - now), tostring(now) }
end
local gate = tonumber(redis.call('GET', gateKey) or '0')
if now < gate then
  return { 'wait', tostring(gate - now), tostring(now) }
end
redis.call('SET', gateKey, now + delay, 'PX', delay + windowMs)
redis.call('DEL', resvKey)
return { 'acquired', tostring(now), tostring(now) }
`;

type ReserveReply = [status: string, slot: string, now: string, windowOffset: string, scope: string, notify: string];
type AcquireReply = [status: string, value: string, now: string];

// Sanity bound only; the inline-wait time budget ends the loop long before.
const MAX_ROUNDS = 100_000;

export class SendRateLimiter {
  private readonly redis: Redis;
  readonly keyPrefix: string;
  readonly windowMs: number;
  private readonly maxInlineWaitMs: number;
  private readonly maxWindows: number;

  constructor({
    redis = getRedisConnection(),
    keyPrefix = 'rl',
    windowMs = HOUR_MS,
    maxInlineWaitMs = 5_000,
    maxWindows = 24 * 7,
  }: SendRateLimiterOptions = {}) {
    this.redis = redis;
    this.keyPrefix = keyPrefix;
    this.windowMs = windowMs;
    this.maxInlineWaitMs = maxInlineWaitMs;
    this.maxWindows = maxWindows;
  }

  // Reserves a send slot (idempotent per email). Exposed for tests/inspection;
  // processing uses acquire().
  async reserve(req: SlotRequest) {
    const [status, slot, now, windowOffset, scope, notify] = (await this.redis.eval(
      RESERVE_SCRIPT,
      0,
      this.keyPrefix,
      req.senderId,
      req.campaignId,
      req.emailId,
      req.delayMs,
      req.senderHourlyLimit,
      req.campaignHourlyLimit,
      this.windowMs,
      this.maxWindows,
    )) as ReserveReply;
    return {
      status: status as 'reserved' | 'existing' | 'exhausted',
      slot: Number(slot),
      now: Number(now),
      windowOffset: Number(windowOffset),
      scope: (scope || undefined) as LimitScope | undefined,
      notify: notify === '1',
    };
  }

  // Decides whether this email may be sent now. 'acquired' means the send is
  // authorized at `at` (Redis time) and must happen immediately; 'deferred'
  // means the caller must put the email back and retry at `until`.
  //
  // Inline waiting is bounded by a time budget (maxInlineWaitMs in total), not
  // by a number of attempts: several due emails of one sender may contend for
  // the gate, and each gets it in turn. Past the budget the email is deferred
  // (re-delayed), never failed.
  async acquire(req: SlotRequest): Promise<SlotDecision> {
    const log = logger.child({ emailId: req.emailId, senderId: req.senderId, campaignId: req.campaignId });
    let waited = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const [status, value, nowRaw] = (await this.redis.eval(
        ACQUIRE_SCRIPT,
        0,
        this.keyPrefix,
        req.senderId,
        req.emailId,
        req.delayMs,
        this.windowMs,
      )) as AcquireReply;
      const now = Number(nowRaw);

      if (status === 'acquired') return { kind: 'acquired', at: new Date(Number(value)) };

      if (status === 'wait') {
        const waitMs = Number(value);
        if (waited + waitMs <= this.maxInlineWaitMs) {
          await sleep(waitMs);
          waited += waitMs;
          continue;
        }
        return { kind: 'deferred', until: new Date(now + waitMs), limited: false, notify: false };
      }

      // 'no_reservation' or 'stale': reserve a slot.
      const r = await this.reserve(req);
      const limited = r.status === 'exhausted' || r.windowOffset > 0;
      log.info('rate limit reservation', {
        status: r.status,
        slot: new Date(r.slot).toISOString(),
        windowOffset: r.windowOffset,
        delayMs: req.delayMs,
        senderHourlyLimit: req.senderHourlyLimit,
        campaignHourlyLimit: req.campaignHourlyLimit,
      });

      if (limited) {
        const limitedWindowStart = new Date(Math.floor(r.now / this.windowMs) * this.windowMs);
        log.warn('rate limit reached', {
          scope: r.scope,
          window: limitedWindowStart.toISOString(),
          nextSlot: new Date(r.slot).toISOString(),
        });
        return { kind: 'deferred', until: new Date(r.slot), limited: true, scope: r.scope, notify: r.notify, limitedWindowStart };
      }
      if (r.slot - r.now > this.maxInlineWaitMs - waited) {
        return { kind: 'deferred', until: new Date(r.slot), limited: false, notify: false };
      }
      // Slot is (nearly) now: the next acquire round waits for it inline.
    }
    // Unreachable in practice: every round waits (bounded by the budget above)
    // or reserves, and a fresh reservation is acquired or waited for next round.
    throw new Error('Rate limiter did not converge');
  }
}

let defaultLimiter: SendRateLimiter | undefined;

export function getSendRateLimiter(): SendRateLimiter {
  defaultLimiter ??= new SendRateLimiter();
  return defaultLimiter;
}
