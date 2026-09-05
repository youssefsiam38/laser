#!/usr/bin/env node
/**
 * Sandboxed demo environment: a temp Pi agent dir with a fake streaming
 * provider, and the host serving the built UI. Never touches ~/.pi/agent.
 *
 *   pnpm sandbox            # http://127.0.0.1:41441
 *   PORT=5000 pnpm sandbox
 *
 * The fake provider ("stub/stub-1") echoes a short markdown reply with a code
 * fence so streaming, markdown, and tool-free turns can be exercised.
 * Requires `pnpm -r build` first.
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostServer } from "@piorbit/host";

const PORT = Number(process.env.PORT ?? 41441);
const base = mkdtempSync(join(tmpdir(), "piorbit-sandbox-"));
const project = join(base, "project");
const agentDir = join(base, "agent");
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(project, "README.md"), "# Sandbox project\n\nA scratch project for piorbit demos.\n");

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
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "stub", defaultModel: "stub-1", theme: "dark" }, null, 2));

// ---- a tiny extension that exercises every portable UI surface ----
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "sandbox-dialogs.ts"),
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
}
`,
);

// ---- host ----
// `stateDir` keeps the sandbox's projects, attention and log store inside the
// temp dir; without it a demo run would write to the real ~/.piorbit.
const host = new HostServer({
  port: PORT,
  agentDir,
  sessionDir: join(base, "sessions"),
  stateDir: join(base, "state"),
  log: (l) => console.error(l),
});
const { url } = await host.listen();
console.log(`piorbit sandbox\n  ui:       ${url}\n  project:  ${project}\n  agentDir: ${agentDir}\n  provider: ${providerUrl}`);

const stop = async () => {
  await host.close();
  provider.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
