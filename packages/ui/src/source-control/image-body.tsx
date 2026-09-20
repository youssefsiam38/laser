/**
 * The body for a file git has no lines to diff (M20-T5).
 *
 * An image is shown: the new one, the old one beside it when both exist, with
 * both sizes, both pixel sizes and the delta in bytes. Everything else — an
 * archive, a font, a `.wasm` — gets the written state, which is not an error:
 * we read the file, it simply has no lines to compare.
 *
 * The picture itself is the catalog's **Image** element
 * (`docs/ux-elements.md` → Image, `elements/image.tsx`), in its standalone
 * `ImagePreview` form: it already owns the loading frame, the "could not be
 * decoded" state and `object-contain`, so this file adds only the two things
 * that are the overlay's — where the bytes come from, and what the caption
 * says about them.
 *
 * Bytes are read only when a person opens the file, one bounded page at a
 * time, into a `Blob` whose object URL is revoked when the file changes or the
 * modal closes. Never a data URL: that would keep a copy of the picture alive
 * in a string for as long as anything held the state.
 */
import { useEffect, useMemo, useState } from "react";
import { FILE_BLOB_MAX_BYTES, FILE_BLOB_PAGE_MAX_BYTES } from "@lasercode/protocol";

import { ImagePreview } from "@/components/assistant-ui/elements/image.js";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/format";

import type { ChangesScope, FileBytesPage } from "./contract.js";
import { getChangesAdapter } from "./data.js";
import {
  binarySizePredicate,
  binaryTitle,
  byteDelta,
  dimensionText,
  fileFormatWord,
  imageAltText,
  refusalSentence,
  sideLabel,
  type BinaryFileView,
  type BinarySide,
  type SideRefusal,
} from "./image-diff.js";
import { ChangesNotice } from "./states.js";
import type { DiffStylePref } from "./prefs.js";

/** At most this many pages for one side: the ceiling divided by the page. */
const MAX_PAGES = Math.ceil(FILE_BLOB_MAX_BYTES / FILE_BLOB_PAGE_MAX_BYTES);

type SideState =
  | { state: "loading" }
  | { state: "ready"; url: string; totalBytes: number; width?: number; height?: number }
  | { state: "refused"; refusal: SideRefusal; totalBytes?: number };

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * One side's bytes, paged in and held as a `Blob`.
 *
 * `wanted` is false for a side this change does not have (the old end of an
 * added file), and nothing is requested for it at all.
 */
