/**
 * The panel contract (docs/ux-panels.md, D-18 / D-20) — the wire vocabulary
 * for everything an extension can show.
 *
 * Six kinds, one payload each, three shared types. An extension declares a
 * `kind` and an `intent`; piorbit decides the surface. Payloads are data,
 * never presentation: no HTML, no class names, no colours, no widths (the
 * schemas in schemas.ts refuse them).
 *
 * Also here:
 *   - the Pi event-bus protocol (`piorbit:panel`, `piorbit:panel:close`,
 *     `piorbit:panel:action`) the companion extension listens on;
 *   - the `pi/panel/*` methods, added to `ClientRequests` / `HostNotifications`
 *     by module augmentation so messages.ts stays the ACP-shaped core;
 *   - the attention derivation (R1): lifecycle is the data, the five-word
 *     status vocabulary is derived from it.
 */

import type { SessionAttention } from "./messages.js";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

/** A verb the extension will answer to. piorbit renders the control. */
export interface Action {
  id: string;
  label: string;
  /** Ask before sending, with this sentence. */
  confirm?: string;
  destructive?: boolean;
}

/**
 * Raw token counts, never a total: a display total and a billing total do not
 * derive from each other (docs/ux-panels.md, "Usage is raw"). Absent accounting
 * is `null` (with a reason on the panel), which is not zero.
 */
export interface PanelUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costUsd?: number | null;
  /** Why there are no numbers ("not measured for detached runs"). */
  unavailableReason?: string;
}

/**
 * Opaque handle to bytes the host can read in ranges (`pi/panel/read`). The
 * host only serves refs it saw arrive on a panel, so a ref is also a grant.
 * Conventional schemes: `file:<absolute path>`, `log:<sha256>`, `inline:<id>`
 * (client-local; never sent to the host).
 */
export type Ref = string;

export type PanelKind = "run" | "plan" | "document" | "stream" | "collection" | "decision";

/**
 * What the extension wants, not where it goes.
 *   glance   I am state, not content
 *   inline   I belong where I happened
 *   follow   I want to be watched while work continues
 *   inspect  I want your attention now
 */
export type PanelIntent = "glance" | "inline" | "follow" | "inspect";

/** The one status vocabulary (DESIGN.md "Status language", R1). */
export type Attention = SessionAttention;

interface PanelBase {
  /** Stable; re-emit to update in place (R6). Unique within a session. */
  id: string;
  /** Extension or service id. Always shown as a badge. */
  source: string;
  title: string;
  intent: PanelIntent;
}

// ---------------------------------------------------------------------------
// The six payloads
// ---------------------------------------------------------------------------

export type RunLifecycle = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface RunPanel extends PanelBase {
  kind: "run";
  /** Human address, e.g. "@auth-audit". */
  handle?: string;
  lifecycle: RunLifecycle;
  /** "timeout", "output cap", "you stopped it" — never lost (docs: "Everybody loses the reason"). */
  terminalReason?: string;
  /** Set by an adapter that knows better than the derivation; the dot reads this. */
  attention?: Attention;
  /** One line, the agent's own words. */
  activity?: string;
  /** A stepper, not a bar. `index` is **1-based**: step 3 of 3 is `{ index: 3, total: 3 }`. */
  phase?: { label: string; index?: number; total?: number };
  /** Absent = no bar. Nobody has a percentage for shell work. */
  progress?: { done: number; total: number } | "indeterminate";
  /** Who started it. */
  origin?: string;
  parent?: { id: string; relation: "spawned-by" | "step-of" };
  /** What was asked for, versus `model` — what it got. */
  requested?: { model?: string; thinking?: string };
  model?: string;
  startedAt?: string;
  endedAt?: string;
  /** `null` renders as "not measured", which is a different thing from zero. */
  usage?: PanelUsage | null;
  /** The live output, read through the host; `bytes` is the liveness signal. */
  output?: { ref: Ref; bytes?: number };
  artifacts?: Array<{ label: string; ref: Ref }>;
  actions?: Action[];
  error?: string;
}

export type PlanStepState = "pending" | "running" | "done" | "failed" | "skipped" | "blocked";

export interface PlanStep {
  id: string;
  label: string;
  phase?: string;
  state: PlanStepState;
  /** Link to a `run` panel, never a copy of its state. */
  runId?: string;
  /** Only when declared; inferred edges are drawn dashed (R3). */
  dependsOn?: string[];
  model?: string;
  usage?: PanelUsage | null;
  startedAt?: string;
  endedAt?: string;
}

export interface PlanPanel extends PanelBase {
  kind: "plan";
  objective?: string;
  /** Rebuilt from traces rather than declared: drawn dashed and labelled. */
  inferred?: boolean;
  steps: PlanStep[];
  /** The plan itself needs a yes: that is a `decision` panel, linked here. */
  approval?: { decisionId: string };
  usage?: PanelUsage | null;
  actions?: Action[];
}

