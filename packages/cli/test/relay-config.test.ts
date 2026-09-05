/**
 * The two URL normalisers, which are the only part of `relay-config.ts` with
 * a decision in it: everything else is a file read or a delegation to
 * `@piorbit/crypto` (already tested there).
 *
 * They matter because both refusals are security answers, not tidiness.
 * `ws://` to a remote host leaks the channel id — a bearer capability for one
 * device's slot — to every hop between here and the relay, and an http origin
 * gives a phone no service worker, no camera and no installable app. Getting
 * either wrong fails quietly at pairing time, on someone else's machine.
 */
import { describe, expect, it } from "vitest";

import { normalizePublicOrigin, normalizeRelayUrl } from "../src/relay-config.js";

describe("normalizeRelayUrl", () => {
  it("keeps a wss URL and its path", () => {
    expect(normalizeRelayUrl("wss://relay.example.com/ws")).toBe("wss://relay.example.com/ws");
  });

  it("assumes wss when no scheme is given", () => {
    expect(normalizeRelayUrl("relay.example.com/ws")).toBe("wss://relay.example.com/ws");
  });

  it("accepts the https spelling people paste from a browser", () => {
    expect(normalizeRelayUrl("https://relay.example.com/ws")).toBe("wss://relay.example.com/ws");
  });

  it("allows ws:// only on this machine", () => {
    expect(normalizeRelayUrl("ws://localhost:8080/ws")).toBe("ws://localhost:8080/ws");
    expect(normalizeRelayUrl("ws://127.0.0.1:8080/ws")).toBe("ws://127.0.0.1:8080/ws");
    expect(() => normalizeRelayUrl("ws://relay.example.com/ws")).toThrow(/must be wss/);
  });

  it("refuses a scheme that is not a WebSocket at all", () => {
    expect(() => normalizeRelayUrl("ftp://relay.example.com")).toThrow(/not a WebSocket scheme/);
  });

  it("refuses something that is not a URL", () => {
    expect(() => normalizeRelayUrl("relay example")).toThrow(/is not a URL/);
  });
});

describe("normalizePublicOrigin", () => {
  it("reduces to the origin, dropping any path", () => {
    expect(normalizePublicOrigin("https://app.example.com/link?x=1")).toBe("https://app.example.com");
  });

  it("assumes https when no scheme is given", () => {
    expect(normalizePublicOrigin("app.example.com")).toBe("https://app.example.com");
  });

  it("allows http only on this machine", () => {
    expect(normalizePublicOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(() => normalizePublicOrigin("http://app.example.com")).toThrow(/is not https/);
  });
});
