import { describe, expect, it } from "vitest";
import { currentWsBase, isLocalLinkUrl, localLinkEligible, noteSocketClosed } from "../src/utils/localLink";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const pub = { protocol: "https:", hostname: "hop.zhoulab.io" };

describe("same-machine fast path", () => {
  it("is tried from a desktop browser on the public hostname", () => {
    expect(localLinkEligible(pub, MAC, 0)).toBe(true);
  });
  it("is not tried from a phone or an iPad posing as a Mac", () => {
    expect(localLinkEligible(pub, IPHONE, 5)).toBe(false);
    expect(localLinkEligible(pub, MAC, 5)).toBe(false);
  });
  it("is not tried when the page is already local", () => {
    expect(localLinkEligible({ protocol: "http:", hostname: "localhost" }, MAC, 0)).toBe(false);
    expect(localLinkEligible({ protocol: "https:", hostname: "127.0.0.1" }, MAC, 0)).toBe(false);
  });
  it("recognises a fast-path socket url", () => {
    expect(isLocalLinkUrl("ws://127.0.0.1:13575/ws?token=ll_x&room=a")).toBe(true);
    expect(isLocalLinkUrl("wss://hop.zhoulab.io/ws?room=a")).toBe(false);
  });
  it("hands tiles the tunnel base while there is no fast path", () => {
    expect(currentWsBase("wss://hop.zhoulab.io/ws")).toBe("wss://hop.zhoulab.io/ws");
    // A tunnel socket that never opened says nothing about the fast path.
    noteSocketClosed("wss://hop.zhoulab.io/ws?room=a", false);
    expect(currentWsBase("wss://hop.zhoulab.io/ws")).toBe("wss://hop.zhoulab.io/ws");
  });
});
