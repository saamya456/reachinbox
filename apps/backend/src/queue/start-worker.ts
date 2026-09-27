import { logger } from '../lib/logger.js';
import { reconcileEmailJobs, type ReconcileResult } from '../services/email-scheduler.service.js';
import { getEmailQueue, type EmailQueue } from './email.queue.js';
import { createEmailWorker, type EmailWorker, type EmailWorkerOptions } from './email.worker.js';

export interface StartEmailWorkerOptions extends Omit<EmailWorkerOptions, 'autorun'> {
  queue?: EmailQueue;
  // Limit reconciliation to one tenant (tests / targeted repair).
  userId?: string;
}

export interface StartedEmailWorker {
  worker: EmailWorker;
  // null when reconciliation failed (processing still starts).
  reconciliation: ReconcileResult | null;
  // When the reconciliation pass finished and processing was started.
  processingStartedAt: Date;
}

// Starts the email worker in two steps: one reconciliation pass between
// PostgreSQL and BullMQ, then normal processing. This runs once per process
// start; nothing here repeats on a timer.
export async function startEmailWorker({
  queue = getEmailQueue(),
  userId,
  ...workerOptions
}: StartEmailWorkerOptions = {}): Promise<StartedEmailWorker> {
  // Created paused so no job is processed before reconciliation completes.
  const worker = createEmailWorker({ ...workerOptions, autorun: false });

  let reconciliation: ReconcileResult | null = null;
  try {
    reconciliation = await reconcileEmailJobs({ queue, userId });
    logger.info('startup reconciliation finished', { ...reconciliation });
  } catch (err) {
    // Jobs already in Redis should still run. The next start (or a manual
    // `npm run queue:reconcile`) repeats the pass.
    logger.error('startup reconciliation failed; starting processing anyway', { err });
  }

  const processingStartedAt = new Date();
  void worker.run().catch((err) => logger.error('email worker stopped with an error', { err }));
  logger.info('email worker processing started', { concurrency: worker.concurrency });

  return { worker, reconciliation, processingStartedAt };
}
