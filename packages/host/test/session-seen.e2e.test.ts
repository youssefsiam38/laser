import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { PRODUCT_NAME } from "@lasercode/protocol";
import { HostServer } from "../src/server.js";
import { HostLink } from "../../desktop/src/host-link.js";
import type { DesktopLog } from "../../desktop/src/log.js";

it("delivers a real seen request to the independent desktop listener without starting a worker", async () => {
  const dir = mkdtempSync(join(tmpdir(), `${PRODUCT_NAME}-seen-`));
  const host = new HostServer({ agentDir: join(dir, "agent"), sessionDir: join(dir, "sessions"), stateDir: join(dir, "state"), logFile: false });
  const seen = vi.fn(), snapshots = vi.fn();
  const link = new HostLink({ log: { error: vi.fn(), line: vi.fn() } as unknown as DesktopLog,
    onAttention: vi.fn(), onSnapshot: snapshots, onSeen: seen });
  let client: WebSocket | undefined;
  try {
    const { url } = await host.listen();
    const wsUrl = `${url.replace("http", "ws")}/ws`;
    link.connect(wsUrl);
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalled());
    client = new WebSocket(wsUrl);
    await new Promise<void>(resolve => client!.once("open", resolve));
    client.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "pi/session/seen", params: { path: "/session/a.jsonl", seq: 4 } }));
    await vi.waitFor(() => expect(seen).toHaveBeenCalledWith("/session/a.jsonl"));
    expect(link.snapshot().running).toBe(0);
  } finally {
    client?.terminate(); link.close(); await host.close(); rmSync(dir, { recursive: true, force: true });
  }
});
