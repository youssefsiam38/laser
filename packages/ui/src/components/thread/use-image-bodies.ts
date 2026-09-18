"use client";
/**
 * Images a transcript points at rather than holds (RP-5b, M16-T82).
 *
 * A prompt's image is never kept as base64 in the store: the view keeps its
 * reference, and the bytes are read back through `session/entry_range` into a
 * `Blob`, which lives outside the JavaScript heap and is bounded and revoked
 * by {@link ImageBlobs}.
 *
 * What a row tells the pool is where it is: actually inside the viewport,
 * close to it, or neither — real visibility from an `IntersectionObserver` on
 * the tile itself, because a mounted row is not a row anybody can see. The
 * pool decodes what is on screen first and gives up what has been off screen
 * longest, so a prompt with more pictures than one window may decode at once
 * still shows every one of them as it comes into view. A picture the pool has
 * no room for says it is waiting, never that it failed, and opening one reads
 * its bytes back whatever the pool is holding.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ImageContent } from "@lasercode/protocol";
import { useLaserStable, useLaserState } from "@/runtime";
import { registerEphemeralCache } from "@/runtime/pressure";
import { IMAGE_PRIORITY, ImageBlobs, type ImageFailure, type ImagePriority } from "@/runtime/image-blobs";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import type { BlockBodies } from "@/store";

export interface ImageSource {
  src?: string | undefined;
  state: "ready" | "loading" | "waiting" | "failed";
  /** Why it is not showing, in a person's words. Absent while it is ready. */
  message?: string | undefined;
  /** Whether its bytes can be opened at all, decoded here or not. */
  openable: boolean;
  /** A read this person's own click started, still in flight. */
  pending?: boolean | undefined;
  /** Present only when trying again is the thing that helps. */
  onRetry?: (() => void) | undefined;
}

/**
 * How far outside the viewport counts as "about to be read". Conservative on
 * purpose: enough to decode the next row before it arrives, not enough to
 * speculatively rebuild a conversation.
 */
const NEARBY_MARGIN = "600px 0px";

const WAITING_COPY = {
  offscreen: "Shown when it scrolls into view",
  room: "Shown when this window has room",
  retired: "Loading image…",
} as const;

/** A picture a person asked for, being read for them right now. */
const OPENING_COPY = "Opening…";

const FAILURE_COPY: Record<ImageFailure, string> = {
  "too-large": "Too large to show here",
  corrupt: "This image could not be rebuilt",
  moved: "The conversation moved on",
  unavailable: "Could not be read just now",
};

/** The same sentence, written out for the line under the pictures. */
const FAILURE_SENTENCE: Record<ImageFailure, string> = {
  "too-large": "is too large to open in this window.",
  corrupt: "did not come back as this image. Try again.",
  moved: "moved with the conversation. Try again.",
  unavailable: "could not be read just now. Try again in a moment.",
};

/**
 * One bounded pool per window and per environment: a device that switches
 * environments never reads with the key of the one it just left (RP-13), and
 * the pool it held is dropped with its object URLs. The live pool is a
 * releasable cache for the window's memory-pressure controller: its offscreen
 * residue goes back on demand (RP-8 step 1).
 */
let pool: { key: string; blobs: ImageBlobs; forget: () => void } | undefined;

/**
 * An image's identity, not its moment: the conversation it belongs to, the
 * entry, the component, and the digest of the bytes themselves. A conversation
 * that advances its revision around an unchanged picture keeps the picture —
 * only bytes that are actually different are read again. A reference with no
 * published digest falls back to the revision it was read at, which is the
 * only identity it has.
 *
 * The pool is one per window, so the session's own path is part of the key:
 * nothing rests on entry ids being unique across every conversation a person
 * opens.
 */
function imageKey(path: string, ref: BodyRef & { entryId: string }): string {
  return `${path}\u0000${ref.entryId}:${ref.component.kind}:${ref.component.index ?? 0}:${ref.contentDigest ?? `r${ref.revision ?? ""}`}`;
}

/**
 * Where each picture is: on screen, close to it, or neither.
 *
 * `enabled` is whether this row points at any picture at all. Most messages
 * point at none, and a transcript keeps many rows mounted: observers are built
 * for the rows that actually carry images, never for every message on screen.
 */
