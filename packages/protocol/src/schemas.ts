/**
 * Runtime validation (M0-T2). The hand-written types in messages.ts stay the
 * source of truth for TypeScript; these schemas guard the process boundary
 * (worker stdio, host WebSocket, relay) where input is untrusted bytes.
 *
 * `clientParamsSchemas satisfies Record<ClientMethod, ...>` makes the compiler
 * refuse a new method in messages.ts that has no schema here.
 */
import { z } from "zod";
import { WEB_SEARCH_PROVIDER_IDS } from "./web-search.js";
import { ErrorCodes, type JsonRpcRequest } from "./jsonrpc.js";
import { PREFS_MAX_BYTES } from "./messages.js";
import type { ClientMethod, ClientRequests } from "./messages.js";
import {
  DEFAULT_INTENT,
  PANEL_INTENTS,
  PANEL_KINDS,
  PANEL_READ_MAX_BYTES,
  type Panel,
  type PanelActionEvent,
  type PanelCloseEvent,
} from "./panels.js";

// ---------- the product's identity ----------

/**
 * `product.json`, validated (MX-T7, D-36).
 *
 * The build reads that file with plain `JSON.parse` in four places — the
 * generators, the drift check, the Linux packaging scripts and the TypeScript
 * emitter — so this is where a malformed field becomes a named failure instead
 * of a product that answers to two names. The rules are the ones the operating
 * systems actually enforce: reverse-DNS with three segments for an app id
 * (macOS keys TCC grants on it), RFC 3986 for a scheme, and a shell-safe
 * upper-case prefix for environment variables.
 */
const formerIdentitySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      dirName: z.string().min(1).optional(),
      storagePrefix: z.string().min(1).optional(),
      envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
      symbolPrefix: z.string().min(1).optional(),
      appId: z.string().min(1).optional(),
      urlScheme: z.string().min(1).optional(),
    })
    .strict(),
]);

export const productIdentitySchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "lower case, starts with a letter, letters digits and hyphens only"),
    displayName: z.string().min(1),
    appId: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+){2,}$/, "reverse-DNS with at least three segments"),
    urlScheme: z.string().regex(/^[a-z][a-z0-9+.-]*$/, "RFC 3986: a-z, digits, + . -"),
    envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "upper case, digits and underscores"),
    dirName: z.string().min(1),
    storagePrefix: z.string().min(1),
    symbolPrefix: z.string().min(1),
    binary: z.string().min(1),
    repository: z.string().regex(/^[^/]+\/[^/]+$/, "owner/name"),
    wireNamespace: z.string().min(1),
    vendor: z.string().min(1).optional(),
    maintainerEmail: z.string().optional(),
    formerNames: z.array(formerIdentitySchema).optional(),
    copy: z.record(z.string(), z.string()).optional(),
    license: z.object({ project: z.string(), metadata: z.string() }).partial().optional(),
    categories: z.array(z.string()).optional(),
    webCategories: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    branding: z.record(z.string(), z.string()).optional(),
    iconSizes: z.array(z.number().int().positive()).optional(),
  })
  // `$`-prefixed keys are product.json's comments, and `desktopFileName` and
  // friends are what the generator adds when it hands the shape to TypeScript.
  .passthrough();

export type ProductIdentity = z.infer<typeof productIdentitySchema>;

// ---------- values ----------

export const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image"), mimeType: z.string().min(1), data: z.string().min(1) }).strict(),
]);

export const modelRefSchema = z
  .object({
    provider: z.string().min(1),
    id: z.string().min(1),
    name: z.string().optional(),
    contextWindow: z.number().int().nonnegative().optional(),
    reasoning: z.boolean().optional(),
    vision: z.boolean().optional(),
  })
  .strict();

export const thinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const uiDialogResponseSchema = z.union([
  z.object({ id: z.string().min(1), value: z.string() }).strict(),
  z.object({ id: z.string().min(1), confirmed: z.boolean() }).strict(),
  z.object({ id: z.string().min(1), cancelled: z.literal(true) }).strict(),
]);

