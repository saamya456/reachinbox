// Delivery contract used by the processing service. The SMTP implementation is
// in smtp-delivery.service.ts; tests may substitute their own.

export interface DeliverableEmail {
  id: string;
  userId: string;
  senderId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  idempotencyKey: string;
}

export interface DeliveryResult {
  providerMessageId: string;
  previewUrl?: string | null;
}

export interface EmailDeliveryService {
  deliver(email: DeliverableEmail): Promise<DeliveryResult>;
}

// Throw this ONLY when the provider definitively did not accept the message
// (connection/authentication failed before anything was sent, or the server
// explicitly rejected the envelope or message). The email becomes FAILED.
//
// Any other error is treated as "outcome unknown": the provider may have
// accepted the message before the error surfaced. The email becomes
// DELIVERY_UNKNOWN and is never resent automatically.
export class DeliveryRejectedError extends Error {
  constructor(message: string, readonly code = 'DELIVERY_REJECTED') {
    super(message);
    this.name = 'DeliveryRejectedError';
  }
}

// Optional, for clearer logs: an error known to be ambiguous. Behaves like
// any other non-rejection error.
export class DeliveryOutcomeUnknownError extends Error {
  constructor(message: string, readonly code = 'DELIVERY_OUTCOME_UNKNOWN') {
    super(message);
    this.name = 'DeliveryOutcomeUnknownError';
  }
}
