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
import { MCP_IMPORT_SOURCES, MCP_PROTOCOL_VERSIONS, MCP_STARTUP_MODES, MCP_TOOL_EXPOSURES } from "./mcp.js";
import {
  AGENT_DESCRIPTION_MAX,
  AGENT_INSTRUCTIONS_MAX,
  AGENT_MAX_DEPTH_LIMIT,
  AGENT_MESSAGE_MODES,
  AGENT_NAME_PATTERN,
  AGENT_RUN_STATUSES,
  BUILTIN_AGENT_NAMES,
  FOREGROUND_COMMAND_SECONDS_MAX,
  FOREGROUND_COMMAND_SECONDS_MIN,
} from "./agents.js";
import { MAX_FALLBACK_CHAIN_MODELS } from "./fallback.js";
import { PROVIDER_FAILURE_CLASSES } from "./provider-failure.js";
import { ErrorCodes, type JsonRpcRequest } from "./jsonrpc.js";
import { PREFS_MAX_BYTES } from "./messages.js";
import type { ClientMethod, ClientRequests } from "./messages.js";
import { TASK_COMMAND_MAX, TASK_LINE_MAX } from "./tasks.js";

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
/** A pending-tray id, as the worker mints it: `p-` and hex. */
const pendingId = z.string().regex(/^p-[0-9a-f]{8,32}$/);

// ---------- M4 values (settings, packages, providers, logs) ----------

const cwd = z.string().min(1);

// ---------- M14 MCP servers ----------

/** Letters, digits, `-` and `_`: it becomes a tool-name prefix (docs/mcp.md). */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const mcpServerName = z.string().regex(MCP_SERVER_NAME_PATTERN, "Use letters, digits, hyphens and underscores; up to 64 characters.");
const mcpSecretRef = z.object({ secret: z.literal(true), present: z.boolean().optional() }).strict();
const mcpSecretInput = z.object({ secret: z.literal(true), value: z.string().min(1).max(16384).regex(/^[^\x00-\x1f\x7f]+$/) }).strict();
const mcpValueInput = z.union([z.string().max(16384), mcpSecretRef, mcpSecretInput]);
const mcpNamePattern = z.string().min(1).max(256);
const mcpTransportInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("stdio"),
      command: z.string().trim().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(256).optional(),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), mcpValueInput).optional(),
      cwd: z.string().max(4096).optional(),
      inheritEnv: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("http"),
      url: z.string().trim().min(1).max(8192),
      headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), mcpValueInput).optional(),
      stream: z.enum(["auto", "streamable-http", "sse"]).optional(),
      caFile: z.string().max(4096).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("socket"), path: z.string().trim().min(1).max(4096) }).strict(),
]);
const mcpAuthInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("bearer"), token: mcpValueInput }).strict(),
  z
    .object({
      kind: z.literal("oauth"),
      clientId: z.string().max(1024).optional(),
      clientSecret: mcpValueInput.optional(),
      scope: z.string().max(2048).optional(),
      redirectUri: z.string().max(2048).optional(),
      authServerMetadataUrl: z.string().max(2048).optional(),
      grantType: z.enum(["authorization_code", "client_credentials"]).optional(),
    })
    .strict(),
]);
const mcpToolPolicySchema = z
  .object({
    exposure: z.enum(MCP_TOOL_EXPOSURES),
    only: z.array(mcpNamePattern).max(1000).optional(),
    include: z.array(mcpNamePattern).max(1000).optional(),
    exclude: z.array(mcpNamePattern).max(1000).optional(),
    approve: z.union([z.boolean(), z.array(mcpNamePattern).max(1000)]).optional(),
  })
  .strict();
