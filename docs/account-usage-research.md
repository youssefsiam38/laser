# OpenAI Codex allowance: verified failure and repair

Research date: 2026-09-07. The original diagnosis below is preserved; the authorized repair is implemented for 0.2.7.

## Implementation and verification

- The companion extension now queries `/backend-api/wham/usage` directly using Pi-owned credentials. No additional CLI, auth store or OAuth owner was introduced.
- Named allowance buckets retain their identity, duration and reset time; the telemetry cards label them separately. Missing windows are not displayed as zero and bucket percentages are never summed.
- Security challenges, rejected authentication, permission failures, rate limits, network failures and malformed responses have distinct recovery messages. Failed refresh preserves the last good snapshot. Response size is bounded while streaming; credentials and raw responses never leave the module.
- Endpoint-exact tests cover the observed response shape, multiple buckets, null windows, the official `windowDurationMins` vocabulary and failure/retry behavior.
- The rebuilt module succeeded twice with this machine's existing Laser credential (initial fetch and manual refresh): HTTP 200, four windows across three buckets, with durations and resets. No login, credential writes or model inference were performed.
- `pnpm verify` passed build, typecheck and 979 tests. Actual quota cards were reviewed at desktop and phone widths in both themes without horizontal overflow.

The direct endpoint remains an undocumented maintenance boundary; successful live verification is not a promise that OpenAI will keep that route stable.

## Confirmed failure

Using this machine's existing, unexpired Laser OpenAI Codex credential, with
no login, token refresh, inference, or credential writes:

| Probe | Result |
| --- | --- |
| Current first URL, `https://chatgpt.com/backend-api/codex/usage` | HTTP 403; `text/html`; `cf-mitigated: challenge`; security-challenge page |
| `https://chatgpt.com/backend-api/wham/usage`, identical credential and headers | HTTP 200; JSON with `rate_limit`, `additional_rate_limits`, `credits` and related fields |
| Installed account-usage module, supplied the same credential through its registry interface | Emitted `unavailable` and exactly `Reconnect your OpenAI account to refresh its allowance.`; made only the first URL request |
| Working URL with just bearer, account-id and Accept headers | HTTP 200; existing installed parser accepts the main window, duration and reset time |

Only response status, shape and diagnostic booleans were printed. Tokens,
account identifiers, email and raw response bodies were not recorded.

The current implementation returns immediately on 403 and only advances after
404 or an exception. It mistakes a security challenge on the first route for
invalid authentication. Reconnecting repeats the same failing route. This is
confirmed on this machine; other users' responses have not been inspected.

Relevant implementation: `packages/pi-extension/src/modules/account-usage.ts`,
endpoint list and HTTP error branch. The native installed package contains the
same logic. This failure is distinct from the earlier old-daemon unknown-method
failure.

## Official integration

OpenAI documents the local Codex app-server JSON-RPC method
`account/rateLimits/read`, and `account/rateLimits/updated` notifications:
<https://learn.chatgpt.com/docs/app-server#auth-endpoints>.

It returns `rateLimits` and, when present, `rateLimitsByLimitId`. The multi-bucket
representation is the useful one for accounts with separate allowances. Windows
have `usedPercent`, `windowDurationMins`, and Unix-seconds `resetsAt`; plan,
credits and other details can be absent. Subscription allowance is not a token
sum or a universal monetary credit balance.

An integration can supply Laser-owned credentials through `account/login/start`
with `type: chatgptAuthTokens`, access token and account id. This is explicitly
experimental and needs `capabilities.experimentalApi: true` at initialization.
The host must handle `account/chatgptAuthTokens/refresh`; do not establish a
second independent owner of rotating refresh tokens.

The installed local CLI is 0.151.0 and advertises `app-server --listen stdio://`.
No app-server was started in this investigation, so successful token injection
into that alternative has not been claimed. No documented public REST contract
for the two web URLs was located. The direct working endpoint is live evidence,
not a guarantee of a stable third-party API.

Pi 0.85.0's installed `openaiCodexOAuth.toAuth` returns the OAuth access token as
`apiKey`; the model registry forwards it. The access-token/account-id assumption
matches this installed engine and this machine's credentials. The failure here
is not a JSON-wrapped credential or a missing account id.

## Additional gaps

- The real response has two additional allowance buckets; the protocol and
  parser currently represent only the selected primary/secondary windows.
- The parser claims app-server-shaped support but reads `windowMinutes`, not
  the documented `windowDurationMins`; a source-shaped diagnostic loses duration.
- The happy-path tests mock every URL as successful and only assert that URLs
  end with `/usage`. They therefore cannot catch a wrong route. The camel-case
  fixture also uses the same incorrect field name as the parser.
- 401, HTML/security-challenge 403, JSON permission errors, timeouts, rate limits
  and provider failures need different recovery messages. A generic reconnect
  instruction is not evidence that reconnecting will help.

## Original recommended repair (now implemented)

1. Use the verified `/backend-api/wham/usage` route directly in the existing
   worker-confined integration. Remove the unverified first-route assumption;
   do not add browser challenge workarounds or scrape terminal output.
2. Keep Pi responsible for OAuth. Only request reconnection after an actual
   unrecoverable authentication failure; distinguish service/network/permission
   failures and preserve the last good reading with its age.
3. Normalize named quota buckets explicitly and retain their identifiers, window
   durations and resets. Never add their percentages, infer missing data as zero,
   or sum account snapshots from main agents and subagents.
4. Add endpoint-exact tests, sanitized real-response fixtures, challenge/401/
   timeout/429 cases, additional buckets, unavailable/null windows and correct
   app-server vocabulary. Verify the installed integration with an authenticated
   read-only smoke check before claiming the allowance feature works.

The alternative is a bundled, pinned Codex app-server behind the same neutral
account-usage interface. That gives an officially documented RPC boundary but
adds a native binary, subprocess lifecycle and external-token integration. Do
not silently depend on a user's global CLI or its possibly different account.
For this confirmed defect, the direct repair is smaller and preserves the Pi
architecture. Reconsider the app-server approach if direct endpoint maintenance
becomes a recurring burden.
