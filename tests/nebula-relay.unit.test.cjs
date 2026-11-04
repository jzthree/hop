'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('../lib/nebula-relay');

test('relay paths: /nebula/<port>/<rest>, query kept; anything else is not one', () => {
    assert.deepStrictEqual(r.parseRelayPath('/nebula/3000/api/fs/read?path=%2Fa'), { port: 3000, rest: '/api/fs/read?path=%2Fa', needsSlash: false });
    assert.deepStrictEqual(r.parseRelayPath('/nebula/3000'), { port: 3000, rest: '', needsSlash: true });
    assert.strictEqual(r.parseRelayPath('/nebula/abc/'), null);
    assert.strictEqual(r.parseRelayPath('/nebula/99999/'), null);
    assert.strictEqual(r.parseRelayPath('/view/x/y'), null);
});

test('only loopback http Nebula addresses are relayable: the configured one and those links name', () => {
    const ports = r.allowedPorts(undefined, ['http://localhost:3000/?file=a', 'http://127.0.0.1:43001/', 'https://nebula.example.org/', 'http://10.0.0.5:22/']);
    assert.deepStrictEqual([...ports].sort(), [3000, 43001]);
    assert.deepStrictEqual([...r.allowedPorts('http://localhost:8123', [])], [8123]);
    assert.strictEqual(r.relayUrlFor('http://localhost:3000/?file=%2Fg%2Fnb.ipynb'), '/nebula/3000/?file=%2Fg%2Fnb.ipynb');
    assert.strictEqual(r.relayUrlFor('https://nebula.example.org/?file=x'), null);
});

test('Nebula always sees an Origin and never hop’s cookies or tokens; its own token passes', () => {
    const h = r.relayRequestHeaders({
        cookie: 'tunnel_session=hs_secret', host: 'hop.example.org', 'x-hop-actor': 'user',
        authorization: 'Bearer hs_' + 'a'.repeat(40), accept: 'text/html', referer: 'https://hop.example.org/'
    }, { port: 3000, publicOrigin: 'https://hop.example.org' });
    assert.strictEqual(h.cookie, undefined);
    assert.strictEqual(h['x-hop-actor'], undefined);
    assert.strictEqual(h.authorization, undefined);
    assert.strictEqual(h.referer, undefined);
    assert.strictEqual(h.origin, 'https://hop.example.org');
    assert.strictEqual(h.host, 'localhost:3000');
    assert.strictEqual(h['x-forwarded-host'], 'hop.example.org');
    assert.strictEqual(h['x-forwarded-proto'], 'https');
    assert.strictEqual(h.accept, 'text/html');
    const own = r.relayRequestHeaders({ authorization: 'Bearer nebula-jwt', origin: 'https://hop.example.org' }, { port: 3000, publicOrigin: 'https://hop.example.org' });
    assert.strictEqual(own.authorization, 'Bearer nebula-jwt');
});

test('responses set no hop cookies, can be framed by hop, and redirects stay inside the relay', () => {
    const h = r.relayResponseHeaders({ 'set-cookie': ['a=b'], 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'content-type': 'text/html' });
    assert.deepStrictEqual(h, { 'content-security-policy': "default-src 'self'; frame-ancestors 'self';", 'content-type': 'text/html' });
    assert.strictEqual(r.relayLocation('/login?next=%2F', 3000), '/nebula/3000/login?next=%2F');
    assert.strictEqual(r.relayLocation('http://localhost:3000/x', 3000), '/nebula/3000/x');
    assert.strictEqual(r.relayLocation('https://elsewhere.org/', 3000), 'https://elsewhere.org/');
    assert.strictEqual(r.relayLocation('//evil.org/', 3000), '//evil.org/');
});
