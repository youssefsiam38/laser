/**
 * The Electron main process (M5-T1 … M5-T5).
 *
 * The shape of the app, in one paragraph: one instance, one host process
 * spawned from a bundled stock Node, one window that can be closed without
 * quitting, a tray that keeps telling you what your agents are doing, and
 * notifications that deep-link back into a session. Everything with a policy
 * lives here; the renderer only ever asks.
 *
 * Order matters at startup and it is not the obvious one. The window is created
 * *before* the host is up, but not shown: creating it early means the operating
 * system sees the app launching, and showing it late means the first frame is
 * the app rather than a white rectangle that turns into the app. If the host
 * fails, the same window shows a written explanation instead — a state that was
 * designed, not a blank page.
 */
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths, type ParsedArgs, type PiorbitPaths } from "@piorbit/cli";
import {
  DEEP_LINK_SCHEME,
  IPC,
  type DeepLink,
  type DesktopHostInfo,
  type IdentitySummary,
  type PanelDescriptor,
  type UpdateStatus,
} from "./api.js";
import { agentHome, desktopEnv } from "./agent-home.js";
import { deepLinkFromArgv, parseDeepLink } from "./deep-links.js";
import { statusPageUrl } from "./error-page.js";
import type { AttentionChange, FleetSnapshot } from "./fleet.js";
import { HostLink } from "./host-link.js";
import { HostProcess } from "./host-process.js";
import { loadSecrets } from "./keychain.js";
import { DesktopLog } from "./log.js";
import { Notifier } from "./notifications.js";
import { installPermissionGates, microphoneStatus, openMicrophoneSettings, requestMicrophone } from "./permissions.js";
import { TrayController } from "./tray.js";
import { Updater } from "./updater.js";
import { chromeFor, WindowManager } from "./windows.js";

/**
 * Never change this. It keys the Windows notification centre, the macOS TCC
 * grants (microphone!), and the update feed. A new id is a new app that has to
 * ask for the microphone again and cannot update the old one.
 */
const APP_ID = "dev.piorbit.desktop";

/** No flags: a GUI takes its configuration from the environment, not argv. */
const NO_ARGS: ParsedArgs = { flags: {}, positionals: [], rest: [], hasRest: false };

/**
 * piorbit's own home, not the agent's (M10-T3). `desktopEnv` removes the
 * variables that describe the person's *own* agent installation and pins
 * piorbit's directories in their place, and everything downstream — the paths
 * this process uses, the host it spawns, every worker under that host — is
 * resolved from this one environment. See `agent-home.ts` for why.
 */
const environment = desktopEnv(process.env);
const home = agentHome(process.env);
const paths: PiorbitPaths = resolvePaths(NO_ARGS, environment);
const log = new DesktopLog(join(paths.stateDir, "desktop.log"));
log.line(
  `piorbit data directory: ${home.dataDir}${home.chosenByPerson ? " (set by PIORBIT_AGENT_DIR)" : ""}` +
    (home.ignored.length > 0 ? `; ignoring ${home.ignored.join(", ")} — those name another agent installation` : ""),
);

/**
 * A development run points at Vite when `PIORBIT_UI_URL` is set, so the UI can
 * hot-reload while still driving a real host. Without it, the host serves the
 * built bundle, which is what a packaged app always does.
 */
const devUiUrl = process.env["PIORBIT_UI_URL"];

// ---------------------------------------------------------------- state ----

let hostInfo: DesktopHostInfo | undefined;
let identity: IdentitySummary | undefined;
let updateStatus: UpdateStatus = { state: "idle" };
/** Links that arrived before a renderer could take them. */
const pendingLinks: DeepLink[] = [];
let mainReady = false;
let quitting = false;

// ------------------------------------------------------------ singleton ----

// A second launch (a deep link, a double-click) must reach the instance that
// already owns the host, not start a rival one. This has to run before
// anything else touches the port or the state directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);
app.setName("piorbit");

// ---------------------------------------------------------------- parts ----

