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
    const thread = source("components/thread/Thread.tsx");
    const pair = source("components/assistant-ui/elements/message-pair.tsx");
    expect(thread).toContain('data-slot="thread-messages" className="flex flex-col gap-5 pt-5 pb-5 empty:hidden"');
    expect(pair).toContain("gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-base");
    expect(pair).toContain('className={cn("-ms-1.5 mt-1 flex h-7');
  });
});
