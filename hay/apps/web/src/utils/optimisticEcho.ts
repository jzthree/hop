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

// Optimistic echo is disabled while ANOTHER client is typing (two people into
// one PTY would make the local echo mismatch the interleaved server echo). The
// trap: a client that set typing=true and then vanished — a dropped tab, a
// crashed phone, a ghost lingering in presence before eviction — leaves its
// flag stuck true, and that silently turns local echo OFF for everyone else,
// so every keystroke then waits a full round-trip and typing feels laggy.
//
// A REAL typist refreshes their presence on every keystroke, so their "last
// seen typing" timestamp keeps advancing; a ghost stops refreshing and goes
// stale. So a peer only counts as actively typing if we've seen their typing
// flag RECENTLY. `lastSeenTyping` maps peer id -> the last time we observed
// them typing (refreshed in the presence handler). Ghosts age out; live
// typists never do.
export const STALE_TYPING_MS = 6000;
export function hasActiveOtherTypist(
  clients: Array<{ id: string; typing?: boolean }>,
  selfId: string | null,
  lastSeenTyping: Map<string, number>,
  now: number,
  staleMs: number = STALE_TYPING_MS
): boolean {
  return clients.some(
    (c) =>
      c.id !== selfId &&
      !!c.typing &&
      now - (lastSeenTyping.get(c.id) ?? 0) < staleMs
  );
}

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

  // Take back the predictions still on screen: step over them and blank
  // them, so the cursor is where the server believes it is. Everything the
  // server sends is placed relative to ITS cursor — a shell that redraws
  // the word being typed (zsh's syntax highlighting and autosuggestions:
  // "\bho") would otherwise land one column per unconfirmed prediction too
  // far right, doubling letters ("hop recover" read "hhopp recover").
  const rollback = () => {
    const n = pending.length;
    pending = "";
    return n ? "\b".repeat(n) + `\u001b[${n}X` : "";
  };

  const reconcileOutput = (data: string) => {
    if (!pending) {
      return data;
    }

    if (now() - lastEchoAt > maxPendingMs) {
      return rollback() + data;
    }

    // Consume the chunk's leading echo of what was predicted. Styling (SGR)
    // and erase-to-end-of-line may sit between the echoed characters (a
    // highlighting shell, coalesced echoes under fast typing): they are kept
    // and change nothing about where the cursor is. The first thing that is
    // not the next predicted character — another character, a cursor move, a
    // backspace, a carriage return, any other control or escape — means the
    // server has moved on from echoing: the remaining predictions are taken
    // back and the rest of the chunk is written as the server sent it. That
    // includes a TUI's repaint (Claude Code's composer, editors), which
    // then draws onto the screen the server expects, with nothing typed
    // left behind or deleted from it.
    let out = "";
    let i = 0;
    let consumed = 0;
    while (i < data.length && consumed < pending.length) {
      const ch = data[i];
      if (ch === "\u001b" && data[i + 1] === "[") {
        let j = i + 2;
        while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j += 1;
        const final = data[j];
        const param = data.slice(i + 2, j);
        // Styling, or erase from the cursor to the end of the line (never
        // the erases that reach left of it).
        if (final === "m" || (final === "K" && (param === "" || param === "0"))) {
          out += data.slice(i, j + 1);
          i = j + 1;
          continue;
        }
        break;
      }
      if (ch === pending[consumed]) {
        consumed += 1;
        i += 1;
        continue;
      }
      break;
    }
    pending = pending.slice(consumed);
    if (i >= data.length) return out;
    // The server has moved on: what is still predicted comes off the screen
    // first (nothing, when every prediction was confirmed).
    return out + rollback() + data.slice(i);
  };

  const reset = () => {
    pending = "";
  };

  const getPending = () => pending;

  return {
    onInput,
    reconcileOutput,
    reset,
    getPending
  };
};
