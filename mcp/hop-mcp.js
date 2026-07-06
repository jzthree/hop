#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2024-11-05'];
const DEFAULT_PROTOCOL = '2024-11-05';
const DEFAULT_ACTOR_HEADER = 'x-hop-actor';
const DEFAULT_ACTOR = 'agent';
const SERVER_VERSION = '0.2.2';
const READ_TERMINAL_MODES = ['raw', 'ui', 'readable_raw'];
const HOPX_TURN_MODES = ['auto', 'raw', 'ui', 'readable_raw'];
const READABLE_CONTROL_LEVELS = ['full', 'structural', 'none'];
const DEFAULT_READABLE_CONTROL_LEVEL = 'none';
const READABLE_NOISE_FILTERS = ['balanced', 'off'];
const DEFAULT_READABLE_NOISE_FILTER = 'balanced';
const DEFAULT_READABLE_COALESCE_MS = 250;
const DEFAULT_READABLE_COALESCE_MAX_CHARS = 32768;
const DEFAULT_HOPX_WAIT_CAPTURE_MAX_EVENTS = 60;
const DEFAULT_HOPX_READABLE_COALESCE_MS = 350;
const DEFAULT_HOPX_UI_INCLUDE_RAW_TAIL = false;
const DEFAULT_HOPX_UI_WAIT_CAPTURE_MAX_EVENTS = 0;
const DEFAULT_HOPX_TEXT_ONLY_READABLE = true;
const DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS = 12000;
const DEFAULT_HOPX_UI_BUSY_GUARD_POLL_MS = 500;
// How many consecutive idle reads the busy-line heuristic needs before it calls a
// turn "done". One idle read can be a lull between an agent's bursts (thinking ->
// tool call); requiring a short settle avoids that stale-idle false positive.
// Only applies on the heuristic path; the Stop-hook turn counter stays
// authoritative and needs no settle.
const DEFAULT_HOPX_UI_SETTLE_CHECKS = 2;
// Verified submit: after pressing Enter in a TUI composer, re-check that the box
// actually cleared. A composer still holding our text means Enter was swallowed
// (a known TUI race), so re-send it up to this many times before giving up.
const DEFAULT_HOPX_VERIFY_SUBMIT_RETRIES = 2;
const DEFAULT_HOPX_VERIFY_SUBMIT_DELAY_MS = 250;
// Box-drawing characters that frame a TUI input box (rounded, square, and heavy
// variants), plus the column separators. Used to locate the composer and to skip
// border cells when scraping its contents.
const COMPOSER_BORDER_CHARS = new Set([
  '╭', '╮', '╰', '╯', '─', '│',
  '┌', '┐', '└', '┘', '┃', '━', '┏', '┓', '┗', '┛'
]);
const COMPOSER_TOP_CORNER_CHARS = new Set(['╭', '┌', '┏']);
const COMPOSER_BOTTOM_CORNER_CHARS = new Set(['╰', '└', '┗']);
// Prompt glyphs Claude/other TUIs print at the start of the input line.
const COMPOSER_PROMPT_CHARS = new Set(['>', '❯', '›', '▶', '⏵']);
const HOPX_UI_BUSY_LINE_PATTERNS = [
  /\besc to (?:interrupt|cancel|stop)\b/i,
  /\bctrl\+c to (?:interrupt|cancel|stop)\b/i,
  /\bwaiting for (?:process|response|model|tool)\b/i,
  /\b(?:thinking|working|generating|processing|running|compiling|building|loading)[…\.]{1,3}/i,
  /^\s*[•*]\s+.*\b(working|starting|thinking|running|processing|generating)\b/i,
  // Claude Code status lines use a spinner glyph + a whimsical gerund + "…"
  // ("✻ Simmering…", "✢ Reticulating…") — the specific verbs are unbounded, so
  // match the shape, not the vocabulary.
  /^\s*[✳✢✶✻✽·◐◓◑◒]{1,3}\s?\S{2,}…/u
];

// Busy-line patterns = the built-ins plus any from HOP_MCP_BUSY_PATTERNS (one
// regex per line). Parsed once; invalid patterns are skipped. Lets users teach
// the matcher about other agents' "working…" indicators without code changes.
let __extraBusyPatterns = null;
function getBusyLinePatterns() {
  if (__extraBusyPatterns === null) {
    __extraBusyPatterns = [];
    const raw = process.env.HOP_MCP_BUSY_PATTERNS;
    if (typeof raw === 'string' && raw.trim()) {
      for (const part of raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        try { __extraBusyPatterns.push(new RegExp(part, 'i')); } catch (e) { }
      }
    }
  }
  return __extraBusyPatterns.length
    ? HOPX_UI_BUSY_LINE_PATTERNS.concat(__extraBusyPatterns)
    : HOPX_UI_BUSY_LINE_PATTERNS;
}

// Does the tail of the rendered screen show an agent "busy" indicator? Returns
// the matching line or null. Used to keep until_agent_done from firing while an
// inline TUI is still working, in every capture mode (not just mode:ui).
// Claude config roots that can hold transcripts (projects/<cwd-slug>/*.jsonl):
// an explicit CLAUDE_CONFIG_DIR, the default ~/.claude, and alternate installs
// like ~/.claude_fable (the `claude-fable` launcher points CLAUDE_CONFIG_DIR
// there, so its transcripts never appear under ~/.claude).
function claudeConfigRoots() {
  const roots = [];
  const push = (p) => {
    if (typeof p === 'string' && p && !roots.includes(p)) roots.push(p);
  };
  push(process.env.CLAUDE_CONFIG_DIR);
  push(path.join(os.homedir(), '.claude'));
  try {
    for (const entry of fs.readdirSync(os.homedir())) {
      if (/^\.claude[_-][A-Za-z0-9_-]+$/.test(entry)) push(path.join(os.homedir(), entry));
    }
  } catch { /* home unreadable — stick with the defaults */ }
  return roots;
}

function screenTextLooksBusy(screenText) {
  if (typeof screenText !== 'string' || !screenText) return null;
  const lines = screenText.split('\n').map((l) => l.trim()).filter(Boolean).slice(-8);
  const patterns = getBusyLinePatterns();
  for (const line of lines) {
    for (const pattern of patterns) {
      if (pattern.test(line)) return line;
    }
  }
  return null;
}
const READABLE_NOISE_REWRITE_WINDOW_MS = 1000;
const READABLE_NOISE_STABLE_MS = 800;
const READABLE_NOISE_MIN_REWRITES = 2;
const READABLE_SPINNER_PREFIX_RE = /^(?:[\u2800-\u28ff]|[✳✢✶✻✽·◐◓◑◒◴◷◶◵])+\s*/u;
const READABLE_ECHO_CANDIDATE_TTL_MS = 5000;
const READABLE_ECHO_MAX_CANDIDATES = 24;
const READABLE_PROMPT_ECHO_PREFIX_RE = /^[^\r\n]{0,160}[#$>%]\s*/;
const READABLE_PROMPT_PADDING_RE = /^\s+[#$>%]\s*$/;
const READABLE_PROMPT_PADDING_COMPLEX_RE = /^\s{4,}(?:\([^)\r\n]{0,24}\)\s*)?[^\r\n]{0,220}[#$>%]\s*$/;
const WAIT_START_MODES = ['latest', 'cursor', 'beginning'];
const MAX_BUFFER_EVENTS = 2000;
// Default hop_read_terminal caps when the caller does not specify maxEvents /
// maxBytes. Pass 0 explicitly to read unlimited buffered output.
const DEFAULT_READ_MAX_EVENTS = 200;
const DEFAULT_READ_MAX_BYTES = 65536;
const STREAM_CONNECT_TIMEOUT_MS = 800;
const REQUEST_JSON_TIMEOUT_MS = 30000;
const CREATE_TERMINAL_OUTPUT_WARMUP_MS = 1200;
const DEFAULT_TERMINAL_COLS = 140;
const DEFAULT_TERMINAL_ROWS = 40;
const UI_PARSER_FLUSH_TIMEOUT_MS = 200;
const DEFAULT_SEND_KEY_REPEAT = 1;
const WAIT_POLL_INTERVAL_MS = 40;
const DEFAULT_WAIT_MAX_MS = 30000;
// Background wait jobs (async=true) watch a turn nobody is blocked on — real
// agent turns run for minutes, so an unspecified max_wait_ms defaults far
// higher than the synchronous 30s. hopx_wait_any also re-arms expired watches.
const DEFAULT_ASYNC_WAIT_MAX_MS = 15 * 60 * 1000;
// How often the standing-manager watcher reconciles the ledger and wakes an
// idle manager whose dispatched workers have completed (hopx_manager_register).
const MANAGER_WAKE_POLL_MS = 5000;
const DEFAULT_WAIT_CAPTURE_MAX_EVENTS = 120;
const DEFAULT_WAIT_AGENT_DONE_IDLE_MS = 2500;
const DEFAULT_WAIT_POLL_MAX_MS = 30000;
const WAIT_JOB_TTL_MS = 15 * 60 * 1000;
const WAIT_JOB_MAX_ENTRIES = 256;
const WAIT_TEXT_WINDOW_MAX_CHARS = 65536;
const DEFAULT_WAIT_PROMPT_REGEX = '(?:^|\\r?\\n)[^\\r\\n]*[#$>%] ?$';
// Where until_regex/until_prompt look for a match:
//   stream = the linear output event stream (default for shells; correct when
//            the byte stream equals the screen)
//   screen = the reconstructed virtual screen text (correct for full-screen/TUI
//            apps that repaint in place; caveat: also sees your echoed input)
//   auto   = stream, plus screen when the terminal is in alternate-screen mode
const WAIT_MATCH_TARGETS = ['stream', 'screen', 'auto'];
const DEFAULT_WAIT_MATCH_TARGET = 'auto';
const STRUCTURAL_READABLE_CONTROL_KINDS = new Set([
  'backspace',
  'cursor',
  'erase_line',
  'erase_display',
  'insert_chars',
  'delete_chars',
  'alternate_screen'
]);

const NAMED_KEY_INPUTS = Object.freeze({
  enter: '\r',
  return: '\r',
  newline: '\r',
  esc: '\x1b',
  escape: '\x1b',
  tab: '\t',
  shift_tab: '\x1b[Z',
  backspace: '\x7f',
  del: '\x7f',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  page_up: '\x1b[5~',
  page_down: '\x1b[6~',
  space: ' ',
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_z: '\x1a',
  ctrl_l: '\x0c',
  ctrl_u: '\x15',
  ctrl_w: '\x17',
  ctrl_a: '\x01',
  ctrl_e: '\x05',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~'
});

let HeadlessTerminalCtor = undefined;
let headlessTerminalLoadError = null;

// Regex to strip all ANSI escape sequences (CSI, OSC, simple escapes, \r-based line rewrites)
const ANSI_RE = /(?:\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-B012]|\x1b[=>Nno|}~78DHM]|\x1b\[[\?=!>]?[0-9;]*[A-Za-z@`]|\r(?!\n))/g;

/**
 * Strip all ANSI escape sequences and carriage-return line rewrites from text.
 * Returns clean, plain text suitable for programmatic consumption.
 */
function stripAnsi(text) {
  if (typeof text !== 'string') return '';
  return text.replace(ANSI_RE, '');
}

/**
 * Heuristic: does this line look like a shell prompt?
 * Matches common patterns: user@host:path$, (env) $, bash-5.2$, etc.
 */
function isLikelyPrompt(line) {
  if (typeof line !== 'string') return false;
  const trimmed = line.trim();
  if (!trimmed) return true; // empty lines are prompt-adjacent
  // Ends with common prompt chars, optionally followed by a space
  return /[#$>%]\s*$/.test(trimmed);
}

function log(...args) {
  console.error(...args);
}

function normalizeSendKeyName(key) {
  if (typeof key !== 'string') return '';
  return key
    .trim()
    .toLowerCase()
    .replace(/\+/g, '_')
    .replace(/[\s-]+/g, '_');
}

function normalizeHopxTurnMode(value) {
  if (value === undefined || value === null || value === '') return 'auto';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return HOPX_TURN_MODES.includes(normalized) ? normalized : null;
}

function resolveHopxTextOnly(raw, captureMode) {
  if (raw === true) return true;
  if (raw === false) return false;
  return captureMode === 'readable_raw' && DEFAULT_HOPX_TEXT_ONLY_READABLE;
}

function resolveSendKeyInput(key, repeatRaw) {
  const normalized = normalizeSendKeyName(key);
  if (!normalized) {
    return { ok: false, error: 'key is required' };
  }

  let input = NAMED_KEY_INPUTS[normalized];
  if (!input && /^ctrl_[a-z]$/.test(normalized)) {
    const code = normalized.charCodeAt(normalized.length - 1) - 96;
    if (code >= 1 && code <= 26) {
      input = String.fromCharCode(code);
    }
  }
  if (!input) {
    const supported = Object.keys(NAMED_KEY_INPUTS).sort().join(', ');
    return {
      ok: false,
      error: `Unsupported key "${key}". Supported keys: ${supported}, ctrl+[a-z].`
    };
  }

  const repeat = Number.isFinite(Number(repeatRaw))
    ? Math.max(1, Math.floor(Number(repeatRaw)))
    : DEFAULT_SEND_KEY_REPEAT;

  return {
    ok: true,
    data: input.repeat(repeat)
  };
}

function sanitizeRegexFlags(raw, fallback = 'm') {
  const allowed = new Set(['d', 'i', 'm', 's', 'u', 'v', 'y']);
  const source = typeof raw === 'string' ? raw : fallback;
  const normalized = String(source || '').trim().toLowerCase();
  const deduped = [];
  for (const ch of normalized) {
    if (!allowed.has(ch)) continue;
    if (deduped.includes(ch)) continue;
    deduped.push(ch);
  }
  if (!deduped.includes('m')) deduped.push('m');
  return deduped.join('');
}

function compileRegex(pattern, rawFlags, fallbackFlags = 'm') {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return { ok: false, error: 'Pattern is required.' };
  }
  try {
    return {
      ok: true,
      regex: new RegExp(pattern, sanitizeRegexFlags(rawFlags, fallbackFlags))
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function appendRollingText(existing, chunk, maxChars = WAIT_TEXT_WINDOW_MAX_CHARS) {
  if (!chunk) return existing;
  const combined = String(existing || '') + String(chunk);
  if (combined.length <= maxChars) return combined;
  return combined.slice(combined.length - maxChars);
}

function getOutputTextFromEvent(event, captureMode) {
  if (!event || typeof event !== 'object') return '';
  if (captureMode === 'readable_raw') {
    return typeof event.text === 'string' ? event.text : '';
  }
  if ((event.type === 'output' || event.type === 'snapshot') && typeof event.data === 'string') {
    return event.data;
  }
  return '';
}

function isOutputLikeEvent(event, captureMode) {
  if (!event || typeof event !== 'object') return false;
  if (captureMode === 'readable_raw') {
    return typeof event.text === 'string'
      || event.type === 'output'
      || event.type === 'snapshot';
  }
  return event.type === 'output' || event.type === 'snapshot';
}

function condenseReadableWaitPayload(waitPayload) {
  if (!waitPayload || typeof waitPayload !== 'object') return waitPayload;
  if (waitPayload.captureMode !== 'readable_raw') return waitPayload;
  if (
    Array.isArray(waitPayload.events)
    && waitPayload.events.length === 0
    && typeof waitPayload.text === 'string'
    && Number.isFinite(waitPayload.originalEventCount)
  ) {
    return waitPayload;
  }

  const events = Array.isArray(waitPayload.events) ? waitPayload.events : [];
  const originalEventCount = Number.isFinite(waitPayload.eventCount)
    ? Math.max(0, Math.floor(waitPayload.eventCount))
    : events.length;
  const text = events
    .map((event) => (event && typeof event.text === 'string' ? event.text : ''))
    .join('');

  return {
    ...waitPayload,
    text,
    originalEventCount,
    eventCount: 0,
    events: []
  };
}

/**
 * Strip token-heavy fields from a wait payload before returning to the agent.
 * Removes: startFrom, captureMode, waitedMs, originalEventCount, ok, matchedText,
 * status (when "matched"), eventCount/events (when empty), closed (when false),
 * error (when null), untilAgentDone (when false), agentDoneIdleMs (when null).
 * Optionally strips the echoed command line from wait.text.
 *
 * @param {object} waitPayload - raw wait payload from runWaitTerminal / condenseReadableWaitPayload
 * @param {string|null} sentData - the data string sent before the wait (for echo stripping), or null
 * @returns {object} slimmed wait payload
 */
function slimWaitPayload(waitPayload, sentData) {
  if (!waitPayload || typeof waitPayload !== 'object') return waitPayload;

  const out = { ...waitPayload };

  // Always remove these echo-of-input / timing / redundant fields
  delete out.startFrom;
  delete out.captureMode;
  delete out.waitedMs;
  delete out.originalEventCount;
  delete out.cursorStart;   // only next_cursor is needed
  delete out.cursorEnd;     // same value as next_cursor

  // Remove 'ok' — redundant with top-level ok
  delete out.ok;

  // Remove matchedText — already visible as last line of text
  delete out.matchedText;

  // Remove status when "matched" (success case)
  if (out.status === 'matched') {
    delete out.status;
  }

  // Remove untilAgentDone when false
  if (out.untilAgentDone === false) {
    delete out.untilAgentDone;
  }

  // Remove agentDoneIdleMs when null
  if (out.agentDoneIdleMs === null || out.agentDoneIdleMs === undefined) {
    delete out.agentDoneIdleMs;
  }

  // Remove eventCount/events when empty
  if (out.eventCount === 0 && Array.isArray(out.events) && out.events.length === 0) {
    delete out.eventCount;
    delete out.events;
  }

  // Remove closed when false
  if (out.closed === false || out.closed === undefined) {
    delete out.closed;
  }

  // Remove error when null/undefined
  if (out.error === null || out.error === undefined) {
    delete out.error;
  }

  // Remove match diagnostics when uninformative
  if (out.matchVia === null || out.matchVia === undefined) {
    delete out.matchVia;
  }
  if (out.matchTarget === DEFAULT_WAIT_MATCH_TARGET || out.matchTarget === undefined) {
    delete out.matchTarget;
  }
  if (out.hint === null || out.hint === undefined) {
    delete out.hint;
  }

  // Strip echoed command from the start of text.
  // The terminal echoes the typed command back before output. The echo may be:
  //   - preceded by the shell prompt (e.g., "user@host:~$ grep foo bar.py")
  //   - immediately followed by output with no newline separator
  // Strategy: find the sent command string in the first ~512 chars of text,
  // then strip everything up through the end of the command (plus one trailing \n if present).
  if (typeof out.text === 'string' && typeof sentData === 'string' && sentData.length > 0) {
    const text = out.text;
    // Strip ANSI from search window for more reliable matching
    const rawWindow = text.slice(0, 1024);
    const cleanWindow = stripAnsi(rawWindow);
    const cmdToFind = sentData.replace(/\r$/, ''); // strip trailing \r if present
    const idx = cleanWindow.indexOf(cmdToFind);
    if (idx !== -1) {
      // Map the clean-text index back to the raw text position.
      // Walk the raw text, skipping ANSI sequences, to find the corresponding raw offset.
      let rawIdx = 0;
      let cleanIdx = 0;
      while (cleanIdx < idx + cmdToFind.length && rawIdx < rawWindow.length) {
        // Check if we're at an ANSI escape
        const remaining = rawWindow.slice(rawIdx);
        ANSI_RE.lastIndex = 0;
        const ansiMatch = ANSI_RE.exec(remaining);
        if (ansiMatch && ansiMatch.index === 0) {
          rawIdx += ansiMatch[0].length;
          continue;
        }
        rawIdx++;
        cleanIdx++;
      }
      // Skip a trailing \n or \r\n after the command
      if (text[rawIdx] === '\r') rawIdx++;
      if (text[rawIdx] === '\n') rawIdx++;
      out.text = text.slice(rawIdx);
    }
  }

  return out;
}

// Reply text a turn's wait captured, for until_reply_regex evaluation: prefer
// the condensed wait.text, else join the captured events' text/data.
function extractWaitReplyText(waitPayload) {
  if (!waitPayload || typeof waitPayload !== 'object') return '';
  if (typeof waitPayload.text === 'string' && waitPayload.text.length > 0) {
    return waitPayload.text;
  }
  const events = Array.isArray(waitPayload.events) ? waitPayload.events : [];
  return events
    .map((event) => {
      if (!event || typeof event !== 'object') return '';
      if (typeof event.text === 'string') return event.text;
      return typeof event.data === 'string' ? event.data : '';
    })
    .join('');
}

// Evaluate a (pre-validated) until_reply_regex against the reply text.
// preferredText (the last assistant message from the session transcript) is
// authoritative when available — a TUI's stream capture often never commits
// the final reply line, and the rendered screen would false-positive on the
// echoed instruction. Falls back to the wait-captured text. Case-insensitive
// by contract; ANSI is stripped so patterns match the visible text.
function evaluateReplyRegex(pattern, waitPayload, preferredText) {
  let regex = null;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return { reply_matched: false, reply_match: null };
  }
  let match = null;
  if (typeof preferredText === 'string' && preferredText) {
    match = stripAnsi(preferredText).match(regex);
  }
  if (!match) {
    match = stripAnsi(extractWaitReplyText(waitPayload)).match(regex);
  }
  return {
    reply_matched: match !== null,
    reply_match: match ? match[0] : null
  };
}

function extractUiBusyLine(uiPayload) {
  const ui = uiPayload && typeof uiPayload === 'object' ? uiPayload.ui : null;
  const lines = ui && Array.isArray(ui.lines) ? ui.lines : [];
  if (lines.length === 0) return null;
  const recentNonEmpty = lines
    .map((line) => (line && typeof line.text === 'string' ? line.text : ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-8);
  const patterns = getBusyLinePatterns();
  for (const line of recentNonEmpty) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return line;
      }
    }
  }
  return null;
}

// Does the text still sitting in a composer look like the text we just tried to
// submit? Used by verified-submit to tell a swallowed Enter (our prompt is still
// in the box) from an unrelated box state (something else is there — leave it be).
// Whitespace-insensitive, case-insensitive, and tolerant of a visually truncated
// composer (compares a leading chunk when one side is shorter).
function composerSharesContent(sent, composerText) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const a = norm(sent);
  const b = norm(composerText);
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (longer.includes(shorter)) return true;
  const head = shorter.slice(0, Math.min(20, shorter.length));
  return head.length >= 4 && longer.includes(head);
}

// Claude Code stores a session transcript at
// ~/.claude/projects/<enc>/<sessionId>.jsonl where <enc> is the cwd with every
// '/' and '_' replaced by '-'. Verified: /Users/jianzhou/Code/auto_statistician_claude
// -> -Users-jianzhou-Code-auto-statistician-claude.
function encodeClaudeProjectDir(cwd) {
  // Claude Code slugifies the cwd by replacing every non-alphanumeric char
  // with '-' ('/Code/hop2/.hop-worktrees/x' -> '-Code-hop2--hop-worktrees-x').
  // The old [/_] rule missed dots, which broke transcript resolution for any
  // cwd containing one (git worktrees under .hop-worktrees, dotdirs, etc.).
  return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');
}

function firstTrajectoryText(parts, n) {
  const s = parts.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}

// Flatten one transcript message's content (string OR block array) into the bits
// a compact turn record needs, without holding the raw blocks. Distinguishes text
// from tool_use (names) from tool_result (size + error) from thinking/image.
function summarizeMessageContent(message, includeThinking) {
  const out = { textParts: [], toolNames: [], toolResults: 0, toolResultBytes: 0, isError: false, hasImage: false };
  if (!message || typeof message !== 'object') return out;
  const content = message.content;
  if (typeof content === 'string') { if (content) out.textParts.push(content); return out; }
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') out.textParts.push(block.text);
    else if (t === 'thinking' && typeof block.thinking === 'string') { if (includeThinking) out.textParts.push(block.thinking); }
    else if (t === 'tool_use') { if (typeof block.name === 'string') out.toolNames.push(block.name); }
    else if (t === 'tool_result') {
      out.toolResults += 1;
      if (block.is_error) out.isError = true;
      const c = block.content;
      if (typeof c === 'string') out.toolResultBytes += Buffer.byteLength(c, 'utf8');
      else if (Array.isArray(c)) {
        for (const cb of c) {
          if (cb && cb.type === 'text' && typeof cb.text === 'string') out.toolResultBytes += Buffer.byteLength(cb.text, 'utf8');
          else if (cb && cb.type === 'image') out.hasImage = true;
        }
      }
    } else if (t === 'image') out.hasImage = true;
  }
  return out;
}

// --- Scrollback-capture stitching helpers (Part 2) ---
// A captured frame is an array of row texts (trailing whitespace stripped).
function stripTrailingBlankLines(arr) {
  let end = arr.length;
  while (end > 0 && !arr[end - 1].trim()) end--;
  return arr.slice(0, end);
}
// Count the contiguous run of identical rows at the BOTTOM of two equal-height
// frames. For a TUI with a fixed footer (e.g. Claude's composer + hint bar), this
// is the non-scrolling chrome, which must be excluded before stitching the
// scrolling transcript region above it. For a clean full-screen pager it catches
// just the status line.
function bottomFixedCount(a, b) {
  let n = 0;
  for (let i = a.length - 1, j = b.length - 1; i >= 0 && j >= 0 && a[i] === b[j]; i--, j--) n++;
  return n;
}
// Largest L such that the bottom L rows of `top` equal the top L rows of `bottom`
// (the overlap when scrolling up reveals new rows above the prior view).
function maxBottomTopOverlap(top, bottom) {
  const max = Math.min(top.length, bottom.length);
  for (let L = max; L > 0; L--) {
    let ok = true;
    for (let k = 0; k < L; k++) {
      if (top[top.length - L + k] !== bottom[k]) { ok = false; break; }
    }
    if (ok) return L;
  }
  return 0;
}

// --- Trajectory "digest" reduction (ported from ~/Code/agent_tools/agent_migration.py,
// kept self-contained so hop has no dependency on that tool). The digest is the
// reduced view a driver actually wants: per-turn User text + Assistant text + a
// one-line summary of each tool call, with transcript noise dropped. ---

// Injected/system text that isn't real conversation; turns whose user text starts
// with one of these are dropped from the digest (agent_migration's noise list).
const TRAJECTORY_NOISE_PREFIXES = [
  '<task-notification>', '<turn_aborted>', '<local-command-caveat>',
  '[Request interrupted', '<command-name>', '<system-reminder>',
  '# AGENTS.md', '<INSTRUCTIONS>', '<local-command-stdout>',
  'Automation:', '<subagent_notification>'
];
function isTrajectoryNoise(text) {
  const t = (text || '').replace(/^\s+/, '');
  return TRAJECTORY_NOISE_PREFIXES.some((p) => t.startsWith(p));
}

// One-line summary of a tool call (port of _summarize_tool_call): the bit that
// drops "a lot of the details" — a Read/Edit/Write becomes just its path, a Bash
// its command head, an MCP call its short name + first couple of args.
function summarizeToolCall(block) {
  const name = (block && typeof block.name === 'string') ? block.name : '?';
  const inp = (block && block.input && typeof block.input === 'object') ? block.input : {};
  const str = (v) => (v === undefined || v === null) ? '' : String(v);
  switch (name) {
    case 'Bash': return `[Bash] ${str(inp.command).slice(0, 120)}`;
    case 'Read': return `[Read] ${str(inp.file_path) || '?'}`;
    case 'Edit': return `[Edit] ${str(inp.file_path) || '?'}`;
    case 'Write': return `[Write] ${str(inp.file_path) || '?'}`;
    case 'Glob': return `[Glob] ${str(inp.pattern) || '?'}`;
    case 'Grep': return `[Grep] ${str(inp.pattern) || '?'}`;
    case 'Agent': return `[Agent] ${str(inp.prompt).slice(0, 80) || '?'}`;
    default: {
      const short = name.includes('__') ? name.split('__').pop() : name;
      const args = Object.entries(inp).slice(0, 2).map(([k, v]) => `${k}=${str(v).slice(0, 30)}`).join(' ');
      return `[${short}] ${args}`.slice(0, 120);
    }
  }
}

// Render one grouped turn ({ user, ts, assistantParts[], tools[] }) to text.
function renderDigestTurn(turn) {
  const lines = [];
  if (turn.user !== null && turn.user !== undefined) {
    lines.push(turn.ts ? `## User [${turn.ts}]` : '## User');
    lines.push(turn.user);
  }
  const assistant = turn.assistantParts.join('\n').trim();
  if (assistant) { lines.push('', '## Assistant', assistant); }
  if (turn.tools && turn.tools.length) {
    lines.push('', '### Actions');
    for (const t of turn.tools) lines.push(`  ${t}`);
  }
  lines.push('');
  return lines.join('\n');
}

function extractToolErrorText(response) {
  if (!response || typeof response !== 'object') return 'Unknown error';
  const content = Array.isArray(response.content) ? response.content : [];
  for (const item of content) {
    if (item && typeof item === 'object' && typeof item.text === 'string' && item.text.trim().length > 0) {
      return item.text.trim();
    }
  }
  return 'Unknown error';
}

function resolveHomeDir() {
  if (process.env.HOP_HOME) return process.env.HOP_HOME;
  return path.join(os.homedir(), '.hop2');
}

function resolveStateFile() {
  if (process.env.HOP_STATE_FILE) return process.env.HOP_STATE_FILE;
  return path.join(resolveHomeDir(), '.tunnel-state');
}

function loadStateFromFile() {
  try {
    const statePath = resolveStateFile();
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.port) return null;
    const port = parsed.port;
    const token = parsed.sessionSecret;
    return { baseUrl: `http://127.0.0.1:${port}`, token };
  } catch (err) {
    return null;
  }
}

function resolveDefaultConnection() {
  if (process.env.HOP_API_URL) {
    return {
      baseUrl: process.env.HOP_API_URL,
      token: process.env.HOP_TOKEN || null
    };
  }
  return loadStateFromFile();
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/$/, '');
  } catch (err) {
    return null;
  }
}

function normalizeEndpointPath(endpoint) {
  if (typeof endpoint !== 'string') return null;
  const trimmed = endpoint.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
}

function normalizeReadableControlLevel(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_READABLE_CONTROL_LEVEL;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return DEFAULT_READABLE_CONTROL_LEVEL;
  if (!READABLE_CONTROL_LEVELS.includes(normalized)) return null;
  return normalized;
}

function normalizeReadableNoiseFilter(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_READABLE_NOISE_FILTER;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) return DEFAULT_READABLE_NOISE_FILTER;
  if (!READABLE_NOISE_FILTERS.includes(normalized)) return null;
  return normalized;
}

function normalizeReadableCoalesceMs(raw) {
  if (!Number.isFinite(raw)) return DEFAULT_READABLE_COALESCE_MS;
  return Math.max(0, Math.floor(raw));
}

function normalizeReadableCoalesceMaxChars(raw) {
  if (!Number.isFinite(raw)) return DEFAULT_READABLE_COALESCE_MAX_CHARS;
  return Math.max(256, Math.floor(raw));
}

function filterReadableControls(controls, controlLevel) {
  if (!Array.isArray(controls) || controls.length === 0) return [];
  if (controlLevel === 'none') return [];
  if (controlLevel !== 'structural') return controls;
  return controls.filter((control) => (
    control
    && typeof control === 'object'
    && STRUCTURAL_READABLE_CONTROL_KINDS.has(control.kind)
  ));
}

function isReadableOutputEvent(event) {
  return !!(
    event
    && typeof event === 'object'
    && (event.type === 'output' || event.type === 'snapshot')
    && typeof event.text === 'string'
    && event.text.length > 0
  );
}

function isReadableEmptyOutputEvent(event) {
  return !!(
    event
    && typeof event === 'object'
    && (event.type === 'output' || event.type === 'snapshot')
    && typeof event.text === 'string'
    && event.text.length === 0
  );
}

function readableEventHasControl(event, kind) {
  if (!event || typeof event !== 'object') return false;
  if (!Array.isArray(event.controls) || event.controls.length === 0) return false;
  return event.controls.some((control) => (
    control
    && typeof control === 'object'
    && control.kind === kind
  ));
}

function stripReadableStatusDotAnimation(line) {
  if (typeof line !== 'string' || line.length === 0) return '';
  const match = line.match(/^(.*?)(?:\s*(?:\.{1,3}|…))+$/u);
  if (!match) return line;
  const stem = match[1].trimEnd();
  if (/^[A-Za-z0-9][A-Za-z0-9 ()/_-]{0,120}$/.test(stem)) {
    return stem;
  }
  return line;
}

function normalizeReadableNoiseLine(line) {
  if (typeof line !== 'string' || line.length === 0) return '';
  const withoutSpinner = line.replace(READABLE_SPINNER_PREFIX_RE, '');
  const withoutAnimation = stripReadableStatusDotAnimation(withoutSpinner);
  return withoutAnimation.replace(/[ \t]+$/g, '');
}

