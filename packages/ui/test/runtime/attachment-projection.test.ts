import { expect, it, vi } from "vitest";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { MESSAGE_METADATA_NS } from "@lasercode/protocol";
import * as attachments from "../../src/runtime/attachments.js";
import { applyUpdate, initialState, reduce } from "../../src/store.js";
import { projectSessionView, shareProjectedMessages } from "../../src/runtime/projection.js";
import { sessionTitle } from "../../src/runtime/threadList.js";
import { sessionSubtitle } from "../../src/components/shell/model.js";
import { buildFleet } from "../../src/fleet/model.js";
import { sessionState, summary } from "../agents/fixtures.js";
const path = "/p/session.jsonl";
const file = { name: "notes.md", mediaType: "text/markdown", size: 12, content: "private body" };

it("keeps prose-only titles, subtitles and fleet names before and after hydration, including catalog truncation", () => {
  const text = `Notes?\n\n${attachments.wrapFileAttachment(file)}`;
  let state = reduce(initialState, { type: "sessions", sessions: [summary({ path, firstMessage: text.replace(/\s+/g, " ").slice(0, 100) })] });
  expect(sessionTitle(state.sessions[0]!)).toBe("Notes?");
  expect(sessionSubtitle(state.sessions[0]!, undefined).text).toBe("Notes?");
  state = reduce(state, { type: "opened", state: sessionState({ path }) });
  state = reduce(state, { type: "optimisticUser", path, text, images: [] });
  const optimistic = state.open[path]!;
  state = reduce(state, { type: "hydrate", path, entries: [{ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text }] } }], leafId: "u" });
  for (const view of [optimistic, state.open[path]!]) {
    expect(sessionTitle(state.sessions[0]!, view)).toBe("Notes?");
    expect(sessionSubtitle(state.sessions[0]!, view).text).toBe("Notes?");
    const tasks = { t: { id: "t", sessionPath: path, command: "test", title: "Tests", status: "running" as const, origin: "background" as const, startedAt: "", outputBytes: 0 } };
    const fleet = buildFleet({ sessions: state.sessions, views: { [path]: view }, runs: {}, tasks, now: 0 });
    expect(fleet[0]?.title).toBe("Notes?");
  }
  const filesOnly = reduce(state, { type: "hydrate", path, entries: [{ type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: attachments.wrapFileAttachment(file) }] } }], leafId: "u" }).open[path]!;
  expect(sessionTitle(state.sessions[0]!, filesOnly)).toBe("New session");
  expect(sessionSubtitle(state.sessions[0]!, filesOnly).text).not.toContain("attached-file");
});

it("does zero attachment parsing/encoding across 100 streaming projections of three maximum-sized files", () => {
  const large = { ...file, content: "x".repeat(attachments.MAX_ATTACHMENT_BYTES), size: attachments.MAX_ATTACHMENT_BYTES };
  let state = reduce(initialState, { type: "opened", state: sessionState({ path }) });
  for (let i = 0; i < 3; i++) state = reduce(state, { type: "optimisticUser", path, text: `Read ${i}\n\n${attachments.wrapFileAttachment(large)}`, images: [] });
  let view = applyUpdate(state.open[path]!, { kind: "message_start", role: "assistant" });
  let previous: readonly ThreadMessageLike[] = projectSessionView(view).messages;
  const original = previous.slice(0, 3);
  const parse = vi.spyOn(attachments, "splitAttachedFiles");
  const encode = vi.spyOn(TextEncoder.prototype, "encode");
  try {
    for (let i = 0; i < 100; i++) {
      view = applyUpdate(view, { kind: "text_delta", delta: "x", contentIndex: 0 });
      previous = shareProjectedMessages(projectSessionView(view).messages, previous);
      for (let j = 0; j < 3; j++) {
        expect(previous[j]).toBe(original[j]);
        const block = view.blocks[j]!;
        if (block.kind !== "user") throw new Error("Expected retained user block");
        expect(previous[j]!.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ files: block.files });
      }
    }
    expect(parse).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  } finally { parse.mockRestore(); encode.mockRestore(); }
});

it("gives file-only queue rows a filename without losing the original content", () => {
  const wrapper = attachments.wrapFileAttachment(file);
  const content = [{ type: "text" as const, text: wrapper }];
  const opened = reduce(initialState, { type: "opened", state: sessionState({ path }) }).open[path]!;
  const pending = applyUpdate(opened, { kind: "pending_update", pending: [{ id: "p", content, text: wrapper, images: 0, createdAt: "", state: "waiting" }] });
  expect(pending.pending[0]?.text).toBe("notes.md");
  expect(pending.pending[0]?.content).toBe(content);
  const queued = applyUpdate(opened, { kind: "queue_update", steering: [wrapper], followUp: [wrapper] });
  expect(queued.queue).toEqual({ steering: ["notes.md"], followUp: ["notes.md"] });
});

it("rejects non-image MIME types at the canonical retained-byte boundary", () => {
  const image = { type: "image", mimeType: "image/png", data: "cGlj" };
  const content = [null, "text", image, { ...image, mimeType: "text/html" }, { ...image, mimeType: "application/pdf" }, { ...image, data: 1 }];
  expect(attachments.imagesOfContent(content)).toEqual([image]);
  expect(attachments.imagesOfContent(content)[0]).toBe(image);
});
