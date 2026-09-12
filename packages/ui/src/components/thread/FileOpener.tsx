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
  return <FileOpenerContext value={opener}>
    {children}
    {opened && opened.scope === scope ? <FileViewer source={opened.source} open onOpenChange={open => { if (!open) setOpened(undefined); }} returnFocus={opened.trigger} /> : null}
  </FileOpenerContext>;
}
