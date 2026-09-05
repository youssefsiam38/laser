import type { DocumentPanel } from "@lasercode/protocol";
import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { DocumentBody as PreviewBody, type DocumentContent } from "@/components/preview";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";
import { useRefContent } from "../../read.js";
import type { PanelEntry } from "../../store.js";
import { formatBytes, shortMediaType } from "../../values.js";
import { ActionButtons } from "../ActionButtons.js";

export interface DocumentBodyProps {
  entry: PanelEntry;
  panel: DocumentPanel;
  onAct(actionId: string): Promise<unknown>;
}

/**
 * Something you read (docs/ux-panels.md "document").
 *
 * The island owns the panel's own facts — media type, version, path, actions —
 * and the reading of its `ref`; what the content *looks like* belongs to
 * `@/components/preview`, which is the same markdown, diff, image and text
 * rendering used anywhere a document is shown. There is one document renderer
 * in the app, and this is the panel's way in to it.
 */
export function DocumentBody({ entry, panel, onAct }: DocumentBodyProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const ref = panel.content && "ref" in panel.content ? panel.content.ref : undefined;
  const inline = panel.content && "inline" in panel.content ? panel.content.inline : undefined;
  // An inline payload is already here; only a ref costs a read.
  const read = useRefContent(entry.path, panel.renderable && inline === undefined ? ref : undefined, {
    mediaType: panel.mediaType,
    reloadToken,
  });

  const content = documentContent(inline, read);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-ink-3">
        <span className="typed">{shortMediaType(panel.mediaType)}</span>
        {panel.version && <span className="typed">v · {panel.version.label}</span>}
        {panel.path && <PathChip path={panel.path} />}
        {read.bytes !== undefined && read.dataUrl === undefined && read.text.length < read.bytes && (
          <span className="typed text-attention">
            showing the first {formatBytes(read.text.length)} of {formatBytes(read.bytes)}
          </span>
        )}
      </div>

      <PreviewBody
        panel={panel}
        content={content}
        {...(ref !== undefined && inline === undefined ? { onRetry: () => setReloadToken((n) => n + 1) } : {})}
        className="min-h-0"
      />
      <ActionButtons actions={panel.actions} onAct={onAct} />
    </div>
  );
}

/** The panel reader's state, in the words the preview body expects. */
function documentContent(
  inline: string | undefined,
  read: { text: string; bytes: number | undefined; loading: boolean; error: string | undefined; dataUrl: string | undefined },
): DocumentContent {
  if (inline !== undefined) return { status: "ready", text: inline };
  if (read.error !== undefined) return { status: "error", message: read.error };
  if (read.loading) return { status: "loading" };
  const truncated = read.bytes !== undefined && read.dataUrl === undefined && read.text.length < read.bytes;
  return {
    status: "ready",
    text: read.text,
    ...(read.dataUrl !== undefined ? { src: read.dataUrl } : {}),
    truncated,
  };
}

function PathChip({ path }: { path: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => void copy(path)}
      title={copied ? "Copied" : `Copy ${path}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md px-1 text-start outline-none hover:bg-surface-2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-live",
        copied && "text-ok",
      )}
    >
      <span className="typed truncate">{path}</span>
      {copied ? <Check className="size-3 shrink-0" aria-hidden="true" /> : <Copy className="size-3 shrink-0" aria-hidden="true" />}
    </button>
  );
}