const windows = new WindowManager({
  stateDir: paths.stateDir,
  log,
  bootstrap: {
    version: app.getVersion(),
    platform: process.platform,
    chrome: chromeFor(process.platform),
  },
  origin: () => (devUiUrl ? originOf(devUiUrl) : hostInfo ? originOf(hostInfo.url) : ""),
  entryUrl: () => devUiUrl ?? hostInfo?.url ?? "",
  onMainWindowState: () => {},
  // "Ready" means the renderer is listening for deep links, which it says by
  // draining the queue — not merely that a document finished loading.
  onMainNavigating: () => {
    mainReady = false;
  },
});

const host = new HostProcess({
  paths,
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  log,
  baseEnv: environment,
  // Development against Vite: the page's origin is the dev server's, and the
  // host has never heard of it. Harmless in a packaged app, where the host
  // serves the page itself and this is empty. (Needs the one-line change to
  // @piorbit/cli's daemon listed under REQUESTS; the variable is set here so
  // nothing else has to change when it lands.)
  ...(devUiUrl ? { env: { PIORBIT_ALLOWED_ORIGINS: originOf(devUiUrl) } } : {}),
  onChange: (info) => onHostChanged(info),
});

const link = new HostLink({
  log,
  onSnapshot: (snapshot: FleetSnapshot) => tray.setFleet(snapshot),
  onAttention: (change: AttentionChange) => notifier.handle(change),
});

const notifier = new Notifier({
  log,
  // A banner while you are looking at the same thing in the app is noise.
  isForeground: () => windows.allWindows().some((window) => window.isVisible() && window.isFocused()),
  onActivate: (target) => {
    openApp();
    dispatchDeepLink(target);
  },
});

const tray = new TrayController({
  onOpen: () => openApp(),
  onNavigate: (target) => {
    openApp();
    dispatchDeepLink(target);
  },
  onCheckForUpdates: () => void updater.check(),
  onInstallUpdate: () => void quit({ install: true }),
  onQuit: () => void quit({}),
  onUnavailable: (error) => {
    log.error("no status icon on this desktop; the window is the app", error);
  },
});

const updater = new Updater({
  packaged: app.isPackaged,
  log,
  onStatus: (status) => {
    updateStatus = status;
    tray.setUpdate(status);
    windows.broadcast(IPC.updateChanged, status);
  },
  quitAndInstall: () => void quit({ install: true }),
});

// ----------------------------------------------------------- deep links ----

function registerProtocolHandler(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    return;
  }
  // In development the executable is Electron, so the OS needs to be told the
  // script to hand the link to as well. macOS ignores this and uses Info.plist,
  // which a development run does not have — links only work packaged there.
  if (process.platform === "win32" || process.platform === "linux") {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      fileURLToPath(new URL("./main.js", import.meta.url)),
    ]);
  }
}

function dispatchDeepLink(target: DeepLink | undefined): void {
  if (!target) return;
  const window = app.isReady() ? windows.mainWindow() : undefined;
  if (window && !window.isDestroyed() && mainReady) {
    window.webContents.send(IPC.deepLink, target);
    return;
  }
  // The UI is not listening yet (a cold start from a link). Hold it; the
  // renderer drains the queue as soon as it mounts.
  pendingLinks.push(target);
  if (pendingLinks.length > 8) pendingLinks.shift();
}

/**
 * A link that arrives before the app is ready — the normal macOS cold start,
 * where `open-url` fires first and *is* the reason the app launched — must not
 * try to build a window. It waits in the queue like any other early link.
 */
function receiveDeepLink(target: DeepLink | undefined): void {
  if (!target) return;
  if (app.isReady()) openApp();
  dispatchDeepLink(target);
}

app.on("second-instance", (_event, argv) => {
  if (app.isReady()) openApp();
  receiveDeepLink(deepLinkFromArgv(argv));
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  receiveDeepLink(parseDeepLink(url));
});

