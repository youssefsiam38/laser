/**
 * A test never inherits the engine's directories or a real provider credential.
 *
 * The incident: `stable-sdk.agent.test.ts`'s "keeps no-signal candidate and
 * ordinary questions hydratable before acceptance" failed on a developer
 * machine and passed in CI. Two things in a shell started from inside the app
 * reach into a sandboxed session:
 *
 *   - `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`, which the pinned
 *     engine resolves parts of a session from rather than from the `agentDir`
 *     the driver passes;
 *   - every provider credential the engine reads straight from the
 *     environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, … — its own `--help`
 *     lists forty of them).
 *
 * With a key in the environment the session resolved to a real provider and
 * model (`openai/gpt-5.5` here) instead of the test's stub, so the assertion on
 * the stub's request count failed. That is a false failure *and* a real
 * request, billed to whoever ran the suite. Stripping both classes before any
 * test module loads makes the sandbox a sandbox.
 *
 * A test that wants any of these sets it itself, to its own sandbox or stub.
 */

/** Every variable the pinned engine reads as a credential or a directory. */
const ENGINE_PATTERNS = [
  // The engine's own namespace: both agent directories, offline and package
  // overrides, an inherited session file. None of ours starts with `PI_`.
  /^PI_/,
  // Provider credentials, by the shapes the engine's list uses.
  /_API_KEY$/,
  /_AUTH_TOKEN$/,
  /_OAUTH_TOKEN$/,
];

/** Named individually because they carry no credential-shaped suffix. */
const ENGINE_NAMES = [
  "ANTHROPIC_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "AZURE_OPENAI_RESOURCE_NAME",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "OPENAI_BASE_URL",
];

for (const name of Object.keys(process.env)) {
  if (ENGINE_PATTERNS.some((pattern) => pattern.test(name)) || ENGINE_NAMES.includes(name)) delete process.env[name];
}
