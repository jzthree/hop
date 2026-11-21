// Long input into a terminal: pieces that arrive whole.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pieces, PIECE_BYTES } = require('../lib/term-input');

test('short input is one piece; long input is pieces that rejoin to it, none over the limit', () => {
    assert.deepEqual(pieces('hello\r'), ['hello\r']);
    assert.deepEqual(pieces(''), []);
    const text = Array.from({ length: 350 }, (_, i) => `Q${String(i + 1).padStart(4, '0')}`).join(' ');
    const out = pieces(text);
    assert.equal(out.join(''), text);
    assert.ok(out.length >= Math.ceil(Buffer.byteLength(text) / PIECE_BYTES));
    for (const p of out) assert.ok(Buffer.byteLength(p) <= PIECE_BYTES);
    // Breaks fall after a space, not mid-word.
    for (const p of out.slice(0, -1)) assert.match(p, / $/);
});

test('never splits a character, a surrogate pair or an escape sequence', () => {
    const text = 'é'.repeat(200) + '😀'.repeat(100) + '\x1b[200~' + 'x'.repeat(300) + '\x1b[201~' + '\x1b]0;title\x07' + 'z'.repeat(50);
    const out = pieces(text, 64);
    assert.equal(out.join(''), text);
    for (const p of out) {
        assert.ok(Buffer.byteLength(p) <= 64, `piece of ${Buffer.byteLength(p)} bytes`);
        assert.ok(!/[\ud800-\udbff]$/.test(p), 'no lone high surrogate at the end');
        assert.ok(!/^[\udc00-\udfff]/.test(p), 'no lone low surrogate at the start');
        assert.ok(!/\x1b(\[[0-9;?]*)?$/.test(p), 'no escape cut open at the end');
    }
    assert.ok(out.some((p) => p.includes('\x1b[200~')) && out.some((p) => p.includes('\x1b[201~')));
    assert.ok(out.some((p) => p.includes('\x1b]0;title\x07')));
});