const sessionPath = z.string().min(1);
const content = z.array(contentBlockSchema).min(1);

// ---------- M4 values (settings, packages, providers, logs) ----------

const cwd = z.string().min(1);
export const settingsScopeSchema = z.enum(["global", "project"]);
export const featureScopeSchema = z.enum(["global", "project"]);
export const packageScopeSchema = z.enum(["user", "project"]);
export const logSectionSchema = z.enum(["provider", "tools", "session", "subagents", "host"]);
export const providerLoginMethodSchema = z.enum(["oauth", "api_key"]);
/** An exact release: `1.2.3`, `1.2.3-beta.1`. Ranges are the host's job to resolve, never a caller's to send. */
export const exactVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, {
  message: "must be an exact version such as 1.2.3",
});
const providerId = z.string().min(1).max(100);
const loginId = z.string().min(1).max(100);
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

/**
 * A settings path is a dotted chain of JSON identifiers. Refusing `__proto__`
 * and friends here means the writer never has to defend against prototype
 * pollution while walking the document.
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
export const settingsPathSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value
        .split(".")
        .every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && !FORBIDDEN_SEGMENTS.has(segment)),
    { message: "must be a dotted chain of JSON identifiers (no __proto__, constructor or prototype)" },
  );

export const settingChangeSchema = z.union([
  z.object({ path: settingsPathSchema, op: z.literal("set"), value: z.unknown() }).strict(),
  z.object({ path: settingsPathSchema, op: z.literal("unset") }).strict(),
]);

export const logQuerySchema = z
  .object({
    kind: z.string().min(1).max(100).optional(),
    promptEntryId: z.string().min(1).max(200).optional(),
    afterAt: z.string().datetime({ offset: true }).optional(),
    beforeAt: z.string().datetime({ offset: true }).optional(),
    sections: z.array(logSectionSchema).min(1).max(5).optional(),
    cwd: cwd.optional(),
    sessionPath: sessionPath.optional(),
    search: z.string().max(500).optional(),
    levels: z.array(logLevelSchema).min(1).max(4).optional(),
    afterId: z.number().int().nonnegative().optional(),
    beforeId: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(1000).optional(),
    byteBudget: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  })
  .strict();

// ---------- panels (docs/ux-panels.md) ----------

const panelId = z.string().min(1).max(200);
const panelText = z.string().max(4000);
const ref = z.string().min(1).max(2000);
const isoDate = z.string().min(1).max(40);

export const panelKindSchema = z.enum(PANEL_KINDS as [Panel["kind"], ...Panel["kind"][]]);
export const panelIntentSchema = z.enum(PANEL_INTENTS as [Panel["intent"], ...Panel["intent"][]]);
export const attentionSchema = z.enum(["idle", "working", "waiting_for_input", "error", "finished_unread"]);

export const actionSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(80),
    confirm: z.string().max(400).optional(),
    destructive: z.boolean().optional(),
  })
  .strict();

export const usageSchema = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    turns: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().nullable().optional(),
    unavailableReason: z.string().max(200).optional(),
  })
  .strict();

const panelBase = {
  id: panelId,
  source: z.string().min(1).max(100),
  title: z.string().min(1).max(300),
  intent: panelIntentSchema,
};

const runPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("run"),
    handle: z.string().max(100).optional(),
    lifecycle: z.enum(["queued", "running", "paused", "done", "failed", "cancelled"]),
    terminalReason: z.string().max(300).optional(),
    attention: attentionSchema.optional(),
    activity: z.string().max(1000).optional(),
    // `index` is 1-based, so it reads as "index of total" with no arithmetic
    // anywhere between the producer and the stepper (docs/ux-panels.md).
    phase: z
      .object({ label: z.string().max(100), index: z.number().int().positive().optional(), total: z.number().int().positive().optional() })
      .strict()
      .optional(),
    progress: z
      .union([z.object({ done: z.number().nonnegative(), total: z.number().positive() }).strict(), z.literal("indeterminate")])
      .optional(),
    origin: z.string().max(200).optional(),
    parent: z.object({ id: panelId, relation: z.enum(["spawned-by", "step-of"]) }).strict().optional(),
    requested: z.object({ model: z.string().max(200).optional(), thinking: z.string().max(40).optional() }).strict().optional(),
    model: z.string().max(200).optional(),
    startedAt: isoDate.optional(),
    endedAt: isoDate.optional(),
    usage: usageSchema.nullable().optional(),
    usageByModel: z
      .array(z.object({ model: z.string().max(200).optional(), usage: usageSchema }).strict())
      .max(16)
      .optional(),
    output: z.object({ ref, bytes: z.number().int().nonnegative().optional() }).strict().optional(),
    artifacts: z.array(z.object({ label: z.string().min(1).max(200), ref }).strict()).max(200).optional(),
    actions: z.array(actionSchema).max(20).optional(),
    error: z.string().max(4000).optional(),
  })
  .strict();

const planStepSchema = z
  .object({
    id: panelId,
    label: z.string().min(1).max(300),
    phase: z.string().max(100).optional(),
    state: z.enum(["pending", "running", "done", "failed", "skipped", "blocked"]),
    runId: panelId.optional(),
    dependsOn: z.array(panelId).max(100).optional(),
    model: z.string().max(200).optional(),
    usage: usageSchema.nullable().optional(),
    startedAt: isoDate.optional(),
    endedAt: isoDate.optional(),
  })
  .strict();

const planPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("plan"),
    objective: z.string().max(2000).optional(),
    inferred: z.boolean().optional(),
    steps: z.array(planStepSchema).max(1000),
    approval: z.object({ decisionId: panelId }).strict().optional(),
    usage: usageSchema.nullable().optional(),
    actions: z.array(actionSchema).max(20).optional(),
  })
  .strict();

const documentPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("document"),
    mediaType: z.string().min(1).max(120),
    content: z
      .union([z.object({ ref }).strict(), z.object({ inline: z.string().max(512 * 1024) }).strict()])
      .optional(),
    renderable: z.boolean(),
    version: z.object({ label: z.string().min(1).max(100), previousRef: ref.optional() }).strict().optional(),
    path: z.string().max(2000).optional(),
    actions: z.array(actionSchema).max(20).optional(),
  })
  .strict();

const streamPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("stream"),
    encoding: z.enum(["text", "ansi", "jsonl"]),
    ref,
    bytes: z.number().int().nonnegative().optional(),
    truncated: z.enum(["head", "tail", "rotated"]).optional(),
    follow: z.boolean().optional(),
    actions: z.array(actionSchema).max(20).optional(),
  })
  .strict();

const collectionItemSchema = z
  .object({
    id: panelId,
    primary: z.string().min(1).max(1000),
    secondary: panelText.optional(),
    meta: z.array(z.object({ label: z.string().max(60), value: z.string().max(400) }).strict()).max(20).optional(),
    ref: ref.optional(),
    actions: z.array(actionSchema).max(10).optional(),
  })
  .strict();

const collectionPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("collection"),
    layout: z.enum(["list", "table"]).optional(),
    items: z.array(collectionItemSchema).max(2000),
    total: z.number().int().nonnegative().optional(),
    cursor: z.string().max(500).optional(),
    actions: z.array(actionSchema).max(20).optional(),
  })
  .strict();

const decisionFieldSchema = z
  .object({
    id: z.string().min(1).max(100),
    label: z.string().min(1).max(300),
    type: z.enum(["choice", "text", "longtext", "confirm"]),
    options: z.array(z.string().max(300)).max(100).optional(),
    default: z.string().max(4000).optional(),
    required: z.boolean().optional(),
  })
  .strict();

const decisionPanelSchema = z
  .object({
    ...panelBase,
    kind: z.literal("decision"),
    message: panelText.optional(),
    blocking: z.enum(["tool", "turn", "session"]),
    toolCallId: z.string().max(200).optional(),
    fields: z.array(decisionFieldSchema).min(1).max(50),
    rejection: z.object({ label: z.string().min(1).max(100), field: z.string().min(1).max(100) }).strict().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/** A complete panel as it travels host → client. Strict: unknown keys are refused. */
