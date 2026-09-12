"use client";
import { useFileOpener } from "@/lib/file-opener";
import { ArtifactCard } from "@/components/assistant-ui/elements/artifact-card";
import { shikiLanguageFromPath } from "@/components/assistant-ui/elements/shiki-language";
import { fileDescription } from "@/components/preview/media";
import { projectFilePath } from "@/lib/file-links";
import { Button } from "@/components/ui/button";
import { hasSourceEditor, openSourcePath } from "@/components/ui/source-file-link";
import { useLaserState } from "@/runtime";

/** No eager reads for collapsed histories. The tool gives the description its
 * known source/size; opening explicitly asks for the current file on disk. */
export function FileCard({ path, lines }: { path: string; lines?: number | undefined }) {
  const cwd = useLaserState(state => state.current ? state.open[state.current]?.state.cwd : undefined);
  const opener = useFileOpener();
  if (!cwd) return null;
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const absolute = projectFilePath(cwd, path);
  return <div className="my-2">
    <ArtifactCard title={name} path={path} description={fileDescription(path, lines === undefined ? undefined : { lines }, shikiLanguageFromPath(path))}>
      {opener ? <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={event => opener.openFile({ request: { cwd, path } }, event.currentTarget)}>Open</Button> : null}
      {absolute && hasSourceEditor() ? <Button variant="ghost" size="sm" className="pointer-coarse:min-h-11" onClick={() => void openSourcePath(absolute)}>Open in editor</Button> : null}
    </ArtifactCard>
  </div>;
}
