/**
 * The bridge (M5-T1).
 *
 * This is the only code that runs with both `ipcRenderer` and the page in
 * scope, so it is deliberately tiny and deliberately dumb: it forwards, it
 * never decides. Anything with a policy in it belongs in the main process,
 * where the page cannot reach it.
 *
 * It is CommonJS (`.cts` → `.cjs`) because a sandboxed preload has no ESM
 * loader. Sandboxed is the point: the renderer displays agent output, and a
 * preload with full Node in it would put `child_process` one prototype away
 * from a bug in the markdown renderer.
 *
 * Everything is exposed under one frozen `window.desktop`. The web build of the
 * same UI simply does not have it, so every caller has to check — which is what
 * keeps the browser, the phone and this window on the same code path.
 */
import electron = require("electron");
import type {
  DeepLink,
  DesktopChrome,
  DesktopHostInfo,
  DesktopPlatform,
  IdentitySummary,
  MicrophoneStatus,
  PanelDescriptor,
  PanelWindowDescriptor,
  UpdateStatus,
  WindowChromeState,
} from "./api.js";

const { contextBridge, ipcRenderer } = electron;

/**
 * The channel table, written here by `pnpm identity:generate` from
 * `product.json` — not imported.
 *
 * A sandboxed preload's `require` resolves `electron` and a few Node builtins
 * and nothing else. A relative specifier such as `./ipc.generated.cjs` fails at
 * load time with "module not found", and Electron's response is to skip the
 * preload entirely: the page then loads with no bridge on `window`, so every
 * button that asks the desktop for something does nothing at all and there is
 * nothing on screen to say why. Hence a generated block instead of an import;
 * `pnpm identity:check` fails the build if it drifts from `ipc.generated.ts`.
 */
// <generated: IPC CHANNELS>
const IPC = {
  hostInfo: "laser:host/info",
  hostChanged: "laser:host/changed",
  hostRetry: "laser:host/retry",
  panelPopOut: "laser:panel/pop-out",
  panelClose: "laser:panel/close",
  deepLink: "laser:deep-link",
  deepLinkPending: "laser:deep-link/pending",
  windowMinimize: "laser:window/minimize",
  windowToggleMaximize: "laser:window/toggle-maximize",
  windowClose: "laser:window/close",
  windowState: "laser:window/state",
  windowStateChanged: "laser:window/state-changed",
  themeSet: "laser:theme/set",
  directorySelect: "laser:directory/select",
  sourceFileOpen: "laser:source-file/open",
  microphoneStatus: "laser:microphone/status",
  microphoneRequest: "laser:microphone/request",
  microphoneSettings: "laser:microphone/settings",
  identity: "laser:identity",
  updateStatus: "laser:update/status",
  updateCheck: "laser:update/check",
  updateInstall: "laser:update/install",
  updateChanged: "laser:update/changed",
} as const;
// </generated: IPC CHANNELS>

interface Bootstrap {
  version: string;
  platform: DesktopPlatform;
  chrome: DesktopChrome;
}

/**
 * The two strings this file may not import.
 *
 * A sandboxed preload's `require` resolves only `electron` and a few Node
 * builtins, so `@laser/protocol` is out of reach here. They are name-free for
 * exactly that reason — an internal contract inside one build rather than the
 * product's identity — and `src/api.ts` declares the same two values for
 * everything that *can* import. `test/preload.test.ts` keeps them equal.
 */
const BRIDGE = "desktop";
const ARGUMENT_PREFIX = "--desktop-";

/** Read one `--desktop-<name>=<url-encoded json>` switch out of argv. */
function readArgument<T>(name: string): T | undefined {
  const prefix = `${ARGUMENT_PREFIX}${name}=`;
  for (const argument of process.argv) {
    if (!argument.startsWith(prefix)) continue;
    try {
      return JSON.parse(decodeURIComponent(argument.slice(prefix.length))) as T;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const bootstrap = readArgument<Bootstrap>("env") ?? {
  version: "0.0.0",
  platform: process.platform as DesktopPlatform,
  chrome: { controls: "custom", height: 44, insetLeft: 0, insetRight: 0 },
};
const panel = readArgument<PanelWindowDescriptor>("panel") ?? null;

/** Subscribe to a main-process channel and hand back the unsubscribe. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  version: bootstrap.version,
  platform: bootstrap.platform,
  chrome: bootstrap.chrome,
  panel,

  host: (): Promise<DesktopHostInfo> => ipcRenderer.invoke(IPC.hostInfo) as Promise<DesktopHostInfo>,
  onHost: (listener: (info: DesktopHostInfo) => void): (() => void) => subscribe(IPC.hostChanged, listener),
  retryHost: (): void => {
    ipcRenderer.send(IPC.hostRetry);
  },

  popOutPanel: (descriptor: PanelDescriptor): Promise<{ opened: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.panelPopOut, descriptor) as Promise<{ opened: boolean; reason?: string }>,
  closePanelWindow: (): void => {
    ipcRenderer.send(IPC.panelClose);
  },

  onDeepLink: (listener: (link: DeepLink) => void): (() => void) => subscribe(IPC.deepLink, listener),
  pendingDeepLinks: (): Promise<DeepLink[]> => ipcRenderer.invoke(IPC.deepLinkPending) as Promise<DeepLink[]>,

  window: {
    minimize: (): void => {
      ipcRenderer.send(IPC.windowMinimize);
    },
    toggleMaximize: (): void => {
      ipcRenderer.send(IPC.windowToggleMaximize);
    },
    close: (): void => {
      ipcRenderer.send(IPC.windowClose);
    },
    state: (): Promise<WindowChromeState> => ipcRenderer.invoke(IPC.windowState) as Promise<WindowChromeState>,
    onState: (listener: (state: WindowChromeState) => void): (() => void) =>
      subscribe(IPC.windowStateChanged, listener),
  },

  setTheme: (theme: "light" | "dark"): void => {
    ipcRenderer.send(IPC.themeSet, theme);
  },

  chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.directorySelect) as Promise<string | null>,
  openSourceFile: (path: string): Promise<{ opened: boolean; reason?: string }> => ipcRenderer.invoke(IPC.sourceFileOpen, path) as Promise<{ opened: boolean; reason?: string }>,

  microphone: {
    status: (): Promise<MicrophoneStatus> => ipcRenderer.invoke(IPC.microphoneStatus) as Promise<MicrophoneStatus>,
    request: (): Promise<MicrophoneStatus> => ipcRenderer.invoke(IPC.microphoneRequest) as Promise<MicrophoneStatus>,
    openSettings: (): void => {
      ipcRenderer.send(IPC.microphoneSettings);
    },
  },

  identity: (): Promise<IdentitySummary> => ipcRenderer.invoke(IPC.identity) as Promise<IdentitySummary>,

  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateStatus) as Promise<UpdateStatus>,
    check: (): Promise<UpdateStatus> => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateStatus>,
    install: (): void => {
      ipcRenderer.send(IPC.updateInstall);
    },
    onStatus: (listener: (status: UpdateStatus) => void): (() => void) => subscribe(IPC.updateChanged, listener),
  },
};

contextBridge.exposeInMainWorld(BRIDGE, api);
