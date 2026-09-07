#!/usr/bin/env node
/**
 * Sandboxed demo environment: a temp Pi agent dir with a fake streaming
 * provider, and the host serving the built UI. Never touches ~/.pi/agent.
 *
 *   pnpm sandbox            # http://127.0.0.1:41441
 *   PORT=5000 pnpm sandbox
 *
 * It records itself in its own state dir the way `laser up` does, so the CLI
 * can be pointed at it:
 *
 *   LASER_STATE_DIR=<the state dir it prints> laser status
 *
 * The fake provider ("stub/stub-1") echoes a short markdown reply with a code
 * fence so streaming, markdown, and tool-free turns can be exercised.
 * Requires `pnpm -r build` first.
 */
import { identity as product } from "./identity/identity.mjs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostServer } from "@lasercode/host";
import { processIdentity, writeHostFile } from "@lasercode/cli";

const PORT = Number(process.env.PORT ?? 41441);
const base = mkdtempSync(join(tmpdir(), `${product.name}-sandbox-`));
const project = join(base, "project");
const agentDir = join(base, "agent");
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(project, "README.md"), `# Sandbox project\n\nA scratch project for ${product.name} demos.\n`);
const skillDir = join(agentDir, "skills", "sandbox-review");
mkdirSync(skillDir, { recursive: true });
writeFileSync(
  join(skillDir, "SKILL.md"),
  "---\nname: sandbox-review\ndescription: Review the sandbox response for clarity and correctness\ndisable-model-invocation: true\n---\n\nReview the response carefully before answering.\n",
);

// ---- fake OpenAI-compatible streaming provider ----
const reply = (prompt) =>
  [
    `You said: **${prompt.slice(0, 60)}**\n\n`,
    "Here is a list:\n\n- one\n- two\n- three\n\n",
    "And a code block:\n\n```ts\n",
    "export function hello(name: string) {\n",
    "  return `hi ${name}`;\n",
    "}\n```\n\n",
    "Done.",
  ];