export function useSideBytes(scope: ChangesScope, view: BinaryFileView, side: BinarySide, wanted: boolean): SideState {
  const adapter = getChangesAdapter();
  const path = side === "old" ? (view.oldPath ?? view.path) : view.path;
  const scopeKey = JSON.stringify(scope);
  const [state, setState] = useState<SideState>({ state: "loading" });

  useEffect(() => {
    if (!wanted) return;
    const load = adapter.getFileBytes;
    setState({ state: "loading" });
    if (!load) {
      setState({ state: "refused", refusal: "unavailable" });
      return;
    }
    let cancelled = false;
    let url: string | undefined;
    void (async () => {
      try {
        const chunks: Uint8Array[] = [];
        let first: FileBytesPage | undefined;
        let offset = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const got = await load(scope, view.repo, path, side, { offset });
          if (cancelled) return;
          if (!got) {
            setState({ state: "refused", refusal: "missing" });
            return;
          }
          first ??= got;
          if (got.refused) {
            setState({ state: "refused", refusal: got.refused, totalBytes: got.totalBytes });
            return;
          }
          if (got.data) chunks.push(decodeBase64(got.data));
          if (got.next === undefined) break;
          offset = got.next;
        }
        if (!first) return;
        const held = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        if (held < first.totalBytes) {
          // More pages than the ceiling allows. The size is still true.
          setState({ state: "refused", refusal: "too-large", totalBytes: first.totalBytes });
          return;
        }
        // Outside the JavaScript heap, and revoked with this effect: a picture
        // never outlives the file it belongs to.
        const made = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: first.mediaType }));
        if (cancelled) {
          URL.revokeObjectURL(made);
          return;
        }
        url = made;
        setState({
          state: "ready",
          url: made,
          totalBytes: first.totalBytes,
          ...(first.width !== undefined ? { width: first.width } : {}),
          ...(first.height !== undefined ? { height: first.height } : {}),
        });
      } catch {
        if (!cancelled) setState({ state: "refused", refusal: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // `scopeKey` stands in for `scope`, which is a fresh object on every read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter, scopeKey, view.repo, path, side, wanted]);

  return wanted ? state : { state: "refused", refusal: "missing" };
}

function sizeOf(state: SideState): number | undefined {
  if (state.state === "ready") return state.totalBytes;
  if (state.state === "refused") return state.totalBytes;
  return undefined;
}

/** A path inside a sentence: typed, isolated, and never the thing that wraps. */
function Typed({ children }: { children: string }) {
  return <span className="typed break-all text-ink">{children}</span>;
}

function SideCaption({
  view,
  side,
  state,
  delta,
}: {
  view: BinaryFileView;
  side: BinarySide;
  state: SideState;
  delta?: string | undefined;
}) {
  const size = sizeOf(state);
  const dimensions = state.state === "ready" ? dimensionText(state) : undefined;
  return (
    <figcaption
      data-slot="changes-image-caption"
      className="flex shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1"
    >
      <span className="text-sm leading-sm font-medium text-ink">{sideLabel(view, side)}</span>
      {size !== undefined ? (
        <span data-slot="changes-image-size" className="typed tnum text-ink-3">
          {formatBytes(size)}
        </span>
      ) : null}
      {dimensions ? (
        <span data-slot="changes-image-dimensions" className="typed tnum text-ink-3">
          {dimensions}
        </span>
      ) : null}
      {delta ? (
        <span data-slot="changes-image-delta" className="typed tnum text-ink-2">
          {delta}
        </span>
      ) : null}
    </figcaption>
  );
}

function ImageSide({
  view,
  side,
  state,
  delta,
}: {
  view: BinaryFileView;
  side: BinarySide;
  state: SideState;
  delta?: string | undefined;
}) {
  return (
    <figure
      data-slot="changes-image-side"
      data-side={side}
      data-state={state.state}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-4"
    >
      <SideCaption view={view} side={side} state={state} delta={delta} />
      <div className="flex min-h-32 min-w-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-surface-2 p-2">
        {state.state === "ready" ? (
          <ImagePreview
            src={state.url}
            alt={imageAltText(view, side)}
            {...(state.width !== undefined && state.height !== undefined
              ? { width: state.width, height: state.height }
              : {})}
            containerClassName="flex max-h-full min-h-0 min-w-0 max-w-full items-center justify-center"
            className="h-auto max-h-full w-auto max-w-full object-contain"
          />
        ) : state.state === "loading" ? (
          <p role="status" className="max-w-(--measure-prose) text-sm leading-sm text-ink-3">
            Reading this image…
          </p>
        ) : (
          <p className="max-w-(--measure-prose) text-sm leading-sm text-ink-2">
            {refusalSentence(state.refusal, state.totalBytes, FILE_BLOB_MAX_BYTES)}
          </p>
        )}
      </div>
    </figure>
  );
}

/**
 * The body. Split lays the two ends side by side and unified stacks them —
 * the same decision the text diff makes, taken from the same preference, so
 * the two bodies never disagree about which layout the window is in.
 */
export function BinaryFileBody({
  view,
  scope,
  diffStyle,
}: {
  view: BinaryFileView;
  scope: ChangesScope;
  diffStyle: DiffStylePref;
}) {
  const wantsOld = view.sides.includes("old");
  const wantsNew = view.sides.includes("new");
  const old = useSideBytes(scope, view, "old", wantsOld);
  const next = useSideBytes(scope, view, "new", wantsNew);
  const sizes = useMemo(
    () => ({
      ...(wantsOld && sizeOf(old) !== undefined ? { old: sizeOf(old) } : {}),
      ...(wantsNew && sizeOf(next) !== undefined ? { next: sizeOf(next) } : {}),
    }),
    [old, next, wantsOld, wantsNew],
  );
  const delta = wantsOld && wantsNew ? byteDelta(sizes.old, sizes.next) : undefined;
  const split = diffStyle === "split" && view.sides.length > 1;

  if (!view.mediaType) {
    // The notice keeps its own `data-slot`: this is one of the body's designed
    // states, and the surface reads them all through that one attribute.
    return (
      <ChangesNotice data-binary={view.kind} title={binaryTitle(view)}>
        <p>
          <Typed>{view.path}</Typed> {binarySizePredicate(view, sizes)}
        </p>
        <p>
          A {fileFormatWord(view.path)} file has no lines to compare, so its size is the whole of what this view can
          show.
        </p>
        <p>Open it where it is meant to be read to see the rest.</p>
      </ChangesNotice>
    );
  }

  return (
    <div
      data-slot="changes-binary"
      data-kind={view.kind}
      data-media={view.mediaType}
      data-layout={split ? "split" : "unified"}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="shrink-0 hairline-b px-4 py-2">
        <p className="max-w-(--measure-prose) text-sm leading-sm text-ink-2">
          <Typed>{view.path}</Typed> {binarySizePredicate(view, sizes)}
        </p>
      </header>
      <div
        /* Stacked, the two ends can be taller than the body, and a scroll box
           nothing can focus is a scroll box a keyboard cannot move. Split
           never scrolls: each picture is contained in its own pane. */
        {...(split ? {} : { tabIndex: 0, role: "region", "aria-label": `${view.path}, before and after` })}
        className={cn(
          "flex min-h-0 min-w-0 flex-1 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-live",
          split ? "flex-row divide-x divide-line overflow-hidden" : "flex-col divide-y divide-line overflow-y-auto overscroll-contain",
        )}
      >
        {wantsOld ? <ImageSide view={view} side="old" state={old} /> : null}
        {wantsNew ? (
          <ImageSide view={view} side="new" state={next} {...(delta ? { delta } : {})} />
        ) : null}
      </div>
    </div>
  );
}
