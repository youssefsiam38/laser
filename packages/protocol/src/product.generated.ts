/**
 * GENERATED from product.json by `pnpm identity:generate`. Do not edit.
 *
 * `pnpm identity:check` runs inside `pnpm -r build` and `pnpm -r test` and
 * fails if this file and product.json disagree, so an edit here is caught
 * rather than shipped. The derived constants every package imports live next
 * door in `identity.ts`; this file holds only what product.json said.
 */

export const PRODUCT = {
  "name": "piorbit",
  "displayName": "piorbit",
  "appId": "dev.piorbit.desktop",
  "developerId": "dev.piorbit",
  "urlScheme": "piorbit",
  "wireNamespace": "piorbit",
  "envPrefix": "PIORBIT",
  "dirName": "piorbit",
  "storagePrefix": "piorbit",
  "symbolPrefix": "piorbit",
  "binary": "piorbit",
  "realBinary": "piorbit-bin",
  "repository": "youssefsiam38/piorbit",
  "homepage": "https://github.com/youssefsiam38/piorbit",
  "issuesUrl": "https://github.com/youssefsiam38/piorbit/issues",
  "vendor": "piorbit contributors",
  "copy": {
    "summary": "A control room for coding agents",
    "description": "Runs coding agent sessions across every project on this machine, and mirrors them to your phone.",
    "descriptionMore": "Everything is configured inside the window: providers, models, extensions and projects. piorbit brings its own runtime and its own agent, so there is nothing to install first and nothing on your machine for it to disagree with.",
    "descriptionRelay": "The phone is not a second application. It is the same interface, reached over an end-to-end encrypted relay that piorbit runs itself, so a session left on the desktop is the session picked up on the train.",
    "webDescription": "Your coding agents, from anywhere. Answer approvals, steer runs, watch every project."
  },
  "desktopFileName": "piorbit.desktop",
  "metainfoFileName": "dev.piorbit.desktop.metainfo.xml",
  "formerNames": []
} as const;

/**
 * Every environment variable the product reads, by its unprefixed name.
 *
 * Emitted rather than composed at runtime so that the full name is a literal
 * type: `ENV.agentDir` is `"PIORBIT_AGENT_DIR"`, and a typo is a compile error
 * rather than a variable nobody sets.
 */
export const ENV = {
  "agentDir": "PIORBIT_AGENT_DIR",
  "allowedOrigins": "PIORBIT_ALLOWED_ORIGINS",
  "arch": "PIORBIT_ARCH",
  "debug": "PIORBIT_DEBUG",
  "disableSandbox": "PIORBIT_DISABLE_SANDBOX",
  "extensionName": "PIORBIT_EXTENSION_NAME",
  "home": "PIORBIT_HOME",
  "node": "PIORBIT_NODE",
  "nodeMirror": "PIORBIT_NODE_MIRROR",
  "npmCli": "PIORBIT_NPM_CLI",
  "npmCommand": "PIORBIT_NPM_COMMAND",
  "port": "PIORBIT_PORT",
  "releaseKey": "PIORBIT_RELEASE_KEY",
  "releaseKeyPem": "PIORBIT_RELEASE_KEY_PEM",
  "repo": "PIORBIT_REPO",
  "scratch": "PIORBIT_SCRATCH",
  "screenshotBaseUrl": "PIORBIT_SCREENSHOT_BASE_URL",
  "sessionDir": "PIORBIT_SESSION_DIR",
  "stateDir": "PIORBIT_STATE_DIR",
  "subagentsTempRoot": "PIORBIT_SUBAGENTS_TEMP_ROOT",
  "tag": "PIORBIT_TAG",
  "uiUrl": "PIORBIT_UI_URL",
  "workerFd": "PIORBIT_WORKER_FD",
  "azureAccount": "PIORBIT_AZURE_ACCOUNT",
  "azureEndpoint": "PIORBIT_AZURE_ENDPOINT",
  "azureProfile": "PIORBIT_AZURE_PROFILE",
  "azurePublisherName": "PIORBIT_AZURE_PUBLISHER_NAME"
} as const;

export type Product = typeof PRODUCT;
export type EnvName = keyof typeof ENV;
