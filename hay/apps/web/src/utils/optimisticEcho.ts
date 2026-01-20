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

    let matched = 0;
    const limit = Math.min(pending.length, data.length);
    while (matched < limit && data[matched] === pending[matched]) {
      matched += 1;
    }

    if (matched > 0) {
      pending = pending.slice(matched);
      mismatchCount = 0;
      return data.slice(matched);
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