function normalizeReadableNoiseText(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  return text
    .split('\n')
    .map((line) => normalizeReadableNoiseLine(line))
    .join('\n');
}

function canonicalizeReadableNoiseText(text) {
  const normalized = normalizeReadableNoiseText(text);
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function normalizeReadableEchoLine(line) {
  if (typeof line !== 'string' || line.length === 0) return '';
  return line
    .replace(/\r/g, '')
    .replace(/[ \t]+$/g, '');
}

function canonicalizeReadableEchoLine(line) {
  return normalizeReadableEchoLine(line).trim();
}

function createReadableEchoState() {
  return {
    candidates: []
  };
}

function pruneReadableEchoCandidates(echoState, nowTs) {
  if (!echoState || !Array.isArray(echoState.candidates)) return;
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  echoState.candidates = echoState.candidates.filter((candidate) => (
    candidate
    && typeof candidate.text === 'string'
    && candidate.text.length > 0
    && Number.isFinite(candidate.ts)
    && (now - candidate.ts) <= READABLE_ECHO_CANDIDATE_TTL_MS
  ));
  if (echoState.candidates.length > READABLE_ECHO_MAX_CANDIDATES) {
    echoState.candidates.splice(0, echoState.candidates.length - READABLE_ECHO_MAX_CANDIDATES);
  }
}

function recordReadableEchoCandidates(echoState, input, nowTs) {
  if (!echoState || typeof input !== 'string' || input.length === 0) return;
  const now = Number.isFinite(nowTs) ? nowTs : Date.now();
  pruneReadableEchoCandidates(echoState, now);

  const segments = input.replace(/\r/g, '\n').split('\n');
  for (const segment of segments) {
    const candidate = canonicalizeReadableEchoLine(segment);
    if (!candidate) continue;
    if (candidate.length > 512) continue;
    if (candidate.length === 1 && !/[A-Za-z0-9]/.test(candidate)) continue;

    const existing = echoState.candidates.find((item) => item.text === candidate);
    if (existing) {
      existing.ts = now;
      continue;
    }
    echoState.candidates.push({ text: candidate, ts: now });
  }

  pruneReadableEchoCandidates(echoState, now);
}

function isLikelyPromptEchoLine(line, candidate) {
  if (typeof line !== 'string' || typeof candidate !== 'string' || !line || !candidate) return false;
  const normalizedLine = normalizeReadableEchoLine(line);
  const hasPromptPrefix = READABLE_PROMPT_ECHO_PREFIX_RE.test(normalizedLine);
  const promptStripped = canonicalizeReadableEchoLine(
    hasPromptPrefix ? normalizedLine.replace(READABLE_PROMPT_ECHO_PREFIX_RE, '') : normalizedLine
  );
  if (!promptStripped) return false;

  if (hasPromptPrefix && promptStripped === candidate) return true;
  if (candidate.length > 1 && promptStripped === `${candidate[0]}${candidate}`) return true;
  return false;
}

function suppressReadableEchoAndPromptNoise(echoState, events) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const now = Date.now();
  if (echoState) {
    pruneReadableEchoCandidates(echoState, now);
  }
  const candidates = (echoState && Array.isArray(echoState.candidates)) ? echoState.candidates : [];

  return events.map((event) => {
    if (!isReadableOutputEvent(event)) return event;
    const text = typeof event.text === 'string' ? event.text : '';
    if (!text) return event;
    const hasRewriteControls = readableEventHasControl(event, 'carriage_return')
      || readableEventHasControl(event, 'erase_line')
      || readableEventHasControl(event, 'backspace');

    let changed = false;
    const parts = text.split('\n');
    const hasMultipleNonEmptyLines = parts.filter((part) => normalizeReadableEchoLine(part).trim().length > 0).length >= 2;
    const kept = [];

    for (const part of parts) {
      const normalizedLine = normalizeReadableEchoLine(part);
      if (
        READABLE_PROMPT_PADDING_RE.test(normalizedLine)
        || READABLE_PROMPT_PADDING_COMPLEX_RE.test(normalizedLine)
      ) {
        changed = true;
        continue;
      }

      let suppressed = false;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const candidate = candidates[i];
        if (!candidate || typeof candidate.text !== 'string') continue;
        const matchesPromptEcho = isLikelyPromptEchoLine(normalizedLine, candidate.text);
        const matchesExactEcho = hasMultipleNonEmptyLines && (
          normalizedLine === candidate.text
          || (candidate.text.length > 1 && normalizedLine === `${candidate.text[0]}${candidate.text}`)
        );
        const matchesRewriteEcho = hasRewriteControls && matchesExactEcho;
        if (matchesPromptEcho || matchesRewriteEcho || matchesExactEcho) {
          suppressed = true;
          changed = true;
          candidate.ts = now;
          break;
        }
      }

      if (!suppressed) kept.push(part);
    }

    if (!changed) return event;
    return {
      ...event,
      text: kept.join('\n')
    };
  });
}

function createReadableNoiseState() {
  return {
    filteredBaseByEventId: new Map(),
    pendingRewrite: null,
    lastCommittedKey: null,
    lastSuppressedRewrite: null
  };
}

function createReadableEventFromTemplate(templateEvent, text, timestamp) {
  const event = templateEvent && typeof templateEvent === 'object'
    ? { ...templateEvent }
    : { type: 'output' };
  event.text = text;
  if (Number.isFinite(timestamp)) {
    event.timestamp = timestamp;
  }
  return event;
}

function isNoisyPendingRewrite(pending) {
  return !!(
    pending
    && pending.rewriteCount >= READABLE_NOISE_MIN_REWRITES
  );
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripNoisyRewriteKeyPrefix(text, rewriteKey) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const key = canonicalizeReadableNoiseText(typeof rewriteKey === 'string' ? rewriteKey : '');
  if (!key) return text;
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}(?:\\s*(?:\\.{1,3}|…))?\\s*`, 'u');
  return text.replace(pattern, '');
}

function maybeEmitReadableCommittedEvent(noiseState, templateEvent, text, timestamp) {
  const normalizedText = normalizeReadableNoiseText(text);
  const commitKey = canonicalizeReadableNoiseText(normalizedText);
  if (!commitKey) return null;
  if (noiseState.lastCommittedKey === commitKey) return null;
  noiseState.lastCommittedKey = commitKey;
  return createReadableEventFromTemplate(templateEvent, normalizedText, timestamp);
}

function flushReadablePendingRewrite(noiseState, nowTs, output, force = false) {
  if (!noiseState || !noiseState.pendingRewrite) return;
  const pending = noiseState.pendingRewrite;
  const elapsed = Number.isFinite(nowTs) && Number.isFinite(pending.lastTs)
    ? nowTs - pending.lastTs
    : 0;
  const isStable = elapsed >= READABLE_NOISE_STABLE_MS;

  if (!isStable) {
    if (force) {
      noiseState.pendingRewrite = null;
    }
    return;
  }

  if (!isNoisyPendingRewrite(pending)) {
    const committed = maybeEmitReadableCommittedEvent(
      noiseState,
      pending.templateEvent,
      pending.text,
      pending.lastTs
    );
    if (committed) output.push(committed);
  } else {
    noiseState.lastSuppressedRewrite = {
      key: pending.key,
      lastTs: pending.lastTs
    };
  }
  noiseState.pendingRewrite = null;
}

function applyBalancedReadableNoiseFilter(noiseState, event) {
  const output = [];
  if (event === undefined) return output;
  if (event === null || typeof event !== 'object') {
    output.push(event);
    return output;
  }
  const eventTs = Number.isFinite(event && event.timestamp) ? Math.floor(event.timestamp) : Date.now();
  flushReadablePendingRewrite(noiseState, eventTs, output, false);

  if (!isReadableOutputEvent(event)) {
    output.push(event);
    return output;
  }

  const text = typeof event.text === 'string' ? event.text : '';
  const hasLineFeed = text.includes('\n') || readableEventHasControl(event, 'line_feed');
  const isRewriteCandidate = !hasLineFeed
    && (readableEventHasControl(event, 'carriage_return') || readableEventHasControl(event, 'erase_line'));

  if (isRewriteCandidate) {
    const normalizedText = normalizeReadableNoiseText(text);
    const rewriteKey = canonicalizeReadableNoiseText(normalizedText);
    if (!rewriteKey) {
      noiseState.pendingRewrite = null;
      return output;
    }

    const pending = noiseState.pendingRewrite;
    const canExtend = pending
      && pending.key === rewriteKey
      && Number.isFinite(pending.lastTs)
      && (eventTs - pending.lastTs) <= READABLE_NOISE_REWRITE_WINDOW_MS;

    if (canExtend) {
      pending.rewriteCount += 1;
      pending.lastTs = eventTs;
      pending.text = normalizedText;
      pending.templateEvent = event;
    } else {
      flushReadablePendingRewrite(noiseState, eventTs, output, true);
      noiseState.pendingRewrite = {
        key: rewriteKey,
        text: normalizedText,
        firstTs: eventTs,
        lastTs: eventTs,
        rewriteCount: 1,
        templateEvent: event
      };
    }
    return output;
  }

  let commitText = text;
  if (noiseState.pendingRewrite) {
    if (isNoisyPendingRewrite(noiseState.pendingRewrite)) {
      commitText = stripNoisyRewriteKeyPrefix(commitText, noiseState.pendingRewrite.key);
    }
  } else if (
    noiseState.lastSuppressedRewrite
    && Number.isFinite(noiseState.lastSuppressedRewrite.lastTs)
    && (eventTs - noiseState.lastSuppressedRewrite.lastTs) <= READABLE_NOISE_REWRITE_WINDOW_MS
  ) {
    commitText = stripNoisyRewriteKeyPrefix(commitText, noiseState.lastSuppressedRewrite.key);
  }
  flushReadablePendingRewrite(noiseState, eventTs, output, true);
  const committed = maybeEmitReadableCommittedEvent(noiseState, event, commitText, eventTs);
  if (committed) {
    output.push(committed);
    noiseState.lastSuppressedRewrite = null;
  }
  return output;
}

function coalesceReadableOutputEvents(events, options = {}) {
  const coalesceMs = normalizeReadableCoalesceMs(options.coalesceMs);
  if (coalesceMs <= 0) return events;
  const coalesceMaxChars = normalizeReadableCoalesceMaxChars(options.coalesceMaxChars);
  const result = [];
  let pending = null;

  const flushPending = () => {
    if (!pending) return;
    result.push(pending);
    pending = null;
  };

  for (const event of events || []) {
    if (!isReadableOutputEvent(event)) {
      flushPending();
      result.push(event);
      continue;
    }

    if (!pending) {
      pending = { ...event };
      if (Array.isArray(event.controls)) {
        pending.controls = [...event.controls];
      }
      continue;
    }

    const previousTs = Number.isFinite(pending.timestamp) ? Math.floor(pending.timestamp) : null;
    const nextTs = Number.isFinite(event.timestamp) ? Math.floor(event.timestamp) : null;
    const withinWindow = previousTs === null || nextTs === null || (nextTs - previousTs) <= coalesceMs;
    const combinedChars = pending.text.length + event.text.length;

    if (!withinWindow || pending.type !== event.type || combinedChars > coalesceMaxChars) {
      flushPending();
      pending = { ...event };
      if (Array.isArray(event.controls)) {
        pending.controls = [...event.controls];
      }
      continue;
    }

    pending.text += event.text;
    if (Array.isArray(event.controls) && event.controls.length > 0) {
      pending.controls = Array.isArray(pending.controls)
        ? pending.controls.concat(event.controls)
        : [...event.controls];
    }
    if (Number.isFinite(event.controlsDropped)) {
      pending.controlsDropped = (Number.isFinite(pending.controlsDropped) ? pending.controlsDropped : 0) + event.controlsDropped;
    }
    if (typeof event.rawData === 'string') {
      pending.rawData = `${pending.rawData || ''}${event.rawData}`;
    }
    if (typeof event.streamEventId === 'number') {
      pending.streamEventId = event.streamEventId;
    }
    if (Number.isFinite(event.timestamp)) {
      pending.timestamp = event.timestamp;
    }
    if (typeof event.alternateScreen === 'boolean') {
      pending.alternateScreen = event.alternateScreen;
    }
    if (typeof event.cursorHidden === 'boolean') {
      pending.cursorHidden = event.cursorHidden;
    }
  }

  flushPending();
  return result;
}

function ensureHeadlessRuntime() {
  if (!global.window) {
    global.window = global;
  }
  if (!global.requestIdleCallback) {
    global.requestIdleCallback = (callback) => {
      return setTimeout(() => callback({ timeRemaining: () => 0, didTimeout: false }), 0);
    };
  }
  if (!global.cancelIdleCallback) {
    global.cancelIdleCallback = (handle) => {
      clearTimeout(handle);
    };
  }
}

function loadHeadlessTerminalCtor() {
  if (HeadlessTerminalCtor !== undefined) {
    return HeadlessTerminalCtor;
  }

  ensureHeadlessRuntime();

  const candidates = [
    'xterm-headless',
    path.join(__dirname, '..', 'hay', 'node_modules', 'xterm-headless')
  ];

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate);
      if (loaded && typeof loaded.Terminal === 'function') {
        HeadlessTerminalCtor = loaded.Terminal;
        return HeadlessTerminalCtor;
      }
    } catch (err) {
      headlessTerminalLoadError = err;
    }
  }

  HeadlessTerminalCtor = null;
  return null;
}

function getHeadlessUnavailableReason() {
  if (!headlessTerminalLoadError) {
    return 'xterm-headless is not available';
  }
  if (headlessTerminalLoadError instanceof Error && headlessTerminalLoadError.message) {
    return `xterm-headless unavailable: ${headlessTerminalLoadError.message}`;
  }
  return `xterm-headless unavailable: ${String(headlessTerminalLoadError)}`;
}

function parseNumericParams(raw) {
  if (!raw) return [];
  return raw
    .split(';')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isFinite(value));
}

function findSseBlockDelimiter(buffer) {
  if (!buffer || typeof buffer !== 'string') return null;
  const delimiters = [
    { marker: '\n\n', length: 2 },
    { marker: '\r\n\r\n', length: 4 }
  ];
  let best = null;

  for (const delimiter of delimiters) {
    const index = buffer.indexOf(delimiter.marker);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { index, length: delimiter.length };
    }
  }

  return best;
}

function numberArrayEquals(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function appendReadableControl(list, droppedRef, maxControls, control) {
  if (!control) return;
  if (list.length >= maxControls) {
    droppedRef.count += 1;
    return;
  }

  const last = list[list.length - 1];
  const sameAsLast = last
    && last.kind === control.kind
    && last.op === control.op
    && last.mode === control.mode
    && last.enabled === control.enabled
    && last.visible === control.visible
    && last.name === control.name
    && last.code === control.code
    && last.final === control.final
    && numberArrayEquals(last.params, control.params);

  if (sameAsLast) {
    last.count = (last.count || 1) + 1;
    return;
  }

  list.push(control);
}

function parseCsiControls(paramText, finalByte) {
  const controls = [];
  const questionMode = paramText.startsWith('?');
  const rawParams = questionMode ? paramText.slice(1) : paramText;
  const params = parseNumericParams(rawParams);
  const firstParam = params.length > 0 ? params[0] : 0;

  if (finalByte === 'm') {
    controls.push({
      kind: 'sgr',
      params: params.length > 0 ? params : [0]
    });
    return controls;
  }

  if (finalByte === 'K') {
    controls.push({ kind: 'erase_line', mode: firstParam });
    return controls;
  }

  if (finalByte === 'J') {
    controls.push({ kind: 'erase_display', mode: firstParam });
    return controls;
  }

  const cursorOps = {
    A: 'up',
    B: 'down',
    C: 'right',
    D: 'left',
    E: 'next_line',
    F: 'prev_line',
    G: 'column',
    H: 'position',
    f: 'position',
    d: 'row'
  };
  if (cursorOps[finalByte]) {
    controls.push({
      kind: 'cursor',
      op: cursorOps[finalByte],
      params
    });
    return controls;
  }

  if ((finalByte === 'h' || finalByte === 'l') && questionMode) {
    const enabled = finalByte === 'h';
    for (const mode of params) {
      if (mode === 25) {
        controls.push({
          kind: 'cursor_visibility',
          visible: enabled
        });
      } else if (mode === 47 || mode === 1047 || mode === 1049) {
        controls.push({
          kind: 'alternate_screen',
          enabled
        });
      } else if (mode === 2004) {
        controls.push({
          kind: 'bracketed_paste',
          enabled
        });
      } else if (mode === 1004) {
        controls.push({
          kind: 'focus_tracking',
          enabled
        });
      } else {
        controls.push({
          kind: 'private_mode',
          mode,
          enabled
        });
      }
    }
    return controls;
  }

  if (finalByte === '@') {
    controls.push({ kind: 'insert_chars', count: firstParam || 1 });
    return controls;
  }

  if (finalByte === 'P') {
    controls.push({ kind: 'delete_chars', count: firstParam || 1 });
    return controls;
  }

  controls.push({
    kind: 'csi',
    final: finalByte,
    params
  });
  return controls;
}

class ReadableOutputParser {
  constructor() {
    this.carry = '';
    this.lineChars = [];
    this.cursorCol = 0;
  }

  parseChunk(data, options = {}) {
    const maxControls = Number.isFinite(options.maxControlOps)
      ? Math.max(1, Math.floor(options.maxControlOps))
      : 200;

    const controls = [];
    const dropped = { count: 0 };
    const outputParts = [];
    const chunkStartLine = this.lineChars.join('');
    let lineChanged = false;
    let destructiveEdit = false;
    let flushedThisChunk = false;

    const writeVisibleChar = (ch) => {
      const col = Math.max(0, this.cursorCol);
      while (this.lineChars.length < col) {
        this.lineChars.push(' ');
      }
      if (col === this.lineChars.length) {
        this.lineChars.push(ch);
      } else {
        this.lineChars[col] = ch;
      }
      this.cursorCol = col + 1;
      lineChanged = true;
    };

    const flushLine = () => {
      outputParts.push(this.lineChars.join(''));
      outputParts.push('\n');
      this.lineChars = [];
      this.cursorCol = 0;
      lineChanged = false;
      destructiveEdit = false;
      flushedThisChunk = true;
    };

    const applyCursorControl = (control) => {
      const step = Array.isArray(control.params) && control.params.length > 0
        ? Math.max(1, control.params[0] || 1)
        : 1;

      switch (control.op) {
        case 'right':
          this.cursorCol = Math.max(0, this.cursorCol + step);
          break;
        case 'left':
          this.cursorCol = Math.max(0, this.cursorCol - step);
          destructiveEdit = true;
          break;
        case 'column':
          this.cursorCol = Math.max(0, step - 1);
          destructiveEdit = true;
          break;
        case 'position': {
          const colParam = Array.isArray(control.params) && control.params.length > 1
            ? Math.max(1, control.params[1] || 1)
            : 1;
          this.cursorCol = Math.max(0, colParam - 1);
          destructiveEdit = true;
          break;
        }
        case 'next_line':
        case 'prev_line':
          flushLine();
          break;
        case 'up':
        case 'down':
        case 'row':
          // Vertical navigation cannot be faithfully reconstructed in a flat stream.
          destructiveEdit = true;
          break;
        default:
          break;
      }
    };

    const applyLineErase = (mode) => {
      if (mode === 2) {
        this.lineChars = [];
        this.cursorCol = 0;
        lineChanged = true;
        destructiveEdit = true;
        return;
      }
      if (mode === 0) {
        if (this.cursorCol < this.lineChars.length) {
          this.lineChars = this.lineChars.slice(0, this.cursorCol);
          lineChanged = true;
          destructiveEdit = true;
        }
        return;
      }
      if (mode === 1) {
        const limit = Math.min(this.cursorCol + 1, this.lineChars.length);
        if (limit <= 0) return;
        for (let i = 0; i < limit; i += 1) {
          this.lineChars[i] = ' ';
        }
        lineChanged = true;
        destructiveEdit = true;
      }
    };

    const applyReadableControlText = (control) => {
      if (!control || typeof control !== 'object') return;
      if (control.kind === 'cursor') {
        applyCursorControl(control);
        return;
      }
      if (control.kind === 'erase_line') {
        applyLineErase(control.mode || 0);
        return;
      }
      if (control.kind === 'insert_chars') {
        const count = Number.isFinite(control.count) ? Math.max(1, Math.floor(control.count)) : 1;
        const cursor = Math.max(0, this.cursorCol);
        while (this.lineChars.length < cursor) this.lineChars.push(' ');
        this.lineChars.splice(cursor, 0, ...new Array(Math.min(count, 500)).fill(' '));
        lineChanged = true;
        destructiveEdit = true;
        return;
      }
      if (control.kind === 'delete_chars') {
        const count = Number.isFinite(control.count) ? Math.max(1, Math.floor(control.count)) : 1;
        if (this.cursorCol < this.lineChars.length) {
          this.lineChars.splice(this.cursorCol, count);
          lineChanged = true;
          destructiveEdit = true;
        }
      }
    };

    const source = this.carry + String(data || '');
    this.carry = '';

    let i = 0;
    while (i < source.length) {
      const ch = source.charCodeAt(i);

      if (ch === 0x1b) {
        if (i + 1 >= source.length) {
          this.carry = source.slice(i);
          break;
        }

        const next = source[i + 1];
        if (next === '[') {
          let j = i + 2;
          while (j < source.length) {
            const code = source.charCodeAt(j);
            if (code >= 0x40 && code <= 0x7e) break;
            j += 1;
          }
          if (j >= source.length) {
            this.carry = source.slice(i);
            break;
          }

          const paramText = source.slice(i + 2, j);
          const finalByte = source[j];
          const parsedControls = parseCsiControls(paramText, finalByte);
          for (const control of parsedControls) {
            appendReadableControl(controls, dropped, maxControls, control);
            applyReadableControlText(control);
          }
          i = j + 1;
          continue;
        }

        if (next === ']') {
          // OSC: ESC ] ... BEL or ESC \
          let j = i + 2;
          let terminated = false;
          while (j < source.length) {
            const code = source.charCodeAt(j);
            if (code === 0x07) {
              terminated = true;
              j += 1;
              break;
            }
            if (code === 0x1b && source[j + 1] === '\\') {
              terminated = true;
              j += 2;
              break;
            }
            j += 1;
          }
          if (!terminated) {
            this.carry = source.slice(i);
            break;
          }
          appendReadableControl(controls, dropped, maxControls, { kind: 'osc' });
          i = j;
          continue;
        }

        // Generic ESC + one byte sequence.
        appendReadableControl(controls, dropped, maxControls, { kind: 'esc' });
        i += 2;
        continue;
      }

      if (ch === 0x0d) {
        appendReadableControl(controls, dropped, maxControls, { kind: 'carriage_return' });
        this.cursorCol = 0;
        destructiveEdit = true;
        i += 1;
        continue;
      }
      if (ch === 0x0a) {
        appendReadableControl(controls, dropped, maxControls, { kind: 'line_feed' });
        flushLine();
        i += 1;
        continue;
      }
      if (ch === 0x08) {
        appendReadableControl(controls, dropped, maxControls, { kind: 'backspace' });
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        destructiveEdit = true;
        i += 1;
        continue;
      }
      if (ch === 0x09) {
        const tabWidth = 8;
        const nextStops = tabWidth - (this.cursorCol % tabWidth || 0);
        for (let s = 0; s < nextStops; s += 1) {
          writeVisibleChar(' ');
        }
        i += 1;
        continue;
      }
      if (ch < 0x20 || ch === 0x7f) {
        appendReadableControl(controls, dropped, maxControls, { kind: 'control', code: ch });
        i += 1;
        continue;
      }

      writeVisibleChar(source[i]);
      i += 1;
    }

    const endLine = this.lineChars.join('');
    if (flushedThisChunk) {
      if (endLine.length > 0) {
        outputParts.push(endLine);
      }
    } else if (lineChanged) {
      if (!destructiveEdit && endLine.startsWith(chunkStartLine)) {
        outputParts.push(endLine.slice(chunkStartLine.length));
      } else {
        outputParts.push(endLine);
      }
    }

    const parsed = {
      text: outputParts.join('')
    };
    if (controls.length > 0) parsed.controls = controls;
    if (dropped.count > 0) parsed.controlsDropped = dropped.count;
    return parsed;
  }
}

function parseReadableOutput(data, options = {}) {
  const parser = new ReadableOutputParser();
  return parser.parseChunk(data, options);
}

function requestJson(method, baseUrl, endpoint, token, actor, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    const isHttps = url.protocol === 'https:';
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Accept': 'application/json',
      [DEFAULT_ACTOR_HEADER]: actor || DEFAULT_ACTOR
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn({
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const contentType = String(res.headers['content-type'] || '');
        if (contentType.includes('application/json')) {
          try {
            const json = data ? JSON.parse(data) : null;
            resolve({ status: res.statusCode || 500, data: json });
          } catch (err) {
            resolve({ status: res.statusCode || 500, data });
          }
        } else {
          resolve({ status: res.statusCode || 500, data });
        }
      });
    });
    req.on('error', reject);
    // Without a timeout a wedged daemon (or half-open TCP through the tunnel)
    // leaves every tool call awaiting forever and the MCP server looks dead.
    req.setTimeout(REQUEST_JSON_TIMEOUT_MS, () => {
      req.destroy(new Error(`request to ${endpoint} timed out after ${REQUEST_JSON_TIMEOUT_MS}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

class TerminalStreamManager {
  constructor() {
    this.streams = new Map();
    this.HeadlessTerminal = loadHeadlessTerminalCtor();
  }