export const panelSchema: z.ZodType<Panel> = z
  .discriminatedUnion("kind", [
    runPanelSchema,
    planPanelSchema,
    documentPanelSchema,
    streamPanelSchema,
    collectionPanelSchema,
    decisionPanelSchema,
  ])
  // "No" opens a field, so the field has to exist — a rejection pointing at
  // nothing would make declining a dead end, which is the one thing it must never be.
  .superRefine((panel, ctx) => {
    if (panel.kind === "decision" && panel.rejection && !panel.fields.some((f) => f.id === panel.rejection?.field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rejection", "field"],
        message: "rejection.field must name one of the decision's fields",
      });
    }
  }) as unknown as z.ZodType<Panel>;

/**
 * Presentation never crosses the bus: an extension that sends any of these,
 * at any depth of `data`, is asking for a new kind, not a new look. Named so
 * the refusal can say which field, rather than "unrecognized key".
 */
export const PRESENTATION_KEYS: ReadonlySet<string> = new Set([
  "html",
  "innerHTML",
  "className",
  "class",
  "style",
  "styles",
  "css",
  "color",
  "colour",
  "background",
  "width",
  "height",
  "icon",
  "component",
  "render",
  "layoutHint",
  "surface",
]);

/** First presentation key found anywhere in `value` (dotted path), or undefined. */
export function findPresentationKey(value: unknown, path = ""): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findPresentationKey(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (PRESENTATION_KEYS.has(key)) return here;
    const hit = findPresentationKey(child, here);
    if (hit) return hit;
  }
  return undefined;
}

