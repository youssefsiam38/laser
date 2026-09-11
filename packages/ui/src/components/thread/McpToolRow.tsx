"use client";
/**
 * MCP tool calls in the transcript (docs/mcp.md "In the transcript").
 *
 * Three rows, one grammar. A **direct** call is the server speaking, so the
 * verb is the server's own name and the summary is what it was asked to do:
 * `Playwright · navigate · https://example.com`. The **gateway** (`mcp`,
 * `mcp__<server>`) is one tool with several modes, so the verb is MCP and the
 * summary says which mode ran. `mcpScript` is code, so the code is the body.
 *
 * The body is the result as a person reads it, never the transport: text
 * blocks go through the transcript's own Markdown renderer (a Playwright
 * answer is Markdown with `js` and `yaml` fences, and it highlights here for
 * the same reason it does in an assistant message), an image block becomes the
 * catalog's `image` element with zoom, download and copy, audio becomes a
 * player, and a resource becomes a small card. A screenshot is never a wall of
 * base64 — the bytes reach an `<img>` and nothing else.
 *
 * Composed from the parts every other row uses (`tool-call`, the
 * `tool-fallback` sections, `tool-error`), so an MCP row is the same row with
 * a different body. Nothing here renders HTML from a server: Markdown runs
 * without `rehype-raw` (invariant 9) and every other value is text.
 */
import { TextMessagePartProvider } from "@assistant-ui/react";
import { mcpContentBlocks, mcpResultContent, type McpContentBlock } from "@lasercode/protocol";
import { Braces, FileText, Plug, Waypoints } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";

import { ImageActions, ImagePreview, ImageRoot, ImageZoom } from "@/components/assistant-ui/elements/image";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { mono } from "@/components/assistant-ui/elements/surfaces";
import { ToolCall } from "@/components/assistant-ui/elements/tool-call";
import { ToolError } from "@/components/assistant-ui/elements/tool-error";
import {
  ToolFallbackArgs,
  ToolFallbackSection,
  type ToolRowState,
} from "@/components/assistant-ui/elements/tool-fallback.aui";
import { cn } from "@/lib/utils";

import {
  mcpActiveLabel,
  mcpGatewayView,
  mcpRowSummary,
  mcpScriptCalls,
  mcpSearchMatches,
  mcpStatusRows,
  type McpToolInfo,
} from "./mcp-tools.js";
import { pretty } from "./tool-summary.js";

export interface McpToolRowProps {
  info: McpToolInfo;
  toolName: string;
  args: unknown;
  /** The result as the row shows it: the final one, or live partial output. */
  result: unknown;
  /** Joined text of the result, for the error path. */
  text: string;
  details: Record<string, unknown> | undefined;
  state: ToolRowState;
  elapsedMs: number | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Namer's name for this call while it runs, when it has one. */
  namerLabel?: string | undefined;
  footer: ReactNode;
}

function McpToolRowImpl(props: McpToolRowProps) {
  const { info, toolName, args, result, text, details, state, elapsedMs, open, onOpenChange, namerLabel, footer } = props;
  const failed = state === "failed";
  const running = state === "running";

  const row = useMemo(() => mcpRowSummary(info, toolName, args, details), [info, toolName, args, details]);
  const icon = info.kind === "script" ? Braces : info.kind === "gateway" ? Waypoints : Plug;
  const activeLabel = namerLabel ?? mcpActiveLabel(info, toolName, args, details);

  return (
    <ToolCall
      icon={icon}
      verb={row.verb}
      activeLabel={activeLabel}
      summary={row.summary}
      state={state}
      elapsedMs={elapsedMs}
      open={open}
      onOpenChange={onOpenChange}
      toolName={toolName}
      peek={failed && text ? <ToolError message={text} compact /> : undefined}
      footer={footer}
      // At a phone width the summary gives way, never the server's name: a row
      // that says “Play…” has lost the one word that tells you whose tool ran.
      className="[&_[data-slot=tool-fallback-trigger-label]]:shrink-0"
    >
      <McpBody
        info={info}
        toolName={row.exact ?? toolName}
        args={args}
        result={result}
        text={text}
        details={details}
        failed={failed}
        running={running}
      />
    </ToolCall>
  );
}

