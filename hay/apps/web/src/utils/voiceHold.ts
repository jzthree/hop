// Hold-space voice dictation — ONE controller for every terminal surface.
//
// It lived only in the full-screen terminal, but the wall's live tiles are
// where typing mostly happens now, so "voice doesn't always work" was often
// simply "voice does not exist on this surface". Both surfaces now share
// this state machine; each provides its own send/overlay/eligibility.
//
// Contract (unchanged from the original):
// - the first Space keydown types its space with zero latency
// - holding past the threshold erases the typed space(s) and listens
// - releasing stops; the transcript is TYPED, never submitted
// - auto-repeat spaces are swallowed; any other key cancels a pending hold
// - while listening, every space is eaten
//
// The event mechanics, measured (not assumed — both prior bugs came from
// getting this wrong): for a plain printable like space, xterm types NOTHING
// on keydown. The browser fires keypress as the keydown's default action,
// and xterm's _keyPress is what feeds the character to the PTY. Therefore:
//  - a fresh keydown is INERT for typing; it only arms the hold timer
//  - its keypress IS the zero-latency space, and must pass through anything
//    short of live dictation (swallowing it while merely pending ate every
//    ordinary space — the second regression)
//  - swallowing a keydown must preventDefault, which suppresses its
//    keypress; returning bare false only stopped xterm, and the leaked
//    keypress typed a space per auto-repeat — the first regression

type RecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export const speechRecognitionCtor = (): (new () => RecognitionLike) | undefined =>
  (window as unknown as { SpeechRecognition?: new () => RecognitionLike }).SpeechRecognition
  || (window as unknown as { webkitSpeechRecognition?: new () => RecognitionLike }).webkitSpeechRecognition;

export type VoiceHoldOptions = {
  send: (data: string) => void;
  notify: (message: string) => void;
  /** null = hidden; string = the interim transcript ("" while warming up). */
  setOverlay: (interim: string | null) => void;
  /** Is the surface a Claude-ish composer right now? Checked at keydown. */
  eligible: () => boolean;
  thresholdMs?: number;
};