export const mcpServerConfigInputSchema = z
  .object({
    name: mcpServerName,
    label: z.string().trim().min(1).max(120).optional(),
    transport: mcpTransportInputSchema.optional(),
    auth: mcpAuthInputSchema.optional(),
    startup: z.enum(MCP_STARTUP_MODES).optional(),
    tools: mcpToolPolicySchema.optional(),
    idleMinutes: z.number().int().min(0).max(100_000).optional(),
    requestTimeoutMs: z.number().int().min(0).max(3_600_000).optional(),
    protocolVersion: z.enum(MCP_PROTOCOL_VERSIONS).optional(),
    resourcesAsTools: z.boolean().optional(),
    debug: z.boolean().optional(),
    disabled: z.boolean().optional(),
    catalogId: z.string().max(64).optional(),
  })
  .strict()
  // A definition, or the one entry that only switches a global server off.
  .refine((server) => server.transport !== undefined || server.disabled === true, "Choose how to connect, or switch the server off.")
  .refine((server) => server.auth === undefined || server.auth.kind === "none" || server.transport?.kind === "http", "Sign-in applies to HTTP servers only.");
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

// ---------- background tasks (docs/ux-fleet.md) ----------

const taskId = z.string().min(1).max(200);
const isoDate = z.string().min(1).max(40);

export const backgroundTaskStatusSchema = z.enum(["running", "completed", "failed", "stopped"]);
export const backgroundTaskOriginSchema = z.enum(["background", "promoted"]);

/**
 * One background task as it travels extension → worker → host → client.
 * Strict: a module that starts inventing fields is asking for a change to the
 * domain model, not for a wider bag.
 */
export const backgroundTaskUpdateSchema = z
  .object({
    id: taskId,
    command: z.string().min(1).max(TASK_COMMAND_MAX),
    title: z.string().min(1).max(TASK_LINE_MAX),
    status: backgroundTaskStatusSchema,
    origin: backgroundTaskOriginSchema,
    startedAt: isoDate,
    endedAt: isoDate.optional(),
    exitCode: z.number().int().nullable().optional(),
    outputBytes: z.number().int().nonnegative(),
    activity: z.string().max(TASK_LINE_MAX).optional(),
    terminalReason: z.string().max(300).optional(),
    error: z.string().max(4000).optional(),
    /** Host-side only; the host reads it and never forwards it to a client. */
    logPath: z.string().min(1).max(4096).optional(),
  })
  .strict();

/**
 * Params of a ranged output read. At most {@link TASK_OUTPUT_MAX_BYTES} come
 * back per call, and `path` names the session the task must belong to: the
 * relay makes a client an arbitrary remote peer, and the task's own session is
 * the only thing between a task id and a file on disk.
 */
export const taskOutputParamsSchema = z
  .object({ path: sessionPath, id: taskId, fromByte: z.number().int().nonnegative() })
  .strict();

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

// ---------- agents (docs/agents-leap) ----------

export const agentNameSchema = z.string().regex(AGENT_NAME_PATTERN, {
  message: "lower case, starts with a letter, letters, digits and hyphens only, at most 40 characters",
});
export const agentModelChoiceSchema = z.object({ provider: z.string().min(1).max(100), id: z.string().min(1).max(200) }).strict();
export const agentMessageModeSchema = z.enum(AGENT_MESSAGE_MODES).default("interrupt");
export const builtinAgentNameSchema = z.enum(BUILTIN_AGENT_NAMES);
export const agentSkillRefSchema = z
  .object({ name: z.string().min(1).max(64), path: z.string().min(1).max(4096), scope: z.enum(["global", "project"]) })
  .strict();
export const agentDefinitionInputSchema = z
  .object({
    name: agentNameSchema,
    description: z.string().max(AGENT_DESCRIPTION_MAX),
    instructions: z.string().max(AGENT_INSTRUCTIONS_MAX),
    engineInstructions: z.boolean(),
    model: agentModelChoiceSchema.nullable(),
    thinkingLevel: thinkingLevelSchema.nullable(),
    supportsSubagents: z.boolean(),
    allowedAgents: z.array(agentNameSchema).max(100),
    scopedSkills: z.boolean(),
    skills: z.array(agentSkillRefSchema).max(200),
  })
  .strict();
