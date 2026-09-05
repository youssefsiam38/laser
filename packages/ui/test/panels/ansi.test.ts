import { describe, expect, it } from "vitest";

import { color256, parseAnsi, stripAnsi } from "../../src/panels/ansi.js";

describe("parseAnsi", () => {
  it("interprets SGR colours and attributes into spans", () => {
    const { spans } = parseAnsi("plain \x1b[1;31merror\x1b[0m done");
    expect(spans).toEqual([
      { text: "plain " },
      { text: "error", bold: true, fg: 1 },
      { text: " done" },
    ]);
  });

  it("handles 256 and truecolour, bright colours and resets of one attribute", () => {
    const { spans } = parseAnsi("\x1b[38;5;196mA\x1b[48;2;10;20;30mB\x1b[92mC\x1b[39mD\x1b[22mE");
    expect(spans[0]).toMatchObject({ text: "A", fg: "rgb(255 0 0)" });
    expect(spans[1]).toMatchObject({ text: "B", fg: "rgb(255 0 0)", bg: "rgb(10 20 30)" });
    expect(spans[2]).toMatchObject({ text: "C", fg: 10 });
    expect(spans[3]!.fg).toBeUndefined();
    expect(spans[3]).toMatchObject({ text: "DE", bg: "rgb(10 20 30)" });
    expect(color256(232)).toBe("rgb(8 8 8)");
    expect(color256(7)).toBe(7);
  });

  it("strips everything that is not colour: cursor moves, clears, OSC titles and hyperlinks", () => {
    const text = "\x1b]0;title\x07\x1b[2J\x1b[Hstart\x1b[3Aend\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\";
    expect(stripAnsi(text)).toBe("startendlink");
    expect(parseAnsi(text).spans).toEqual([{ text: "startendlink" }]);
  });

  it("carries style across chunks, so a tail read mid-sequence keeps its colour", () => {
    const first = parseAnsi("\x1b[32mgreen ");
    const second = parseAnsi("still green\x1b[0m", first.style);
    expect(second.spans[0]).toMatchObject({ text: "still green", fg: 2 });
  });
});
