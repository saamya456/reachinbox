// Child process for the multi-process rate-limit test: a real email worker
// (concurrency 1) sharing Redis rate-limit state with other processes. Its
// delivery only reports what it would send.
// Usage: node --import tsx tests/fixtures/rate-worker.ts <queuePrefix> <rateLimitPrefix> <deliveryMs>
import '../setup.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { createEmailWorker } from '../../src/queue/email.worker.js';
import { SendRateLimiter } from '../../src/services/rate-limit/send-rate-limiter.js';

const [prefix, rateLimitPrefix, deliveryMs = '0'] = process.argv.slice(2);
if (!prefix || !rateLimitPrefix) throw new Error('queue prefix and rate-limit prefix arguments required');

const worker = createEmailWorker({
  prefix,
  concurrency: 1,
  rateLimiter: new SendRateLimiter({ keyPrefix: rateLimitPrefix }),
  delivery: {
    async deliver(email) {
      process.stdout.write(`SENT ${email.id} ${process.pid}\n`);
      await sleep(Number(deliveryMs));
      return { providerMessageId: `child-${email.id}` };
    },
  },
});
worker.on('ready', () => process.stdout.write(`READY ${process.pid}\n`));
