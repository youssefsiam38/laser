/**
 * The startup timeline (M16-T30).
 *
 * A launch that felt slow is unanswerable after the fact unless the shell
 * wrote down when each of its steps happened. These pin what that costs and
 * what it may contain: one line per milestone, written once, and nothing in
 * any of them beyond a fixed name and a number — a log a person sends to us
 * must not carry a path, a URL or a word of their conversation.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DesktopLog, STARTUP_MILESTONES } from "../src/log.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-timeline-"));
  file = join(dir, "desktop.log");
  // The timeline is the only thing under test; stderr is noise here.
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const timeline = (): string[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("startup: "))
    .map((line) => line.slice(line.indexOf("startup: ")));

describe("the startup timeline", () => {
  it("writes one line per milestone, with the milliseconds since launch", () => {
    const log = new DesktopLog(file);
    log.milestone("process entered");
    log.milestone("app ready");
    log.milestone("window created");
    log.milestone("window ready to show");
    log.milestone("host ready");
    log.milestone("app loaded");

    expect(timeline()).toEqual([
      expect.stringMatching(/^startup: process entered at \d+ms$/),
      expect.stringMatching(/^startup: app ready at \d+ms$/),
      expect.stringMatching(/^startup: window created at \d+ms$/),
      expect.stringMatching(/^startup: window ready to show at \d+ms$/),
      expect.stringMatching(/^startup: host ready at \d+ms$/),
      expect.stringMatching(/^startup: app loaded at \d+ms$/),
    ]);
  });

  it("records a milestone once, however often it happens", () => {
    const log = new DesktopLog(file);
    log.milestone("window created");
    log.milestone("window created");
    log.milestone("window ready to show");
    log.milestone("window created");

    expect(timeline()).toHaveLength(2);
  });

  it("keeps every launch line free of anything but a fixed name and a number", () => {
    const log = new DesktopLog(file);
    for (const name of STARTUP_MILESTONES) log.milestone(name);

    const names = timeline().map((line) => /^startup: (.+) at \d+ms$/.exec(line)?.[1]);
    expect(names).toEqual([...STARTUP_MILESTONES]);
    // `milestone()` takes one of these names and nothing else: a path, a URL or
    // a piece of a transcript cannot be spelled as one, and TypeScript refuses
    // a variable in its place. This is the runtime half of that guarantee.
    expect(STARTUP_MILESTONES.every((name) => /^[a-z ]+$/.test(name))).toBe(true);
  });

  it("covers the whole launch: every milestone has somewhere it is written", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const sources = ["main.ts", "windows.ts"].map((name) => readFileSync(join(src, name), "utf8")).join("\n");
    // A name nothing writes is a hole in the timeline: the launch it was meant
    // to explain would be missing a step and nobody would notice until the log
    // was needed.
    for (const name of STARTUP_MILESTONES) expect(sources).toContain(`"${name}"`);
  });
});
