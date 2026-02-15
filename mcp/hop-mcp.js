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
const READABLE_CONTROL_LEVELS = ['full', 'structural', 'none'];
const DEFAULT_READABLE_CONTROL_LEVEL = 'none';
const READABLE_NOISE_FILTERS = ['balanced', 'off'];
const DEFAULT_READABLE_NOISE_FILTER = 'balanced';
const DEFAULT_READABLE_COALESCE_MS = 250;
const DEFAULT_READABLE_COALESCE_MAX_CHARS = 32768;
const READABLE_NOISE_REWRITE_WINDOW_MS = 1000;
const READABLE_NOISE_STABLE_MS = 800;
const READABLE_NOISE_MIN_REWRITES = 2;
const READABLE_SPINNER_PREFIX_RE = /^(?:[\u2800-\u28ff]|[✳✢✶✻✽·◐◓◑◒◴◷◶◵])+\s*/u;
const WAIT_START_MODES = ['latest', 'cursor', 'beginning'];
const MAX_BUFFER_EVENTS = 2000;
const STREAM_CONNECT_TIMEOUT_MS = 800;
const CREATE_TERMINAL_OUTPUT_WARMUP_MS = 1200;
const DEFAULT_TERMINAL_COLS = 140;
const DEFAULT_TERMINAL_ROWS = 40;
const UI_PARSER_FLUSH_TIMEOUT_MS = 200;
const DEFAULT_SEND_KEY_REPEAT = 1;
const WAIT_POLL_INTERVAL_MS = 40;
const DEFAULT_WAIT_MAX_MS = 30000;
const DEFAULT_WAIT_CAPTURE_MAX_EVENTS = 120;
const DEFAULT_WAIT_AGENT_DONE_IDLE_MS = 1200;
const WAIT_TEXT_WINDOW_MAX_CHARS = 65536;
const DEFAULT_WAIT_PROMPT_REGEX = '(?:^|\\r?\\n)[^\\r\\n]*[#$>%] ?$';
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
        noise: createReadableNoiseState()
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
    let lastId = cursor || null;

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

    const shouldFilterControls = controlLevel !== 'full';
    const controlFilteredEvents = mappedEvents.map((event) => {
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

    if (coalesceMs > 0) {
      return coalesceReadableOutputEvents(normalizedEvents, { coalesceMs, coalesceMaxChars });
    }
    return normalizedEvents;
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
      waitTerminal: {
        startFromModes: WAIT_START_MODES,
        defaultStartFrom: 'latest',
        defaultCapture: 'readable_raw',
        defaultCondition: 'until_agent_done',
        defaultAgentDoneIdleMs: DEFAULT_WAIT_AGENT_DONE_IDLE_MS
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
        name: 'hop_send_and_wait',
        description: 'Write input (and optional keypress), then wait for completion/output in one call. Defaults to agent-friendly completion when no explicit wait condition is provided.',
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
            until_prompt: { type: 'boolean', description: 'Wait for prompt regex match.' },
            until_agent_done: { type: 'boolean', description: 'Wait for agent-style completion: output has started, terminal is quiet, and interactive cursor is visible.' },
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
        name: 'hop_wait_terminal',
        description: 'Wait for terminal output conditions (regex, prompt, idle, agent_done) without client polling loops. Defaults to agent_done when no explicit wait condition is provided.',
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
            until_prompt: { type: 'boolean', description: 'Wait for prompt regex match.' },
            until_agent_done: { type: 'boolean', description: 'Wait for agent-style completion: output has started, terminal is quiet, and interactive cursor is visible.' },
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
            includeRawTail: { type: 'boolean', description: 'In UI mode, include raw output tail for lossless event inspection.' },
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
        description: 'List available workspaces and the current default.',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'hop_save_workspace',
        description: 'Save a workspace snapshot by name.',
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
        name: 'hop_use_workspace',
        description: 'Set the default workspace by name.',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name']
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
        description: 'Available workspaces and current default.'
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
      return { content: [{ type: 'text', text: `Connected to ${this.baseUrl}` }] };
    }

    if (name === 'hop_server_info') {
      return this.wrapJson(this.getServerInfoPayload());
    }

    this.ensureConnection();

    switch (name) {
      case 'hop_list_sessions':
        return this.wrapApiResult(await this.callApi('GET', '/api/sessions'), { endpoint: '/api/sessions' });
      case 'hop_list_terminals':
        return this.wrapApiResult(await this.callApi('GET', '/api/terminals'), { endpoint: '/api/terminals' });
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
        }
        return this.wrapApiResult(attached, { endpoint: '/api/terminals/attach' });
      }
      case 'hop_write_terminal':
        await this.prewarmTerminalStream(args.terminal_id);
        return this.wrapApiResult(
          await this.callApi('POST', `/api/terminals/${encodeURIComponent(args.terminal_id)}/write`, {
            data: args.data
          }),
          { endpoint: `/api/terminals/${encodeURIComponent(args.terminal_id)}/write` }
        );
      case 'hop_send_key': {
        const mapped = resolveSendKeyInput(args.key, args.repeat);
        if (!mapped.ok) {
          return { content: [{ type: 'text', text: `Error: ${mapped.error}` }], isError: true };
        }
        await this.prewarmTerminalStream(args.terminal_id);
        return this.wrapApiResult(
          await this.callApi('POST', `/api/terminals/${encodeURIComponent(args.terminal_id)}/write`, {
            data: mapped.data
          }),
          { endpoint: `/api/terminals/${encodeURIComponent(args.terminal_id)}/write` }
        );
      }
      case 'hop_send_and_wait':
        return await this.handleSendAndWait(args);
      case 'hop_wait_terminal':
        return await this.handleWaitTerminal(args);
      case 'hop_resize_terminal': {
        this.streamManager.ensure(this.baseUrl, this.token, this.actor, args.terminal_id, { cols: args.cols, rows: args.rows });
        const resized = await this.callApi('POST', `/api/terminals/${encodeURIComponent(args.terminal_id)}/resize`, {
          cols: args.cols,
          rows: args.rows
        });
        if (resized && resized.ok !== false) {
          this.streamManager.setTerminalSize(args.terminal_id, args.cols, args.rows);
        }
        return this.wrapApiResult(resized, { endpoint: `/api/terminals/${encodeURIComponent(args.terminal_id)}/resize` });
      }
      case 'hop_read_terminal':
        return await this.handleReadTerminal(args);
      case 'hop_close_terminal': {
        const closed = await this.callApi('DELETE', `/api/terminals/${encodeURIComponent(args.terminal_id)}${args.killSession ? '?killSession=true' : ''}`);
        this.streamManager.remove(args.terminal_id);
        return this.wrapApiResult(closed, { endpoint: `/api/terminals/${encodeURIComponent(args.terminal_id)}` });
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
      case 'hop_save_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/save', { name: args.name }),
          { endpoint: '/api/workspaces/save' }
        );
      case 'hop_load_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/load', { name: args.name, start: args.start }),
          { endpoint: '/api/workspaces/load' }
        );
      case 'hop_use_workspace':
        return this.wrapApiResult(
          await this.callApi('POST', '/api/workspaces/use', { name: args.name }),
          { endpoint: '/api/workspaces/use' }
        );
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
    this.streamManager.ensure(this.baseUrl, this.token, this.actor, terminalId, options);
    await this.streamManager.waitUntilConnected(terminalId);
    const waitForOutputMs = Number.isFinite(options.waitForOutputMs)
      ? Math.max(0, Math.floor(options.waitForOutputMs))
      : 0;
    if (waitForOutputMs > 0) {
      await this.streamManager.waitForOutputEvent(terminalId, waitForOutputMs);
    }
  }

  async handleSendAndWait(args) {
    const terminalId = args.terminal_id;
    if (!terminalId) {
      return { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true };
    }

    const data = typeof args.data === 'string' ? args.data : '';
    const pressEnter = args.press_enter === true;
    const key = typeof args.key === 'string' ? args.key : '';
    const shouldWait = args.wait !== false;
    if (!data && !pressEnter && !key) {
      return {
        content: [{ type: 'text', text: 'Error: provide at least one input action (data, press_enter=true, or key).' }],
        isError: true
      };
    }

    await this.prewarmTerminalStream(terminalId);
    const endpoint = `/api/terminals/${encodeURIComponent(terminalId)}/write`;
    const cursorBeforeSend = this.streamManager.getLatestCursor(terminalId);
    const sent = [];

    const sendPayload = async (payload, source) => {
      const result = await this.callApi('POST', endpoint, { data: payload });
      if (this.isApiFailurePayload(result)) {
        return { errorResponse: this.wrapApiResult(result, { endpoint }) };
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
      return this.wrapJson({
        ok: true,
        terminal_id: terminalId,
        sent,
        waited: false,
        cursorStart: cursorBeforeSend,
        cursorEnd: this.streamManager.getLatestCursor(terminalId),
        next_cursor: this.streamManager.getLatestCursor(terminalId)
      });
    }

    const waitArgs = { ...args, terminal_id: terminalId };
    delete waitArgs.data;
    delete waitArgs.press_enter;
    delete waitArgs.key;
    delete waitArgs.repeat;
    delete waitArgs.wait;

    if (waitArgs.cursor === undefined && waitArgs.start_from === undefined) {
      waitArgs.start_from = 'cursor';
      waitArgs.cursor = cursorBeforeSend;
    }

    const waited = await this.runWaitTerminal(waitArgs);
    if (waited.errorResponse) return waited.errorResponse;

    return this.wrapJson({
      ok: true,
      terminal_id: terminalId,
      sent,
      waited: true,
      wait: waited.payload,
      cursorStart: waited.payload.cursorStart,
      cursorEnd: waited.payload.cursorEnd,
      next_cursor: waited.payload.cursorEnd
    });
  }

  async runWaitTerminal(args) {
    const terminalId = args.terminal_id;
    if (!terminalId) {
      return { errorResponse: { content: [{ type: 'text', text: 'Error: terminal_id is required.' }], isError: true } };
    }

    const captureMode = typeof args.capture === 'string'
      ? String(args.capture).toLowerCase()
      : 'readable_raw';
    if (captureMode !== 'raw' && captureMode !== 'readable_raw') {
      return { errorResponse: { content: [{ type: 'text', text: 'Error: capture must be "raw" or "readable_raw".' }], isError: true } };
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

    this.streamManager.ensure(this.baseUrl, this.token, this.actor, terminalId);
    await this.streamManager.waitUntilConnected(terminalId, 300);

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
    let status = 'timed_out';
    let lastRead = null;
    let sawOutputLike = false;

    while (true) {
      const readResult = this.streamManager.readEvents(terminalId, cursor, 0, captureMaxEvents || 200);
      lastRead = readResult;
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

      if (untilRegex) {
        const match = untilRegex.exec(textWindow);
        if (match) {
          matched = 'regex';
          matchedText = typeof match[0] === 'string' ? match[0] : null;
          status = 'matched';
          break;
        }
      }

      if (promptRegex) {
        const match = promptRegex.exec(textWindow);
        if (match) {
          matched = 'prompt';
          matchedText = typeof match[0] === 'string' ? match[0] : null;
          status = 'matched';
          break;
        }
      }

      const now = Date.now();
      if (untilAgentDone && agentDoneIdleMs !== null && sawOutputLike && (now - lastOutputAt) >= agentDoneIdleMs) {
        const flags = this.streamManager.getTerminalFlags(terminalId);
        if (flags.exists && !flags.closed && !flags.alternateScreen && !flags.cursorHidden) {
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

    return {
      payload: {
      ok: status === 'matched',
      status,
      matched,
      matchedText,
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
    return this.wrapJson(outcome.payload);
  }

  async handleReadTerminal(args) {
    const terminalId = args.terminal_id;
    if (!terminalId) {
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

    this.streamManager.ensure(this.baseUrl, this.token, this.actor, terminalId);
    await this.streamManager.waitUntilConnected(terminalId, 300);

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

    const result = this.streamManager.readEvents(terminalId, cursorStart, maxBytes, maxEvents);
    const cursorEnd = result.cursor;
    if (mode === 'raw') {
      return this.wrapJson({
        ...result,
        cursorStart,
        cursorEnd,
        next_cursor: cursorEnd,
        startFrom: startFromResolved
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

      return this.wrapJson({
        mode: 'readable_raw',
        cursor: cursorEnd,
        cursorStart,
        cursorEnd,
        next_cursor: cursorEnd,
        startFrom: startFromResolved,
        done: result.done,
        closed: result.closed,
        error: result.error,
        eventCount: events.length,
        events
      });
    }

    const includeRawTail = args.includeRawTail !== false;
    const rawTailMaxEvents = Number.isFinite(args.rawTailMaxEvents)
      ? Math.max(0, Math.floor(args.rawTailMaxEvents))
      : 40;
    const uiMaxLines = Number.isFinite(args.uiMaxLines)
      ? Math.max(1, Math.floor(args.uiMaxLines))
      : undefined;

    await this.streamManager.flushVirtualScreen(terminalId);
    const payload = {
      mode: 'ui',
      cursor: cursorEnd,
      cursorStart,
      cursorEnd,
      next_cursor: cursorEnd,
      startFrom: startFromResolved,
      done: result.done,
      closed: result.closed,
      error: result.error,
      eventCount: result.events.length,
      ui: this.streamManager.getUiSnapshot(terminalId, { maxLines: uiMaxLines })
    };

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
