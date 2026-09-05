import { describe, expect, it } from "vitest";
import { LineDecoder, isNotification, isRequest, isResponse } from "../src/index.js";

describe("LineDecoder", () => {
  it("splits on LF only and strips CR", () => {
    const d = new LineDecoder();
    expect(d.push('{"a":1}\r\n{"b":"x y"}\n{"c"')).toEqual(['{"a":1}', '{"b":"x y"}']);
    expect(d.push(":3}\n")).toEqual(['{"c":3}']);
    expect(d.end()).toEqual([]);
  });
});

describe("message guards", () => {
  it("classifies request, notification, response", () => {
    expect(isRequest({ jsonrpc: "2.0", id: 1, method: "x", params: {} })).toBe(true);
    expect(isNotification({ jsonrpc: "2.0", method: "x", params: {} })).toBe(true);
    expect(isResponse({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true);
  });
});
