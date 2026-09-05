/**
 * Electron main (M5-T1). Decisions already fixed:
 *  - spawn the host from a bundled stock Node binary unpacked outside asar (not Electron's Node,
 *    not utilityProcess): keeps process.execPath a real `node` for MCP stdio children and npx.
 *  - runAsNode fuse off; asarUnpack for anything spawned or dlopen'ed.
 *  - root identity key and relay tokens in the OS keychain via @napi-rs/keyring (M5-T3).
 */
export {};
