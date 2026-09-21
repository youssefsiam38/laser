# @lasercode/protocol

The wire contract. ACP-shaped JSON-RPC messages, types, zod schemas and the
product identity constants every other package imports instead of hard-coding
a name.

- Imports nothing from Pi, and nothing from any other workspace package.
- A new capability is added here first, with a schema and a round-trip sample,
  then implemented elsewhere.
- Shared display projections for search live here too, so the host and the UI
  agree on what a tool's searchable content is.
