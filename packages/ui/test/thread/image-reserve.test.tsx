// @vitest-environment happy-dom
/**
 * An image reserves its own box before it decodes (M16-T87, D-303).
 *
 * The transcript's engine anchors rows, so content growing *inside* the row
 * somebody is reading, above their line, moves their text by that much — and
 * an image arriving at full height was the largest instance of that by a long
 * way. Laser already reads dimensions out of a bounded prefix of the image's
 * own bytes for accounting; the same numbers reserve the space, so the decode
 * changes no height at all.
 *
 * What this cannot prove is the pixels: happy-dom lays nothing out. It proves
 * the box is declared, from the real header parser, for the formats the parser
 * knows and for nothing else. `docs/transcript-reading.md` records the rest.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Image, ImagePreview } from "../../src/components/assistant-ui/elements/image.js";

let container: HTMLDivElement;
let root: Root;

const base64 = (bytes: number[]): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** A real PNG header: signature, IHDR, then the size the transcript reads. */
const png = (width: number, height: number): string => {
  const be = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
  return `data:image/png;base64,${base64([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...be(13), 0x49, 0x48, 0x44, 0x52,
    ...be(width), ...be(height),
  ])}`;
};

const preview = () => container.querySelector<HTMLElement>('[data-slot="image-preview"]');

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("holds the space a picture is going to need, from the picture's own header", async () => {
  await act(async () => root.render(<ImagePreview src={png(2048, 1024)} alt="A picture" />));
  expect(preview()?.style.aspectRatio).toBe("2048 / 1024");
  expect(preview()?.dataset["reserved"]).toBe("2048x1024");
  const img = container.querySelector("img")!;
  expect(img.getAttribute("width")).toBe("2048");
  expect(img.getAttribute("height")).toBe("1024");
});

it("reserves nothing it cannot read, rather than guessing a shape", async () => {
  // A remote picture: the bytes are not here, so the size is not knowable.
  // (What is and is not readable is `dataUriImageDimensions`' own contract,
  // pinned in `test/runtime/view-measure.test.ts`.)
  await act(async () => root.render(<ImagePreview src="https://example.invalid/picture.png" alt="A picture" />));
  expect(preview()?.style.aspectRatio).toBeFalsy();
  expect(preview()?.dataset["reserved"]).toBeUndefined();

  // Inline bytes whose header says nothing this parser knows.
  await act(async () => root.render(<ImagePreview src={`data:image/svg+xml;base64,${base64([0x3c, 0x73, 0x76, 0x67, 0x3e, 0x3c, 0x2f, 0x73, 0x76, 0x67, 0x3e])}`} alt="A picture" />));
  expect(preview()?.style.aspectRatio).toBeFalsy();
  expect(preview()?.dataset["reserved"]).toBeUndefined();
});

it("reserves the box through the image part the transcript renders", async () => {
  await act(async () => root.render(<Image type="image" image={png(600, 900)} status={{ type: "complete" }} />));
  expect(preview()?.style.aspectRatio).toBe("600 / 900");
});

it("gives the space back when the picture turns out not to be one", async () => {
  const src = png(2048, 1024);
  await act(async () => root.render(<ImagePreview src={src} alt="A picture" />));
  expect(preview()?.style.aspectRatio).toBe("2048 / 1024");
  await act(async () => { container.querySelector("img")!.dispatchEvent(new Event("error")); });
  // Nothing is going to fill that box now, so the failure state keeps its own
  // size instead of standing in a reserved rectangle it cannot use.
  expect(preview()?.style.aspectRatio).toBeFalsy();
  expect(container.querySelector('[data-slot="image-preview-error"]')).not.toBeNull();
});
