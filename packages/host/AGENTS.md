# @lasercode/host

The supervisor. One worker per project, the session catalog, the local
WebSocket the UI speaks, the relay client, the log store, saved-history search
and the agent run registry.

- Must not import Pi. It only resolves the worker's entry path.
- The catalog watcher parses JSON, so sessions started elsewhere stay visible
  without a worker running.
