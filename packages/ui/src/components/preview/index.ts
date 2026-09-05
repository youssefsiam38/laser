/**
 * Document-panel bodies (M8-T3). The dock mounts `DocumentBody`; the four
 * renderers are exported too, because a markdown or diff body is useful
 * anywhere — a sheet, a maximized island, a future file viewer — and none of
 * them knows anything about panels.
 *
 * Native replacements for pi-markdown-preview and @xynogen/pix-display, both
 * terminal-only (docs/research/findings.md).
 */
export { DocumentBody, type DocumentBodyProps, type DocumentContent } from "./DocumentBody.js";
export { MarkdownPreview, type MarkdownPreviewProps } from "./MarkdownPreview.js";
export { DiffPreview, type DiffPreviewProps } from "./DiffPreview.js";
export { ImagePreview, type ImagePreviewProps } from "./ImagePreview.js";
export { TextPreview, type TextPreviewProps } from "./TextPreview.js";
export { OpenExternally, type OpenExternallyProps } from "./OpenExternally.js";
export {
  baseMediaType,
  describeMediaType,
  isPreviewable,
  needsBinaryRead,
  previewKindFor,
  type PreviewKind,
} from "./media.js";