export const createVoiceHold = (opts: VoiceHoldOptions) => {
  const threshold = opts.thresholdMs ?? 550;
  const MAX_HOLD_MS = 60000;
  let timer = 0;
  let watchdog = 0;
  let active = false;
  /** A hold has begun (space is down) but dictation has not started yet. */
  let pending = false;
  let spacesTyped = 0;
  let finalText = "";
  let interimText = "";
  let rec: RecognitionLike | null = null;
  /** stop() was called: the next onend is ours, not the recogniser giving up. */
  let stopping = false;
  /** Consecutive recogniser restarts that produced nothing — a loop guard. */
  let emptyRestarts = 0;

  const finish = (sendText: boolean) => {
    if (!active) return;
    active = false;
    pending = false;
    stopping = false;
    emptyRestarts = 0;
    rec = null;
    window.clearTimeout(watchdog);
    window.removeEventListener("blur", onWindowBlur);
    opts.setOverlay(null);
    // Final AND interim: a recogniser stopped by us often ends before it
    // finalises the last phrase, and `final || interim` dropped that phrase
    // whenever anything earlier had already been finalised.
    const text = (finalText + interimText).trim();
    finalText = "";
    interimText = "";
    if (sendText && text) opts.send(text);
  };

  const start = () => {
    pending = false;
    if (active) return;
    const Ctor = speechRecognitionCtor();
    // Silence here read as "voice randomly does nothing": the space vanished
    // (or didn't) and no overlay ever appeared, with no reason given.
    if (!Ctor) { opts.notify("Voice input is not supported in this browser"); return; }
    active = true;
    stopping = false;
    emptyRestarts = 0;
    finalText = "";
    interimText = "";
    // Erase every space that reached the app during this hold.
    for (let i = 0; i < Math.max(1, spacesTyped); i++) opts.send("\x7f");
    spacesTyped = 0;
    armWatchdog();
    window.addEventListener("blur", onWindowBlur);
    opts.setOverlay("");
    if (!listen(Ctor)) { opts.notify("Voice input could not start"); finish(false); }
  };

  // One recogniser session. The hold outlives it: browser recognisers end
  // on their own schedule — Safari after a pause in speech, Chrome after a
  // few seconds of silence ("no-speech") — and `continuous` does not change
  // that in practice. Ending the hold with them meant dictation cut out
  // while Space was still down and whatever came next was lost. So a
  // recogniser that ends while the key is held is simply replaced; the words
  // already final are kept, and only OUR stop() finishes the hold.
  const listen = (Ctor: new () => RecognitionLike): boolean => {
    let r: RecognitionLike;
    try { r = new Ctor(); } catch { return false; }
    let heard = false;
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      heard = true;
      emptyRestarts = 0;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      interimText = interim;
      opts.setOverlay((finalText + interim).trim());
    };
    const ended = () => {
      if (!active || rec !== r) return;      // an old recogniser, or already finished
      if (stopping) { finish(true); return; } // released: type what we have
      // A finished phrase is folded in; the interim is gone with the session.
      interimText = "";
      // Three recognisers in a row that heard nothing is the service refusing
      // us, not silence — give the space bar back rather than spin forever.
      if (!heard && ++emptyRestarts >= 3) { finish(true); return; }
      opts.setOverlay(finalText.trim());
      if (!listen(Ctor)) finish(true);
    };
    r.onerror = (ev) => {
      const code = ev?.error || "unknown";
      // Quiet or interrupted while still held: not a failure, just this
      // recogniser's session ending — the onend that follows restarts it.
      if (active && !stopping && (code === "no-speech" || code === "aborted")) return;
      // EVERY real failure explains itself. Only mic-denial was surfaced
      // before; Chrome's cloud recogniser routinely fails with "network",
      // and that silent death read as "voice randomly doesn't work".
      if (code === "not-allowed" || code === "service-not-allowed") {
        opts.notify("Microphone permission needed for voice input");
      } else if (code === "network") {
        opts.notify("Voice recognition unreachable (browser speech service) — try again");
      } else if (code === "no-speech") {
        opts.notify("No speech detected");
      } else if (code !== "aborted") {
        opts.notify(`Voice input failed: ${code}`);
      }
      finish(false);
    };
    r.onend = ended;
    rec = r;
    try { r.start(); } catch { rec = null; return false; }
    return true;
  };

  const stop = () => {
    const r = rec;
    stopping = true;
    try { r?.stop(); } catch { /* already gone */ }
    rec = null;
    // Finish on OUR schedule rather than waiting for the recogniser's onend.
    // A recogniser that never fires one (it happens: the service drops, the
    // tab backgrounds, permission is revoked mid-hold) left `active` stuck
    // true — and since every space is deliberately eaten while active, that
    // is a terminal that cannot type a space AT ALL. onend arriving later is
    // harmless; finish() is a no-op once inactive.
    finish(true);
  };

  // Last line of defence. Nothing should hold the microphone for a minute,
  // and no failure mode of this controller may leave the space bar dead.
  const armWatchdog = () => {
    window.clearTimeout(watchdog);
    watchdog = window.setTimeout(() => { if (active) stop(); }, MAX_HOLD_MS);
  };
  // Releasing space outside the terminal (window switch mid-hold) means the
  // keyup never arrives, so end the hold when focus leaves.
  const onWindowBlur = () => {
    if (active) stop();
    else { window.clearTimeout(timer); pending = false; }
  };

  /**
   * Feed every key event here first. Returns:
   *  false — consumed (swallow), true — let the terminal process it,
   *  undefined — not a voice-relevant event; continue with other branches.
   */
  const handleKey = (ev: {
    type: string; code: string; key: string; repeat?: boolean;
    metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean;
    preventDefault?: () => void;
  }): boolean | undefined => {
    /** Refuse the key AND stop the browser acting on it. */
    const swallow = () => {
      try { ev.preventDefault?.(); } catch { /* synthetic event in a test */ }
      return false;
    };
    // Return, mid-dictation, ENDS it and keeps the words (Jian). Without
    // this the Enter fell through to the terminal while the recogniser was
    // still running: a bare newline hit the composer, and the transcript
    // landed after it — the one key you would reach for to finish a thought
    // was the one that split it in half. Swallowed rather than passed on, so
    // this inserts and does not also submit; a second Return sends it.
    if (active && ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"
                                            || ev.code === "NumpadEnter")) {
      stop();
      return swallow();
    }
    // A keypress carries no `code` in some engines; fall back to the key.
    const isSpace = ev.code === "Space" || (ev.type === "keypress" && ev.key === " ");
    if (isSpace && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey
        && !!speechRecognitionCtor() && (active || pending || opts.eligible())) {
      if (ev.type === "keydown") {
        if (active) {
          // A genuine auto-repeat is the only thing that may be eaten while
          // listening. `repeat` is the honest signal: a FRESH press cannot be
          // part of the hold in progress, so the hold is over — whether the
          // keyup was lost to a window switch or the recogniser wedged. End
          // it and fall through: the press below types via its keypress.
          if (ev.repeat) return swallow();
          stop();
        }
        if (!ev.repeat) {
          window.clearTimeout(timer);
          pending = true;
          // Types via the keypress this keydown will spawn; counted so a
          // matured hold knows to erase it.
          spacesTyped = 1;
          timer = window.setTimeout(start, threshold);
          return true;
        }
        // Auto-repeat while held: preventDefault suppresses its keypress,
        // so nothing reaches the composer.
        return swallow();
      }
      if (ev.type === "keypress") {
        // THE typing event (see header). Passes untouched unless dictation
        // is live — a pending hold's keypress is the ordinary space itself.
        return active ? swallow() : undefined;
      }
      if (ev.type === "keyup") {
        window.clearTimeout(timer);
        pending = false;
        spacesTyped = 0;
        if (active) { stop(); return swallow(); }
        return true;
      }
      return undefined;
    }
    // Any other keydown cancels a pending (not yet active) hold.
    if (ev.type === "keydown" && ev.code !== "Space") {
      window.clearTimeout(timer);
      pending = false;
    }
    return undefined;
  };

  const dispose = () => {
    window.clearTimeout(timer);
    window.clearTimeout(watchdog);
    window.removeEventListener("blur", onWindowBlur);
    if (active) { try { rec?.stop(); } catch { /* gone */ } }
    active = false;
    pending = false;
    rec = null;
    opts.setOverlay(null);
  };

  return { handleKey, dispose, isActive: () => active };
};

