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

  it("accepts hello with and without the optional created flag", () => {
    const base = {
      type: "hello",
      clientId: "c1",
      roomId: "r1",
      color: "#fff",
      collabMode: true,
      controllerId: null
    };
    const withoutCreated = safeParseServerMessage(JSON.stringify(base));
    expect(withoutCreated?.type).toBe("hello");

    const withCreated = safeParseServerMessage(JSON.stringify({ ...base, created: true }));
    expect(withCreated?.type).toBe("hello");
    expect(withCreated && "created" in withCreated ? withCreated.created : undefined).toBe(true);
  });

  it("accepts session_ended with and without the optional by field", () => {
    const base = {
      type: "session_ended",
      exitCode: 137,
      signal: "SIGKILL",
      message: "Session ended"
    };
    const withoutBy = safeParseServerMessage(JSON.stringify(base));
    expect(withoutBy?.type).toBe("session_ended");

    const withBy = safeParseServerMessage(JSON.stringify({ ...base, by: "alice" }));
    expect(withBy?.type).toBe("session_ended");
    expect(withBy && "by" in withBy ? withBy.by : undefined).toBe("alice");
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
