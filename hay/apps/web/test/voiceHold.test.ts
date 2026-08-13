import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceHold } from "../src/utils/voiceHold";

// A stand-in for the browser's SpeechRecognition, so a hold can be driven to
// completion without a microphone.
class FakeRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((ev: unknown) => void) | null = null;
  onerror: ((ev: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  static last: FakeRecognition | null = null;
  constructor() { FakeRecognition.last = this; }
  start() { this.started = true; }
  stop() { this.onend?.(); }
}

// The event shapes xterm actually hands a custom key handler. Measured
// behavior (both regressions came from assuming otherwise): xterm types a
// plain printable from the KEYPRESS, which the browser fires only when the
// keydown was not defaultPrevented.
const keydown = (opts: Partial<{ repeat: boolean }> = {}) =>
  ({ type: "keydown", code: "Space", key: " ", repeat: false, ...opts, preventDefault: vi.fn() });
const keypress = () => ({ type: "keypress", code: "Space", key: " ", preventDefault: vi.fn() });
const keyup = () => ({ type: "keyup", code: "Space", key: " ", preventDefault: vi.fn() });

/** Drive one browser-faithful key sequence: keypress fires only if the
 *  keydown was not prevented, and "typed" means the keypress reached the
 *  terminal unrefused — the exact condition under which xterm emits the
 *  character to the PTY. */
const pressSpace = (hold: ReturnType<typeof createVoiceHold>, opts: Partial<{ repeat: boolean }> = {}) => {
  const kd = keydown(opts);
  const kdVerdict = hold.handleKey(kd);
  const kdPrevented = (kd.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0;
  let typed = false;
  if (!kdPrevented) {
    const kp = keypress();
    const kpVerdict = hold.handleKey(kp);
    const kpPrevented = (kp.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    typed = kpVerdict !== false && !kpPrevented;
  }
  return { kdVerdict, typed };
};

let sent: string[];
let notices: string[];
let overlays: (string | null)[];

const makeHold = (eligible = true) => {
  sent = []; notices = []; overlays = [];
  return createVoiceHold({
    send: (d) => sent.push(d),
    notify: (m) => notices.push(m),
    setOverlay: (o) => overlays.push(o),
    eligible: () => eligible,
    thresholdMs: 500
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
  FakeRecognition.last = null;
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
});

describe("hold-space dictation", () => {
  it("an ordinary tap TYPES its space — the keypress passes through", () => {
    // The second regression, distilled: `pending` is true for the fleeting
    // moment between keydown and keyup of EVERY normal space, and the
    // keypress inside that window is the event that actually types. Eating
    // it made hop unable to type a space at all.
    const hold = makeHold();
    const { kdVerdict, typed } = pressSpace(hold);
    expect(kdVerdict).toBe(true);
    expect(typed).toBe(true);
    expect(hold.handleKey(keyup())).toBe(true);
    // And again — nothing latches.
    expect(pressSpace(hold).typed).toBe(true);
  });

  it("holding space types exactly one space, not one per auto-repeat", () => {
    // The first regression: swallowed repeat keydowns without preventDefault
    // let the browser fire their keypresses, which typed a space each.
    const hold = makeHold();

    // First press: the space goes through for zero latency.
    expect(pressSpace(hold).typed).toBe(true);

    // Auto-repeat, as the OS delivers it. preventDefault on the keydown is
    // what suppresses the browser's keypress, so `typed` must stay false.
    for (let i = 0; i < 8; i++) {
      const rep = pressSpace(hold, { repeat: true });
      expect(rep.kdVerdict).toBe(false);
      expect(rep.typed).toBe(false);
    }

    // Nothing was sent to the terminal by the controller itself yet.
    expect(sent).toEqual([]);
  });

  it("crossing the threshold erases the typed space and starts listening", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    expect(hold.isActive()).toBe(false);

    vi.advanceTimersByTime(500);
    expect(hold.isActive()).toBe(true);
    // The zero-latency space is erased, exactly once.
    expect(sent).toEqual(["\x7f"]);
    expect(FakeRecognition.last?.started).toBe(true);
    expect(overlays[overlays.length - 1]).toBe("");
  });

  it("swallows every space while listening, including keypress", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    sent.length = 0;

    expect(hold.handleKey(keydown({ repeat: true }))).toBe(false);
    const press = keypress();
    expect(hold.handleKey(press)).toBe(false);
    expect(press.preventDefault).toHaveBeenCalled();
    // No stray spaces reach the composer mid-dictation.
    expect(sent).toEqual([]);
  });

  it("releasing types the transcript and never submits it", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    sent.length = 0;

    FakeRecognition.last!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "hello there" } }]
    });
    hold.handleKey(keyup());

    expect(sent).toEqual(["hello there"]);
    expect(sent.join("")).not.toContain("\r");
    expect(hold.isActive()).toBe(false);
  });

  it("a quick tap is an ordinary space — no erase, no listening", () => {
    const hold = makeHold();
    expect(hold.handleKey(keydown())).toBe(true);
    vi.advanceTimersByTime(120);
    expect(hold.handleKey(keyup())).toBe(true);
    vi.advanceTimersByTime(1000);

    expect(hold.isActive()).toBe(false);
    // A tap must not erase the space it just typed.
    expect(sent).toEqual([]);
  });

  it("a keypress outside any hold is left alone", () => {
    const hold = makeHold();
    // Nothing held: the terminal owns this key entirely.
    expect(hold.handleKey(keypress())).toBe(undefined);
  });

  it("stays out of the way when the surface is not a Claude composer", () => {
    const hold = makeHold(false);
    expect(hold.handleKey(keydown())).toBe(undefined);
    expect(hold.handleKey(keypress())).toBe(undefined);
    vi.advanceTimersByTime(1000);
    expect(hold.isActive()).toBe(false);
  });

  it("another key cancels a hold that has not started yet", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    hold.handleKey({ type: "keydown", code: "KeyA", key: "a", preventDefault: vi.fn() });
    vi.advanceTimersByTime(1000);

    expect(hold.isActive()).toBe(false);
    // A cancelled hold must not erase anything.
    expect(sent).toEqual([]);
    // ...and a later space is an ordinary space again.
    expect(hold.handleKey(keypress())).toBe(undefined);
  });

  it("Enter mid-dictation keeps the words instead of splitting the thought", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    sent.length = 0;
    FakeRecognition.last!.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "the end" } }]
    });

    const enter = { type: "keydown", code: "Enter", key: "Enter", preventDefault: vi.fn() };
    expect(hold.handleKey(enter)).toBe(false);
    expect(enter.preventDefault).toHaveBeenCalled();
    // The transcript lands; the newline does not.
    expect(sent).toEqual(["the end"]);
  });

  it("explains itself when speech recognition is unavailable", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    // Vanishes between the press and the threshold (or was never real).
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    vi.advanceTimersByTime(500);

    expect(hold.isActive()).toBe(false);
    expect(notices.join(" ")).toMatch(/not supported/i);
  });

  it("surfaces the reason when recognition fails mid-hold", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    FakeRecognition.last!.onerror?.({ error: "network" });

    expect(hold.isActive()).toBe(false);
    expect(notices.join(" ")).toMatch(/unreachable/i);
    expect(overlays[overlays.length - 1]).toBe(null);
  });

  it("a recogniser that never ends cannot kill the space bar", () => {
    // The regression that bit Jian: dictation started, the recogniser never
    // fired onend, `active` stuck true — and because every space is eaten
    // while active, the terminal could not type a space AT ALL.
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    expect(hold.isActive()).toBe(true);

    // Release. stop() must finish on our own schedule, not the recogniser's.
    FakeRecognition.last!.onend = null;      // it simply never calls back
    hold.handleKey(keyup());
    expect(hold.isActive()).toBe(false);

    // And the very next space types, as an ordinary space.
    sent.length = 0;
    expect(pressSpace(hold).typed).toBe(true);
  });

  it("a space always types even if a hold got stuck with the key up", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    expect(hold.isActive()).toBe(true);

    // The keyup never arrives (window switch, focus loss, a dropped event).
    // A FRESH press must still reach the terminal rather than be swallowed.
    const fresh = pressSpace(hold);
    expect(fresh.kdVerdict).toBe(true);
    expect(fresh.typed).toBe(true);
    expect(hold.isActive()).toBe(false); // the stuck hold was ended, not honoured
  });

  it("losing focus mid-hold ends it instead of leaving it armed", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    expect(hold.isActive()).toBe(true);

    window.dispatchEvent(new Event("blur"));
    expect(hold.isActive()).toBe(false);
    // Space works immediately afterwards.
    expect(pressSpace(hold).typed).toBe(true);
  });

  it("a hold cannot outlive the watchdog", () => {
    const hold = makeHold();
    hold.handleKey(keydown());
    vi.advanceTimersByTime(500);
    expect(hold.isActive()).toBe(true);

    vi.advanceTimersByTime(60000);
    expect(hold.isActive()).toBe(false) // nothing may hold the mic indefinitely
  });

});
