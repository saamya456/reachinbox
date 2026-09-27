// Development only: prints a session cookie value for a local user, for
// browser end-to-end checks on machines without Google OAuth credentials.
// It needs direct database access and is refused in production; it is NOT a
// login path of the application (the app only signs users in via Google).
// Usage: npm run dev:session -w apps/backend -- <email> [name]
import { env } from '../src/config/env.js';
import { createSession } from '../src/auth/session.js';
import { prisma } from '../src/lib/prisma.js';
import { closeRedisConnection } from '../src/queue/connection.js';

if (env.NODE_ENV === 'production') {
  console.error('create-dev-session is disabled in production');
  process.exit(1);
}
const [email, name = 'Dev User'] = process.argv.slice(2);
if (!email) {
  console.error('Usage: create-dev-session <email> [name]');
  process.exit(1);
}

try {
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    create: { email: email.toLowerCase(), name, googleId: `dev:${email.toLowerCase()}` },
    update: {},
    select: { id: true, email: true },
  });
  const sessionId = await createSession(user.id);
  console.log(JSON.stringify({ userId: user.id, email: user.email, cookie: 'ri_sid', sessionId }));
} finally {
  await closeRedisConnection();
  await prisma.$disconnect();
}
