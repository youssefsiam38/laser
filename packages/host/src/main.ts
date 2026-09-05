#!/usr/bin/env node
/**
 * Host entry. Args: [--port N] [--agent-dir D] [--session-dir D] [--ui-dir D]
 */
import { HostServer } from "./server.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const port = arg("port");
const agentDir = arg("agent-dir");
const sessionDir = arg("session-dir");
const uiDir = arg("ui-dir");

const server = new HostServer({
  ...(port ? { port: Number(port) } : { port: 41_441 }),
  ...(agentDir ? { agentDir } : {}),
  ...(sessionDir ? { sessionDir } : {}),
  ...(uiDir ? { uiDir } : {}),
  log: (line) => console.error(line),
});

server.listen().then(({ url }) => console.log(url));

const shutdown = () => void server.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
