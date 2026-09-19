/**
 * The overlay's visual values all come from the theme, and its chrome is
 * hairlines and ground changes rather than boxes inside boxes.
 *
 * `docs/ux-theme.md` T1 says a literal colour, a raw `px` size or an
 * arbitrary spacing step in a component is a bug and that the reviewer greps
 * for them. This is that grep, run every time, over the one tree this leap
 * owns. `DESIGN.md` "Do not" adds the second half: a card is the dialog
 * itself, never a bordered rounded box holding one row inside it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../src/source-control", import.meta.url));
const sources = readdirSync(dir)
  .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

/** Class attributes only: prose and comments may say whatever they need to. */
function classLists(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/className=(?:"([^"]*)"|\{(?:cn\()?([\s\S]*?)\}\s*\n?)/g)) {
    out.push(match[1] ?? match[2] ?? "");
  }
  for (const match of text.matchAll(/"([a-z0-9-]+(?::[a-z0-9-[\]()_.,%/]+)*(?:\s+[^"]*)?)"/g)) {
    out.push(match[1] ?? "");
  }
  return out;
}

it("names no colour, no raw type size and no arbitrary spacing step", () => {
  const offenders: string[] = [];
  for (const { name, text } of sources) {
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) && /className|style|color/.test(line)) offenders.push(`${name}: ${line.trim()}`);
      if (/\boklch\(|\brgba?\(|\bhsla?\(/.test(line)) offenders.push(`${name}: ${line.trim()}`);
      // `text-[13px]`, `p-[7px]`, `w-[240px]`, `gap-[3px]` — a value off the
      // scale. A viewport-relative cap (`max-h-[calc(100dvh-2rem)]`) is
      // geometry the scale has no name for, and stays allowed.
      for (const arbitrary of line.matchAll(
        /\b(?:text|p|px|py|pt|pb|ps|pe|m|mx|my|ms|me|gap|w|h|size|min-w|min-h|max-w|max-h)-\[([^\]]*)\]/g,
      )) {
        const value = arbitrary[1] ?? "";
        if (/\d(?:px|rem|em)\b/.test(value) && !/\b\d+(?:dvh|dvw|svh|vh|vw)\b|env\(/.test(value)) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
      // 11px is the eyebrow, and an eyebrow is a category label, never a value.
      if (/\btext-2xs\b/.test(line)) offenders.push(`${name}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});

it("draws no card inside a card: one border, or a hairline and a ground", () => {
  const offenders: string[] = [];
  for (const { name, text } of sources) {
    for (const classes of classLists(text)) {
      const rounded = /\brounded-(?:md|lg|xl|2xl|3xl)\b/.test(classes);
      const boxed = /\bborder\b(?!-)/.test(classes) || /\bborder border-/.test(classes);
      if (rounded && boxed) offenders.push(`${name}: ${classes.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});

it("keeps the overlay's own chrome on hairlines", () => {
  const chrome = sources.filter(({ name }) => ["overlay.tsx", "toolbar.tsx", "tabs.tsx", "rail.tsx"].includes(name));
  expect(chrome).toHaveLength(4);
  for (const { name, text } of chrome) {
    expect({ name, borders: /border-[stbe]? border-line|\bborder border-line\b/.test(text) }).toEqual({
      name,
      borders: false,
    });
  }
});
