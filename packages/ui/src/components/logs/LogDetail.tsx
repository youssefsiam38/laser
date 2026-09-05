"use client";
/**
 * The detail pane: one log row in full.
 *
 * A payload above the store's inline limit is not in the page at all — the row
 * carries a hash, a size and a preview, and this pane fetches the body with
 * `pi/logs/content` when you open it. That is the byte-budget contract from the
 * host side made visible: you always see something immediately, and the whole
 * thing on request.
 *
 * Provider response rows carry the ceiling note, because a reader who sees
 * "HTTP 200" and no body deserves to be told why rather than left guessing.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Download, Info } from "lucide-react";

import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { AnsiText } from "@/components/assistant-ui/elements/ansi-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useCopy } from "@/hooks";
import { dateTime, duration } from "@/format";
import { cn } from "@/lib/utils";
import { useLaserStable } from "@/runtime";
import type { LogEntry } from "@lasercode/protocol";

import { SECTION_TONE } from "./model.js";

export function LogDetail({ entry }: { entry: LogEntry | undefined }) {
  if (!entry) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="max-w-72 text-center text-sm leading-6 text-ink-2">
          Pick a row to see its payload — the whole provider request, a tool's arguments and result, or a worker's
          output.
        </p>
      </div>
    );
  }
  return <Detail key={entry.id} entry={entry} />;
}

function Detail({ entry }: { entry: LogEntry }) {
  const { client } = useLaserStable();
  const [body, setBody] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const { copied, copy } = useCopy();

  const ref = entry.detailRef;

  // Rows whose payload is a captured stream rather than a structured record.
  // Matched on the kind's shape, not an exhaustive list, because `kind` is an
  // open vocabulary the host and its extensions extend (`worker_stderr`,
  // `tool_stderr`, …) and a new one should read correctly on the day it
  // appears rather than the day someone remembers to add it here. A payload
  // that came back as JSON is never terminal output whatever its kind says.
  const terminalOutput = !ref
    ? false
    : /(^|_)(stderr|stdout|output|console)$/.test(entry.kind);

  useEffect(() => {
    if (!ref) {
      setBody(entry.detail === undefined ? undefined : JSON.stringify(entry.detail, null, 2));
      return;
    }
    let live = true;
    setLoading(true);
    setError(undefined);
    client
      .request("pi/logs/content", { ref: ref.ref })
      .then((result) => {
        if (!live) return;
        setTruncated(result.truncated);
        try {
          setBody(JSON.stringify(JSON.parse(result.text), null, 2));
        } catch {
          setBody(result.text);
        }
      })
      .catch((fetchError: unknown) => {
        if (live) setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [client, ref, entry.detail]);

  return (
    <ScrollArea className="h-full">
      <div className="flex min-w-0 flex-col gap-3 p-3">
        <header className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ background: SECTION_TONE[entry.section] }}
            />
            <span className="font-mono text-sm text-ink">{entry.kind}</span>
            <Badge variant={entry.level === "error" ? "danger" : entry.level === "warn" ? "attention" : "outline"}>
              {entry.level}
            </Badge>
            {entry.status !== undefined && (
              <Badge variant={entry.status >= 400 ? "danger" : "ok"}>HTTP {entry.status}</Badge>
            )}
            {entry.durationMs !== undefined && <Badge variant="default">{duration(entry.durationMs)}</Badge>}
          </div>
          <p className="text-sm leading-5 text-ink">{entry.summary}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs text-ink-3">
            <dt>time</dt>
            <dd className="text-ink-2">{dateTime(entry.at)}</dd>
            <dt>id</dt>
            <dd className="text-ink-2">#{entry.id}</dd>
            {entry.correlationId && (
              <>
                <dt>pairs with</dt>
                <dd className="text-ink-2">{entry.correlationId}</dd>
              </>
            )}
            {entry.cwd && (
              <>
                <dt>project</dt>
                <dd className="min-w-0 truncate text-ink-2" title={entry.cwd}>
                  {entry.cwd}
                </dd>
              </>
            )}
            {entry.sessionPath && (
              <>
                <dt>session</dt>
                <dd className="min-w-0 truncate text-ink-2" title={entry.sessionPath}>
                  {entry.sessionPath}
                </dd>
              </>
            )}
          </dl>
        </header>

        {entry.kind === "provider_response" && <ProviderCeilingNote />}

        {ref && (
          <p className="flex items-center gap-1.5 font-mono text-xs text-ink-3">
            <Download className="size-3" />
            {(ref.bytes / 1024).toFixed(1)} kB payload · sha256 {ref.ref.slice(0, 12)}…
            {truncated ? " · truncated for display" : ""}
          </p>
        )}

        {loading && <GenerationLoader label="Fetching the payload" layout="inline" />}
        {error && (
          <p className="rounded-lg bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-3 py-2 text-xs leading-5 text-danger">
            {error}
          </p>
        )}

        {body !== undefined && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="eyebrow">payload</span>
              <Button variant="ghost" size="xs" className="ms-auto gap-1" onClick={() => void copy(body)}>
                {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {/* Captured process output is terminal output: it arrives with SGR
                escapes in it, and a plain `<pre>` renders those as literal
                `ESC[31m` noise in front of the very line a reader opened the
                row to read. Those rows get the terminal ground and the
                decoder every other stream in the app uses; everything else
                (a JSON body, a request record) stays on the surface ground,
                where it is structured data rather than a console. */}
            {terminalOutput ? (
              <pre className="terminal max-h-[60vh] w-full min-w-0 overflow-auto rounded-lg border border-terminal-line p-3 whitespace-pre">
                <AnsiText text={body} />
              </pre>
            ) : (
              <pre
                className={cn(
                  "max-h-[60vh] w-full min-w-0 overflow-auto rounded-lg bg-surface-2 p-3",
                  "font-mono text-xs leading-sm whitespace-pre text-ink-2",
                )}
              >
                {body}
              </pre>
            )}
          </div>
        )}

        {body === undefined && !loading && !error && (
          <p className="text-xs leading-5 text-ink-3">This row has no payload — its summary is the whole record.</p>
        )}
      </div>
    </ScrollArea>
  );
}

/**
 * The hard ceiling from `docs/research/findings.md`, stated where it matters.
 * Pretending a response body exists (or showing an empty pane) would be worse
 * than saying what Pi does and does not hand us.
 */
function ProviderCeilingNote() {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs leading-5 text-ink-2">
      <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
      <p>
        <span className="font-medium text-ink">There is no response body here, and there cannot be.</span> Pi 0.85 gives
        an extension the complete provider <em>request</em>, but its{" "}
        <code className="font-mono text-xs">after_provider_response</code> hook carries only the HTTP status and the
        response headers — it exposes no hook for the raw stream. The model's actual output is reconstructed from
        session events and shown in the transcript.
      </p>
    </div>
  );
}
