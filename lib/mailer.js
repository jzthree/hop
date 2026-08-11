// Minimal SMTP client — just enough to send hop's registration mail.
//
// Deliberately dependency-free: hop's host-side deps are kept few and boring,
// and what we need is a small, well-specified subset (EHLO, AUTH LOGIN, one
// recipient, one text body). The socket factory is injectable so the whole
// conversation is testable against a fake server with no TLS and no network.
//
// Implicit TLS (port 465) is the default and the recommended setting.
// STARTTLS (587) is supported because some relays only offer that.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const CRLF = '\r\n';
const SMTP_TIMEOUT_MS = 20000;

/** RFC 2047 encoded-word, so a non-ASCII subject survives the header. */
const encodeHeaderValue = (value) => {
  const text = String(value == null ? '' : value);
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
};

/** Fold a base64 body to the 76-char lines SMTP expects. */
const wrap76 = (b64) => (b64.match(/.{1,76}/g) || []).join(CRLF);

/**
 * Build the full RFC 5322 message. Pure — no IO — so the header set and
 * escaping are testable on their own.
 */
function buildMessage({ from, to, subject, text, messageId, date }) {
  const id = messageId || `<${crypto.randomUUID()}@${os.hostname() || 'hop'}>`;
  const when = (date || new Date()).toUTCString().replace(/GMT$/, '+0000');
  // base64 sidesteps every line-length, dot-stuffing and 8-bit concern at
  // once — an emoji or an 80-column paragraph cannot corrupt the body.
  const body = wrap76(Buffer.from(String(text ?? ''), 'utf8').toString('base64'));
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${when}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64'
  ];
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

/** Extract the bare address from "Name <a@b>" for the SMTP envelope. */
const envelopeAddress = (value) => {
  const match = /<([^>]+)>/.exec(String(value || ''));
  return (match ? match[1] : String(value || '')).trim();
};

/**
 * Drive one SMTP conversation.
 * @param {object} config { host, port, user, pass, from, secure, insecure }
 * @param {object} message { to, subject, text }
 * @param {object} deps  { connect } — injectable for tests
 */
async function sendMail(config, message, deps = {}) {
  const host = String(config?.host || '').trim();
  const port = Number(config?.port) || 465;
  if (!host) throw new Error('Mail is not configured (no SMTP host).');
  if (!config?.from) throw new Error('Mail is not configured (no From address).');
  if (!message?.to) throw new Error('No recipient.');

  // Plaintext is allowed only against loopback (the test fake). Anywhere else
  // it would put an SMTP password on the wire in the clear.
  const loopback = /^(127\.|::1$|localhost$)/.test(host);
  if (config.insecure && !loopback) {
    throw new Error('Refusing to send unencrypted SMTP to a remote host.');
  }
  const useImplicitTls = config.insecure ? false : config.secure !== false && port === 465;

  const connect = deps.connect || ((opts) => (useImplicitTls
    ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
    : net.connect({ host: opts.host, port: opts.port })));

  const socket = connect({ host, port });
  socket.setEncoding('utf8');
  socket.setTimeout(SMTP_TIMEOUT_MS);

  let buffer = '';
  let pending = null;
  let fatal = null;

  const fail = (err) => {
    fatal = err instanceof Error ? err : new Error(String(err));
    if (pending) {
      const { reject } = pending;
      pending = null;
      reject(fatal);
    }
  };

  socket.on('error', fail);
  socket.on('timeout', () => fail(new Error('SMTP timed out.')));
  socket.on('close', () => { if (pending) fail(new Error('SMTP connection closed early.')); });

  const consume = () => {
    if (!pending) return;
    // A reply ends at the first line whose 4th character is a space
    // ("250-EXTENSION" continues, "250 OK" terminates).
    const lines = buffer.split(CRLF);
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join(CRLF);
        buffer = lines.slice(i + 1).join(CRLF);
        const { resolve } = pending;
        pending = null;
        resolve({ code: Number(reply.slice(0, 3)), text: reply });
        return;
      }
    }
  };

  socket.on('data', (chunk) => { buffer += chunk; consume(); });

  const readReply = () => new Promise((resolve, reject) => {
    if (fatal) { reject(fatal); return; }
    pending = { resolve, reject };
    consume();
  });

  const send = (line) => { socket.write(line + CRLF); };

  const expect = async (codes, context) => {
    const reply = await readReply();
    if (!codes.includes(reply.code)) {
      throw new Error(`SMTP ${context} failed: ${reply.text.trim()}`);
    }
    return reply;
  };

  try {
    await expect([220], 'greeting');
    const me = os.hostname() || 'localhost';
    send(`EHLO ${me}`);
    let ehlo = await expect([250], 'EHLO');

    // STARTTLS upgrade for submission ports that require it.
    if (!useImplicitTls && !config.insecure) {
      if (!/STARTTLS/i.test(ehlo.text)) {
        throw new Error('Server does not offer STARTTLS and implicit TLS is off — refusing to send in the clear.');
      }
      send('STARTTLS');
      await expect([220], 'STARTTLS');
      await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket, servername: host }, resolve);
        upgraded.on('error', reject);
        upgraded.setEncoding('utf8');
        upgraded.on('data', (chunk) => { buffer += chunk; consume(); });
        // Route writes through the encrypted stream from here on.
        socket.write = upgraded.write.bind(upgraded);
      });
      send(`EHLO ${me}`);
      ehlo = await expect([250], 'EHLO after STARTTLS');
    }

    if (config.user) {
      send('AUTH LOGIN');
      await expect([334], 'AUTH');
      send(Buffer.from(String(config.user), 'utf8').toString('base64'));
      await expect([334], 'AUTH username');
      send(Buffer.from(String(config.pass || ''), 'utf8').toString('base64'));
      await expect([235], 'AUTH password');
    }

    send(`MAIL FROM:<${envelopeAddress(config.from)}>`);
    await expect([250], 'MAIL FROM');
    send(`RCPT TO:<${envelopeAddress(message.to)}>`);
    await expect([250, 251], 'RCPT TO');
    send('DATA');
    await expect([354], 'DATA');

    const payload = buildMessage({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text
    });
    socket.write(payload);
    socket.write(`.${CRLF}`);
    const accepted = await expect([250], 'message body');

    send('QUIT');
    return { ok: true, response: accepted.text.trim() };
  } finally {
    try { socket.end(); } catch (e) { /* already gone */ }
    try { socket.destroy(); } catch (e) { /* already gone */ }
  }
}

module.exports = { sendMail, buildMessage, encodeHeaderValue, envelopeAddress };