export const McpToolRow = memo(McpToolRowImpl);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function McpBody({
  info,
  toolName,
  args,
  result,
  text,
  details,
  failed,
  running,
}: {
  info: McpToolInfo;
  toolName: string;
  args: unknown;
  result: unknown;
  text: string;
  details: Record<string, unknown> | undefined;
  failed: boolean;
  running: boolean;
}) {
  if (info.kind === "script") {
    const code = typeof (args as { code?: unknown })?.code === "string" ? (args as { code: string }).code : "";
    const calls = mcpScriptCalls(details);
    return (
      <>
        <ToolFallbackArgs argsText={pretty(args)} />
        {code ? (
          <ToolFallbackSection label="script">
            <McpMarkdown text={`\`\`\`js\n${code}\n\`\`\``} />
          </ToolFallbackSection>
        ) : null}
        <McpResult blocks={mcpContentBlocks(result)} text={text} failed={failed} running={running} label={info.kind} />
        {calls.length > 0 ? (
          <ToolFallbackSection label="calls">
            <ul data-search-exclude className="flex flex-col gap-1">
              {calls.map((call, index) => (
                <li key={`${call.tool}-${index}`} className={cn(mono, "flex min-w-0 items-center gap-1.5 text-ink-3")}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", call.ok === false ? "bg-danger" : "bg-ok")} aria-hidden="true" />
                  {call.server ? <span className="shrink-0">{call.server}</span> : null}
                  {call.server ? <span aria-hidden="true">·</span> : null}
                  <span className="min-w-0 truncate text-ink-2">{call.tool}</span>
                </li>
              ))}
            </ul>
          </ToolFallbackSection>
        ) : null}
      </>
    );
  }

  const gateway = info.kind === "gateway" ? mcpGatewayView(args, details) : undefined;
  const matches = gateway?.mode === "search" ? mcpSearchMatches(details) : [];
  const statusRows = gateway?.mode === "status" ? mcpStatusRows(details) : [];
  // A gateway call carries the called tool's own result; when it was too large
  // to keep, the envelope's own content is what there is.
  const content = gateway?.mode === "call" ? mcpResultContent(result) : result;

  return (
    <>
      <ToolFallbackArgs argsText={pretty(args)} />
      {info.kind === "direct" ? (
        // The name the model actually called, which the humanised row hides.
        <ToolFallbackSection label="tool">
          <p data-search-exclude className={cn(mono, "truncate text-ink-3")} title={toolName}>
            {toolName}
          </p>
        </ToolFallbackSection>
      ) : null}
      {matches.length > 0 ? (
        <ToolFallbackSection label="matches">
          <ul className="flex flex-col gap-1">
            {matches.map((match, index) => (
              <li key={`${match.server}-${match.tool}-${index}`} className={cn(mono, "flex min-w-0 items-center gap-1.5 text-ink-2")}>
                <span data-search-content className="shrink-0 text-ink-3">
                  {match.server}
                </span>
                <span aria-hidden="true" className="text-ink-3">
                  ·
                </span>
                <span data-search-content className="min-w-0 truncate">
                  {match.tool}
                </span>
              </li>
            ))}
          </ul>
        </ToolFallbackSection>
      ) : null}
      {statusRows.length > 0 ? (
        <ToolFallbackSection label="servers">
          <ul className="flex flex-col gap-1">
            {statusRows.map((server) => (
              <li key={server.name} className={cn(mono, "flex min-w-0 items-baseline gap-2 text-ink-2")}>
                <span data-search-content className="min-w-0 flex-1 truncate">
                  {server.name}
                </span>
                <span data-search-content className="shrink-0 text-ink-3">
                  {server.status}
                </span>
                {server.toolCount !== undefined ? (
                  <span className="shrink-0 text-ink-3">
                    <span data-search-content className="tnum">
                      {server.toolCount}
                    </span>
                    {" tools"}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </ToolFallbackSection>
      ) : null}
      <McpResult blocks={mcpContentBlocks(content)} text={text} failed={failed} running={running} label={info.kind} />
    </>
  );
}

/** The result blocks, in the order the server sent them. */
function McpResult({
  blocks,
  text,
  failed,
  running,
  label,
}: {
  blocks: McpContentBlock[];
  text: string;
  failed: boolean;
  running: boolean;
  label: string;
}) {
  if (failed) {
    return text ? (
      <ToolFallbackSection label="error">
        <ToolError message={text} />
      </ToolFallbackSection>
    ) : null;
  }
  if (blocks.length === 0) return null;
  return (
    <ToolFallbackSection label={running ? "output" : "result"}>
      <div data-slot="mcp-result" data-mcp-kind={label} className="flex min-w-0 flex-col gap-2">
        {blocks.map((block, index) => (
          <McpBlock key={index} block={block} />
        ))}
      </div>
    </ToolFallbackSection>
  );
}

function McpBlock({ block }: { block: McpContentBlock }) {
  if (block.kind === "text") return <McpMarkdown text={block.text} />;
  if (block.kind === "image") {
    const src = `data:${block.mimeType};base64,${block.data.replace(/\s+/g, "")}`;
    return (
      <ImageRoot data-slot="mcp-image" size="lg">
        <ImageZoom src={src} alt="Image returned by the server">
          <ImagePreview src={src} alt="Image returned by the server" />
        </ImageZoom>
        <ImageActions part={{ type: "image", image: src }} />
      </ImageRoot>
    );
  }
  if (block.kind === "audio") {
    const src = `data:${block.mimeType};base64,${block.data.replace(/\s+/g, "")}`;
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- a server's audio carries no track
      <audio
        data-slot="mcp-audio"
        controls
        src={src}
        aria-label="Audio returned by the server"
        className="w-full max-w-96 rounded-lg border border-line bg-surface-2"
      />
    );
  }
  return (
    <div data-slot="mcp-resource" className="flex min-w-0 flex-col gap-1 rounded-lg border border-line bg-surface-2 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <FileText aria-hidden="true" className="size-3.5 shrink-0 self-center text-ink-3" />
        <span data-search-content className={cn(mono, "min-w-0 flex-1 truncate text-ink-2")} title={block.uri}>
          {block.name ?? block.uri}
        </span>
        {block.mimeType ? <span className={cn(mono, "shrink-0 text-ink-3")}>{block.mimeType}</span> : null}
      </div>
      {block.text ? <McpMarkdown text={block.text} /> : null}
    </div>
  );
}

/**
 * A server's text, drawn by the renderer the transcript already uses for an
 * assistant answer — the same type scale, the same fences, the same rule that
 * no HTML in it is ever markup. The region is the search content of this
 * block; everything around it is chrome.
 */
function McpMarkdown({ text }: { text: string }) {
  return (
    <div data-search-content data-slot="mcp-text" className="min-w-0">
      <TextMessagePartProvider text={text} isRunning={false}>
        <MarkdownText className="max-w-none text-sm" />
      </TextMessagePartProvider>
    </div>
  );
}
