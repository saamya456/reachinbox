import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// SSRF protection for user-supplied SMTP servers.
//
// A sender's smtp_host/smtp_port make the worker open a TCP connection, so an
// unchecked value could target internal services (Redis, Postgres, cloud
// metadata, admin panels). Rules:
//  - only SMTP ports (25, 465, 587, 2525);
//  - a hostname must be fully qualified (single-label names such as "redis"
//    or "postgres" resolve to internal services, e.g. inside Docker);
//  - names like localhost, *.local, *.internal (incl. metadata.google.internal)
//    and *.home.arpa are rejected outright;
//  - EVERY address the name resolves to must be public: loopback, private,
//    link-local (incl. 169.254.169.254 metadata), CGNAT, documentation,
//    multicast, reserved and the IPv6 equivalents are blocked;
//  - at delivery time the host is resolved and checked again, and the SMTP
//    connection is made to that checked IP (TLS still verifies the
//    certificate against the hostname). This defeats DNS rebinding between
//    the check and the connection.

export const ALLOWED_SMTP_PORTS = [25, 465, 587, 2525] as const;

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (incl. Teredo)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local (incl. AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}
// IPv4-mapped IPv6 (::ffff:a.b.c.d) needs no rule of its own: BlockList checks it
// against the IPv4 rules. (A ::ffff:0:0/96 rule would match every IPv4 address.)

const BLOCKED_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|in-addr\.arpa|ip6\.arpa|localdomain)$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export class SmtpHostError extends Error {
  constructor(
    readonly code: 'invalid_host' | 'blocked_host' | 'unresolvable_host' | 'invalid_port',
    message: string,
  ) {
    super(message);
    this.name = 'SmtpHostError';
  }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

// Syntax-only normalization: lower-case, no trailing dot, hostname or IP literal.
export function normalizeSmtpHost(input: string): string {
  const host = input.trim().toLowerCase().replace(/\.$/, '');
  if (!host || host.length > 253) throw new SmtpHostError('invalid_host', 'SMTP host is not a valid hostname');
  if (isIP(host)) return host;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1)!)) {
    throw new SmtpHostError('invalid_host', 'SMTP host must be a fully qualified hostname or an IP address');
  }
  if (BLOCKED_NAME.test(host)) throw new SmtpHostError('blocked_host', 'SMTP host is not allowed');
  return host;
}

export function assertAllowedSmtpPort(port: number) {
  if (!(ALLOWED_SMTP_PORTS as readonly number[]).includes(port)) {
    throw new SmtpHostError('invalid_port', `SMTP port must be one of ${ALLOWED_SMTP_PORTS.join(', ')}`);
  }
}

// Resolves the host and requires every address to be public. Returns the
// normalized host and its (all public) addresses.
export async function resolvePublicSmtpHost(input: string): Promise<{ host: string; addresses: string[] }> {
  const host = normalizeSmtpHost(input);
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new SmtpHostError('unresolvable_host', 'SMTP host could not be resolved');
    }
  }
  if (addresses.length === 0) throw new SmtpHostError('unresolvable_host', 'SMTP host could not be resolved');
  if (!addresses.every(isPublicAddress)) {
    throw new SmtpHostError('blocked_host', 'SMTP host resolves to a private or reserved address');
  }
  return { host, addresses };
}