  normalizeSize(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 2) return fallback;
    return Math.floor(parsed);
  }

  createVirtualScreen(cols, rows) {
    if (!this.HeadlessTerminal) return null;
    try {
      return new this.HeadlessTerminal({
        cols,
        rows,
        scrollback: 5000,
        allowProposedApi: true
      });
    } catch (err) {
      headlessTerminalLoadError = err;
      return null;
    }
  }

  applySizing(state, options = {}) {
    const nextCols = this.normalizeSize(options.cols, state.cols);
    const nextRows = this.normalizeSize(options.rows, state.rows);
    if (nextCols === state.cols && nextRows === state.rows) return;

    state.cols = nextCols;
    state.rows = nextRows;

    if (!state.virtualScreen) return;

    try {
      state.virtualScreen.resize(nextCols, nextRows);
      state.screenRevision += 1;
    } catch (err) {
      state.virtualScreenError = `Virtual screen resize failed: ${err instanceof Error ? err.message : String(err)}`;
      state.virtualScreen = null;
    }
  }

  setTerminalSize(terminalId, cols, rows) {
    const state = this.streams.get(terminalId);
    if (!state) return;
    this.applySizing(state, { cols, rows });
  }

  noteTerminalInput(terminalId, data) {
    if (typeof data !== 'string' || data.length === 0) return;
    const state = this.streams.get(terminalId);
    if (!state || !state.readableRaw) return;
    const echoState = state.readableRaw.echo || (state.readableRaw.echo = createReadableEchoState());
    recordReadableEchoCandidates(echoState, data, Date.now());
  }

  ensure(baseUrl, token, actor, terminalId, options = {}) {
    const existing = this.streams.get(terminalId);
    if (existing) {
      this.applySizing(existing, options);
      if ((existing.closed || existing.error) && !existing.connecting) {
        this.restartStream(baseUrl, token, actor, existing);
      }
      return existing;
    }

    const cols = this.normalizeSize(options.cols, DEFAULT_TERMINAL_COLS);
    const rows = this.normalizeSize(options.rows, DEFAULT_TERMINAL_ROWS);
    const virtualScreen = this.createVirtualScreen(cols, rows);

    const state = {
      terminalId,
      events: [],
      nextId: 1,
      closed: false,
      connected: false,
      connecting: false,
      error: null,
      buffer: '',
      connectResolved: false,
      resolveConnected: null,
      connectPromise: null,
      lastServerEventId: 0,
      cols,
      rows,
      virtualScreen,
      virtualScreenError: virtualScreen ? null : getHeadlessUnavailableReason(),
      parseQueue: Promise.resolve(),
      screenRevision: 0,
      alternateScreen: false,
      cursorHidden: false,
      readableRaw: {
        parser: new ReadableOutputParser(),
        parsedByEventId: new Map(),
        noise: createReadableNoiseState(),
        echo: createReadableEchoState()
      }
    };
    this.resetConnectPromise(state);
    this.streams.set(terminalId, state);
    this.startStream(baseUrl, token, actor, state);
    return state;
  }

  resetConnectPromise(state) {
    state.connectResolved = false;
    state.connectPromise = new Promise((resolve) => {
      state.resolveConnected = resolve;
    });
  }

  restartStream(baseUrl, token, actor, state) {
    if (!state || state.connecting) return;
    state.closed = false;
    state.connected = false;
    state.error = null;
    state.buffer = '';
    this.resetConnectPromise(state);
    this.startStream(baseUrl, token, actor, state);
  }

  resolveConnection(state) {
    if (!state.connectResolved && typeof state.resolveConnected === 'function') {
      state.connectResolved = true;
      state.resolveConnected(state.connected);
    }
  }

  async waitUntilConnected(terminalId, timeoutMs = STREAM_CONNECT_TIMEOUT_MS) {
    const state = this.streams.get(terminalId);
    if (!state) return false;
    if (state.closed || state.error) return false;
    if (state.connected) return true;

    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs));
    const connected = await Promise.race([state.connectPromise, timeout]);
    return !!connected;
  }

  async waitForOutputEvent(terminalId, timeoutMs = 0) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

    const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
    while (Date.now() <= deadline) {
      const state = this.streams.get(terminalId);
      if (!state) return false;
      if (state.events.some((event) => (
        event
        && event.payload
        && typeof event.payload === 'object'
        && (event.payload.type === 'output' || event.payload.type === 'snapshot')
      ))) {
        return true;
      }
      if (state.closed || state.error) return false;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    return false;
  }

  remove(terminalId) {
    const state = this.streams.get(terminalId);
    if (state && state.virtualScreen && typeof state.virtualScreen.dispose === 'function') {
      try {
        state.virtualScreen.dispose();
      } catch (err) {
        // no-op
      }
    }
    this.streams.delete(terminalId);
  }

  async flushVirtualScreen(terminalId, timeoutMs = UI_PARSER_FLUSH_TIMEOUT_MS) {
    const state = this.streams.get(terminalId);
    if (!state || !state.virtualScreen) return;
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    await Promise.race([state.parseQueue.catch(() => {}), timeout]);
  }

  // Full rendered viewport of the virtual screen as plain text (one line per
  // row, trailing blank rows trimmed), or null if the screen isn't available.
  // Used by until_regex/until_prompt screen-matching, where the linear output
  // stream doesn't contain what a redraw-heavy TUI actually renders.
  getScreenText(terminalId) {
    const state = this.streams.get(terminalId);
    if (!state || !state.virtualScreen) return null;
    const buffer = state.virtualScreen.buffer.active;
    const viewportStart = buffer.baseY;
    const lines = [];
    for (let row = viewportStart; row < viewportStart + state.rows; row++) {
      const line = buffer.getLine(row);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  getUiSnapshot(terminalId, options = {}) {
    const state = this.streams.get(terminalId);
    if (!state) {
      return {
        available: false,
        reason: 'Terminal stream not initialized'
      };
    }

    if (!state.virtualScreen) {
      return {
        available: false,
        reason: state.virtualScreenError || getHeadlessUnavailableReason(),
        cols: state.cols,
        rows: state.rows,
        screenRevision: state.screenRevision,
        alternateScreen: state.alternateScreen,
        cursorHidden: state.cursorHidden
      };
    }

    const buffer = state.virtualScreen.buffer.active;
    const requestedLines = Number.isFinite(options.maxLines) && options.maxLines > 0
      ? Math.floor(options.maxLines)
      : state.rows;
    const lineCount = Math.max(1, Math.min(requestedLines, state.rows));
    const viewportStart = buffer.baseY;
    const viewportEnd = viewportStart + state.rows - 1;
    const cursorAbsoluteY = buffer.baseY + buffer.cursorY;
    const viewportLines = [];
    for (let row = viewportStart; row <= viewportEnd; row++) {
      const line = buffer.getLine(row);
      const text = line ? line.translateToString(true) : '';
      viewportLines.push({
        row,
        text,
        wrapped: !!(line && line.isWrapped),
        nonEmpty: text.trim().length > 0
      });
    }

    const maxStartInViewport = Math.max(viewportStart, viewportEnd - lineCount + 1);
    const centeredStart = cursorAbsoluteY - Math.floor(lineCount / 2);
    let startRow = lineCount < state.rows
      ? Math.max(viewportStart, Math.min(centeredStart, maxStartInViewport))
      : viewportStart;
    let windowStrategy = lineCount < state.rows ? 'cursor_centered' : 'full_viewport';

    const prefixNonEmpty = [0];
    for (const line of viewportLines) {
      prefixNonEmpty.push(prefixNonEmpty[prefixNonEmpty.length - 1] + (line.nonEmpty ? 1 : 0));
    }

    const countNonEmpty = (rowStart) => {
      const offset = Math.max(0, Math.min(state.rows - lineCount, rowStart - viewportStart));
      const end = offset + lineCount;
      return prefixNonEmpty[end] - prefixNonEmpty[offset];
    };

    const cursorWindowNonEmpty = countNonEmpty(startRow);
    if (lineCount < state.rows && cursorWindowNonEmpty === 0) {
      let bestStart = startRow;
      let bestNonEmpty = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset <= state.rows - lineCount; offset++) {
        const candidateStart = viewportStart + offset;
        const candidateNonEmpty = prefixNonEmpty[offset + lineCount] - prefixNonEmpty[offset];
        const candidateCenter = candidateStart + Math.floor(lineCount / 2);
        const distanceFromCursor = Math.abs(candidateCenter - cursorAbsoluteY);
        if (
          candidateNonEmpty > bestNonEmpty
          || (candidateNonEmpty === bestNonEmpty && distanceFromCursor < bestDistance)
        ) {
          bestStart = candidateStart;
          bestNonEmpty = candidateNonEmpty;
          bestDistance = distanceFromCursor;
        }
      }
      if (bestNonEmpty > 0) {
        startRow = bestStart;
        windowStrategy = 'densest_nonempty';
      }
    }

    const endRow = startRow + lineCount;
    const lines = viewportLines
      .slice(startRow - viewportStart, endRow - viewportStart)
      .map((line) => ({
        row: line.row,
        text: line.text,
        wrapped: line.wrapped
      }));
    const nonEmptyLineCount = lines.reduce((count, line) => (
      line.text.trim().length > 0 ? count + 1 : count
    ), 0);
    const cursorRow = cursorAbsoluteY - startRow;
    const cursorInWindow = cursorRow >= 0 && cursorRow < lines.length;
    const cursorLine = cursorInWindow ? lines[cursorRow] : null;

    return {
      available: true,
      cols: state.cols,
      rows: state.rows,
      screenRevision: state.screenRevision,
      viewport: {
        start: viewportStart,
        end: viewportStart + state.rows - 1
      },
      window: {
        start: startRow,
        end: endRow - 1,
        cursorRow,
        cursorInWindow,
        strategy: windowStrategy,
        nonEmptyLineCount
      },
      cursor: {
        x: buffer.cursorX,
        y: buffer.cursorY,
        absoluteY: cursorAbsoluteY
      },
      cursorLine,
      alternateScreen: state.alternateScreen,
      cursorHidden: state.cursorHidden,
      lines
    };
  }

  // Read the state of a TUI input box ("composer") from the live virtual screen,
  // distinguishing text the user/agent actually typed from the dim ghost
  // placeholder the app shows when the box is empty. The discriminator is the
  // per-cell SGR dim attribute (cell.isDim()) rather than stripping \e[2m from a
  // string, which sidesteps the color-payload ambiguity of attribute-blind scrapes.
  //
  // Strategy: scan the bottom of the viewport for a box-drawing frame
  // (╭…╮ / ╰…╯). The rows between the corners are the composer body; within them
  // we drop border cells, a leading prompt glyph (> / ❯), and any run of dim
  // cells (the placeholder), and keep the rest as the real input `text`.
  //
  // Returns { available, found, strategy, text, ghost, isEmpty, boxTop, boxBottom }.
  // found=false (with available=true) means no recognizable composer was on
  // screen — callers must treat that as "cannot verify", never as "empty".
  getComposerState(terminalId, options = {}) {
    const state = this.streams.get(terminalId);
    if (!state || !state.virtualScreen) {
      return { available: false, found: false, reason: 'virtual screen unavailable' };
    }
    const buffer = state.virtualScreen.buffer.active;
    const rows = state.rows;
    const cols = state.cols;
    const viewportStart = buffer.baseY;
    const scanRows = Math.min(rows, Number.isFinite(options.scanRows) ? Math.max(1, Math.floor(options.scanRows)) : 16);
    // The composer is usually pinned near the bottom, but a near-empty screen
    // (e.g. a freshly launched Claude Code with only a welcome banner) draws it
    // top-aligned with empty rows below it. Anchoring the scan to the physical
    // bottom would then look only at those empty trailing rows and miss the
    // composer entirely — which silently defeats both verified-submit and
    // needs_input(parked_composer). Anchor to the last non-empty row instead.
    const viewportTop = viewportStart;
    const viewportBottom = viewportStart + rows - 1;
    let lastRow = viewportBottom;
    for (let row = viewportBottom; row >= viewportTop; row--) {
      const line = buffer.getLine(row);
      if (line && line.translateToString(true).trim()) { lastRow = row; break; }
    }
    const firstScanRow = Math.max(viewportTop, lastRow - scanRows + 1);

    const cell = buffer.getNullCell ? buffer.getNullCell() : undefined;
    const firstChar = (row) => {
      const line = buffer.getLine(row);
      if (!line) return '';
      const s = line.translateToString(true);
      const trimmed = s.replace(/\s+$/, '');
      const idx = trimmed.search(/\S/);
      return idx < 0 ? '' : trimmed[idx];
    };

    // Find the bottom border first (search upward from the screen bottom), then
    // the matching top border above it.
    let boxBottom = -1;
    for (let row = lastRow; row >= firstScanRow; row--) {
      if (COMPOSER_BOTTOM_CORNER_CHARS.has(firstChar(row))) { boxBottom = row; break; }
    }
    let boxTop = -1;
    if (boxBottom >= 0) {
      for (let row = boxBottom - 1; row >= firstScanRow; row--) {
        if (COMPOSER_TOP_CORNER_CHARS.has(firstChar(row))) { boxTop = row; break; }
        // A second bottom corner before a top corner means we mis-paired; reset.
        if (COMPOSER_BOTTOM_CORNER_CHARS.has(firstChar(row))) { boxBottom = row; }
      }
    }

    const readBody = (rowStart, rowEnd) => {
      let real = '';
      let ghost = '';
      let strippedPrompt = false;
      for (let row = rowStart; row <= rowEnd; row++) {
        const line = buffer.getLine(row);
        if (!line) continue;
        const lineLen = Math.min(cols, line.length);
        let rowReal = '';
        for (let x = 0; x < lineLen; x++) {
          const c = line.getCell(x, cell);
          if (!c) continue;
          if (c.getWidth() === 0) continue; // trailing half of a wide glyph
          const ch = c.getChars();
          if (!ch) continue;
          if (COMPOSER_BORDER_CHARS.has(ch)) continue; // box frame
          // Strip a single leading prompt glyph at the very start of the body.
          if (!strippedPrompt && COMPOSER_PROMPT_CHARS.has(ch) && rowReal.trim() === '' && real.trim() === '') {
            strippedPrompt = true;
            continue;
          }
          if (c.isDim()) { ghost += ch; continue; } // placeholder ghost text
          rowReal += ch;
        }
        real += (real && rowReal.trim() ? ' ' : '') + rowReal;
      }
      return { real: real.replace(/\s+/g, ' ').trim(), ghost: ghost.replace(/\s+/g, ' ').trim() };
    };

    if (boxTop >= 0 && boxBottom > boxTop) {
      const body = readBody(boxTop + 1, boxBottom - 1);
      return {
        available: true,
        found: true,
        strategy: 'box',
        text: body.real,
        ghost: body.ghost,
        isEmpty: body.real.length === 0,
        boxTop: boxTop - viewportStart,
        boxBottom: boxBottom - viewportStart
      };
    }

    // No frame: fall back to a bare prompt line (legacy/narrow TUIs, and modern
    // Claude Code which draws `❯ ` with horizontal rules rather than a box).
    // Anchor to the CURSOR's line first: the cursor sits in the active input, so
    // it is the composer. Scanning "first prompt glyph up from the bottom"
    // mis-fires here — Claude's `⏵⏵ bypass permissions` status line sits BELOW
    // the composer and `⏵` is itself a prompt glyph, so a bottom-up scan reads
    // that status line as composer text (found, but never empty).
    const cursorRow = viewportStart + (typeof buffer.cursorY === 'number' ? buffer.cursorY : 0);
    if (cursorRow >= viewportTop && cursorRow <= viewportBottom
        && COMPOSER_PROMPT_CHARS.has(firstChar(cursorRow))) {
      const body = readBody(cursorRow, cursorRow);
      return {
        available: true,
        found: true,
        strategy: 'cursor-prompt',
        text: body.real,
        ghost: body.ghost,
        isEmpty: body.real.length === 0,
        boxTop: cursorRow - viewportStart,
        boxBottom: cursorRow - viewportStart
      };
    }
    // Last resort: scan up from the bottom, but skip the bypass-permissions
    // status line so it can't masquerade as the composer.
    for (let row = lastRow; row >= firstScanRow; row--) {
      if (!COMPOSER_PROMPT_CHARS.has(firstChar(row))) continue;
      const body = readBody(row, row);
      if (/bypass permissions|shift\+tab to cycle/i.test(body.real)) continue;
      return {
        available: true,
        found: true,
        strategy: 'prompt',
        text: body.real,
        ghost: body.ghost,
        isEmpty: body.real.length === 0,
        boxTop: row - viewportStart,
        boxBottom: row - viewportStart
      };
    }

    return { available: true, found: false, strategy: 'none', text: '', ghost: '', isEmpty: false };
  }

  startStream(baseUrl, token, actor, state) {
    state.connecting = true;
    state.closed = false;
    state.error = null;

    const url = new URL(`/api/terminals/${encodeURIComponent(state.terminalId)}/stream`, baseUrl);
    if (state.lastServerEventId > 0) {
      url.searchParams.set('after', String(state.lastServerEventId));
    }
    const isHttps = url.protocol === 'https:';
    const headers = {
      'Accept': 'text/event-stream',
      [DEFAULT_ACTOR_HEADER]: actor || DEFAULT_ACTOR
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn({
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers
    }, (res) => {
      if ((res.statusCode || 500) >= 400) {
        state.connected = false;
        state.connecting = false;
        state.error = new Error(`Stream request failed (${res.statusCode || 500})`);
        state.closed = true;
        this.resolveConnection(state);
        res.resume();
        return;
      }

      state.connected = true;
      state.connecting = false;
      state.closed = false;
      state.error = null;
      this.resolveConnection(state);

      res.on('data', chunk => this.handleChunk(state, chunk.toString('utf8')));
      res.on('end', () => {
        state.connected = false;
        state.connecting = false;
        state.closed = true;
        this.resolveConnection(state);
      });
    });

    req.on('error', (err) => {
      state.connected = false;
      state.connecting = false;
      state.error = err;
      state.closed = true;
      this.resolveConnection(state);
    });

    req.end();
  }

  handleChunk(state, chunk) {
    state.buffer += chunk;
    while (true) {
      const delimiter = findSseBlockDelimiter(state.buffer);
      if (!delimiter) break;
      const block = state.buffer.slice(0, delimiter.index);
      state.buffer = state.buffer.slice(delimiter.index + delimiter.length);
      this.handleBlock(state, block);
    }
  }

  handleBlock(state, block) {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.replace(/^data:\s?/, ''));
      }
    }
    if (!dataLines.length) return;
    const payloadText = dataLines.join('\n');
    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch (err) {
      payload = { type: 'raw', data: payloadText };
    }
    this.pushEvent(state, payload);
  }

  trackFlagsFromPayload(state, payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.alternateScreen === 'boolean') {
      state.alternateScreen = payload.alternateScreen;
    }
    if (typeof payload.cursorHidden === 'boolean') {
      state.cursorHidden = payload.cursorHidden;
    }
  }

  queueVirtualScreenWrite(state, payload) {
    if (!state.virtualScreen) return;
    if (!payload || typeof payload !== 'object') return;
    if (payload.type !== 'output' && payload.type !== 'snapshot') return;
    if (typeof payload.data !== 'string' || payload.data.length === 0) return;

    const data = payload.data;
    state.parseQueue = state.parseQueue.catch(() => {}).then(() => {
      return new Promise((resolve) => {
        if (!state.virtualScreen) {
          resolve();
          return;
        }
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          resolve();
        };

        const timer = setTimeout(done, 100);
        try {
          state.virtualScreen.write(data, () => {
            clearTimeout(timer);
            state.screenRevision += 1;
            done();
          });
        } catch (err) {
          clearTimeout(timer);
          state.virtualScreenError = `Virtual screen write failed: ${err instanceof Error ? err.message : String(err)}`;
          state.virtualScreen = null;
          done();
        }
      });
    });
  }

  pushEvent(state, payload) {
    if (payload && typeof payload === 'object' && Number.isFinite(payload.streamEventId)) {
      const serverEventId = Math.floor(payload.streamEventId);
      if (serverEventId <= state.lastServerEventId) {
        return;
      }
      state.lastServerEventId = serverEventId;
    }

    const event = {
      id: state.nextId++,
      payload,
      timestamp: Date.now()
    };
    state.events.push(event);
    this.trackFlagsFromPayload(state, payload);
    this.queueVirtualScreenWrite(state, payload);
    if (state.events.length > MAX_BUFFER_EVENTS) {
      state.events.splice(0, state.events.length - MAX_BUFFER_EVENTS);
    }

    if (state.readableRaw && state.readableRaw.parsedByEventId) {
      const minId = state.events.length > 0 ? state.events[0].id : state.nextId;
      for (const id of state.readableRaw.parsedByEventId.keys()) {
        if (id < minId) {
          state.readableRaw.parsedByEventId.delete(id);
        }
      }
      if (
        state.readableRaw.noise
        && state.readableRaw.noise.filteredBaseByEventId
        && typeof state.readableRaw.noise.filteredBaseByEventId.delete === 'function'
      ) {
        for (const id of state.readableRaw.noise.filteredBaseByEventId.keys()) {
          if (id < minId) {
            state.readableRaw.noise.filteredBaseByEventId.delete(id);
          }
        }
      }
    }
  }

  getLatestCursor(terminalId) {
    const state = this.streams.get(terminalId);
    if (!state) return null;
    return state.nextId - 1;
  }

  getTerminalFlags(terminalId) {
    const state = this.streams.get(terminalId);
    if (!state) {
      return {
        exists: false,
        closed: true,
        alternateScreen: false,
        cursorHidden: false
      };
    }
    return {
      exists: true,
      closed: !!state.closed,
      alternateScreen: !!state.alternateScreen,
      cursorHidden: !!state.cursorHidden
    };
  }

  getBeginningCursor(terminalId) {
    const state = this.streams.get(terminalId);
    if (!state) return null;
    if (state.events.length > 0) {
      return state.events[0].id - 1;
    }
    return state.nextId - 1;
  }

  readEvents(terminalId, cursor, maxBytes, maxEvents) {
    const state = this.streams.get(terminalId);
    if (!state) return { events: [], records: [], cursor, done: true, closed: true, error: 'Stream not initialized' };

    const startId = typeof cursor === 'number' ? cursor + 1 : state.events.length ? state.events[0].id : state.nextId;
    const events = [];
    const records = [];
    let bytes = 0;
    let lastId = typeof cursor === 'number' ? cursor : null;

    for (const event of state.events) {
      if (event.id < startId) continue;
      const serialized = JSON.stringify(event.payload);
      const size = Buffer.byteLength(serialized, 'utf8');
      if (maxBytes && bytes + size > maxBytes) break;
      events.push(event.payload);
      records.push({
        id: event.id,
        payload: event.payload
      });
      bytes += size;
      lastId = event.id;
      if (maxEvents && events.length >= maxEvents) break;
    }

    return {
      events,
      records,
      cursor: lastId,
      done: state.closed,
      closed: state.closed,
      error: state.error ? String(state.error.message || state.error) : null
    };
  }

  mapReadableRawEvents(terminalId, records, options = {}) {
    const state = this.streams.get(terminalId);
    if (!state || !state.readableRaw) {
      return (records || []).map((record) => record && record.payload ? record.payload : record);
    }

    const maxControlOps = Number.isFinite(options.maxControlOps)
      ? Math.max(1, Math.floor(options.maxControlOps))
      : 200;
    const includeRawData = options.includeRawData === true;
    const includeMetaEvents = options.includeMetaEvents === true;
    const controlLevel = normalizeReadableControlLevel(options.controlLevel) || DEFAULT_READABLE_CONTROL_LEVEL;
    const noiseFilter = normalizeReadableNoiseFilter(options.noiseFilter) || DEFAULT_READABLE_NOISE_FILTER;
    const coalesceMs = normalizeReadableCoalesceMs(options.coalesceMs);
    const coalesceMaxChars = normalizeReadableCoalesceMaxChars(options.coalesceMaxChars);
    const parsedByEventId = state.readableRaw.parsedByEventId;
    const parser = state.readableRaw.parser;
    const noiseState = state.readableRaw.noise || (state.readableRaw.noise = createReadableNoiseState());

    const mappedEntries = (records || []).map((record) => {
      if (!record || typeof record !== 'object') return record;

      const event = record.payload;
      if (!event || typeof event !== 'object') {
        return { id: record.id, event, rawData: null };
      }

      if ((event.type !== 'output' && event.type !== 'snapshot') || typeof event.data !== 'string') {
        return { id: record.id, event, rawData: null };
      }

      let mapped = parsedByEventId.get(record.id);
      if (!mapped) {
        const parsed = parser.parseChunk(event.data, { maxControlOps });
        mapped = {
          type: event.type,
          text: parsed.text
        };
        if (parsed.controls) mapped.controls = parsed.controls;
        if (parsed.controlsDropped) mapped.controlsDropped = parsed.controlsDropped;
        if (typeof event.alternateScreen === 'boolean') mapped.alternateScreen = event.alternateScreen;
        if (typeof event.cursorHidden === 'boolean') mapped.cursorHidden = event.cursorHidden;
        if (typeof event.streamEventId === 'number') mapped.streamEventId = event.streamEventId;
        if (Number.isFinite(event.timestamp)) mapped.timestamp = event.timestamp;
        parsedByEventId.set(record.id, mapped);
      }

      return {
        id: record.id,
        event: mapped,
        rawData: event.data
      };
    });

    const withRawData = (event, rawData) => {
      if (!includeRawData) return event;
      if (!event || typeof event !== 'object') return event;
      if (!isReadableOutputEvent(event) && !isReadableEmptyOutputEvent(event)) return event;
      return {
        ...event,
        rawData: typeof rawData === 'string' ? rawData : ''
      };
    };

    let mappedEvents;
    if (noiseFilter === 'balanced') {
      mappedEvents = [];
      for (const entry of mappedEntries) {
        if (!entry || typeof entry !== 'object') continue;
        const recordId = Number.isFinite(entry.id) ? Math.floor(entry.id) : null;
        const mappedEvent = entry.event;

        if (recordId === null) {
          const filtered = applyBalancedReadableNoiseFilter(noiseState, mappedEvent);
          mappedEvents.push(...filtered.map((item) => withRawData(item, entry.rawData)));
          continue;
        }

        let filteredEvents = noiseState.filteredBaseByEventId.get(recordId);
        if (!filteredEvents) {
          filteredEvents = applyBalancedReadableNoiseFilter(noiseState, mappedEvent);
          noiseState.filteredBaseByEventId.set(recordId, filteredEvents);
        }
        if (Array.isArray(filteredEvents) && filteredEvents.length > 0) {
          mappedEvents.push(...filteredEvents.map((item) => withRawData(item, entry.rawData)));
        }
      }

      const flushed = [];
      flushReadablePendingRewrite(noiseState, Date.now(), flushed, false);
      if (flushed.length > 0) {
        mappedEvents.push(...flushed.map((item) => withRawData(item, null)));
      }
    } else {
      mappedEvents = mappedEntries.map((entry) => {
        if (!entry || typeof entry !== 'object') return entry;
        return withRawData(entry.event, entry.rawData);
      });
    }

    const echoSuppressedEvents = noiseFilter === 'balanced'
      ? suppressReadableEchoAndPromptNoise(state.readableRaw.echo, mappedEvents)
      : mappedEvents;

    const shouldFilterControls = controlLevel !== 'full';
    const controlFilteredEvents = echoSuppressedEvents.map((event) => {
      if (!event || typeof event !== 'object') return event;
      if (!isReadableOutputEvent(event) && !isReadableEmptyOutputEvent(event)) {
        return event;
      }

      let next = event;
      if (shouldFilterControls || includeRawData) {
        next = { ...event };
      }

      if (shouldFilterControls) {
        const filteredControls = filterReadableControls(event.controls, controlLevel);
        if (filteredControls.length > 0) {
          next.controls = filteredControls;
        } else {
          delete next.controls;
          delete next.controlsDropped;
        }
      }

      if (includeRawData) {
        if (!Object.prototype.hasOwnProperty.call(next, 'rawData')) {
          next.rawData = '';
        }
      }

      return next;
    });

    const dropEmptyOutput = controlLevel === 'none' && !includeRawData;
    const nonEmptyEvents = dropEmptyOutput
      ? controlFilteredEvents.filter((event) => !isReadableEmptyOutputEvent(event))
      : controlFilteredEvents;
    const normalizedEvents = includeMetaEvents
      ? nonEmptyEvents
      : nonEmptyEvents.filter((event) => (
        event
        && typeof event === 'object'
        && (event.type === 'output' || event.type === 'snapshot')
      ));
    const compactedEvents = normalizedEvents;

    if (coalesceMs > 0) {
      return coalesceReadableOutputEvents(compactedEvents, { coalesceMs, coalesceMaxChars });
    }
    return compactedEvents;
  }
}

class HopMCPServer {
  constructor() {
    this.agentId = randomUUID();
    this.clientName = 'MCP Agent';
    this.clientVersion = SERVER_VERSION;
    this.startedAt = new Date().toISOString();
    this.baseUrl = null;
    this.token = null;
    this.actor = process.env.HOP_ACTOR || DEFAULT_ACTOR;
    this.streamManager = new TerminalStreamManager();
    this.waitJobs = new Map();
    this.terminalHandles = new Map(); // terminalId -> { internalName, sessionName, displayName, cols, rows }
    this.terminalAliases = new Map(); // staleTerminalId -> liveTerminalId
    this.managerWatch = null; // standing-manager wake registration (hopx_manager_register)

    const resolved = resolveDefaultConnection();
    if (resolved) {
      this.baseUrl = normalizeBaseUrl(resolved.baseUrl);
      this.token = resolved.token || process.env.HOP_TOKEN || null;
    }

    log(`[Hop MCP] Agent ID: ${this.agentId.slice(0, 8)}`);
    if (this.baseUrl) {
      log(`[Hop MCP] Default Hop API: ${this.baseUrl}`);
    } else {
      log(`[Hop MCP] No default Hop connection. Use connect_server(base_url=...) or set HOP_API_URL.`);
    }
  }

  getServerInfoPayload() {
    const headlessAvailable = !!this.streamManager.HeadlessTerminal;
    return {
      name: 'hop-mcp',
      version: SERVER_VERSION,
      pid: process.pid,
      startedAt: this.startedAt,
      scriptPath: __filename,
      cwd: process.cwd(),
      actor: this.actor,
      connection: {
        configured: !!this.baseUrl,
        baseUrl: this.baseUrl || null,
        hasToken: !!this.token
      },
      readTerminal: {
        modes: READ_TERMINAL_MODES,
        startFromModes: WAIT_START_MODES,
        defaultStartFrom: 'beginning',
        uiWindowing: 'cursor_centered_with_densest_nonempty_fallback',
        supportsRawTail: true,
        supportsReadableControls: true,
        readableControlLevels: READABLE_CONTROL_LEVELS,
        readableNoiseFilters: READABLE_NOISE_FILTERS,
        readableNoiseDefault: DEFAULT_READABLE_NOISE_FILTER,
        readableIncludeMetaEventsDefault: false,
        readableRawCoalesce: true,
        readableRawParser: 'stateful_incremental',
        createAttachWarmupMs: CREATE_TERMINAL_OUTPUT_WARMUP_MS,
        defaultTerminalSize: {
          cols: DEFAULT_TERMINAL_COLS,
          rows: DEFAULT_TERMINAL_ROWS
        }
      },
      hopx: {
        waitCaptureMaxEventsDefault: DEFAULT_HOPX_WAIT_CAPTURE_MAX_EVENTS,
        readableCoalesceMsDefault: DEFAULT_HOPX_READABLE_COALESCE_MS,
        uiIncludeRawTailDefault: DEFAULT_HOPX_UI_INCLUDE_RAW_TAIL,
        uiWaitCaptureMaxEventsDefault: DEFAULT_HOPX_UI_WAIT_CAPTURE_MAX_EVENTS,
        textOnlyReadableDefault: DEFAULT_HOPX_TEXT_ONLY_READABLE,
        uiBusyGuardMaxWaitMsDefault: DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS
      },
      waitTerminal: {
        startFromModes: WAIT_START_MODES,
        defaultStartFrom: 'latest',
        defaultCapture: 'readable_raw',
        defaultCondition: 'until_agent_done',
        defaultAgentDoneIdleMs: DEFAULT_WAIT_AGENT_DONE_IDLE_MS,
        supportsAsyncJobs: true,
        waitJobTtlMs: WAIT_JOB_TTL_MS
      },
      toolNamespaces: {
        corePrefix: 'hop_',
        helperPrefix: 'hopx_'
      },
      headless: {
        available: headlessAvailable,
        reason: headlessAvailable ? null : getHeadlessUnavailableReason()
      }
    };
  }

  async start() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', async (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch (err) {
        this.write({ jsonrpc: '2.0', id: 0, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      const response = await this.handleRequest(request);
      if (response) this.write(response);
    });

    rl.on('close', () => {
      log('[Hop MCP] Server stopped');
      process.exit(0);
    });

