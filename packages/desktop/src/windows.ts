/**
 * Windows: the app window, and one window per popped-out panel (M5-T1).
 *
 * The titlebar treatment is the reason this file is not four lines. piorbit
 * draws its own top bar, so the native one is hidden — but "hidden" means three
 * different things:
 *
 *   macOS    `hiddenInset`: the system still draws the traffic lights, inset
 *            into our bar. We tell the UI how much room to leave on the left.
 *   Windows  a `titleBarOverlay`: the system draws minimise/maximise/close on
 *            the right, in our colours, which we restate whenever the theme
 *            changes. The UI leaves room on the right.
 *   Linux    no overlay exists, so the window is frameless and the UI draws the
 *            three controls itself through `window.piorbit.window`.
 *
 * Two things the UI cannot do for itself and which are therefore here: the
 * background colour is set before the first paint (a white flash on a dark
 * theme is exactly the "things pop" failure the bar forbids), and the window is
 * not shown until the renderer says it is ready.
 *
 * Navigation is locked to the host origin. The renderer is our own bundle, but
 * it renders agent output, and a link the agent wrote must open in the person's
 * browser — never inside a window holding `window.piorbit`.
 */
import { BrowserWindow, clipboard, dialog, nativeTheme, screen, shell, type BrowserWindowConstructorOptions } from "electron";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopChrome, PanelDescriptor, WindowChromeState } from "./api.js";
import type { DesktopLog } from "./log.js";
import { plainText } from "./text.js";

/** DESIGN.md `--bg`, so the frame matches the page before the page exists. */
const GROUND = { light: "#F5F7FA", dark: "#0B0F14" };
const INK = { light: "#131A22", dark: "#E6EDF3" };

/** The top bar height in DESIGN.md terms: 44px, which is also the touch floor. */
const TITLE_BAR_HEIGHT = 44;
/** Traffic lights are ~52px wide; 16px in, 12px of air after them. */
const MAC_TRAFFIC_LIGHT_INSET = 80;
/** The Windows controls overlay: three 46px buttons. */
const WINDOWS_OVERLAY_INSET = 138;

const MIN_WIDTH = 420;
const MIN_HEIGHT = 480;

export function chromeFor(platform: NodeJS.Platform): DesktopChrome {
  if (platform === "darwin") {
    return { controls: "system", height: TITLE_BAR_HEIGHT, insetLeft: MAC_TRAFFIC_LIGHT_INSET, insetRight: 0 };
  }
  if (platform === "win32") {
    return { controls: "system", height: TITLE_BAR_HEIGHT, insetLeft: 0, insetRight: WINDOWS_OVERLAY_INSET };
  }
  return { controls: "custom", height: TITLE_BAR_HEIGHT, insetLeft: 0, insetRight: WINDOWS_OVERLAY_INSET };
}

export function preloadPath(): string {
  // `.cjs`, because a sandboxed preload is CommonJS. The rest of the shell is
  // ESM; this one file is not.
  return fileURLToPath(new URL("./preload.cjs", import.meta.url));
}

interface StoredBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/**
 * Remembering where the window was, and refusing to restore it somewhere the
 * person cannot reach: a laptop undocked from a second monitor must not open
 * its window at x = 3000.
 */
