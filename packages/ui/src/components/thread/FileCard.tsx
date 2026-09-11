"use client";
import { useRef, useState } from "react";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { fileDescription, projectFilePath } from "@/components/preview/FileSource";
import { Button } from "@/components/ui/button";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { useLaserState } from "@/runtime";
import { FileViewer } from "./FileViewer.js";

/** No eager reads for collapsed histories. The tool gives the description its
 * known source/size; opening explicitly asks for the current file on disk. */
export function FileCard({ path, content }: { path: string; content?: string | undefined }) {
  const cwd = useLaserState(state => state.current ? state.open[state.current]?.state.cwd : undefined);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  if (!cwd) return null;
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const absolute = projectFilePath(cwd, path);
  return <div className="my-2 [@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-w-11">
    <ArtifactCard title={name} path={path} description={fileDescription(path, content === undefined ? undefined : { content })}>
      <Button ref={button} variant="outline" size="sm" onClick={() => setOpen(true)}>Open</Button>
      {absolute && hasSourceEditor() ? <Button variant="ghost" size="sm" onClick={() => void openSourcePath(absolute)}>Open in editor</Button> : null}
    </ArtifactCard>
    <FileViewer source={{ cwd, path }} open={open} onOpenChange={setOpen} returnFocus={button.current} />
  </div>;
}