/**
 * Is this surface running Claude Code? Used for KEY ENCODING (Shift+Enter's
 * CSI-u) and voice eligibility, so it must stay true for RESTORED sessions:
 * an argv-launched restore (`shell -lc "claude …; exec shell -l"`) reports
 * the wrapper shell as the foreground process forever, so a process-only
 * check goes false on every session that came back through `hop restore`.
 * The terminal's own chrome is the honest second witness.
 */
export const isClaudeSurface = (
  foregroundIsClaude: boolean,
  terminal: Parameters<typeof bufferLooksLikeClaude>[0] | null | undefined
): boolean => foregroundIsClaude || (!!terminal && bufferLooksLikeClaude(terminal));

/** Claude chrome scan over a terminal's visible rows — shared eligibility. */
export const bufferLooksLikeClaude = (t: {
  rows: number;
  buffer: { active: { baseY: number; getLine: (row: number) => { translateToString: (trim: boolean) => string } | undefined } };
}): boolean => {
  try {
    const end = t.buffer.active.baseY + t.rows;
    let text = "";
    for (let i = Math.max(0, end - 30); i < end; i++) {
      text += (t.buffer.active.getLine(i)?.translateToString(true) ?? "") + "\n";
    }
    return /bypass permissions on|shift\+tab to cycle|esc to interrupt|\? for shortcuts/i.test(text);
  } catch {
    return false;
  }
};
