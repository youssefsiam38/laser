/**
 * Runtime validation (M0-T2). The hand-written types in messages.ts stay the
 * source of truth for TypeScript; these schemas guard the process boundary
 * (worker stdio, host WebSocket, relay) where input is untrusted bytes.
 *
 * `clientParamsSchemas satisfies Record<ClientMethod, ...>` makes the compiler
 * refuse a new method in messages.ts that has no schema here.
 */
import { z } from "zod";
import { ErrorCodes, type JsonRpcRequest } from "./jsonrpc.js";
import type { ClientMethod, ClientRequests } from "./messages.js";

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
export const packageScopeSchema = z.enum(["user", "project"]);
export const logSectionSchema = z.enum(["provider", "tools", "session", "subagents", "host"]);
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

// ---------- client → host request params, one per method ----------

export const clientParamsSchemas = {
  "session/new": z.object({ cwd: z.string().min(1), parentPath: sessionPath.optional() }).strict(),
  "session/load": z.object({ path: sessionPath, fromSeq: z.number().int().nonnegative().optional() }).strict(),
  "session/prompt": z
    .object({ path: sessionPath, content, streamingBehavior: z.enum(["steer", "followUp"]).optional() })
    .strict(),
  "session/cancel": z.object({ path: sessionPath }).strict(),
  "session/set_mode": z.object({ path: sessionPath, mode: z.string().min(1) }).strict(),

  "pi/session/list": z.object({ cwd: z.string().min(1).optional() }).strict(),
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
  "pi/session/entries": z.object({ path: sessionPath }).strict(),
  "pi/session/compact": z.object({ path: sessionPath, instructions: z.string().optional() }).strict(),
  "pi/model/list": z.object({ path: sessionPath }).strict(),
  "pi/model/set": z.object({ path: sessionPath, model: modelRefSchema }).strict(),
  "pi/thinking/set": z.object({ path: sessionPath, level: thinkingLevelSchema }).strict(),
  "pi/ui/response": uiDialogResponseSchema,

  "pi/project/list": z.object({}).strict(),
  "pi/project/add": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/project/remove": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/project/trust": z
    .object({ cwd: z.string().min(1), trusted: z.boolean(), remember: z.boolean().optional() })
    .strict(),

  "pi/worker/list": z.object({}).strict(),
  "pi/worker/restart": z.object({ cwd: z.string().min(1) }).strict(),
  "pi/worker/stop": z.object({ cwd: z.string().min(1) }).strict(),

  // --- M4: settings, packages, providers, logs ---
  "pi/settings/list": z.object({ cwd }).strict(),
  "pi/settings/get": z.object({ cwd }).strict(),
  "pi/settings/set": z
    .object({ cwd, scope: settingsScopeSchema, changes: z.array(settingChangeSchema).min(1).max(200) })
    .strict(),

  "pi/packages/list": z.object({ cwd }).strict(),
  "pi/packages/install": z.object({ cwd, source: z.string().min(1).max(500), scope: packageScopeSchema }).strict(),
  "pi/packages/remove": z.object({ cwd, source: z.string().min(1).max(500), scope: packageScopeSchema }).strict(),
  "pi/packages/update": z.object({ cwd, source: z.string().min(1).max(500).optional() }).strict(),
  "pi/packages/check_updates": z.object({ cwd }).strict(),

  "pi/providers/list": z.object({ cwd }).strict(),
  "pi/models/catalog": z.object({ cwd, refresh: z.boolean().optional() }).strict(),

  "pi/logs/query": logQuerySchema,
  "pi/logs/content": z
    .object({ ref: z.string().regex(/^[0-9a-f]{64}$/), maxBytes: z.number().int().positive().max(8 * 1024 * 1024).optional() })
    .strict(),
  "pi/logs/stats": z.object({}).strict(),
  "pi/logs/clear": z.object({ sections: z.array(logSectionSchema).min(1).max(5).optional() }).strict(),
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
