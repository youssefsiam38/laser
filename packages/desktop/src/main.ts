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
import { APP_ID, DATA_DIR_NAME, ENV, PRODUCT_NAME } from "@lasercode/protocol";
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateFormerIdentities, resolvePaths, type ParsedArgs, type LaserPaths } from "@lasercode/cli";
import {
  DEEP_LINK_SCHEME,
  IPC,
  type DeepLink,
  type DesktopHostInfo,
  type IdentitySummary,
  type UpdateStatus,
} from "./api.js";
import { agentHome, desktopEnv } from "./agent-home.js";
import { openSourceFile } from "./open-source-file.js";
import { deepLinkFromArgv, parseDeepLink } from "./deep-links.js";
import { startingPageUrl, statusPageUrl } from "./error-page.js";
import { frameColours, parseStartupGround, readStartupGround, writeStartupGround, type StartupGround } from "./startup-ground.js";
import type { AttentionChange, FleetSnapshot } from "./fleet.js";
import { HostLink } from "./host-link.js";
import { HostProcess } from "./host-process.js";
import { resolveShellEnvironment } from "./shell-environment.js";
import { connectedGpuVendors, linuxDisplayDecision, probeWaylandGlobals } from "./linux-display.js";
import { loadSecrets } from "./keychain.js";
import { DesktopLog } from "./log.js";
import { Notifier } from "./notifications.js";
import { NativeUpdateWatch } from "./native-update.js";
import { LinuxRelaunchError, linuxRelaunchCommand, prepareLinuxRelaunch, type PreparedRelaunch } from "./linux-relaunch.js";
import { resolveNodeRuntime } from "./runtime.js";
import { installPermissionGates, microphoneStatus, openMicrophoneSettings, requestMicrophone } from "./permissions.js";
import { TrayController } from "./tray.js";
import { Updater } from "./updater.js";
import { chromeFor, WindowManager } from "./windows.js";

/**
 * Never change this. It keys the Windows notification centre, the macOS TCC
 * grants (microphone!), and the update feed. A new id is a new app that has to
 * ask for the microphone again and cannot update the old one.
 */
// The app id is product.json's, through @lasercode/protocol: macOS keys TCC
// grants on it and Windows keys the notification centre and taskbar on it.

/** No flags: a GUI takes its configuration from the environment, not argv. */
const NO_ARGS: ParsedArgs = { flags: {}, positionals: [], rest: [], hasRest: false };

/**
 * laser's own home, not the agent's (M10-T3). `desktopEnv` removes the
 * variables that describe the person's *own* agent installation and pins
 * laser's directories in their place, and everything downstream — the paths
 * this process uses, the host it spawns, every worker under that host — is
 * resolved from this one environment. See `agent-home.ts` for why.
 */
// Before any path is resolved: if this product was renamed, the person's data
// is still under the old directory name and has to move first (MX-T7, D-36).
const migration = migrateFormerIdentities(process.env);

const environment = desktopEnv(process.env);
const home = agentHome(process.env);
const paths: LaserPaths = resolvePaths(NO_ARGS, environment);
const log = new DesktopLog(join(paths.stateDir, "desktop.log"));
for (const line of migration.lines) log.line(line);
log.line(
  `${PRODUCT_NAME} data directory: ${home.dataDir}${home.chosenByPerson ? ` (set by ${ENV.agentDir})` : ""}` +
    (home.ignored.length > 0 ? `; ignoring ${home.ignored.join(", ")} — those name another agent installation` : ""),
);

/**
 * A development run points at Vite when `${ENV.uiUrl}` is set, so the UI can
 * hot-reload while still driving a real host. Without it, the host serves the
 * built bundle, which is what a packaged app always does.
 */
const devUiUrl = process.env[ENV.uiUrl];

// ---------------------------------------------------------------- state ----

let hostInfo: DesktopHostInfo | undefined;
let identity: IdentitySummary | undefined;
let updateStatus: UpdateStatus = { state: "idle" };
/** Links that arrived before a renderer could take them. */
const pendingLinks: DeepLink[] = [];
let mainReady = false;
let quitting = false;
/**
 * What the app last told us it paints with, so the opening screen and the
 * window frame are the person's own colours from the first frame (M13-T32).
 */
let startupGround: StartupGround | undefined = readStartupGround(paths.stateDir);
let nativePromptOpen = false;
let nativeVersion: string | undefined;

// ------------------------------------------------------------ singleton ----

/**
 * The display backend, before anything opens a window. The policy and its
 * reasons live in `linux-display.ts`; the short version is that an NVIDIA GPU
 * under a compositor without explicit sync shows stale frames, and the app is
 * the one party that can still make it right.
 */
if (process.platform === "linux") {
  const decision = linuxDisplayDecision({
    argv: process.argv.slice(1),
    env: process.env,
    gpuVendors: connectedGpuVendors(),
    waylandGlobals: probeWaylandGlobals(
      process.env,
      process.execPath,
      join(dirname(fileURLToPath(import.meta.url)), "wayland-globals.js"),
    ),
  });
  for (const [name, value] of decision.switches) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
  for (const note of decision.notes) log.line(note);
}

