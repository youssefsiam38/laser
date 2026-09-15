"use client";
/**
 * What a prompt row can do with a message it does not hold (RP-5b §2, B3).
 *
 * Copying it honestly, opening one of its files, listing the ones its row does
 * not show, and rebuilding it for editing — each of them bounded, verified and
 * accounted for. They live here rather than inside the transcript's message
 * renderer, which has quite enough to do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EDITABLE_TEXT_MAX_BYTES, utf8ByteLength } from "@lasercode/protocol";

import { AttachmentBrowser } from "./AttachmentBrowser.js";
import { partial } from "./LargeBodyViewer.js";
import { useCopy } from "@/hooks/use-copy";
import type { FileOpener } from "@/lib/file-opener";
import { useLaserStable, useLaserState } from "@/runtime";
import { attachedFileContent, splitAttachedFiles, type AttachedFile } from "@/runtime/attachments";
import { isReadable, omittedBytes, type BodyRef } from "@/runtime/body-excerpt";
import { bodyReadMessage, canCopyWholeBody, copyWholeBody, readAttachment, streamBody } from "@/runtime/body-reader";
import type { ActionReservation } from "@/runtime/view-cache";
import type { FileOverflow } from "@/store";

/**
 * Copy a message honestly (RP-5b).
 *
 * A body this window holds whole is copied as it is. A body it holds an
 * excerpt of is read from its authority a slice at a time and verified against
 * the digest the conversation published, so what lands on the clipboard is the
 * whole message or nothing. When this window cannot take a whole body that way,
 * the excerpt goes — carrying, in the bytes themselves, an exact line saying
 * what is missing. Nothing is copied as if it were whole when it is not.
 */
export function useHonestCopy(path: string | undefined, text: string, body: BodyRef | undefined) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const { copied, copy, markCopied } = useCopy();
  const [copying, setCopying] = useState(false);
  const [wasPartial, setWasPartial] = useState(false);
  const run = useCallback(async () => {
    // Only a body this window holds whole is copied as it is.
    if (body === undefined || omittedBytes(body) <= 0) {
      setWasPartial(false);
      await copy(text);
      return;
    }
    // Everything else is an excerpt. It is copied whole from its authority, or
    // it goes with the marker in its bytes — never plain, and never because a
    // reference happened to be live or a path was not to hand.
    const marked = async (): Promise<void> => {
      setWasPartial(true);
      await copy(partial(text, body.excerpt.offset, body.excerpt.offset + body.excerpt.bytes, body.totalBytes));
    };
    if (!isReadable(body) || path === undefined || !canCopyWholeBody()) {
      await marked();
      return;
    }
    setCopying(true);
    try {
      const outcome = await copyWholeBody(
        (params) => client.request("session/entry_range", params),
        path,
        body,
        { environmentKey, revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision },
      ).catch(() => ({ ok: false as const, reason: "short" as const }));
      if (outcome.ok) {
        // The clipboard took the blob itself, so the shared copy lifecycle is
        // told rather than driven: same feedback, same clock.
        setWasPartial(false);
        markCopied();
        return;
      }
      await marked();
    } finally {
      setCopying(false);
    }
  }, [body, client, copy, environmentKey, markCopied, path, text]);
  return { copied, copying, partial: copied && wasPartial, copy: run };
}

/**
 * The attachments a prompt has that are not chips here (RP-5b §2).
 *
 * An exact number when the authority scanned the whole prompt and told us how
 * many it did not describe; no number at all when it could not see all of it —
 * a count it cannot stand behind is not shown.
 */
