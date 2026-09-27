// Creates a fresh Ethereal (fake SMTP) account.
//
// nodemailer.createTestAccount() caches the first account for the whole
// process (unless ETHEREAL_CACHE=no is set before nodemailer loads), so a
// long-running API would hand out the same account again. This calls the same
// Ethereal endpoint directly, uncached.

const ETHEREAL_API = 'https://api.nodemailer.com/user';

export interface EtherealAccount {
  user: string;
  pass: string;
  smtp: { host: string; port: number; secure: boolean };
}

export async function createEtherealAccount(): Promise<EtherealAccount> {
  const response = await fetch(ETHEREAL_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestor: 'reachinbox-scheduler', version: '1.0.0' }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await response.json().catch(() => null)) as
    | { status?: string; user?: unknown; pass?: unknown; smtp?: { host?: unknown; port?: unknown; secure?: unknown } }
    | null;
  if (
    !response.ok ||
    data?.status !== 'success' ||
    typeof data.user !== 'string' ||
    typeof data.pass !== 'string' ||
    typeof data.smtp?.host !== 'string' ||
    typeof data.smtp.port !== 'number'
  ) {
    throw new Error('Could not create an Ethereal account');
  }
  return { user: data.user, pass: data.pass, smtp: { host: data.smtp.host, port: data.smtp.port, secure: data.smtp.secure === true } };
}
