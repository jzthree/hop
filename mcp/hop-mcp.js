#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const { randomUUID } = require('crypto');

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
const HOPX_UI_BUSY_LINE_PATTERNS = [
  /\besc to (?:interrupt|cancel|stop)\b/i,
  /\bctrl\+c to (?:interrupt|cancel|stop)\b/i,
  /\bwaiting for (?:process|response|model|tool)\b/i,
  /\b(?:thinking|working|generating|processing|running|compiling|building|loading)[…\.]{1,3}/i,
  /^\s*[•*]\s+.*\b(working|starting|thinking|running|processing|generating)\b/i
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
const STREAM_CONNECT_TIMEOUT_MS = 800;
const REQUEST_JSON_TIMEOUT_MS = 30000;
const CREATE_TERMINAL_OUTPUT_WARMUP_MS = 1200;
const DEFAULT_TERMINAL_COLS = 140;
const DEFAULT_TERMINAL_ROWS = 40;
const UI_PARSER_FLUSH_TIMEOUT_MS = 200;
const DEFAULT_SEND_KEY_REPEAT = 1;
const WAIT_POLL_INTERVAL_MS = 40;
const DEFAULT_WAIT_MAX_MS = 30000;
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
  ctrl_e: '\x05'
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
          result = await this.handleToolCall(params || {});
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
            base_url: { type: 'string', description: 'Hop API base URL (e.g. http://127.0.0.1:39528 or https://hop2.zhoulab.io)' },
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
        description: 'Create a terminal session and optionally run a startup command.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            cwd: { type: 'string', description: 'Absolute path.' },
            cols: { type: 'number' },
            rows: { type: 'number' },
            shell: { type: 'string' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            startup: { type: 'string' },
            autoStart: { type: 'boolean' },
            folderId: { type: 'string' }
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
        description: 'Send a named keypress to a terminal session (e.g. enter, ctrl_c, up, esc).',
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
            press_enter: { type: 'boolean', description: 'If true, send an Enter key after data (default: false).' },
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
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000).' },
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
        description: 'Execute a shell command and return clean stdout — like a Bash tool on a persistent terminal session. Sends the command, waits for the next shell prompt, strips the echoed input and ANSI codes, and returns plain text output. For simple command-then-read workflows that don\'t need raw terminal events.',
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
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000).' },
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
            coalesce_max_chars: { type: 'number', description: 'In readable_raw capture, max chars per merged frame (default: 16384).' }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hop_wait_start',
        description: 'Deprecated: prefer hop_wait_terminal with async:true. Start a background terminal wait job and return wait_id immediately.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
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
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000).' },
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
            coalesce_max_chars: { type: 'number', description: 'In readable_raw capture, max chars per merged frame (default: 16384).' }
          },
          required: ['terminal_id']
        }
      },
      {
        name: 'hop_wait_poll',
        description: 'Poll or await completion of a background wait job created by hop_wait_start (or hop_wait_terminal with async=true).',
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
        description: 'Read terminal output events. Supports raw ANSI events or UI snapshot mode with optional raw tail.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            cursor: { type: 'number' },
            start_from: {
              type: 'string',
              enum: WAIT_START_MODES,
              description: 'Where to start reading: latest (tail), cursor (requires cursor), or beginning (oldest buffered event).'
            },
            maxBytes: { type: 'number' },
            maxEvents: { type: 'number' },
            mode: { type: 'string', enum: READ_TERMINAL_MODES },
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
            coalesce_max_chars: { type: 'number', description: 'In readable_raw mode, max chars per merged frame (default: 16384).' }
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
        description: 'Convenience helper: send one turn to a terminal agent, wait, and return mode-appropriate output. Built on top of core hop_* tools.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: { type: 'string' },
            wait_id: { type: 'string', description: 'Existing async hopx turn wait_id to poll or control.' },
            data: { type: 'string', description: 'Text to send to the terminal.' },
            message: { type: 'string', description: 'Alias for data.' },
            press_enter: { type: 'boolean', description: 'Send Enter after data. Defaults to true when data/message is provided.' },
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
            prompt_regex: { type: 'string', description: 'Prompt matcher regex.' },
            idle_ms: { type: 'number', description: 'Match when output-like events are quiet for this duration.' },
            max_wait_ms: { type: 'number', description: 'Overall wait timeout (default: 30000).' },
            capture_max_events: { type: 'number', description: 'Max captured wait events (default: 60 for hopx helper; 0 when selected mode is ui unless overridden).' },
            text_only: { type: 'boolean', description: 'If true, condense readable waits to wait.text + metadata. Ignored for mode="ui" output snapshots. Default is true for readable modes.' },
            clean_text: { type: 'boolean', description: 'If true, strip ANSI escape codes from text output (default: false).' },
            // Advanced readable_raw tuning (maxControlOps, includeRawData,
            // includeMetaEvents, control_level, noise_filter, coalesce_ms,
            // coalesce_max_chars) still works as pass-through; omitted from the
            // helper schema for clarity. Use hop_wait_terminal for full control.
            uiMaxLines: { type: 'number', description: 'For mode=ui, max visible lines to include.' },
            includeRawTail: { type: 'boolean', description: 'For mode=ui, include raw output tail (default: false in hopx helper).' },
            rawTailMaxEvents: { type: 'number', description: 'For mode=ui, max raw tail events.' }
          },
          required: ['terminal_id']
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
      case 'hop_wait_start':
        return await this.handleWaitStart(args);
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

  async callApiWithConnection(method, baseUrl, token, endpoint, body) {
    const response = await requestJson(method, baseUrl, endpoint, token, this.actor, body);
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
      endpoint: options.endpoint || null,
      error: Object.prototype.hasOwnProperty.call(payload, 'error') ? payload.error : payload
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(normalized, null, 2) }],
      isError: true
    };
  }

  wrapJson(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
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
        job.done = true;
        job.updatedAt = Date.now();
        this.pruneWaitJobs(job.updatedAt);
      }
    })();

    this.waitJobs.set(waitId, job);
    this.pruneWaitJobs(now);
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
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
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
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
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

    const startedAt = Date.now();
    const maxWaitMsInput = Number.isFinite(args.max_wait_ms)
      ? Math.max(0, Math.floor(args.max_wait_ms))
      : DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS;
    const guardMaxWaitMs = Math.min(maxWaitMsInput, DEFAULT_HOPX_UI_BUSY_GUARD_MAX_WAIT_MS);
    let checks = 0;
    let lastBusyLine = null;
    let lastOutput = null;

    while (true) {
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
      if (!busyLine) {
        return {
          payload: {
            applied: true,
            busy: false,
            busyLine: null,
            checks,
            waitedMs: Date.now() - startedAt,
            output: uiPayload
          }
        };
      }
      lastBusyLine = busyLine;

      if (guardMaxWaitMs <= 0 || (Date.now() - startedAt) >= guardMaxWaitMs) {
        return {
          payload: {
            applied: true,
            busy: true,
            busyLine: lastBusyLine,
            checks,
            waitedMs: Date.now() - startedAt,
            output: lastOutput
          }
        };
      }

      await new Promise((resolve) => setTimeout(resolve, DEFAULT_HOPX_UI_BUSY_GUARD_POLL_MS));
    }
  }

  async handleHopxAgentTurn(args) {
    const requestedTerminalId = typeof args.terminal_id === 'string' ? args.terminal_id : '';
    const waitId = typeof args.wait_id === 'string' ? args.wait_id.trim() : '';
    if (!requestedTerminalId && !waitId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
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
    } else if (hasInputAction) {
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
            selected_mode: 'ui',
            text_only: false,
            uiMaxLines: args.uiMaxLines,
            rawTailMaxEvents: args.rawTailMaxEvents,
            includeUiRawTail
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
        if (waitPayload && typeof waitPayload === 'object') {
          waitPayload = {
            ...waitPayload,
            uiBusyGuard: {
              applied: true,
              busy: guardOutcome.payload.busy === true,
              busyLine: guardOutcome.payload.busyLine || null,
              checks: guardOutcome.payload.checks,
              waitedMs: guardOutcome.payload.waitedMs
            }
          };
        }
      }

      return this.wrapJson({
        ok: true,
        helper: 'hopx_agent_turn',
        terminal_id: requestedTerminalId,
        wait: waitPayload,
        output: outputPayload
      });
    }

    if (shouldAsync && shouldWait) {
      const waitArgs = this.applyHopxWaitDefaults({
        terminal_id: requestedTerminalId,
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
        selected_mode: selectedMode,
        text_only: readableTextOnly
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
              uiBusyGuard: {
                applied: true,
                busy: guardOutcome.payload.busy === true,
                busyLine: guardOutcome.payload.busyLine || null,
                checks: guardOutcome.payload.checks,
                waitedMs: guardOutcome.payload.waitedMs
              }
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
        return this.wrapJson({
          ...promotedPayload
        });
      }
    }

    const finalPayload = {
      ...parsedSendAndWait.payload,
      helper: 'hopx_agent_turn'
    };

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

    // Send the command + Enter
    this.streamManager.noteTerminalInput(terminalId, command);
    const sendResult = await this.callTerminalEndpointWithRecovery(
      requestedTerminalId,
      'POST',
      (tid) => `/api/terminals/${encodeURIComponent(tid)}/write`,
      { data: command + '\r' }
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
    waitPayload = slimWaitPayload(waitPayload, command);

    // Get clean text: strip ANSI, trim
    let stdout = typeof waitPayload.text === 'string' ? waitPayload.text : '';
    stdout = stripAnsi(stdout);

    // Remove only the single trailing shell prompt line, and only when the wait
    // actually returned to a prompt. Greedily popping every line that ends in
    // %/$/>/# would eat real output (e.g. "Download complete: 100%").
    const lines = stdout.split('\n');
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if ((matchKind === 'prompt' || matchKind === 'agent_done')
        && lines.length > 0
        && isLikelyPrompt(lines[lines.length - 1])) {
      lines.pop();
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
    }
    stdout = lines.join('\n').trimEnd();

    const timedOut = waitPayload.status === 'timeout';
    const result = {
      ok: !timedOut,
      terminal_id: requestedTerminalId,
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
        if (flags.exists && !flags.closed && !flags.alternateScreen && !flags.cursorHidden && !busyLine) {
          matched = 'agent_done';
          matchedText = null;
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
    const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : 0;
    const maxEvents = typeof args.maxEvents === 'number' ? args.maxEvents : 0;
    const mode = typeof args.mode === 'string' ? String(args.mode).toLowerCase() : 'raw';

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
    if (mode === 'raw') {
      return this.wrapJson({
        ...result,
        cursorStart,
        cursorEnd,
        next_cursor: cursorEnd
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
        events
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
      ui: this.streamManager.getUiSnapshot(terminalId, { maxLines: uiMaxLines })
    };
    if (result.closed) payload.closed = result.closed;
    if (result.error != null) payload.error = result.error;

    if (includeRawTail) {
      payload.rawTail = rawTailMaxEvents > 0 ? result.events.slice(-rawTailMaxEvents) : [];
    }

    return this.wrapJson(payload);
  }
}

new HopMCPServer().start().catch((err) => {
  console.error('Hop MCP server failed to start:', err);
  process.exit(1);
});
