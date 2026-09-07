# Built-in web search

Web search is an opt-in built-in feature. Settings → Features controls its
global/project availability; Settings → Providers and models → Web search
owns connections and the selected provider. Disabling it preserves connections.
Changing availability uses the existing project restart boundary; busy projects
report the pending restart rather than interrupting a turn. Connection changes
apply to the next search, including searches in an already-open session.

## Engine and provider coverage

The worker pins `pi-web-access@0.28.0` and bundles its exported `search()` API,
including its dependencies, at build time. There is no runtime download or
transpiler requirement. The catalog is tested against all 29 upstream IDs:
OpenAI, Brave, Parallel, Parallel MCP, TinyFish, Search1API, Searchinfinity,
Querit, Tavily, Firecrawl, Jina, SearXNG, DuckDuckGo, Perplexity, Google Gemini,
Kimi, Exa, SerpDive, Kagi, Ollama, AnySearch, xAI, Mistral, Bright Data, SerpBase,
Serper, Valyu, Bocha and XCrawl.

One explicit provider handles each request. The model cannot override it,
enable fallback or broadcast a query to every connected account. Results stay
in the existing transcript disclosure (D-61); no duplicate results panel.
The `web-access` module of the single companion extension registers the tool
during factory setup. The worker injects its credential-aware executor only
when Web search is enabled; registration failures remain module-local.

## Credentials and permission

- Shared OpenAI API/Codex, Google API, Kimi Coding, xAI and Mistral connections
  require an explicit **Allow, test and use** action. The engine resolves the
  existing credential afresh for each call, including OAuth refresh. Only the
  selected provider's model/auth snapshot crosses into the search runner.
- Search-only keys are literal, write-only fields. The worker stores them with
  connection policy in `<agentDir>/search-connections.json`, using cross-process
  locking, atomic replacement and user-only file permissions. No keys enter
  generic preferences, status responses, model messages or error output.
- Revoking search access does not sign the model provider out. Removing a
  search-only key does not delete a shared credential.
- DuckDuckGo and Parallel MCP need no key; Exa and AnySearch offer optional
  keys. SearXNG requires an explicit instance URL; Bright Data also needs a
  SERP zone. Kimi needs Coding Plan credentials, not Moonshot API credentials.
- Activating any connection (including a free provider) performs one real search
  before atomically saving it as the only selected provider. A failed probe keeps
  the previous selection and credentials unchanged. Saved inactive credentials
  are never a fallback. Turning the feature on also tests the selected connection;
  turning it off makes no provider call and preserves credentials. The UI warns
  that probes may incur provider charges.
- OpenAI API and Codex use separate upstream endpoints with only the explicitly
  granted connection. Both routes passed bounded live search verification for
  M12-T68; endpoint-shaped regression tests remain offline.

## Isolation and boundaries

Each invocation gets a fresh worker thread, module cache, private environment
and temporary configuration directory. Only the selected credential is supplied;
no ambient provider keys, ADC files, `.pi` configuration or proxy credentials
are inherited. Secrets remain in memory during execution, not the temporary
configuration. Four searches may run concurrently. Cancellation/timeout
terminates the thread and removes its temporary directory. Results are bounded
and credentials are redacted before a result crosses back into the transcript.

The build replaces upstream's optional Gemini browser-cookie module with an
unavailable adapter. Browser cookies, automatic browser launch, terminal setup
commands, Google ADC and upstream's interactive curator are deliberately not
product authentication paths. Gemini uses its API; Codex/xAI subscriptions use
the existing explicit model connection. This covers every search provider, not
every upstream terminal/browser authentication mode.

The exact-pinned DuckDuckGo module carries a small local patch distinguishing
an explicit empty-results page from a bot-verification page. Challenges are
reported, never bypassed. Errors name the selected provider and safe HTTP status
or failure category without including response bodies or credentials.

SearXNG may be self-hosted: only addresses resolved from the configured instance
receive a private-address exception. Upstream still validates DNS and redirects;
there is no blanket private-network allowlist.

## Verification

Protocol schema samples and host routing tests cover both `web-search/status`
and `web-search/configure`. Tests cover credential secrecy, concurrent writes,
consent/revocation, catalog parity, real upstream SearXNG execution and abort.
The host integration proves an enabled session exposes `web_search` to the
model. The packaged-session probe opens a real session with every built-in and
executes search against a local fixture using the bundled runtime with an empty
PATH. External provider accounts are not used by these checks.

Source: https://github.com/nicobailon/pi-web-access