export function AttachmentOverflow({ overflow, body, path, onOpen }: {
  overflow: FileOverflow | undefined;
  body: BodyRef | undefined;
  path: string | undefined;
  onOpen?: ((file: { name: string; mediaType: string; ref: BodyRef }, trigger: HTMLElement) => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!overflow || !body) return null;
  const label = "unknown" in overflow
    ? "More attachments in this message"
    : `${overflow.omitted} more ${overflow.omitted === 1 ? "attachment" : "attachments"} in this message`;
  return <>
    <button
      ref={trigger}
      type="button"
      data-slot="attachment-overflow"
      onClick={() => setOpen(true)}
      className="mt-1 min-h-11 self-end text-xs text-ink-3 underline underline-offset-2 outline-none transition-colors duration-(--motion-instant) hover:text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live"
    >
      {label}
    </button>
    {open ? <AttachmentBrowser body={body} path={path} open onOpenChange={setOpen} returnFocus={trigger.current} onOpen={onOpen} /> : null}
  </>;
}


/**
 * Opening one of a prompt's files, wherever it was listed: the chips on its
 * row, or the browser behind them. Either way the region is read back at one
 * revision, verified whole, and unescaped only then.
 */
export function usePromptAttachments(input: { path: string | undefined; files: readonly AttachedFile[]; refs: ReadonlyArray<BodyRef | undefined> | undefined; opener: FileOpener | undefined }) {
  const { path, files, refs, opener } = input;
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const [problem, setProblem] = useState<string>();

  /** Open one named file from its verified region, wherever it was listed. */
  const openRegionFile = useCallback(async (file: { name: string; mediaType: string; ref: BodyRef }, trigger: HTMLElement): Promise<void> => {
    if (!opener || path === undefined || !isReadable(file.ref) || !file.ref.region) {
      setProblem("This file cannot be opened from here. Open the conversation again.");
      return;
    }
    setProblem(undefined);
    const outcome = await readAttachment(
      (params) => client.request("session/entry_range", params),
      path,
      file.ref as never,
      { environmentKey, revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision },
    ).catch(() => ({ ok: false as const, reason: "short" as const }));
    if (!outcome.ok) {
      setProblem(outcome.reason === "corrupt"
        ? "What came back was not this file. Open the conversation again."
        : outcome.reason === "too-large"
          ? "This file is too large to open here."
          : "This file could not be read just now. Try again in a moment.");
      return;
    }
    opener.openFile({ file: attachedFileContent({ name: file.name, mediaType: file.mediaType, size: outcome.bytes, content: outcome.text }) }, trigger);
  }, [client, environmentKey, opener, path]);

  const openAttachment = useCallback(async (index: number, trigger: HTMLElement): Promise<void> => {
    const held = files[index];
    if (!opener || !held) return;
    setProblem(undefined);
    const ref = refs?.[index];
    if (held.content) { opener.openFile({ file: attachedFileContent(held) }, trigger); return; }
    if (!ref || !isReadable(ref) || !ref.region || path === undefined) {
      setProblem("This file cannot be opened from here. Open the conversation again.");
      return;
    }
    const outcome = await readAttachment(
      (params) => client.request("session/entry_range", params),
      path,
      ref as never,
      { environmentKey, revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision },
    ).catch(() => ({ ok: false as const, reason: "short" as const }));
    if (!outcome.ok) {
      setProblem(outcome.reason === "corrupt"
        ? "What came back was not this file. Open the conversation again."
        : outcome.reason === "too-large"
          ? "This file is too large to open here."
          : "This file could not be read just now. Try again in a moment.");
      return;
    }
    opener.openFile({ file: attachedFileContent({ ...held, content: outcome.text, size: outcome.bytes }) }, trigger);
  }, [client, environmentKey, files, opener, path, refs]);



  return { problem, openRegionFile, openAttachment };
}


/**
 * Rebuilding a prompt this window only shows part of, so it can be edited
 * (RP-5b B3).
 *
 * Room is taken from the renderer's own accounting **before** anything is
 * read, the body comes back at one revision in bounded slices and is verified
 * as a whole, and only a verified body becomes a draft and its attachments. A
 * message past what a composer may hold is refused outright, whatever room
 * this view happens to have.
 */
export function usePromptEdit(input: {
  path: string | undefined;
  setDraft: (draft: string) => void;
  setEditing: (editing: boolean) => void;
  editOwner: { update: (patch: { draft?: string; editing?: boolean }) => void };
}) {
  const { path, setDraft, setEditing, editOwner } = input;
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  /** The room this edit is holding, for as long as its draft exists. */
  const editRoom = useRef<ActionReservation | undefined>(undefined);
  /** Which rebuild owns the editor; a late one belongs to nobody. */
  const editAttempt = useRef(0);
  const { reserveViewAction } = useLaserStable();
  /** The attachments a rebuild decoded, held beside the draft they belong to. */
  const rebuiltFiles = useRef<AttachedFile[] | undefined>(undefined);
  const releaseEditRoom = useCallback(() => {
    // Everything an edit was holding goes together, exactly once.
    editAttempt.current += 1;
    editRoom.current?.release();
    editRoom.current = undefined;
    rebuiltFiles.current = undefined;
  }, []);
  // Unmount, a different conversation, a different environment: an edit being
  // rebuilt belongs to none of them, and a read still in flight is fenced out
  // by the same counter that releases the room.
  useEffect(() => releaseEditRoom, [releaseEditRoom, path, environmentKey]);
  const [editRefusal, setEditRefusal] = useState<string>();

  const rebuildForEdit = useCallback(async (body: BodyRef): Promise<void> => {
    setEditRefusal(undefined);
    const tooLarge = "This message is too large to edit here. Open it to read or copy what you need into a new message, or fork from a later message. Nothing has changed.";
    if (!isReadable(body) || path === undefined || !Number.isSafeInteger(body.totalBytes)) {
      setEditRefusal(tooLarge);
      return;
    }
    // The editable bound is a bound: a message past it is never rebuilt,
    // however much room this view happens to have (RP-5b B3). It is decided
    // from the identity the page published, before a byte is asked for.
    if (body.totalBytes > EDITABLE_TEXT_MAX_BYTES) {
      setEditRefusal(tooLarge);
      return;
    }
    // What the draft will cost: the body itself, and the same bytes again for
    // the editor's own copy of it, which is what an edit really holds.
    const want = body.totalBytes * 2;
    const room = reserveViewAction(path, want);
    if (!room) {
      setEditRefusal(tooLarge);
      return;
    }
    const mine = ++editAttempt.current;
    try {
      let assembled = "";
      const outcome = await streamBody(
        (params) => client.request("session/entry_range", params),
        path,
        body,
        { environmentKey, revisionOf: async (candidate) => (await client.request("session/revision", { path: candidate })).revision },
        (slice) => { assembled += slice; },
      );
      // A conversation that moved on, a scope that changed, or a person who
      // gave up: the bytes are dropped and nothing is edited.
      // Cancelled, unmounted, or another rebuild started: this one's room goes
      // back here, once, and nothing it read is assigned anywhere.
      if (mine !== editAttempt.current) { room.release(); return; }
      if (!outcome.verified || utf8ByteLength(assembled) !== body.totalBytes) {
        room.release();
        if (mine !== editAttempt.current) return;
        setEditRefusal("This message could not be read in full just now, so it was not opened for editing. Nothing has changed.");
        return;
      }
      // Complete canonical wrappers, split from a body that is whole. The
      // editor shows the person's prose; the files are held beside it, under
      // the same reservation, and are wrapped again only on the way out.
      const { text: prose, files: attached } = splitAttachedFiles(assembled);
      editRoom.current?.release();
      editRoom.current = room;
      rebuiltFiles.current = attached;
      setDraft(prose);
      setEditing(true);
    } catch (failure) {
      room.release();
      if (mine !== editAttempt.current) return;
      setEditRefusal(bodyReadMessage(failure));
    }
  }, [client, editOwner, environmentKey, path, reserveViewAction, setDraft, setEditing]);

  return { editRefusal, rebuildForEdit, releaseEditRoom, rebuiltFiles, editAttempt };
}
