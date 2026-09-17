/**
 * The first lines of an output the transcript is not holding (M16-T60).
 *
 * A page that left a large record out carries only its reference, so the tool
 * row would show a command and a fold with nothing between. While the row is
 * open, this reads the head of the output once, keeps at most
 * `OUTPUT_PREVIEW_BYTES` of it, and lets the rest of the segment go. The
 * preview lives in the row's own state: it goes when the row closes or leaves
 * the screen, and memory pressure takes it like any other ephemeral cache.
 */
import { useCallback, useEffect, useState } from "react";

import { useLaserStable, useLaserState } from "@/runtime";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import type { RangeRequest } from "@/runtime/body-reader";
import { registerEphemeralCache } from "@/runtime/pressure";
import { charIndexAtByte, OutputPager } from "./output-pager.js";

/** About a hundred lines of ordinary output. */
export const OUTPUT_PREVIEW_BYTES = 8 * 1024;

export function useOutputPreview(ref: BodyRef | undefined, path: string | undefined, enabled: boolean): string | undefined {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const [preview, setPreview] = useState<{ key: string; text: string } | undefined>(undefined);
  const request = useCallback<RangeRequest>((params) => client.request("session/entry_range", params), [client]);
  const revisionOf = useCallback(async (candidate: string) => (await client.request("session/revision", { path: candidate })).revision, [client]);
  const wanted = enabled && path !== undefined && isReadable(ref) && ref.excerpt.bytes === 0;
  const key = wanted ? `${path}\0${ref.entryId}\0${JSON.stringify(ref.component)}\0${ref.totalBytes}` : "";

  useEffect(() => {
    if (!wanted || !isReadable(ref) || path === undefined) { setPreview(undefined); return; }
    const pager = new OutputPager(request, path, ref, environmentKey, revisionOf);
    let done = false;
    const forget = registerEphemeralCache({ clear: () => { setPreview(undefined); return { count: 0, bytes: 0 }; } });
    const unsubscribe = pager.subscribe(() => {
      const segment = pager.getSnapshot().segments.get(0);
      if (!segment || done) return;
      done = true;
      const cut = charIndexAtByte(segment.text, segment.start, Math.min(segment.end, segment.start + OUTPUT_PREVIEW_BYTES));
      setPreview({ key, text: segment.text.slice(0, cut.index) });
      // Only the preview is kept; the segment it came from is let go.
      pager.clear();
    });
    pager.show(0);
    return () => { done = true; unsubscribe(); forget(); pager.clear(); };
    // `key` names everything the read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, request, revisionOf, environmentKey]);

  return preview && preview.key === key ? preview.text : undefined;
}
