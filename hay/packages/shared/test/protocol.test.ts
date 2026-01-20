import { describe, expect, it } from "vitest";
import { safeParseClientMessage, safeParseServerMessage } from "../src/protocol";

describe("protocol parsing", () => {
  it("accepts a valid client input message", () => {
    const parsed = safeParseClientMessage(JSON.stringify({ type: "input", data: "ls" }));
    expect(parsed).toEqual({ type: "input", data: "ls" });
  });

  it("rejects invalid client payload", () => {
    const parsed = safeParseClientMessage(JSON.stringify({ type: "input", data: 12 }));
    expect(parsed).toBeNull();
  });

  it("accepts presence payloads", () => {
    const parsed = safeParseServerMessage(
      JSON.stringify({
        type: "presence",
        clients: [
          {
            id: "a",
            name: "Casey",
            color: "#fff",
            typing: false,
            lastActive: 1
          }
        ]
      })
    );

    expect(parsed?.type).toBe("presence");
  });
});
