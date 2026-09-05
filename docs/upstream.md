# Upstream contributions log

Every PR or issue filed against an upstream project, with its status. Keep PRs
small and self-contained (`AGENTS.md` §6).

| Project | Change | Task | URL | Status |
| --- | --- | --- | --- | --- |
| pi-subagents | export `requestAsyncSteer` / `requestAsyncInterrupt` from `./control-channel` | M3-T9 | — | not filed |
| pi-subagents | emit `workflowGraph` snapshot from scripted workflows | M3-T9 | — | not filed |
| pi-subagents | live index of running foreground children | M3-T9 | — | not filed |
| pi-subagents | guard `ctx.ui.custom()` call sites on `ctx.mode === "tui"` so RPC hosts get the `select` fallback | M3-T9 | — | not filed |
| pi-gpt-transcribe | non-tui entry point for hosts that provide the widget contract | M8-T2 | — | not filed |
| earendil-works/pi | `dist/main.js` → `dist/experimental/server.js` imports `@earendil-works/pi-server`, undeclared in `package.json`; resolves only under npm's flat hoisting, fails under pnpm/strict installers with ERR_MODULE_NOT_FOUND. Fix: declare the dependency (or lazy-import the experimental server). Local workaround: `packageExtensions` in `pnpm-workspace.yaml`. | M0-T4 | — | not filed |
