"use client";
import type { FileViewerSource } from "@/lib/file-opener";
import type { ProjectFileContent } from "@lasercode/protocol";
import { useEffect, useMemo, useState } from "react";
import { Tabs } from "radix-ui";
import { CodeDiffRows } from "@/components/assistant-ui/elements/code-diff";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { shikiLanguageFromPath } from "@/components/assistant-ui/elements/shiki-highlighter";
import { FileSource } from "@/components/preview/FileSource";
import { boundedPreview } from "@/components/preview/display";
import { ImagePreview } from "@/components/preview/ImagePreview";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import { TextPreview } from "@/components/preview/TextPreview";
import { OpenExternally } from "@/components/preview/OpenExternally";
import { fileDescription, previewKindFor } from "@/components/preview/media";
import { fileDirectory, projectFilePath } from "@/lib/file-links";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileLinkDirectory, hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { useCopy } from "@/hooks/use-copy";
import { useLaserStable } from "@/runtime";
import type { DiffView } from "./diff.js";

export type { FileViewerSource } from "@/lib/file-opener";

export function FileViewer({ source, open, onOpenChange, returnFocus }: {
  source: FileViewerSource; open: boolean; onOpenChange(open: boolean): void; returnFocus?: HTMLElement | null | undefined;
}) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-dvh max-h-dvh w-full max-w-full flex-col gap-0 rounded-none p-0 sm:max-w-[calc(100%-var(--space-unit)*8)] sm:rounded-xl pointer-coarse:[&>button]:size-11"
      onCloseAutoFocus={event => { if (returnFocus) { event.preventDefault(); returnFocus.focus(); } }}>
      <ViewerContents source={source} />
    </DialogContent>
  </Dialog>;
}

function ViewerContents({ source }: { source: FileViewerSource }) {
  const { client } = useLaserStable();
  const { copy, copied } = useCopy();
  const [fetched, setFile] = useState<ProjectFileContent>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const cwd = source.request?.cwd;
  const path = source.request?.path;
  const loaded = source.file ?? fetched;
  const displayPath = path ? loaded?.path ?? path : undefined;
  const absolute = displayPath && cwd ? projectFilePath(cwd, displayPath) : undefined;
  const preview = useMemo(() => loaded ? boundedPreview(loaded) : undefined, [loaded]);
  const file = preview?.file;
  const name = file?.name ?? path?.split(/[\\/]/).at(-1) ?? "File";
  useEffect(() => {
    if (source.file || cwd === undefined || path === undefined) return;
    let current = true;
    setFile(undefined); setError(undefined);
    void client.request("pi/project/read", { cwd, path }).then(result => { if (current) setFile(result); }, failure => {
      if (current) setError(failure instanceof Error ? failure.message : "That file could not be read. Try opening it again.");
    });
    return () => { current = false; };
  }, [client, cwd, path, attempt, source.file]);
  const editor = absolute && hasSourceEditor() ? () => void openSourcePath(absolute) : undefined;
  return <>
    <DialogHeader className="shrink-0 border-b border-line p-4 pe-12">
      <DialogTitle className="break-all">{name}</DialogTitle>
      {displayPath ? <p dir="ltr" className="typed break-all text-ink-3">{displayPath}</p> : null}
      <DialogDescription>{fileDescription(file?.path || path || "", file, shikiLanguageFromPath(file?.path || path || ""))}</DialogDescription>
      {absolute ? <div className="mt-2 flex flex-wrap gap-2">
        {editor ? <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={editor}>Open in editor</Button> : null}
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => void copy(absolute)}>{copied ? "Copied" : "Copy path"}</Button>
      </div> : null}
    </DialogHeader>
    {error ? <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-ink-2">
      <p>{error}</p><Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
    </div> : !file ? <div role="status" className="flex flex-1 items-center justify-center p-6"><GenerationLoader label="Opening file" /></div> : <>
      {file.truncated ? <p role="status" className="border-b border-line bg-surface-2 px-4 py-2 text-sm text-ink-2">This preview is truncated. Open the file in your editor to see it in full.</p> : null}
      <FileLinkDirectory.Provider value={absolute ? fileDirectory(absolute) : undefined}>
        <FileBody file={file} diff={preview?.diff} path={absolute} onOpen={editor} />
      </FileLinkDirectory.Provider>
    </>}
  </>;
}

function FileBody({ file, diff, path, onOpen }: { file: ProjectFileContent; diff: DiffView | undefined; path: string | undefined; onOpen: (() => void) | undefined }) {
  const kind = previewKindFor(file.mediaType, file.path);
  if (kind === "image" && file.encoding === "base64") {
    if (file.truncated) return <OpenExternally mediaType={file.mediaType} reason="This image is too large to preview here" path={path} onOpen={onOpen} />;
    return <ImagePreview className="flex-1" src={`data:${file.mediaType};base64,${file.content}`} alt={file.name} />;
  }
  if (file.encoding === "base64" || file.content.includes("\0")) return <OpenExternally mediaType={file.mediaType} path={path} onOpen={onOpen} />;
  if (kind === "markdown") return <Tabs.Root defaultValue="preview" className="flex min-h-0 flex-1 flex-col">
    <Tabs.List aria-label="Markdown view" className="flex shrink-0 gap-1 border-b border-line px-4 py-2">
      {(["preview", "source"] as const).map(value => <Tabs.Trigger key={value} value={value} asChild>
        <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11 data-[state=active]:bg-surface-2 data-[state=active]:text-ink">{value === "preview" ? "Preview" : "Source"}</Button>
      </Tabs.Trigger>)}
    </Tabs.List>
    <Tabs.Content value="preview" className="min-h-0 flex-1 overflow-auto"><MarkdownPreview text={file.content} prose className="mx-auto w-full max-w-[calc(var(--measure-prose)+var(--space-unit)*8)]" /></Tabs.Content>
    <Tabs.Content value="source" className="min-h-0 flex-1 overflow-auto"><FileSource path={file.path} text={file.content} /></Tabs.Content>
  </Tabs.Root>;
  if (diff?.hunks.length) return <div className="min-h-0 flex-1 overflow-auto"><CodeDiffRows hunks={diff.hunks} inset="px-4" /></div>;
  if (shikiLanguageFromPath(file.path) !== "text") return <div className="min-h-0 flex-1 overflow-auto"><FileSource path={file.path} text={file.content} /></div>;
  return <TextPreview text={file.content} truncated={file.truncated} className="min-h-0 flex-1 overflow-auto" />;
}
