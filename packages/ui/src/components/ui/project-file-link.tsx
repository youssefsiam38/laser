import { useCallback, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { ProjectFileContent } from "@lasercode/protocol";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { FileViewer } from "@/components/thread/FileViewer";
import { FileLinkDirectory, SourceFileLink } from "./source-file-link.js";
import { fileLinkPath, projectFilePath } from "@/lib/file-links";
import { cn } from "@/lib/utils";
import { paper } from "@/components/assistant-ui/elements/surfaces";
import { useLaserStable } from "@/runtime";

/** A Markdown URL must stay inside its owning project, not merely be a local path. */
export function projectReferencePath(href: string, cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const path = fileLinkPath(href, cwd);
  const root = projectFilePath(cwd, ".");
  return path && (root === "/" || path.startsWith(`${root}/`)) ? path : undefined;
}
export function looksLikeFilePath(text: string): boolean {
  return /^(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:md|markdown|mdx|txt|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|py|go|rs|sh|css|html|vue|svelte|sql|png|jpe?g|gif|webp|svg|pdf)(?::\d+(?::\d+)?)?$/i.test(text);
}

/** One read per mounted reference; late replies cannot replace a new target. */
export function useProjectFile(cwd: string | undefined, path: string | undefined, eager = false) {
  const { client } = useLaserStable();
  const key = JSON.stringify([cwd, path]);
  const current = useRef(key); current.current = key;
  const pending = useRef<{ key: string; promise: Promise<ProjectFileContent | undefined> } | undefined>(undefined);
  const [result, setResult] = useState<{ key: string; file?: ProjectFileContent; failed?: boolean }>();
  const read = useCallback((): Promise<ProjectFileContent | undefined> => {
    if (!cwd || !path) return Promise.resolve(undefined);
    if (pending.current?.key === key) return pending.current.promise;
    const promise = client.request("pi/project/read", { cwd, path }).then(file => {
      if (current.current !== key) return undefined;
      setResult({ key, file }); return file;
    }, () => { if (current.current === key) setResult({ key, failed: true }); return undefined; });
    pending.current = { key, promise };
    return promise;
  }, [client, cwd, path, key]);
  useEffect(() => { if (eager) void read(); }, [eager, read]);
  return { read, file: result?.key === key ? result.file : undefined, failed: result?.key === key && result.failed === true };
}

/** Inline form of the adopted message-attachment chip; no read until intent. */
export function ProjectFileLink({ path, children, literal = false }: { path: string; children: ReactNode; literal?: boolean }) {
  const cwd = useContext(FileLinkDirectory);
  const resolved = cwd ? literal ? projectFilePath(cwd, path) : projectReferencePath(path, cwd) : undefined;
  if (!cwd || !resolved) return <>{children}</>;
  return <ReadableFileChip key={`${cwd}:${resolved}`} cwd={cwd} path={resolved}>{children}</ReadableFileChip>;
}
function ReadableFileChip({ cwd, path, children }: { cwd: string; path: string; children: ReactNode }) {
  const { read, file, failed } = useProjectFile(cwd, path);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (failed) return <>{children}</>;
  return <>
    <button ref={trigger} type="button" data-slot="file-chip" data-file-path={path} aria-busy={open && !file || undefined}
      onMouseEnter={() => void read()} onFocus={() => void read()} onClick={() => {
        setOpen(true);
        void read().then(file => { if (!file) toast.error("This file couldn’t be read. Check that it still exists in the project."); });
      }}
      className={cn(paper, "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 align-baseline text-xs text-ink-2 pointer-coarse:min-h-11 outline-none hover:border-ink-3 hover:text-ink active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}>
      <FileText aria-hidden="true" className="size-3.5 shrink-0" /><span data-search-content className="min-w-0 truncate">{children}</span>
      {open && !file ? <span role="status">Opening…</span> : null}
    </button>
    {open && file ? <FileViewer source={{ request: { cwd, path }, file }} open onOpenChange={setOpen} returnFocus={trigger.current} /> : null}
  </>;
}

/** Keep authored labels searchable; footnotes and web links keep their own behavior. */
export function ConversationFileLink(props: ComponentProps<"a">) {
  const cwd = useContext(FileLinkDirectory);
  if (!projectReferencePath(props.href ?? "", cwd)) return <SourceFileLink {...props} />;
  return <ProjectFileLink path={props.href!}>{props.children}</ProjectFileLink>;
}