export const panelEventSchema = z
  .object({
    v: z.literal(1),
    id: panelId,
    kind: panelKindSchema,
    intent: panelIntentSchema.optional(),
    title: z.string().min(1).max(300),
    source: z.string().min(1).max(100).optional(),
    data: z.record(z.string(), z.unknown()),
    actions: z.array(actionSchema).max(20).optional(),
  })
  .strict();

export const panelCloseEventSchema = z
  .object({ v: z.literal(1).optional(), id: panelId, reason: z.string().max(300).optional() })
  .strict();

export const panelActionEventSchema = z
  .object({ id: panelId, actionId: z.string().min(1).max(100), value: z.string().max(64 * 1024).optional() })
  .strict();

export type PanelValidation = { ok: true; panel: Panel } | { ok: false; error: string };

/**
 * Validate a `laser:panel` bus event and flatten it into a `Panel`.
 * Strict at both layers; the error is one sentence naming the field, so the
 * extension author can act on it when it shows up in the logs.
 */
export function validatePanelEvent(raw: unknown, defaultSource = "extension"): PanelValidation {
  const event = panelEventSchema.safeParse(raw);
  if (!event.success) return { ok: false, error: describeIssues(event.error.issues) };
  const presentation = findPresentationKey(event.data.data, "data");
  if (presentation) {
    return { ok: false, error: `presentation is not accepted (${presentation}); declare a kind and data only` };
  }
  const e = event.data;
  const candidate: Record<string, unknown> = {
    ...e.data,
    kind: e.kind,
    id: e.id,
    title: e.title,
    source: e.source ?? defaultSource,
    intent: e.intent ?? DEFAULT_INTENT[e.kind],
    ...(e.actions ? { actions: e.actions } : {}),
  };
  const panel = panelSchema.safeParse(candidate);
  if (!panel.success) return { ok: false, error: describeIssues(panel.error.issues) };
  return { ok: true, panel: panel.data };
}

export function validatePanelClose(raw: unknown): { ok: true; event: PanelCloseEvent } | { ok: false; error: string } {
  const parsed = panelCloseEventSchema.safeParse(raw);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, error: describeIssues(parsed.error.issues) };
}