class WindowState {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, "window-state.json");
  }

  read(): StoredBounds | undefined {
    let parsed: Partial<StoredBounds>;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoredBounds>;
    } catch {
      return undefined;
    }
    if (typeof parsed.width !== "number" || typeof parsed.height !== "number") return undefined;
    const bounds: StoredBounds = {
      width: Math.max(MIN_WIDTH, Math.round(parsed.width)),
      height: Math.max(MIN_HEIGHT, Math.round(parsed.height)),
      ...(parsed.maximized === true ? { maximized: true } : {}),
    };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      const point = { x: Math.round(parsed.x), y: Math.round(parsed.y) };
      const display = screen.getDisplayMatching({ ...point, width: bounds.width, height: bounds.height });
      const area = display.workArea;
      const visible =
        point.x + bounds.width > area.x + 80 &&
        point.x < area.x + area.width - 80 &&
        point.y + 40 > area.y &&
        point.y < area.y + area.height - 40;
      if (visible) {
        bounds.x = point.x;
        bounds.y = point.y;
      }
    }
    return bounds;
  }

  write(window: BrowserWindow): void {
    try {
      // `getNormalBounds` is the un-maximized geometry, which is what we want
      // to restore to when someone un-maximizes later.
      const bounds = window.getNormalBounds();
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(
        this.file,
        `${JSON.stringify({ ...bounds, maximized: window.isMaximized() }, null, 2)}\n`,
      );
    } catch {
      // Losing the window position is not worth an error dialog.
    }
  }
}

/** What the preload needs before the page runs. Passed as a launch argument. */
export interface WindowBootstrap {
  version: string;
  platform: string;
  chrome: DesktopChrome;
}

export interface WindowManagerOptions {
  stateDir: string;
  log: DesktopLog;
  bootstrap: WindowBootstrap;
  /** Current host origin, e.g. `http://127.0.0.1:41441`. Empty while starting. */
  origin: () => string;
  /** What a window should load: the host's UI, or a Vite dev server. */
  entryUrl: () => string;
  onMainWindowState: (state: WindowChromeState) => void;
  /** The app window started loading a document: whatever was listening is gone. */
  onMainNavigating: () => void;
}

/** `--piorbit-<name>=<url-encoded json>`, read back by the preload from argv. */
function launchArgument(name: string, value: unknown): string {
  return `--piorbit-${name}=${encodeURIComponent(JSON.stringify(value))}`;
}

/**
 * Two `data:` URLs both have an opaque origin, so this deliberately treats them
 * as the same place: the waiting screen must not reload itself every time the
 * host reports that it is still starting.
 */
function sameOrigin(a: string, b: string): boolean {
  const originOf = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.origin === "null" ? parsed.protocol : parsed.origin;
    } catch {
      return "";
    }
  };
  const left = originOf(a);
  return left !== "" && left === originOf(b);
}

export class WindowManager {
  private main: BrowserWindow | undefined;
  private readonly panels = new Map<string, BrowserWindow>();
  private readonly state: WindowState;
  private saveTimer: NodeJS.Timeout | undefined;
  /** Set while the app is really quitting, so `close` stops meaning `hide`. */
  private quitting = false;

  constructor(private readonly options: WindowManagerOptions) {
    this.state = new WindowState(options.stateDir);
    nativeTheme.on("updated", () => this.applyTheme());
  }

  mainWindow(): BrowserWindow | undefined {
    return this.main;
  }

  allWindows(): BrowserWindow[] {
    return [this.main, ...this.panels.values()].filter((window): window is BrowserWindow => window !== undefined);
  }

  beginQuit(): void {
    this.quitting = true;
    if (this.main && !this.main.isDestroyed()) this.state.write(this.main);
  }

  /** Create the app window, or bring the existing one forward. */
  showMain(): BrowserWindow {
    const existing = this.main;
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      if (!existing.isVisible()) existing.show();
      existing.focus();
      return existing;
    }

    const stored = this.state.read();
    const window = new BrowserWindow({
      ...this.frameOptions(),
      width: stored?.width ?? 1280,
      height: stored?.height ?? 820,
      ...(stored?.x !== undefined && stored.y !== undefined ? { x: stored.x, y: stored.y } : {}),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      title: "piorbit",
      backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
      webPreferences: this.webPreferences(),
    });
    this.main = window;
    if (stored?.maximized) window.maximize();

    this.harden(window);
    window.once("ready-to-show", () => {
      window.show();
      if (stored?.maximized) window.maximize();
    });

