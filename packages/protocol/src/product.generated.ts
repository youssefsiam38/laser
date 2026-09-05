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
  "urlScheme": "laser",
  "wireNamespace": "piorbit",
  "envPrefix": "LASER",
  "dirName": "laser",
  "storagePrefix": "laser",
  "symbolPrefix": "laser",
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
  "formerNames": [
    {
      "name": "piorbit",
      "dirName": "piorbit",
      "storagePrefix": "piorbit",
      "envPrefix": "PIORBIT",
      "symbolPrefix": "piorbit",
      "urlScheme": "piorbit"
    }
  ]
} as const;

/**
 * Every environment variable the product reads, by its unprefixed name.
 *
 * Emitted rather than composed at runtime so that the full name is a literal
 * type: `ENV.agentDir` is `"LASER_AGENT_DIR"`, and a typo is a compile error
 * rather than a variable nobody sets.
 */
export const ENV = {
  "agentDir": "LASER_AGENT_DIR",
  "allowedOrigins": "LASER_ALLOWED_ORIGINS",
  "arch": "LASER_ARCH",
  "debug": "LASER_DEBUG",
  "disableSandbox": "LASER_DISABLE_SANDBOX",
  "extensionName": "LASER_EXTENSION_NAME",
  "home": "LASER_HOME",
  "node": "LASER_NODE",
  "nodeMirror": "LASER_NODE_MIRROR",
  "npmCli": "LASER_NPM_CLI",
  "npmCommand": "LASER_NPM_COMMAND",
  "port": "LASER_PORT",
  "releaseKey": "LASER_RELEASE_KEY",
  "releaseKeyPem": "LASER_RELEASE_KEY_PEM",
  "repo": "LASER_REPO",
  "scratch": "LASER_SCRATCH",
  "screenshotBaseUrl": "LASER_SCREENSHOT_BASE_URL",
  "sessionDir": "LASER_SESSION_DIR",
  "stateDir": "LASER_STATE_DIR",
  "subagentsTempRoot": "LASER_SUBAGENTS_TEMP_ROOT",
  "tag": "LASER_TAG",
  "uiUrl": "LASER_UI_URL",
  "workerFd": "LASER_WORKER_FD",
  "azureAccount": "LASER_AZURE_ACCOUNT",
  "azureEndpoint": "LASER_AZURE_ENDPOINT",
  "azureProfile": "LASER_AZURE_PROFILE",
  "azurePublisherName": "LASER_AZURE_PUBLISHER_NAME"
} as const;

export type Product = typeof PRODUCT;
export type EnvName = keyof typeof ENV;
