/**
 * Document renderers (M8-T3). A markdown, diff, image or text body is useful
 * anywhere — the transcript, a sheet, a future file viewer — and none of them
 * knows where its bytes came from.
 *
 * Native replacements for pi-markdown-preview and @xynogen/pix-display, both
 * terminal-only (docs/research/findings.md).
 */
export { MarkdownPreview, type MarkdownPreviewProps } from "./MarkdownPreview.js";
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