    window.webContents.on("did-start-loading", () => this.options.onMainNavigating());
    const save = (): void => this.scheduleSave(window);
    window.on("resize", save);
    window.on("move", save);
    const publish = (): void => this.publishState(window);
    window.on("maximize", publish);
    window.on("unmaximize", publish);
    window.on("enter-full-screen", publish);
    window.on("leave-full-screen", publish);
    window.on("focus", publish);
    window.on("blur", publish);
    window.on("close", (event) => {
      this.state.write(window);
      if (this.quitting) return;
      // The tray keeps piorbit running: closing the window puts it away, it
      // does not stop the agent. Quit is explicit, from the tray or Cmd/Ctrl+Q.
      event.preventDefault();
      window.hide();
      this.publishState(window);
    });
    window.on("closed", () => {
      if (this.main === window) this.main = undefined;
    });

    return window;
  }

  /**
   * Point the app window at a URL. Called from the main process only, so it is
   * not subject to the `will-navigate` gate — that gate exists to stop the
   * *page* from navigating itself somewhere it should not be.
   *
   * By default a window already showing the same origin is left alone. That is
   * the whole point: the app navigates itself constantly (sessions, panels,
   * routes), and re-issuing `loadURL` because the host reported "ready" a
   * second time would throw away whatever the person was in the middle of.
   * `force` is for the one case that must interrupt them — the host died and
   * the window has to say so.
   */
  navigateMain(url: string, force = false): void {
    const window = this.main;
    if (!window || window.isDestroyed()) return;
    const current = window.webContents.getURL();
    if (!force && current && sameOrigin(current, url)) return;
    void window.loadURL(url);
  }

  /**
   * A panel in its own window (docs/ux-panels.md, D-20). Identity is the panel
   * id: asking twice focuses the window that already exists rather than opening
   * a second copy of the same run.
   */
  popOutPanel(descriptor: PanelDescriptor): { opened: boolean; reason?: string } {
    const existing = this.panels.get(descriptor.id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return { opened: true };
    }
    const entry = this.options.entryUrl();
    if (!entry) return { opened: false, reason: "The agent host is not running yet." };

    const window = new BrowserWindow({
      ...this.frameOptions(),
      width: 560,
      height: 720,
      minWidth: 360,
      minHeight: 320,
      show: false,
      title: plainText(descriptor.title, 80) || "piorbit",
      backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
      webPreferences: {
        ...this.webPreferences(),
        // The descriptor reaches the preload before the page runs, so the UI
        // can render the panel on its first paint instead of flashing the
        // whole app and then replacing it.
        additionalArguments: [
          launchArgument("env", this.options.bootstrap),
          launchArgument("panel", descriptor),
        ],
      },
    });
    this.panels.set(descriptor.id, window);
    this.harden(window);
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (this.panels.get(descriptor.id) === window) this.panels.delete(descriptor.id);
    });
    // The agent renames things mid-run; the window title follows.
    window.on("page-title-updated", (event) => event.preventDefault());
    void window.loadURL(entry);
    return { opened: true };
  }

  closePanelWindow(window: BrowserWindow): void {
    for (const [id, candidate] of this.panels) {
      if (candidate === window) {
        this.panels.delete(id);
        break;
      }
    }
    if (!window.isDestroyed()) window.close();
  }

  /** Send something to every window that is alive. */
  broadcast(channel: string, payload: unknown): void {
    for (const window of this.allWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  stateOf(window: BrowserWindow): WindowChromeState {
    return { maximized: window.isMaximized(), fullScreen: window.isFullScreen(), focused: window.isFocused() };
  }

  private publishState(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    const state = this.stateOf(window);
    window.webContents.send("piorbit:window/state-changed", state);
    if (window === this.main) this.options.onMainWindowState(state);
  }

  private scheduleSave(window: BrowserWindow): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      if (!window.isDestroyed()) this.state.write(window);
    }, 400);
  }

  private frameOptions(): BrowserWindowConstructorOptions {
    const dark = nativeTheme.shouldUseDarkColors;
    if (process.platform === "darwin") {
      return {
        titleBarStyle: "hiddenInset",
        trafficLightPosition: { x: 16, y: (TITLE_BAR_HEIGHT - 16) / 2 },
      };
    }
    if (process.platform === "win32") {
      return {
        titleBarStyle: "hidden",
        titleBarOverlay: {
          color: dark ? GROUND.dark : GROUND.light,
          symbolColor: dark ? INK.dark : INK.light,
          height: TITLE_BAR_HEIGHT,
        },
      };
    }
    // Linux: no overlay API. Frameless, and the UI draws the controls.
    return { frame: false };
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      additionalArguments: [launchArgument("env", this.options.bootstrap)],
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      // The renderer is served over http from loopback; nothing here should
      // ever reach the network on its own.
      backgroundThrottling: false,
    };
  }

  /**
   * Hand a link to the person's browser, and say so when that fails.
   *
   * `shell.openExternal` rejects on a machine with no `xdg-open` and no portal
   * — a minimal desktop, a container, a kiosk. Dropping that rejection is how
   * provider sign-in becomes a dead end: the person clicks "Sign in", nothing
   * appears, and there is no URL anywhere to paste into a browser by hand. So
   * the failure gets a dialog with the address in it and a button that copies
   * it, which is the one thing that still lets them finish.
   */
  private openInBrowser(window: BrowserWindow, url: string): void {
    void shell.openExternal(url).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log.line(`could not open ${url.slice(0, 120)} in a browser: ${reason}`);
      void dialog
        .showMessageBox(window, {
          type: "warning",
          title: "piorbit could not open your browser",
          message: "piorbit could not open your browser",
          detail:
            `This computer has no program registered to open web links, so piorbit could not hand this address over:\n\n${url}\n\n` +
            `Copy it and paste it into a browser to carry on.`,
          buttons: ["Copy the address", "Close"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        .then((answer) => {
          if (answer.response === 0) clipboard.writeText(url);
        })
        .catch(() => {});
    });
  }

  /**
   * Everything a window is not allowed to do. `setWindowOpenHandler` and
   * `will-navigate` together mean a link in agent output opens in the person's
   * browser and can never take over a window that has `window.piorbit`.
   */
  private harden(window: BrowserWindow): void {
    const { log } = this.options;
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.openInBrowser(window, url);
      else log.line(`refused to open ${url.slice(0, 120)}`);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const origin = this.options.origin();
      // `sameOrigin`, never `startsWith`: the host origin is
      // `http://127.0.0.1:41441`, and both `http://127.0.0.1:41441.example/`
      // and `http://127.0.0.1:414419/` are prefixed by it. The URLs that reach
      // here come from agent output, and the window they would load in carries
      // the whole `window.piorbit` bridge.
      if (origin && sameOrigin(url, origin)) return;
      event.preventDefault();
      if (/^https?:/i.test(url)) this.openInBrowser(window, url);
      else log.line(`refused navigation to ${url.slice(0, 120)}`);
    });
    // Reload a crashed renderer, but only once in a while: a page that crashes
    // on load would otherwise spin forever, and a window flickering through an
    // infinite reload is worse than a window that stopped.
    let lastRecovery = 0;
    window.webContents.on("render-process-gone", (_event, details) => {
      const now = Date.now();
      if (now - lastRecovery < 15_000) {
        log.line(`a window's renderer stopped again (${details.reason}); leaving it alone`);
        return;
      }
      lastRecovery = now;
      log.line(`a window's renderer stopped (${details.reason}); reloading it`);
      if (!window.isDestroyed()) window.reload();
    });
  }

  /** Keep the native frame in step with the theme, on every window. */
  applyTheme(theme?: "light" | "dark"): void {
    const dark = theme ? theme === "dark" : nativeTheme.shouldUseDarkColors;
    for (const window of this.allWindows()) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(dark ? GROUND.dark : GROUND.light);
      if (process.platform === "win32") {
        window.setTitleBarOverlay({
          color: dark ? GROUND.dark : GROUND.light,
          symbolColor: dark ? INK.dark : INK.light,
          height: TITLE_BAR_HEIGHT,
        });
      }
    }
  }
}
