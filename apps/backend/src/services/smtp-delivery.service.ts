import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { decryptSecret } from '../lib/crypto.js';
import { htmlToText, looksLikeHtml, sanitizeEmailHtml } from '../lib/html.js';
import { prisma } from '../lib/prisma.js';
import { assertAllowedSmtpPort, resolvePublicSmtpHost, SmtpHostError } from '../security/smtp-host.js';
import {
  DeliveryOutcomeUnknownError,
  DeliveryRejectedError,
  type DeliverableEmail,
  type DeliveryResult,
  type EmailDeliveryService,
} from './email-delivery.service.js';

// Real SMTP delivery (Ethereal in development) using nodemailer's
// SMTPConnection, driven in three explicit phases so failures can be
// classified by *when* they happened:
//
//   connect  (TCP/TLS + greeting + EHLO/STARTTLS)
//   login    (AUTH)
//   send     (MAIL FROM, RCPT TO, DATA + message body, final reply)
//
// Classification (assumptions documented in the README):
//  - any failure in connect or login -> REJECTED. No message exists on the wire yet.
//  - send failure with code EENVELOPE -> REJECTED. The server refused MAIL FROM / RCPT TO /
//    the DATA command (or the address was invalid), so the body was never transmitted.
//  - send failure with code EMESSAGE carrying an SMTP reply code -> REJECTED. The server
//    explicitly answered the message with 4xx/5xx, i.e. it did not accept it.
//  - every other send failure (socket closed/reset, timeout, protocol error, ...) -> UNKNOWN.
//    nodemailer reports socket-level failures as command "CONN" at every stage, so
//    they cannot be told apart from a drop after the server accepted the message.
//
// transport.sendMail() is deliberately not used: it hides which phase failed.
//
// SSRF: the host is resolved and checked (public addresses, SMTP ports only)
// right before connecting, and the connection goes to that checked IP with
// TLS verifying the certificate against the hostname, so DNS rebinding after
// the sender was saved cannot redirect the connection to an internal service.
//
// The SMTP password is decrypted here, used for AUTH and never returned,
// logged or included in errors.

export interface SmtpDeliveryOptions {
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
  // Tests only (local SMTP server on 127.0.0.1). Never enabled in the app.
  allowPrivateHosts?: boolean;
}

interface SmtpError extends Error {
  code?: string;
  responseCode?: number;
  command?: string;
}

export function createSmtpDelivery({
  connectionTimeoutMs = 10_000,
  greetingTimeoutMs = 10_000,
  socketTimeoutMs = 30_000,
  allowPrivateHosts = false,
}: SmtpDeliveryOptions = {}): EmailDeliveryService {
  return {
    async deliver(email: DeliverableEmail): Promise<DeliveryResult> {
      const sender = await prisma.sender.findFirst({
        where: { id: email.senderId, userId: email.userId },
        select: {
          email: true,
          displayName: true,
          smtpHost: true,
          smtpPort: true,
          smtpSecure: true,
          smtpUser: true,
          smtpPasswordEncrypted: true,
        },
      });
      if (!sender) throw new DeliveryRejectedError('Sender not found', 'SENDER_NOT_FOUND');

      let password: string;
      try {
        password = decryptSecret(sender.smtpPasswordEncrypted);
      } catch {
        throw new DeliveryRejectedError('SMTP credentials could not be decrypted', 'SMTP_CREDENTIALS_INVALID');
      }

      // Deterministic Message-ID from the idempotency key: the same logical
      // email always carries the same id, which lets a DELIVERY_UNKNOWN email
      // be looked up at the provider and lets receivers de-duplicate.
      const senderDomain = sender.email.split('@')[1] ?? 'reachinbox.local';
      const messageId = `<${email.idempotencyKey}@${senderDomain}>`;
      const raw = await new MailComposer({
        from: sender.displayName ? { name: sender.displayName, address: sender.email } : sender.email,
        to: email.recipientEmail,
        subject: email.subject,
        text: htmlToText(email.body),
        // Stored bodies are already sanitized; sanitizing again on send is cheap insurance.
        ...(looksLikeHtml(email.body) ? { html: sanitizeEmailHtml(email.body) } : {}),
        messageId,
      })
        .compile()
        .build();

      let connectHost = sender.smtpHost;
      let servername: string | undefined;
      if (!allowPrivateHosts) {
        try {
          assertAllowedSmtpPort(sender.smtpPort);
          const target = await resolvePublicSmtpHost(sender.smtpHost);
          connectHost = target.addresses[0]!;
          servername = isIP(target.host) ? undefined : target.host;
        } catch (err) {
          if (err instanceof SmtpHostError) {
            throw new DeliveryRejectedError(`SMTP host rejected: ${err.message}`, 'SMTP_HOST_BLOCKED');
          }
          throw err;
        }
      }

      const connection = new SMTPConnection({
        host: connectHost,
        servername,
        port: sender.smtpPort,
        secure: sender.smtpSecure,
        connectionTimeout: connectionTimeoutMs,
        greetingTimeout: greetingTimeoutMs,
        socketTimeout: socketTimeoutMs,
      });
      // Errors are handled per phase; this keeps a late socket error from
      // becoming an unhandled 'error' event.
      connection.on('error', () => {});

      try {
        try {
          await phase<void>(connection, (done) => connection.connect((err) => done(err ?? null)));
        } catch (err) {
          throw rejected('connect', err);
        }
        try {
          await phase<boolean | undefined>(connection, (done) =>
            connection.login({ user: sender.smtpUser, pass: password }, done),
          );
        } catch (err) {
          throw rejected('login', err);
        }

        let info: SMTPConnection.SentMessageInfo;
        try {
          info = await phase<SMTPConnection.SentMessageInfo>(connection, (done) =>
            connection.send({ from: sender.email, to: [email.recipientEmail] }, raw, (err, result) =>
              done(err, result),
            ),
          );
        } catch (err) {
          throw classifySendError(err);
        }
        if (!info.accepted.includes(email.recipientEmail)) {
          throw new DeliveryRejectedError('Recipient was not accepted', 'SMTP_RECIPIENT_REJECTED');
        }

        return {
          providerMessageId: providerIdFrom(info.response) ?? messageId,
          previewUrl: nodemailer.getTestMessageUrl({ response: info.response } as never) || null,
        };
      } finally {
        connection.quit();
      }
    },
  };
}

