import { describe, expect, it, vi } from "vitest";
import { notifyAccountsChanged, onAccountsMaybeChanged } from "./accountsChanged";

describe("accounts read again", () => {
  it("at once when Settings changes them; on coming back to the front, not more than every so often", () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const off = onAccountsMaybeChanged(reload, 30_000);
    notifyAccountsChanged();
    expect(reload).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(1); // just read
    vi.advanceTimersByTime(31_000);
    window.dispatchEvent(new Event("focus"));
    expect(reload).toHaveBeenCalledTimes(2);
    off();
    notifyAccountsChanged();
    expect(reload).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
