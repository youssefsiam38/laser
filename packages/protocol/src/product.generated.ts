/**
 * GENERATED from product.json by `pnpm identity:generate`. Do not edit.
 *
 * `pnpm identity:check` runs inside `pnpm -r build` and `pnpm -r test` and
 * fails if this file and product.json disagree, so an edit here is caught
 * rather than shipped. The derived constants every package imports live next
 * door in `identity.ts`; this file holds only what product.json said.
 */

export const PRODUCT = {
  "name": "laser",
  "displayName": "Laser",
  "appId": "com.hubtrix.laser",
  "developerId": "com.hubtrix",
  "urlScheme": "lasercode",
  "wireNamespace": "lasercode",
  "envPrefix": "LASERCODE",
  "dirName": "lasercode",
  "storagePrefix": "lasercode",
  "symbolPrefix": "lasercode",
  "binary": "laser",
  "realBinary": "laser-bin",
  "repository": "youssefsiam38/laser",
  "homepage": "https://github.com/youssefsiam38/laser",
  "issuesUrl": "https://github.com/youssefsiam38/laser/issues",
  "vendor": "Laser contributors",
  "copy": {
    "summary": "A control room for coding agents",
    "description": "Runs coding agent sessions across every project on this machine, and mirrors them to your phone.",
    "descriptionMore": "Everything is configured inside the window: providers, models, extensions and projects. Laser brings its own runtime and its own agent, so there is nothing to install first and nothing on your machine for it to disagree with.",
    "descriptionRelay": "The phone is not a second application. It is the same interface, reached over an end-to-end encrypted relay that Laser runs itself, so a session left on the desktop is the session picked up on the train.",
    "webDescription": "Your coding agents, from anywhere. Answer approvals, steer runs, watch every project."
  },
  "desktopFileName": "laser.desktop",
  "metainfoFileName": "com.hubtrix.laser.metainfo.xml",
  "formerNames": []
} as const;

/**
 * Every environment variable the product reads, by its unprefixed name.
 *
 * Emitted rather than composed at runtime so that the full name is a literal
 * type: `ENV.agentDir` is `"LASERCODE_AGENT_DIR"`, and a typo is a compile error
 * rather than a variable nobody sets.
 */
export const ENV = {
  "agentDir": "LASERCODE_AGENT_DIR",
  "allowedOrigins": "LASERCODE_ALLOWED_ORIGINS",
  "arch": "LASERCODE_ARCH",
  "debug": "LASERCODE_DEBUG",
  "disableSandbox": "LASERCODE_DISABLE_SANDBOX",
  "extensionName": "LASERCODE_EXTENSION_NAME",
  "home": "LASERCODE_HOME",
  "node": "LASERCODE_NODE",
  "nodeMirror": "LASERCODE_NODE_MIRROR",
  "npmCli": "LASERCODE_NPM_CLI",
  "npmCommand": "LASERCODE_NPM_COMMAND",
  "port": "LASERCODE_PORT",
  "releaseKey": "LASERCODE_RELEASE_KEY",
  "releaseKeyPem": "LASERCODE_RELEASE_KEY_PEM",
  "repo": "LASERCODE_REPO",
  "scratch": "LASERCODE_SCRATCH",
  "screenshotBaseUrl": "LASERCODE_SCREENSHOT_BASE_URL",
  "sessionDir": "LASERCODE_SESSION_DIR",
  "stateDir": "LASERCODE_STATE_DIR",
  "subagentsTempRoot": "LASERCODE_SUBAGENTS_TEMP_ROOT",
  "tag": "LASERCODE_TAG",
  "uiUrl": "LASERCODE_UI_URL",
  "workerFd": "LASERCODE_WORKER_FD",
  "azureAccount": "LASERCODE_AZURE_ACCOUNT",
  "azureEndpoint": "LASERCODE_AZURE_ENDPOINT",
  "azureProfile": "LASERCODE_AZURE_PROFILE",
  "azurePublisherName": "LASERCODE_AZURE_PUBLISHER_NAME"
} as const;

export type Product = typeof PRODUCT;
export type EnvName = keyof typeof ENV;
