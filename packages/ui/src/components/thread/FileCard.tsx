"use client";
import { useRef, useState } from "react";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { shikiLanguageFromPath } from "@/components/assistant-ui/elements/shiki-highlighter";
import { fileDescription } from "@/components/preview/media";
import { projectFilePath } from "@/lib/file-links";
import { Button } from "@/components/ui/button";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { useLaserState } from "@/runtime";
import { FileViewer } from "./FileViewer.js";

/** No eager reads for collapsed histories. The tool gives the description its
 * known source/size; opening explicitly asks for the current file on disk. */
export function FileCard({ path, lines }: { path: string; lines?: number | undefined }) {
  const cwd = useLaserState(state => state.current ? state.open[state.current]?.state.cwd : undefined);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!cwd) return null;
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const absolute = projectFilePath(cwd, path);
  return <div className="my-2">
    <ArtifactCard title={name} path={path} description={fileDescription(path, lines === undefined ? undefined : { lines }, shikiLanguageFromPath(path))}>
      <Button ref={button} variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setOpen(true)}>Open</Button>
      {absolute && hasSourceEditor() ? <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => void openSourcePath(absolute)}>Open in editor</Button> : null}
    </ArtifactCard>
    <FileViewer source={{ request: { cwd, path } }} open={open} onOpenChange={setOpen} returnFocus={button.current} />
  </div>;
}