    log('='.repeat(60));
    log('Hop MCP Server Started');
    log(`Version: ${SERVER_VERSION}`);
    log(`Protocol: Model Context Protocol (MCP) ${DEFAULT_PROTOCOL} (supports ${SUPPORTED_PROTOCOLS.join(', ')})`);
    log('='.repeat(60));
  }

  write(payload) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  }

  ensureConnection() {
    if (!this.baseUrl) {
      const resolved = resolveDefaultConnection();
      if (resolved) {
        this.baseUrl = normalizeBaseUrl(resolved.baseUrl);
        this.token = resolved.token || process.env.HOP_TOKEN || null;
      }
    }
    if (!this.baseUrl) {
      throw new Error('Hop connection not configured. Use connect_server(base_url=...) or set HOP_API_URL.');
    }
  }

  async handleRequest(request) {
    const { id, method, params } = request;
    const responseId = id ?? 0;
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = this.handleInitialize(params || {});
          break;
        case 'resources/list':
          result = { resources: this.getResourceDefinitions() };
          break;
        case 'resources/read':
          result = await this.handleResourceRead(params || {});
          break;
        case 'tools/list':
          result = { tools: this.getToolDefinitions() };
          break;
        case 'tools/call':
          // Expected failures (daemon down, unconfigured connection) must come
          // back as isError tool results, not JSON-RPC protocol errors.
          try {
            result = await this.handleToolCall(params || {});
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const failure = { ok: false, status: null, endpoint: null, error: message };
            if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|socket hang up|timed out|not configured/i.test(message)) {
              failure.hint = this.buildDaemonUnreachableHint(this.baseUrl);
            }
            result = {
              content: [{ type: 'text', text: JSON.stringify(failure) }],
              isError: true
            };
          }
          break;
        case 'notifications/initialized':
          return null;
        default:
          return { jsonrpc: '2.0', id: responseId, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return { jsonrpc: '2.0', id: responseId, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { jsonrpc: '2.0', id: responseId, error: { code: -32603, message: `Internal error: ${message}` } };
    }
  }

  handleInitialize(params) {
    const requestedProtocol = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
    const protocolVersion = requestedProtocol && SUPPORTED_PROTOCOLS.includes(requestedProtocol)
      ? requestedProtocol
      : DEFAULT_PROTOCOL;

    if (requestedProtocol && requestedProtocol !== protocolVersion) {
      log(`[Hop MCP] Unsupported protocolVersion "${requestedProtocol}", falling back to ${protocolVersion}`);
    }

    const clientInfo = params.clientInfo || {};
    if (clientInfo.name) {
      this.clientName = clientInfo.name;
      this.clientVersion = clientInfo.version || '0.0.0';
      log(`[Hop MCP] Client identified: ${this.clientName} v${this.clientVersion}`);
    }

    return {
      protocolVersion,
      serverInfo: { name: 'hop-mcp', version: SERVER_VERSION },
      capabilities: { tools: {} }
    };
  }

  getToolDefinitions() {
    return [
      {
        name: 'connect_server',
        description: 'Connect to a Hop API base_url (http/https). Optional token overrides HOP_TOKEN. Use for remote hop instances.',
        inputSchema: {
          type: 'object',
          properties: {
            base_url: { type: 'string', description: 'Hop API base URL (e.g. http://127.0.0.1:39528 or https://hop2.example.com)' },
            token: { type: 'string', description: 'Bearer token for Hop API (optional)' },
            verify: { type: 'boolean', description: 'If true, probe the Hop API before saving connection settings.' },
            verify_endpoint: { type: 'string', description: 'API path to probe when verify=true (default: /api/sessions).' }
          }
        }
      },
      {
        name: 'hop_server_info',
        description: 'Return hop-mcp runtime diagnostics (version, script path, read-mode capabilities).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'hop_list_sessions',
        description: 'List Hop sessions and metadata.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'hop_list_terminals',
        description: 'List terminal API sessions (created via hop_create_terminal or hop_attach_terminal).',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'hop_create_terminal',
        description: 'Create a terminal session and optionally run a startup command. The returned `id` is the terminal_id used by every other terminal tool.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Display name for the session (default: "agent-<timestamp>"). Names must be unique: if the name is already in use the call fails with 409 "Session name already in use" (use hop_attach_terminal to reuse the existing session).' },
            cwd: { type: 'string', description: 'Working directory; must be an absolute path.' },
            cols: { type: 'number', description: `Terminal width in columns (default: ${DEFAULT_TERMINAL_COLS}).` },
            rows: { type: 'number', description: `Terminal height in rows (default: ${DEFAULT_TERMINAL_ROWS}).` },
            shell: { type: 'string', description: 'Shell binary to launch (default: the daemon user\'s login shell from $SHELL).' },
            env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables for the shell process.' },
            startup: { type: 'string', description: 'Command typed into the shell right after it starts (skipped when autoStart=false).' },
            autoStart: { type: 'boolean', description: 'If false, the startup command is saved but not run on create (default: true).' },
            folderId: { type: 'string', description: 'Optional UI folder to place the session in; ignored if the folder does not exist.' }
          }
        }
      },
      {
        name: 'hop_attach_terminal',
        description: 'Attach to an existing terminal session by name or internalName.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            internalName: { type: 'string' },
            cols: { type: 'number' },
            rows: { type: 'number' }
          }
        }
      },
      {
        name: 'hop_write_terminal',
        description: 'Write raw input to a terminal session.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            data: { type: 'string' }
          },
          required: ['terminal_id', 'data']
        }
      },
      {
        name: 'hop_send_key',
        description: 'Send a named keypress to a terminal session. Supported: enter, esc, tab, shift_tab, backspace, delete, insert, arrows (up/down/left/right), home, end, page_up, page_down, space, f1-f12, and ctrl+[a-z] combos (e.g. ctrl_c). For anything else, send the raw escape sequence with hop_write_terminal.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            key: { type: 'string' },
            repeat: { type: 'number', description: 'Repeat keypress count (default: 1).' }
          },
          required: ['terminal_id', 'key']
        }
      },
      {
        name: 'hopx_send_and_wait',
        description: 'Convenience helper: write input (and optional keypress), then wait for completion/output in one call. Defaults to agent-friendly completion when no explicit wait condition is provided.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            data: { type: 'string', description: 'Raw text to write before waiting.' },
            press_enter: { type: 'boolean', description: 'If true, send an Enter key after data (default: false). Note: unlike hopx_agent_turn, press_enter defaults to false here.' },
            key: { type: 'string', description: 'Optional named key to send after data (for example enter, esc, ctrl_c).' },
            repeat: { type: 'number', description: 'Repeat keypress count when key is provided (default: 1).' },
            wait: { type: 'boolean', description: 'If false, only sends input and skips wait logic (default: true).' },
            cursor: { type: 'number' },
            start_from: {
              type: 'string',
              enum: WAIT_START_MODES,
              description: 'Where to start scanning output: latest (tail), cursor (requires cursor), or beginning (oldest buffered event).'
            },
            until_regex: { type: 'string' },
            regex_flags: { type: 'string', description: 'Regex flags for until_regex (default: m).' },
            match_target: { type: 'string', enum: WAIT_MATCH_TARGETS, description: 'Where until_regex/until_prompt look: stream (output byte stream, good for shells), screen (rendered virtual screen, needed for redraw-heavy TUIs but also sees echoed input), or auto (default: stream, plus screen in alternate-screen mode).' },
            until_prompt: { type: 'boolean', description: 'Wait for prompt regex match.' },
            until_agent_done: { type: 'boolean', description: 'Wait for agent-style completion: output has started, the terminal is quiet, the interactive cursor is visible, and no busy indicator (e.g. "esc to interrupt") is showing.' },
            prompt_regex: { type: 'string', description: 'Prompt matcher regex (default: conservative shell-like prompt).' },
            idle_ms: { type: 'number', description: 'Match when no output-like events arrive for this duration.' },
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000 synchronous; 15 minutes when async=true — the job is a background watch nobody blocks on).' },
            capture: { type: 'string', enum: ['raw', 'readable_raw'], description: 'Capture format for returned events (default: readable_raw).' },
            capture_max_events: { type: 'number', description: 'Max captured tail events to return (default: 60 for hopx helper).' },
            text_only: { type: 'boolean', description: 'If true and capture="readable_raw", return concatenated wait.text and omit wait.events for smaller payloads. Default is true for readable_raw capture.' },
            clean_text: { type: 'boolean', description: 'If true, strip ANSI escape codes from wait.text for plain text output (default: false).' }
            // Advanced readable_raw tuning (maxControlOps, includeRawData,
            // includeMetaEvents, control_level, noise_filter, coalesce_ms,
            // coalesce_max_chars) is still accepted as pass-through but omitted
            // here to keep the helper schema lean; use hop_wait_terminal for full
            // control.
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hopx_exec',
        description: 'Run a shell command on a persistent terminal and return clean stdout — like a Bash tool. Sends the command, waits for the next shell prompt, and strips the echoed input and ANSI codes. ok = the prompt returned before timeout_ms; it does NOT mean the command succeeded. exit_code = the command\'s real exit status, or null if it could not be captured (timeout, or a non-POSIX shell). Use for command-then-read work that does not need raw terminal events.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string', description: 'Terminal to run the command in.' },
            command: { type: 'string', description: 'Shell command to execute (Enter is sent automatically).' },
            timeout_ms: { type: 'number', description: 'Max time to wait for prompt return (default: 30000).' },
            prompt_regex: { type: 'string', description: 'Custom prompt regex for this command (default: conservative shell prompt matcher). Useful for SSH sessions with non-standard prompts.' },
            idle_ms: { type: 'number', description: 'Fallback: match after this many ms of silence if prompt regex doesn\'t match (useful for commands with non-standard output endings).' }
          },
          required: ['terminal_id', 'command']
        }
      },
      {
        name: 'hop_wait_terminal',
        description: 'Wait for terminal output conditions (regex, prompt, idle, agent_done) without client polling loops. Defaults to agent_done when no explicit wait condition is provided.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            async: { type: 'boolean', description: 'If true, start the wait as a background job and return wait_id immediately.' },
            cursor: { type: 'number' },
            start_from: {
              type: 'string',
              enum: WAIT_START_MODES,
              description: 'Where to start scanning output: latest (tail), cursor (requires cursor), or beginning (oldest buffered event).'
            },
            until_regex: { type: 'string' },
            regex_flags: { type: 'string', description: 'Regex flags for until_regex (default: m).' },
            match_target: { type: 'string', enum: WAIT_MATCH_TARGETS, description: 'Where until_regex/until_prompt look: stream (output byte stream, good for shells), screen (rendered virtual screen, needed for redraw-heavy TUIs but also sees echoed input), or auto (default: stream, plus screen in alternate-screen mode).' },
            until_prompt: { type: 'boolean', description: 'Wait for prompt regex match.' },
            until_agent_done: { type: 'boolean', description: 'Wait for agent-style completion: output has started, the terminal is quiet, the interactive cursor is visible, and no busy indicator (e.g. "esc to interrupt") is showing.' },
            prompt_regex: { type: 'string', description: 'Prompt matcher regex (default: conservative shell-like prompt).' },
            idle_ms: { type: 'number', description: 'Match when no output-like events arrive for this duration.' },
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000 synchronous; 15 minutes when async=true — the job is a background watch nobody blocks on).' },
            capture: { type: 'string', enum: ['raw', 'readable_raw'], description: 'Capture format for returned events (default: readable_raw).' },
            capture_max_events: { type: 'number', description: 'Max captured tail events to return (default: 120).' },
            maxControlOps: { type: 'number', description: 'In readable_raw capture, max parsed control ops per event (default: 200).' },
            includeRawData: { type: 'boolean', description: 'In readable_raw capture, include original event data.' },
            includeMetaEvents: { type: 'boolean', description: 'In readable_raw capture, include non-output meta events (default: false).' },
            control_level: {
              type: 'string',
              enum: READABLE_CONTROL_LEVELS,
              description: 'In readable_raw capture, control detail level: full, structural, or none.'
            },
            noise_filter: {
              type: 'string',
              enum: READABLE_NOISE_FILTERS,
              description: 'In readable_raw capture, text noise filter mode: balanced (default) or off.'
            },
            coalesce_ms: { type: 'number', description: 'In readable_raw capture, merge adjacent text frames within this time window (ms).' },
            coalesce_max_chars: { type: 'number', description: `In readable_raw capture, max chars per merged frame (default: ${DEFAULT_READABLE_COALESCE_MAX_CHARS}).` }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hop_wait_poll',
        description: 'Poll or await completion of a background wait job created by hop_wait_terminal with async=true.',
        inputSchema: {
          type: 'object',
          properties: {
            wait_id: { type: 'string' },
            wait: { type: 'boolean', description: 'If true, block until job finishes or max_wait_ms elapses.' },
            max_wait_ms: { type: 'number', description: 'Max time to block when wait=true (default: 30000).' },
            cancel: { type: 'boolean', description: 'If true, abort the still-running wait (status becomes "aborted") and return its final state. Does not touch the terminal.' },
            consume: { type: 'boolean', description: 'If true, remove completed job after returning payload.' }
          },
          required: ['wait_id']
        }
      },
      {
        name: 'hop_resize_terminal',
        description: 'Resize terminal PTY.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            cols: { type: 'number' },
            rows: { type: 'number' }
          },
          required: ['terminal_id', 'cols', 'rows']
        }
      },
      {
        name: 'hop_read_terminal',
        description: 'Read terminal output events. Defaults to mode="readable_raw" (parsed text); raw ANSI events and UI snapshot modes are also available.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            cursor: { type: 'number' },
            start_from: {
              type: 'string',
              enum: WAIT_START_MODES,
              description: 'Where to start reading: latest (tail), cursor (requires cursor), or beginning (oldest buffered event). Default: cursor when cursor is provided, otherwise beginning.'
            },
            maxBytes: { type: 'number', description: `Max serialized bytes of events to return (default: ${DEFAULT_READ_MAX_BYTES}). Pass 0 for unlimited.` },
            maxEvents: { type: 'number', description: `Max events to return (default: ${DEFAULT_READ_MAX_EVENTS}). Pass 0 for unlimited. When either cap truncates output, the payload includes truncated:true and a hint; continue with start_from="cursor", cursor=next_cursor.` },
            mode: { type: 'string', enum: READ_TERMINAL_MODES, description: 'Output format: readable_raw (default; parsed text with compact control hints), raw (raw ANSI events), or ui (rendered screen snapshot).' },
            uiMaxLines: { type: 'number', description: 'In UI mode, number of visible lines to include (default: terminal rows).' },
            includeRawTail: { type: 'boolean', description: 'In UI mode, include raw output tail for lossless event inspection (default: false, opt-in).' },
            rawTailMaxEvents: { type: 'number', description: 'In UI mode, max raw tail events to include (default: 40).' },
            maxControlOps: { type: 'number', description: 'In readable_raw mode, max parsed control ops per event (default: 200).' },
            includeRawData: { type: 'boolean', description: 'In readable_raw mode, include original data string per event.' },
            includeMetaEvents: { type: 'boolean', description: 'In readable_raw mode, include non-output meta events (default: false).' },
            control_level: {
              type: 'string',
              enum: READABLE_CONTROL_LEVELS,
              description: 'In readable_raw mode, control detail level: full, structural, or none.'
            },
            noise_filter: {
              type: 'string',
              enum: READABLE_NOISE_FILTERS,
              description: 'In readable_raw mode, text noise filter mode: balanced (default) or off.'
            },
            coalesce_ms: { type: 'number', description: 'In readable_raw mode, merge adjacent text frames within this time window (ms).' },
            coalesce_max_chars: { type: 'number', description: `In readable_raw mode, max chars per merged frame (default: ${DEFAULT_READABLE_COALESCE_MAX_CHARS}).` }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hop_close_terminal',
        description: 'Detach terminal API session; optionally kill the underlying hop session.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            killSession: { type: 'boolean' }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hop_set_agent_permission',
        description: 'Allow or block agent access for a session.',
        inputSchema: {
          type: 'object',
          properties: {
            internalName: { type: 'string' },
            name: { type: 'string' },
            allowed: { type: 'boolean' }
          },
          required: ['allowed']
        }
      },
      {
        name: 'hop_list_workspaces',
        description: 'List available workspaces.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'hop_create_workspace',
        description: 'Create an empty workspace by name.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'hop_show_workspace',
        description: 'Show saved definitions in a workspace.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'hop_save_workspace',
        description: 'Save a workspace snapshot from live sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            sessionNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of live session internal names to save. Defaults to all live terminal sessions.'
            }
          },
          required: ['name']
        }
      },
      {
        name: 'hop_delete_workspace',
        description: 'Delete a workspace by name.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
        }
      },
      {
        name: 'hop_load_workspace',
        description: 'Load a workspace and optionally start sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            start: { type: 'boolean' }
          },
          required: ['name']
        }
      },
      {
        name: 'hopx_agent_turn',
        description: 'Convenience helper: send one turn to a terminal agent, wait, and return mode-appropriate output. Built on top of core hop_* tools. Provide terminal_id to start a turn, or wait_id to continue/poll/control an async turn. Optional until_reply_regex is evaluated (case-insensitive) against the captured reply text after the turn completes and reported as reply_matched/reply_match — "task finished", not just "turn finished".',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            wait_id: { type: 'string', description: 'Existing async hopx turn wait_id to poll or control.' },
            data: { type: 'string', description: 'Text to send to the terminal.' },
            message: { type: 'string', description: 'Alias for data.' },
            press_enter: { type: 'boolean', description: 'Send Enter after data. Defaults to true when data/message is provided. Note: unlike hopx_send_and_wait, press_enter defaults to true here.' },
            key: { type: 'string', description: 'Optional named key to send after data (for example enter, esc, ctrl_c).' },
            repeat: { type: 'number', description: 'Repeat keypress count when key is provided (default: 1).' },
            wait: { type: 'boolean', description: 'If false, send only and skip waiting.' },
            async: { type: 'boolean', description: 'If true, start the wait as a background job and return wait_id immediately.' },
            control: {
              type: 'string',
              enum: ['send', 'wait', 'interrupt', 'terminate'],
              description: 'send (default), wait-only continuation, or explicit interrupt/terminate control.'
            },
            interrupt_key: { type: 'string', description: 'Named key used for interrupt/terminate control (default: esc).' },
            terminate_message: { type: 'string', description: 'Optional follow-up instruction to send after terminate interrupt.' },
            mode: {
              type: 'string',
              enum: HOPX_TURN_MODES,
              description: 'auto (default), readable_raw/raw capture, or ui snapshot output.'
            },
            cursor: { type: 'number' },
            start_from: {
              type: 'string',
              enum: WAIT_START_MODES,
              description: 'Where waiting begins: latest, cursor, or beginning.'
            },
            until_regex: { type: 'string' },
            regex_flags: { type: 'string', description: 'Regex flags for until_regex (default: m).' },
            match_target: { type: 'string', enum: WAIT_MATCH_TARGETS, description: 'Where until_regex/until_prompt look: stream (output byte stream, good for shells), screen (rendered virtual screen, needed for redraw-heavy TUIs but also sees echoed input), or auto (default: stream, plus screen in alternate-screen mode).' },
            until_prompt: { type: 'boolean', description: 'Wait for prompt regex match.' },
            until_agent_done: { type: 'boolean', description: 'Wait for agent-style completion.' },
            until_reply_regex: { type: 'string', description: 'Optional case-insensitive regex evaluated against the captured reply text AFTER the turn completes (it does not change when the wait ends); adds reply_matched: true|false and reply_match (first match or null) to the result. For async turns it is evaluated when the background job completes, so hopx_wait_any completed[] summaries carry it too.' },
            prompt_regex: { type: 'string', description: 'Prompt matcher regex.' },
            idle_ms: { type: 'number', description: 'Match when output-like events are quiet for this duration.' },
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000 synchronous; 15 minutes when async=true — the job is a background watch nobody blocks on).' },
            capture_max_events: { type: 'number', description: 'Max captured wait events (default: 60 for hopx helper; 0 when selected mode is ui unless overridden).' },
            text_only: { type: 'boolean', description: 'If true, condense readable waits to wait.text + metadata. Ignored for mode="ui" output snapshots. Default is true for readable modes.' },
            clean_text: { type: 'boolean', description: 'If true, strip ANSI escape codes from text output (default: false).' },
            // Advanced readable_raw tuning (maxControlOps, includeRawData,
            // includeMetaEvents, control_level, noise_filter, coalesce_ms,
            // coalesce_max_chars) still works as pass-through; omitted from the
            // helper schema for clarity. Use hop_wait_terminal for full control.
            uiMaxLines: { type: 'number', description: 'For mode=ui, max visible lines to include.' },
            includeRawTail: { type: 'boolean', description: 'For mode=ui, include raw output tail (default: false in hopx helper).' },
            rawTailMaxEvents: { type: 'number', description: 'For mode=ui, max raw tail events.' },
            verify_submit: { type: 'boolean', description: 'For mode=ui: after data+Enter, confirm the composer cleared and re-send Enter if it was swallowed (default: true). Set false to disable.' },
            verify_submit_retries: { type: 'number', description: 'Max Enter re-sends when verified submit detects a swallowed Enter (default: 2).' },
            verify_submit_delay_ms: { type: 'number', description: 'Delay before each verified-submit composer re-check (default: 250).' },
            settle_checks: { type: 'number', description: 'For the busy-line completion heuristic (no Stop-hook marker): consecutive idle reads required before declaring the turn done (default: 2). Ignored when the turn counter marker is authoritative.' }
          }
        }
      },
      {
        name: 'hop_read_trajectory',
        description: 'Read a Claude Code session\'s real conversation history — far more than the terminal frame shows for a full-screen TUI. Returns a context-safe reduced digest by default (never the raw transcript). Identify the session by its hop name. Requires the same per-session agent permission as attaching (enable with hop_set_agent_permission), and the transcript file must live on the same host as the MCP (path resolved from the SessionStart hook record).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Hop session name (display name or internalName), e.g. "Lyra".' },
            mode: {
              type: 'string',
              enum: ['digest', 'summary', 'list', 'get', 'tail'],
              description: 'digest (default): reduced conversation view — per-turn User text + Assistant text + one-line tool-call summaries, transcript noise dropped, most-recent turns within max_chars. summary: metadata + per-type counts + last few turns. list: paginated compact turn records (offset/limit). get: full content of one turn (index or uuid). tail: last N turns\' full text.'
            },
            offset: { type: 'number', description: 'For mode=list: turn offset (negative counts from the end; default: last `limit` turns).' },
            limit: { type: 'number', description: 'For mode=list (default 20) / tail (default 6): number of turns.' },
            index: { type: 'number', description: 'For mode=get: 0-based turn index (as reported by list/summary).' },
            uuid: { type: 'string', description: 'For mode=get: the turn uuid (alternative to index).' },
            include_thinking: { type: 'boolean', description: 'Include assistant "thinking" blocks in previews/text (default: false).' },
            text_only: { type: 'boolean', description: 'For get/tail: return only joined message text, omitting tool input/result blocks (default: false).' },
            max_chars: { type: 'number', description: 'Output cap in characters (default: 8000). On overflow the result is trimmed and marked truncated with a hint to narrow the query.' }
          },
          required: ['name']
        }
      },
      {
        name: 'hopx_capture_scrollback',
        description: 'Capture an alternate-screen TUI\'s scrollback history the way a user would: drive the app to scroll up page-by-page, snapshot each rendered frame, and stitch the newly-revealed rows together. Works for any scrollable TUI (Claude fullscreen verified: PageUp scrolls, PageDown restores) and when no transcript file is reachable. The user\'s live view is restored afterward by default. Best-effort and lossy for wrapped/redrawn content — prefer hop_read_trajectory when a Claude transcript is available. Requires agent permission on the session.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string', description: 'Terminal id (from hop_attach_terminal / hop_create_terminal).' },
            scroll_key: { type: 'string', description: 'Key that scrolls up one page (default: page_up).' },
            restore_key: { type: 'string', description: 'Key that scrolls back down to restore the view (default: page_down). Applied once per captured page.' },
            max_pages: { type: 'number', description: 'Max scroll-up steps (default: 40). Capture stops earlier when the top is reached.' },
            settle_ms: { type: 'number', description: 'Max ms to wait for a redraw after each scroll before concluding the top is reached (default: 1200).' },
            max_chars: { type: 'number', description: 'Output cap for the stitched text (default: 8000). Earliest content is kept on overflow.' },
            restore: { type: 'boolean', description: 'Scroll back down to the live bottom when done (default: true).' }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hopx_agents_overview',
        description: 'Fleet status in one call, for a manager agent orchestrating subagents: every agent-created or agent-permitted session with its state (running/busy/needs_input/idle — needs_input = waiting for a human, via a parked composer prompt or a recent unanswered bell), working directory, foreground program, Claude turn count (Stop-hook counter when available), bell counters (a subagent asking for attention), last activity, and any pending wait jobs this MCP holds for it. Diff bellSeq/turnCount across calls to detect progress. Composes hop_list_sessions + local turn counters + the wait-job registry.',
        inputSchema: {
          type: 'object',
          properties: {
            include_user_sessions: { type: 'boolean', description: 'Also include user-created sessions that have agent access enabled (default: true). false = only agent-created sessions.' },
            include_ports: { type: 'boolean', description: 'Include port (proxy) sessions (default: false).' }
          }
        }
      },
      {
        name: 'hopx_wait_any',
        description: 'Block until ANY of several background waits completes — the manager-loop primitive. Pass wait_ids and/or terminal_ids (a terminal with no live wait gets an until_agent_done wait auto-started). Returns completed jobs (with slimmed results) plus the still-pending set. Re-arm rule: a watch that only timed out is re-armed automatically and reappears in pending under a NEW wait_id — carry pending[].wait_id into the next call; only a real condition match counts as completed. Replaces round-robin hop_wait_poll across a fleet.',
        inputSchema: {
          type: 'object',
          properties: {
            wait_ids: { type: 'array', items: { type: 'string' }, description: 'Wait job ids to race.' },
            terminal_ids: { type: 'array', items: { type: 'string' }, description: 'Terminals to watch; reuses each terminal\'s live wait job or starts an until_agent_done wait.' },
            max_wait_ms: { type: 'number', description: 'Max ms THIS CALL blocks for the first completion (default: 30000). Distinct from each background job\'s own 15-minute wait window.' },
            consume: { type: 'boolean', description: 'Remove returned completed jobs from the registry (default: false).' },
            include_results: { type: 'boolean', description: 'Include each completed job\'s (slimmed) wait payload (default: true).' },
            rearm_timed_out: { type: 'boolean', description: 'Re-arm watches whose wait window expired instead of reporting them as completions (default: true).' }
          }
        }
      },
      {
        name: 'hopx_spawn_agent',
        description: 'One-call subagent bring-up: create a terminal, launch an agent CLI (claude/codex/gemini or a custom command), wait until it is ready for input, and optionally dispatch a first task as an async turn. Returns { terminal_id, sessionName, wait_id? } — collect results with hopx_wait_any / hopx_agent_turn(wait_id=...). Composes hop_create_terminal + hop_write_terminal + hop_wait_terminal + hopx_agent_turn.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Session name for the subagent terminal (default: auto-named).' },
            cwd: { type: 'string', description: 'Working directory for the terminal.' },
            agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'custom'], description: 'Agent CLI preset (default: claude). Use custom with command=... for anything else.' },
            command: { type: 'string', description: 'Override the launch command (required when agent=custom).' },
            args: { type: 'string', description: 'Extra CLI arguments appended to the launch command (e.g. "--model opus").' },
            initial_task: { type: 'string', description: 'First task to dispatch once ready, as an async agent turn (returns its wait_id).' },
            ready_timeout_ms: { type: 'number', description: 'Max ms to wait for the agent CLI to become ready (default: 60000).' },
            cols: { type: 'number', description: 'Terminal columns.' },
            rows: { type: 'number', description: 'Terminal rows.' },
            isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree: give the worker its own git worktree + fleet/<name> branch under <repo>/.hop-worktrees so parallel workers can edit overlapping files; result carries { worktree: { path, branch, repoRoot } }. Manager merges the branch and runs `git worktree remove` when done.' }
          }
        }
      },
      {
        name: 'hopx_manager_register',
        description: 'Register THIS session as a standing manager so hop wakes it when its dispatched workers finish — instead of the manager holding a turn open polling hopx_wait_any. Pass your own terminal_id. While registered, a background watcher reconciles the task ledger and, when a task you dispatched completes AND your terminal is idle at an empty composer, injects a short "N task(s) completed — review the ledger" prompt to start your next turn. Tasks dispatched after registering are tagged with your terminal so only your fleet wakes you. Call with enabled=false to stop. Event-driven managers can dispatch async, end their turn, and be woken cheaply.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string', description: "This manager session's own terminal_id (from hop_list_terminals / the session you are running in)." },
            enabled: { type: 'boolean', description: 'true (default) to start watching; false to stop and clear the registration.' }
          }
        }
      },
      {
        name: 'hopx_task_ledger',
        description: 'The durable orchestration ledger: every async agent turn dispatched with hopx_agent_turn is recorded on disk (~/.hop2/orchestration) and survives manager/MCP restarts. Lists tasks with status pending/completed/failed, contract verdicts (replyMatched), and per-session grouping; pending entries are lazily reconciled from turn counters + transcripts on every call, so a freshly restarted manager sees which turns finished while nobody was watching. Use acknowledge to delete consumed entries.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'completed', 'failed', 'all'], description: 'Filter (default: all).' },
            session: { type: 'string', description: 'Filter to one session (name or internalName).' },
            acknowledge: { type: 'array', items: { type: 'string' }, description: 'Task ids to delete from the ledger (consume after reading results).' },
            limit: { type: 'number', description: 'Max entries returned (default 50, newest first).' }
          }
        }
      }
    ];
  }

  getResourceDefinitions() {
    return [
      {
        uri: 'hop://sessions',
        name: 'Hop Sessions',
        mimeType: 'application/json',
        description: 'List of Hop sessions and metadata.'
      },
      {
        uri: 'hop://terminals',
        name: 'Hop Terminals',
        mimeType: 'application/json',
        description: 'Active terminal API sessions.'
      },
      {
        uri: 'hop://workspaces',
        name: 'Hop Workspaces',
        mimeType: 'application/json',
        description: 'Available workspaces.'
      }
    ];
  }

  async handleToolCall(params) {
    const name = params.name;
    const args = params.arguments || {};

    if (name === 'connect_server') {
      const baseUrl = normalizeBaseUrl(args.base_url);
      if (!baseUrl) {
        return { content: [{ type: 'text', text: 'Error: connect_server requires a valid http(s) base_url.' }], isError: true };
      }
      const token = args.token || process.env.HOP_TOKEN || null;
      const shouldVerify = args.verify === true;
      const verifyEndpoint = normalizeEndpointPath(args.verify_endpoint || '/api/sessions');
      if (!verifyEndpoint) {
        return { content: [{ type: 'text', text: 'Error: verify_endpoint must be a non-empty API path.' }], isError: true };
      }
      if (shouldVerify) {
        const probe = await this.callApiWithConnection('GET', baseUrl, token, verifyEndpoint);
        const wrappedProbe = this.wrapApiResult(probe, { endpoint: verifyEndpoint });
        if (wrappedProbe.isError) {
          return wrappedProbe;
        }
      }
      this.baseUrl = baseUrl;
      this.token = token;
      this.clearTransientTerminalState();
      return { content: [{ type: 'text', text: `Connected to ${this.baseUrl}` }] };
    }

    if (name === 'hop_server_info') {
      return this.wrapJson(this.getServerInfoPayload());
    }

    this.ensureConnection();

    switch (name) {
      case 'hop_list_sessions':
        return this.wrapApiResult(await this.callApi('GET', '/api/sessions'), { endpoint: '/api/sessions' });
      case 'hop_list_terminals': {
        const listed = await this.callApi('GET', '/api/terminals');
        if (!this.isApiFailurePayload(listed) && Array.isArray(listed.terminals)) {
          for (const terminal of listed.terminals) {
            if (!terminal || typeof terminal.id !== 'string') continue;
            this.rememberTerminalHandle(terminal.id, {
              internalName: terminal.sessionName || null,
              sessionName: terminal.sessionName || null,
              displayName: terminal.displayName || null
            });
          }
        }
        return this.wrapApiResult(listed, { endpoint: '/api/terminals' });
      }
      case 'hop_create_terminal': {
        const created = await this.callApi('POST', '/api/terminals', {
          name: args.name,
          cwd: args.cwd,
          cols: args.cols,
          rows: args.rows,
          shell: args.shell,
          env: args.env,
          startup: args.startup,
          autoStart: args.autoStart,
          folderId: args.folderId
        });
        if (created && created.ok && created.id) {
          await this.prewarmTerminalStream(created.id, {
            cols: args.cols,
            rows: args.rows,
            waitForOutputMs: CREATE_TERMINAL_OUTPUT_WARMUP_MS
          });
          this.rememberTerminalHandleFromPayload(created, {
            displayName: args.name,
            cols: args.cols,
            rows: args.rows
          });
        }
        return this.wrapApiResult(created, { endpoint: '/api/terminals' });
      }
      case 'hop_attach_terminal': {
        const attached = await this.callApi('POST', '/api/terminals/attach', {
          name: args.name,
          internalName: args.internalName,
          cols: args.cols,
          rows: args.rows
        });
        if (attached && attached.ok && attached.id) {
          await this.prewarmTerminalStream(attached.id, {
            cols: args.cols,
            rows: args.rows,
            waitForOutputMs: CREATE_TERMINAL_OUTPUT_WARMUP_MS
          });
          this.rememberTerminalHandleFromPayload(attached, {
            internalName: args.internalName,
            displayName: args.name,
            cols: args.cols,
            rows: args.rows
          });
        }
        return this.wrapApiResult(attached, { endpoint: '/api/terminals/attach' });
      }
      case 'hop_write_terminal':
        {
          const resolvedId = await this.ensureTerminalReadyWithRecovery(args.terminal_id);
          if (typeof args.data === 'string' && args.data.length > 0) {
            this.streamManager.noteTerminalInput(resolvedId, args.data);
          }
          const call = await this.callTerminalEndpointWithRecovery(
            args.terminal_id,
            'POST',
            (terminalId) => `/api/terminals/${encodeURIComponent(terminalId)}/write`,
            { data: args.data }
          );
          if (call.terminalId && call.terminalId !== resolvedId && typeof args.data === 'string' && args.data.length > 0) {
            this.streamManager.noteTerminalInput(call.terminalId, args.data);
          }
          return this.wrapApiResult(call.payload, { endpoint: call.endpoint });
        }
      case 'hop_send_key': {
        const mapped = resolveSendKeyInput(args.key, args.repeat);
        if (!mapped.ok) {
          return { content: [{ type: 'text', text: `Error: ${mapped.error}` }], isError: true };
        }
        {
          const resolvedId = await this.ensureTerminalReadyWithRecovery(args.terminal_id);
          this.streamManager.noteTerminalInput(resolvedId, mapped.data);
          const call = await this.callTerminalEndpointWithRecovery(
            args.terminal_id,
            'POST',
            (terminalId) => `/api/terminals/${encodeURIComponent(terminalId)}/write`,
            { data: mapped.data }
          );
          if (call.terminalId && call.terminalId !== resolvedId) {
            this.streamManager.noteTerminalInput(call.terminalId, mapped.data);
          }
          return this.wrapApiResult(call.payload, { endpoint: call.endpoint });
        }
      }
      case 'hopx_send_and_wait':
        return await this.handleSendAndWait(args);
      case 'hopx_exec':
        return await this.handleExec(args);
      case 'hop_wait_terminal':
        if (args.async === true) {
          return await this.handleWaitStart(args);
        }
        return await this.handleWaitTerminal(args);
      case 'hop_wait_poll':
        return await this.handleWaitPoll(args);
      case 'hop_resize_terminal': {
        const resolvedId = await this.ensureTerminalReadyWithRecovery(args.terminal_id, { cols: args.cols, rows: args.rows });
        this.streamManager.ensure(this.baseUrl, this.token, this.actor, resolvedId, { cols: args.cols, rows: args.rows });
        const call = await this.callTerminalEndpointWithRecovery(
          args.terminal_id,
          'POST',
          (terminalId) => `/api/terminals/${encodeURIComponent(terminalId)}/resize`,
          {
            cols: args.cols,
            rows: args.rows
          },
          { cols: args.cols, rows: args.rows }
        );
        if (call.payload && call.payload.ok !== false) {
          this.streamManager.setTerminalSize(call.terminalId, args.cols, args.rows);
          this.rememberTerminalHandle(call.terminalId, {
            cols: Number.isFinite(args.cols) ? Math.floor(args.cols) : undefined,
            rows: Number.isFinite(args.rows) ? Math.floor(args.rows) : undefined
          });
        }
        return this.wrapApiResult(call.payload, { endpoint: call.endpoint });
      }
      case 'hop_read_terminal':
        return await this.handleReadTerminal(args);
      case 'hop_close_terminal': {
        const call = await this.callTerminalEndpointWithRecovery(
          args.terminal_id,
          'DELETE',
          (terminalId) => `/api/terminals/${encodeURIComponent(terminalId)}${args.killSession ? '?killSession=true' : ''}`,
          undefined
        );
        if (!this.isApiFailurePayload(call.payload)) {
          this.forgetTerminalHandle(args.terminal_id);
          this.forgetTerminalHandle(call.terminalId);
        }
        return this.wrapApiResult(call.payload, { endpoint: call.endpoint });
      }
      case 'hop_set_agent_permission':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/sessions/agent-permission', {
            name: args.name,
            internalName: args.internalName,
            allowed: args.allowed
          }),
          { endpoint: '/api/sessions/agent-permission' }
        );
      case 'hop_list_workspaces':
        return this.wrapApiResult(await this.callApi('GET', '/api/workspaces'), { endpoint: '/api/workspaces' });
      case 'hop_create_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/create', { name: args.name }),
          { endpoint: '/api/workspaces/create' }
        );
      case 'hop_show_workspace':
        return this.wrapApiResult(
          await this.callApi('GET', `/api/workspaces/show?name=${encodeURIComponent(args.name)}`),
          { endpoint: '/api/workspaces/show' }
        );
      case 'hop_save_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/save', { name: args.name, sessionNames: args.sessionNames }),
          { endpoint: '/api/workspaces/save' }
        );
      case 'hop_delete_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/delete', { name: args.name }),
          { endpoint: '/api/workspaces/delete' }
        );
      case 'hop_load_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/load', { name: args.name, start: args.start }),
          { endpoint: '/api/workspaces/load' }
        );
      case 'hopx_agent_turn':
        return await this.handleHopxAgentTurn(args);
      case 'hop_read_trajectory':
        return await this.handleReadTrajectory(args);
      case 'hopx_capture_scrollback':
        return await this.handleCaptureScrollback(args);
      case 'hopx_agents_overview':
        return await this.handleAgentsOverview(args);
      case 'hopx_wait_any':
        return await this.handleWaitAny(args);
      case 'hopx_spawn_agent':
        return await this.handleSpawnAgent(args);
      case 'hopx_task_ledger':
        return await this.handleTaskLedger(args);
      case 'hopx_manager_register':
        return await this.handleManagerRegister(args);
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  }

  async handleResourceRead(params) {
    const uri = params.uri;
    if (!uri || typeof uri !== 'string') {
      return { contents: [{ uri: uri || 'hop://unknown', mimeType: 'text/plain', text: 'Error: uri is required.' }] };
    }

    this.ensureConnection();

    if (uri === 'hop://sessions') {
      const data = await this.callApi('GET', '/api/sessions');
      return this.wrapResource(uri, data);
    }
    if (uri === 'hop://terminals') {
      const data = await this.callApi('GET', '/api/terminals');
      return this.wrapResource(uri, data);
    }
    if (uri === 'hop://workspaces') {
      const data = await this.callApi('GET', '/api/workspaces');
      return this.wrapResource(uri, data);
    }

    return { contents: [{ uri, mimeType: 'text/plain', text: `Error: resource not found (${uri})` }] };
  }

  clearTransientTerminalState() {
    for (const terminalId of Array.from(this.streamManager.streams.keys())) {
      this.streamManager.remove(terminalId);
    }
    this.waitJobs.clear();
    this.terminalHandles.clear();
    this.terminalAliases.clear();
  }

  resolveTerminalAlias(terminalId) {
    if (typeof terminalId !== 'string' || terminalId.length === 0) return terminalId;
    let current = terminalId;
    const seen = new Set();
    while (this.terminalAliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.terminalAliases.get(current);
    }
    return current;
  }

  getTerminalHandle(terminalId) {
    if (typeof terminalId !== 'string' || terminalId.length === 0) return null;
    const resolved = this.resolveTerminalAlias(terminalId);
    return this.terminalHandles.get(terminalId) || this.terminalHandles.get(resolved) || null;
  }

  rememberTerminalHandle(terminalId, details = {}) {
    if (typeof terminalId !== 'string' || terminalId.length === 0) return;
    const existing = this.getTerminalHandle(terminalId) || {};
    const merged = {
      ...existing,
      ...details
    };
    this.terminalHandles.set(terminalId, merged);
    const resolved = this.resolveTerminalAlias(terminalId);
    if (resolved && resolved !== terminalId) {
      this.terminalHandles.set(resolved, merged);
    }
  }

  rememberTerminalHandleFromPayload(payload, fallback = {}) {
    if (!payload || typeof payload !== 'object' || !payload.id) return;
    const terminalId = String(payload.id);
    const sessionName = typeof payload.sessionName === 'string'
      ? payload.sessionName
      : (typeof fallback.sessionName === 'string' ? fallback.sessionName : null);
    const internalName = typeof payload.internalName === 'string'
      ? payload.internalName
      : (typeof fallback.internalName === 'string'
        ? fallback.internalName
        : sessionName);
    const displayName = typeof payload.displayName === 'string'
      ? payload.displayName
      : (typeof fallback.displayName === 'string' ? fallback.displayName : null);
    this.rememberTerminalHandle(terminalId, {
      internalName: internalName || null,
      sessionName: sessionName || internalName || null,
      displayName: displayName || null,
      cols: Number.isFinite(fallback.cols) ? Math.floor(fallback.cols) : undefined,
      rows: Number.isFinite(fallback.rows) ? Math.floor(fallback.rows) : undefined
    });
  }

  forgetTerminalHandle(terminalId) {
    if (typeof terminalId !== 'string' || terminalId.length === 0) return;
    const resolved = this.resolveTerminalAlias(terminalId);
    this.terminalHandles.delete(terminalId);
    this.terminalHandles.delete(resolved);
    this.streamManager.remove(terminalId);
    this.streamManager.remove(resolved);

    for (const [alias, target] of Array.from(this.terminalAliases.entries())) {
      if (alias === terminalId || alias === resolved || target === terminalId || target === resolved) {
        this.terminalAliases.delete(alias);
      }
    }
  }

  isTerminalNotFoundPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const status = Number.isFinite(payload.status) ? Math.floor(payload.status) : null;
    const err = payload.error;
    const errText = typeof err === 'string'
      ? err
      : (err && typeof err === 'object'
        ? String(err.error || err.message || JSON.stringify(err))
        : '');
    return status === 404 || /terminal not found/i.test(errText);
  }

  isTerminalNotFoundStreamError(rawError) {
    if (!rawError) return false;
    const text = String(rawError);
    if (/terminal not found/i.test(text)) return true;
    if (/stream request failed\s*\(404\)/i.test(text)) return true;
    return false;
  }

  async recoverTerminalId(requestedTerminalId, currentTerminalId, options = {}) {
    const handle = this.getTerminalHandle(currentTerminalId) || this.getTerminalHandle(requestedTerminalId);
    if (!handle) return null;

    const attachBody = {
      internalName: handle.internalName || handle.sessionName || options.internalName,
      name: handle.displayName || options.name,
      cols: Number.isFinite(options.cols) ? Math.floor(options.cols) : handle.cols,
      rows: Number.isFinite(options.rows) ? Math.floor(options.rows) : handle.rows
    };
    if (!attachBody.internalName && !attachBody.name) return null;

    const attached = await this.callApi('POST', '/api/terminals/attach', attachBody);
    if (this.isApiFailurePayload(attached) || !attached.id) {
      return null;
    }

    const recoveredId = String(attached.id);
    this.rememberTerminalHandleFromPayload(attached, attachBody);
    if (requestedTerminalId && requestedTerminalId !== recoveredId) {
      this.terminalAliases.set(requestedTerminalId, recoveredId);
    }
    if (currentTerminalId && currentTerminalId !== recoveredId) {
      this.terminalAliases.set(currentTerminalId, recoveredId);
    }
    this.streamManager.remove(currentTerminalId);
    await this.prewarmTerminalStream(recoveredId, {
      cols: attachBody.cols,
      rows: attachBody.rows
    });
    return recoveredId;
  }

  async callTerminalEndpointWithRecovery(requestedTerminalId, method, endpointBuilder, body, options = {}) {
    let terminalId = this.resolveTerminalAlias(requestedTerminalId);
    let endpoint = endpointBuilder(terminalId);
    let payload = await this.callApi(method, endpoint, typeof body === 'function' ? body(terminalId) : body);

    if (this.isTerminalNotFoundPayload(payload)) {
      const recoveredId = await this.recoverTerminalId(requestedTerminalId, terminalId, options);
      if (recoveredId) {
        terminalId = recoveredId;
        endpoint = endpointBuilder(terminalId);
        payload = await this.callApi(method, endpoint, typeof body === 'function' ? body(terminalId) : body);
      }
    }

    return { payload, endpoint, terminalId };
  }

  async ensureTerminalReadyWithRecovery(requestedTerminalId, options = {}) {
    let terminalId = this.resolveTerminalAlias(requestedTerminalId);
    await this.prewarmTerminalStream(terminalId, options);

    const cursor = this.streamManager.getLatestCursor(terminalId);
    const probe = this.streamManager.readEvents(terminalId, cursor, 0, 1);
    if (!this.isTerminalNotFoundStreamError(probe.error)) {
      return terminalId;
    }

    const recoveredId = await this.recoverTerminalId(requestedTerminalId, terminalId, options);
    if (!recoveredId) {
      return terminalId;
    }
    terminalId = recoveredId;
    await this.prewarmTerminalStream(terminalId, options);
    return terminalId;
  }

  buildDaemonUnreachableHint(baseUrl) {
    const target = baseUrl || this.baseUrl || '<unconfigured>';
    return `Could not reach the hop daemon at ${target}. Start it with 'hop' or 'hop start', or call connect_server(base_url=...) for a remote instance.`;
  }

  async callApiWithConnection(method, baseUrl, token, endpoint, body) {
    let response;
    try {
      response = await requestJson(method, baseUrl, endpoint, token, this.actor, body);
    } catch (err) {
      // Connection-level failures (ECONNREFUSED, DNS, timeouts) become normal
      // tool-result errors instead of opaque JSON-RPC protocol errors.
      return {
        ok: false,
        status: null,
        endpoint,
        error: err instanceof Error ? err.message : String(err),
        hint: this.buildDaemonUnreachableHint(baseUrl)
      };
    }
    if (response.status >= 400) {
      return { ok: false, status: response.status, error: response.data };
    }
    return response.data;
  }

  async callApi(method, endpoint, body) {
    return this.callApiWithConnection(method, this.baseUrl, this.token, endpoint, body);
  }

  isApiFailurePayload(payload) {
    const status = payload && Number.isFinite(payload.status) ? Math.floor(payload.status) : null;
    return !!(
      payload
      && typeof payload === 'object'
      && (
        payload.ok === false
        || (status !== null && status >= 400)
      )
    );
  }

  wrapApiResult(payload, options = {}) {
    const status = payload && Number.isFinite(payload.status) ? Math.floor(payload.status) : null;
    if (!this.isApiFailurePayload(payload)) {
      return this.wrapJson(payload);
    }

    const normalized = {
      ok: false,
      status,
      endpoint: options.endpoint || (payload && payload.endpoint) || null,
      error: Object.prototype.hasOwnProperty.call(payload, 'error') ? payload.error : payload
    };
    if (payload && typeof payload.hint === 'string' && payload.hint) {
      normalized.hint = payload.hint;
    }
    if (status === 403 && /agent access/i.test(JSON.stringify(normalized.error ?? ''))) {
      normalized.hint = "Enable with hop_set_agent_permission(name=..., allowed=true), or ask the user to run 'hop session permit <name>'.";
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(normalized) }],
      isError: true
    };
  }

  wrapJson(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
  }

  wrapResource(uri, payload) {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2)
        }
      ]
    };
  }

  async prewarmTerminalStream(terminalId, options = {}) {
    if (!terminalId) return;
    const resolvedId = this.resolveTerminalAlias(terminalId);
    this.streamManager.ensure(this.baseUrl, this.token, this.actor, resolvedId, options);
    await this.streamManager.waitUntilConnected(resolvedId);
    const waitForOutputMs = Number.isFinite(options.waitForOutputMs)
      ? Math.max(0, Math.floor(options.waitForOutputMs))
      : 0;
    if (waitForOutputMs > 0) {
      await this.streamManager.waitForOutputEvent(resolvedId, waitForOutputMs);
    }
    return resolvedId;
  }

  createWaitJobId() {
    return `wait_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  }

  pruneWaitJobs(nowTs = Date.now()) {
    const now = Number.isFinite(nowTs) ? nowTs : Date.now();

    for (const [waitId, job] of this.waitJobs.entries()) {
      if (!job || typeof job !== 'object') {
        this.waitJobs.delete(waitId);
        continue;
      }
      if (!job.done) continue;
      const updatedAt = Number.isFinite(job.updatedAt) ? job.updatedAt : now;
      if ((now - updatedAt) > WAIT_JOB_TTL_MS) {
        this.waitJobs.delete(waitId);
      }
    }

    if (this.waitJobs.size <= WAIT_JOB_MAX_ENTRIES) return;

    const entries = Array.from(this.waitJobs.entries())
      .sort((left, right) => {
        const leftTs = Number.isFinite(left[1]?.updatedAt) ? left[1].updatedAt : 0;
        const rightTs = Number.isFinite(right[1]?.updatedAt) ? right[1].updatedAt : 0;
        return leftTs - rightTs;
      });

    for (const [waitId, job] of entries) {
      if (this.waitJobs.size <= WAIT_JOB_MAX_ENTRIES) break;
      if (job && job.done) this.waitJobs.delete(waitId);
    }
    for (const [waitId] of entries) {
      if (this.waitJobs.size <= WAIT_JOB_MAX_ENTRIES) break;
      this.waitJobs.delete(waitId);
    }
  }

  startWaitJob(args, metadata = null) {
    const waitId = this.createWaitJobId();
    const now = Date.now();
    const waitArgs = { ...args };
    delete waitArgs.async;
    if (!Number.isFinite(waitArgs.max_wait_ms)) {
      waitArgs.max_wait_ms = DEFAULT_ASYNC_WAIT_MAX_MS;
    }

    const job = {
      waitId,
      createdAt: now,
      updatedAt: now,
      done: false,
      status: 'pending',
      result: null,
      error: null,
      aborted: false,
      promise: null,
      // until_reply_regex verdict, filled in when the job completes (only when
      // the metadata carries the regex).
      replyMatched: null,
      replyMatch: null,
      // Stable link back to the terminal for fleet views (metadata is
      // caller-shaped and not guaranteed to carry it).
      terminalId: typeof args.terminal_id === 'string' ? args.terminal_id : null,
      // Snapshot of the wait arguments so an expired watch can be re-armed
      // identically (hopx_wait_any rearm_timed_out).
      argsSnapshot: { ...waitArgs },
      metadata: metadata && typeof metadata === 'object' ? { ...metadata } : null
    };

    job.promise = (async () => {
      try {
        const outcome = await this.runWaitTerminal(waitArgs, { isAborted: () => job.aborted });
        if (outcome.errorResponse) {
          job.status = 'error';
          job.error = extractToolErrorText(outcome.errorResponse);
        } else {
          job.status = outcome.payload && typeof outcome.payload.status === 'string'
            ? outcome.payload.status
            : 'matched';
          job.result = outcome.payload || null;
        }
      } catch (err) {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
      } finally {
        // Evaluate an until_reply_regex carried in the job metadata, so
        // summaries (hopx_wait_any completed[], wait_id polls) report
        // task-level completion, not just turn completion. The transcript's
        // last assistant message is the authoritative reply source; the
        // wait-captured text is the fallback.
        if (job.metadata && typeof job.metadata.until_reply_regex === 'string') {
          let transcriptReply = null;
          try {
            const handle = this.getTerminalHandle(job.terminalId);
            const internalName = handle ? (handle.internalName || handle.sessionName || null) : null;
            transcriptReply = await this.readLastAssistantReplyText(internalName);
          } catch {
            /* fall back to wait text */
          }
          const reply = evaluateReplyRegex(job.metadata.until_reply_regex, job.result, transcriptReply);
          job.replyMatched = reply.reply_matched;
          job.replyMatch = reply.reply_match;
        }
        job.done = true;
        job.updatedAt = Date.now();
        if (job.metadata && job.metadata.ledger) {
          this.updateLedgerTask(job.waitId, {
            status: job.status === 'error' ? 'failed' : (job.status === 'timed_out' ? 'pending' : 'completed'),
            completedAt: job.status === 'error' || job.status === 'timed_out' ? undefined : job.updatedAt,
            replyMatched: job.replyMatched,
            replyMatch: job.replyMatch,
            error: job.status === 'error' ? (job.error || 'unknown') : undefined
          });
        }
        this.pruneWaitJobs(job.updatedAt);
      }
    })();

    this.waitJobs.set(waitId, job);
    this.pruneWaitJobs(now);
    if (job.metadata && job.metadata.ledger) {
      const handle = this.getTerminalHandle(job.terminalId);
      this.writeLedgerTask({
        taskId: waitId,
        internalName: handle ? (handle.internalName || handle.sessionName || null) : null,
        sessionName: handle ? (handle.displayName || handle.sessionName || null) : null,
        task: typeof job.metadata.task_summary === 'string' ? job.metadata.task_summary : null,
        contract: typeof job.metadata.until_reply_regex === 'string' ? job.metadata.until_reply_regex : null,
        baselineTurnCount: Number.isFinite(args.baselineTurnCount) ? Math.floor(args.baselineTurnCount) : null,
        dispatchedAt: now,
        // The manager terminal that dispatched this task (if one registered for
        // wake), so the background watcher can nudge it awake on completion.
        managerTerminalId: this.managerWatch ? this.managerWatch.terminalId : null,
        status: 'pending'
      });
    }
    return job;
  }

  summarizeWaitJob(job) {
    const payload = {
      ok: job.done ? job.status !== 'error' : true,
      wait_id: job.waitId,
      done: !!job.done,
      status: job.done ? job.status : 'pending'
    };
    if (job.done && job.metadata && typeof job.metadata === 'object') {
      payload.metadata = job.metadata;
    }
    if (job.done && typeof job.replyMatched === 'boolean') {
      payload.reply_matched = job.replyMatched;
      payload.reply_match = job.replyMatch;
    }
    return payload;
  }

  async handleWaitStart(args) {
    if (!args || typeof args !== 'object') {
      return { content: [{ type: 'text', text: 'Error: wait arguments are required.' }], isError: true };
    }
    if (!args.terminal_id) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }

    const job = this.startWaitJob(args);
    return this.wrapJson(this.summarizeWaitJob(job));
  }

  async handleWaitPoll(args) {
    const waitId = typeof args.wait_id === 'string' ? args.wait_id.trim() : '';
    if (!waitId) {
      return { content: [{ type: 'text', text: 'Error: wait_id is required.' }], isError: true };
    }

    const job = this.waitJobs.get(waitId);
    if (!job) {
      return {
        content: [{ type: 'text', text: `Error: wait job not found (${waitId}). It may be stale after daemon or MCP restart.` }],
        isError: true
      };
    }

    // Cancel a still-running wait: signal the loop to abort and let it settle so
    // a hung/long async wait can be reclaimed instead of running to its timeout.
    if (args.cancel === true && !job.done) {
      job.aborted = true;
      await Promise.race([
        job.promise,
        new Promise((resolve) => setTimeout(resolve, 1000))
      ]);
    }

    if (args.wait === true && !job.done) {
      const maxWaitMs = Number.isFinite(args.max_wait_ms)
        ? Math.max(1, Math.floor(args.max_wait_ms))
        : DEFAULT_WAIT_POLL_MAX_MS;
      await Promise.race([
        job.promise,
        new Promise((resolve) => setTimeout(resolve, maxWaitMs))
      ]);
    }

    const payload = this.summarizeWaitJob(job);
    if (job.done && job.result) {
      payload.result = slimWaitPayload(job.result, null);
    }
    if (job.done && job.status === 'error') {
      payload.error = job.error || 'Unknown wait failure';
    }

    if (args.consume === true && job.done) {
      this.waitJobs.delete(waitId);
    }

    if (job.done && job.status === 'error') {
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: true
      };
    }
    return this.wrapJson(payload);
  }

  parseToolJsonResponse(response, label) {
    if (!response || typeof response !== 'object') {
      return { ok: false, error: `${label}: invalid response` };
    }
    if (response.isError) {
      return { ok: false, error: `${label}: ${extractToolErrorText(response)}` };
    }
    const content = Array.isArray(response.content) ? response.content : [];
    const first = content.length > 0 ? content[0] : null;
    if (!first || typeof first.text !== 'string') {
      return { ok: false, error: `${label}: missing response text payload` };
    }
    try {
      return { ok: true, payload: JSON.parse(first.text) };
    } catch (err) {
      return {
        ok: false,
        error: `${label}: failed to parse JSON (${err instanceof Error ? err.message : String(err)})`
      };
    }
  }

  getHopxControlMode(args, hasInputAction) {
    const requested = typeof args.control === 'string' ? String(args.control).toLowerCase() : '';
    if (requested === 'send' || requested === 'wait' || requested === 'interrupt' || requested === 'terminate') {
      return requested;
    }
    return hasInputAction ? 'send' : 'wait';
  }

  getHopxInterruptKey(args) {
    if (typeof args.interrupt_key === 'string' && args.interrupt_key.trim().length > 0) {
      return args.interrupt_key.trim();
    }
    return 'esc';
  }

  async sendHopxControlInput(terminalId, key, repeat = 1) {
    const mapped = resolveSendKeyInput(key, repeat);
    if (!mapped.ok) {
      return {
        errorResponse: { content: [{ type: 'text', text: `Error: ${mapped.error}` }], isError: true }
      };
    }

    const resolvedId = await this.ensureTerminalReadyWithRecovery(terminalId);
    this.streamManager.noteTerminalInput(resolvedId, mapped.data);
    const call = await this.callTerminalEndpointWithRecovery(
      terminalId,
      'POST',
      (currentTerminalId) => `/api/terminals/${encodeURIComponent(currentTerminalId)}/write`,
      { data: mapped.data }
    );
    if (this.isApiFailurePayload(call.payload)) {
      return { errorResponse: this.wrapApiResult(call.payload, { endpoint: call.endpoint }) };
    }
    return {
      payload: {
        terminal_id: terminalId,
        sent: [{ source: `key:${normalizeSendKeyName(key)}`, bytes: Buffer.byteLength(mapped.data, 'utf8') }]
      }
    };
  }

  async formatHopxAsyncWaitResponse(job, options = {}) {
    const metadata = job && job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
    const payload = this.summarizeWaitJob(job);
    const includeUiRawTail = metadata.includeUiRawTail === true;
    const selectedMode = typeof metadata.selected_mode === 'string' ? metadata.selected_mode : 'readable_raw';
    payload.helper = 'hopx_agent_turn';
    payload.terminal_id = metadata.terminal_id || options.terminal_id || null;

    if (job.done && job.result) {
      const waitCaptureMode = job.result && typeof job.result.captureMode === 'string'
        ? String(job.result.captureMode).toLowerCase()
        : 'readable_raw';
      const rawWait = (
        metadata.text_only === true
        && waitCaptureMode === 'readable_raw'
      )
        ? condenseReadableWaitPayload(job.result)
        : job.result;
      payload.wait = slimWaitPayload(rawWait, null);
      if (selectedMode === 'ui' && payload.terminal_id) {
        const uiOutcome = await this.readHopxUiSnapshot(
          payload.terminal_id,
          metadata.uiMaxLines,
          metadata.rawTailMaxEvents,
          includeUiRawTail
        );
        if (uiOutcome.errorResponse) return uiOutcome.errorResponse;
        payload.output = uiOutcome.payload;
      }
    }
    if (job.done && job.status === 'error') {
      payload.error = job.error || 'Unknown wait failure';
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: true
      };
    }

    return this.wrapJson(payload);
  }

  applyHopxWaitDefaults(waitArgs) {
    const next = { ...waitArgs };
    if (next.capture_max_events === undefined || next.capture_max_events === null) {
      next.capture_max_events = DEFAULT_HOPX_WAIT_CAPTURE_MAX_EVENTS;
    }

    const captureMode = typeof next.capture === 'string'
      ? String(next.capture).toLowerCase()
      : 'readable_raw';
    if (captureMode === 'readable_raw') {
      if (next.control_level === undefined || next.control_level === null || next.control_level === '') {
        next.control_level = DEFAULT_READABLE_CONTROL_LEVEL;
      }
      if (next.noise_filter === undefined || next.noise_filter === null || next.noise_filter === '') {
        next.noise_filter = DEFAULT_READABLE_NOISE_FILTER;
      }
      if (next.coalesce_ms === undefined || next.coalesce_ms === null) {
        next.coalesce_ms = DEFAULT_HOPX_READABLE_COALESCE_MS;
      }
    }
    return next;
  }

  shouldApplyHopxUiBusyGuard(args, waitPayload) {
    if (!waitPayload || typeof waitPayload !== 'object') return false;
    if (waitPayload.matched !== 'agent_done') return false;
    if (args.until_agent_done === false) return false;
    if (typeof args.until_regex === 'string' && args.until_regex.length > 0) return false;
    if (args.until_prompt === true) return false;
    if (args.idle_ms !== undefined && args.idle_ms !== null) return false;
    return true;
  }

  // Read the per-turn completion counter the Claude Stop hook writes for a hop
  // session (see scripts/claude-session-hook.js). Returns the integer count, or
  // null when the marker is absent/unreadable (hook not installed, driving a
  // non-Claude session, or no local filesystem access) — callers then fall back
  // to the busy-line heuristic.
  readTurnCount(internalName) {
    if (!internalName || !/^[A-Za-z0-9_.-]+$/.test(internalName)) return null;
    try {
      const file = path.join(resolveHomeDir(), 'claude-sessions', `${internalName}.turn`);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && Number.isInteger(data.count) ? data.count : null;
    } catch {
      return null;
    }
  }

  // Authoritative reply text for until_reply_regex: the last assistant message
  // in the session's Claude transcript. Returns null when no transcript is
  // resolvable (non-Claude agent, no hook record, remote host) — callers then
  // fall back to wait-captured text.
  async readLastAssistantReplyText(internalName) {
    if (!internalName) return null;
    try {
      const source = await this.resolveTrajectorySource(internalName);
      if (!source || source.error || source.kind !== 'local') return null;
      const data = await this.loadTrajectory(source, { mode: 'tail', limit: 8, textOnly: true });
      const tail = Array.isArray(data && data.tail) ? data.tail : [];
      for (let i = tail.length - 1; i >= 0; i--) {
        const t = tail[i];
        if (t && t.kind === 'assistant' && typeof t.text === 'string' && t.text.trim()) {
          return t.text;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Durable task ledger (~/.hop2/orchestration/tasks/<id>.json) ─────────
  // Orchestration state that survives manager/MCP restarts: every async
  // dispatched turn with a contract is recorded on disk and lazily reconciled
  // from the turn counters + transcripts. One file per task — no locking.
  ledgerDir() {
    return path.join(resolveHomeDir(), 'orchestration', 'tasks');
  }

  writeLedgerTask(entry) {
    try {
      const dir = this.ledgerDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${entry.taskId}.json`);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
      fs.renameSync(tmp, file);
    } catch { /* ledger is best-effort; never break the dispatch */ }
  }

  updateLedgerTask(taskId, patch) {
    try {
      const file = path.join(this.ledgerDir(), `${taskId}.json`);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.writeLedgerTask({ ...entry, ...patch });
    } catch { /* entry may not exist (ledger disabled or pruned) */ }
  }

  listLedgerTasks() {
    const out = [];
    try {
      for (const f of fs.readdirSync(this.ledgerDir())) {
        if (!f.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(this.ledgerDir(), f), 'utf8'))); }
        catch { /* skip unreadable */ }
      }
    } catch { /* no ledger yet */ }
    out.sort((a, b) => (b.dispatchedAt || 0) - (a.dispatchedAt || 0));
    return out;
  }

  // Settle pending entries without any live wait job: if the session's turn
  // counter advanced past the dispatch baseline, the turn finished while
  // nobody was watching (e.g. the manager died) — evaluate the contract from
  // the transcript and complete the entry. Called lazily on ledger reads and
  // overview calls, so a restarted manager sees truth immediately.
  async reconcileLedger() {
    let changed = 0;
    for (const entry of this.listLedgerTasks()) {
      if (entry.status !== 'pending') continue;
      const current = this.readTurnCount(entry.internalName);
      if (current === null || current <= (entry.baselineTurnCount ?? 0)) continue;
      let replyMatched = null;
      let replyMatch = null;
      if (typeof entry.contract === 'string' && entry.contract) {
        const replyText = await this.readLastAssistantReplyText(entry.internalName);
        const verdict = evaluateReplyRegex(entry.contract, null, replyText);
        replyMatched = verdict.reply_matched;
        replyMatch = verdict.reply_match;
      }
      this.updateLedgerTask(entry.taskId, {
        status: 'completed', completedAt: Date.now(), turnCount: current,
        replyMatched, replyMatch, reconciled: true
      });
      changed += 1;
    }
    return changed;
  }

  // True when the SessionStart hook has recorded this hop session: the Stop
  // hook will then bump the turn counter, making the counter the authoritative
  // agent_done signal — the quiet-screen heuristic alone must not declare a
  // turn finished (thinking models pause with an idle-looking screen).
  hasClaudeHookRecord(internalName) {
    if (!internalName || !/^[A-Za-z0-9_.-]+$/.test(internalName)) return false;
    try {
      fs.accessSync(path.join(resolveHomeDir(), 'claude-sessions', `${internalName}.json`));
      return true;
    } catch {
      return false;
    }
  }

  // Resolve a hop session name to its Claude transcript file. Seam: returns a
  // { kind:'local', path, ... } source today (the MCP runs on the same host as
  // the sessions); a future { kind:'daemon', name } variant can route the read
  // through a daemon endpoint for agent-remote-from-sessions setups, with
  // loadTrajectory() switching on source.kind.
  async resolveTrajectorySource(name) {
    if (!name || typeof name !== 'string') return { error: 'name is required' };
    let internalName = name;
    let cwd = null;
    let matched = false;
    let agentPermitted = false;
    try {
      const listed = await this.callApi('GET', '/api/sessions');
      if (listed && Array.isArray(listed.sessions)) {
        const match = listed.sessions.find((s) => s && (s.name === name || s.displayName === name || s.internalName === name));
        if (match) {
          matched = true;
          internalName = match.internalName || match.name || name;
          cwd = typeof match.cwd === 'string' ? match.cwd : null;
          agentPermitted = match.agentPermitted === true;
        }
      }
    } catch { /* daemon unreachable -> cannot verify permission, deny below */ }

    // Agent-permission gate: reading a session's transcript is gated by the SAME
    // per-session permission as attaching to its terminal, so a driver can't read
    // history it isn't allowed to drive. We must be able to confirm the permission
    // from the live session list; if we can't (unknown session / daemon down), deny —
    // with one post-mortem exception: a killed/exited session drops out of the live
    // list, but its SessionStart hook record and transcript survive on disk. The
    // hook record only exists for sessions that ran under hop with the hook
    // installed, so its presence proves this was a hop-launched Claude session;
    // treat it as permission for the read-only post-mortem. Sessions with no hook
    // record keep the hard deny, and live-but-unpermitted sessions stay denied.
    let postMortem = false;
    if (!matched) {
      if (!this.hasClaudeHookRecord(internalName)) {
        return { error: `Unknown hop session "${name}" (not in the session list and no on-disk hook record, so access can't be verified).`, denied: true };
      }
      postMortem = true;
    } else if (!agentPermitted) {
      return {
        error: `Agent access not permitted for "${name}". Enable with hop_set_agent_permission(name="${name}", allowed=true) or run 'hop session permit ${name}'.`,
        denied: true
      };
    }

    let sessionId = null;
    if (/^[A-Za-z0-9_.-]+$/.test(internalName)) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(resolveHomeDir(), 'claude-sessions', `${internalName}.json`), 'utf8'));
        if (rec && typeof rec.sessionId === 'string' && rec.sessionId) sessionId = rec.sessionId;
        if (rec && typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd; // hook record cwd wins
      } catch { /* no hook record */ }
    }
    if (!cwd) {
      return { error: `Could not resolve a working directory for session "${name}" (not a known hop session, and no claude-sessions record).` };
    }

    // Transcripts live under <config-root>/projects/<cwd-slug>/. The root is
    // NOT always ~/.claude: alternate installs point CLAUDE_CONFIG_DIR at e.g.
    // ~/.claude_fable, so search every plausible root (exact sessionId match
    // first across all roots, then newest-fallback across all roots).
    const projectDirs = claudeConfigRoots().map((root) => path.join(root, 'projects', encodeClaudeProjectDir(cwd)));
    if (sessionId) {
      for (const projectDir of projectDirs) {
        const preferred = path.join(projectDir, `${sessionId}.jsonl`);
        if (fs.existsSync(preferred)) {
          return { kind: 'local', path: preferred, sessionId, cwd, internalName, fallback: false, postMortem };
        }
      }
    }
    // Fallback: newest .jsonl across the project dirs (hook not installed /
    // sessionId stale). This is AMBIGUOUS when several sessions share a cwd:
    // every one of them maps to the single newest transcript. We surface that
    // (ambiguous + candidateCount) so a caller knows the mapping may be wrong
    // and to install the SessionStart hook (`hop claude-hook install`), which
    // records each session's exact sessionId.
    let best = null; let bestMtime = -1; let candidateCount = 0;
    for (const projectDir of projectDirs) {
      try {
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
        candidateCount += files.length;
        for (const f of files) {
          const p = path.join(projectDir, f);
          let m = 0; try { m = fs.statSync(p).mtimeMs; } catch { /* skip */ }
          if (m > bestMtime) { bestMtime = m; best = p; }
        }
      } catch { /* project dir missing in this root */ }
    }
    if (best) {
      return {
        kind: 'local', path: best,
        sessionId: sessionId || path.basename(best, '.jsonl'),
        cwd, internalName, fallback: true, postMortem,
        ambiguous: candidateCount > 1,
        candidateCount
      };
    }
    // Last resort: the hook recorded an exact sessionId — search every root's
    // project dirs for it directly, immune to slug-encoding drift.
    if (sessionId) {
      for (const root of claudeConfigRoots()) {
        const projectsDir = path.join(root, 'projects');
        let entries = [];
        try { entries = fs.readdirSync(projectsDir); } catch { continue; }
        for (const entry of entries) {
          const candidate = path.join(projectsDir, entry, `${sessionId}.jsonl`);
          if (fs.existsSync(candidate)) {
            return { kind: 'local', path: candidate, sessionId, cwd, internalName, fallback: false, viaSessionIdScan: true, postMortem };
          }
        }
      }
    }
    return { error: `No Claude transcript found for "${name}" under ${projectDirs.join(', ')}. The SessionStart hook may not be installed, the session may not be Claude, or the transcript isn't on this host.` };
  }

  buildFullTrajectoryTurn(obj, rec, summary, textOnly) {
    const full = {
      index: rec.index,
      uuid: rec.uuid,
      kind: rec.kind,
      ts: rec.ts,
      role: (obj.message && typeof obj.message.role === 'string') ? obj.message.role : null,
      model: (obj.message && typeof obj.message.model === 'string') ? obj.message.model : undefined,
      outTokens: rec.outTokens,
      text: summary.textParts.join('\n\n')
    };
    if (textOnly) return full;
    const content = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
    const toolUses = [];
    const toolResults = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use') {
        let inputStr = '';
        try { inputStr = JSON.stringify(b.input); } catch { inputStr = ''; }
        toolUses.push({ name: b.name, inputPreview: inputStr.slice(0, 400), inputBytes: Buffer.byteLength(inputStr || '', 'utf8') });
      } else if (b.type === 'tool_result') {
        let txt = '';
        const c = b.content;
        if (typeof c === 'string') txt = c;
        else if (Array.isArray(c)) txt = c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('\n');
        toolResults.push({ isError: !!b.is_error, preview: txt.slice(0, 400), bytes: Buffer.byteLength(txt, 'utf8') });
      }
    }
    if (toolUses.length) full.toolUses = toolUses;
    if (toolResults.length) full.toolResults = toolResults;
    return full;
  }

  // Stream-parse a transcript (readline; never loads the whole file) and assemble
  // a mode-appropriate, compact payload. turns[] holds only compact records;
  // full content is captured only for the one requested turn (get) or the last N
  // (tail). The seam: only kind:'local' is implemented today.
  async loadTrajectory(source, opts) {
    if (source.kind !== 'local') throw new Error(`Unsupported trajectory source: ${source.kind}`);
    const mode = opts.mode;
    const includeThinking = opts.includeThinking === true;
    const tailLimit = mode === 'tail' ? (Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 6) : 0;

    const turns = [];
    const counts = {};
    const tailRing = [];
    const digestTurns = [];
    let curTurn = null;
    let getMatch = null;
    let lineCount = 0; let parseErrors = 0; let totalOutTokens = 0;
    let model = null; let title = null; let firstTs = null; let lastTs = null;
    let turnIndex = 0;

    const rl = readline.createInterface({ input: fs.createReadStream(source.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      lineCount += 1;
      let obj;
      try { obj = JSON.parse(line); } catch { parseErrors += 1; continue; }
      if (!obj || typeof obj !== 'object') { parseErrors += 1; continue; }

      const ltype = typeof obj.type === 'string' ? obj.type : 'unknown';
      counts[ltype] = (counts[ltype] || 0) + 1;
      const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
      if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
      if (obj.message && typeof obj.message === 'object') {
        if (typeof obj.message.model === 'string') model = obj.message.model;
        const u = obj.message.usage;
        if (u && Number.isInteger(u.output_tokens)) totalOutTokens += u.output_tokens;
      }
      if (ltype === 'ai-title' && typeof obj.aiTitle === 'string') title = obj.aiTitle;

      const role = (obj.message && typeof obj.message.role === 'string') ? obj.message.role : null;
      let kind = null;
      if (ltype === 'assistant' || role === 'assistant') kind = 'assistant';
      else if (ltype === 'user' || role === 'user') kind = 'user';
      if (!kind) continue; // noise line: counted in countsByType only

      const summary = summarizeMessageContent(obj.message, includeThinking);
      const hasText = summary.textParts.some((t) => t && t.trim());
      let semantic = kind;
      if (kind === 'user' && !hasText && summary.toolResults > 0) semantic = 'tool_result';
      const outTokens = (obj.message && obj.message.usage && Number.isInteger(obj.message.usage.output_tokens))
        ? obj.message.usage.output_tokens : undefined;
      const rec = {
        index: turnIndex,
        uuid: typeof obj.uuid === 'string' ? obj.uuid : null,
        kind: semantic,
        ts,
        preview: firstTrajectoryText(summary.textParts, 120)
          || (summary.toolResults ? `[tool_result x${summary.toolResults}${summary.isError ? ' error' : ''}]`
            : (summary.toolNames.length ? `[tool_use: ${summary.toolNames.join(', ')}]` : '')),
        toolNames: summary.toolNames.length ? summary.toolNames : undefined,
        outTokens,
        isError: summary.isError || undefined,
        bytes: Buffer.byteLength(line, 'utf8')
      };
      turns.push(rec);

      if (mode === 'digest') {
        // Group into User -> (Assistant text + tool one-liners) turns. A
        // tool_result-only user line doesn't start a turn (it's dropped); it just
        // doesn't interrupt the current one.
        if (kind === 'user' && hasText) {
          if (curTurn) digestTurns.push(curTurn);
          curTurn = { user: summary.textParts.join('\n').trim(), ts: ts ? ts.slice(0, 19) : '', assistantParts: [], tools: [] };
        } else if (kind === 'assistant') {
          if (!curTurn) curTurn = { user: null, ts: ts ? ts.slice(0, 19) : '', assistantParts: [], tools: [] };
          const atxt = summary.textParts.join('\n');
          if (atxt.trim()) curTurn.assistantParts.push(atxt);
          const content = (obj.message && Array.isArray(obj.message.content)) ? obj.message.content : [];
          for (const b of content) {
            if (b && typeof b === 'object' && b.type === 'tool_use') curTurn.tools.push(summarizeToolCall(b));
          }
        }
      }

      if (mode === 'get') {
        const wantIndex = Number.isInteger(opts.index) ? opts.index : null;
        const wantUuid = typeof opts.uuid === 'string' ? opts.uuid : null;
        if ((wantUuid && rec.uuid === wantUuid) || (wantIndex !== null && turnIndex === wantIndex)) {
          getMatch = this.buildFullTrajectoryTurn(obj, rec, summary, opts.textOnly === true);
        }
      } else if (tailLimit > 0) {
        tailRing.push(this.buildFullTrajectoryTurn(obj, rec, summary, opts.textOnly === true));
        if (tailRing.length > tailLimit) tailRing.shift();
      }
      turnIndex += 1;
    }

    let bytes = 0;
    try { bytes = fs.statSync(source.path).size; } catch { /* ignore */ }
    const sourceInfo = {
      sessionId: source.sessionId, cwd: source.cwd, internalName: source.internalName,
      path: source.path, fallback: source.fallback === true
    };
    if (source.postMortem === true) {
      sourceInfo.postMortem = true; // session no longer live; read allowed via its on-disk hook record
    }
    if (source.ambiguous) {
      sourceInfo.ambiguous = true;
      sourceInfo.candidateCount = source.candidateCount;
      sourceInfo.warning = `No SessionStart-hook record for "${source.internalName}"; resolved by newest transcript in a cwd with ${source.candidateCount} transcripts, so this may be the wrong session. Install the hook (\`hop claude-hook install\`) for exact per-session mapping.`;
    }

    if (mode === 'digest') {
      if (curTurn) digestTurns.push(curTurn);
      const maxChars = Number.isFinite(opts.maxChars) ? Math.max(500, Math.floor(opts.maxChars)) : 8000;
      // Drop turns whose user text is injected noise (system reminders, command
      // echoes, task notifications, ...).
      const kept = digestTurns.filter((t) => !(typeof t.user === 'string' && isTrajectoryNoise(t.user)));
      // Budget recent-first: keep the most recent turns that fit (always >=1).
      const budget = Math.max(400, Math.floor(maxChars * 0.9)); // headroom for header/JSON escaping
      const blocks = [];
      let total = 0;
      for (let i = kept.length - 1; i >= 0; i--) {
        const block = renderDigestTurn(kept[i]);
        if (total + block.length > budget && blocks.length) break;
        blocks.push(block);
        total += block.length;
      }
      blocks.reverse();
      const included = blocks.length;
      return {
        ok: true, helper: 'hop_read_trajectory', mode: 'digest', source: sourceInfo,
        turnCountTotal: kept.length, turnsIncluded: included,
        firstTs, lastTs, model, title: title || undefined,
        ...(included < kept.length ? { truncated: true, hint: `Showing the ${included} most recent of ${kept.length} turns (max_chars=${maxChars}). Raise max_chars for more, or use mode="list"/"get" to navigate.` } : {}),
        text: blocks.join('\n')
      };
    }

    if (mode === 'list') {
      const limit = (Number.isInteger(opts.limit) && opts.limit > 0) ? opts.limit : 20;
      let offset;
      if (Number.isInteger(opts.offset)) offset = opts.offset < 0 ? Math.max(0, turns.length + opts.offset) : opts.offset;
      else offset = Math.max(0, turns.length - limit);
      const slice = turns.slice(offset, offset + limit);
      return {
        ok: true, helper: 'hop_read_trajectory', mode, source: sourceInfo,
        turnCount: turns.length, offset, limit,
        nextOffset: (offset + limit) < turns.length ? (offset + limit) : null,
        turns: slice
      };
    }
    if (mode === 'get') {
      if (!getMatch) {
        return { __error: `Turn not found (index=${opts.index}, uuid=${opts.uuid || ''}). turnCount=${turns.length}; use mode="list" to find a valid index.` };
      }
      return { ok: true, helper: 'hop_read_trajectory', mode, source: sourceInfo, turnCount: turns.length, turn: getMatch };
    }
    if (mode === 'tail') {
      return { ok: true, helper: 'hop_read_trajectory', mode, source: sourceInfo, turnCount: turns.length, tail: tailRing };
    }
    // summary (default)
    return {
      ok: true, helper: 'hop_read_trajectory', mode: 'summary', source: sourceInfo,
      lineCount, parseErrors, bytes, firstTs, lastTs, model, title: title || undefined,
      turnCount: turns.length, countsByType: counts, totalOutTokens,
      lastTurns: turns.slice(-8)
    };
  }

  // Keep the result under max_chars. Compact modes rarely overflow by construction;
  // when they do, trim the biggest field (full text / oldest items) and flag it.
  capTrajectoryPayload(payload, mode, maxChars) {
    const fits = (p) => JSON.stringify(p).length <= maxChars;
    if (fits(payload)) return payload;
    payload.truncated = true;
    payload.hint = `Output exceeded max_chars=${maxChars}; narrow the query (smaller limit, a specific index/uuid via mode="get", or raise max_chars).`;
    if (mode === 'digest' && typeof payload.text === 'string') {
      // digest is already budgeted recent-first; if JSON overhead still pushes it
      // over, trim from the FRONT so the most recent turns are kept.
      while (!fits(payload) && payload.text.length > 200) {
        payload.text = payload.text.slice(Math.floor(payload.text.length * 0.2));
      }
      payload.text = '…\n' + payload.text;
    } else if (mode === 'get' && payload.turn) {
      if (payload.turn.toolUses) delete payload.turn.toolUses;
      if (!fits(payload) && payload.turn.toolResults) delete payload.turn.toolResults;
      while (!fits(payload) && typeof payload.turn.text === 'string' && payload.turn.text.length > 200) {
        payload.turn.text = payload.turn.text.slice(0, Math.floor(payload.turn.text.length * 0.7));
      }
      if (!fits(payload) && typeof payload.turn.text === 'string') payload.turn.text = payload.turn.text.slice(0, 200) + '…';
    } else if (mode === 'tail' && Array.isArray(payload.tail)) {
      for (const it of payload.tail) {
        if (typeof it.text === 'string' && it.text.length > 300) it.text = it.text.slice(0, 300) + '…';
        delete it.toolUses; delete it.toolResults;
      }
      while (!fits(payload) && payload.tail.length > 1) payload.tail.shift();
    } else if (mode === 'list' && Array.isArray(payload.turns)) {
      while (!fits(payload) && payload.turns.length > 1) payload.turns.pop();
    } else if (Array.isArray(payload.lastTurns)) {
      while (!fits(payload) && payload.lastTurns.length > 1) payload.lastTurns.shift();
    }
    return payload;
  }

  async handleReadTrajectory(args) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return { content: [{ type: 'text', text: 'Error: name is required.' }], isError: true };
    const mode = ['digest', 'summary', 'list', 'get', 'tail'].includes(args.mode) ? args.mode : 'digest';
    const maxChars = Number.isFinite(args.max_chars) ? Math.max(500, Math.floor(args.max_chars)) : 8000;
    const opts = {
      mode,
      maxChars,
      includeThinking: args.include_thinking === true,
      textOnly: args.text_only === true,
      offset: Number.isFinite(args.offset) ? Math.floor(args.offset) : undefined,
      limit: Number.isFinite(args.limit) ? Math.floor(args.limit) : undefined,
      index: Number.isFinite(args.index) ? Math.floor(args.index) : undefined,
      uuid: typeof args.uuid === 'string' ? args.uuid : undefined
    };
    if (mode === 'get' && opts.index === undefined && !opts.uuid) {
      return { content: [{ type: 'text', text: 'Error: mode="get" requires index or uuid (find one with mode="list").' }], isError: true };
    }
    const source = await this.resolveTrajectorySource(name);
    if (source.error) return { content: [{ type: 'text', text: `Error: ${source.error}` }], isError: true };
    let payload;
    try {
      payload = await this.loadTrajectory(source, opts);
    } catch (e) {
      return { content: [{ type: 'text', text: `Error reading trajectory: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
    if (payload && payload.__error) {
      return { content: [{ type: 'text', text: `Error: ${payload.__error}` }], isError: true };
    }
    return this.wrapJson(this.capTrajectoryPayload(payload, mode, maxChars));
  }

  // Hop-native history capture: obtain an alternate-screen TUI's scrollback the way
  // a user would — drive the app to scroll up, snapshot each rendered frame, and
  // stitch the newly-revealed rows together. Works when the transcript file isn't
  // reachable and for any scrollable TUI (Claude verified: PageUp scrolls, PageDown
  // restores). Best-effort and lossy for wrapped/redrawn content — prefer
  // hop_read_trajectory when a Claude transcript is available.
  async handleCaptureScrollback(args) {
    const requestedTerminalId = typeof args.terminal_id === 'string' ? args.terminal_id : '';
    if (!requestedTerminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }
    const scrollKey = (typeof args.scroll_key === 'string' && args.scroll_key) ? args.scroll_key : 'page_up';
    const restoreKey = (typeof args.restore_key === 'string' && args.restore_key) ? args.restore_key : 'page_down';
    const maxPages = Number.isFinite(args.max_pages) ? Math.max(1, Math.floor(args.max_pages)) : 40;
    const settleMs = Number.isFinite(args.settle_ms) ? Math.max(100, Math.floor(args.settle_ms)) : 1200;
    const maxChars = Number.isFinite(args.max_chars) ? Math.max(500, Math.floor(args.max_chars)) : 8000;
    const restore = args.restore !== false;

    const terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const readFrame = async () => {
      await this.streamManager.flushVirtualScreen(terminalId);
      const snap = this.streamManager.getUiSnapshot(terminalId, {});
      if (!snap || snap.available === false) return null;
      const lines = Array.isArray(snap.lines)
        ? snap.lines.map((l) => (l && typeof l.text === 'string' ? l.text.replace(/\s+$/, '') : ''))
        : [];
      return { lines, rev: snap.screenRevision };
    };
    // Send a scroll key, then poll for the screen to actually redraw (screenRevision
    // change) within the settle budget. No redraw → the app didn't scroll (top reached
    // or key not handled).
    const scrollAndWait = async (key, prevRev) => {
      await this.handleSendAndWait({ terminal_id: requestedTerminalId, key, wait: false });
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        await sleep(120);
        const f = await readFrame();
        if (f && f.rev !== prevRev) return f;
      }
      return null;
    };

    const first = await readFrame();
    if (!first) {
      return { content: [{ type: 'text', text: 'Error: no rendered screen available for this terminal.' }], isError: true };
    }
    let prevFull = first.lines;
    let prevRev = first.rev;
    let accumulator = null;
    let pages = 0;
    let reachedTop = false;
    let truncated = false;

    while (pages < maxPages) {
      const nf = await scrollAndWait(scrollKey, prevRev);
      if (!nf) { reachedTop = true; break; } // no redraw → can't scroll further
      const newFull = nf.lines;
      prevRev = nf.rev;
      const chromeN = bottomFixedCount(newFull, prevFull);
      const prevTrans = stripTrailingBlankLines(prevFull.slice(0, prevFull.length - chromeN));
      const newTrans = stripTrailingBlankLines(newFull.slice(0, newFull.length - chromeN));
      if (accumulator === null) accumulator = prevTrans.slice();
      const overlap = maxBottomTopOverlap(newTrans, accumulator);
      const revealed = newTrans.slice(0, newTrans.length - overlap);
      if (revealed.filter((s) => s.trim().length).length === 0) { reachedTop = true; break; }
      accumulator = revealed.concat(accumulator);
      prevFull = newFull;
      pages += 1;
      if (accumulator.join('\n').length > maxChars) { truncated = true; break; }
    }
    if (accumulator === null) accumulator = stripTrailingBlankLines(prevFull); // never scrolled

    // Restore the user's live view (reverse the scroll). page_down is a no-op once
    // at the bottom, so an exact reversal is safe even if the last scroll clamped.
    let restored = false;
    if (restore && pages > 0) {
      for (let i = 0; i < pages; i++) {
        await this.handleSendAndWait({ terminal_id: requestedTerminalId, key: restoreKey, wait: false });
        await sleep(60);
      }
      await sleep(150);
      restored = true;
    }

    let text = accumulator.join('\n');
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }

    return this.wrapJson({
      ok: true,
      helper: 'hopx_capture_scrollback',
      terminal_id: requestedTerminalId,
      scrollKey,
      pagesCaptured: pages,
      reachedTop,
      restored,
      lineCount: accumulator.length,
      ...(truncated ? { truncated: true, hint: `Captured scrollback hit max_chars=${maxChars}; raise max_chars or lower max_pages. Earliest content kept; the live bottom is visible in the terminal.` } : {}),
      text
    });
  }

  // Verified submit (firstmate lesson): pressing Enter at a TUI composer can be
  // swallowed when the app isn't ready for input, leaving the prompt sitting
  // unsent — the driver then waits forever for a turn that never started. After a
  // send+Enter we re-read the composer (dim-ghost/border-aware, see
  // getComposerState) and, if our text is still in the box, re-send Enter a
  // bounded number of times. Only acts in TUI/alt-screen mode where a composer
  // exists; degrades to a no-op (verified:false, reason:composer_not_found) when
  // it can't see a box, so it never double-submits a plain shell.
  async verifyHopxSubmitCleared(requestedTerminalId, streamTerminalId, sentData, opts = {}) {
    const retries = Number.isInteger(opts.retries)
      ? Math.max(0, opts.retries)
      : DEFAULT_HOPX_VERIFY_SUBMIT_RETRIES;
    const delayMs = Number.isFinite(opts.delayMs)
      ? Math.max(0, Math.floor(opts.delayMs))
      : DEFAULT_HOPX_VERIFY_SUBMIT_DELAY_MS;
    let resends = 0;
    let composer = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await this.streamManager.flushVirtualScreen(streamTerminalId);
      composer = this.streamManager.getComposerState(streamTerminalId);
      if (!composer || !composer.found) {
        return { applied: true, verified: false, reason: 'composer_not_found', resends, composer: composer || null };
      }
      if (composer.isEmpty) {
        return {
          applied: true, verified: true,
          reason: resends ? 'cleared_after_resend' : 'cleared',
          resends, composer
        };
      }
      if (!composerSharesContent(sentData, composer.text)) {
        // The box holds something other than our un-submitted prompt; don't poke it.
        return { applied: true, verified: false, reason: 'composer_has_other_text', resends, composer };
      }
      if (attempt === retries) break;
      // Our prompt is still sitting in the composer → Enter was swallowed. Re-send.
      const re = await this.handleSendAndWait({
        terminal_id: requestedTerminalId,
        press_enter: true,
        wait: false
      });
      if (re.isError) {
        return { applied: true, verified: false, reason: 'resend_failed', resends, composer };
      }
      resends += 1;
    }
    return { applied: true, verified: false, reason: 'still_present', resends, composer };
  }

  shouldVerifyHopxSubmit(args) {
    return args.verify_submit !== false;
  }

  // Compact view of a waitForHopxUiNotBusy result for the wait payload's
  // uiBusyGuard field: the three-state verdict plus the signals behind it.
  summarizeUiBusyGuard(payload) {
    if (!payload || typeof payload !== 'object') return { applied: true };
    return {
      applied: true,
      state: payload.state || (payload.busy === true ? 'busy' : 'done'),
      busy: payload.busy === true,
      turnDone: payload.turnDone === true,
      busyLine: payload.busyLine || null,
      settledIdle: Number.isInteger(payload.settledIdle) ? payload.settledIdle : undefined,
      composer: payload.composer || null,
      checks: payload.checks,
      waitedMs: payload.waitedMs
    };
  }

  // Compact, response-friendly view of a verifyHopxSubmitCleared result: keep the
  // verdict, the reason, and how many Enters it had to re-send; drop the bulky
  // raw composer dump (callers that want it can read the composer directly).
  summarizeSubmitVerification(v) {
    if (!v || typeof v !== 'object') return null;
    return {
      applied: v.applied === true,
      verified: v.verified === true,
      reason: v.reason || null,
      resends: Number.isInteger(v.resends) ? v.resends : 0
    };
  }

  async readHopxUiSnapshot(terminalId, uiMaxLines, rawTailMaxEvents, includeRawTail = false) {
    const uiRead = await this.handleReadTerminal({
      terminal_id: terminalId,
      mode: 'ui',
      start_from: 'latest',
      uiMaxLines,
      includeRawTail,
      rawTailMaxEvents
    });
    if (uiRead.isError) return { errorResponse: uiRead };
    const parsedUi = this.parseToolJsonResponse(uiRead, 'hop_read_terminal');
    if (!parsedUi.ok) {
      return {
        errorResponse: { content: [{ type: 'text', text: `Error: ${parsedUi.error}` }], isError: true }
      };
    }
    return { payload: parsedUi.payload };
  }

  async waitForHopxUiNotBusy(args) {
    const requestedTerminalId = typeof args.terminal_id === 'string' ? args.terminal_id : '';
    if (!requestedTerminalId) {
      return {
        errorResponse: { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true }
      };
    }

    // Deterministic turn-end via the Claude Stop hook (scripts/claude-session-hook.js):
    // when a turn counter is in use for this session it is AUTHORITATIVE. The agent
    // is done iff the count advanced past the baseline captured at send time; until
    // then we keep waiting regardless of the busy-line heuristic (which can read a
    // paused agent as idle). With no marker we fall back to the busy-line scrape.
    const turnInternalName = typeof args.turnInternalName === 'string' && args.turnInternalName
      ? args.turnInternalName
      : null;
    const baselineProvided = Number.isInteger(args.baselineTurnCount);
    const baseline = baselineProvided ? args.baselineTurnCount : 0;

    // Settle: on the heuristic path one idle read can be a lull between an agent's
    // bursts. Require N consecutive idle reads before calling it done. The marker
    // path is exact and needs no settle.
    const settleChecks = Number.isInteger(args.settle_checks)
      ? Math.max(1, args.settle_checks)
      : DEFAULT_HOPX_UI_SETTLE_CHECKS;

    const streamTerminalId = this.resolveTerminalAlias(requestedTerminalId);
    const composerSummary = () => {
      const c = this.streamManager.getComposerState(streamTerminalId);
      if (!c) return null;
      return { found: c.found === true, isEmpty: c.isEmpty === true, strategy: c.strategy || null };
    };

    const startedAt = Date.now();
    const maxWaitMsInput = Number.isFinite(args.max_wait_ms)
      ? Math.max(0, Math.floor(args.max_wait_ms))
      : DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS;
    const guardMaxWaitMs = Math.min(maxWaitMsInput, DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS);
    let checks = 0;
    let lastBusyLine = null;
    let lastOutput = null;
    let consecutiveIdle = 0;
    let lastComposer = null;

    while (true) {
      // Authoritative path: the turn counter advanced → the turn is done.
      let markerActive = false;
      if (turnInternalName) {
        const current = this.readTurnCount(turnInternalName);
        markerActive = current !== null || baselineProvided;
        if (current !== null && current > baseline) {
          const snap = await this.readHopxUiSnapshot(
            requestedTerminalId, args.uiMaxLines, args.rawTailMaxEvents, false
          );
          const out = snap.errorResponse ? lastOutput : snap.payload;
          return {
            payload: {
              applied: true, state: 'done', busy: false, busyLine: null, turnDone: true,
              settledIdle: consecutiveIdle, composer: composerSummary(),
              checks: checks + 1, waitedMs: Date.now() - startedAt, output: out || lastOutput
            }
          };
        }
      }

      const uiOutcome = await this.readHopxUiSnapshot(
        requestedTerminalId,
        args.uiMaxLines,
        args.rawTailMaxEvents,
        false
      );
      if (uiOutcome.errorResponse) return uiOutcome;
      const uiPayload = uiOutcome.payload;
      lastOutput = uiPayload;
      checks += 1;
      const busyLine = extractUiBusyLine(uiPayload);
      lastComposer = composerSummary();
      // "Not busy" ends the wait only when the marker is NOT the source of truth.
      // When a marker is active we ignore an idle-looking screen and keep waiting
      // for the counter to advance (or for the guard budget to expire).
      if (!markerActive) {
        if (!busyLine) {
          consecutiveIdle += 1;
          // Settle confirmed: idle held across N consecutive reads → done.
          if (consecutiveIdle >= settleChecks) {
            return {
              payload: {
                applied: true,
                state: 'done',
                busy: false,
                busyLine: null,
                turnDone: false,
                settledIdle: consecutiveIdle,
                composer: lastComposer,
                checks,
                waitedMs: Date.now() - startedAt,
                output: uiPayload
              }
            };
          }
        } else {
          consecutiveIdle = 0;
        }
      }
      if (busyLine) lastBusyLine = busyLine;

      if (guardMaxWaitMs <= 0 || (Date.now() - startedAt) >= guardMaxWaitMs) {
        // Three-state verdict at timeout. The marker (when active) is authoritative
        // that the turn is NOT done → busy. Otherwise read the heuristic: a busy
        // line right now means busy; pure-idle-but-under-settle leans done; a
        // busy→idle flap we couldn't confirm is unknown.
        let state;
        let busy;
        if (markerActive) {
          state = 'busy';
          busy = true;
        } else if (consecutiveIdle >= 1 && !lastBusyLine) {
          state = 'done';
          busy = false;
        } else if (consecutiveIdle === 0 && lastBusyLine) {
          state = 'busy';
          busy = true;
        } else {
          state = 'unknown';
          busy = Boolean(lastBusyLine);
        }
        return {
          payload: {
            applied: true,
            state,
            busy,
            busyLine: lastBusyLine,
            turnDone: false,
            settledIdle: consecutiveIdle,
            composer: lastComposer,
            checks,
            waitedMs: Date.now() - startedAt,
            output: lastOutput
          }
        };
      }

      await new Promise((resolve) => setTimeout(resolve, DEFAULT_HOPX_UI_BUSY_GUARD_POLL_MS));
    }
  }

  // ── Fleet helpers for manager agents ──
  // hopx layering: these are convenience tools composed from the atomic hop_
  // primitives (session list, wait registry, terminal create/write/wait).

  // One-call fleet status: join /api/sessions with the local Stop-hook turn
  // counters and this MCP's wait-job registry. state is deliberately simple —
  // "busy" means WE are driving a turn there (a live wait job); everything
  // else derives from diffing turnCount/bellSeq/lastActivityAt across calls.
  async handleAgentsOverview(args = {}) {
    // Settle any orphaned pending tasks first so state reflects reality even
    // after a manager restart (ledger survives; wait jobs do not).
    await this.reconcileLedger().catch(() => {});
    const ledgerBySession = new Map();
    for (const t of this.listLedgerTasks()) {
      const key = t.internalName || t.sessionName;
      if (!key) continue;
      const rec = ledgerBySession.get(key) || { pending: 0, lastCompleted: null };
      if (t.status === 'pending') rec.pending += 1;
      else if (t.status === 'completed' && (!rec.lastCompleted || t.completedAt > rec.lastCompleted.completedAt)) {
        rec.lastCompleted = { taskId: t.taskId, replyMatched: t.replyMatched ?? null, completedAt: t.completedAt, task: t.task };
      }
      ledgerBySession.set(key, rec);
    }
    const listed = await this.callApi('GET', '/api/sessions');
    if (this.isApiFailurePayload(listed)) {
      return this.wrapApiResult(listed, { endpoint: '/api/sessions' });
    }
    const includeUser = args.include_user_sessions !== false;
    const includePorts = args.include_ports === true;
    const activeNames = new Set(Array.isArray(listed.active) ? listed.active : []);

    // Reverse-map known terminal handles and live wait jobs onto sessions.
    const handlesBySession = new Map();
    for (const [terminalId, handle] of this.terminalHandles.entries()) {
      const key = handle && (handle.internalName || handle.sessionName);
      if (key && !handlesBySession.has(key)) handlesBySession.set(key, terminalId);
    }
    const waitsByTerminal = new Map();
    for (const [waitId, job] of this.waitJobs.entries()) {
      if (job.done || !job.terminalId) continue;
      const list = waitsByTerminal.get(job.terminalId) || [];
      list.push(waitId);
      waitsByTerminal.set(job.terminalId, list);
    }

    const agents = [];
    for (const s of Array.isArray(listed.sessions) ? listed.sessions : []) {
      if (!s || typeof s !== 'object') continue;
      if (!includePorts && s.type === 'port') continue;
      const isAgentCreated = s.createdBy === 'agent';
      const isPermitted = s.agentPermitted === true;
      if (!isAgentCreated && !(includeUser && isPermitted)) continue;
      const internalName = s.internalName || s.name;
      const displayName = s.displayName || s.name;
      const live = s.live === true || activeNames.has(displayName);
      const terminalId = handlesBySession.get(internalName) || handlesBySession.get(displayName) || null;
      const pendingWaits = terminalId ? (waitsByTerminal.get(terminalId) || []) : [];
      const ledger = ledgerBySession.get(internalName) || ledgerBySession.get(displayName) || null;
      const ledgerPending = ledger ? ledger.pending : 0;
      const lastActivityAt = Number(s.lastActivityAt) || 0;
      const lastBellAt = Number(s.lastBellAt) || 0;
      // needs_input: we hold a terminal handle and can see the session is parked
      // on a human — either an un-submitted prompt sitting in the composer or a
      // bell that rang at/after the last output. Ranks above idle, below busy.
      let needsInputReason = null;
      if (live && pendingWaits.length === 0 && terminalId) {
        const composer = this.streamManager.getComposerState(terminalId);
        if (composer && composer.found && !composer.isEmpty) {
          needsInputReason = 'parked_composer';
        } else if (lastBellAt > 0 && lastBellAt >= lastActivityAt - 2000) {
          needsInputReason = 'recent_bell';
        }
      }
      agents.push({
        sessionName: displayName,
        internalName,
        // busy counts BOTH this process's live waits and ledger-pending tasks
        // dispatched by any manager (the ledger is cross-process truth).
        state: !live
          ? 'not_running'
          : ((pendingWaits.length > 0 || ledgerPending > 0) ? 'busy' : (needsInputReason ? 'needs_input' : 'idle')),
        createdBy: s.createdBy || 'user',
        agentPermitted: isPermitted,
        cwd: s.cwd || null,
        foregroundProcess: s.foregroundProcess || null,
        lastActivityAt,
        bellSeq: Number(s.bellSeq) || 0,
        lastBellAt,
        turnCount: this.readTurnCount(internalName),
        terminal_id: terminalId,
        needs_input_reason: needsInputReason,
        pending_waits: pendingWaits,
        tasks_pending: ledgerPending,
        last_completed_task: ledger ? ledger.lastCompleted : null
      });
    }
    // Most recently active first — the sessions a manager cares about float up.
    agents.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    return this.wrapJson({
      ok: true,
      helper: 'hopx_agents_overview',
      agentCount: agents.length,
      agents,
      hint: 'Diff bellSeq (attention) and turnCount (completed Claude turns) against your previous call to detect progress. busy = this MCP holds a live wait job for the terminal. needs_input = the terminal is parked on a human (un-submitted prompt in the composer, or a recent unanswered bell) — see needs_input_reason.'
    });
  }

  // ── Standing-manager wake ──────────────────────────────────────────────
  // Register this session's terminal as a manager; a background timer wakes it
  // when its dispatched workers complete, so it need not hold a turn open on
  // hopx_wait_any. Lives in the MCP process (respawns fresh — no host restart);
  // a future step can migrate the watcher into the daemon so managers that are
  // fully disconnected still get woken.
  async handleManagerRegister(args = {}) {
    const enable = args.enabled !== false;
    if (!enable) {
      this.stopManagerWatch();
      return this.wrapJson({ ok: true, helper: 'hopx_manager_register', watching: false });
    }
    const terminalId = typeof args.terminal_id === 'string' && args.terminal_id ? args.terminal_id : null;
    if (!terminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required (this manager session\'s own terminal).' }], isError: true };
    }
    this.stopManagerWatch();
    this.managerWatch = { terminalId, woken: new Set(), ticking: false };
    // The manager's own terminal is usually created by a DIFFERENT process (the
    // harness that spawned the manager), so this process has no stream for it —
    // and getComposerState (the wake's idle gate) would return unavailable and
    // never fire. Prewarm a stream for the manager's own terminal so the watcher
    // can actually read its composer.
    await this.prewarmTerminalStream(terminalId).catch(() => {});
    const pollMs = MANAGER_WAKE_POLL_MS;
    this.managerWatch.timer = setInterval(() => { this.managerWatchTick().catch(() => {}); }, pollMs);
    if (this.managerWatch.timer.unref) this.managerWatch.timer.unref();
    return this.wrapJson({
      ok: true, helper: 'hopx_manager_register', watching: true,
      terminal_id: terminalId, poll_ms: pollMs,
      hint: 'You will be woken with a prompt when a task you dispatch (async, ledger-tracked) completes and your composer is idle. You can now dispatch async and end your turn.'
    });
  }

  stopManagerWatch() {
    if (this.managerWatch && this.managerWatch.timer) {
      clearInterval(this.managerWatch.timer);
    }
    this.managerWatch = null;
  }

  async managerWatchTick() {
    const watch = this.managerWatch;
    if (!watch || watch.ticking) return;
    watch.ticking = true;
    try {
      await this.reconcileLedger().catch(() => {});
      const mgrTid = watch.terminalId;
      const fresh = this.listLedgerTasks().filter((t) =>
        (t.status === 'completed' || t.status === 'failed')
        && t.managerTerminalId === mgrTid
        && !watch.woken.has(t.taskId));
      if (!fresh.length) return;
      if (process.env.HOP_WAKE_DEBUG === '1') console.error(`[wake] ${fresh.length} completed task(s) for manager ${mgrTid}`);
      // Never interrupt a manager that is mid-work: skip if it holds a live wait
      // job, or its composer is absent/non-empty (spinner up, or typing).
      const managerBusy = [...this.waitJobs.values()].some((j) => !j.done && j.terminalId === mgrTid);
      if (managerBusy) return;
      let composer = null;
      try { composer = this.streamManager.getComposerState(mgrTid); } catch { composer = null; }
      // No stream for the manager's own terminal (dropped, or never warmed) →
      // prewarm and skip this tick; the next tick reads a live composer.
      if (!composer || composer.available === false) {
        await this.prewarmTerminalStream(mgrTid).catch(() => {});
        return;
      }
      if (!composer.found || composer.isEmpty !== true) return;
      // Claim these tasks before writing so a slow submit can't double-fire.
      for (const t of fresh) watch.woken.add(t.taskId);
      const names = fresh.map((t) => t.sessionName || t.internalName || t.taskId).join(', ');
      const verb = fresh.length === 1 ? 'task' : 'tasks';
      const msg = `[hop wake] ${fresh.length} dispatched ${verb} completed: ${names}. Review with hopx_task_ledger, verify/merge, then dispatch the next work or acknowledge.`;
      try {
        // Inject the wake through the same proven dispatch path workers use
        // (handleHopxAgentTurn), NOT a bare write: it actively drains the stream
        // so its verified-submit sees a FRESH screen and re-sends a swallowed
        // Enter. A bare write leaves the virtualScreen stale, so a parked prompt
        // is never detected and the manager is never actually woken. async so
        // the tick returns promptly; _skipLedger so the wake is not itself a task.
        const dispatch = await this.handleHopxAgentTurn({
          terminal_id: mgrTid, data: msg, async: true, _skipLedger: true
        });
        const failed = dispatch && dispatch.isError;
        if (failed) throw new Error('wake dispatch failed');
        // The async dispatch types the message and does an inline verified-submit
        // — but for a long-idle manager that check can run before the message
        // renders, so a swallowed Enter is missed and the prompt parks. Re-confirm
        // with patience: wait for the composer to hold our text, then press Enter
        // until it clears. This is what actually makes the wake reliable.
        let submitted = false;
        for (let k = 0; k < 6; k++) {
          await new Promise((r) => setTimeout(r, 800));
          await this.streamManager.flushVirtualScreen(mgrTid);
          const c = this.streamManager.getComposerState(mgrTid);
          if (!c || !c.found) { submitted = true; break; }
          if (c.isEmpty === true) { submitted = true; break; }
          // Our wake text is parked in the composer → the Enter was swallowed.
          await this.handleSendAndWait({ terminal_id: mgrTid, key: 'enter', wait: false });
        }
        if (process.env.HOP_WAKE_DEBUG === '1') {
          console.error(`[wake] dispatched+confirmed: submitted=${submitted}`);
        }
      } catch {
        // Dispatch failed (terminal gone?) — unclaim so a later tick can retry.
        for (const t of fresh) watch.woken.delete(t.taskId);
      }
    } finally {
      watch.ticking = false;
    }
  }

  async handleTaskLedger(args = {}) {
    const acknowledged = [];
    if (Array.isArray(args.acknowledge)) {
      for (const id of args.acknowledge) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(id)) continue;
        try {
          fs.rmSync(path.join(this.ledgerDir(), `${id}.json`));
          acknowledged.push(id);
        } catch { /* already gone */ }
      }
    }
    const reconciled = await this.reconcileLedger().catch(() => 0);
    const statusFilter = typeof args.status === 'string' && args.status !== 'all' ? args.status : null;
    const sessionFilter = typeof args.session === 'string' && args.session ? args.session : null;
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 50;
    let tasks = this.listLedgerTasks();
    if (statusFilter) tasks = tasks.filter((t) => t.status === statusFilter);
    if (sessionFilter) tasks = tasks.filter((t) => t.internalName === sessionFilter || t.sessionName === sessionFilter);
    const total = tasks.length;
    tasks = tasks.slice(0, limit);
    return this.wrapJson({
      ok: true,
      helper: 'hopx_task_ledger',
      reconciled_now: reconciled,
      acknowledged,
      taskCount: total,
      tasks,
      hint: 'pending = dispatched but turn not yet finished (or manager died mid-watch — reconciliation settles it once the turn counter advances). Re-arm watches with hopx_wait_any(terminal_ids=[...]) after a restart; acknowledge consumed entries to keep the ledger small.'
    });
  }

  // Race several wait jobs: first completion (or timeout) returns control to
  // the manager, with the still-pending set so the next call can re-arm.
  async handleWaitAny(args = {}) {
    const waitIds = [];
    const seen = new Set();
    const pushId = (id) => {
      if (typeof id === 'string' && id.trim() && !seen.has(id.trim())) {
        seen.add(id.trim());
        waitIds.push(id.trim());
      }
    };
    for (const id of Array.isArray(args.wait_ids) ? args.wait_ids : []) pushId(id);

    const unknown = waitIds.filter((id) => !this.waitJobs.has(id));
    if (unknown.length > 0) {
      return {
        content: [{ type: 'text', text: `Error: wait job(s) not found: ${unknown.join(', ')}. They may be stale after daemon or MCP restart.` }],
        isError: true
      };
    }

    // Terminals: reuse a live wait job when one exists, else start an
    // until_agent_done wait so "watch these terminals" is a single call.
    const started = [];
    for (const terminalId of Array.isArray(args.terminal_ids) ? args.terminal_ids : []) {
      if (typeof terminalId !== 'string' || !terminalId.trim()) continue;
      const existing = [...this.waitJobs.values()].find((job) => !job.done && job.terminalId === terminalId);
      if (existing) {
        pushId(existing.waitId);
        continue;
      }
      const job = this.startWaitJob(
        { terminal_id: terminalId, until_agent_done: true, capture: 'readable_raw', start_from: 'latest' },
        { terminal_id: terminalId, startedBy: 'hopx_wait_any' }
      );
      started.push(job.waitId);
      pushId(job.waitId);
    }

    if (waitIds.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: provide wait_ids and/or terminal_ids to wait on.' }],
        isError: true
      };
    }

    let jobs = waitIds.map((id) => this.waitJobs.get(id));
    const maxWaitMs = Number.isFinite(args.max_wait_ms)
      ? Math.max(1, Math.floor(args.max_wait_ms))
      : DEFAULT_WAIT_POLL_MAX_MS;
    const rearmTimedOut = args.rearm_timed_out !== false;
    const includeResults = args.include_results !== false;
    const deadline = Date.now() + maxWaitMs;
    const rearmed = [];

    // A watch that merely EXPIRED is not a finished turn. By default such
    // jobs are re-armed in place (fresh wait, same args) and stay pending —
    // otherwise a manager mistakes "watch timed out" for "agent done", nudges
    // a busy agent, and tears down a working fleet.
    const partition = () => {
      const completed = [];
      const stillPending = [];
      const next = [];
      for (const job of jobs) {
        if (job.done && rearmTimedOut && job.status === 'timed_out' && job.argsSnapshot && job.terminalId) {
          const fresh = this.startWaitJob({ ...job.argsSnapshot }, {
            ...(job.metadata || {}),
            terminal_id: job.terminalId,
            rearmedFrom: job.waitId
          });
          this.waitJobs.delete(job.waitId);
          rearmed.push({ from: job.waitId, wait_id: fresh.waitId, terminal_id: fresh.terminalId });
          next.push(fresh);
          stillPending.push(fresh);
          continue;
        }
        next.push(job);
        if (job.done) completed.push(job);
        else stillPending.push(job);
      }
      jobs = next;
      return { completed, stillPending };
    };

    let { completed: completedJobs, stillPending } = partition();
    while (completedJobs.length === 0 && stillPending.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        Promise.race(stillPending.map((job) => job.promise)),
        new Promise((resolve) => setTimeout(resolve, remaining))
      ]);
      ({ completed: completedJobs, stillPending } = partition());
    }

    const completed = [];
    const pending = [];
    for (const job of jobs) {
      const summary = this.summarizeWaitJob(job);
      summary.terminal_id = job.terminalId || null;
      if (job.done) {
        if (job.status === 'error') summary.error = job.error || 'Unknown wait failure';
        if (includeResults && job.result) summary.result = slimWaitPayload(job.result, null);
        completed.push(summary);
        if (args.consume === true) this.waitJobs.delete(job.waitId);
      } else {
        if (job.metadata && job.metadata.rearmedFrom) summary.rearmed_from = job.metadata.rearmedFrom;
        pending.push(summary);
      }
    }
    return this.wrapJson({
      ok: true,
      helper: 'hopx_wait_any',
      completed,
      pending,
      started_waits: started,
      rearmed,
      timed_out: completed.length === 0,
      hint: rearmed.length > 0
        ? 'Some expired watches were re-armed with new wait_ids — use pending[].wait_id for the next hopx_wait_any call.'
        : undefined
    });
  }

  // One-call subagent bring-up: terminal + agent CLI + readiness (+ optional
  // first task dispatched as an async turn).
  async handleSpawnAgent(args = {}) {
    const preset = typeof args.agent === 'string' && args.agent ? args.agent : 'claude';
    const presetCommands = { claude: 'claude', codex: 'codex', gemini: 'gemini' };
    let command = typeof args.command === 'string' && args.command.trim() ? args.command.trim() : '';
    if (!command) {
      if (preset === 'custom') {
        return { content: [{ type: 'text', text: 'Error: agent="custom" requires command=...' }], isError: true };
      }
      command = presetCommands[preset];
      if (!command) {
        return { content: [{ type: 'text', text: `Error: unknown agent preset "${preset}". Use claude, codex, gemini, or custom with command=...` }], isError: true };
      }
    }
    if (typeof args.args === 'string' && args.args.trim()) {
      command += ` ${args.args.trim()}`;
    }

    // isolation:"worktree" — each worker gets its own git worktree + branch so
    // fleets can edit overlapping files without racing. Mechanism only: the
    // manager reviews/merges the branch and removes the worktree afterwards.
    let spawnCwd = args.cwd;
    let worktree = null;
    if (args.isolation === 'worktree') {
      if (!spawnCwd) {
        return { content: [{ type: 'text', text: 'Error: isolation="worktree" requires cwd (a path inside a git repo).' }], isError: true };
      }
      try {
        const repoRoot = execSync(`git -C ${JSON.stringify(spawnCwd)} rev-parse --show-toplevel`, { encoding: 'utf8' }).trim();
        const slug = `${(args.name || 'agent').replace(/[^A-Za-z0-9_-]/g, '-')}-${Date.now().toString(36)}`;
        const branch = `fleet/${slug}`;
        const wtPath = require('path').join(repoRoot, '.hop-worktrees', slug);
        execSync(`git -C ${JSON.stringify(repoRoot)} worktree add -b ${JSON.stringify(branch)} ${JSON.stringify(wtPath)}`, { encoding: 'utf8', stdio: 'pipe' });
        spawnCwd = wtPath;
        worktree = { path: wtPath, branch, repoRoot };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: worktree isolation failed: ${err && err.stderr ? String(err.stderr).trim() : (err instanceof Error ? err.message : String(err))}` }],
          isError: true
        };
      }
    }

    const created = await this.callApi('POST', '/api/terminals', {
      name: args.name,
      cwd: spawnCwd,
      cols: args.cols,
      rows: args.rows
    });
    if (this.isApiFailurePayload(created) || !created.id) {
      return this.wrapApiResult(created, { endpoint: '/api/terminals' });
    }
    const terminalId = created.id;
    await this.prewarmTerminalStream(terminalId, {
      cols: args.cols,
      rows: args.rows,
      waitForOutputMs: CREATE_TERMINAL_OUTPUT_WARMUP_MS
    });
    this.rememberTerminalHandleFromPayload(created, {
      displayName: args.name,
      cols: args.cols,
      rows: args.rows
    });

    const launchData = `${command}\n`;
    this.streamManager.noteTerminalInput(terminalId, launchData);
    const launch = await this.callTerminalEndpointWithRecovery(
      terminalId,
      'POST',
      (id) => `/api/terminals/${encodeURIComponent(id)}/write`,
      { data: launchData }
    );
    if (this.isApiFailurePayload(launch.payload)) {
      return this.wrapApiResult(launch.payload, { endpoint: launch.endpoint });
    }

    const readyTimeoutMs = Number.isFinite(args.ready_timeout_ms)
      ? Math.max(1000, Math.floor(args.ready_timeout_ms))
      : 60000;
    // Readiness = the CLI painted and went quiet. Launching is not a turn (no
    // Stop-hook bump), so until_agent_done would hang against the turn-counter
    // gate for hook-recorded sessions; a plain idle window is the right signal.
    const readiness = await this.runWaitTerminal(
      {
        terminal_id: terminalId,
        until_agent_done: false,
        idle_ms: 3000,
        start_from: 'latest',
        max_wait_ms: readyTimeoutMs,
        capture: 'readable_raw',
        capture_max_events: 0
      },
      { isAborted: () => false }
    );
    let ready = !readiness.errorResponse
      && readiness.payload
      && readiness.payload.status !== 'timed_out';

    // Idle alone is a false-positive for TUI agents: a freshly launched Claude
    // Code (or codex/gemini) paints its welcome banner — and lately a dated
    // promotional interstitial — then falls quiet for the idle window while the
    // composer is not yet accepting input. The first dispatched Enter then gets
    // swallowed by that transition and the task parks unsubmitted. So when we
    // expect a composer, require it to actually be present before declaring
    // ready: poll getComposerState (which finds the box or the bare `❯` prompt
    // line) up to a bounded window, then give it a beat to settle so the first
    // keystroke isn't racing a final repaint. Plain shells (agent="custom")
    // have no composer and keep the idle-only signal.
    const TUI_PRESETS = new Set(['claude', 'codex', 'gemini']);
    let composerReady = null;
    if (ready && TUI_PRESETS.has(preset)) {
      const composerDeadline = Date.now() + Math.min(readyTimeoutMs, 20000);
      composerReady = false;
      while (Date.now() < composerDeadline) {
        let c = null;
        try { c = this.streamManager.getComposerState(terminalId); } catch { c = null; }
        if (c && c.found) { composerReady = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      ready = composerReady;
      if (composerReady) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const result = {
      ok: true,
      helper: 'hopx_spawn_agent',
      worktree,
      terminal_id: terminalId,
      sessionName: created.sessionName || created.displayName || args.name || null,
      internalName: created.sessionName || null,
      command,
      ready,
      readiness_status: readiness.errorResponse
        ? 'error'
        : (composerReady === false ? 'composer_not_ready' : ((readiness.payload && readiness.payload.status) || 'unknown'))
    };
    if (composerReady !== null) {
      result.composer_ready = composerReady;
    }
    if (!ready) {
      result.hint = composerReady === false
        ? 'Agent CLI painted but its input composer never became available within ready_timeout_ms — inspect with hop_read_terminal(mode="ui") before dispatching; the first keystroke may be swallowed.'
        : 'Agent CLI not confirmed ready within ready_timeout_ms — inspect with hop_read_terminal before dispatching work.';
    }

    if (ready && typeof args.initial_task === 'string' && args.initial_task.length > 0) {
      const dispatch = await this.handleHopxAgentTurn({
        terminal_id: terminalId,
        data: args.initial_task,
        async: true
      });
      if (!dispatch.isError && dispatch.content && dispatch.content[0] && typeof dispatch.content[0].text === 'string') {
        try {
          const parsed = JSON.parse(dispatch.content[0].text);
          if (parsed && typeof parsed.wait_id === 'string') {
            result.wait_id = parsed.wait_id;
            result.dispatched = true;
          }
        } catch {
          /* leave dispatch details out; the task may still be running */
        }
      }
      if (!result.wait_id) {
        result.dispatched = false;
        result.hint = 'initial_task dispatch did not return a wait_id — check the terminal with hopx_agent_turn(control="wait").';
      }
    }

    return this.wrapJson(result);
  }

  async handleHopxAgentTurn(args) {
    const requestedTerminalId = typeof args.terminal_id === 'string' ? args.terminal_id : '';
    const waitId = typeof args.wait_id === 'string' ? args.wait_id.trim() : '';
    if (!requestedTerminalId && !waitId) {
      return {
        content: [{ type: 'text', text: 'Error: provide terminal_id (to start a turn) or wait_id (to continue/poll/control an async turn).' }],
        isError: true
      };
    }

    const data = typeof args.data === 'string'
      ? args.data
      : (typeof args.message === 'string' ? args.message : '');
    const key = typeof args.key === 'string' ? args.key : '';
    const pressEnter = args.press_enter === true || (args.press_enter === undefined && data.length > 0);
    const shouldWait = args.wait !== false;
    const shouldAsync = args.async === true && shouldWait;
    const hasInputAction = Boolean(data || key || pressEnter);
    const controlMode = this.getHopxControlMode(args, hasInputAction);
    if (args.until_reply_regex !== undefined && args.until_reply_regex !== null) {
      if (typeof args.until_reply_regex !== 'string') {
        return { content: [{ type: 'text', text: 'Error: until_reply_regex must be a string (regex source).' }], isError: true };
      }
      try {
        new RegExp(args.until_reply_regex, 'i');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: invalid until_reply_regex: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true
        };
      }
    }
    const captureMaxEventsProvided = args.capture_max_events !== undefined && args.capture_max_events !== null;
    const selectedModeInput = normalizeHopxTurnMode(args.mode);
    if (!selectedModeInput) {
      return {
        content: [{ type: 'text', text: `Error: mode must be one of "${HOPX_TURN_MODES.join('", "')}".` }],
        isError: true
      };
    }

    if (waitId) {
      const job = this.waitJobs.get(waitId);
      if (!job) {
        return {
          content: [{ type: 'text', text: `Error: wait job not found (${waitId}). It may be stale after daemon or MCP restart.` }],
          isError: true
        };
      }

      const terminalIdFromJob = job.metadata && typeof job.metadata.terminal_id === 'string'
        ? job.metadata.terminal_id
        : requestedTerminalId;

      if (controlMode === 'interrupt' || controlMode === 'terminate') {
        // Interrupting the turn also cancels its background wait, so the job is
        // reclaimed immediately instead of running on to its timeout.
        if (!job.done) job.aborted = true;
        const interruptOutcome = await this.sendHopxControlInput(
          terminalIdFromJob,
          this.getHopxInterruptKey(args),
          1
        );
        if (interruptOutcome.errorResponse) return interruptOutcome.errorResponse;
        if (controlMode === 'terminate' && typeof args.terminate_message === 'string' && args.terminate_message.length > 0) {
          const terminateSend = await this.handleSendAndWait({
            terminal_id: terminalIdFromJob,
            data: args.terminate_message,
            press_enter: true,
            wait: false
          });
          if (terminateSend.isError) return terminateSend;
        }
      }

      if (args.wait === true && !job.done) {
        const maxWaitMs = Number.isFinite(args.max_wait_ms)
          ? Math.max(1, Math.floor(args.max_wait_ms))
          : DEFAULT_WAIT_POLL_MAX_MS;
        await Promise.race([
          job.promise,
          new Promise((resolve) => setTimeout(resolve, maxWaitMs))
        ]);
      }

      return await this.formatHopxAsyncWaitResponse(job, { terminal_id: terminalIdFromJob });
    }

    if (!hasInputAction && controlMode === 'send') {
      return {
        content: [{ type: 'text', text: 'Error: provide at least one input action, or use control=\"wait\" for wait-only mode.' }],
        isError: true
      };
    }

    let terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);
    // Capture the session's turn counter BEFORE sending, so the wait below can
    // detect the Stop-hook bump that marks this turn's completion (authoritative
    // when the hook is installed; falls back to the busy-line heuristic otherwise).
    const turnHandle = this.getTerminalHandle(terminalId);
    const turnInternalName = turnHandle ? (turnHandle.internalName || turnHandle.sessionName || null) : null;
    const baselineTurnCount = this.readTurnCount(turnInternalName);
    let selectedMode = selectedModeInput;
    if (selectedMode === 'auto') {
      const flags = this.streamManager.getTerminalFlags(terminalId);
      selectedMode = flags.exists && flags.alternateScreen ? 'ui' : 'readable_raw';
    }
    const readableTextOnly = resolveHopxTextOnly(args.text_only, selectedMode);
    const includeUiRawTail = args.includeRawTail === true ? true : DEFAULT_HOPX_UI_INCLUDE_RAW_TAIL;

    let sendOnlyPayload = {
      cursorStart: this.streamManager.getLatestCursor(terminalId)
    };
    if (controlMode === 'interrupt' || controlMode === 'terminate') {
      const interruptOutcome = await this.sendHopxControlInput(
        requestedTerminalId,
        this.getHopxInterruptKey(args),
        1
      );
      if (interruptOutcome.errorResponse) return interruptOutcome.errorResponse;
      if (controlMode === 'terminate' && typeof args.terminate_message === 'string' && args.terminate_message.length > 0) {
        const terminateSend = await this.handleSendAndWait({
          terminal_id: requestedTerminalId,
          data: args.terminate_message,
          press_enter: true,
          wait: false
        });
        if (terminateSend.isError) return terminateSend;
        const parsedTerminateSend = this.parseToolJsonResponse(terminateSend, 'hopx_send_and_wait');
        if (!parsedTerminateSend.ok) {
          return { content: [{ type: 'text', text: `Error: ${parsedTerminateSend.error}` }], isError: true };
        }
      }
    } else if (hasInputAction && (selectedMode === 'ui' || shouldAsync)) {
      // Pre-send (then wait separately) only for paths that DON'T fall through to
      // the combined send+wait below: the ui branch and any async branch both
      // return before that final handleSendAndWait. Non-ui synchronous turns must
      // NOT pre-send here — the final handleSendAndWait does the send, so a
      // pre-send would run the input twice (double-send).
      const sendOnly = await this.handleSendAndWait({
        terminal_id: requestedTerminalId,
        data,
        press_enter: pressEnter,
        key,
        repeat: args.repeat,
        wait: false
      });
      if (sendOnly.isError) return sendOnly;

      const parsedSend = this.parseToolJsonResponse(sendOnly, 'hopx_send_and_wait');
      if (!parsedSend.ok) {
        return { content: [{ type: 'text', text: `Error: ${parsedSend.error}` }], isError: true };
      }
      sendOnlyPayload = parsedSend.payload;
    }

    // Verified submit: we just pressed Enter — confirm the composer actually
    // cleared (re-send Enter if it was swallowed). Runs in EVERY mode, not just
    // ui: claude normally runs inline (auto -> readable_raw), and an unverified
    // submit there can leave the prompt parked in the composer indefinitely.
    // Safe for plain shells — no composer box is found, so nothing is poked.
    let submitVerification = null;
    if (
      data
      && pressEnter
      && controlMode === 'send'
      && this.shouldVerifyHopxSubmit(args)
    ) {
      submitVerification = await this.verifyHopxSubmitCleared(
        requestedTerminalId,
        terminalId,
        data,
        { retries: args.verify_submit_retries, delayMs: args.verify_submit_delay_ms }
      );
    }

    if (selectedMode === 'ui') {
      let waitPayload = null;
      if (shouldWait) {
        const preSendCursor = Number.isFinite(sendOnlyPayload && sendOnlyPayload.cursorStart)
          ? Math.floor(sendOnlyPayload.cursorStart)
          : null;
        const waitStartFrom = (args.start_from !== undefined && args.start_from !== null)
          ? args.start_from
          : (preSendCursor === null ? undefined : 'cursor');
        const waitCursor = (args.cursor !== undefined && args.cursor !== null)
          ? args.cursor
          : (preSendCursor === null ? undefined : preSendCursor);
        const waitArgs = this.applyHopxWaitDefaults({
          terminal_id: requestedTerminalId,
          baselineTurnCount: baselineTurnCount === null ? undefined : baselineTurnCount,
          cursor: waitCursor,
          start_from: waitStartFrom,
          until_regex: args.until_regex,
          regex_flags: args.regex_flags,
          match_target: args.match_target,
          until_prompt: args.until_prompt,
          until_agent_done: args.until_agent_done,
          prompt_regex: args.prompt_regex,
          idle_ms: args.idle_ms,
          max_wait_ms: args.max_wait_ms,
          capture: 'readable_raw',
          capture_max_events: captureMaxEventsProvided
            ? args.capture_max_events
            : DEFAULT_HOPX_UI_WAIT_CAPTURE_MAX_EVENTS,
          maxControlOps: args.maxControlOps,
          includeRawData: args.includeRawData,
          includeMetaEvents: args.includeMetaEvents,
          control_level: args.control_level,
          noise_filter: args.noise_filter,
          coalesce_ms: args.coalesce_ms,
          coalesce_max_chars: args.coalesce_max_chars
        });
        if (shouldAsync) {
          const job = this.startWaitJob(waitArgs, {
            helper: 'hopx_agent_turn',
            terminal_id: requestedTerminalId,
            ledger: args._skipLedger !== true,
            task_summary: data ? data.slice(0, 200) : null,
            selected_mode: 'ui',
            text_only: false,
            uiMaxLines: args.uiMaxLines,
            rawTailMaxEvents: args.rawTailMaxEvents,
            includeUiRawTail,
            ...(typeof args.until_reply_regex === 'string' ? { until_reply_regex: args.until_reply_regex } : {})
          });
          return this.wrapJson({
            ...this.summarizeWaitJob(job),
            helper: 'hopx_agent_turn',
            terminal_id: requestedTerminalId
          });
        }
        const waited = await this.runWaitTerminal(waitArgs);
        if (waited.errorResponse) return waited.errorResponse;
        waitPayload = slimWaitPayload(waited.payload, null);
      }

      let outputPayload = null;
      const firstUiSnapshot = await this.readHopxUiSnapshot(
        requestedTerminalId,
        args.uiMaxLines,
        args.rawTailMaxEvents,
        includeUiRawTail
      );
      if (firstUiSnapshot.errorResponse) return firstUiSnapshot.errorResponse;
      outputPayload = firstUiSnapshot.payload;

      if (this.shouldApplyHopxUiBusyGuard(args, waitPayload)) {
        const guardOutcome = await this.waitForHopxUiNotBusy({
          terminal_id: requestedTerminalId,
          max_wait_ms: args.max_wait_ms,
          uiMaxLines: args.uiMaxLines,
          rawTailMaxEvents: args.rawTailMaxEvents,
          turnInternalName,
          baselineTurnCount: baselineTurnCount === null ? undefined : baselineTurnCount
        });
        if (guardOutcome.errorResponse) return guardOutcome.errorResponse;
        outputPayload = guardOutcome.payload.output || outputPayload;
        if (includeUiRawTail) {
          const finalUiSnapshot = await this.readHopxUiSnapshot(
            requestedTerminalId,
            args.uiMaxLines,
            args.rawTailMaxEvents,
            true
          );
          if (finalUiSnapshot.errorResponse) return finalUiSnapshot.errorResponse;
          outputPayload = finalUiSnapshot.payload;
        }
        if (waitPayload && typeof waitPayload === 'object') {
          waitPayload = {
            ...waitPayload,
            uiBusyGuard: this.summarizeUiBusyGuard(guardOutcome.payload)
          };
        }
      }

      return this.wrapJson({
        ok: true,
        helper: 'hopx_agent_turn',
        terminal_id: requestedTerminalId,
        wait: waitPayload,
        output: outputPayload,
        ...(submitVerification ? { submit: this.summarizeSubmitVerification(submitVerification) } : {})
      });
    }

    if (shouldAsync && shouldWait) {
      const waitArgs = this.applyHopxWaitDefaults({
        terminal_id: requestedTerminalId,
        baselineTurnCount: baselineTurnCount === null ? undefined : baselineTurnCount,
        capture: selectedMode,
        cursor: args.cursor,
        start_from: args.start_from,
        until_regex: args.until_regex,
        regex_flags: args.regex_flags,
        match_target: args.match_target,
        until_prompt: args.until_prompt,
        until_agent_done: args.until_agent_done,
        prompt_regex: args.prompt_regex,
        idle_ms: args.idle_ms,
        max_wait_ms: args.max_wait_ms,
        capture_max_events: args.capture_max_events,
        maxControlOps: args.maxControlOps,
        includeRawData: args.includeRawData,
        includeMetaEvents: args.includeMetaEvents,
        control_level: args.control_level,
        noise_filter: args.noise_filter,
        coalesce_ms: args.coalesce_ms,
        coalesce_max_chars: args.coalesce_max_chars
      });
      if (waitArgs.cursor === undefined && waitArgs.start_from === undefined) {
        const preSendCursor = Number.isFinite(sendOnlyPayload && sendOnlyPayload.cursorStart)
          ? Math.floor(sendOnlyPayload.cursorStart)
          : null;
        if (preSendCursor !== null) {
          waitArgs.start_from = 'cursor';
          waitArgs.cursor = preSendCursor;
        }
      }
      const job = this.startWaitJob(waitArgs, {
        helper: 'hopx_agent_turn',
        terminal_id: requestedTerminalId,
        ledger: args._skipLedger !== true,
        task_summary: data ? data.slice(0, 200) : null,
        selected_mode: selectedMode,
        text_only: readableTextOnly,
        ...(typeof args.until_reply_regex === 'string' ? { until_reply_regex: args.until_reply_regex } : {})
      });
      return this.wrapJson({
        ...this.summarizeWaitJob(job),
        helper: 'hopx_agent_turn',
        terminal_id: requestedTerminalId
      });
    }

    if ((controlMode === 'interrupt' || controlMode === 'terminate') && !shouldWait && !hasInputAction) {
      return this.wrapJson({
        ok: true,
        helper: 'hopx_agent_turn',
        terminal_id: requestedTerminalId,
        next_cursor: this.streamManager.getLatestCursor(terminalId)
      });
    }

    const sendAndWait = await this.handleSendAndWait({
      terminal_id: requestedTerminalId,
      data,
      press_enter: pressEnter,
      key,
      repeat: args.repeat,
      wait: shouldWait,
      capture: selectedMode,
      cursor: args.cursor,
      start_from: args.start_from,
      until_regex: args.until_regex,
      regex_flags: args.regex_flags,
      match_target: args.match_target,
      until_prompt: args.until_prompt,
      until_agent_done: args.until_agent_done,
      prompt_regex: args.prompt_regex,
      idle_ms: args.idle_ms,
      max_wait_ms: args.max_wait_ms,
      capture_max_events: args.capture_max_events,
      maxControlOps: args.maxControlOps,
      includeRawData: args.includeRawData,
      includeMetaEvents: args.includeMetaEvents,
      control_level: args.control_level,
      noise_filter: args.noise_filter,
      coalesce_ms: args.coalesce_ms,
      coalesce_max_chars: args.coalesce_max_chars,
      text_only: readableTextOnly,
      clean_text: args.clean_text
    });
    if (sendAndWait.isError) return sendAndWait;

    const parsedSendAndWait = this.parseToolJsonResponse(sendAndWait, 'hopx_send_and_wait');
    if (!parsedSendAndWait.ok) {
      return { content: [{ type: 'text', text: `Error: ${parsedSendAndWait.error}` }], isError: true };
    }

    const canAutoPromoteUi = (
      selectedModeInput === 'auto'
      && selectedMode === 'readable_raw'
      && shouldWait
    );
    if (canAutoPromoteUi) {
      terminalId = this.resolveTerminalAlias(requestedTerminalId);
      const postFlags = this.streamManager.getTerminalFlags(terminalId);
      if (postFlags.exists && postFlags.alternateScreen) {
        let outputPayload = null;
        const firstUiSnapshot = await this.readHopxUiSnapshot(
          requestedTerminalId,
          args.uiMaxLines,
          args.rawTailMaxEvents,
          includeUiRawTail
        );
        if (firstUiSnapshot.errorResponse) return firstUiSnapshot.errorResponse;
        outputPayload = firstUiSnapshot.payload;

        const promotedPayload = {
          ...parsedSendAndWait.payload,
          helper: 'hopx_agent_turn',
          auto_switched_to_ui: true,
          output: outputPayload
        };
        if (this.shouldApplyHopxUiBusyGuard(args, promotedPayload.wait)) {
          const guardOutcome = await this.waitForHopxUiNotBusy({
            terminal_id: requestedTerminalId,
            max_wait_ms: args.max_wait_ms,
            uiMaxLines: args.uiMaxLines,
            rawTailMaxEvents: args.rawTailMaxEvents
          });
          if (guardOutcome.errorResponse) return guardOutcome.errorResponse;
          outputPayload = guardOutcome.payload.output || outputPayload;
          if (includeUiRawTail) {
            const finalUiSnapshot = await this.readHopxUiSnapshot(
              requestedTerminalId,
              args.uiMaxLines,
              args.rawTailMaxEvents,
              true
            );
            if (finalUiSnapshot.errorResponse) return finalUiSnapshot.errorResponse;
            outputPayload = finalUiSnapshot.payload;
          }
          promotedPayload.output = outputPayload;
          if (promotedPayload.wait && typeof promotedPayload.wait === 'object') {
            promotedPayload.wait = {
              ...promotedPayload.wait,
              uiBusyGuard: this.summarizeUiBusyGuard(guardOutcome.payload)
            };
          }
        }
        if (
          !captureMaxEventsProvided
          && promotedPayload.wait
          && typeof promotedPayload.wait === 'object'
          && Array.isArray(promotedPayload.wait.events)
        ) {
          promotedPayload.wait = {
            ...promotedPayload.wait,
            eventCount: 0,
            events: []
          };
        }
        if (typeof args.until_reply_regex === 'string') {
          const transcriptReply = await this.readLastAssistantReplyText(turnInternalName);
          Object.assign(promotedPayload, evaluateReplyRegex(args.until_reply_regex, promotedPayload.wait, transcriptReply));
        }
        return this.wrapJson({
          ...promotedPayload
        });
      }
    }

    const finalPayload = {
      ...parsedSendAndWait.payload,
      helper: 'hopx_agent_turn'
    };
    if (typeof args.until_reply_regex === 'string') {
      const transcriptReply = await this.readLastAssistantReplyText(turnInternalName);
      Object.assign(finalPayload, evaluateReplyRegex(args.until_reply_regex, finalPayload.wait, transcriptReply));
    }

    return this.wrapJson(finalPayload);
  }

  async handleSendAndWait(args) {
    const requestedTerminalId = args.terminal_id;
    if (!requestedTerminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }

    const data = typeof args.data === 'string' ? args.data : '';
    const pressEnter = args.press_enter === true;
    const key = typeof args.key === 'string' ? args.key : '';
    const shouldWait = args.wait !== false;
    if (!data && !pressEnter && !key && !shouldWait) {
      return {
        content: [{ type: 'text', text: 'Error: provide at least one input action (data, press_enter=true, or key), or set wait=true for wait-only mode.' }],
        isError: true
      };
    }

    let terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);
    const cursorBeforeSend = this.streamManager.getLatestCursor(terminalId);
    const sent = [];

    const sendPayload = async (payload, source) => {
      if (typeof payload === 'string' && payload.length > 0) {
        this.streamManager.noteTerminalInput(terminalId, payload);
      }
      const call = await this.callTerminalEndpointWithRecovery(
        requestedTerminalId,
        'POST',
        (currentTerminalId) => `/api/terminals/${encodeURIComponent(currentTerminalId)}/write`,
        { data: payload }
      );
      terminalId = call.terminalId;
      if (this.isApiFailurePayload(call.payload)) {
        return { errorResponse: this.wrapApiResult(call.payload, { endpoint: call.endpoint }) };
      }
      sent.push({
        source,
        bytes: Buffer.byteLength(payload, 'utf8')
      });
      return { ok: true };
    };

    if (data) {
      const wrote = await sendPayload(data, 'data');
      if (wrote.errorResponse) return wrote.errorResponse;
    }

    if (pressEnter) {
      const entered = await sendPayload('\r', 'press_enter');
      if (entered.errorResponse) return entered.errorResponse;
    }

    if (key) {
      const mapped = resolveSendKeyInput(key, args.repeat);
      if (!mapped.ok) {
        return { content: [{ type: 'text', text: `Error: ${mapped.error}` }], isError: true };
      }
      const keyed = await sendPayload(mapped.data, `key:${normalizeSendKeyName(key)}`);
      if (keyed.errorResponse) return keyed.errorResponse;
    }

    if (!shouldWait) {
      const cursorEnd = this.streamManager.getLatestCursor(terminalId);
      return this.wrapJson({
        ok: true,
        terminal_id: requestedTerminalId,
        cursorStart: cursorBeforeSend,
        cursorEnd,
        next_cursor: cursorEnd
      });
    }

    const waitArgs = { ...args, terminal_id: requestedTerminalId };
    delete waitArgs.data;
    delete waitArgs.press_enter;
    delete waitArgs.key;
    delete waitArgs.repeat;
    delete waitArgs.wait;
    delete waitArgs.text_only;

    if (waitArgs.cursor === undefined && waitArgs.start_from === undefined) {
      waitArgs.start_from = 'cursor';
      waitArgs.cursor = cursorBeforeSend;
    }

    const waited = await this.runWaitTerminal(this.applyHopxWaitDefaults(waitArgs));
    if (waited.errorResponse) return waited.errorResponse;
    let waitPayload = waited.payload;
    const waitCaptureMode = waitPayload && typeof waitPayload.captureMode === 'string'
      ? String(waitPayload.captureMode).toLowerCase()
      : (typeof args.capture === 'string' ? String(args.capture).toLowerCase() : 'readable_raw');
    if (resolveHopxTextOnly(args.text_only, waitCaptureMode)) {
      waitPayload = condenseReadableWaitPayload(waitPayload);
    }
    // Slim the wait payload: strip echo-of-input fields and optionally strip echoed command line
    const sentDataStr = (data && pressEnter) ? data : null;
    waitPayload = slimWaitPayload(waitPayload, sentDataStr);

    // Strip ANSI escape codes if clean_text requested
    if (args.clean_text === true && typeof waitPayload.text === 'string') {
      waitPayload.text = stripAnsi(waitPayload.text);
    }

    return this.wrapJson({
      ok: true,
      terminal_id: requestedTerminalId,
      wait: waitPayload
    });
  }

  /**
   * hopx_exec: Bash-tool semantics on a persistent terminal.
   * Send command → wait for prompt → return clean stdout (echo stripped, ANSI stripped).
   */
  async handleExec(args) {
    const requestedTerminalId = args.terminal_id;
    if (!requestedTerminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command) {
      return { content: [{ type: 'text', text: 'Error: command is required.' }], isError: true };
    }

    const timeoutMs = typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
      ? Math.max(1000, args.timeout_ms)
      : DEFAULT_WAIT_MAX_MS;

    let terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);
    const cursorBeforeSend = this.streamManager.getLatestCursor(terminalId);

    // Append a sentinel that prints the command's exit status so we can report
    // a real exit_code (POSIX-ish shells). If the sentinel never shows up
    // (timeout, exotic shell), we degrade to exit_code: null.
    const rcNonce = randomUUID().slice(0, 8);
    const rcPrefix = `__HOPX_RC_${rcNonce}=`;
    // Trim trailing semicolons/whitespace so `cmd;` doesn't become `cmd;;`,
    // and join with a space after a trailing `&` (`cmd &; ...` is a syntax error).
    const commandBody = command.replace(/[\s;]+$/, '');
    const joiner = /&$/.test(commandBody) ? ' ' : '; ';
    const wrappedCommand = `${commandBody}${joiner}printf '\\n${rcPrefix}%d\\n' "$?"`;

    // Send the command + Enter
    this.streamManager.noteTerminalInput(terminalId, wrappedCommand);
    const sendResult = await this.callTerminalEndpointWithRecovery(
      requestedTerminalId,
      'POST',
      (tid) => `/api/terminals/${encodeURIComponent(tid)}/write`,
      { data: wrappedCommand + '\r' }
    );
    terminalId = sendResult.terminalId;
    if (this.isApiFailurePayload(sendResult.payload)) {
      return this.wrapApiResult(sendResult.payload, { endpoint: sendResult.endpoint });
    }

    // Build wait args: wait for prompt (primary) or idle (fallback)
    const waitArgs = {
      terminal_id: requestedTerminalId,
      start_from: 'cursor',
      cursor: cursorBeforeSend,
      until_prompt: true,
      capture: 'readable_raw',
      capture_max_events: DEFAULT_HOPX_WAIT_CAPTURE_MAX_EVENTS,
      max_wait_ms: timeoutMs,
      control_level: 'none',
      noise_filter: 'balanced',
      coalesce_ms: DEFAULT_HOPX_READABLE_COALESCE_MS
    };

    // Custom prompt regex
    if (typeof args.prompt_regex === 'string' && args.prompt_regex.length > 0) {
      waitArgs.prompt_regex = args.prompt_regex;
    }

    // Idle fallback (if provided, use both prompt + idle whichever fires first)
    if (typeof args.idle_ms === 'number' && Number.isFinite(args.idle_ms)) {
      waitArgs.idle_ms = args.idle_ms;
    }

    const waited = await this.runWaitTerminal(this.applyHopxWaitDefaults(waitArgs));
    if (waited.errorResponse) return waited.errorResponse;

    // How the wait ended ('prompt' | 'agent_done' | 'regex' | 'idle' | null);
    // only a prompt/agent-done return means a fresh shell prompt is at the tail.
    const matchKind = waited.payload && typeof waited.payload === 'object'
      ? waited.payload.matched
      : null;

    // Condense to single text blob
    let waitPayload = condenseReadableWaitPayload(waited.payload);
    // Strip echo and slim
    waitPayload = slimWaitPayload(waitPayload, wrappedCommand);

    // Get clean text: strip ANSI, trim
    let stdout = typeof waitPayload.text === 'string' ? waitPayload.text : '';
    stdout = stripAnsi(stdout);

    // Extract the exit-code sentinel and drop its line(s) from stdout.
    let exitCode = null;
    const rcLineRe = new RegExp(`^${rcPrefix}(\\d+)$`);
    const lines = stdout.split('\n').filter((line) => {
      const m = rcLineRe.exec(line.trim());
      if (m) {
        exitCode = parseInt(m[1], 10);
        return false;
      }
      return true;
    });
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    // Remove only the single trailing shell prompt line, and only when the wait
    // actually returned to a prompt. Greedily popping every line that ends in
    // %/$/>/# would eat real output (e.g. "Download complete: 100%").
    if ((matchKind === 'prompt' || matchKind === 'agent_done')
        && lines.length > 0
        && isLikelyPrompt(lines[lines.length - 1])) {
      lines.pop();
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
    }
    stdout = lines.join('\n').trimEnd();

    const timedOut = waitPayload.status === 'timed_out';
    // ok = the shell prompt returned within the timeout. It does NOT mean the
    // command succeeded; exit_code carries the command's real status (null if
    // the sentinel was never observed, e.g. timeout or non-POSIX shell).
    const result = {
      ok: !timedOut,
      terminal_id: requestedTerminalId,
      exit_code: exitCode,
      stdout
    };
    if (timedOut) {
      result.timed_out = true;
    }
    if (waitPayload.next_cursor !== undefined) {
      result.next_cursor = waitPayload.next_cursor;
    }

    return this.wrapJson(result);
  }

  async runWaitTerminal(args, options = {}) {
    const isAborted = typeof options.isAborted === 'function' ? options.isAborted : null;
    const requestedTerminalId = args.terminal_id;
    if (!requestedTerminalId) {
      return { errorResponse: { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true } };
    }

    const captureMode = typeof args.capture === 'string'
      ? String(args.capture).toLowerCase()
      : 'readable_raw';
    if (captureMode !== 'raw' && captureMode !== 'readable_raw') {
      return { errorResponse: { content: [{ type: 'text', text: 'Error: capture must be "raw" or "readable_raw".' }], isError: true } };
    }

    const matchTarget = typeof args.match_target === 'string'
      ? String(args.match_target).toLowerCase()
      : DEFAULT_WAIT_MATCH_TARGET;
    if (!WAIT_MATCH_TARGETS.includes(matchTarget)) {
      return { errorResponse: { content: [{ type: 'text', text: `Error: match_target must be one of "${WAIT_MATCH_TARGETS.join('", "')}".` }], isError: true } };
    }

    const untilRegexPattern = typeof args.until_regex === 'string' && args.until_regex.length > 0
      ? args.until_regex
      : null;
    const untilPrompt = args.until_prompt === true;
    const untilAgentDoneRequested = args.until_agent_done === true;
    const idleWasProvided = args.idle_ms !== undefined && args.idle_ms !== null;
    const idleMs = Number.isFinite(args.idle_ms)
      ? Math.max(1, Math.floor(args.idle_ms))
      : null;
    let untilAgentDone = untilAgentDoneRequested;

    if (!untilRegexPattern && !untilPrompt && idleMs === null && args.until_agent_done === undefined) {
      untilAgentDone = true;
    }

    if (!untilRegexPattern && !untilPrompt && idleMs === null && !untilAgentDone) {
      return {
        errorResponse: {
          content: [{ type: 'text', text: 'Error: Provide at least one wait condition: until_regex, until_prompt, idle_ms, or until_agent_done.' }],
          isError: true
        }
      };
    }

    let untilRegex = null;
    if (untilRegexPattern) {
      const compiled = compileRegex(untilRegexPattern, args.regex_flags, 'm');
      if (!compiled.ok) {
        return { errorResponse: { content: [{ type: 'text', text: `Error: Invalid until_regex (${compiled.error})` }], isError: true } };
      }
      untilRegex = compiled.regex;
    }

    let promptRegex = null;
    if (untilPrompt) {
      const promptPattern = typeof args.prompt_regex === 'string' && args.prompt_regex.length > 0
        ? args.prompt_regex
        : DEFAULT_WAIT_PROMPT_REGEX;
      const compiled = compileRegex(promptPattern, 'm', 'm');
      if (!compiled.ok) {
        return { errorResponse: { content: [{ type: 'text', text: `Error: Invalid prompt_regex (${compiled.error})` }], isError: true } };
      }
      promptRegex = compiled.regex;
    }

    const maxWaitMs = Number.isFinite(args.max_wait_ms)
      ? Math.max(1, Math.floor(args.max_wait_ms))
      : DEFAULT_WAIT_MAX_MS;
    const captureMaxEvents = Number.isFinite(args.capture_max_events)
      ? Math.max(0, Math.floor(args.capture_max_events))
      : DEFAULT_WAIT_CAPTURE_MAX_EVENTS;
    const maxControlOps = Number.isFinite(args.maxControlOps)
      ? Math.max(1, Math.floor(args.maxControlOps))
      : 200;
    const includeRawData = args.includeRawData === true;
    const includeMetaEvents = args.includeMetaEvents === true;
    let controlLevel = DEFAULT_READABLE_CONTROL_LEVEL;
    let noiseFilter = DEFAULT_READABLE_NOISE_FILTER;
    let coalesceMs = DEFAULT_READABLE_COALESCE_MS;
    let coalesceMaxChars = DEFAULT_READABLE_COALESCE_MAX_CHARS;
    if (captureMode === 'readable_raw') {
      controlLevel = normalizeReadableControlLevel(args.control_level);
      if (!controlLevel) {
        return {
          errorResponse: {
            content: [{ type: 'text', text: `Error: control_level must be one of "${READABLE_CONTROL_LEVELS.join('", "')}".` }],
            isError: true
          }
        };
      }
      noiseFilter = normalizeReadableNoiseFilter(args.noise_filter);
      if (!noiseFilter) {
        return {
          errorResponse: {
            content: [{ type: 'text', text: `Error: noise_filter must be one of "${READABLE_NOISE_FILTERS.join('", "')}".` }],
            isError: true
          }
        };
      }
      coalesceMs = normalizeReadableCoalesceMs(args.coalesce_ms);
      coalesceMaxChars = normalizeReadableCoalesceMaxChars(args.coalesce_max_chars);
    }

    const agentDoneIdleMs = untilAgentDone
      ? (idleMs !== null ? idleMs : DEFAULT_WAIT_AGENT_DONE_IDLE_MS)
      : null;
    const providedCursor = typeof args.cursor === 'number' ? Math.floor(args.cursor) : null;
    const startFrom = typeof args.start_from === 'string'
      ? String(args.start_from).toLowerCase()
      : null;
    if (startFrom && !WAIT_START_MODES.includes(startFrom)) {
      return { errorResponse: { content: [{ type: 'text', text: 'Error: start_from must be one of "latest", "cursor", or "beginning".' }], isError: true } };
    }

    let terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);
    const readyProbe = this.streamManager.readEvents(terminalId, this.streamManager.getLatestCursor(terminalId), 0, 1);
    if (this.isTerminalNotFoundStreamError(readyProbe.error)) {
      return {
        errorResponse: {
          content: [{ type: 'text', text: 'Error: terminal_id is stale or missing (likely daemon restart). Reattach or recreate terminal.' }],
          isError: true
        }
      };
    }

    let cursor = null;
    let startFromResolved = startFrom;
    if (!startFromResolved) {
      startFromResolved = providedCursor === null ? 'latest' : 'cursor';
    }

    if (startFromResolved === 'cursor') {
      if (providedCursor === null) {
        return { errorResponse: { content: [{ type: 'text', text: 'Error: start_from="cursor" requires cursor.' }], isError: true } };
      }
      cursor = providedCursor;
    } else if (startFromResolved === 'beginning') {
      cursor = this.streamManager.getBeginningCursor(terminalId);
    } else {
      cursor = this.streamManager.getLatestCursor(terminalId);
    }
    if (cursor === null) {
      cursor = this.streamManager.getLatestCursor(terminalId);
    }
    const cursorStart = cursor;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    let textWindow = '';
    const capturedEvents = [];
    let matched = null;
    let matchedText = null;
    let matchVia = null;
    let status = 'timed_out';
    let lastRead = null;
    let sawOutputLike = false;
    let recoveredInLoop = false;

    // Turn-counter marker for until_agent_done: authoritative when the Claude
    // hook has recorded this session. baseline from args when the caller
    // measured it pre-send (hopx_agent_turn does), else read now.
    const markerHandle = untilAgentDone ? this.getTerminalHandle(terminalId) : null;
    const markerName = markerHandle ? (markerHandle.internalName || markerHandle.sessionName || null) : null;
    const markerBaseline = Number.isFinite(args.baselineTurnCount)
      ? Math.floor(args.baselineTurnCount)
      : (markerName ? this.readTurnCount(markerName) : null);
    const markerExpected = Boolean(markerName && this.hasClaudeHookRecord(markerName));
    let markerTurnDone = false;

    while (true) {
      if (isAborted && isAborted()) {
        status = 'aborted';
        break;
      }
      const readResult = this.streamManager.readEvents(terminalId, cursor, 0, captureMaxEvents || 200);
      lastRead = readResult;
      if (this.isTerminalNotFoundStreamError(readResult.error)) {
        if (!recoveredInLoop) {
          const recoveredId = await this.recoverTerminalId(requestedTerminalId, terminalId);
          if (recoveredId && recoveredId !== terminalId) {
            terminalId = recoveredId;
            cursor = this.streamManager.getLatestCursor(terminalId);
            recoveredInLoop = true;
            continue;
          }
        }
        return {
          errorResponse: {
            content: [{ type: 'text', text: 'Error: terminal_id is stale or missing (likely daemon restart). Reattach or recreate terminal.' }],
            isError: true
          }
        };
      }
      if (readResult.records.length > 0) {
        cursor = readResult.cursor;
        const mappedEvents = captureMode === 'readable_raw'
          ? this.streamManager.mapReadableRawEvents(terminalId, readResult.records, {
            maxControlOps,
            includeRawData,
            includeMetaEvents,
            controlLevel,
            noiseFilter,
            coalesceMs,
            coalesceMaxChars
          })
          : readResult.records.map((record) => (record && record.payload ? record.payload : record));

        for (const event of mappedEvents) {
          if (isOutputLikeEvent(event, captureMode)) {
            sawOutputLike = true;
            lastOutputAt = Date.now();
          }
          textWindow = appendRollingText(textWindow, getOutputTextFromEvent(event, captureMode));
          if (captureMaxEvents > 0) {
            capturedEvents.push(event);
            if (capturedEvents.length > captureMaxEvents) {
              capturedEvents.splice(0, capturedEvents.length - captureMaxEvents);
            }
          }
        }
      }

      // Decide whether to also match the rendered screen this iteration. For a
      // redraw-heavy TUI the output stream never linearly contains what's on
      // screen; the reconstructed virtual screen does.
      let screenText = null;
      if (untilRegex || promptRegex) {
        let screenEnabled = matchTarget === 'screen';
        if (!screenEnabled && matchTarget === 'auto') {
          const f = this.streamManager.getTerminalFlags(terminalId);
          screenEnabled = !!(f.exists && f.alternateScreen);
        }
        if (screenEnabled) {
          screenText = this.streamManager.getScreenText(terminalId);
        }
      }

      if (untilRegex) {
        untilRegex.lastIndex = 0;
        let match = untilRegex.exec(textWindow);
        let via = 'stream';
        if (!match && screenText) {
          untilRegex.lastIndex = 0;
          match = untilRegex.exec(screenText);
          via = 'screen';
        }
        if (match) {
          matched = 'regex';
          matchedText = typeof match[0] === 'string' ? match[0] : null;
          matchVia = via;
          status = 'matched';
          break;
        }
      }

      if (promptRegex) {
        // The shell prompt is always the final line of output. Match only the
        // tail (text after the last newline), so a mid-stream line ending in
        // %/$/>/# — e.g. a "100%" progress line that has already scrolled past —
        // doesn't spuriously satisfy the prompt condition and truncate output.
        const tailOf = (s) => {
          const nl = s.lastIndexOf('\n');
          return nl === -1 ? s : s.slice(nl + 1);
        };
        promptRegex.lastIndex = 0;
        let match = promptRegex.exec(tailOf(textWindow));
        let via = 'stream';
        if (!match && screenText) {
          promptRegex.lastIndex = 0;
          match = promptRegex.exec(tailOf(screenText));
          via = 'screen';
        }
        if (match) {
          matched = 'prompt';
          matchedText = typeof match[0] === 'string' ? match[0] : null;
          matchVia = via;
          status = 'matched';
          break;
        }
      }

      // Authoritative agent_done: the Stop hook bumped the session's turn
      // counter. The bump lands after the reply renders, but this pass's read
      // may predate that render — so drain exactly one more read pass before
      // breaking, or the captured events miss the reply tail (and downstream
      // consumers like until_reply_regex see an empty reply).
      if (untilAgentDone && markerName) {
        if (markerTurnDone) {
          matched = 'agent_done';
          matchedText = null;
          matchVia = 'turn_counter';
          status = 'matched';
          break;
        }
        const currentTurnCount = this.readTurnCount(markerName);
        if (currentTurnCount !== null && currentTurnCount > (markerBaseline ?? 0)) {
          markerTurnDone = true;
        }
      }

      const now = Date.now();
      if (untilAgentDone && agentDoneIdleMs !== null && sawOutputLike && (now - lastOutputAt) >= agentDoneIdleMs) {
        const flags = this.streamManager.getTerminalFlags(terminalId);
        // Don't declare done while the agent's own UI still shows a busy
        // indicator (e.g. "esc to interrupt"), even if output paused. Previously
        // this check only ran in mode:ui after the wait returned; folding it into
        // the core predicate covers readable_raw/auto (the defaults) too, so a
        // mid-turn streaming/tool pause no longer reads as completion.
        const busyLine = flags.exists && !flags.closed
          ? screenTextLooksBusy(this.streamManager.getScreenText(terminalId))
          : null;
        // When a hook record exists the counter above is the source of truth:
        // a quiet, idle-looking screen is NOT completion (thinking models
        // pause before streaming — the exact gap that fired false dones).
        if (!markerExpected && flags.exists && !flags.closed && !flags.alternateScreen && !flags.cursorHidden && !busyLine) {
          matched = 'agent_done';
          matchedText = null;
          matchVia = 'heuristic';
          status = 'matched';
          break;
        }
      }

      if (idleWasProvided && idleMs !== null && (now - lastOutputAt) >= idleMs) {
        matched = 'idle';
        matchedText = null;
        status = 'matched';
        break;
      }

      if (readResult.closed) {
        status = 'closed';
        break;
      }

      if ((now - startedAt) >= maxWaitMs) {
        status = 'timed_out';
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
    }

    // On a stream-match timeout, detect the classic TUI trap: the pattern is on
    // the rendered screen but never appeared in the output stream. Surface an
    // actionable hint instead of a silent 30s/90s timeout.
    let hint = null;
    if (status === 'timed_out' && matchTarget !== 'screen' && (untilRegex || promptRegex)) {
      const screenText = this.streamManager.getScreenText(terminalId);
      const flags = this.streamManager.getTerminalFlags(terminalId);
      let screenWouldMatch = false;
      if (screenText) {
        if (untilRegex) {
          untilRegex.lastIndex = 0;
          screenWouldMatch = untilRegex.test(screenText);
        }
        if (!screenWouldMatch && promptRegex) {
          const nl = screenText.lastIndexOf('\n');
          const tail = nl === -1 ? screenText : screenText.slice(nl + 1);
          promptRegex.lastIndex = 0;
          screenWouldMatch = promptRegex.test(tail);
        }
      }
      if (screenWouldMatch || (flags.exists && flags.alternateScreen)) {
        hint = "Timed out scanning the output stream, but the pattern appears on the rendered screen — this terminal looks like a full-screen/TUI app that repaints in place. until_regex/until_prompt scan the byte stream by default. Retry with match_target:\"screen\", or use until_agent_done for interactive agents.";
      }
    }

    return {
      payload: {
      ok: status === 'matched',
      status,
      matched,
      matchedText,
      matchVia,
      matchTarget,
      hint,
      cursorStart,
      cursorEnd: cursor,
      next_cursor: cursor,
      startFrom: startFromResolved,
      untilAgentDone,
      agentDoneIdleMs,
      waitedMs: Date.now() - startedAt,
      captureMode,
      eventCount: capturedEvents.length,
      events: capturedEvents,
      closed: status === 'closed',
      error: lastRead ? lastRead.error : null
      }
    };
  }

  async handleWaitTerminal(args) {
    const outcome = await this.runWaitTerminal(args);
    if (outcome.errorResponse) return outcome.errorResponse;
    return this.wrapJson(slimWaitPayload(outcome.payload, null));
  }

  async handleReadTerminal(args) {
    const requestedTerminalId = args.terminal_id;
    if (!requestedTerminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }
    const providedCursor = typeof args.cursor === 'number' ? Math.floor(args.cursor) : null;
    const startFrom = typeof args.start_from === 'string'
      ? String(args.start_from).toLowerCase()
      : null;
    if (startFrom && !WAIT_START_MODES.includes(startFrom)) {
      return { content: [{ type: 'text', text: 'Error: start_from must be one of "latest", "cursor", or "beginning".' }], isError: true };
    }
    // Token-thrifty defaults; callers pass 0 explicitly for unlimited reads.
    const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : DEFAULT_READ_MAX_BYTES;
    const maxEvents = typeof args.maxEvents === 'number' ? args.maxEvents : DEFAULT_READ_MAX_EVENTS;
    const mode = typeof args.mode === 'string' ? String(args.mode).toLowerCase() : 'readable_raw';

    if (!READ_TERMINAL_MODES.includes(mode)) {
      const supported = READ_TERMINAL_MODES.map((item) => `"${item}"`).join(', ');
      return { content: [{ type: 'text', text: `Error: mode must be one of ${supported}.` }], isError: true };
    }

    let terminalId = await this.ensureTerminalReadyWithRecovery(requestedTerminalId);

    let startFromResolved = startFrom;
    if (!startFromResolved) {
      startFromResolved = providedCursor === null ? 'beginning' : 'cursor';
    }
    let cursorStart = null;
    if (startFromResolved === 'cursor') {
      if (providedCursor === null) {
        return { content: [{ type: 'text', text: 'Error: start_from="cursor" requires cursor.' }], isError: true };
      }
      cursorStart = providedCursor;
    } else if (startFromResolved === 'beginning') {
      cursorStart = this.streamManager.getBeginningCursor(terminalId);
    } else {
      cursorStart = this.streamManager.getLatestCursor(terminalId);
    }
    if (cursorStart === null) {
      cursorStart = this.streamManager.getLatestCursor(terminalId);
    }

    let result = this.streamManager.readEvents(terminalId, cursorStart, maxBytes, maxEvents);
    if (this.isTerminalNotFoundStreamError(result.error)) {
      const recoveredId = await this.recoverTerminalId(requestedTerminalId, terminalId);
      if (recoveredId && recoveredId !== terminalId) {
        terminalId = recoveredId;
        if (startFromResolved === 'beginning') {
          cursorStart = this.streamManager.getBeginningCursor(terminalId);
        } else if (startFromResolved === 'latest') {
          cursorStart = this.streamManager.getLatestCursor(terminalId);
        }
        if (cursorStart === null) {
          cursorStart = this.streamManager.getLatestCursor(terminalId);
        }
        result = this.streamManager.readEvents(terminalId, cursorStart, maxBytes, maxEvents);
      }
    }
    if (this.isTerminalNotFoundStreamError(result.error)) {
      return {
        content: [{ type: 'text', text: 'Error: terminal_id is stale or missing (likely daemon restart). Reattach or recreate terminal.' }],
        isError: true
      };
    }
    const cursorEnd = result.cursor;
    // Flag reads cut short by the maxEvents/maxBytes caps so callers know to
    // page through the rest via cursor instead of assuming they saw everything.
    const latestCursor = this.streamManager.getLatestCursor(terminalId);
    const truncated = Boolean(
      (maxBytes || maxEvents)
      && cursorEnd !== null
      && latestCursor !== null
      && latestCursor > cursorEnd
    );
    const truncation = truncated
      ? {
        truncated: true,
        hint: `Output truncated by maxEvents/maxBytes caps. Continue with start_from="cursor", cursor=${cursorEnd}, or pass maxEvents=0 and maxBytes=0 for unlimited.`
      }
      : null;
    if (mode === 'raw') {
      return this.wrapJson({
        ...result,
        cursorStart,
        cursorEnd,
        next_cursor: cursorEnd,
        ...(truncation || {})
      });
    }

    if (mode === 'readable_raw') {
      const maxControlOps = Number.isFinite(args.maxControlOps)
        ? Math.max(1, Math.floor(args.maxControlOps))
        : 200;
      const includeRawData = args.includeRawData === true;
      const includeMetaEvents = args.includeMetaEvents === true;
      const controlLevel = normalizeReadableControlLevel(args.control_level);
      if (!controlLevel) {
        return {
          content: [{ type: 'text', text: `Error: control_level must be one of "${READABLE_CONTROL_LEVELS.join('", "')}".` }],
          isError: true
        };
      }
      const noiseFilter = normalizeReadableNoiseFilter(args.noise_filter);
      if (!noiseFilter) {
        return {
          content: [{ type: 'text', text: `Error: noise_filter must be one of "${READABLE_NOISE_FILTERS.join('", "')}".` }],
          isError: true
        };
      }
      const coalesceMs = normalizeReadableCoalesceMs(args.coalesce_ms);
      const coalesceMaxChars = normalizeReadableCoalesceMaxChars(args.coalesce_max_chars);
      const events = this.streamManager.mapReadableRawEvents(terminalId, result.records || [], {
        maxControlOps,
        includeRawData,
        includeMetaEvents,
        controlLevel,
        noiseFilter,
        coalesceMs,
        coalesceMaxChars
      });

      const readableRawPayload = {
        cursor: cursorEnd,
        next_cursor: cursorEnd,
        done: result.done,
        eventCount: events.length,
        events,
        ...(truncation || {})
      };
      if (result.closed) readableRawPayload.closed = result.closed;
      if (result.error != null) readableRawPayload.error = result.error;
      return this.wrapJson(readableRawPayload);
    }

    const includeRawTail = args.includeRawTail === true;
    const rawTailMaxEvents = Number.isFinite(args.rawTailMaxEvents)
      ? Math.max(0, Math.floor(args.rawTailMaxEvents))
      : 40;
    const uiMaxLines = Number.isFinite(args.uiMaxLines)
      ? Math.max(1, Math.floor(args.uiMaxLines))
      : undefined;

    await this.streamManager.flushVirtualScreen(terminalId);
    const payload = {
      cursor: cursorEnd,
      next_cursor: cursorEnd,
      done: result.done,
      ui: this.streamManager.getUiSnapshot(terminalId, { maxLines: uiMaxLines }),
      ...(truncation || {})
    };
    if (result.closed) payload.closed = result.closed;
    if (result.error != null) payload.error = result.error;

    if (includeRawTail) {
      payload.rawTail = rawTailMaxEvents > 0 ? result.events.slice(-rawTailMaxEvents) : [];
    }

    return this.wrapJson(payload);
  }
}

// Only boot the server when run directly (`node hop-mcp.js`). When required as a
// module (tests), export the internals instead so the scrape/wait logic can be
// exercised without standing up a stdio server.
if (require.main === module) {
  new HopMCPServer().start().catch((err) => {
    console.error('Hop MCP server failed to start:', err);
    process.exit(1);
  });
} else {
  module.exports = {
    HopMCPServer,
    TerminalStreamManager,
    extractUiBusyLine,
    getBusyLinePatterns,
    COMPOSER_BORDER_CHARS,
    COMPOSER_PROMPT_CHARS,
    encodeClaudeProjectDir,
    summarizeMessageContent
  };
}
