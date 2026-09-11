"use client";
/**
 * Run (docs/mcp.md "Inspecting" → *Run*): the developer's proof that the
 * server does what they think, before the model ever calls it. Pick a tool,
 * fill in its arguments — a real control per property the schema describes,
 * JSON for anything stranger — run it on the inspector's own connection and
 * read the result as it came back.
 */
import type { McpCallResult, McpInspection, McpScope, McpToolInfo } from "@lasercode/protocol";
import { Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ImagePreview, ImageRoot, ImageZoom } from "@/components/assistant-ui/elements/image";
import { JsonViewer } from "@/components/assistant-ui/elements/json-viewer";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { MarkdownPreview } from "@/components/preview/MarkdownPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSwitch } from "@/components/assistant-ui/elements/settings-panel";
import { useLaserStable } from "@/runtime";

import { selectClass } from "../fields.js";
import { buildArgs, contentDataUri, initialArgValues, schemaFields, schemaToShape, type ArgValues } from "./model.js";

export function McpRunPanel({
  cwd,
  scope,
  name,
  inspection,
}: {
  cwd: string;
  scope: McpScope;
  name: string;
  inspection: McpInspection;
}) {
  const { client } = useLaserStable();
  const [tool, setTool] = useState<string | undefined>(inspection.tools[0]?.originalName);
  const [values, setValues] = useState<ArgValues>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<McpCallResult>();
  const [error, setError] = useState<string>();

  const selected: McpToolInfo | undefined = inspection.tools.find((entry) => entry.originalName === tool);
  const fields = useMemo(() => schemaFields(selected?.inputSchema), [selected]);

  useEffect(() => {
    setValues(initialArgValues(fields));
    setResult(undefined);
    setError(undefined);
  }, [fields]);

  const run = async () => {
    if (!selected) return;
    const built = buildArgs(fields, values);
    if ("error" in built) {
      setError(built.error);
      return;
    }
    setRunning(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await client.request("mcp/call", { cwd, scope, name, tool: selected.originalName, args: built.args }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  };

  if (!inspection.tools.length) {
    return <p className="text-sm leading-6 text-ink-2">This server offers no tools to run.</p>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-ink">
        Tool
        <select className={selectClass} value={tool ?? ""} onChange={(event) => setTool(event.target.value)} aria-label="Tool to run">
          {inspection.tools.map((entry) => (
            <option key={entry.originalName} value={entry.originalName}>
              {entry.title ?? entry.originalName}
            </option>
          ))}
        </select>
      </label>

      {selected?.description && <p className="text-sm leading-6 text-ink-2">{selected.description}</p>}
      {schemaToShape(selected?.inputSchema) && (
        <p className="typed break-words text-ink-3">{schemaToShape(selected?.inputSchema)}</p>
      )}

      <div className="flex flex-col gap-3">
        {fields.map((field) => {
          const label = `${field.name}${field.required ? " (required)" : ""}`;
          const value = values[field.name];
          if (field.kind === "boolean") {
            return (
              <div key={field.name} className="flex items-start gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm text-ink">{label}</span>
                  {field.description && <span className="text-xs leading-5 text-ink-3">{field.description}</span>}
                </span>
                <SettingsSwitch
                  checked={value === true}
                  aria-label={field.name}
                  onCheckedChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
                />
              </div>
            );
          }
          const text = typeof value === "string" ? value : "";
          const onChange = (next: string) => setValues((current) => ({ ...current, [field.name]: next }));
          return (
            <label key={field.name} className="flex flex-col gap-1 text-sm text-ink">
              {label}
              {field.description && <span className="text-xs leading-5 text-ink-3">{field.description}</span>}
              {field.kind === "enum" ? (
                <select className={selectClass} aria-label={field.name} value={text} onChange={(event) => onChange(event.target.value)}>
                  <option value="">— not set —</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : field.kind === "text" || field.kind === "string-list" || field.kind === "json" ? (
                <Textarea
                  aria-label={field.name}
                  rows={field.kind === "string-list" ? 3 : 4}
                  value={text}
                  spellCheck={false}
                  placeholder={field.kind === "string-list" ? "One per line" : field.kind === "json" ? "JSON" : undefined}
                  onChange={(event) => onChange(event.target.value)}
                />
              ) : (
                <Input
                  aria-label={field.name}
                  inputMode={field.kind === "number" ? "numeric" : undefined}
                  value={text}
                  spellCheck={false}
                  onChange={(event) => onChange(event.target.value)}
                />
              )}
            </label>
          );
        })}
        {!fields.length && <p className="text-sm leading-6 text-ink-2">This tool takes no arguments.</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={running} onClick={() => void run()}>
          <Play aria-hidden="true" /> Run it
        </Button>
        {running && <GenerationLoader label="Running" layout="inline" />}
      </div>

      {error && (
        <p role="alert" className="text-sm leading-6 text-danger">
          {error}
        </p>
      )}

      {result && <CallResult result={result} />}
    </div>
  );
}

function CallResult({ result }: { result: McpCallResult }) {
  return (
    <section data-slot="mcp-call-result" data-ok={result.ok} className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.ok ? "live" : "danger"}>{result.ok ? "Worked" : "Failed"}</Badge>
        <Badge variant="outline" className="tnum">
          {result.durationMs} ms
        </Badge>
      </div>
      {result.error && <p className="text-sm leading-6 text-danger">{result.error}</p>}
      {result.content.map((block, index) => {
        if (block.type === "text") {
          return (
            <MarkdownPreview key={index} text={block.text} className="rounded-lg bg-surface p-2" />
          );
        }
        if (block.type === "image") {
          const src = contentDataUri(block);
          return (
            <ImageRoot key={index} data-slot="mcp-result-image">
              <ImageZoom src={src} alt="What the tool returned">
                <ImagePreview src={src} alt="What the tool returned" />
              </ImageZoom>
            </ImageRoot>
          );
        }
        if (block.type === "audio") {
          return (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio key={index} controls data-slot="mcp-result-audio" className="w-full" src={contentDataUri(block)}>
              Your browser cannot play this sound.
            </audio>
          );
        }
        return (
          <div key={index} data-slot="mcp-result-resource" className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface p-2">
            <span className="typed truncate text-ink-2" title={block.uri}>
              {block.uri}
            </span>
            {block.mimeType && <span className="text-xs text-ink-3">{block.mimeType}</span>}
            {block.text && <pre className="typed max-h-40 overflow-auto whitespace-pre-wrap text-ink-2">{block.text}</pre>}
          </div>
        );
      })}
      {result.structuredContent !== undefined && <JsonViewer value={result.structuredContent} />}
    </section>
  );
}
