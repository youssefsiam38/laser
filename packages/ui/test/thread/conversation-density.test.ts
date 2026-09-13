import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../src/${relative}`, import.meta.url)), "utf8");

describe("compact conversation density", () => {
  it("uses the shared body type and compact markdown rhythm", () => {
    const markdown = source("components/assistant-ui/elements/markdown-text.tsx");
    expect(markdown).toContain('"md-body max-w-(--measure-prose) text-base');
    expect(markdown).toContain('cn("my-2 first:mt-0 last:mb-0"');
    expect(markdown).not.toContain('"md-body max-w-(--measure-prose) text-md');
  });

  it("tightens message and prompt spacing without shrinking controls", () => {
    // Mounted-row spacing is measured with the real stylesheet in sustained-navigation.mjs.
    const pair = source("components/assistant-ui/elements/message-pair.tsx");
    expect(pair).toContain("gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-base");
    expect(pair).toContain('className={cn("-ms-1.5 mt-1 flex h-7');
  });
});
