import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createLaserExtension } from "../src/index.js";
import {
  fileKey,
  isEditMatchFailure,
  pathsOf,
  staleEditAppliedNote,
  staleEditFailureNote,
} from "../src/modules/file-freshness.js";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Block = { type: string; text: string };
type Annotation = { content?: Block[] } | undefined;

/** What the engine puts in the result of a tool that threw (`agent-loop.js`). */
const errorContent = (message: string): Block[] => [{ type: "text", text: message }];
/** What the engine's `edit` puts in the result of a call that worked. */
const okContent = (path: string, blocks = 1): Block[] => [
  { type: "text", text: `Successfully replaced ${blocks} block(s) in ${path}.` },
];

/**
 * The sentence this module appended, or `undefined` when it said nothing.
 *
 * The module only ever appends, so the note is whatever follows the blocks the
 * engine itself produced. A test that asserts on this is asserting on the
 * entire interface of the feature: what the agent reads.
 */
function noteOf(annotation: Annotation, original: Block[]): string | undefined {
  if (!annotation?.content) return undefined;
  expect(annotation.content.slice(0, original.length)).toEqual(original);
  const added = annotation.content.slice(original.length);
  expect(added).toHaveLength(1);
  return added[0]?.text;
}

/**
 * One session: the companion extension with only this module, activated, plus
 * direct access to the two engine hooks it installs.
 */
