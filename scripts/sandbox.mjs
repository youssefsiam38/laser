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
 *
 * Opt-in scenes, each keyed by an environment variable:
 *
 *   SANDBOX_GOAL=1      a prompt carrying a `<goal_id>` ends through the goal
 *                       completion tool with no assistant text (the durable
 *                       summary regression, AGENTS.md §6a).
 *   SANDBOX_ACTIVITY=1  the exact prompt "sandbox activity" streams reasoning,
 *                       then runs a 30 s command so partial output is visible.
 *   SANDBOX_AGENTS=1    the agent harness (docs/agents.md). A prompt containing
 *                       the word "delegate" answers with one `start_agent` call
 *                       (agent `default`, instance `explorer`). A request that
 *                       is a subagent child — its tool list carries
 *                       `complete_agent_run`, or its system prompt names the
 *                       subagent role — answers `bash ls`, then, once that
 *                       result is back, `complete_agent_run` with
 *                       "Counted the files.". Everything else in this scene is
 *                       one short text. The sandbox project is a git repository
 *                       with one commit so a child gets a real worktree. A
 *                       prompt containing both "delegate" and "review" starts
 *                       the child with `worktree: false` instead, so the
 *                       shared-checkout path is demonstrable too.
 */
import { identity as product } from "./identity/identity.mjs";
import { execFileSync } from "node:child_process";
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
writeFileSync(join(project, "notes.txt"), "one\ntwo\nthree\n");

// The project is a git repository with one commit. Subagent children are
// mandatory worktrees under <project>/.worktrees (D-140), and a worktree needs
// a commit to branch from; a bare directory would make every `start_agent`
// a person-facing refusal instead of a demo.
try {
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Sandbox", "-c", "user.email=sandbox@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "Sandbox project");
} catch (error) {
  console.error(`sandbox: could not initialise a git repository in ${project}; subagent worktrees will be refused (${error instanceof Error ? error.message : String(error)})`);
}
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
const textOf = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text ?? "").join("") : "";

/** The function name behind the most recent tool result, or undefined. */
function lastToolName(msgs) {
  const result = [...msgs].reverse().find((m) => m?.role === "tool");
  if (!result) return undefined;
  for (const m of msgs) {
    for (const call of m?.tool_calls ?? []) {
      if (call?.id === result.tool_call_id) return call.function?.name;
    }
  }
  return undefined;
}