export const agentPolicyPatchSchema = z
  .object({
    maxDepth: z.number().int().min(1).max(AGENT_MAX_DEPTH_LIMIT).optional(),
    foregroundCommandSeconds: z.number().int().min(FOREGROUND_COMMAND_SECONDS_MIN).max(FOREGROUND_COMMAND_SECONDS_MAX).optional(),
  })
  .strict();
export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES as [string, ...string[]]);

/**
 * The fallback record a session file carries (M15-T3).
 *
 * It is read back from a file that a previous generation of this app wrote, so
 * it is validated rather than trusted: a malformed entry must leave a session
 * with no chain, never with half a traversal. Strict, so a new field cannot
 * appear without this schema and the round-trip sample saying what it means.
 */
const fallbackModelRefSchema = z
  .object({ provider: z.string().min(1).max(100), id: z.string().min(1).max(200) })
  .strict();
const providerFailureClassSchema = z.enum(PROVIDER_FAILURE_CLASSES as unknown as [string, ...string[]]);
const isoInstant = z.string().min(1).max(64);
export const sessionFallbackEntrySchema = z
  .object({
    version: z.literal(1),
    event: z.enum(["activated", "switched", "returned", "attempt_failed", "exhausted", "cleared"]),
    at: isoInstant,
    from: fallbackModelRefSchema.optional(),
    to: fallbackModelRefSchema.optional(),
    failure: z.object({ class: providerFailureClassSchema, at: isoInstant }).strict().optional(),
    activation: z
      .object({
        id: z.string().min(1).max(100),
        chainKey: z.string().min(1).max(320),
        models: z.array(fallbackModelRefSchema).min(1).max(MAX_FALLBACK_CHAIN_MODELS),
        position: z.number().int().nonnegative().max(MAX_FALLBACK_CHAIN_MODELS),
        startedAt: isoInstant,
      })
      .strict()
      .nullable(),
    failover: z
      .object({
        id: z.string().min(1).max(100),
        startedAt: isoInstant,
        attempts: z
          .array(
            z
              .object({
                model: z.string().min(1).max(320),
                at: isoInstant,
                outcome: z.enum(["failed", "succeeded", "skipped"]),
                class: providerFailureClassSchema.optional(),
                reason: z.string().max(300).optional(),
              })
              .strict(),
          )
          .max(4 * MAX_FALLBACK_CHAIN_MODELS),
        endedAt: isoInstant.optional(),
        ended: z.enum(["switched", "returned", "exhausted", "aborted"]).optional(),
      })
      .strict()
      .optional(),
    models: z.record(
      z
        .object({
          lastFailure: z.object({ class: providerFailureClassSchema, at: isoInstant }).strict().optional(),
          cooldownUntil: isoInstant.optional(),
          knownResetAt: isoInstant.optional(),
          nonTransient: z.boolean().optional(),
        })
        .strict(),
    ),
  })
  .strict();
const runId = z.string().min(1).max(100);
/** Loose on purpose: the host relays what a worker produced; the worker validated it. */
const agentsSnapshotSchema = z.object({ revision: z.number().int().nonnegative() }).passthrough();

/**
 * The bookkeeping half of a `session/load` reply.
 *
 * `state` is the engine's own snapshot and is not re-validated here; the two
 * sequence numbers are the part a client reasons about, and getting either of
 * them wrong duplicates or holes a transcript, so they are checked. Strict, so
 * a third counter cannot appear without this schema and its round-trip sample
 * saying what it means.
 */
export const sessionLoadResultSchema = z
  .object({
    state: z.unknown(),
    /** Earliest seq the reply covers; a mismatch with `fromSeq` means resync. */
    replayFrom: z.number().int().nonnegative(),
    /** The worker's watermark for this session as it answered. */
    seq: z.number().int().nonnegative(),
  })
  .strict();

// ---------- client → host request params, one per method ----------

