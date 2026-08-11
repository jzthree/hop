const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { sendMail, buildMessage, encodeHeaderValue, envelopeAddress } = require('../lib/mailer');

test('a built message carries the headers a real MTA needs', () => {
  const msg = buildMessage({
    from: 'hop <hop@zhoulab.io>',
    to: 'alice@uchicago.edu',
    subject: 'Confirm your hop subdomain',
    text: 'hello',
    messageId: '<fixed@test>',
    date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5))
  });
  assert.match(msg, /^From: hop <hop@zhoulab\.io>\r\n/);
  assert.match(msg, /\r\nTo: alice@uchicago\.edu\r\n/);
  assert.match(msg, /\r\nSubject: Confirm your hop subdomain\r\n/);
  assert.match(msg, /\r\nMessage-ID: <fixed@test>\r\n/);
  assert.match(msg, /\r\nMIME-Version: 1\.0\r\n/);
  assert.match(msg, /\r\nContent-Transfer-Encoding: base64\r\n/);
  // Headers and body are separated by exactly one blank line.
  const [headers, body] = msg.split('\r\n\r\n');
  assert.ok(!headers.includes('hello'));
  assert.equal(Buffer.from(body.trim(), 'base64').toString('utf8'), 'hello');
});

test('non-ASCII subjects are encoded rather than smuggled raw into a header', () => {
  assert.equal(encodeHeaderValue('plain ascii'), 'plain ascii');
  const encoded = encodeHeaderValue('café ☕');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(encoded.slice(10, -2), 'base64').toString('utf8'), 'café ☕');
});

test('a body that would break the protocol survives base64 intact', () => {
  // A bare "." line ends DATA; base64 means it can never appear as one.
  const nasty = 'line one\r\n.\r\nstill the same message\n' + 'x'.repeat(500) + '\név 😀';
  const msg = buildMessage({ from: 'a@b', to: 'c@d', subject: 's', text: nasty });
  const body = msg.split('\r\n\r\n')[1];
  assert.ok(!/\r\n\.\r\n/.test(body), 'no bare dot line in the encoded body');
  assert.ok(body.split('\r\n').every((l) => l.length <= 76), 'lines stay within SMTP limits');
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), nasty);
});

test('envelope addresses are unwrapped from display names', () => {
  assert.equal(envelopeAddress('hop <hop@zhoulab.io>'), 'hop@zhoulab.io');
  assert.equal(envelopeAddress('bare@example.com'), 'bare@example.com');
});

// A fake SMTP server: speaks just enough to record the conversation.
const fakeSmtp = (behavior = {}) => new Promise((resolve) => {
  const transcript = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let dataBuf = '';
    socket.setEncoding('utf8');
    // A client may drop the connection the moment it sends QUIT; a real MTA
    // shrugs at that, so the double must too (otherwise the reset surfaces
    // as an unhandled error after the test has already passed).
    socket.on('error', () => {});
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      if (inData) {
        dataBuf += chunk;
        if (dataBuf.includes('\r\n.\r\n')) {
          inData = false;
          transcript.push({ cmd: 'BODY', body: dataBuf.split('\r\n.\r\n')[0] });
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        transcript.push({ cmd: line });
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) socket.write('250-fake greets you\r\n250 AUTH LOGIN\r\n');
        else if (upper === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (upper.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
        else if (upper.startsWith('RCPT TO')) socket.write(behavior.rejectRecipient ? '550 no such user\r\n' : '250 ok\r\n');
        else if (upper === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (upper === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) {
          // base64 AUTH steps: username then password
          const seen = transcript.filter((t) => /^[A-Za-z0-9+/=]+$/.test(t.cmd)).length;
          socket.write(seen === 1 ? '334 UGFzc3dvcmQ6\r\n' : (behavior.rejectAuth ? '535 bad credentials\r\n' : '235 accepted\r\n'));
        } else socket.write('250 ok\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, transcript }));
});

test('a full send walks the SMTP conversation and delivers the body', async () => {
  const { server, port, transcript } = await fakeSmtp();
  try {
    const res = await sendMail(
      { host: '127.0.0.1', port, user: 'hop@zhoulab.io', pass: 'app-password', from: 'hop <hop@zhoulab.io>', insecure: true },
      { to: 'alice@uchicago.edu', subject: 'Confirm', text: 'click here' }
    );
    assert.equal(res.ok, true);
    const cmds = transcript.map((t) => t.cmd);
    assert.ok(cmds.some((c) => c.startsWith('EHLO')), 'said EHLO');
    assert.ok(cmds.includes('AUTH LOGIN'), 'authenticated');
    assert.ok(cmds.includes('MAIL FROM:<hop@zhoulab.io>'), 'envelope sender is the bare address');
    assert.ok(cmds.includes('RCPT TO:<alice@uchicago.edu>'), 'envelope recipient');
    const body = transcript.find((t) => t.cmd === 'BODY');
    assert.ok(body, 'body was transmitted');
    assert.match(body.body, /Subject: Confirm/);
    // The password must never appear in the clear anywhere in the exchange.
    assert.ok(!cmds.some((c) => c.includes('app-password')), 'credentials are base64, not plaintext');
  } finally {
    server.close();
  }
});

test('a rejected recipient surfaces the server’s reason, not a generic failure', async () => {
  const { server, port } = await fakeSmtp({ rejectRecipient: true });
  try {
    await assert.rejects(
      () => sendMail(
        { host: '127.0.0.1', port, user: 'u', pass: 'p', from: 'hop@zhoulab.io', insecure: true },
        { to: 'ghost@uchicago.edu', subject: 's', text: 't' }
      ),
      /RCPT TO failed.*550/s
    );
  } finally {
    server.close();
  }
});

test('bad credentials fail loudly at the AUTH step', async () => {
  const { server, port } = await fakeSmtp({ rejectAuth: true });
  try {
    await assert.rejects(
      () => sendMail(
        { host: '127.0.0.1', port, user: 'u', pass: 'wrong', from: 'hop@zhoulab.io', insecure: true },
        { to: 'alice@uchicago.edu', subject: 's', text: 't' }
      ),
      /AUTH password failed.*535/s
    );
  } finally {
    server.close();
  }
});

test('unencrypted SMTP to a remote host is refused outright', async () => {
  await assert.rejects(
    () => sendMail(
      { host: 'smtp.gmail.com', port: 587, user: 'u', pass: 'p', from: 'hop@zhoulab.io', insecure: true },
      { to: 'alice@uchicago.edu', subject: 's', text: 't' }
    ),
    /Refusing to send unencrypted SMTP/
  );
});

test('an unconfigured mailer explains itself instead of hanging', async () => {
  await assert.rejects(
    () => sendMail({ from: 'a@b' }, { to: 'c@d', subject: 's', text: 't' }),
    /Mail is not configured/
  );
});