function useImageVisibility(enabled: boolean) {
  const nodes = useRef(new Map<number, HTMLElement>());
  const flags = useRef(new Map<HTMLElement, { visible: boolean; nearby: boolean }>());
  const observers = useRef<IntersectionObserver[]>([]);
  const callbacks = useRef(new Map<number, (element: HTMLElement | null) => void>());
  const [ranks, setRanks] = useState<ReadonlyMap<number, ImagePriority>>(() => new Map());

  const apply = useCallback(() => {
    setRanks(previous => {
      const next = new Map<number, ImagePriority>();
      for (const [index, element] of nodes.current) {
        const seen = flags.current.get(element);
        // Nothing observed yet is treated as on screen: a picture never waits
        // for an observer to prove it is visible before it starts loading.
        next.set(index, seen === undefined || seen.visible
          ? IMAGE_PRIORITY.visible
          : seen.nearby ? IMAGE_PRIORITY.nearby : IMAGE_PRIORITY.background);
      }
      if (previous.size === next.size && [...next].every(([index, rank]) => previous.get(index) === rank)) return previous;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === "undefined") return;
    const mark = (field: "visible" | "nearby") => (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const seen = flags.current.get(element) ?? { visible: false, nearby: false };
        seen[field] = entry.isIntersecting;
        flags.current.set(element, seen);
      }
      apply();
    };
    const watching = [
      new IntersectionObserver(mark("visible")),
      new IntersectionObserver(mark("nearby"), { rootMargin: NEARBY_MARGIN }),
    ];
    observers.current = watching;
    for (const element of nodes.current.values()) for (const observer of watching) observer.observe(element);
    return () => {
      for (const observer of watching) observer.disconnect();
      observers.current = [];
      flags.current.clear();
    };
  }, [apply, enabled]);

  /** A stable ref callback per picture, so React does not re-register it. */
  const observe = useCallback((index: number) => {
    const held = callbacks.current.get(index);
    if (held) return held;
    const callback = (element: HTMLElement | null) => {
      const previous = nodes.current.get(index);
      if (previous && previous !== element) {
        for (const observer of observers.current) observer.unobserve(previous);
        flags.current.delete(previous);
      }
      if (element) {
        nodes.current.set(index, element);
        for (const observer of observers.current) observer.observe(element);
      } else nodes.current.delete(index);
      apply();
    };
    callbacks.current.set(index, callback);
    return callback;
  }, [apply]);

  return { observe, ranks };
}

