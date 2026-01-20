import { describe, expect, it } from "vitest";
import { sortPresence } from "../src/utils/presence";

const makeClient = (id: string, name: string) => ({
  id,
  name,
  color: "#fff",
  typing: false,
  lastActive: Date.now()
});

describe("sortPresence", () => {
  it("keeps self at the top", () => {
    const clients = [makeClient("b", "Blake"), makeClient("a", "Alex")];
    const sorted = sortPresence(clients, "a");
    expect(sorted[0].id).toBe("a");
  });
});