const provider = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const request = JSON.parse(body);
    const msgs = request.messages ?? [];
    const last = msgs.at(-1)?.content;
    const prompt = textOf(last);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: "c", object: "chat.completion.chunk", created: 1, model: "stub-1" };
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    const callTool = (name, args) => {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: {
        name, arguments: JSON.stringify(args),
      } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      res.end("data: [DONE]\n\n");
    };
    const sayShort = async (text) => {
      for (const ch of text.match(/.{1,6}/gs) ?? []) {
        send({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] });
        await new Promise((r) => setTimeout(r, 25));
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
      res.end("data: [DONE]\n\n");
    };
    // Agents scene (docs/agents.md). The parent delegates once; a child lists
    // the directory and ends through `complete_agent_run`, the only successful
    // ending the harness accepts. Child detection prefers the tool list — the
    // harness registers `complete_agent_run` only in a child — and falls back
    // to the role block the companion extension injects into a child's system
    // prompt. A parent's own tool schema mentions `subagent_name`, so text
    // alone would misfire; the fallback therefore also requires `start_agent`
    // to be absent.
    if (process.env.SANDBOX_AGENTS === "1") {
      const lastRole = msgs.at(-1)?.role;
      const toolNames = (request.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter((n) => typeof n === "string");
      const systemText = msgs.filter((m) => m?.role === "system").map((m) => textOf(m.content)).join("\n");
      const isChild = toolNames.includes("complete_agent_run") || (/subagent/i.test(systemText) && !toolNames.includes("start_agent"));
      const previousTool = lastToolName(msgs);
      if (isChild) {
        if (lastRole === "tool" && previousTool === "bash") return callTool("complete_agent_run", { status: "completed", message: "Counted the files." });
        if (lastRole === "tool") return sayShort("Done.");
        return callTool("bash", { command: "ls" });
      }
      if (lastRole === "user" && /\bdelegate\b/i.test(prompt)) {
        // "delegate a review" takes the other path: a child the parent judged
        // read-only, started with `worktree: false`, which runs in the
        // parent's own checkout and has no branch of its own.
        return /\breview\b/i.test(prompt)
          ? callTool("start_agent", { agent_name: "default", subagent_name: "reviewer", task: "Read the notes and report what is in them.", worktree: false })
          : callTool("start_agent", { agent_name: "default", subagent_name: "explorer", task: "List the files here and report the count." });
      }
      if (lastRole === "tool" && previousTool === "start_agent") return sayShort("Started **explorer** in the background. I will report when it finishes.");
      if (lastRole === "tool") return sayShort("Noted the result.");
      if (/explorer|counted/i.test(prompt)) return sayShort("The explorer finished: it counted the files.");
      return sayShort("Noted. Say **delegate** to start a subagent.");
    }
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

  // Questions are the only thing an extension can ask a person, and they are
  // answered inline in the transcript (docs/ux-fleet.md, "Questions").
  pi.registerCommand("ask", {
    description: "sandbox: ask a select inline",
    handler: async (args, ctx) => {
      const answer = await ctx.ui.select("Which branch?", ["main", "next", "always allow"]);
      ctx.ui.notify(answer ? "picked " + answer : "cancelled", "info");
    },
  });
}
`,
);

// ---- host ----
// `stateDir` keeps the sandbox's projects, attention and log store inside the
// temp dir; without it a demo run would write to the real ~/.laser.
const sessionDir = join(base, "sessions");
const stateDir = join(base, "state");
const host = new HostServer({
  port: PORT,
  agentDir,
  sessionDir,
  stateDir,
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
  startedAt: new Date().toISOString(),
  cliVersion: "sandbox",
  ...(identity ? { identity } : {}),
});

console.log(
  `${product.name} sandbox\n  ui:       ${url}\n  project:  ${project}\n  agentDir: ${agentDir}\n  stateDir: ${stateDir}\n  provider: ${providerUrl}\n` +
    `  cli:      ${product.env.stateDir}=${stateDir} ${product.env.agentDir}=${agentDir} ${product.binary} status`,
);

// ---- demo background work, seeded from the host ----
//
// The fleet's two kinds of work come from two typed sources: the harness
// publishes `agents/run`, and the companion's background-work module publishes
// `lasercode/task/update`. Pi 0.85 builds a session's extension set from its
// package manager, so a bare path in `settings.extensions` is not enough to
// load the demo extension and the fleet would be empty. Seeding the host's own
// task register keeps the sandbox honest — same register, same broadcast, same
// rows a client would receive — and the commands say `sandbox` so nobody
// mistakes them for something that ran.
const taskLog = join(stateDir, "sandbox-task.log");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  taskLog,
  [
    "  VITE v7.1.0  ready in 412 ms",
    "",
    "  \u001b[32m\u2192\u001b[0m  Local:   http://localhost:5173/",
    "  \u001b[32m\u2192\u001b[0m  Network: http://192.168.1.24:5173/",
    "",
    "10:04:12 [vite] page reload src/App.tsx",
    "10:04:31 [vite] hmr update src/routes/index.tsx",
    "",
  ].join("\n"),
);

const seeded = new Set();
setInterval(() => {
  if (process.env.SANDBOX_GOAL === "1") return;
  for (const worker of host.pool.workers()) {
    for (const path of host.pool.openSessions(worker.cwd)) {
      if (seeded.has(path)) continue;
      seeded.add(path);
      for (const task of demoTasks(path)) host.tasks.upsert(path, task, taskLog);
      // A live one keeps growing, so the column has something that moves.
      let bytes = 240;
      const timer = setInterval(() => {
        bytes += 37;
        host.tasks.upsert(
          path,
          { ...demoTasks(path)[0], outputBytes: bytes, activity: `page reload ${Math.round(bytes / 37)} · 12 ms` },
          taskLog,
        );
      }, 2000);
      timer.unref();
    }
  }
}, 1000).unref();

function demoTasks(sessionPath) {
  const now = Date.now();
  return [
    {
      id: "t-sandbox-dev",
      sessionPath,
      command: "pnpm vite dev --host --port 5173",
      title: "pnpm vite dev --host --port 5173",
      status: "running",
      origin: "background",
      startedAt: new Date(now - 42_000).toISOString(),
      outputBytes: 240,
      activity: "ready in 412 ms · http://localhost:5173",
    },
    {
      id: "t-sandbox-test",
      sessionPath,
      command: "pnpm -r test",
      title: "pnpm -r test",
      status: "failed",
      origin: "promoted",
      startedAt: new Date(now - 300_000).toISOString(),
      endedAt: new Date(now - 120_000).toISOString(),
      exitCode: 1,
      outputBytes: 4096,
      terminalReason: "exit code 1",
      activity: "1 failed | 660 passed (661)",
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