export function useImageBodies(path: string | undefined, images: readonly ImageContent[], bodies: BlockBodies | undefined) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const refs = bodies?.images;
  const [version, changed] = useReducer((count: number) => count + 1, 0);
  const [problem, setProblem] = useState<string>();
  const blobs = useMemo(() => {
    if (pool?.key !== environmentKey) {
      pool?.forget();
      pool?.blobs.clear();
      const blobs = new ImageBlobs(
        (params) => client.request("session/entry_range", params),
        environmentKey,
        async (candidate) => (await client.request("session/revision", { path: candidate })).revision,
      );
      // Under memory pressure this window gives back the pictures it is
      // keeping for rows nobody is looking at: they cost a re-read to get
      // back, and nothing on screen is drawn from them (RP-8 step 1).
      pool = { key: environmentKey, blobs, forget: registerEphemeralCache({ clear: () => blobs.releaseIdle() }) };
    }
    return pool.blobs;
  }, [client, environmentKey]);

  /** Every picture this row points at rather than holds, by its identity. */
  const keys = useMemo(() => {
    const found = new Map<number, string>();
    if (!refs || path === undefined) return found;
    for (const [index, ref] of refs.entries()) {
      if (!ref || !isReadable(ref) || images[index]?.data) continue;
      found.set(index, imageKey(path, ref));
    }
    return found;
  }, [images, path, refs]);
  // Only a row that carries pictures watches where they are.
  const { observe, ranks } = useImageVisibility(keys.size > 0);
  /** Pictures a click is reading right now, so a second click joins nothing. */
  const [opening, setOpening] = useState<ReadonlySet<number>>(() => new Set());
  const openingNow = useRef<ReadonlySet<number>>(opening);
  openingNow.current = opening;

  /**
   * The identities this row is holding, as one string. A store update that
   * rebuilds the same references — every delta of a streaming turn does — must
   * not give the pictures back and read them all again: the holds follow what
   * the row points at, not how often React rebuilt the array.
   */
  const signature = [...keys].map(([index, key]) => `${index}\u0001${key}`).join("\u0000");
  const held = useRef<{ signature: string; keys: Map<number, string> }>({ signature, keys });
  if (held.current.signature !== signature) held.current = { signature, keys };
  // What the loads need, read at the moment they run rather than depended on:
  // visibility is a `prioritize`, never a second hold.
  const latest = useRef({ refs, images, ranks });
  latest.current = { refs, images, ranks };

  useEffect(() => {
    const { keys: wanted } = held.current;
    if (path === undefined || wanted.size === 0) return;
    const holding: string[] = [];
    const watching: Array<() => void> = [];
    for (const [index, key] of wanted) {
      const ref = latest.current.refs?.[index];
      if (!ref || !isReadable(ref)) continue;
      holding.push(key);
      watching.push(blobs.watch(key, changed));
      void blobs.load(key, path, ref, latest.current.images[index]?.mimeType ?? "image/png", latest.current.ranks.get(index) ?? IMAGE_PRIORITY.visible)
        .then(changed);
    }
    return () => {
      for (const stop of watching) stop();
      // Every image this row showed is one holder of its blob; the last row to
      // go revokes the URL, so nothing decoded outlives what is on screen.
      for (const key of holding) blobs.release(key);
    };
  }, [blobs, path, signature]);

  // Where each picture is now. The pool decides what that means for the ones
  // it has no room for: they queue, and come back.
  useEffect(() => {
    for (const [index, key] of held.current.keys) blobs.prioritize(key, ranks.get(index) ?? IMAGE_PRIORITY.visible);
  }, [blobs, ranks, signature]);

  const sourceFor = useCallback((index: number, image: ImageContent): ImageSource => {
    if (image.data) return { src: `data:${image.mimeType};base64,${image.data}`, state: "ready", openable: true };
    const key = keys.get(index);
    const ref = refs?.[index];
    if (!key || !ref || !isReadable(ref)) {
      return { state: "failed", message: "Not kept in this window", openable: false };
    }
    const status = blobs.stateOf(key);
    const pending = opening.has(index);
    if (status.state === "ready") return { src: status.url, state: "ready", openable: true, pending };
    if (status.state === "loading") return { state: "loading", message: "Loading image…", openable: true, pending };
    if (status.state === "waiting") {
      return status.reason === "retired"
        ? { state: "loading", message: WAITING_COPY.retired, openable: true, pending }
        : { state: "waiting", message: pending ? OPENING_COPY : WAITING_COPY[status.reason], openable: true, pending };
    }
    return {
      state: "failed",
      message: FAILURE_COPY[status.reason],
      openable: status.reason !== "too-large",
      onRetry: status.reason === "too-large" ? undefined : () => { blobs.retry(key); changed(); },
    };
    // `version` is what makes this recompute when the pool moves underneath.
  }, [blobs, keys, opening, refs, version]);

  /**
   * What went wrong with this row's pictures, written out once under the grid.
   * A tile is 112 px in a multi-image prompt: it shows the state and the way
   * out, and the sentence explaining it belongs where there is room for it.
   */
  const failures = useMemo(() => {
    const lines: string[] = [];
    for (const [index, key] of keys) {
      const status = blobs.stateOf(key);
      if (status.state === "failed") lines.push(`Image ${index + 1} ${FAILURE_SENTENCE[status.reason]}`);
    }
    return lines;
    // `version` is what makes this recompute when the pool moves underneath.
  }, [blobs, keys, version]);

  /**
   * The picture itself, for opening, copying or saving it: the pool's own blob
   * when it has one, and otherwise the same verified read from the
   * conversation's own authority. The action works whenever the bytes exist —
   * it is never gated on what happens to be decoded (M16-T82).
   */
  const openFor = useCallback(async (index: number, name: string) => {
    const image = images[index];
    const ref = refs?.[index];
    const key = keys.get(index);
    if (!image || image.data) return undefined;
    if (!key || !ref || !isReadable(ref) || path === undefined) {
      setProblem(`Image ${index + 1} cannot be opened from here. Open the conversation again.`);
      return undefined;
    }
    // One read per picture, however impatient the clicking: the pool coalesces
    // the read itself, and the tile says it is busy meanwhile.
    if (openingNow.current.has(index)) return undefined;
    setProblem(undefined);
    setOpening(current => new Set(current).add(index));
    try {
      const opened = await blobs.open(key, path, ref, image.mimeType ?? "image/png");
      changed();
      if ("failed" in opened) {
        setProblem(`Image ${index + 1} ${FAILURE_SENTENCE[opened.failed]}`);
        return undefined;
      }
      return {
        picture: { url: opened.url, blob: opened.blob, name, mediaType: image.mimeType ?? "image/png", bytes: opened.bytes },
        release: opened.release,
      };
    } finally {
      setOpening(current => {
        if (!current.has(index)) return current;
        const next = new Set(current);
        next.delete(index);
        return next;
      });
    }
  }, [blobs, images, keys, path, refs]);

  /** The openable problem a person is told about: their click first, then the row's. */
  const told = problem ?? (failures.length === 0 ? undefined
    : failures.length === 1 ? failures[0]
    : `${failures.length} images could not be shown. ${failures[0]}`);

  return useMemo(() => ({ sourceFor, openFor, observe, problem: told }), [observe, openFor, sourceFor, told]);
}
