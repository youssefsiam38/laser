import { PRODUCT_DISPLAY_NAME, PRODUCT_NAME } from "@lasercode/protocol";
import { sep } from "node:path";
import { describe, expect, it } from "vitest";

import { unpacked } from "../src/host-control.js";
import { sanitize, sanitizeDeep } from "../src/output.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * Both of these are silent when they are wrong. A path inside `app.asar` looks
 * fine to every check that runs inside Electron (its `fs` is asar-aware) and
 * only fails in the bundled Node that actually runs the host; an escape
 * sequence in a run title prints as nothing at all and retitles the terminal.
 */
describe("unpacked", () => {
  it("rewrites a path inside app.asar to the unpacked copy", () => {
    const inside = ["", "Applications", `${PRODUCT_DISPLAY_NAME}.app`, "Contents", "Resources", "app.asar", "node_modules", "@lasercode", "cli", "dist", "main.js"].join(sep);
    expect(unpacked(inside)).toBe(inside.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`));
  });

  it("leaves a development path alone", () => {
    const dev = ["", "home", "me", PRODUCT_NAME, "packages", "cli", "dist", "main.js"].join(sep);
    expect(unpacked(dev)).toBe(dev);
  });

  it("does not touch a directory that merely starts with app.asar", () => {
    const decoy = ["", "srv", "app.asarbackup", "dist", "main.js"].join(sep);
    expect(unpacked(decoy)).toBe(decoy);
  });
});

describe("sanitizeDeep", () => {
  it("strips escapes from every string in a panel, at any depth", () => {
    // An OSC that retitles the terminal, and a CSI that clears the scrollback.
    const title = `worker#2${ESC}]0;pwned${BEL}`;
    const label = `build${ESC}[2J`;
    const panel = { kind: "run", title, steps: [{ label }], usage: { input: 10, costUsd: null } };
    expect(sanitizeDeep(panel)).toEqual({
      kind: "run",
      title: sanitize(title),
      steps: [{ label: sanitize(label) }],
      usage: { input: 10, costUsd: null },
    });
    // And the escapes really are gone, not merely equal to themselves.
    expect(sanitizeDeep(panel).title).not.toContain(ESC);
    expect(sanitizeDeep(panel).title).toBe("worker#2");
    expect(sanitizeDeep(panel).steps[0]!.label).toBe("build");
  });

  it("keeps newlines and tabs, which a ledger is made of", () => {
    expect(sanitizeDeep("# Mission\n\n- one\tthing")).toBe("# Mission\n\n- one\tthing");
  });

  it("leaves non-strings alone", () => {
    expect(sanitizeDeep({ n: 1, b: true, z: null, u: undefined })).toEqual({ n: 1, b: true, z: null, u: undefined });
  });
});
