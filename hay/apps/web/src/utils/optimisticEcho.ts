export type OptimisticEchoOptions = {
  maxPendingMs?: number;
  now?: () => number;
};

export type OptimisticEcho = {
  onInput: (data: string, enabled: boolean) => string;
  reconcileOutput: (data: string) => string;
  reset: () => void;
  getPending: () => string;
};

const DEFAULT_MAX_PENDING_MS = 800;

const isPrintable = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
};

const filterPrintable = (data: string) => {
  let result = "";
  let index = 0;
  while (index < data.length) {
    const char = data[index];
    if (char === "\u001b") {
      index += 1;
      if (data[index] === "[") {
        index += 1;
        while (index < data.length) {
          const code = data.charCodeAt(index);
          if (code >= 0x40 && code <= 0x7e) {
            index += 1;
            break;
          }
          index += 1;
        }
      } else {
        index += 1;
      }
      continue;
    }
    if (isPrintable(char)) {
      result += char;
    }
    index += 1;
  }
  return result;
};

export const createOptimisticEcho = (options: OptimisticEchoOptions = {}): OptimisticEcho => {
  const maxPendingMs = options.maxPendingMs ?? DEFAULT_MAX_PENDING_MS;
  const now = options.now ?? (() => Date.now());
  let pending = "";
  let lastEchoAt = 0;
  let mismatchCount = 0;

  const onInput = (data: string, enabled: boolean) => {
    if (!enabled) {
      return "";
    }
    const filtered = filterPrintable(data);
    if (!filtered) {
      return "";
    }
    pending += filtered;
    lastEchoAt = now();
    return filtered;
  };

  const reconcileOutput = (data: string) => {
    if (!pending) {
      return data;
    }

    if (now() - lastEchoAt > maxPendingMs) {
      pending = "";
      mismatchCount = 0;
      return data;
    }

    // TUI guard: a chunk carrying cursor-movement/erase/OSC controls is a
    // REDRAW (Claude Code's composer, editors), not a keystroke echo.
    // Consuming pending chars out of a redraw deletes the user's typed text
    // from the repainted screen — "I can't see what I typed" in multi-line
    // composers. Redraw chunks pass through untouched; the repaint is the
    // truth, so pending is dropped rather than matched later out of context.
    {
      let scan = 0;
      let complex = false;
      while (scan < data.length) {
        const c = data[scan];
        if (c === "\u001b") {
          const next = data[scan + 1];
          if (next === "[") {
            let j = scan + 2;
            while (j < data.length) {
              const code = data.charCodeAt(j);
              j += 1;
              if (code >= 0x40 && code <= 0x7e) {
                // SGR (m) is styling, safe; anything else moves/erases.
                if (data[j - 1] !== "m") complex = true;
                break;
              }
            }
            scan = j;
            continue;
          }
          complex = true; // OSC / other escapes: treat as redraw
          break;
        }
        scan += 1;
      }
      if (complex) {
        pending = "";
        mismatchCount = 0;
        return data;
      }
    }

    // Consume echoed copies of pending chars wherever they sit in the
    // chunk's PRINTABLE stream, preserving control sequences verbatim. The
    // old head-anchored raw prefix match broke on the first escape byte the
    // shell interleaves under rapid typing (echoes arrive coalesced), then
    // two strikes cleared pending — after which every server echo rendered
    // on top of the optimistic one: typing "alal..." fast displayed
    // "llllllalalal..." (reproduced deterministically in emulation).
    let out = "";
    let i = 0;
    let consumed = 0;
    let sawForeign = false;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\u001b") {
        let j = i + 1;
        if (data[j] === "[") {
          j += 1;
          while (j < data.length) {
            const code = data.charCodeAt(j);
            j += 1;
            if (code >= 0x40 && code <= 0x7e) break;
          }
        } else {
          j += 1;
        }
        out += data.slice(i, j);
        i = j;
        continue;
      }
      if (!sawForeign && consumed < pending.length && isPrintable(ch) && ch === pending[consumed]) {
        consumed += 1;
        i += 1;
        continue;
      }
      if (!sawForeign && consumed < pending.length && isPrintable(ch)) {
        // A printable that isn't the next expected echo: stop consuming so we
        // never swallow real program output out of order.
        sawForeign = true;
      }
      out += ch;
      i += 1;
    }

    if (consumed > 0) {
      pending = pending.slice(consumed);
      mismatchCount = 0;
      return out;
    }

    mismatchCount += 1;
    if (mismatchCount >= 2) {
      pending = "";
      mismatchCount = 0;
    }

    return data;
  };

  const reset = () => {
    pending = "";
    mismatchCount = 0;
  };

  const getPending = () => pending;

  return {
    onInput,
    reconcileOutput,
    reset,
    getPending
  };
};
