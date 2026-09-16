import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileOpenerContext, type FileOpener, type FileViewerSource } from "@/lib/file-opener";
import { ProjectFileCache } from "@/runtime/project-file-cache";
import { registerEphemeralCache } from "@/runtime/pressure";
import { useLaserStable } from "@/runtime";
import { FileViewer } from "./FileViewer.js";

/** One viewer and bounded read cache per thread, shared by files, images and tool cards. */
export function FileOpenerProvider({ children, scope }: { children: ReactNode; scope?: string | undefined }) {
  const { client } = useLaserStable();
  const cache = useMemo(() => new ProjectFileCache((cwd, path) => client.request("pi/project/read", { cwd, path })), [client, scope]);
  // Under memory pressure this window gives back what it can rebuild, and the
  // bounded file reads a thread has accumulated are exactly that (RP-8 step 1).
  useEffect(() => registerEphemeralCache(cache), [cache]);
  const [opened, setOpened] = useState<{ source: FileViewerSource; trigger: HTMLElement; scope: string | undefined }>();
  /**
   * A picture is shown from the image pool's own blob, and showing it is a
   * hold. There is exactly one place that gives a hold back — here — so every
   * way a viewer can go away releases once and only once: closing it, opening
   * something else over it, the thread changing underneath it, and this
   * provider going away. A release that has already run does nothing.
   */
  const show = useCallback((next: { source: FileViewerSource; trigger: HTMLElement; scope: string | undefined } | undefined) => {
    setOpened(current => {
      if (current === next) return current;
      current?.source.release?.();
      return next;
    });
  }, []);
  const held = useRef<typeof opened>(undefined);
  held.current = opened;
  useEffect(() => () => {
    // Unmount, or the thread changed: whatever is open is let go.
    held.current?.source.release?.();
    held.current = undefined;
  }, [scope]);
  const opener = useMemo<FileOpener>(() => ({ readFile: cache.read, openFile: (source, trigger) => show({ source, trigger, scope }) }), [cache, scope, show]);
  const close = () => show(undefined);
  return <FileOpenerContext value={opener}>
    {children}
    {opened && opened.scope === scope ? <FileViewer source={opened.source} open onOpenChange={open => { if (!open) close(); }} returnFocus={opened.trigger} /> : null}
  </FileOpenerContext>;
}
