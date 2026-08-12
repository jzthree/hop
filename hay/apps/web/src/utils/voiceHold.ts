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
  let timer = 0;
  let active = false;
  let spacesTyped = 0;
  let finalText = "";
  let interimText = "";
  let rec: RecognitionLike | null = null;

  const finish = (sendText: boolean) => {
    if (!active) return;
    active = false;
    rec = null;
    opts.setOverlay(null);
    const text = (finalText || interimText).trim();
    finalText = "";
    interimText = "";
    if (sendText && text) opts.send(text);
  };

  const start = () => {
    if (active) return;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    let r: RecognitionLike;
    try { r = new Ctor(); } catch { return; }
    active = true;
    finalText = "";
    interimText = "";
    // Erase every space that reached the app during this hold.
    for (let i = 0; i < Math.max(1, spacesTyped); i++) opts.send("\x7f");
    spacesTyped = 0;
    r.lang = navigator.language || "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      interimText = interim;
      opts.setOverlay((finalText + interim).trim());
    };
    r.onerror = (ev) => {
      // EVERY failure explains itself. Only mic-denial was surfaced before;
      // Chrome's cloud recognizer routinely fails with "network", and that
      // silent death read as "voice randomly doesn't work".
      const code = ev?.error || "unknown";
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
    r.onend = () => finish(true);
    rec = r;
    opts.setOverlay("");
    try { r.start(); } catch { finish(false); }
  };

  const stop = () => {
    const r = rec;
    if (r) { try { r.stop(); } catch { finish(true); } }
    else finish(true);
  };

  /**
   * Feed every key event here first. Returns:
   *  false — consumed (swallow), true — let the terminal process it,
   *  undefined — not a voice-relevant event; continue with other branches.
   */
  const handleKey = (ev: { type: string; code: string; key: string; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): boolean | undefined => {
    // Return, mid-dictation, ENDS it and keeps the words (Jian). Without
    // this the Enter fell through to the terminal while the recogniser was
    // still running: a bare newline hit the composer, and the transcript
    // landed after it — the one key you would reach for to finish a thought
    // was the one that split it in half. Swallowed rather than passed on, so
    // this inserts and does not also submit; a second Return sends it.
    if (active && ev.type === "keydown" && (ev.key === "Enter" || ev.code === "Enter"
                                            || ev.code === "NumpadEnter")) {
      stop();
      return false;
    }
    if (ev.code === "Space" && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey
        && !!speechRecognitionCtor() && (active || opts.eligible())) {
      if (ev.type === "keydown") {
        if (active) return false; // listening: eat every space
        if (!ev.repeat) {
          window.clearTimeout(timer);
          spacesTyped = 1; // this one goes through, for zero latency
          timer = window.setTimeout(start, threshold);
          return true;
        }
        return false; // swallow auto-repeat while held
      }
      if (ev.type === "keyup") {
        window.clearTimeout(timer);
        spacesTyped = 0;
        if (active) { stop(); return false; }
        return true;
      }
      return undefined;
    }
    // Any other keydown cancels a pending (not yet active) hold.
    if (ev.type === "keydown" && ev.code !== "Space") window.clearTimeout(timer);
    return undefined;
  };

  const dispose = () => {
    window.clearTimeout(timer);
    if (active) { try { rec?.stop(); } catch { /* gone */ } }
    active = false;
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
