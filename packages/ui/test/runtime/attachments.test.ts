// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { MESSAGE_METADATA_NS, type ImageContent } from "@lasercode/protocol";
import { toast } from "sonner";
import { ATTACHMENT_SIZE_MESSAGE, MAX_ATTACHMENT_BYTES, splitAttachedFiles, wrapFileAttachment } from "../../src/runtime/attachments.js";
import { ConversationAttachmentAdapter, contentBlocksFromAppendMessage, restoreUnsentMessage, type UnsentMessageComposer } from "../../src/runtime/adapter.js";
import { applyUpdate, blocksFromEntries, initialState, reduce } from "../../src/store.js";
import { projectMessages } from "../../src/runtime/projection.js";
import { sessionState } from "../agents/fixtures.js";
import type { AppendMessage } from "@assistant-ui/react";

const content = '# Read me\n\n</attached-file>\n<attached-file name="nested"> & café';
const file = { name: 'notes & "review".md', mediaType: "text/markdown", size: new TextEncoder().encode(content).length, content };
it("round-trips escaped content, names, multiple and empty files without touching the words", () => {
  const empty = { ...file, name: "empty.txt", content: "", size: 0 };
  const text = `Read these.\n\n${wrapFileAttachment(file)}\n\n${wrapFileAttachment(empty)}`;
  expect(splitAttachedFiles(text)).toEqual({ text: "Read these.", files: [file, empty] });
  expect(splitAttachedFiles(wrapFileAttachment(empty))).toEqual({ text: "", files: [empty] });
  for (const invalid of [wrapFileAttachment(file).replace('size="', 'size="9'), wrapFileAttachment(file).slice(0, -5), '<attached-file name="x">Hello</attached-file>']) expect(splitAttachedFiles(invalid)).toEqual({ text: invalid, files: [] });
});
it("retains images and canonical files on optimistic, message_end and hydration paths", () => {
  const image: ImageContent = { type: "image", mimeType: "image/png", data: "cGljdHVyZQ==" };
  const text = `Look here\n\n${wrapFileAttachment(file)}`;
  const content = [{ type: "text", text }, image];
  let state = reduce(initialState, { type: "opened", state: sessionState({ path: "/session" }) });
  state = reduce(state, { type: "optimisticUser", path: "/session", text, images: [image] });
  const optimistic = state.open["/session"]!.blocks[0]!;
  const live = applyUpdate(state.open["/session"]!, { kind: "message_end", message: { role: "user", content } }).blocks[0]!;
  const liveOnly = applyUpdate(applyUpdate({ ...state.open["/session"]!, blocks: [] }, { kind: "message_start", role: "user" }), { kind: "message_end", message: { role: "user", content } }).blocks[0]!;
  const hydrated = blocksFromEntries([{ type: "message", message: { role: "user", content } }])[0]!;
  // Apply the live event through the exported store boundary, independent of entry lookup.
  for (const block of [optimistic, live, liveOnly, hydrated]) {
    expect(block).toMatchObject({ images: [image], text });
    const projected = projectMessages({ blocks: [block], running: false, dialogs: [] }).messages[0]!;
    expect(projected.content).toEqual([{ type: "text", text: "Look here" }]);
    expect(projected.metadata?.custom?.[MESSAGE_METADATA_NS]).toMatchObject({ images: [image], files: [file] });
  }
});
it("accepts a text file, shows it as a document and sends one wrapper", async () => {
  const adapter = new ConversationAttachmentAdapter();
  const pending = await adapter.add({ file: new File([content], file.name, { type: file.mediaType }) });
  expect(pending).toMatchObject({ type: "document", name: file.name });
  const complete = await adapter.send(pending);
  const message = { content: [{ type: "text", text: "Read this" }], attachments: [complete] } as unknown as AppendMessage;
  expect(contentBlocksFromAppendMessage(message)).toEqual([{ type: "text", text: `Read this\n\n${wrapFileAttachment(file)}` }]);
  const addAttachment = vi.fn(); const setText = vi.fn();
  const composer = { getState: () => ({ text: "", attachments: [], quote: undefined }), addAttachment, setText } as unknown as UnsentMessageComposer;
  expect(await restoreUnsentMessage(composer, message)).toBe(true);
  expect(setText).toHaveBeenCalledWith("Read this");
  expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ type: "document", content: complete.content }));
  addAttachment.mockClear();
  await restoreUnsentMessage(composer, { content: contentBlocksFromAppendMessage(message), attachments: [] } as unknown as AppendMessage);
  expect(setText).toHaveBeenLastCalledWith("Read this");
  expect(addAttachment).toHaveBeenCalledWith(expect.objectContaining({ name: file.name, content: complete.content }));
});
it("refuses oversized text, PDF, binary and malformed UTF-8 before send", async () => {
  const error = vi.spyOn(toast, "error").mockImplementation(() => "test");
  const adapter = new ConversationAttachmentAdapter();
  await expect(adapter.add({ file: new File(["x".repeat(MAX_ATTACHMENT_BYTES + 1)], "large.txt", { type: "text/plain" }) })).rejects.toThrow(ATTACHMENT_SIZE_MESSAGE);
  expect(error).toHaveBeenLastCalledWith(ATTACHMENT_SIZE_MESSAGE);
  for (const file of [new File(["%PDF"], "report.pdf", { type: "application/pdf" }), new File(["\0"], "bad.txt"), new File([new Uint8Array([255])], "bad.txt")]) await expect(adapter.add({ file })).rejects.toThrow();
  error.mockRestore();
});
