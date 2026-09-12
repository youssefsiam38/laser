import { useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { FileLinkDirectory, SourceFileLink } from "./source-file-link.js";
import { fileLinkPath, projectFilePath } from "@/lib/file-links";
import { useFileOpener } from "@/lib/file-opener";
import { cn } from "@/lib/utils";
import { paper } from "@/components/assistant-ui/elements/surfaces";

/** Machine paths resolve against the owning project, never the web origin. */
export function projectReferencePath(href: string, cwd?: string): string | undefined {
  return cwd ? fileLinkPath(href, cwd) : undefined;
}
export function projectDirectivePath(path: string, cwd?: string): string | undefined {
  return cwd ? projectFilePath(cwd, path) : undefined;
}
export function looksLikeFilePath(text: string): boolean {
  return /^(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:md|markdown|mdx|txt|json|ya?ml|toml|tsx?|jsx?|mjs|cjs|py|go|rs|sh|css|html|vue|svelte|sql|png|jpe?g|gif|webp|svg|pdf)(?::\d+(?::\d+)?)?$/i.test(text);
}

/** Inline form of the adopted message-attachment chip; no read until intent. */
export function ProjectFileLink({ path, children, literal = false }: { path: string; children: ReactNode; literal?: boolean }) {
  const cwd = useContext(FileLinkDirectory);
  const resolved = literal ? projectDirectivePath(path, cwd) : projectReferencePath(path, cwd);
  if (!cwd || !resolved) return <>{children}</>;
  return <ReadableFileChip key={`${cwd}:${resolved}`} cwd={cwd} path={resolved}>{children}</ReadableFileChip>;
}
function ReadableFileChip({ cwd, path, children }: { cwd: string; path: string; children: ReactNode }) {
  const opener = useFileOpener();
  const [opening, setOpening] = useState(false);
  const intent = useRef(0);
  useEffect(() => () => { intent.current++; }, [opener]);
  if (!opener) return <>{children}</>;
  const prefetch = () => { void opener.readFile(cwd, path).catch(() => {}); };
  return <button type="button" dir="ltr" data-slot="file-chip" data-file-path={path} aria-busy={opening || undefined}
    onMouseEnter={prefetch} onFocus={prefetch} onKeyDown={event => { if (event.key === "Escape") { intent.current++; setOpening(false); } }}
    onClick={event => {
      const trigger = event.currentTarget;
      const accepted = ++intent.current;
      setOpening(true);
      void opener.readFile(cwd, path).then(file => {
        if (accepted === intent.current) opener.openFile({ request: { cwd, path }, file }, trigger);
      }, error => {
        if (accepted === intent.current) toast.error(error instanceof Error ? error.message : "That file could not be read. Try opening it again.");
      }).finally(() => { if (accepted === intent.current) setOpening(false); });
    }}
    className={cn(paper, "inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 align-baseline text-xs text-ink-2 pointer-coarse:min-h-11 outline-none hover:border-ink-3 hover:text-ink active:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-live")}>
    <FileText aria-hidden="true" className="size-3.5 shrink-0" /><span data-search-content className="min-w-0 truncate">{children}</span>
    {opening ? <span role="status" className="sr-only">Opening file</span> : null}
  </button>;
}

/** Keep authored labels searchable; footnotes and web links keep their own behavior. */
export function ConversationFileLink(props: ComponentProps<"a">) {
  const cwd = useContext(FileLinkDirectory);
  if (!projectReferencePath(props.href ?? "", cwd)) return <SourceFileLink {...props} />;
  return <ProjectFileLink path={props.href!}>{props.children}</ProjectFileLink>;
}