export function validatePanelAction(raw: unknown): { ok: true; event: PanelActionEvent } | { ok: false; error: string } {
  const parsed = panelActionEventSchema.safeParse(raw);
  return parsed.success ? { ok: true, event: parsed.data } : { ok: false, error: describeIssues(parsed.error.issues) };
}

function describeIssues(issues: readonly z.ZodIssue[]): string {
  const first = issues[0];
  if (!first) return "invalid panel";
  const where = first.path.length > 0 ? first.path.map(String).join(".") : "payload";
  return `${where}: ${first.message}`;
}

/**
 * Params of a ranged read: `to` is exclusive and at most PANEL_READ_MAX_BYTES
 * past `from`, and both are byte offsets. `path` names the session the read is
 * made from, so a grant that belongs to another session is refused.
 */
export const panelReadParamsSchema = z
  .object({ path: sessionPath, ref, from: z.number().int().nonnegative(), to: z.number().int().nonnegative() })
  .strict()
  .refine((p) => p.to > p.from, { message: "to must be greater than from" })
  .refine((p) => p.to - p.from <= PANEL_READ_MAX_BYTES, {
    message: `read at most ${PANEL_READ_MAX_BYTES} bytes per request`,
  });

// ---------- M7 push / M8 dictation values ----------

/** A push endpoint is an absolute https URL chosen by the browser's push service. */
const pushEndpoint = z.string().url().max(2048).startsWith("https://");

export const pushSubscriptionSchema = z
  .object({
    endpoint: pushEndpoint,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }).strict(),
  })
  .strict();

export const pushDeviceSchema = z
  .object({
    label: z.string().min(1).max(120),
    platform: z.enum(["ios", "android", "other"]),
    standalone: z.boolean(),
  })
  .strict();

const uploadId = z.string().min(1).max(80);
/** 32 KiB decoded is ~43.7 KiB of base64; the cap leaves room for the envelope. */
const audioChunk = z.string().max(64 * 1024);

// ---------- M11 prefs / M4-T7 keybindings / composer sources ----------

/**
 * A preference namespace is a short, flat, lower-case id. Flat on purpose: a
 * namespace is a filing drawer, not a path, so there is nothing here that could
 * ever be mistaken for a filesystem or a prototype chain.
 */
export const prefsNamespaceSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, { message: "must be lower-case letters, digits and dashes, starting with a letter" });

/**
 * The value is whatever the owning feature stores; the host never reads inside
 * it. What is checked is that it is JSON at all and that it is small — a
 * preference that does not fit in a quarter of a megabyte is not a preference.
 */
