"use client";
/**
 * Images a transcript points at rather than holds (RP-5b).
 *
 * A prompt's image is never kept as base64 in the store: the view keeps its
 * reference, and the bytes are read back through `session/entry_range` into a
 * `Blob`, which lives outside the JavaScript heap and is bounded and revoked
 * by {@link ImageBlobs}. A row that has not been read yet, or cannot be, says
 * so rather than showing a broken picture.
 */
import { useEffect, useMemo, useState } from "react";
import type { ImageContent } from "@lasercode/protocol";
import { useLaserStable, useLaserState } from "@/runtime";
import { ImageBlobs } from "@/runtime/body-reader";
import { isReadable, type BodyRef } from "@/runtime/body-excerpt";
import type { BlockBodies } from "@/store";

export interface ImageSource {
  src?: string | undefined;
  state: "ready" | "loading" | "unavailable";
}

/**
 * One bounded pool per window and per environment: a device that switches
 * environments never reads with the key of the one it just left (RP-13), and
 * the pool it held is dropped with its object URLs.
 */
let pool: { key: string; blobs: ImageBlobs } | undefined;

export function useImageBodies(path: string | undefined, images: readonly ImageContent[], bodies: BlockBodies | undefined) {
  const { client } = useLaserStable();
  const environmentKey = useLaserState(s => s.environment?.environmentKey) ?? "";
  const refs = bodies?.images;
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState<Record<number, true>>({});
  const blobs = useMemo(() => {
    if (pool?.key !== environmentKey) {
      pool?.blobs.clear();
      pool = {
        key: environmentKey,
        blobs: new ImageBlobs(
          (params) => client.request("session/entry_range", params),
          environmentKey,
          async (candidate) => (await client.request("session/revision", { path: candidate })).revision,
        ),
      };
    }
    return pool.blobs;
  }, [client, environmentKey]);

  useEffect(() => {
    if (!refs || path === undefined) return;
    let live = true;
    // Every image this row shows is one holder of its blob; the last row to go
    // revokes the URL, so nothing decoded outlives what is on screen.
    const holding: string[] = [];
    for (const [index, ref] of refs.entries()) {
      if (!ref || !isReadable(ref) || images[index]?.data) continue;
      const key = `${ref.entryId}:${ref.component.kind}:${ref.component.index ?? 0}:${ref.revision ?? ""}`;
      holding.push(key);
      void blobs.load(key, path, ref, images[index]?.mimeType ?? "image/png").then(url => {
        if (!live) return;
        if (url) setUrls(current => (current[index] === url ? current : { ...current, [index]: url }));
        else setFailed(current => ({ ...current, [index]: true }));
      });
    }
    return () => {
      live = false;
      for (const key of holding) blobs.release(key);
    };
  }, [blobs, images, path, refs]);

  const sourceFor = useMemo(() => (index: number, image: ImageContent): ImageSource => {
    if (image.data) return { src: `data:${image.mimeType};base64,${image.data}`, state: "ready" };
    const url = urls[index];
    if (url) return { src: url, state: "ready" };
    const ref: BodyRef | undefined = refs?.[index];
    if (failed[index] || !ref || !isReadable(ref)) return { state: "unavailable" };
    return { state: "loading" };
  }, [failed, refs, urls]);

  /**
   * The rebuilt picture itself, for opening, copying or saving it: the pool's
   * own blob, held while the viewer is open and given back on close. Nothing is
   * fetched back from the object URL, so nothing is charged twice (RP-5b).
   */
  const pictureFor = useMemo(() => (index: number, name: string) => {
    const ref = refs?.[index];
    if (!ref || !isReadable(ref) || images[index]?.data) return undefined;
    const key = `${ref.entryId}:${ref.component.kind}:${ref.component.index ?? 0}:${ref.revision ?? ""}`;
    const held = blobs.source(key);
    if (!held) return undefined;
    return {
      picture: { url: held.url, blob: held.blob, name, mediaType: images[index]?.mimeType ?? "image/png", bytes: held.bytes },
      release: () => blobs.release(key),
    };
  }, [blobs, images, refs]);

  return useMemo(() => Object.assign(sourceFor, { pictureFor }), [pictureFor, sourceFor]);
}
