import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';

// Internal event boundary. Phase 5 (Slack notifications) subscribes here;
// nothing in this phase sends notifications.
//
// hourlyLimitReached fires in whichever worker process hit the limit, at most
// once per sender (or campaign) and window across all processes: the reserve
// script marks the window with HSETNX before this event is emitted.

export interface HourlyLimitReachedEvent {
  userId: string;
  senderId: string;
  campaignId: string;
  // Which limit filled the window: sender hourly limit, campaign hourly limit,
  // or the window cannot fit more sends at the configured minimum delay.
  scope: 'sender' | 'campaign' | 'spacing';
  windowStart: Date;
  // When the first rescheduled email will be attempted.
  nextSlotAt: Date;
  // The email that triggered the event.
  emailId: string;
}

interface EmailEventMap {
  hourlyLimitReached: [HourlyLimitReachedEvent];
}

export const emailEvents = new EventEmitter<EmailEventMap>();

// Calls each subscriber in isolation: a failing subscriber neither breaks email
// processing nor prevents the others (e.g. Slack) from running.
export function emitHourlyLimitReached(event: HourlyLimitReachedEvent): void {
  for (const listener of emailEvents.listeners('hourlyLimitReached')) {
    try {
      listener(event);
    } catch (err) {
      logger.error('hourlyLimitReached subscriber failed', { err, senderId: event.senderId });
    }
  }
}
