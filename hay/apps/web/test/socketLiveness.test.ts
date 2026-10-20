import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchLiveness } from "../src/utils/socketLiveness";

// A socket that only does what the test tells it to.
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  closes = 0;
  answers = false;
  send(data: string) {
    this.sent.push(data);
    if (this.answers) this.hear();
  }
  close() { this.readyState = WebSocket.CLOSING; }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  hear() { this.dispatchEvent(new MessageEvent("message", { data: "{}" })); }
}

const watched = () => {
  const sock = new FakeSocket();
  watchLiveness(sock as unknown as WebSocket);
  sock.addEventListener("close", () => { sock.closes += 1; });
  return sock;
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("socket liveness", () => {
  it("gives up on a handshake that hangs", () => {
    const sock = watched();
    vi.advanceTimersByTime(7500);
    expect(sock.closes).toBe(0);
    vi.advanceTimersByTime(2500);
    expect(sock.closes).toBe(1);
  });

  it("leaves a quiet socket that answers its ping alone", () => {
    const sock = watched();
    sock.answers = true;
    sock.open();
    vi.advanceTimersByTime(17500);
    expect(sock.sent.some((s) => JSON.parse(s).type === "ping")).toBe(true);
    vi.advanceTimersByTime(60000);
    expect(sock.closes).toBe(0);
  });

  it("closes an open socket that stops answering, once", () => {
    const sock = watched();
    sock.open();
    vi.advanceTimersByTime(30000);
    expect(sock.closes).toBe(1);
    // The browser's own close, when it finally comes, is not a second one.
    sock.dispatchEvent(new CloseEvent("close"));
    expect(sock.closes).toBe(1);
  });

  it("pings at once after a sleep", () => {
    const sock = watched();
    sock.open();
    vi.setSystemTime(Date.now() + 10 * 60000); // the laptop slept; timers did not run
    vi.advanceTimersByTime(2500);
    expect(sock.sent.length).toBe(1);
    expect(sock.closes).toBe(0);
  });
});
