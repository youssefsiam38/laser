/**
 * The engine's built-in system prompt, as text a person can read and edit
 * into their own `default` agent.
 *
 * The engine does not export its prompt builder from the package index, so it
 * is loaded by file URL next to the resolved entry point — the D-38 technique
 * `keybindings.ts` uses. If a later engine moves it, this says so in one
 * sentence and returns nothing rather than inventing a prompt.
 */
import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ErrorCodes, ProtocolError } from "@lasercode/protocol";
import { ENGINE_BUILTIN_TOOLS } from "./session-config.js";

interface SystemPromptModule {
  buildSystemPrompt(options: { cwd: string; selectedTools?: string[]; toolSnippets?: Record<string, string> }): string;
}

let loaded: Promise<SystemPromptModule> | undefined;

/**
 * Where the pinned engine keeps `system-prompt.js`: `import.meta.resolve` in
 * the built worker, the `node_modules` walk under the test runner (which does
 * not provide it) — the same two ways `keybindings.ts` uses.
 */
export function engineSystemPromptModulePath(): string {
  const relative = join("core", "system-prompt.js");
  const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolve === "function") {
    try {
      const candidate = join(dirname(fileURLToPath(resolve("@earendil-works/pi-coding-agent"))), relative);
      if (existsSync(candidate)) return candidate;
    } catch {
      /* fall through to the directory walk */
    }
  }
  const suffix = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", relative);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, suffix);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) break;
    dir = parent;
  }
  throw new ProtocolError(ErrorCodes.Unsupported, "This engine version keeps its built-in instructions somewhere new; the default agent's instructions cannot be shown until the app is updated.");
}

function loadSystemPromptModule(): Promise<SystemPromptModule> {
  loaded ??= (async () => {
    const path = engineSystemPromptModulePath();
    let mod: Partial<SystemPromptModule>;
    try {
      mod = (await import(pathToFileURL(path).href)) as Partial<SystemPromptModule>;
    } catch {
      throw new ProtocolError(ErrorCodes.Unsupported, "This engine version keeps its built-in instructions somewhere new; the default agent's instructions cannot be shown until the app is updated.");
    }
    if (typeof mod.buildSystemPrompt !== "function") {
      throw new ProtocolError(ErrorCodes.Unsupported, "This engine version no longer exposes its built-in instructions; the default agent's instructions cannot be shown until the app is updated.");
    }
    return mod as SystemPromptModule;
  })();
  return loaded;
}

/** One-line snippets for the default tools, exactly as the engine registers them. */
export function defaultToolSnippets(cwd: string): Record<string, string> {
  const definitions = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const snippets: Record<string, string> = {};
  for (const definition of definitions) {
    const snippet = (definition as { promptSnippet?: string }).promptSnippet;
    if (snippet) snippets[definition.name] = snippet.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  }
  return snippets;
}

/** Strip the trailing working-directory line the engine appends; the agent's own cwd is added at run time. */
export function stripWorkingDirectory(text: string): string {
  return text.replace(/\n*Current working directory: [^\n]*\s*$/, "").trimEnd();
}

/**
 * The built-in prompt for the default tools, without the trailing working
 * directory line, project context or skills — those are added per session.
 */
export async function engineDefaultInstructions(cwd: string): Promise<string> {
  const { buildSystemPrompt } = await loadSystemPromptModule();
  const text = buildSystemPrompt({ cwd, selectedTools: [...ENGINE_BUILTIN_TOOLS], toolSnippets: defaultToolSnippets(cwd) });
  return stripWorkingDirectory(text);
}