function session(cwd: string) {
  const handlers = new Map<string, Handler[]>();
  const send = vi.fn();
  const pi = {
    on: (name: string, callback: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(callback);
      handlers.set(name, list);
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  const extension = createLaserExtension({ send, only: ["file-freshness"] });
  extension.factory(pi);
  const fire = async (name: string, event: unknown, ctx: unknown = { cwd }): Promise<unknown[]> => {
    const out: unknown[] = [];
    for (const handler of handlers.get(name) ?? []) out.push(await handler(event, ctx));
    return out;
  };

  /** `tool_execution_start`: the observation, taken before the tool runs. */
  const begin = async (toolName: string, input: unknown, id = "c1"): Promise<void> => {
    await fire("tool_execution_start", { type: "tool_execution_start", toolCallId: id, toolName, args: input });
  };
  /** `tool_result`: what actually happened, and whatever the module says about it. */
  const finish = async (
    toolName: string,
    input: unknown,
    options: { isError?: boolean; content?: Block[]; id?: string } = {},
  ): Promise<Annotation> => {
    const results = (await fire("tool_result", {
      type: "tool_result",
      toolCallId: options.id ?? "c1",
      toolName,
      input,
      content: options.content ?? okContent(String((input as { path?: string })?.path ?? "")),
      isError: options.isError ?? false,
    })) as Annotation[];
    return results.find((value) => value?.content) ?? undefined;
  };

  return {
    send,
    handlers,
    fire,
    begin,
    finish,
    start: () => fire("session_start", {}),
    shutdown: () => fire("session_shutdown", {}),
    /** A whole tool call: observation, then result. Returns the note, if any. */
    call: async (
      toolName: string,
      input: unknown,
      options: { isError?: boolean; content?: Block[]; id?: string } = {},
    ): Promise<string | undefined> => {
      const original = options.content ?? okContent(String((input as { path?: string })?.path ?? ""));
      await begin(toolName, input, options.id);
      return noteOf(await finish(toolName, input, { ...options, content: original }), original);
    },
  };
}

async function open(cwd: string) {
  const s = session(cwd);
  await s.start();
  return s;
}

let dir: string;
const file = (name: string) => join(dir, name);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "freshness-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A change another writer made: different bytes, so different size and mtime. */
function changeOnDisk(path: string, content: string): void {
  writeFileSync(path, content);
}

const notFound = (path: string) =>
  errorContent(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`);

describe("file-freshness module", () => {
  it("activates in every session and installs two hooks, neither of which can block", async () => {
    const s = await open(dir);
    expect(s.send).toHaveBeenCalledWith({ type: "lasercode/capabilities", active: ["file-freshness"], failed: [] });
    expect(s.handlers.has("tool_execution_start")).toBe(true);
    expect(s.handlers.has("tool_result")).toBe(true);
    // The rule is content-based now: there is nothing here that can refuse a call.
    expect(s.handlers.has("tool_call")).toBe(false);
  });

  it("explains a failed edit on a file that moved, keeping the engine's own words", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");

    const engineSaid = notFound("a.ts");
    await s.begin("edit", { path: "a.ts", edits: [{ oldText: "one\n", newText: "two\n" }] });
    const annotated = await s.finish("edit", { path: "a.ts", edits: [] }, { isError: true, content: engineSaid });

    // Appended, never replaced: the engine's message is still the first block.
    expect(annotated?.content?.[0]).toEqual(engineSaid[0]);
    const note = noteOf(annotated, engineSaid);
    expect(note).toBe(
      "a.ts changed on disk after you last read it, so the text you asked to replace is no longer what the file holds. " +
        "Read a.ts again, then redo this edit against what is there now.",
    );
  });

  it("notes a succeeded edit on a file that moved, and calls it applied rather than complaining", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");

    const note = await s.call("edit", { path: "a.ts", edits: [] });
    expect(note).toBe(
      "This edit matched the file's current text and was applied. " +
        "a.ts changed on disk after you last read it, so it carries changes you have not seen. " +
        "Read a.ts again before any further edit that depends on the surrounding lines.",
    );
  });

  /**
   * The precise failure the mtime refusal produced in the wild
   * (anthropics/claude-code #3513, #7443, #10437, #11463, #48390): the agent's
   * own edit advances the mtime, so every call after the first was refused on a
   * file nobody else had touched. Five real edits, one real read, no note.
   */
  it("says nothing at all when the agent edits one file five times in a row", async () => {
    const path = file("a.ts");
    writeFileSync(path, "one\ntwo\nthree\nfour\nfive\nsix\n");
    const editTool = createEditToolDefinition(dir);
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });

    const words = ["one", "two", "three", "four", "five"];
    for (const word of words) {
      const input = { path: "a.ts", edits: [{ oldText: word, newText: word.toUpperCase() }] };
      await s.begin("edit", input);
      await editTool.execute("c1", input as never, undefined, undefined, {} as never);
      const note = noteOf(await s.finish("edit", input, { content: okContent("a.ts") }), okContent("a.ts"));
      expect(note, `edit of "${word}" should be silent`).toBeUndefined();
    }
    expect(readFileSync(path, "utf8")).toBe("ONE\nTWO\nTHREE\nFOUR\nFIVE\nsix\n");
  });

  it("does not let the agent's own write speak up on its own next edit", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "written by the agent\n");
    await s.call("write", { path: "a.ts", content: "written by the agent\n" });
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
  });

  it("says nothing about a file nobody touched since the read", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
    // Even when the edit fails for a reason that has nothing to do with freshness.
    expect(await s.call("edit", { path: "a.ts", edits: [] }, { isError: true, content: notFound("a.ts") })).toBeUndefined();
  });

  it("says nothing about a file it never saw read or written", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    // An edit to a file never read stays allowed and stays silent: there is no
    // read-before-edit rule here, by decision.
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
    expect(await s.call("edit", { path: "a.ts", edits: [] }, { isError: true, content: notFound("a.ts") })).toBeUndefined();
  });

  it("leaves every other tool's result exactly as the engine wrote it", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one, formatted\n");
    // `bash` moved the file and gets no note; nor does `write`, nor an unknown tool.
    expect(await s.call("bash", { command: `sed -i s/one/one,\\ formatted/ ${file("a.ts")}` })).toBeUndefined();
    expect(await s.call("write", { path: "a.ts", content: "mine\n" })).toBeUndefined();
    expect(await s.call("ls", { path: "a.ts" })).toBeUndefined();
  });

  it("keeps quiet about a failure freshness cannot explain, even on a file that moved", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");
    for (const message of [
      "oldText must not be empty in a.ts.",
      "edits[0] and edits[1] overlap in a.ts. Merge them into one edit or target disjoint regions.",
      "Could not edit file: a.ts. Error code: EACCES.",
      "Operation aborted",
      "Edit tool input is invalid. edits must contain at least one replacement.",
    ]) {
      const note = await s.call("edit", { path: "a.ts", edits: [] }, { isError: true, content: errorContent(message) });
      expect(note, message).toBeUndefined();
    }
  });

  it("keeps explaining until the agent actually re-reads, because a failed edit records nothing", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");
    const failed = { isError: true, content: notFound("a.ts") };
    expect(await s.call("edit", { path: "a.ts", edits: [] }, failed)).toContain("changed on disk");
    expect(await s.call("edit", { path: "a.ts", edits: [] }, failed)).toContain("changed on disk");
    // The re-read is what settles it.
    await s.call("read", { path: "a.ts" });
    expect(await s.call("edit", { path: "a.ts", edits: [] }, failed)).toBeUndefined();
  });

  it("treats a relative, a dot-relative and an absolute spelling as one file", async () => {
    mkdirSync(file("src"));
    writeFileSync(file("src/a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "src/a.ts" });
    // Same file, spelled two other ways, unchanged: still silent.
    expect(await s.call("edit", { path: "./src/a.ts", edits: [] })).toBeUndefined();
    expect(await s.call("edit", { path: resolve(dir, "src/a.ts"), edits: [] })).toBeUndefined();
    changeOnDisk(file("src/a.ts"), "one two three\n");
    // And the record found through any of the three spellings speaks, naming the
    // path the way the agent spelled it. These edits fail, so none of them
    // re-records and each spelling is asked the same question.
    const failed = { isError: true, content: notFound("src/a.ts") };
    expect(await s.call("edit", { path: "./src/a.ts", edits: [] }, failed)).toContain("./src/a.ts changed on disk");
    expect(await s.call("edit", { path: resolve(dir, "src/a.ts"), edits: [] }, failed)).toContain(resolve(dir, "src/a.ts"));
    expect(await s.call("edit", { path: "src/a.ts", edits: [] }, failed)).toContain("src/a.ts changed on disk");
  });

  it("keeps one record for a file reached through a symlinked directory", async () => {
    mkdirSync(file("real"));
    writeFileSync(file("real/a.ts"), "one\n");
    try {
      symlinkSync(file("real"), file("link"), "dir");
    } catch {
      return; // No symlink privilege here; the rule is covered by fileKey's unit test.
    }
    const s = await open(dir);
    await s.call("read", { path: "link/a.ts" });
    changeOnDisk(file("real/a.ts"), "one two three\n");
    expect(await s.call("edit", { path: "real/a.ts", edits: [] })).toContain("real/a.ts changed on disk");
  });

  it("keeps two sessions' records apart", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const first = await open(dir);
    const second = await open(dir);
    await first.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");
    expect(await first.call("edit", { path: "a.ts", edits: [] })).toContain("changed on disk");
    // The second session never read it, so it has nothing to say.
    expect(await second.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
  });

  it("says nothing when the file is gone or the stat fails", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    unlinkSync(file("a.ts"));
    expect(await s.call("edit", { path: "a.ts", edits: [] }, { isError: true, content: notFound("a.ts") })).toBeUndefined();
    // A directory is not a file either.
    mkdirSync(file("b"));
    await s.call("read", { path: "b" });
    expect(await s.call("edit", { path: "b", edits: [] })).toBeUndefined();
  });

  it("does not record a tool call that failed", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    // A read that failed proves nothing about what the agent has seen.
    await s.call("read", { path: "a.ts" }, { isError: true, content: errorContent("Could not read a.ts.") });
    changeOnDisk(file("a.ts"), "one two three\n");
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
  });

  it("keeps the record store bounded, evicting the oldest and so going quiet about it", async () => {
    const limit = 2048;
    const s = await open(dir);
    writeFileSync(file("oldest.ts"), "one\n");
    await s.call("read", { path: "oldest.ts" });
    mkdirSync(file("many"));
    for (let i = 0; i < limit; i += 1) {
      const name = `many/f${i}.ts`;
      writeFileSync(file(name), "x\n");
      await s.finish("read", { path: name });
    }
    // The oldest record has been evicted, so the module has nothing to say.
    changeOnDisk(file("oldest.ts"), "one two three\n");
    expect(await s.call("edit", { path: "oldest.ts", edits: [] })).toBeUndefined();
    // The most recent ones are still remembered.
    changeOnDisk(file(`many/f${limit - 1}.ts`), "x y z\n");
    expect(await s.call("edit", { path: `many/f${limit - 1}.ts`, edits: [] })).toContain("changed on disk");
  }, 30_000);

  it("forgets an in-flight observation whose result never arrives, without unbounded growth", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");
    // 256 aborted edits, then the one whose result does arrive.
    for (let i = 0; i < 300; i += 1) await s.begin("edit", { path: "a.ts", edits: [] }, `abandoned-${i}`);
    const original = okContent("a.ts");
    const note = noteOf(await s.finish("edit", { path: "a.ts", edits: [] }, { id: "abandoned-299" }), original);
    expect(note).toContain("changed on disk");
    // And an id whose observation was evicted simply says nothing.
    expect(noteOf(await s.finish("edit", { path: "a.ts", edits: [] }, { id: "abandoned-0" }), original)).toBeUndefined();
  });

  it("never throws and never speaks on a malformed or unknown call", async () => {
    const s = await open(dir);
    expect(await s.call("edit", undefined)).toBeUndefined();
    expect(await s.call("edit", { path: "" })).toBeUndefined();
    expect(await s.call("edit", { path: 42 })).toBeUndefined();
    expect(await s.call("ls", { path: dir })).toBeUndefined();
    await expect(s.finish("read", { path: null })).resolves.toBeUndefined();
    await expect(s.finish("write", undefined)).resolves.toBeUndefined();
    // No tool call id, no observation, and no crash.
    await expect(s.begin("edit", { path: "a.ts" }, "")).resolves.toBeUndefined();
  });

  it("leaves the engine's result untouched when the annotator itself fails", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    const [observe] = s.handlers.get("tool_execution_start") ?? [];
    const [settle] = s.handlers.get("tool_result") ?? [];
    const hostile = {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "edit",
      get input(): unknown {
        throw new Error("the event itself is broken");
      },
    };
    expect(() => observe?.(hostile, { cwd: dir })).not.toThrow();
    expect(settle?.(hostile, { cwd: dir })).toBeUndefined();
    // A context without a cwd, and no context at all, are survivable too.
    expect(() => observe?.({ type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: {} }, undefined)).not.toThrow();
    expect(settle?.({ type: "tool_result", toolCallId: "c1", toolName: "edit", input: {}, content: [], isError: false }, null)).toBeUndefined();
  });

  it("drops its records at session shutdown", async () => {
    writeFileSync(file("a.ts"), "one\n");
    const s = await open(dir);
    await s.call("read", { path: "a.ts" });
    changeOnDisk(file("a.ts"), "one two three\n");
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toContain("changed on disk");
    await s.shutdown();
    expect(await s.call("edit", { path: "a.ts", edits: [] })).toBeUndefined();
  });
});

describe("file identity", () => {
  it("collapses every spelling of one path onto one key", () => {
    expect(fileKey("src/a.ts", dir)).toBe(fileKey("./src/a.ts", dir));
    expect(fileKey("src/a.ts", dir)).toBe(fileKey(join(dir, "src", "a.ts"), dir));
    expect(fileKey("src/../src/a.ts", dir)).toBe(fileKey("src/a.ts", dir));
  });
  it("refuses a path it cannot make sense of", () => {
    expect(fileKey("", dir)).toBeUndefined();
    expect(fileKey("   ", dir)).toBeUndefined();
    expect(fileKey(undefined as unknown as string, dir)).toBeUndefined();
  });
  it("resolves a symlinked directory to one key", () => {
    mkdirSync(file("real"));
    writeFileSync(file("real/a.ts"), "one\n");
    try {
      symlinkSync(file("real"), file("link"), "dir");
    } catch {
      return;
    }
    expect(fileKey("link/a.ts", dir)).toBe(fileKey("real/a.ts", dir));
    // Also for a file that does not exist yet, through the parent directory.
    expect(fileKey("link/new.ts", dir)).toBe(fileKey("real/new.ts", dir));
  });
});

describe("tool input paths", () => {
  it("reads the single path both file tools actually carry", () => {
    expect(pathsOf({ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] })).toEqual(["a.ts"]);
    expect(pathsOf({ path: "a.ts", content: "x" })).toEqual(["a.ts"]);
  });
  it("reads plural shapes so a future multi-file call is explained, not skipped", () => {
    expect(pathsOf({ paths: ["a.ts", "b.ts", "a.ts"] })).toEqual(["a.ts", "b.ts"]);
    expect(pathsOf({ edits: [{ path: "a.ts" }, { path: "b.ts" }] })).toEqual(["a.ts", "b.ts"]);
  });
  it("returns nothing for input that carries no path", () => {
    expect(pathsOf(undefined)).toEqual([]);
    expect(pathsOf({ command: "ls" })).toEqual([]);
    expect(pathsOf("a.ts")).toEqual([]);
  });
});

/**
 * These two strings are the entire interface of this feature: an agent reads
 * them and nothing else. Both are an instruction, never a complaint, and both
 * name the file and the next step.
 */
describe("the two things this module can say", () => {
  it("explains a failed edit: what happened, which file, and what to do", () => {
    expect(staleEditFailureNote(["src/a.ts"])).toBe(
      "src/a.ts changed on disk after you last read it, so the text you asked to replace is no longer what the file holds. " +
        "Read src/a.ts again, then redo this edit against what is there now.",
    );
  });
  it("notes a succeeded edit: applied, but the file carries changes you have not seen", () => {
    expect(staleEditAppliedNote(["src/a.ts"])).toBe(
      "This edit matched the file's current text and was applied. " +
        "src/a.ts changed on disk after you last read it, so it carries changes you have not seen. " +
        "Read src/a.ts again before any further edit that depends on the surrounding lines.",
    );
  });
  it("names every stale file when one call touches several", () => {
    expect(staleEditFailureNote(["a.ts", "b.ts"])).toContain("a.ts, b.ts changed on disk after you last read them");
    expect(staleEditFailureNote(["a.ts", "b.ts"])).toContain("Read each of them again");
    expect(staleEditAppliedNote(["a.ts", "b.ts"])).toContain("so they carry changes you have not seen");
    expect(staleEditAppliedNote(["a.ts", "b.ts"])).toContain("Read each of them again before any further edit");
  });
});

/**
 * Against the pinned engine's own `read`, `write` and `edit` definitions
 * (Pi 0.85), because the failure text `MATCH_FAILURE_PATTERNS` bets on is the
 * engine's, not ours. An engine bump that rewords an error fails a test here
 * rather than quietly annotating everything, or nothing.
 *
 * The agent loop is not needed: it turns a thrown tool error into
 * `content: [{ type: "text", text: err.message }]` with `isError: true`
 * (`pi-agent-core/dist/agent-loop.js`, `createErrorToolResult`), which is
 * exactly what these tests feed the hook.
 */
describe("against the engine's own file tools", () => {
  type Tool = { execute: (id: string, params: never, s: undefined, u: undefined, ctx: never) => Promise<unknown> };
  const run = async (definition: Tool, input: unknown): Promise<unknown> =>
    definition.execute("c1", input as never, undefined, undefined, {} as never);
  /** The message the engine's tool actually threw, as the loop would flatten it. */
  const failureOf = async (definition: Tool, input: unknown): Promise<string> => {
    try {
      await run(definition, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the engine tool to fail");
  };

  it("recognises every way the engine says the file's text is not what you thought", async () => {
    const path = file("a.ts");
    const editTool = createEditToolDefinition(dir);

    // The old text is gone — one edit, and one of several.
    writeFileSync(path, "alpha\n");
    const gone = await failureOf(editTool, { path: "a.ts", edits: [{ oldText: "zeta", newText: "Z" }] });
    expect(gone).toBe("Could not find the exact text in a.ts. The old text must match exactly including all whitespace and newlines.");
    writeFileSync(path, "alpha\nbeta\n");
    const goneOfMany = await failureOf(editTool, {
      path: "a.ts",
      edits: [{ oldText: "alpha", newText: "A" }, { oldText: "zeta", newText: "Z" }],
    });
    expect(goneOfMany).toBe("Could not find edits[1] in a.ts. The oldText must match exactly including all whitespace and newlines.");

    // It became ambiguous — the engine refuses rather than taking the first one.
    writeFileSync(path, "one\ntwo\none\n");
    const ambiguous = await failureOf(editTool, { path: "a.ts", edits: [{ oldText: "one", newText: "ONE" }] });
    expect(ambiguous).toBe("Found 2 occurrences of the text in a.ts. The text must be unique. Please provide more context to make it unique.");
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\none\n"); // Nothing was written.
    writeFileSync(path, "a\na\na\nb\n");
    const ambiguousOfMany = await failureOf(editTool, {
      path: "a.ts",
      edits: [{ oldText: "a", newText: "A" }, { oldText: "b", newText: "B" }],
    });
    expect(ambiguousOfMany).toBe("Found 3 occurrences of edits[0] in a.ts. Each oldText must be unique. Please provide more context to make it unique.");
    expect(readFileSync(path, "utf8")).toBe("a\na\na\nb\n");

    // The change is already there, usually because somebody else made it.
    writeFileSync(path, "alpha\n");
    const identical = await failureOf(editTool, { path: "a.ts", edits: [{ oldText: "alpha", newText: "alpha" }] });
    expect(identical).toContain("The replacement produced identical content.");

    for (const message of [gone, goneOfMany, ambiguous, ambiguousOfMany, identical]) {
      expect(isEditMatchFailure(errorContent(message)), message).toBe(true);
    }
  });

  it("does not mistake a failure freshness cannot explain for a stale match", async () => {
    const path = file("a.ts");
    const editTool = createEditToolDefinition(dir);
    writeFileSync(path, "abcdef\n");

    const empty = await failureOf(editTool, { path: "a.ts", edits: [{ oldText: "", newText: "x" }] });
    expect(empty).toBe("oldText must not be empty in a.ts.");
    const overlap = await failureOf(editTool, {
      path: "a.ts",
      edits: [{ oldText: "abcd", newText: "X" }, { oldText: "cdef", newText: "Y" }],
    });
    expect(overlap).toContain("overlap in a.ts");
    const missing = await failureOf(editTool, { path: "nope.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(missing).toBe("Could not edit file: nope.ts. Error code: ENOENT.");
    const invalid = await failureOf(editTool, { path: "a.ts", edits: [] });
    expect(invalid).toContain("edits must contain at least one replacement");

    for (const message of [empty, overlap, missing, invalid, "Operation aborted"]) {
      expect(isEditMatchFailure(errorContent(message)), message).toBe(false);
    }
    expect(isEditMatchFailure([])).toBe(false);
    expect(isEditMatchFailure(undefined)).toBe(false);
    expect(isEditMatchFailure(okContent("a.ts"))).toBe(false);
  });

  it("explains a real failed edit and notes a real applied one, then goes quiet", async () => {
    const path = file("a.ts");
    writeFileSync(path, "alpha\nbeta\ngamma\n");
    const readTool = createReadToolDefinition(dir);
    const writeTool = createWriteToolDefinition(dir);
    const editTool = createEditToolDefinition(dir);
    const s = await open(dir);

    await run(readTool, { path: "a.ts" });
    await s.finish("read", { path: "a.ts" });

    // Somebody else rewrites the file — a formatter, a person, another agent —
    // and the text the agent remembers is gone.
    changeOnDisk(path, "alpha\nBETA reformatted\ngamma\ndelta\n");
    const stale = { path: "a.ts", edits: [{ oldText: "beta", newText: "BETA" }] };
    await s.begin("edit", stale);
    const said = errorContent(await failureOf(editTool, stale));
    const failureNote = noteOf(await s.finish("edit", stale, { isError: true, content: said }), said);
    expect(failureNote).toContain("a.ts changed on disk after you last read it");
    expect(failureNote).toContain("Read a.ts again, then redo this edit against what is there now.");

    // The same file, an edit whose old text *does* still match: the engine
    // applies it, and the note says so and asks for a re-read anyway.
    const good = { path: "a.ts", edits: [{ oldText: "gamma", newText: "GAMMA" }] };
    await s.begin("edit", good);
    await run(editTool, good);
    const appliedNote = noteOf(await s.finish("edit", good, { content: okContent("a.ts") }), okContent("a.ts"));
    expect(appliedNote).toContain("This edit matched the file's current text and was applied.");
    expect(readFileSync(path, "utf8")).toBe("alpha\nBETA reformatted\nGAMMA\ndelta\n");

    // That success re-recorded, so the agent's next edit is silent.
    const next = { path: "a.ts", edits: [{ oldText: "delta", newText: "DELTA" }] };
    await s.begin("edit", next);
    await run(editTool, next);
    expect(noteOf(await s.finish("edit", next, { content: okContent("a.ts") }), okContent("a.ts"))).toBeUndefined();

    // And a `write` clears the way just as well.
    changeOnDisk(path, "somebody else entirely\n");
    await run(writeTool, { path: "a.ts", content: "one\ntwo\n" });
    await s.finish("write", { path: "a.ts", content: "one\ntwo\n" });
    const after = { path: "a.ts", edits: [{ oldText: "two", newText: "three" }] };
    await s.begin("edit", after);
    await run(editTool, after);
    expect(noteOf(await s.finish("edit", after, { content: okContent("a.ts") }), okContent("a.ts"))).toBeUndefined();
  });

  it("reads the path out of the engine's real parameter schemas", () => {
    for (const definition of [createReadToolDefinition(dir), createWriteToolDefinition(dir), createEditToolDefinition(dir)]) {
      expect(Object.keys((definition.parameters as { properties: Record<string, unknown> }).properties)).toContain("path");
    }
  });
});