export const clientParamsSchemas = {
  "session/new": z.object({ cwd: z.string().min(1), parentPath: sessionPath.optional(), agentName: agentNameSchema.optional() }).strict(),
  "session/load": z.object({ path: sessionPath, fromSeq: z.number().int().nonnegative().optional() }).strict(),
  "session/prompt": z
    .object({
      path: sessionPath,
      content,
      streamingBehavior: z.enum(["steer", "followUp"]).optional(),
      firstTurn: z.object({
        agentName: agentNameSchema,
        model: modelRefSchema.nullable().optional(),
        thinkingLevel: thinkingLevelSchema.optional(),
      }).strict().optional(),
    })
    .strict(),
  "session/cancel": z.object({ path: sessionPath }).strict(),
  "session/set_mode": z.object({ path: sessionPath, mode: z.string().min(1) }).strict(),

  "pi/host/version": z.object({}).strict(),
  "pi/host/environment": z.object({ variables: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.string().max(131_072).refine((value) => !value.includes("\0"), "invalid environment value"),
  ).refine((variables) => Object.keys(variables).length <= 4096
    && Object.entries(variables).reduce((size, [key, value]) => size + key.length + value.length + 2, 0) <= 1_048_576,
  "environment is too large") }).strict(),
  "pi/session/list": z.object({ cwd: z.string().min(1).optional() }).strict(),
  "session/search": z.object({ query: z.string().trim().min(1).max(200), cwd: z.string().min(1).optional(), after: z.string().datetime().optional(), before: z.string().datetime().optional(), cursor: z.number().int().nonnegative().optional() }).strict(),
  "pi/session/inbox": z
    .object({ cwd: z.string().min(1).optional(), limit: z.number().int().positive().max(500).optional() })
    .strict(),
  "pi/session/seen": z.object({ path: sessionPath, seq: z.number().int().nonnegative().optional() }).strict(),
  "pi/session/detach": z.object({ path: sessionPath }).strict(),
  // A move names the session and the project it goes to, nothing else: the
  // destination file is the host's to choose (M13-T58).
  "pi/session/move": z.object({ path: sessionPath, cwd }).strict(),
  "pi/session/close": z.object({ path: sessionPath }).strict(),
  "pi/session/steer": z.object({ path: sessionPath, content }).strict(),
  "pi/session/follow_up": z.object({ path: sessionPath, content }).strict(),
  "pi/session/clear_queue": z.object({ path: sessionPath }).strict(),

  // The pending tray (pending.ts). Laser's own list, so every operation names
  // one message by the id the worker minted for it.
  "session/pending/list": z.object({ path: sessionPath }).strict(),
  "session/pending/add": z.object({ path: sessionPath, content }).strict(),
  "session/pending/edit": z.object({ path: sessionPath, id: pendingId, content }).strict(),
  "session/pending/remove": z.object({ path: sessionPath, id: pendingId }).strict(),
  "session/pending/steer": z.object({ path: sessionPath, id: pendingId }).strict(),
  "session/pending/clear": z.object({ path: sessionPath }).strict(),
  "pi/session/fork": z.object({ path: sessionPath, entryId: z.string().min(1), stopFirst: z.boolean().optional() }).strict(),
  "pi/session/navigate": z
    .object({ path: sessionPath, entryId: z.string().min(1), summarize: z.boolean().optional(), label: z.string().optional(), stopFirst: z.boolean().optional() })
    .strict(),
  "pi/session/rename": z.object({ path: sessionPath, name: z.string() }).strict(),
  // `worktree` is optional and defaults to keeping it: a caller that omits the
  // field never destroys a child agent's checkout (M13-T42).
  "pi/session/delete": z.object({ path: sessionPath, worktree: z.enum(["keep", "delete"]).optional() }).strict(),
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

  // --- M14 MCP servers (docs/mcp.md) ---
  "mcp/list": z.object({ cwd }).strict(),
  "mcp/save": z.object({ cwd, scope: featureScopeSchema, server: mcpServerConfigInputSchema, originalName: mcpServerName.optional() }).strict(),
  "mcp/remove": z.object({ cwd, scope: featureScopeSchema, name: mcpServerName }).strict(),
  "mcp/inspect": z
    .object({ cwd, scope: featureScopeSchema, name: mcpServerName.optional(), server: mcpServerConfigInputSchema.optional() })
    .strict()
    .refine((value) => (value.name === undefined) !== (value.server === undefined), "Name a saved server or pass a definition, not both."),
  "mcp/ping": z.object({ cwd, scope: featureScopeSchema, name: mcpServerName }).strict(),
  "mcp/call": z
    .object({ cwd, scope: featureScopeSchema, name: mcpServerName, tool: z.string().min(1).max(256), args: z.record(z.string(), z.unknown()) })
    .strict(),
  "mcp/disconnect": z.object({ cwd, scope: featureScopeSchema, name: mcpServerName }).strict(),
  "mcp/auth/start": z.object({ cwd, scope: featureScopeSchema, name: mcpServerName }).strict(),
  "mcp/auth/complete": z
    .object({ cwd, scope: featureScopeSchema, name: mcpServerName, redirectUrl: z.string().trim().min(1).max(8192).optional(), code: z.string().trim().min(1).max(4096).optional() })
    .strict()
    .refine((value) => value.redirectUrl !== undefined || value.code !== undefined, "Paste the callback URL or the code."),
  "mcp/auth/logout": z.object({ cwd, scope: featureScopeSchema, name: mcpServerName }).strict(),
  "mcp/import/detect": z.object({ cwd }).strict(),
  "mcp/import/apply": z
    .object({ cwd, source: z.enum(MCP_IMPORT_SOURCES), names: z.array(mcpServerName).min(1).max(200), scope: featureScopeSchema, replace: z.boolean().optional() })
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

  // --- background tasks (docs/ux-fleet.md) ---
  "tasks/list": z.object({ path: sessionPath.optional() }).strict(),
  "tasks/output": taskOutputParamsSchema,
  "tasks/stop": z.object({ path: sessionPath, id: z.string().min(1).max(200) }).strict(),
  "pi/task/stop": z.object({ path: sessionPath, id: z.string().min(1).max(200) }).strict(),

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
  "pi/project/read": z.object({ cwd, path: z.string().min(1).max(4096) }).strict(),

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

  // --- M13 agents (docs/agents-leap) ---
  "agents/list": z.object({}).strict(),
  "agents/validate": z.object({ agent: agentDefinitionInputSchema, originalName: agentNameSchema.nullable() }).strict(),
  "agents/save": z.object({ agent: agentDefinitionInputSchema, originalName: agentNameSchema.nullable() }).strict(),
  "agents/delete": z.object({ name: agentNameSchema }).strict(),
  "agents/set-default": z.object({ name: agentNameSchema }).strict(),
  "agents/set-policy": z.object({ policy: agentPolicyPatchSchema }).strict(),
  "agents/skills": z.object({ cwd }).strict(),
  "agents/engine-instructions": z.object({ cwd }).strict(),
  "agents/runs/list": z.object({ path: sessionPath.optional() }).strict(),
  "agents/runs/stop": z.object({ runId, reason: z.string().max(2000).optional() }).strict(),
  "agents/worktree/status": z.object({ path: sessionPath }).strict(),
  "agents/worktree/remove": z.object({ path: sessionPath, force: z.boolean().optional() }).strict(),
  "agents/builtin/set-model": z.object({ name: builtinAgentNameSchema, model: agentModelChoiceSchema.nullable() }).strict(),
  "agents/builtin/set-instructions": z.object({ name: builtinAgentNameSchema, instructions: z.string().max(AGENT_INSTRUCTIONS_MAX).nullable() }).strict(),
  "agents/namer/qualify": z.object({ cwd }).strict(),
  "agents/sync": z.object({ snapshot: agentsSnapshotSchema }).strict(),
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
