// A real SMTP endpoint that accepts every message and keeps none.
//
// WHY IT EXISTS: creating an org invite delivers its accept link through the backend's real
// nodemailer transport, and on a delivery failure the invite is deliberately revoked before the
// error surfaces — so on a machine where nothing listens at the SMTP address in `backend/.env.test`,
// the Team page cannot create an invite at all and the pending-invite UI is untestable. This sink is
// the same move as `graphStub.mjs`: replace the one external system (the mail server) at the network
// boundary, and leave every line of our own code — the transport, the port, the revoke-on-failure
// ordering — running exactly as it does in production.
//
// WHY IT DISCARDS: nothing in this suite can read an invite through to acceptance anyway — accepting
// sits behind the email-verification gate, and only the stack's boot-time database flip can verify an
// account. Capturing mail would be storage in service of nothing. The failure mode stays honest: the
// sink accepts or the connection breaks, and a broken connection still fails the invite loudly.
//
// The dialogue is the minimum nodemailer needs: greeting, EHLO with AUTH advertised (nodemailer is
// configured with credentials and will attempt AUTH LOGIN even against a server that stays silent
// about it, so advertising and accepting is the shortest honest path), MAIL/RCPT/DATA/QUIT.
import { createServer } from 'node:net';

export async function startMailSink() {
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    /** 'command' | 'data' | 'auth' — AUTH LOGIN sends the two credential lines outside any verb. */
    let mode = 'command';
    let authLinesLeft = 0;

    socket.write('220 commerce-e2e-sink ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buffer = buffer.slice(end + 5);
          mode = 'command';
          socket.write('250 OK\r\n');
          continue;
        }

        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);

        if (mode === 'auth') {
          authLinesLeft -= 1;
          socket.write(authLinesLeft > 0 ? '334 UGFzc3dvcmQ6\r\n' : '235 OK\r\n');
          if (authLinesLeft <= 0) mode = 'command';
          continue;
        }

        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-commerce-e2e-sink\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (verb === 'AUTH') {
          if (/^AUTH PLAIN .+$/i.test(line)) {
            socket.write('235 OK\r\n');
          } else if (/^AUTH PLAIN$/i.test(line)) {
            mode = 'auth';
            authLinesLeft = 1;
            socket.write('334 \r\n');
          } else {
            // AUTH LOGIN: username line, then password line.
            mode = 'auth';
            authLinesLeft = 2;
            socket.write('334 VXNlcm5hbWU6\r\n');
          }
        } else if (verb === 'DATA') {
          mode = 'data';
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 Bye\r\n');
          socket.end();
        } else {
          // MAIL FROM, RCPT TO, RSET, NOOP — all accepted; the sink judges nothing.
          socket.write('250 OK\r\n');
        }
      }
    });

    // A peer that vanishes mid-dialogue is nodemailer's problem to report, not this process's crash.
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
