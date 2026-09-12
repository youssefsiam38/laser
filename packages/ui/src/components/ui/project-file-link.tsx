import { useContext, useRef, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { FileViewer } from "@/components/thread/FileViewer";
import { FileLinkDirectory } from "./source-file-link.js";
import { fileLinkPath, projectFilePath } from "@/lib/file-links";
import { cn } from "@/lib/utils";
import { paper } from "@/components/assistant-ui/elements/surfaces";

/** Inline form of the adopted message-attachment chip; same viewer, no eager read. */
export function ProjectFileLink({ path, children, literal = false }: { path: string; children: ReactNode; literal?: boolean }) {
  const cwd = useContext(FileLinkDirectory);
  const resolved = cwd ? literal ? projectFilePath(cwd, path) : fileLinkPath(path, cwd) : undefined;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!cwd || !resolved) return <>{children}</>;
  return <>
    <button ref={trigger} type="button" data-slot="file-chip" data-file-path={resolved} onClick={() => setOpen(true)}
      className={cn(paper, "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 align-baseline text-xs text-ink-2 pointer-coarse:min-h-11 outline-none hover:border-ink-3 hover:text-ink active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}>
      <FileText aria-hidden="true" className="size-3.5 shrink-0" /><span className="min-w-0 truncate">{children}</span>
    </button>
    {open ? <FileViewer source={{ request: { cwd, path: resolved } }} open onOpenChange={setOpen} returnFocus={trigger.current} /> : null}
  </>;
}