export type DocumentContent = { ref: Ref } | { inline: string };

export interface DocumentPanel extends PanelBase {
  kind: "document";
  /** "text/markdown", "text/x-diff", "image/png", … */
  mediaType: string;
  content?: DocumentContent;
  /** false → offer to open externally; never guess at a viewer. */
  renderable: boolean;
  version?: { label: string; previousRef?: Ref };
  /** Where it lives, if it lives somewhere. */
  path?: string;
  actions?: Action[];
}

export type StreamEncoding = "text" | "ansi" | "jsonl";

export interface StreamPanel extends PanelBase {
  kind: "stream";
  encoding: StreamEncoding;
  ref: Ref;
  /** Size so far; also the liveness signal. */
  bytes?: number;
  truncated?: "head" | "tail" | "rotated";
  /** Still being written. */
  follow?: boolean;
  actions?: Action[];
}

export interface CollectionItem {
  id: string;
  /** The line you read first. */
  primary: string;
  /** Context under it. */
  secondary?: string;
  /** Columns, when tabular. */
  meta?: Array<{ label: string; value: string }>;
  /** Opens a document panel. */
  ref?: Ref;
  actions?: Action[];
}

export interface CollectionPanel extends PanelBase {
  kind: "collection";
  layout?: "list" | "table";
  items: CollectionItem[];
  total?: number;
  cursor?: string;
  actions?: Action[];
}

export type DecisionBlocking = "tool" | "turn" | "session";
export type DecisionFieldType = "choice" | "text" | "longtext" | "confirm";

export interface DecisionField {
  id: string;
  label: string;
  type: DecisionFieldType;
  options?: string[];
  default?: string;
  required?: boolean;
}

export interface DecisionPanel extends PanelBase {
  kind: "decision";
  message?: string;
  /** Decides placement: a tool row, the turn (card above the composer), or everything (sheet). */
  blocking: DecisionBlocking;
  /** Renders inside that tool row. */
  toolCallId?: string;
  fields: DecisionField[];
  /** "No" is never a dead end: declining opens this field. */
  rejection?: { label: string; field: string };
  timeoutMs?: number;
}

export type Panel = RunPanel | PlanPanel | DocumentPanel | StreamPanel | CollectionPanel | DecisionPanel;

export type PanelOfKind<K extends PanelKind> = Extract<Panel, { kind: K }>;

export const PANEL_KINDS: readonly PanelKind[] = ["run", "plan", "document", "stream", "collection", "decision"];
export const PANEL_INTENTS: readonly PanelIntent[] = ["glance", "inline", "follow", "inspect"];

// ---------------------------------------------------------------------------
// Attention (R1, R5)
// ---------------------------------------------------------------------------

/** Lower = more urgent. waiting > error > finished-unread > working > idle. */
export const ATTENTION_RANK: Readonly<Record<Attention, number>> = {
  waiting_for_input: 0,
  error: 1,
  finished_unread: 2,
  working: 3,
  idle: 4,
};

export interface AttentionContext {
  /** A person has looked at this panel since it last finished. */
  seen?: boolean;
  /** Decision panels still open, so a plan awaiting approval can light up. */
  openDecisionIds?: ReadonlySet<string>;
}

/**
 * The dot for one panel, derived from its lifecycle. Lifecycle and attention
 * are different axes: `cancelled` is not an error, `paused` is not working.
 * An adapter's explicit `attention` wins, because it may know the reason.
 */
export function attentionOf(panel: Panel, context: AttentionContext = {}): Attention {
  const seen = context.seen ?? false;
  switch (panel.kind) {
    case "decision":
      return "waiting_for_input";
    case "run": {
      if (panel.attention) return panel.attention;
      switch (panel.lifecycle) {
        case "queued":
        case "running":
          return "working";
        case "failed":
          return seen ? "idle" : "error";
        case "done":
        case "cancelled":
          return seen ? "idle" : "finished_unread";
        case "paused":
          return "idle";
      }
      return "idle";
    }
    case "plan": {
      if (panel.approval && context.openDecisionIds?.has(panel.approval.decisionId)) return "waiting_for_input";
      const states = new Set(panel.steps.map((s) => s.state));
      if (states.has("failed")) return seen ? "idle" : "error";
      if (states.has("running")) return "working";
      if (panel.steps.length > 0 && [...states].every((s) => s === "done" || s === "skipped")) {
        return seen ? "idle" : "finished_unread";
      }
      return "idle";
    }
    case "stream":
      return panel.follow ? "working" : "idle";
    case "document":
    case "collection":
      return "idle";
  }
}

/** A container's status is the highest-attention status it contains (R1). */
export function highestAttention(list: Iterable<Attention>): Attention {
  let best: Attention = "idle";
  for (const a of list) if (ATTENTION_RANK[a] < ATTENTION_RANK[best]) best = a;
  return best;
}

