/**
 * web-access — pi-web-access as `collection` panels (M8-T4).
 *
 * The package already works in piorbit without help: it uses only the portable
 * UI surface (`notify`, `select`, string widgets), so its dialogs and status
 * lines come through the ui-bridge unchanged. What it does *not* have is a way
 * to show a set of found things as anything but a wall of text in a tool row.
 *
 * That is what a `collection` panel is for, so this module is an adapter in the
 * sense of docs/ux-panels.md: it reads the package's private world and emits
 * the declared payload. Two deliberate choices:
 *
 * - **It emits on the public bus** (`piorbit:panel`), exactly as a third-party
 *   extension that opted into the contract would, rather than through a
 *   private channel to the worker. The contract is dogfooded by our own code
 *   before it is asked of anyone else's (docs/ux-panels.md, decision 4). A
 *   terminal Pi ignores the event and nothing breaks.
 *
 * - **The payload carries generic rows, never domain values** (R12a). There is
 *   no `url` field and no `snippet` field on the wire: a search hit, a fetched
 *   page and a checked source all become `primary` / `secondary` / `meta`,
 *   which is the only reason one renderer can draw all three.
 *
 * Where the data comes from: `pi.appendEntry("web-search-results", …)`. The
 * package stores every search, fetch and source-check as a custom session entry
 * (`storage.ts`), which is richer and more stable than the tool's `details` —
 * `details.curatedQueries` exists only on the curated path, while the entry is
 * written on every path. Entries appended during a tool call are found by
 * remembering the entry count when the call started, so no id has to be
 * guessed and a renamed tool still works.
 */

import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { PANEL_EVENT, type CollectionItem, type PanelEvent } from "@lasercode/protocol";
import type { PiorbitModule } from "./index.js";

/** As it appears in `sourceInfo.source` (`npm:pi-web-access`) and in the resolved path. */
const PACKAGE_ID = "pi-web-access";
/** The custom entry type the package appends for every stored result (`storage.ts`). */
const ENTRY_TYPE = "web-search-results";
/** Panel ids are namespaced by producer so two adapters can never collide. */
const PANEL_PREFIX = "web-access";
/** Rows past this are summarised by `total` rather than sent. A panel is a view, not a database. */
const MAX_ITEMS = 200;
/** Long enough to read, short enough that a row stays one or two lines. */
const MAX_SECONDARY = 400;