// ------------------------------------------------------------ lifecycle ----

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function onHostChanged(info: DesktopHostInfo): void {
  hostInfo = info;
  windows.broadcast(IPC.hostChanged, info);
  tray.setHostMessage(info.state === "ready" ? undefined : (info.message ?? "starting the agent host…"));
  if (info.state === "ready") link.connect(info.wsUrl);
  routeMainWindow();
}

/**
 * What the app window should be showing, given what the host is doing. One
 * function so the tray, a retry, a deep link and the host's own state changes
 * cannot disagree about it.
 *
 * `navigateMain` leaves a window that is already on the right origin alone, so
 * calling this while somebody is working never interrupts them. The one
 * exception is a host that has failed: that has to be said, even mid-session.
 */
function routeMainWindow(): void {
  if (!windows.mainWindow()) return;
  const state = hostInfo?.state;
  if (state === "ready" && hostInfo) {
    windows.navigateMain(devUiUrl ?? hostInfo.url);
    return;
  }
  if (state === "failed") {
    windows.navigateMain(
      statusPageUrl({
        title: "piorbit cannot start its agent host",
        message: hostInfo?.message ?? "Something stopped the host from starting.",
        logFile: hostInfo?.logFile ?? paths.logFile,
      }),
      true,
    );
    return;
  }
  windows.navigateMain(
    statusPageUrl({
      title: "Starting piorbit",
      message:
        "piorbit is starting the agent host that runs your sessions. This is only slow the first time after an update.",
      logFile: hostInfo?.logFile ?? paths.logFile,
      busy: true,
    }),
  );
}

/**
 * If the host is quick — which it normally is — the first thing on screen is
 * the app itself. Only a slow start earns a waiting screen, and it says what it
 * is waiting for rather than spinning anonymously.
 */
const SLOW_START_MS = 1200;

function showWaitingScreenIfSlow(): void {
  setTimeout(() => {
    if (quitting || hostInfo?.state === "ready" || hostInfo?.state === "failed") return;
    routeMainWindow();
  }, SLOW_START_MS);
}

/**
 * Show the window, creating it if it is gone (macOS keeps the app running with
 * no window at all). Routing afterwards is what stops the tray from opening a
 * blank rectangle while the host is still starting.
 */
function openApp(): BrowserWindow {
  const window = windows.showMain();
  routeMainWindow();
  return window;
}

async function quit(options: { install?: boolean }): Promise<void> {
  if (quitting) return;
  quitting = true;
  log.line(options.install ? "quitting to install an update" : "quitting");
  windows.beginQuit();
  updater.stop();
  link.close();
  tray.destroy();
  try {
    await host.stop();
  } catch (error) {
    log.error("stopping the host failed", error);
  }
  if (options.install && updater.quitAndInstall()) return;
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitting) return;
  // Cmd+Q, a taskbar close, or a logout: run the same orderly shutdown as the
  // tray's Quit, so the host is never killed mid-write.
  event.preventDefault();
  void quit({});
});

/**
 * The tray is the app's home, so closing the last window is not quitting —
 * *when there is a tray*. On a GNOME session with no AppIndicator extension
 * there is no status icon at all, and this would leave an invisible process
 * holding the host and the single-instance lock with no way back to it. Then
 * the window is the app, and closing it quits.
 */
app.on("window-all-closed", () => {
  if (tray.available()) return;
  log.line("no status icon and no windows left; quitting");
  void quit({});
});
app.on("activate", () => {
  // macOS can emit this during launch, before a window may be built.
  if (app.isReady()) openApp();
});

// ------------------------------------------------------------------ IPC ----

