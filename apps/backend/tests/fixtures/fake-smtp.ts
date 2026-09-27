// Minimal SMTP server over real TCP for failure modes a public provider cannot
// produce on demand. nodemailer talks to it exactly as to any SMTP server.
import net from 'node:net';

export type FakeSmtpMode =
  | 'accept' // 250 queued
  | 'reject_auth' // 535 at AUTH
  | 'reject_rcpt' // 550 at RCPT TO
  | 'reject_message' // 554 after the message body
  | 'drop_after_data' // receives the whole message, then closes without replying
  | 'hang_after_data'; // receives the whole message, never replies

export interface FakeSmtpServer {
  port: number;
  // Raw messages fully received (everything between DATA and the final dot).
  messages: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(mode: FakeSmtpMode): Promise<FakeSmtpServer> {
  const messages: string[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);

    let buffer = '';
    let inData = false;
    reply('220 fake.smtp ESMTP ready');

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          messages.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          if (mode === 'drop_after_data') {
            socket.destroy();
            return;
          }
          if (mode === 'hang_after_data') return;
          if (mode === 'reject_message') reply('554 5.7.1 Message rejected');
          else reply(`250 2.0.0 Ok: queued as FAKE${messages.length}`);
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) socket.write('250-fake.smtp\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (cmd.startsWith('HELO')) reply('250 fake.smtp');
        else if (cmd.startsWith('AUTH')) {
          reply(mode === 'reject_auth' ? '535 5.7.8 Authentication credentials invalid' : '235 2.7.0 Authentication successful');
        } else if (cmd.startsWith('MAIL FROM')) reply('250 2.1.0 Ok');
        else if (cmd.startsWith('RCPT TO')) reply(mode === 'reject_rcpt' ? '550 5.1.1 No such user' : '250 2.1.5 Ok');
        else if (cmd === 'DATA') {
          reply('354 End data with <CR><LF>.<CR><LF>');
          inData = true;
        } else if (cmd === 'RSET') reply('250 Ok');
        else if (cmd === 'QUIT') {
          reply('221 Bye');
          socket.end();
        } else reply('502 Command not implemented');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    messages,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