// Runs one SMTPConnection step, settling on its callback, an 'error' event or
// the connection ending, whichever comes first.
function phase<T>(connection: SMTPConnection, start: (done: (err: Error | null, result?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    const onError = (err: Error) => finish(err);
    const onEnd = () => finish(Object.assign(new Error('Connection closed'), { code: 'ECONNECTION' }));
    function finish(err: Error | null, result?: T) {
      connection.off('error', onError);
      connection.off('end', onEnd);
      if (err) reject(err);
      else resolve(result as T);
    }
    connection.once('error', onError);
    connection.once('end', onEnd);
    start(finish);
  });
}

function describe(err: unknown): { message: string; code: string } {
  const e = err as SmtpError;
  return { message: (e?.message ?? String(err)).slice(0, 500), code: e?.code ?? 'UNKNOWN' };
}

function rejected(stage: 'connect' | 'login', err: unknown) {
  const { message, code } = describe(err);
  return new DeliveryRejectedError(`SMTP ${stage} failed: ${message}`, `SMTP_${code}`);
}

export function classifySendError(err: unknown): Error {
  const e = err as SmtpError;
  const { message, code } = describe(err);
  if (e?.code === 'EENVELOPE') {
    return new DeliveryRejectedError(`SMTP envelope rejected: ${message}`, `SMTP_EENVELOPE${e.responseCode ? `_${e.responseCode}` : ''}`);
  }
  if (e?.code === 'EMESSAGE' && (typeof e.responseCode === 'number' || e.command === 'API' || e.command === 'MAIL FROM')) {
    return new DeliveryRejectedError(`SMTP message rejected: ${message}`, `SMTP_EMESSAGE${e.responseCode ? `_${e.responseCode}` : ''}`);
  }
  return new DeliveryOutcomeUnknownError(`SMTP send interrupted (${code}): ${message}`, `SMTP_${code}`);
}

// Provider-assigned id from the final SMTP reply, e.g. Ethereal's
// "250 Accepted [STATUS=new MSGID=...]" or Postfix's "250 2.0.0 Ok: queued as ABC123".
function providerIdFrom(response: string | undefined): string | null {
  if (!response) return null;
  return /\bMSGID=([^\s\]]+)/.exec(response)?.[1] ?? /queued as ([^\s]+)/i.exec(response)?.[1] ?? null;
}

let defaultDelivery: EmailDeliveryService | undefined;

export function getSmtpDelivery(): EmailDeliveryService {
  defaultDelivery ??= createSmtpDelivery();
  return defaultDelivery;
}
