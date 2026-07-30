'use strict';

function emptyFailureState() {
  return { pid: 0, count: 0, firstAt: 0 };
}

function createFailureTracker({ requiredFailures, windowMs, now = Date.now }) {
  if (!Number.isInteger(requiredFailures) || requiredFailures < 1) {
    throw new TypeError('requiredFailures must be a positive integer');
  }
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new TypeError('windowMs must be a non-negative number');
  }
  if (typeof now !== 'function') {
    throw new TypeError('now must be a function');
  }

  let state = emptyFailureState();

  return {
    recordFailure(pid) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new TypeError('pid must be a positive integer');
      }
      const at = now();
      if (state.pid !== pid) {
        state = { pid, count: 0, firstAt: at };
      }
      state.count += 1;
      const failingForMs = Math.max(0, at - state.firstAt);
      return {
        ...state,
        failingForMs,
        shouldRestart: state.count >= requiredFailures && failingForMs >= windowMs
      };
    },

    recordSuccess(pid) {
      const recovered = state.pid === pid && state.count > 0
        ? { ...state, failingForMs: Math.max(0, now() - state.firstAt) }
        : null;
      state = emptyFailureState();
      return recovered;
    },

    reset() {
      state = emptyFailureState();
    },

    snapshot() {
      return { ...state };
    }
  };
}

function createSingleFlight() {
  let pending = null;

  return {
    run(work) {
      if (pending) return pending;
      if (typeof work !== 'function') {
        throw new TypeError('work must be a function');
      }
      const current = Promise.resolve().then(work);
      pending = current;
      const clear = () => {
        if (pending === current) pending = null;
      };
      current.then(clear, clear);
      return current;
    },

    isRunning() {
      return pending !== null;
    }
  };
}

function sameHostIncarnation(a, b) {
  if (!a || !b) return false;
  if (Number(a.pid) !== Number(b.pid) || Number(a.port) !== Number(b.port)) {
    return false;
  }
  const aStartedAt = Number(a.startedAt);
  const bStartedAt = Number(b.startedAt);
  if (aStartedAt > 0 && bStartedAt > 0) {
    return aStartedAt === bStartedAt;
  }
  return true;
}

module.exports = {
  createFailureTracker,
  createSingleFlight,
  sameHostIncarnation
};
