import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileOpenerContext, type FileOpener, type FileViewerSource } from "@/lib/file-opener";
import { ProjectFileCache } from "@/runtime/project-file-cache";
import { useLaserStable } from "@/runtime";
import { FileViewer } from "./FileViewer.js";

/** One viewer and bounded read cache per thread, shared by files, images and tool cards. */
export function FileOpenerProvider({ children, scope }: { children: ReactNode; scope?: string | undefined }) {
  const { client } = useLaserStable();
  const cache = useMemo(() => new ProjectFileCache((cwd, path) => client.request("pi/project/read", { cwd, path })), [client, scope]);
  const [opened, setOpened] = useState<{ source: FileViewerSource; trigger: HTMLElement; scope: string | undefined }>();
  useEffect(() => setOpened(undefined), [scope]);
  const opener = useMemo<FileOpener>(() => ({ readFile: cache.read, openFile: (source, trigger) => setOpened({ source, trigger, scope }) }), [cache, scope]);
  // A picture shown from the image pool is held while it is open and given
  // back the moment it is not, so nothing decoded outlives what is on screen.
  const close = () => setOpened(current => { current?.source.release?.(); return undefined; });
  return <FileOpenerContext value={opener}>
    {children}
    {opened && opened.scope === scope ? <FileViewer source={opened.source} open onOpenChange={open => { if (!open) close(); }} returnFocus={opened.trigger} /> : null}
  </FileOpenerContext>;
}