export const prefsValueSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be JSON, or null to clear the namespace" });
    return;
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be JSON (it could not be serialised)" });
    return;
  }
  if (Buffer.byteLength(text, "utf8") > PREFS_MAX_BYTES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be at most ${PREFS_MAX_BYTES} bytes of JSON` });
  }
});

/** A binding id as the agent spells it: dotted, lower-case-ish, no separators of its own. */
export const keybindingIdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, { message: "must be a dotted binding id such as app.interrupt" });

/**
 * One chord as the agent writes it: `ctrl+shift+f`, `enter`, `alt+backspace`.
 * Refusing anything else here means the writer never puts a string the agent
 * cannot parse into the person's keybindings file.
 */
export const keyIdSchema = z
  .string()
  .min(1)
  .max(60)
  // Printable ASCII with no spaces: `ctrl+shift+f`, `alt+backspace`, `ctrl+]`.
  .regex(/^[!-~]+$/, { message: "must be a key such as ctrl+shift+f, with no spaces" });

export const keybindingChangeSchema = z.union([
  z.object({ id: keybindingIdSchema, op: z.literal("set"), keys: z.array(keyIdSchema).min(1).max(8) }).strict(),
  z.object({ id: keybindingIdSchema, op: z.literal("reset") }).strict(),
]);

// ---------- client → host request params, one per method ----------

export const clientParamsSchemas = {
  "session/new": z.object({ cwd: z.string().min(1), parentPath: sessionPath.optional() }).strict(),
  "session/load": z.object({ path: sessionPath, fromSeq: z.number().int().nonnegative().optional() }).strict(),
  "session/prompt": z
    .object({ path: sessionPath, content, streamingBehavior: z.enum(["steer", "followUp"]).optional() })
    .strict(),
  "session/cancel": z.object({ path: sessionPath }).strict(),
  "session/set_mode": z.object({ path: sessionPath, mode: z.string().min(1) }).strict(),

  "pi/host/version": z.object({}).strict(),
  "pi/session/list": z.object({ cwd: z.string().min(1).optional() }).strict(),
  "session/search": z.object({ query: z.string().trim().min(1).max(200), cwd: z.string().min(1).optional(), after: z.string().datetime().optional(), before: z.string().datetime().optional(), cursor: z.number().int().nonnegative().optional() }).strict(),
  "pi/session/inbox": z
    .object({ cwd: z.string().min(1).optional(), limit: z.number().int().positive().max(500).optional() })
    .strict(),
  "pi/session/seen": z.object({ path: sessionPath, seq: z.number().int().nonnegative().optional() }).strict(),
  "pi/session/detach": z.object({ path: sessionPath }).strict(),
  "pi/session/steer": z.object({ path: sessionPath, content }).strict(),
  "pi/session/follow_up": z.object({ path: sessionPath, content }).strict(),
  "pi/session/clear_queue": z.object({ path: sessionPath }).strict(),
  "pi/session/fork": z.object({ path: sessionPath, entryId: z.string().min(1) }).strict(),
  "pi/session/navigate": z
    .object({ path: sessionPath, entryId: z.string().min(1), summarize: z.boolean().optional(), label: z.string().optional() })
    .strict(),
  "pi/session/rename": z.object({ path: sessionPath, name: z.string() }).strict(),
  "pi/session/delete": z.object({ path: sessionPath }).strict(),
  "pi/session/entries": z.object({ path: sessionPath }).strict(),
  "pi/session/compact": z.object({ path: sessionPath, instructions: z.string().optional() }).strict(),
  "pi/model/list": z.object({ path: sessionPath }).strict(),
  "pi/model/set": z.object({ path: sessionPath, model: modelRefSchema }).strict(),
  "pi/thinking/set": z.object({ path: sessionPath, level: thinkingLevelSchema }).strict(),
  "pi/account-usage/refresh": z.object({ path: sessionPath }).strict(),
  "pi/ui/response": uiDialogResponseSchema,

  "pi/project/list": z.object({}).strict(),
  "pi/project/add": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/project/reorder": z.object({ cwds: z.array(z.string().min(1)).max(1_000) }).strict(),
  "pi/project/remove": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/project/trust": z
    .object({ cwd: z.string().min(1), trusted: z.boolean(), remember: z.boolean().optional() })
    .strict(),
  "pi/project/git": z.object({ cwd: z.string().min(1), path: sessionPath.optional() }).strict(),
  "pi/project/browse": z.object({ path: z.string().min(1).max(4096).optional() }).strict(),

  "pi/worker/list": z.object({}).strict(),
  "pi/worker/restart": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/worker/stop": z.object({ cwd: z.string().min(1) }).strict(),

  // --- M4: settings, packages, providers, logs ---
  "pi/settings/list": z.object({ cwd }).strict(),
  "pi/settings/get": z.object({ cwd }).strict(),
  "pi/settings/set": z
    .object({ cwd, scope: settingsScopeSchema, changes: z.array(settingChangeSchema).min(1).max(200) })
    .strict(),

  "feature/list": z.object({ cwd: cwd.optional() }).strict(),
  "web-search/status": z.object({ cwd }).strict(),
  "web-search/configure": z.object({ cwd, change: z.discriminatedUnion("action", [
    z.object({ action: z.literal("test") }).strict(),
    z.object({ action: z.literal("select"), provider: z.enum(WEB_SEARCH_PROVIDER_IDS) }).strict(),
    z.object({ action: z.literal("configure"), provider: z.enum(WEB_SEARCH_PROVIDER_IDS), connection: z.object({
      source: z.enum(["none", "dedicated", "shared"]),
      sharedProvider: z.string().min(1).max(80).optional(),
      baseUrl: z.string().trim().max(2048).optional(),
      zone: z.string().trim().max(120).optional(),
    }).strict(), apiKey: z.string().trim().min(1).max(16384).regex(/^[^\x00-\x1f\x7f]+$/).nullable().optional(), activate: z.boolean().optional() }).strict(),
  ]) }).strict(),
  "feature/set": z
    .object({ id: z.string().min(1).max(80), enabled: z.boolean().nullable(), scope: featureScopeSchema, cwd: cwd.optional() })
    .strict(),
  "session/goal/get": z.object({ path: sessionPath }).strict(),
  "session/goal/action": z
    .object({
      path: sessionPath,
      action: z.discriminatedUnion("action", [
        z.object({ action: z.literal("pause") }).strict(),
        z.object({ action: z.literal("resume") }).strict(),
        z.object({ action: z.literal("clear") }).strict(),
        z.object({ action: z.literal("edit"), objective: z.string().trim().min(1).max(4000) }).strict(),
        z.object({ action: z.literal("start"), objective: z.string().trim().min(1).max(4000) }).strict(),
      ]),
    })
    .strict(),

  "pi/packages/list": z.object({ cwd }).strict(),
  "pi/packages/install": z
    .object({ cwd, source: z.string().min(1).max(500), scope: packageScopeSchema, version: exactVersion.optional() })
    .strict(),
  "pi/packages/remove": z.object({ cwd, source: z.string().min(1).max(500), scope: packageScopeSchema }).strict(),
  "pi/packages/update": z.object({ cwd, source: z.string().min(1).max(500).optional() }).strict(),
  "pi/packages/check_updates": z.object({ cwd }).strict(),

  "pi/packages/catalog": z
    .object({ cwd: cwd.optional(), query: z.string().max(200).optional(), limit: z.number().int().positive().max(200).optional() })
    .strict(),
  "pi/packages/runtime": z.object({}).strict(),
  "pi/packages/records": z.object({ cwd: cwd.optional() }).strict(),

  "pi/providers/list": z.object({ cwd }).strict(),
  "pi/models/catalog": z.object({ cwd, refresh: z.boolean().optional() }).strict(),
  "pi/providers/login/start": z.object({ cwd, provider: providerId, method: providerLoginMethodSchema }).strict(),
  "pi/providers/login/answer": z
    .object({ cwd, id: loginId, promptId: z.string().min(1).max(100), value: z.string().max(16 * 1024) })
    .strict(),
  "pi/providers/login/cancel": z.object({ cwd, id: loginId }).strict(),
  "pi/providers/logout": z.object({ cwd, provider: providerId }).strict(),

  "pi/setup/state": z.object({}).strict(),
  "pi/setup/complete": z.object({ completed: z.boolean() }).strict(),

  "pi/logs/query": logQuerySchema,
  "pi/logs/content": z
    .object({ ref: z.string().regex(/^[0-9a-f]{64}$/), maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional() })
    .strict(),
  "pi/logs/stats": z.object({}).strict(),
  "pi/logs/clear": z.object({ sections: z.array(logSectionSchema).min(1).max(5).optional() }).strict(),

  // --- panels (docs/ux-panels.md) ---
  "pi/panel/action": z
    .object({ path: sessionPath, id: panelId, actionId: z.string().min(1).max(100), value: z.string().max(64 * 1024).optional() })
    .strict(),
  "pi/panel/read": panelReadParamsSchema,
  "pi/panel/list": z.object({ path: sessionPath }).strict(),

  // --- M11 prefs (host-owned; never Pi's settings file) ---
  "pi/prefs/get": z.object({ namespace: prefsNamespaceSchema.optional() }).strict(),
  "pi/prefs/set": z.object({ namespace: prefsNamespaceSchema, value: prefsValueSchema }).strict(),

  // --- M4-T7 keybindings ---
  "pi/keybindings/get": z.object({ cwd }).strict(),
  "pi/keybindings/set": z.object({ cwd, changes: z.array(keybindingChangeSchema).min(1).max(200) }).strict(),

  // --- composer sources ---
  "pi/commands/list": z.union([z.object({ path: sessionPath }).strict(), z.object({ cwd }).strict()]),
  "pi/prompts/list": z.object({ path: sessionPath }).strict(),
  "pi/project/files": z
    .object({ cwd, query: z.string().max(200).optional(), limit: z.number().int().positive().max(2000).optional() })
    .strict(),

  // --- M7 push. Endpoints are absolute https URLs from the browser. ---
  "pi/push/config": z.object({}).strict(),
  "pi/push/subscribe": z.object({ subscription: pushSubscriptionSchema, device: pushDeviceSchema }).strict(),
  "pi/push/unsubscribe": z.object({ endpoint: pushEndpoint }).strict(),
  "pi/push/test": z.object({ endpoint: pushEndpoint }).strict(),

  // --- M8 dictation ---
  "pi/transcribe/status": z.object({ cwd }).strict(),
  "pi/transcribe/begin": z
    .object({
      cwd,
      mimeType: z.string().min(1).max(120),
      language: z.string().max(16).optional(),
      path: sessionPath.optional(),
    })
    .strict(),
  "pi/transcribe/chunk": z.object({ id: uploadId, data: audioChunk }).strict(),
  "pi/transcribe/end": z.object({ id: uploadId }).strict(),
  "pi/transcribe/cancel": z.object({ id: uploadId }).strict(),
} satisfies Record<ClientMethod, z.ZodTypeAny>;

export const clientMethods = Object.keys(clientParamsSchemas) as ClientMethod[];

export function isClientMethod(method: string): method is ClientMethod {
  return Object.prototype.hasOwnProperty.call(clientParamsSchemas, method);
}

// ---------- envelope ----------

const jsonRpcId = z.union([z.string(), z.number()]);

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcId,
    method: z.string().min(1),
    params: z.unknown().optional(),
    clientVersion: z.string().min(1).optional(),
  })
  .strict();

export const jsonRpcNotificationSchema = z
  .object({ jsonrpc: z.literal("2.0"), method: z.string().min(1), params: z.unknown().optional() })
  .strict();

export const jsonRpcResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcId,
    result: z.unknown().optional(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .strict()
      .optional(),
  })
  .strict();

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export type TypedClientRequest = {
  [M in ClientMethod]: JsonRpcRequest<M, ClientRequests[M]["params"]>;
}[ClientMethod];

/**
 * Parse one raw JSON-RPC line into a typed client request. Throws
 * ProtocolError with the right JSON-RPC code for the host to echo back.
 */
export function parseClientRequest(raw: unknown): TypedClientRequest {
  const env = jsonRpcRequestSchema.safeParse(raw);
  if (!env.success) {
    throw new ProtocolError(ErrorCodes.InvalidRequest, "invalid JSON-RPC request envelope", env.error.issues);
  }
  const { method } = env.data;
  if (!isClientMethod(method)) {
    throw new ProtocolError(ErrorCodes.MethodNotFound, `unknown method ${method}`);
  }
  const params = clientParamsSchemas[method].safeParse(env.data.params ?? {});
  if (!params.success) {
    throw new ProtocolError(ErrorCodes.InvalidParams, `invalid params for ${method}`, params.error.issues);
  }
  return { jsonrpc: "2.0", id: env.data.id, method, params: params.data } as TypedClientRequest;
}

/** Parse a raw line of JSON; a syntax error is a ParseError, not an exception. */
export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new ProtocolError(ErrorCodes.ParseError, "invalid JSON", error instanceof Error ? error.message : String(error));
  }
}