function windowOf(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function installIpc(): void {
  ipcMain.handle(IPC.hostInfo, () => hostInfo);
  ipcMain.on(IPC.hostRetry, () => void host.start());

  ipcMain.handle(IPC.panelPopOut, (_event, descriptor: PanelDescriptor) => {
    if (!descriptor || typeof descriptor.id !== "string" || descriptor.id.length === 0) {
      return { opened: false, reason: "That panel has no id." };
    }
    return windows.popOutPanel(descriptor);
  });
  ipcMain.on(IPC.panelClose, (event) => {
    const window = windowOf(event);
    if (window) windows.closePanelWindow(window);
  });

  ipcMain.handle(IPC.deepLinkPending, () => {
    mainReady = true;
    const drained = [...pendingLinks];
    pendingLinks.length = 0;
    return drained;
  });

  ipcMain.on(IPC.windowMinimize, (event) => windowOf(event)?.minimize());
  ipcMain.on(IPC.windowToggleMaximize, (event) => {
    const window = windowOf(event);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on(IPC.windowClose, (event) => windowOf(event)?.close());
  ipcMain.handle(IPC.windowState, (event) => {
    const window = windowOf(event);
    return window ? windows.stateOf(window) : { maximized: false, fullScreen: false, focused: false };
  });

  ipcMain.on(IPC.themeSet, (_event, theme: unknown) => {
    if (theme !== "light" && theme !== "dark") return;
    windows.applyTheme(theme);
  });

  ipcMain.handle(IPC.microphoneStatus, () => microphoneStatus());
  ipcMain.handle(IPC.microphoneRequest, () => requestMicrophone(log));
  ipcMain.on(IPC.microphoneSettings, () => openMicrophoneSettings());

  ipcMain.handle(IPC.identity, () => identity);

  ipcMain.handle(IPC.updateStatus, () => updateStatus);
  ipcMain.handle(IPC.updateCheck, () => updater.check());
  ipcMain.on(IPC.updateInstall, () => updater.install());
}

// ----------------------------------------------------------------- menu ----

/**
 * Frameless windows draw no menu bar, but the accelerators still have to work:
 * without a menu, Cmd/Ctrl+C in the composer does nothing on Windows and Linux.
 * So the menu exists everywhere and is only *visible* on macOS.
 */
function installMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "piorbit",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: "Quit piorbit", accelerator: "Command+Q", click: () => void quit({}) },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        { label: "Open piorbit", accelerator: "CmdOrCtrl+Shift+O", click: () => openApp() },
        { type: "separator" },
        isMac ? { role: "close" } : { label: "Quit piorbit", accelerator: "Ctrl+Q", click: () => void quit({}) },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : ([{ role: "toggleDevTools" }] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Show the host log", click: () => void shell.openPath(paths.logFile) },
        { label: "Show the piorbit log", click: () => void shell.openPath(join(paths.stateDir, "desktop.log")) },
        { type: "separator" },
        { label: "Check for updates…", click: () => void updater.check() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------- start ----

async function start(): Promise<void> {
  registerProtocolHandler();
  await app.whenReady();

  installPermissionGates(session.defaultSession, {
    isOurOrigin: (url) => {
      const origin = devUiUrl ? originOf(devUiUrl) : (hostInfo ? originOf(hostInfo.url) : "");
      return origin !== "" && originOf(url) === origin;
    },
    log,
  });
  installIpc();
  installMenu();
  tray.start();

  // The window exists from here on, so the OS shows the app launching; it is
  // shown only once there is something in it (`ready-to-show`).
  windows.showMain();
  showWaitingScreenIfSlow();

  // A link that launched the app (Windows and Linux pass it in argv).
  dispatchDeepLink(deepLinkFromArgv(process.argv));

  // Secrets before the host, so a keychain prompt is the first thing a person
  // sees rather than something that interrupts a running session later.
  try {
    const secrets = await loadSecrets({ stateDir: paths.stateDir, log });
    identity = secrets.summary;
    log.line(`identity ${secrets.summary.deviceId} from ${secrets.summary.storage}`);
  } catch (error) {
    log.error("could not load the piorbit identity", error);
    identity = undefined;
  }

  await host.start();
  updater.start();
}

start().catch((error: unknown) => {
  log.error("piorbit could not start", error);
  // Nothing is on screen yet at this point, so a dialog is the only way to say
  // anything at all.
  dialog.showErrorBox(
    "piorbit could not start",
    `${error instanceof Error ? error.message : String(error)}\n\nThe log is at ${join(paths.stateDir, "desktop.log")}.`,
  );
  app.exit(1);
});