const provider = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const msgs = JSON.parse(body).messages ?? [];
    const last = msgs.at(-1)?.content;
    const prompt = typeof last === "string" ? last : Array.isArray(last) ? last.map((p) => p.text ?? "").join("") : "";
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    // Goal regression specimen: the real engine terminates on this tool with
    // no assistant text. Its durable summary must remain readable in chat.
    if (process.env.SANDBOX_GOAL === "1" && msgs.at(-1)?.role === "user" && prompt.includes("<goal_id>")) {
      const goalId = /<goal_id>\s*([^\s<>]+)\s*<\/goal_id>/.exec(prompt)?.[1];
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
        name: "goal_complete", arguments: JSON.stringify({ goal_id: goalId, summary: "The root Compose file provides a persistent development stack. The docker directory contains the isolated CI test stack. Compared the service definitions and documented their intended use; no files were changed." }),
      } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.end("data: [DONE]\n\n");
      return;
    }
    // Opt-in lifecycle specimen: real worker events, including partial command
    // output. Never runs unless the exact sandbox-only prompt is submitted.
    if (process.env.SANDBOX_ACTIVITY === "1" && msgs.at(-1)?.role === "user" && prompt === "sandbox activity") {
      for (const text of ["Checking the execution path. ", "I will run a short command and observe its progress."]) {
        send({ ...base, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
        await new Promise(r => setTimeout(r, 1200));
      }
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
        name: "bash", arguments: JSON.stringify({ command: "printf 'progress\\n'; sleep 30; printf 'done\\n'" }),
      } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.end("data: [DONE]\n\n");
      return;
    }
    for (const piece of reply(prompt)) {
      for (const ch of piece.match(/.{1,6}/gs) ?? []) {
        send({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify(
    { providers: { stub: { baseUrl: providerUrl, api: "openai-completions", apiKey: "sandbox", models: [{ id: "stub-1", name: "Stub One", contextWindow: 8000, maxTokens: 1000 }] } } },
    null,
    2,
  ),
);
// ---- a tiny extension that exercises every portable UI surface ----
//
// It is listed in `settings.extensions` rather than only dropped in
// `<agentDir>/extensions/`: Pi 0.85 builds its extension set from the package
// manager's resolved paths, so a file sitting in that directory with nothing
// pointing at it is never loaded. (`discoverAndLoadExtensions` still exists and
// does scan the directory, but the session's resource loader does not call it.)
const extensionFile = join(agentDir, "extensions", "sandbox-dialogs.ts");
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", theme: "dark", extensions: [extensionFile] }, null, 2),
);

mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  extensionFile,
  `export default function (pi) {
  pi.registerCommand("ask", {
    description: "sandbox: select dialog",
    handler: async (_args, ctx) => {
      const v = await ctx.ui.select("Pick one", ["Alpha", "Beta", "Gamma"]);
      ctx.ui.notify(v ? "You picked " + v : "Cancelled", v ? "info" : "warning");
      ctx.ui.setStatus("sandbox", v ? "picked " + v : undefined);
    },
  });
  pi.registerCommand("confirm", {
    description: "sandbox: confirm dialog",
    handler: async (_args, ctx) => {
      const ok = await ctx.ui.confirm("Proceed?", "This only shows a toast.");
      ctx.ui.notify(ok ? "Confirmed" : "Declined", ok ? "info" : "warning");
    },
  });
  pi.registerCommand("input", {
    description: "sandbox: input dialog",
    handler: async (_args, ctx) => {
      const v = await ctx.ui.input("Your name?", "type here");
      ctx.ui.notify(v ? "Hello " + v : "No name", "info");
    },
  });
  pi.registerCommand("widget", {
    description: "sandbox: widget above the editor",
    handler: async (args, ctx) => {
      ctx.ui.setWidget("sandbox", args === "off" ? undefined : ["sandbox widget", "line two: " + new Date().toISOString()]);
      ctx.ui.setTitle("sandbox title");
    },
  });

  // The declared panel protocol (docs/ux-panels.md). One of each kind, so the
  // dock, the phone strip and the popped-out page all have something real to
  // draw without pi-subagents being installed.
  const emitPanels = () => {
      const now = Date.now();
      pi.events.emit("lasercode:panel", {
        v: 1, id: "sandbox:run", kind: "run", intent: "follow",
        title: "worker#2", source: "sandbox", handle: "@sandbox",
        lifecycle: "running", activity: "reading the repository",
        phase: { label: "survey", index: 1, total: 3 },
        startedAt: new Date(now - 42_000).toISOString(),
        usage: { input: 84_800, output: 7_000, cacheRead: 328_000, cacheWrite: 0, costUsd: 0.032 },
        actions: [{ id: "stop", label: "Stop", destructive: true, confirm: "Stop worker#2?" }],
      });
      pi.events.emit("lasercode:panel", {
        v: 1, id: "sandbox:plan", kind: "plan", intent: "follow",
        title: "Workflow · 2 lanes", source: "sandbox", objective: "Ship the sandbox demo",
        inferred: true,
        steps: [
          { id: "s1", label: "survey", phase: "preflight", state: "done" },
          { id: "s2", label: "patch", phase: "work", state: "running", runId: "sandbox:run" },
          { id: "s3", label: "verify", phase: "work", state: "pending" },
        ],
        usage: null,
      });
      pi.events.emit("lasercode:panel", {
        v: 1, id: "sandbox:doc", kind: "document", intent: "follow",
        title: "README.md", source: "sandbox", mediaType: "text/markdown", renderable: true,
        content: { inline: "# Sandbox project\n\nA scratch project for demos.\n\n- one\n- two\n" },
      });
      pi.events.emit("lasercode:panel", {
        v: 1, id: "sandbox:hits", kind: "collection", intent: "inline",
        title: '3 results for "noise protocol"', source: "sandbox", layout: "list",
        items: [
          { id: "a", primary: "Noise Protocol Framework", secondary: "The specification", meta: [{ label: "url", value: "https://noiseprotocol.org" }] },
          { id: "b", primary: "Noise_KK", secondary: "Both parties know each other's static key" },
          { id: "c", primary: "Noise explained", secondary: "A walkthrough" },
        ],
        total: 3,
      });
      pi.events.emit("lasercode:panel", {
        v: 1, id: "sandbox:ask", kind: "decision", intent: "inspect",
        title: "Publish the sandbox build?", source: "sandbox", blocking: "turn",
        message: "Nothing is published; this only shows a toast.",
        fields: [
          { id: "confirm", label: "Publish the sandbox build?", type: "confirm" },
          { id: "why", label: "Tell the sandbox why", type: "longtext" },
        ],
        rejection: { label: "No", field: "why" },
      });
  };

  // Emitted at session start so the panel gallery is immediately visible.
  // The registered command remains available in the composer's live catalogue
  // for testing explicit command invocation as well.
  pi.on("session_start", () => { console.error("[sandbox-ext] session_start"); setTimeout(() => { try { emitPanels(); console.error("[sandbox-ext] panels emitted"); } catch (e) { console.error("[sandbox-ext] emit failed: " + e); } }, 400); });

  pi.registerCommand("panels", { description: "sandbox: re-emit the demo panels", handler: async () => emitPanels() });

  // Answering closes the question, which is what makes "delivered" true rather
  // than a claim. The stream kind is covered by /widget, whose lines the host
  // turns into a stream panel through the fallback.
  pi.events.on("lasercode:panel:action", (event) => {
    if (event.id === "sandbox:ask") pi.events.emit("lasercode:panel:close", { id: "sandbox:ask", reason: "answered" });
  });
}
`,
);

// ---- host ----
// `stateDir` keeps the sandbox's projects, attention and log store inside the
// temp dir; without it a demo run would write to the real ~/.laser.
const sessionDir = join(base, "sessions");
const stateDir = join(base, "state");
const subagentsTempRoot = join(stateDir, "subagents");
const host = new HostServer({
  port: PORT,
  agentDir,
  sessionDir,
  stateDir,
  subagentsTempRoot,
  log: (l) => console.error(l),
});
const { url, port } = await host.listen();

// The same record `laser up` writes. Without it the CLI has no way to find
// this host, and half of what the CLI does could not be tried against a
// sandbox at all.
const hostFile = join(stateDir, "host.json");
mkdirSync(stateDir, { recursive: true });
const identity = processIdentity(process.pid);
writeHostFile(hostFile, {
  pid: process.pid,
  host: "127.0.0.1",
  port,
  url,
  agentDir,
  sessionDir,
  stateDir,
  subagentsTempRoot,
  startedAt: new Date().toISOString(),
  cliVersion: "sandbox",
  ...(identity ? { identity } : {}),
});

console.log(
  `${product.name} sandbox\n  ui:       ${url}\n  project:  ${project}\n  agentDir: ${agentDir}\n  stateDir: ${stateDir}\n  provider: ${providerUrl}\n` +
    `  cli:      ${product.env.stateDir}=${stateDir} ${product.env.agentDir}=${agentDir} ${product.binary} status`,
);

// ---- demo panels, seeded from the host ----
//
// The extension above emits the same five panels on Pi's bus, which is the
// path a real package takes. It is registered in `settings.extensions`, but Pi
// 0.85 builds a session's extension set from its *package manager*, so a bare
// path there is not enough to load it and the demo would be empty. Seeding the
// panel hub directly keeps the sandbox honest — it is the same hub, the same
// broadcast and the same panels a client would receive — and it is marked
// `source: "sandbox"` so nobody mistakes it for an extension that ran.
const seeded = new Set();
setInterval(() => {
  for (const worker of host.pool.workers()) {
    for (const path of host.pool.openSessions(worker.cwd)) {
      if (seeded.has(path)) continue;
      seeded.add(path);
      for (const panel of demoPanels()) host.panels.upsert(worker.cwd, path, panel);
    }
  }
}, 1000).unref();

function demoPanels() {
  if (process.env.SANDBOX_GOAL === "1") return [];
  const now = Date.now();
  return [
    {
      kind: "run", id: "sandbox:run", source: "sandbox", title: "worker#2", intent: "follow", handle: "@sandbox",
      lifecycle: "running", activity: "reading the repository",
      phase: { label: "survey", index: 1, total: 3 },
      startedAt: new Date(now - 42_000).toISOString(),
      usage: { input: 84_800, output: 7_000, cacheRead: 328_000, cacheWrite: 0, costUsd: 0.032 },
      actions: [{ id: "stop", label: "Stop", destructive: true, confirm: "Stop worker#2?" }],
    },
    {
      kind: "plan", id: "sandbox:plan", source: "sandbox", title: "Workflow · 2 lanes", intent: "follow",
      objective: "Ship the sandbox demo", inferred: true, usage: null,
      steps: [
        { id: "s1", label: "survey", phase: "preflight", state: "done" },
        { id: "s2", label: "patch", phase: "work", state: "running", runId: "sandbox:run" },
        { id: "s3", label: "verify", phase: "work", state: "pending" },
      ],
    },
    {
      kind: "document", id: "sandbox:doc", source: "sandbox", title: "README.md", intent: "follow",
      mediaType: "text/markdown", renderable: true,
      content: { inline: "# Sandbox project\n\nA scratch project for demos.\n\n- one\n- two\n" },
    },
    {
      kind: "collection", id: "sandbox:hits", source: "sandbox", title: '3 results for "noise protocol"',
      intent: "inline", layout: "list", total: 3,
      items: [
        { id: "a", primary: "Noise Protocol Framework", secondary: "The specification", meta: [{ label: "url", value: "https://noiseprotocol.org" }] },
        { id: "b", primary: "Noise_KK", secondary: "Both parties know each other's static key" },
        { id: "c", primary: "Noise explained", secondary: "A walkthrough" },
      ],
    },
    {
      kind: "decision", id: "sandbox:ask", source: "sandbox", title: "Publish the sandbox build?", intent: "inspect",
      blocking: "turn", message: "Nothing is published; this only shows a card.",
      fields: [
        { id: "confirm", label: "Publish the sandbox build?", type: "confirm" },
        { id: "why", label: "Tell the sandbox why", type: "longtext" },
      ],
      rejection: { label: "No", field: "why" },
    },
  ];
}

const stop = async () => {
  await host.close();
  provider.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
