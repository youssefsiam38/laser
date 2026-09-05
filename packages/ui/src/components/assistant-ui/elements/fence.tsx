/**
 * The fenced code block's box, shared by the Shiki element and its plain
 * fallback so a fence looks the same tokenized or not. `markdown-text`'s
 * `CodeHeader` draws the top edge, so the pre has no top radius.
 */
import { cn } from "@/lib/utils";

export const fenceClassName = cn(
  "aui-shiki [&>pre]:mb-4 [&>pre]:overflow-x-auto [&>pre]:rounded-b-lg [&>pre]:border [&>pre]:border-line",
  "[&>pre]:bg-surface-2! [&>pre]:p-3.5 [&>pre]:font-mono [&>pre]:text-xs [&>pre]:leading-sm [&>pre]:text-ink!",
  "[&>pre]:last:mb-0 [&_code]:block [&_code]:font-mono [&_.line]:px-0!",
);