/** Every ref a panel carries, so the host knows which bytes it may serve. */
export function refsOf(panel: Panel): Ref[] {
  const refs: Ref[] = [];
  switch (panel.kind) {
    case "run":
      if (panel.output) refs.push(panel.output.ref);
      for (const a of panel.artifacts ?? []) refs.push(a.ref);
      break;
    case "document":
      if (panel.content && "ref" in panel.content) refs.push(panel.content.ref);
      if (panel.version?.previousRef) refs.push(panel.version.previousRef);
      break;
    case "stream":
      refs.push(panel.ref);
      break;
    case "collection":
      for (const item of panel.items) if (item.ref) refs.push(item.ref);
      break;
    case "plan":
    case "decision":
      break;
  }
  return refs;
}

/**
 * The one live number a minimal island shows, and the liveness signal the
 * store samples for velocity: bytes for streams and runs with output, steps
 * done for plans, item count for collections.
 */
export function liveBytesOf(panel: Panel): number | undefined {
  switch (panel.kind) {
    case "stream":
      return panel.bytes;
    case "run":
      return panel.output?.bytes;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The declared protocol on Pi's event bus
// ---------------------------------------------------------------------------

export const PANEL_EVENT = "piorbit:panel";
export const PANEL_CLOSE_EVENT = "piorbit:panel:close";
export const PANEL_ACTION_EVENT = "piorbit:panel:action";

/**
 * What an extension emits on `piorbit:panel`. Kind-specific fields travel in
 * `data`; the companion module validates and flattens it into a `Panel`.
 */
export interface PanelEvent {
  v: 1;
  id: string;
  kind: PanelKind;
  /** Defaults per kind: run/plan/stream → follow, document/collection → inline, decision → inspect. */
  intent?: PanelIntent | undefined;
  title: string;
  /** Defaults to the extension's own name when the module can tell, else "extension". */
  source?: string | undefined;
  data: Record<string, unknown>;
  actions?: Action[] | undefined;
}

export interface PanelCloseEvent {
  v?: 1 | undefined;
  id: string;
  /** Said as it goes (R7): "finished", "pruned by retention", … */
  reason?: string | undefined;
}

/** piorbit → extension, on `piorbit:panel:action`. */
export interface PanelActionEvent {
  id: string;
  actionId: string;
  value?: string | undefined;
}

export const DEFAULT_INTENT: Readonly<Record<PanelKind, PanelIntent>> = {
  run: "follow",
  plan: "follow",
  stream: "follow",
  document: "inline",
  collection: "inline",
  decision: "inspect",
};

// ---------------------------------------------------------------------------
// Companion extension ⇄ worker
// ---------------------------------------------------------------------------

/** Worker → companion extension (the only inbound message today). */
export type PiExtensionCommand = { type: "piorbit/panel/action"; id: string; actionId: string; value?: string };

// ---------------------------------------------------------------------------
// The wire: pi/panel/* (module augmentation of the method catalogue)
// ---------------------------------------------------------------------------

export interface PanelReadResult {
  ref: Ref;
  /** Offset the chunk starts at. */
  from: number;
  /** Total size so far, so a follower knows how far behind it is. */
  bytes: number;
  chunk: string;
  /** `base64` for binary refs (images); text refs are UTF-8. */
  encoding: "utf8" | "base64";
  /** The chunk reached the current end. */
  eof: boolean;
}

/** Largest range one `pi/panel/read` answers. Ask again for more. */
export const PANEL_READ_MAX_BYTES = 1024 * 1024;

declare module "./messages.js" {
  interface ClientRequests {
    /**
     * A person pressed an action on a panel. `delivered` is false when no
     * extension still holds that panel id (it closed, or the session restarted).
     * Fallback decision panels (ids starting `ui:`) answer via `pi/ui/response`
     * instead; the client knows which is which.
     */
    "pi/panel/action": {
      params: { path: string; id: string; actionId: string; value?: string };
      result: { delivered: boolean };
    };
    /**
     * Ranged read of a stream or document ref. `to` is exclusive and capped at
     * PANEL_READ_MAX_BYTES past `from`; both are **byte** offsets, and the
     * result's `from` comes back aligned to a UTF-8 character boundary.
     *
     * `path` is the session the ref is being read from. A grant records the
     * session its panel arrived on, and a read from another session is
     * refused: the relay makes a client an arbitrary remote peer, and the
     * grant is the only thing between a panel ref and the filesystem.
     */
    "pi/panel/read": { params: { path: string; ref: Ref; from: number; to: number }; result: PanelReadResult };
    /** Every open panel of a session, for a client that (re)attaches. */
    "pi/panel/list": { params: { path: string }; result: { panels: Panel[] } };
  }

  interface HostNotifications {
    /** A panel appeared or changed. Same id replaces in place (R6); arriving twice is normal (R9). */
    "pi/panel/upsert": { path: string; panel: Panel };
    /** A panel ended, and says which way (R7). */
    "pi/panel/close": { path: string; id: string; reason?: string };
  }
}
