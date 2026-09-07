import { createHash, webcrypto } from "node:crypto";
import { expect, it, vi } from "vitest";
import { requestSourceSpans } from "../../src/components/logs/request-sources.js";
import type { InstructionSourceMap } from "@lasercode/protocol";

vi.stubGlobal("crypto", webcrypto);
const text = "Project rule 🟢.";
const map: InstructionSourceMap = { path: ["instructions"], sha256: createHash("sha256").update(text).digest("hex"), spans: [{ start: 0, end: text.length, source: { kind: "file", label: "AGENTS.md", path: "/project/AGENTS.md" } }] };
it("only attributes the same retained string at its recorded JSON path", async () => {
  expect(await requestSourceSpans({ path: "instructions", value: text }, [map])).toEqual(map.spans);
  expect((await requestSourceSpans({ path: "messages[0]", value: text }, [map]))[0]?.source.kind).toBe("unrecorded");
});
it("rejects redacted text, gaps, out-of-range offsets and wrong hashes", async () => {
  expect((await requestSourceSpans({ path: "instructions", value: "[redacted]" }, [map]))[0]?.source.kind).toBe("unrecorded");
  for (const spans of [[{ ...map.spans[0]!, start: 1 }], [{ ...map.spans[0]!, end: 1e6 }], [{ ...map.spans[0]!, start: -1 }]]) {
    expect((await requestSourceSpans({ path: "instructions", value: text }, [{ ...map, spans }]))[0]?.source.kind).toBe("unrecorded");
  }
});
it("projects Anthropic blocks, role messages and Gemini parts without duplicating text", async () => {
  for (const [value, path] of [[[{ type: "text", text }], ["system", 0, "text"]], [{ role: "system", content: [{ type: "text", text }] }, ["system", "content", 0, "text"]], [{ parts: [{ text }] }, ["system", "parts", 0, "text"]]] as const) {
    expect(await requestSourceSpans({ path: "system", value }, [{ ...map, path: [...path] }])).toEqual(map.spans);
  }
});
