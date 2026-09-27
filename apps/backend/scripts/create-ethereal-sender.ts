// Development helper: creates a fresh Ethereal SMTP account and stores it as a
// Sender for an existing user, with the password encrypted (ENCRYPTION_KEY).
// Usage: npm run sender:ethereal -w apps/backend -- <userId> [hourlyLimit]
// Ethereal never delivers to real inboxes; open previewUrl to see a message.
import { encryptSecret } from '../src/lib/crypto.js';
import { logger } from '../src/lib/logger.js';
import { prisma } from '../src/lib/prisma.js';
import { createEtherealAccount } from '../src/services/ethereal.js';

const [userId, hourlyLimitArg = '100'] = process.argv.slice(2);
if (!userId) {
  console.error('Usage: create-ethereal-sender <userId> [hourlyLimit]');
  process.exit(1);
}

try {
  const account = await createEtherealAccount();
  const sender = await prisma.sender.create({
    data: {
      userId,
      email: account.user,
      displayName: 'ReachInbox (Ethereal)',
      smtpHost: account.smtp.host,
      smtpPort: account.smtp.port,
      smtpSecure: account.smtp.secure,
      smtpUser: account.user,
      smtpPasswordEncrypted: encryptSecret(account.pass),
      hourlyLimit: Number(hourlyLimitArg),
    },
    select: { id: true, email: true, smtpHost: true, smtpPort: true, hourlyLimit: true },
  });
  // The password is never printed; log in at https://ethereal.email with it only if you
  // need the web inbox (it is recoverable via decryptSecret in a trusted shell).
  logger.info('ethereal sender created', { ...sender });
} finally {
  await prisma.$disconnect();
}
