import { describe, expect, it } from "vitest";
import { desktopUrl } from "../src/components/DesktopView";

describe("desktop socket url", () => {
  it("points the terminal socket's url at the desktop pipe, keeping its query", () => {
    expect(desktopUrl("wss://hop.example.test/ws")).toBe("wss://hop.example.test/desktop/ws");
    expect(desktopUrl("ws://127.0.0.1:4000/ws?token=ll_x")).toBe("ws://127.0.0.1:4000/desktop/ws?token=ll_x");
  });
});
