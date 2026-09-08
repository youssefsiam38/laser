import { expect, it } from "vitest";
import { toolSearchContent, jsonSearchValues } from "../src/search-content.js";

it("uses visible terminal content, never command keys, tool names or hidden parameters", () => {
  expect(toolSearchContent({ name: "bash", args: { command: "echo hello", timeout: 12345, secret: "hidden" }, result: { content: [{ type: "text", text: "world" }, { type: "image", data: "private" }], details: { secret: "hidden" } } })).toEqual(["echo hello", "world"]);
  expect(toolSearchContent({ name: "bash", args: { command: "command -v node" }, result: "command output\nCommand exited with code 1", isError: true })).toEqual(["command -v node", "command output"]);
});
it("keeps unknown tools searchable through JSON values, including nested arrays and displayed escapes", () => {
  expect(toolSearchContent({ name: "future_tool", args: { command: "hello", nested: [{ query: "Apple", enabled: true, limit: 7 }], newline: "a\nb" }, result: '{"command":"pear"}' })).toEqual(["hello", "Apple", "true", "7", String.raw`a\nb`, "pear"]);
  expect(jsonSearchValues({ Apple: "pear" })).toEqual(["pear"]);
});
it("uses exactly the bounded diff lines and excludes hidden success messages", () => {
  const text = Array.from({ length: 405 }, (_, i) => `line${i}`).join("\n");
  const values = toolSearchContent({ name: "write", args: { path: "file.ts", content: text }, result: "Hidden confirmation" });
  expect(values).toHaveLength(401);
  expect(values[0]).toBe("file.ts");
  expect(values.at(-1)).toBe("line399");
  expect(toolSearchContent({ name: "edit", args: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] }, result: "Permission denied", isError: true })).toEqual(["file.ts", "old", "new", "Permission denied"]);
});
it("treats a rendered error as literal text, while JSON fallback output searches only values", () => {
  const result = '{"error":"permission denied"}';
  expect(toolSearchContent({ name: "read", args: { path: "file" }, result, isError: true })).toEqual(["file", result]);
  expect(toolSearchContent({ name: "future_tool", args: {}, result, isError: true })).toEqual(["permission denied"]);
});
it("projects only the final message of complete_agent_run, never its status or the harness reply", () => {
  expect(toolSearchContent({ name: "complete_agent_run", args: { status: "completed", message: "Counted the files." }, result: { content: [{ type: "text", text: "Run r1 ended with status completed." }], details: { runId: "r1", status: "completed" } } })).toEqual(["Counted the files."]);
  expect(toolSearchContent({ name: "complete_agent_run", args: { status: "blocked" }, result: "ignored" })).toEqual([]);
});