function fromPackage(info: ToolInfo["sourceInfo"] | undefined, id: string): boolean {
  if (!info) return false;
  return info.source.includes(id) || info.path.includes(id);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const clamp = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

/** `https://example.com/a/b?c` → `example.com`. Display only; never a link. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
  }
}

/** The panel schema caps a meta value at 400 characters; clamping here keeps a
 *  freakishly long URL from failing validation and dropping the whole panel. */
const MAX_META_VALUE = 400;

function meta(pairs: Array<[string, string | undefined]>): CollectionItem["meta"] {
  const rows = pairs
    .filter((pair): pair is [string, string] => pair[1] !== undefined && pair[1] !== "")
    .map(([label, value]) => ({ label, value: clamp(value, MAX_META_VALUE) }));
  return rows.length > 0 ? rows : undefined;
}

function item(id: string, primary: string, secondary: string | undefined, pairs: Array<[string, string | undefined]>): CollectionItem {
  const columns = meta(pairs);
  return {
    id,
    primary: clamp(primary, 200),
    ...(secondary ? { secondary: clamp(secondary, MAX_SECONDARY) } : {}),
    ...(columns ? { meta: columns } : {}),
  };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// The three stored shapes → one generic collection
// ---------------------------------------------------------------------------

interface Collection {
  title: string;
  items: CollectionItem[];
  layout: "list" | "table";
  total: number;
}

/** `type: "search"` — queries, each with an answer and its sources. */
function fromSearch(data: Record<string, unknown>): Collection | undefined {
  const queries = Array.isArray(data["queries"]) ? data["queries"] : [];
  if (queries.length === 0) return undefined;
  const items: CollectionItem[] = [];
  let total = 0;
  const labels: string[] = [];
  const many = queries.length > 1;

  queries.forEach((raw, qi) => {
    if (!isRecord(raw)) return;
    const query = text(raw["query"]) ?? `query ${qi + 1}`;
    labels.push(query);
    const error = text(raw["error"]);
    if (error) {
      total += 1;
      if (items.length < MAX_ITEMS) items.push(item(`q${qi}-error`, query, error, [["Result", "failed"]]));
      return;
    }
    const results = Array.isArray(raw["results"]) ? raw["results"] : [];
    results.forEach((source, si) => {
      if (!isRecord(source)) return;
      const url = text(source["url"]);
      const title = text(source["title"]) ?? (url ? hostOf(url) : undefined);
      if (!title) return;
      total += 1;
      if (items.length >= MAX_ITEMS) return;
      items.push(
        item(`q${qi}-r${si}`, title, text(source["snippet"]), [
          ["Site", url ? hostOf(url) : undefined],
          ["URL", url],
          ["Query", many ? query : undefined],
        ]),
      );
    });
  });

  if (items.length === 0) return undefined;
  const subject = labels.length === 1 ? `“${clamp(labels[0] ?? "", 60)}”` : plural(labels.length, "query", "queries");
  return { title: `${plural(total, "result")} for ${subject}`, items, layout: "list", total };
}

/** `type: "fetch"` — one row per URL, with status and size, so a table. */
function fromFetch(data: Record<string, unknown>): Collection | undefined {
  const urls = Array.isArray(data["urlMetadata"])
    ? data["urlMetadata"]
    : Array.isArray(data["urls"])
      ? data["urls"]
      : [];
  if (urls.length === 0) return undefined;
  const items: CollectionItem[] = [];
  urls.forEach((raw, i) => {
    if (!isRecord(raw) || items.length >= MAX_ITEMS) return;
    const url = text(raw["url"]);
    if (!url) return;
    const bytes = typeof raw["contentLength"] === "number" ? raw["contentLength"] : undefined;
    const status = typeof raw["status"] === "number" ? String(raw["status"]) : undefined;
    items.push(
      item(`u${i}`, text(raw["title"]) ?? hostOf(url), text(raw["error"]), [
        ["URL", url],
        ["Status", status],
        ["Type", text(raw["mimeType"])],
        ["Size", bytes === undefined ? undefined : `${Math.max(1, Math.round(bytes / 1024))} KB`],
      ]),
    );
  });
  if (items.length === 0) return undefined;
  return { title: `Fetched ${plural(urls.length, "page")}`, items, layout: "table", total: urls.length };
}

/** `type: "research"` — a source-check artifact: its sources, ranked. */
function fromResearch(data: Record<string, unknown>): Collection | undefined {
  const artifact = isRecord(data["artifact"]) ? data["artifact"] : undefined;
  const sources = artifact && Array.isArray(artifact["sources"]) ? artifact["sources"] : [];
  if (sources.length === 0) return undefined;
  const items: CollectionItem[] = [];
  sources.forEach((raw, i) => {
    if (!isRecord(raw) || items.length >= MAX_ITEMS) return;
    const url = text(raw["url"]);
    const title = text(raw["title"]) ?? (url ? hostOf(url) : undefined);
    if (!title) return;
    items.push(
      item(`s${i}`, title, text(raw["snippet"]) ?? text(raw["fetch_error"]), [
        ["Rank", typeof raw["rank"] === "number" ? String(raw["rank"]) : undefined],
        ["Quality", text(raw["quality"])],
        ["URL", url],
      ]),
    );
  });
  if (items.length === 0) return undefined;
  const claim = text(artifact?.["query"]);
  return {
    title: claim ? `${plural(sources.length, "source")} for “${clamp(claim, 60)}”` : plural(sources.length, "source"),
    items,
    layout: "table",
    total: sources.length,
  };
}

function collectionFor(data: Record<string, unknown>): Collection | undefined {
  switch (data["type"]) {
    case "search":
      return fromSearch(data);
    case "fetch":
      return fromFetch(data);
    case "research":
      return fromResearch(data);
    default:
      // A shape this adapter does not know is not a shape to guess at (R3).
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

interface CustomEntryLike {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function entriesOf(ctx: ExtensionContext): readonly CustomEntryLike[] {
  try {
    return ctx.sessionManager.getEntries() as unknown as readonly CustomEntryLike[];
  } catch {
    return [];
  }
}

export const webAccessModule: PiorbitModule = {
  name: "web-access",

  detect({ pi }) {
    try {
      return pi.getAllTools().some((tool) => fromPackage(tool.sourceInfo, PACKAGE_ID));
    } catch {
      // No bound runner yet: "not detected" is the honest answer, and it costs
      // nothing — the transcript still renders the tool rows as it always did.
      return false;
    }
  },

  activate({ pi }) {
    let toolNames = new Set<string>();
    try {
      toolNames = new Set(pi.getAllTools().filter((t) => fromPackage(t.sourceInfo, PACKAGE_ID)).map((t) => t.name));
    } catch {
      // detect() already succeeded, so this is a transient failure; an empty
      // set means no panels rather than a broken session.
    }

    /**
     * Entry count when each of the package's tool calls started. Bounded: a
     * call that is aborted never reaches `tool_execution_end`, so without a cap
     * a long session would accumulate marks for every abandoned search.
     */
    const marks = new Map<string, number>();
    const MAX_MARKS = 64;

    pi.on("tool_execution_start", (event, ctx: ExtensionContext) => {
      if (!toolNames.has(event.toolName)) return;
      if (marks.size >= MAX_MARKS) {
        const oldest = marks.keys().next().value;
        if (oldest !== undefined) marks.delete(oldest);
      }
      marks.set(event.toolCallId, entriesOf(ctx).length);
    });

    pi.on("tool_execution_end", (event, ctx: ExtensionContext) => {
      const from = marks.get(event.toolCallId);
      marks.delete(event.toolCallId);
      if (from === undefined || event.isError) return;

      const appended = entriesOf(ctx).slice(from);
      let index = 0;
      for (const entry of appended) {
        if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !isRecord(entry.data)) continue;
        const collection = collectionFor(entry.data);
        if (!collection) continue;
        const id = text(entry.data["id"]) ?? `${event.toolCallId}-${index}`;
        index += 1;
        const panel: PanelEvent = {
          v: 1,
          id: `${PANEL_PREFIX}:${id}`,
          kind: "collection",
          intent: "inline",
          source: PACKAGE_ID,
          title: collection.title,
          data: {
            layout: collection.layout,
            items: collection.items,
            total: collection.total,
          },
        };
        // Fire-and-forget onto the public bus. A host that is not listening
        // (a terminal Pi) drops it; the tool row is unaffected either way.
        pi.events.emit(PANEL_EVENT, panel);
      }
    });
  },
};