// A second launch (a deep link, a double-click) must reach the instance that
// already owns the host, not start a rival one. This has to run before
// anything else touches the port or the state directory.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId(APP_ID);
app.setName(PRODUCT_NAME);

/**
 * Pin where Chromium keeps its own state — cookies, local storage, the GPU
 * cache — instead of letting it derive one.
 *
 * `setName` comes too late to move it: Electron has already resolved
 * `userData` from the executable, which in a development run is the `electron`
 * binary itself. The effect is that `pnpm dev` writes into `~/.config/Electron`,
 * shared with every other Electron app anyone has ever run from source, and a
 * packaged build writes somewhere else again — so the two disagree about what
 * theme you chose and a stale value from an unrelated app can decide how this
 * one looks. Naming it once fixes both.
 */
app.setPath("userData", join(app.getPath("appData"), DATA_DIR_NAME));

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
  frame: () => frameColours(startupGround, nativeTheme.shouldUseDarkColors),
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
  // @lasercode/cli's daemon listed under REQUESTS; the variable is set here so
  // nothing else has to change when it lands.)
  ...(devUiUrl ? { env: { [ENV.allowedOrigins]: originOf(devUiUrl) } } : {}),
  onChange: (info) => onHostChanged(info),
  confirmHostRefresh: async () => (await dialog.showMessageBox({
    type: "question", title: `Restart ${PRODUCT_NAME} and its host?`,
    message: "The running host is a different version.",
    detail: "Restart both together to continue. Saved sessions are kept, but active work will stop. Choose Later to leave the host running.",
    buttons: ["Later", "Restart together"], defaultId: 0, cancelId: 0,
  })).response === 1,
});

const link = new HostLink({
  log,
  onSnapshot: (snapshot: FleetSnapshot) => tray.setFleet(snapshot),
  onAttention: (change: AttentionChange) => notifier.handle(change),
  onSeen: (path) => notifier.clear(path),
  onSessions: (sessions) => notifier.reconcile(sessions),
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
  onInstallUpdate: () => void installUpdate(),
  onQuit: () => void quit({}),
  onUnavailable: (error) => {
    log.error("no status icon on this desktop; the window is the app", error);
  },
});

const updater = new Updater({
  packaged: app.isPackaged,
  log,
  onStatus: (status) => {
    if (nativeVersion) return;
    updateStatus = status;
    tray.setUpdate(status);
    windows.broadcast(IPC.updateChanged, status);
  },
  quitAndInstall: () => void quit({ install: true }),
});

const nativeUpdate = new NativeUpdateWatch({
  resources: process.resourcesPath, running: app.getVersion(),
  onReady: (version) => {
    nativeVersion = version;
    updateStatus = { state: "ready", version, message: "Installed by your operating system. Restart the app and host together when you are ready." };
    tray.setUpdate(updateStatus);
    windows.broadcast(IPC.updateChanged, updateStatus);
    void installUpdate(true);
  },
});

async function installUpdate(announce = false, forceRelaunch = false): Promise<void> {
  if (nativePromptOpen || quitting) return;
  nativePromptOpen = true;
  if (!forceRelaunch && !nativeUpdate.check()) { nativePromptOpen = false; if (!announce) updater.install(); return; }
  try {
  const { response } = await dialog.showMessageBox({
    type: "question", title: `${PRODUCT_NAME} update ready`,
    message: "Restart the app and host together?",
    detail: "Saved sessions will be kept. Active work will stop during the restart. Choose Later to keep working; Restart is available from the system tray menu.",
    buttons: ["Later", "Restart now"], defaultId: 0, cancelId: 0,
  });
  if (response === 1 && !quitting) await quit({ relaunch: true });
  } finally { nativePromptOpen = false; }
}

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
        title: `${PRODUCT_NAME} cannot start its agent host`,
        message: hostInfo?.message ?? "Something stopped the host from starting.",
        logFile: hostInfo?.logFile ?? paths.logFile,
      }),
      true,
    );
    return;
  }
  // One opening screen, not two: the same mark and beams the app itself
  // mounts, in the same colours, so the app taking over is a handover rather
  // than a second screen (M13-T32).
  windows.navigateMain(startingPageUrl(startupGround, nativeTheme.shouldUseDarkColors));
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

