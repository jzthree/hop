'use strict';
// Long input goes into a terminal in pieces. macOS hands a program at most
// ~1 KB of queued terminal input per read (TTYHOG 1024, less 2), and Claude
// Code, given a longer burst, kept only its last piece: every hop message
// over ~1 KB typed into a Claude session lost its first 1022 bytes (its
// sender line with them; measured 2026-11-21 over a day of deliveries).
// 256-byte pieces 20 ms apart arrive whole in Claude, Codex and agy.

const PIECE_BYTES = 256;
const PIECE_GAP_MS = 20;

const utf8Len = (cp) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

/** Where an escape sequence starting at i ends (exclusive), or i when none starts there. */
function escapeEnd(s, i) {
    if (s[i] !== '\x1b') return i;
    const next = s[i + 1];
    if (next === '[') { // CSI: parameters, then one final byte @–~
        let j = i + 2;
        while (j < s.length && /[0-?]/.test(s[j])) j++;
        while (j < s.length && /[ -/]/.test(s[j])) j++;
        return Math.min(s.length, j + 1);
    }
    if (next === ']' || next === 'P' || next === '_' || next === '^') { // OSC / DCS / APC / PM: to BEL or ST
        for (let j = i + 2; j < s.length; j++) {
            if (s[j] === '\x07') return j + 1;
            if (s[j] === '\x1b' && s[j + 1] === '\\') return j + 2;
        }
        return s.length;
    }
    return Math.min(s.length, i + 2); // ESC and one character (Alt+key, SS3 lead)
}

/**
 * The pieces of `data`, each at most `maxBytes` of UTF-8 (an escape sequence
 * longer than that stays whole), never splitting a character or an escape
 * sequence, and breaking after a space or newline when one is near the end.
 */
function pieces(data, maxBytes = PIECE_BYTES) {
    const s = String(data == null ? '' : data);
    if (Buffer.byteLength(s) <= maxBytes) return s ? [s] : [];
    const out = [];
    let start = 0, bytes = 0, lastBreak = -1, i = 0;
    while (i < s.length) {
        let end = escapeEnd(s, i);
        let size;
        if (end > i) size = Buffer.byteLength(s.slice(i, end));
        else {
            const cp = s.codePointAt(i);
            end = i + (cp > 0xffff ? 2 : 1);
            size = utf8Len(cp);
        }
        if (bytes + size > maxBytes && i > start) {
            // Break after a space or newline in the last quarter, else here.
            const cut = lastBreak > start && bytes - Buffer.byteLength(s.slice(lastBreak, i)) >= maxBytes * 0.75 ? lastBreak : i;
            out.push(s.slice(start, cut));
            start = cut; bytes = Buffer.byteLength(s.slice(start, i)); lastBreak = -1;
        }
        bytes += size;
        if (s[i] === ' ' || s[i] === '\n') lastBreak = end;
        i = end;
    }
    if (start < s.length) out.push(s.slice(start));
    return out;
}

module.exports = { pieces, PIECE_BYTES, PIECE_GAP_MS };
