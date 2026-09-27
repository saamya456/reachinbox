import { describe, expect, it } from 'vitest';
import { allTimeZones, browserTimeZone, formatLocalInput, resolveStart, ScheduleTimeError, tomorrowAt, zonedToInstant } from './time';

describe('time zone list', () => {
  it('offers the browser zone first, always offers UTC, and has no duplicates', () => {
    const zones = allTimeZones();
    expect(zones[0]).toBe(browserTimeZone());
    expect(zones).toContain('UTC');
    expect(zones).toContain('America/New_York');
    expect(new Set(zones).size).toBe(zones.length);
  });
});

describe('schedule time conversion', () => {
  it('converts wall-clock time in a zone to the right UTC instant', () => {
    expect(zonedToInstant('2026-10-01T09:30', 'Asia/Kolkata').toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(zonedToInstant('2026-07-01T09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z'); // EDT
    expect(zonedToInstant('2026-12-01T09:00', 'America/New_York').toISOString()).toBe('2026-12-01T14:00:00.000Z'); // EST
    expect(zonedToInstant('2026-12-01T09:00', 'UTC').toISOString()).toBe('2026-12-01T09:00:00.000Z');
  });

  it('rejects a time skipped by the spring-forward DST change', () => {
    expect(() => zonedToInstant('2026-03-08T02:30', 'America/New_York')).toThrow(ScheduleTimeError);
    try {
      zonedToInstant('2026-03-08T02:30', 'America/New_York');
    } catch (err) {
      expect((err as ScheduleTimeError).code).toBe('nonexistent');
    }
  });

  it('resolves an ambiguous fall-back time to a valid instant in that hour', () => {
    const instant = zonedToInstant('2026-11-01T01:30', 'America/New_York');
    expect(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']).toContain(instant.toISOString());
    expect(formatLocalInput(instant, 'America/New_York')).toBe('2026-11-01T01:30');
  });

  it('rejects past start times but tolerates "now"', () => {
    const now = new Date('2026-10-01T10:00:30Z');
    expect(() => resolveStart('2026-10-01T09:00', 'UTC', now)).toThrow(/past/);
    expect(resolveStart('2026-10-01T10:00', 'UTC', now).toISOString()).toBe('2026-10-01T10:00:00.000Z');
    expect(() => zonedToInstant('not-a-date', 'UTC')).toThrow(ScheduleTimeError);
  });

  it('builds "tomorrow at" presets in the chosen zone', () => {
    const now = new Date('2026-10-01T20:00:00Z'); // already Oct 2 in Kolkata
    expect(tomorrowAt(10, 'Asia/Kolkata', now)).toBe('2026-10-03T10:00');
    expect(tomorrowAt(15, 'UTC', now)).toBe('2026-10-02T15:00');
  });
});
