"use client";
/**
 * The `src` of the attachment in scope: an object URL for a pending `File`,
 * or the data URL of a completed image part. Installed with the `attachment`
 * element; rewritten without `zustand/react/shallow` — two primitive
 * selectors need no shallow compare.
 */
import { useAuiState } from "@assistant-ui/react";
import { useEffect, useState } from "react";

function useFileSrc(file: File | undefined): string | undefined {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(undefined);
  useEffect(() => {
    if (!file) {
      setEntry(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setEntry({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return entry !== undefined && entry.file === file ? entry.url : undefined;
}

export function useAttachmentSrc(): string | undefined {
  const file = useAuiState((s) => (s.attachment.type === "image" ? s.attachment.file : undefined));
  const src = useAuiState((s) => {
    if (s.attachment.type !== "image" || s.attachment.file) return undefined;
    const part = s.attachment.content?.find((c) => c.type === "image");
    return part && part.type === "image" ? part.image : undefined;
  });
  return useFileSrc(file) ?? src;
}
