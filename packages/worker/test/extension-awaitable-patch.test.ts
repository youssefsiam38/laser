import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  SettingsManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

interface Actions {
  sendMessage(message: { customType: string; content: string }, options: { triggerTurn: boolean }): Promise<void>;
  sendUserMessage(content: string): Promise<void>;
}

function pending<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("the pinned extension-send patch", () => {
  it("returns the exact runtime promises from the actual loader API", async () => {
    const entry = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const loaderUrl = pathToFileURL(join(dirname(entry), "core", "extensions", "loader.js")).href;
    const loader = await import(loaderUrl) as {
      createExtensionRuntime(): Record<string, unknown>;
      loadExtensionFromFactory(
        factory: (api: Record<string, unknown>) => void,
        cwd: string,
        eventBus: undefined,
        runtime: Record<string, unknown>,
      ): Promise<unknown>;
    };
    const runtime = loader.createExtensionRuntime();
    let api: { sendMessage: Actions["sendMessage"]; sendUserMessage: Actions["sendUserMessage"] } | undefined;
    await loader.loadExtensionFromFactory((value) => {
      api = value as unknown as typeof api;
    }, process.cwd(), undefined, runtime);

    const user = pending();
    const custom = pending();
    runtime["sendUserMessage"] = () => user.promise;
    runtime["sendMessage"] = () => custom.promise;

    expect(api!.sendUserMessage("owned")).toBe(user.promise);
    expect(api!.sendMessage({ customType: "test", content: "owned" }, { triggerTurn: true })).toBe(custom.promise);
    user.resolve();
    custom.resolve();
    await Promise.all([user.promise, custom.promise]);
  });

  it("treats an actual handled input as accepted without agent work", async () => {
    const base = mkdtempSync(join(tmpdir(), "extension-handled-"));
    const cwd = join(base, "project");
    const agentDir = join(base, "agent");
    const sessionDir = join(base, "sessions");
    for (const path of [cwd, agentDir, sessionDir]) mkdirSync(path, { recursive: true });
    const handled: InlineExtension = (pi) => {
      pi.on("input", () => ({ action: "handled" }));
    };
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [handled],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.create(cwd, sessionDir),
    });
    const events: string[] = [];
    const preflight: boolean[] = [];
    const unsubscribe = created.session.subscribe((event) => events.push(event.type));
    try {
      await created.session.bindExtensions({ mode: "rpc" });
      await created.session.prompt("consumed", {
        source: "extension",
        preflightResult: (accepted) => preflight.push(accepted),
      });
      expect(preflight).toEqual([true]);
      expect(events).not.toContain("agent_start");
      expect(events).not.toContain("agent_settled");
      expect(created.session.isStreaming).toBe(false);
    } finally {
      unsubscribe();
      await created.session.dispose();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("returns the original operations from the actual AgentSession binding and observes ignored rejection", async () => {
    const user = pending();
    const custom = pending();
    const errors: unknown[] = [];
    let actions: Actions | undefined;
    const session = {
      sendUserMessage: () => user.promise,
      sendCustomMessage: () => custom.promise,
      sessionManager: {},
      promptTemplates: [],
      _resourceLoader: { getSkills: () => ({ skills: [] }) },
      _bindExtensionCore: undefined as unknown,
    } as Record<string, unknown>;
    // Use the installed method itself, with only the collaborators it reads at bind time.
    const entry = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const agentSessionUrl = pathToFileURL(join(dirname(entry), "core", "agent-session.js")).href;
    const module = await import(agentSessionUrl) as { AgentSession: { prototype: { _bindExtensionCore(runner: unknown): void } } };
    module.AgentSession.prototype._bindExtensionCore.call(session, {
      getRegisteredCommands: () => [],
      bindCore: (bound: Actions) => {
        actions = bound;
      },
      emitError: (error: unknown) => errors.push(error),
    });

    const returnedUser = actions!.sendUserMessage("held");
    const returnedCustom = actions!.sendMessage({ customType: "test", content: "held" }, { triggerTurn: true });
    expect(returnedUser).toBe(user.promise);
    expect(returnedCustom).toBe(custom.promise);

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    user.reject(new Error("ignored user rejection"));
    custom.reject(new Error("ignored custom rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(errors).toHaveLength(2);
  });

  it("runs each send diagnostic in the sender's async context, never in the operation's", async () => {
    // The patched `bindCore` attaches `.then(undefined, emitError)` at the
    // call site, so AsyncLocalStorage hands the diagnostic the context the
    // extension sent from. The operation itself is created inside a context
    // of its own here, and that context must not reach the diagnostic: an
    // admission helper cannot make the engine's observer carry the new
    // invocation, and nothing but the caller's context is trustworthy.
    const als = new AsyncLocalStorage<{ name: string }>();
    const seen: Array<{ name: string } | undefined> = [];
    let actions: Actions | undefined;
    const refuse = () => als.run({ name: "operation" }, () => Promise.reject(new Error("refused before acceptance")));
    const session = {
      sendUserMessage: refuse,
      sendCustomMessage: refuse,
      sessionManager: {},
      promptTemplates: [],
      _resourceLoader: { getSkills: () => ({ skills: [] }) },
      _bindExtensionCore: undefined as unknown,
    } as Record<string, unknown>;
    const entry = join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
    const agentSessionUrl = pathToFileURL(join(dirname(entry), "core", "agent-session.js")).href;
    const module = await import(agentSessionUrl) as { AgentSession: { prototype: { _bindExtensionCore(runner: unknown): void } } };
    module.AgentSession.prototype._bindExtensionCore.call(session, {
      getRegisteredCommands: () => [],
      bindCore: (bound: Actions) => {
        actions = bound;
      },
      emitError: () => seen.push(als.getStore()),
    });

    await actions!.sendUserMessage("top-level").catch(() => undefined);
    await als.run({ name: "user sender" }, () => actions!.sendUserMessage("nested").catch(() => undefined));
    await als.run({ name: "custom sender" }, () => actions!.sendMessage({ customType: "test", content: "nested" }, { triggerTurn: true }).catch(() => undefined));
    // A delayed observer still carries only its own sender's context.
    const held = pending();
    session["sendUserMessage"] = () => held.promise;
    const delayed = als.run({ name: "delayed sender" }, () => actions!.sendUserMessage("delayed").catch(() => undefined));
    await als.run({ name: "someone else" }, async () => {
      held.reject(new Error("refused later"));
      await delayed;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(seen).toEqual([undefined, { name: "user sender" }, { name: "custom sender" }, { name: "delayed sender" }]);
  });
});
