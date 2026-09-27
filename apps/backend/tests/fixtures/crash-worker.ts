// Child process used by the crash-recovery test: runs a real email worker whose
// delivery announces itself and then hangs, so the parent can kill this process
// after deliveryStartedAt is written (simulating a crash right around SMTP
// acceptance). Usage: node --import tsx tests/fixtures/crash-worker.ts <queuePrefix> <rateLimitPrefix>
import '../setup.js';
import { createEmailWorker } from '../../src/queue/email.worker.js';
import { SendRateLimiter } from '../../src/services/rate-limit/send-rate-limiter.js';

const [prefix, rateLimitPrefix] = process.argv.slice(2);
if (!prefix || !rateLimitPrefix) throw new Error('queue prefix and rate-limit prefix arguments required');

createEmailWorker({
  prefix,
  rateLimiter: new SendRateLimiter({ keyPrefix: rateLimitPrefix }),
  stalled: { lockDuration: 1_000, stalledInterval: 500 },
  delivery: {
    deliver(email) {
      process.stdout.write(`DELIVERY_STARTED ${email.id}\n`);
      return new Promise(() => {}); // never settles; the parent kills us here
    },
  },
});