async function quit(options: { install?: boolean; relaunch?: boolean }): Promise<void> {
  if (quitting) return;
  quitting = true;
  let relaunch: PreparedRelaunch | undefined;
  if (options.relaunch && process.platform === "linux") {
    try {
      const runtime = resolveNodeRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
      relaunch = await prepareLinuxRelaunch({
        nodeBinary: runtime.binary,
        command: linuxRelaunchCommand({
          packaged: app.isPackaged, execPath: process.execPath, argv: process.argv,
          cwd: process.cwd(), env: process.env,
        }),
        logFile: join(paths.stateDir, "desktop.log"),
      });
      // Preparation must succeed before interrupting work. A stop failure must
      // never leave a committed replacement beside the old host.
      await host.stop(true);
      await relaunch.commit();
    } catch (error) {
      relaunch?.cancel();
      quitting = false;
      log.error("preparing update restart failed", error);
      await dialog.showMessageBox({
        type: "error", title: "Restart could not be prepared",
        message: error instanceof LinuxRelaunchError ? error.message : "The app could not prepare its restart. When your work is saved, quit completely and open it from the applications menu.",
        buttons: ["Keep app open"],
      });
      return;
    }
  }
  log.line(options.install ? "quitting to install an update" : "quitting");
  windows.beginQuit();
  updater.stop();
  nativeUpdate.stop();
  link.close();
  notifier.dispose();
  tray.destroy();
  try {
    if (!relaunch) await host.stop(options.relaunch || options.install);
  } catch (error) {
    log.error("stopping the host failed", error);
  }
  if (options.install && updater.quitAndInstall()) return;
  if (options.relaunch && !relaunch) app.relaunch();
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

  // The app has applied a theme. Two things follow: the native frame changes
  // colour with it, and the few declarations the opening screen needs are kept
  // on disk so the next launch starts in this theme rather than in the default
  // one (M13-T32).
  ipcMain.on(IPC.themeSet, (_event, theme: unknown, ground: unknown) => {
    if (theme !== "light" && theme !== "dark") return;
    const recorded = parseStartupGround(ground);
    if (recorded) {
      startupGround = recorded;
      writeStartupGround(paths.stateDir, recorded);
    }
    windows.applyTheme();
  });

  ipcMain.handle(IPC.directorySelect, async (event) => {
    const owner = windowOf(event);
    const options: Electron.OpenDialogOptions = {
      title: "Choose a project folder",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.microphoneStatus, () => microphoneStatus());
  ipcMain.handle(IPC.sourceFileOpen, (event, path: unknown) => {
    if (!windowOf(event) || event.senderFrame !== event.sender.mainFrame) return { opened: false, reason: "Open source files from the main application window." };
    return openSourceFile(path);
  });
  ipcMain.handle(IPC.microphoneRequest, () => requestMicrophone(log));
  ipcMain.on(IPC.microphoneSettings, () => openMicrophoneSettings());

  ipcMain.handle(IPC.identity, () => identity);

  ipcMain.handle(IPC.updateStatus, () => updateStatus);
  ipcMain.handle(IPC.updateCheck, () => nativeUpdate.check() ? updateStatus : updater.check());
  ipcMain.on(IPC.updateInstall, (_event, options: unknown) => void installUpdate(false,
    !!options && typeof options === "object" && (options as { relaunch?: unknown }).relaunch === true));
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
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { label: `Quit ${PRODUCT_NAME}`, accelerator: "Command+Q", click: () => void quit({}) },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        { label: `Open ${PRODUCT_NAME}`, accelerator: "CmdOrCtrl+Shift+O", click: () => openApp() },
        { type: "separator" },
        isMac ? { role: "close" } : { label: `Quit ${PRODUCT_NAME}`, accelerator: "Ctrl+Q", click: () => void quit({}) },
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
        { label: `Show the ${PRODUCT_NAME} log`, click: () => void shell.openPath(join(paths.stateDir, "desktop.log")) },
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
  if (process.platform === "linux") {
    // What Chromium actually did with the display decision, for support logs.
    // Only once `gpu-info-update` has fired: before that every feature reads
    // `disabled_software`, which is Chromium not knowing yet, not Chromium
    // having decided — and a log that says the GPU is off when it is on sends
    // the next person chasing the wrong thing.
    app.once("gpu-info-update", () => {
      const gpu = app.getGPUFeatureStatus() as unknown as Record<string, string>;
      log.line(`gpu: compositing ${gpu["gpu_compositing"]}, rasterization ${gpu["rasterization"]}, webgl ${gpu["webgl"]}`);
    });
  }

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
    log.error(`could not load the ${PRODUCT_NAME} identity`, error);
    identity = undefined;
  }

  const shellEnvironment = await resolveShellEnvironment({ log: (line) => log.line(line) });
  Object.assign(process.env, shellEnvironment);
  Object.assign(environment, shellEnvironment);
  await host.start();
  updater.start();
  if (app.isPackaged && process.platform === "linux") nativeUpdate.start();
}

start().catch((error: unknown) => {
  log.error(`${PRODUCT_NAME} could not start`, error);
  // Nothing is on screen yet at this point, so a dialog is the only way to say
  // anything at all.
  dialog.showErrorBox(
    `${PRODUCT_NAME} could not start`,
    `${error instanceof Error ? error.message : String(error)}\n\nThe log is at ${join(paths.stateDir, "desktop.log")}.`,
  );
  app.exit(1);
});
