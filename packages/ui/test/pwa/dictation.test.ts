/**
 * The pure parts of dictation: recorder mime choice, relay-sized chunking,
 * and where a phrase lands relative to the caret.
 */
import { describe, expect, it } from "vitest";
import {
  CHUNK_BYTES,
  MediaRecorderDictationAdapter,
  chunkBase64,
  describeMicrophoneError,
  pickRecorderMimeType,
  placePhraseAtCaret,
  removeRuntimeAppend,
} from "../../src/pwa/dictation.js";

describe("pickRecorderMimeType", () => {
  it("prefers webm/opus, falls back to mp4 on Safari, and survives a throwing isTypeSupported", () => {
    expect(pickRecorderMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(
      pickRecorderMimeType(() => {
        throw new Error("no");
      }),
    ).toBeUndefined();
  });
});

describe("chunkBase64", () => {
  it("keeps every chunk on a 4-character boundary and under the byte budget", () => {
    const base64 = "A".repeat(200_000);
    const chunks = chunkBase64(base64);
    expect(chunks.join("")).toBe(base64);
    for (const c of chunks) {
      expect(c.length % 4 === 0 || c === chunks.at(-1)).toBe(true);
      expect((c.length / 4) * 3).toBeLessThanOrEqual(CHUNK_BYTES);
    }
    expect(chunkBase64("")).toEqual([""]);
    expect(chunkBase64("abcdefgh", 3)).toEqual(["abcd", "efgh"]);
  });
});

describe("placePhraseAtCaret", () => {
  it("appends with a space when the caret is at the end or unknown", () => {
    expect(placePhraseAtCaret("fix the", undefined, "tests")).toEqual({ text: "fix the tests", caret: 13 });
    expect(placePhraseAtCaret("fix the ", 8, "tests")).toEqual({ text: "fix the tests", caret: 13 });
    expect(placePhraseAtCaret("", 0, "hello")).toEqual({ text: "hello", caret: 5 });
  });
  it("inserts mid-text with spacing on both sides only where needed", () => {
    expect(placePhraseAtCaret("fix tests", 3, "the")).toEqual({ text: "fix the tests", caret: 7 });
    expect(placePhraseAtCaret("fix  tests", 4, "the")).toEqual({ text: "fix the tests", caret: 7 });
    expect(placePhraseAtCaret("a, b", 1, "x")).toEqual({ text: "a x, b", caret: 3 });
  });
  it("ignores an empty phrase and clamps a caret past the end", () => {
    expect(placePhraseAtCaret("abc", 1, "   ")).toEqual({ text: "abc", caret: 1 });
    expect(placePhraseAtCaret("abc", 99, "d")).toEqual({ text: "abc d", caret: 5 });
  });
});

describe("removeRuntimeAppend", () => {
  it("removes only the phrase assistant-ui appended", () => {
    expect(removeRuntimeAppend("typed words dictated phrase", "dictated phrase")).toBe("typed words");
    expect(removeRuntimeAppend("dictated phrase", "dictated phrase")).toBe("");
    expect(removeRuntimeAppend("leave this alone", "different phrase")).toBe("leave this alone");
  });
});

describe("describeMicrophoneError", () => {
  it("writes for a person", () => {
    const denied = new Error("x");
    denied.name = "NotAllowedError";
    expect(describeMicrophoneError(denied).title).toBe("Microphone access is off");
    expect(describeMicrophoneError(new Error("boom")).body).toBe("boom");
  });
});

describe("MediaRecorderDictationAdapter", () => {
  it("checks provider readiness before asking for microphone access", async () => {
    const calls: string[] = [];
    let resolveError!: (error: unknown) => void;
    const failed = new Promise<unknown>((resolve) => {
      resolveError = resolve;
    });
    const adapter = new MediaRecorderDictationAdapter({
      transport: {
        check: async () => {
          calls.push("check");
          throw new Error("Add an OpenAI platform API key in Settings → Providers and models.");
        },
        begin: async () => "unused",
        chunk: async () => {},
        end: async () => "",
        cancel: async () => {},
      },
      getMedia: async () => {
        calls.push("microphone");
        throw new Error("must not run");
      },
      onError: resolveError,
    });

    adapter.listen();
    await expect(failed).resolves.toMatchObject({ message: expect.stringContaining("OpenAI platform API key") });
    expect(calls).toEqual(["check"]);
  });
});
