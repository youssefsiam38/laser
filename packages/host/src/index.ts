/**
 * @piorbit/host (M1-T1, M2-T1)
 *
 * Responsibilities:
 *  - WorkerPool: spawn `piorbit-worker` per project cwd from the bundled Node;
 *    never two per cwd; restart on crash; retire when idle with no attachment
 *    and no background subagent run referencing the session.
 *  - Router: JSON-RPC between UI clients (local WebSocket on 127.0.0.1, or the
 *    relay) and workers; assigns per-session `seq`; buffers updates for resume.
 *  - SessionCatalog: cached scan of ~/.pi/agent/sessions (M1-T2).
 *  - Subagents file layer: watches pi-subagents' on-disk state for every
 *    session, including terminal-started ones (M3-T2..T4).
 *  - LogStore: SQLite for provider round-trips and events (M4-T5).
 *  - RelayClient: outbound-only encrypted channel (M6-T5).
 *
 * This package must not import Pi. It talks to workers only through @piorbit/protocol.
 */
export const HOST_DEFAULT_PORT = 41_441;
export const HOST_BIND_ADDRESS = "127.0.0.1";
export * from "./subagents/file-layer.js";
