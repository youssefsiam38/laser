/**
 * The renderer table (M8-T3). A lookup table is exactly the kind of logic a
 * test is the cheapest proof for: every row is a promise that `renderable`
 * means something, and the interesting cases are the ties.
 */
import { describe, expect, it } from "vitest";

import { baseMediaType, describeMediaType, isPreviewable, needsBinaryRead, previewKindFor } from "@/components/preview/media";

describe("previewKindFor", () => {
  it("ignores parameters and casing on the media type", () => {
    expect(baseMediaType("text/markdown; charset=utf-8")).toBe("text/markdown");
    expect(previewKindFor("TEXT/MARKDOWN; charset=UTF-8")).toBe("markdown");
  });

  it("draws markdown, diffs, images and source text", () => {
    expect(previewKindFor("text/markdown")).toBe("markdown");
    expect(previewKindFor("text/x-diff")).toBe("diff");
    expect(previewKindFor("application/x-patch")).toBe("diff");
    expect(previewKindFor("image/png")).toBe("image");
    expect(previewKindFor("image/svg+xml")).toBe("image");
    expect(previewKindFor("application/json")).toBe("text");
  });

  it("lets the path break a tie the media type left open", () => {
    // A producer that does not know markdown types still gets markdown.
    expect(previewKindFor("text/plain", "/repo/README.md")).toBe("markdown");
    expect(previewKindFor("text/plain", "/tmp/fix.patch")).toBe("diff");
    // ...but a specific declared type wins over the file name.
    expect(previewKindFor("text/markdown", "/repo/notes.txt")).toBe("markdown");
    expect(previewKindFor("image/png", "/repo/logo.md")).toBe("image");
  });

  it("refuses to guess at formats no browser draws", () => {
    for (const type of ["application/pdf", "image/tiff", "image/heic", "application/zip", "application/octet-stream"]) {
      expect(previewKindFor(type)).toBe("none");
      expect(isPreviewable(type)).toBe(false);
    }
    // Not even when the file name suggests otherwise: the bytes are still a PDF.
    expect(previewKindFor("application/pdf", "/docs/spec.md")).toBe("none");
  });

  it("shows an unknown text-ish type as text rather than as nothing", () => {
    expect(previewKindFor("text/csv")).toBe("text");
    expect(previewKindFor("application/vnd.custom+json")).toBe("text");
    expect(previewKindFor("application/vnd.custom+yaml")).toBe("text");
    // A binary type we have never seen stays a question, not a guess.
    expect(previewKindFor("application/vnd.sqlite3")).toBe("none");
    expect(previewKindFor("")).toBe("none");
  });

  it("asks for base64 only where an image needs it", () => {
    expect(needsBinaryRead("image/webp")).toBe(true);
    expect(needsBinaryRead("text/markdown")).toBe(false);
    expect(needsBinaryRead("application/pdf")).toBe(false);
  });
});

describe("describeMediaType", () => {
  it("names formats the way a person would", () => {
    expect(describeMediaType("text/markdown")).toBe("Markdown");
    expect(describeMediaType("text/x-diff")).toBe("Unified diff");
    expect(describeMediaType("application/pdf")).toBe("PDF");
    expect(describeMediaType("image/png")).toBe("PNG image");
    expect(describeMediaType("image/svg+xml")).toBe("SVG image");
  });

  it("still says something useful for a type it has never seen", () => {
    expect(describeMediaType("application/vnd.sqlite3")).toBe("VND.SQLITE3");
    expect(describeMediaType("")).toBe("Unknown format");
  });
});
