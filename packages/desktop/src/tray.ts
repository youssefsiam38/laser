/**
 * The tray (M5-T1).
 *
 * What it is for: knowing whether anything needs you without opening the app,
 * and getting to that thing in one click. So it carries counts, not a launcher
 * menu — every row is a session you can jump to.
 *
 * The state vocabulary is DESIGN.md's, in words rather than colour, because a
 * native menu has no dot and macOS re-tints a template icon anyway: "waiting",
 * "error", "done", "running". The icon carries one bit (does anything need
 * you), and on macOS the count rides alongside it as a title.
 *
 * The menu is rebuilt from a snapshot rather than mutated, because on Linux a
 * tray menu is a fixed structure handed to the desktop environment — there is
 * nothing to mutate.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from "electron";
import type { SessionAttention } from "@lasercode/protocol";
import type { DeepLink, UpdateStatus } from "./api.js";
import type { FleetSnapshot } from "./fleet.js";
import {
  trayAttention,
  trayAttention2x,
  trayAttention3x,
  trayColourAttention,
  trayColourAttention2x,
  trayColourAttention3x,
  trayColourIdle,
  trayColourIdle2x,
  trayColourIdle3x,
  trayIdle,
  trayIdle2x,
  trayIdle3x,
} from "./assets/icons.generated.js";
import { fleetSummary, plainText, shortAge } from "./text.js";

/** Enough rows to be useful, few enough to stay a menu. */
const PROJECT_LIMIT = 10;
const SESSION_LIMIT = 8;

/**
 * macOS wants a template image (black + alpha) and re-tints it for the light
 * menu bar, the dark one, and the highlighted state. Windows and Linux do not
 * re-tint anything, so a black mark vanishes on a dark taskbar: those get the
 * coloured mark instead.
 */
const useTemplate = process.platform === "darwin";

function imageFrom(base64: string, base64_2x: string, base64_3x: string): NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"), { scaleFactor: 1 });
  image.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(base64_2x, "base64") });
  image.addRepresentation({ scaleFactor: 3, buffer: Buffer.from(base64_3x, "base64") });
  if (useTemplate) image.setTemplateImage(true);
  return image;
}

const ICONS = useTemplate
  ? {
      idle: imageFrom(trayIdle, trayIdle2x, trayIdle3x),
      attention: imageFrom(trayAttention, trayAttention2x, trayAttention3x),
    }
  : {
      idle: imageFrom(trayColourIdle, trayColourIdle2x, trayColourIdle3x),
      attention: imageFrom(trayColourAttention, trayColourAttention2x, trayColourAttention3x),
    };

export interface TrayControllerOptions {
  /** Open (or focus) the app window. */
  onOpen: () => void;
  onNavigate: (link: DeepLink) => void;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onQuit: () => void;
  /** No tray host on this desktop: the window has to become the app's home. */
  onUnavailable?: (error: Error) => void;
}

export class TrayController {
  private tray: Tray | undefined;
  /** Why there is no status icon, when there is none. */
  private failure: Error | undefined;
  private snapshot: FleetSnapshot = { connected: false, projects: [], running: 0, waiting: 0 };
  private hostMessage: string | undefined;
  private update: UpdateStatus = { state: "idle" };
  private rebuildTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: TrayControllerOptions) {}

  /**
   * The status icon, if this desktop has somewhere to put one.
   *
   * A GNOME session without the AppIndicator extension has no tray host, and
   * `new Tray()` is inside the app's startup path, whose rejection ends in
   * `app.exit(1)`. A missing status icon is a degraded app, not a failed
   * launch — so it is caught, recorded, and `available()` tells the caller,
   * which then stops treating the tray as the app's home.
   */
  start(): void {
    if (this.tray) return;
    try {
      this.tray = new Tray(ICONS.idle);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.options.onUnavailable?.(this.failure);
      return;
    }
    this.tray.setToolTip(PRODUCT_NAME);
    // Windows and Linux: a click is "show me the app". macOS: a click opens the
    // menu, which is what every menu-bar app does there.
    this.tray.on("click", () => {
      if (process.platform === "darwin") this.tray?.popUpContextMenu();
      else this.options.onOpen();
    });
    this.render();
  }

  /** False when this desktop has no tray host, so nothing else assumes one. */
  available(): boolean {
    return this.tray !== undefined;
  }

  setFleet(snapshot: FleetSnapshot): void {
    this.snapshot = snapshot;
    this.schedule();
  }

  /** A host that is starting or broken replaces the counts with the reason. */
  setHostMessage(message: string | undefined): void {
    this.hostMessage = message;
    this.schedule();
  }

  setUpdate(status: UpdateStatus): void {
    this.update = status;
    this.schedule();
  }

  destroy(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.tray?.destroy();
    this.tray = undefined;
  }

  /** Attention arrives in bursts; the tray only needs the end of one. */
  private schedule(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.render();
    }, 150);
  }

  private render(): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    const { running, waiting } = this.snapshot;

    tray.setImage(waiting > 0 ? ICONS.attention : ICONS.idle);
    if (process.platform === "darwin") {
      // A number next to the mark, only when there is something to say.
      tray.setTitle(waiting > 0 ? ` ${waiting}` : "", { fontType: "monospacedDigit" });
    }
    tray.setToolTip(this.headline());
    tray.setContextMenu(Menu.buildFromTemplate(this.template()));
  }

  private headline(): string {
    if (this.hostMessage) return `${PRODUCT_NAME} — ${plainText(this.hostMessage, 80)}`;
    if (!this.snapshot.connected) return `${PRODUCT_NAME} — connecting to the agent host…`;
    const summary = fleetSummary(this.snapshot.running, this.snapshot.waiting);
    return summary ? `${PRODUCT_NAME} — ${summary}` : `${PRODUCT_NAME} — nothing running`;
  }

  private template(): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [{ label: this.headline(), enabled: false }, { type: "separator" }];

    const projects = this.snapshot.projects.filter((project) => project.sessions.length > 0);
    if (this.snapshot.connected && projects.length === 0) {
      items.push({ label: "No sessions yet", enabled: false });
    }
    for (const project of projects.slice(0, PROJECT_LIMIT)) {
      const summary = fleetSummary(project.running, project.waiting);
      const submenu: MenuItemConstructorOptions[] = project.sessions.slice(0, SESSION_LIMIT).map((session) => ({
        label: `${plainText(session.name ?? "New session", 48)} · ${describe(session.attention)} · ${shortAge(session.modifiedAt)}`,
        click: () => this.options.onNavigate({ kind: "session", path: session.path }),
      }));
      if (project.sessions.length > SESSION_LIMIT) {
        submenu.push({ type: "separator" });
        submenu.push({ label: `${project.sessions.length - SESSION_LIMIT} more in ${PRODUCT_NAME}`, enabled: false });
      }
      submenu.push({ type: "separator" });
      submenu.push({
        label: "Open this project",
        click: () => this.options.onNavigate({ kind: "project", cwd: project.cwd }),
      });
      items.push({
        label: summary ? `${plainText(project.name, 40)} — ${summary}` : plainText(project.name, 40),
        submenu,
      });
    }
    if (projects.length > PROJECT_LIMIT) {
      items.push({ label: `${projects.length - PROJECT_LIMIT} more projects in ${PRODUCT_NAME}`, enabled: false });
    }

    items.push({ type: "separator" });
    items.push({ label: `Open ${PRODUCT_NAME}`, click: () => this.options.onOpen() });
    items.push(...this.updateItems());
    items.push({ type: "separator" });
    items.push({ label: `Quit ${PRODUCT_NAME}`, click: () => this.options.onQuit() });
    return items;
  }

  private updateItems(): MenuItemConstructorOptions[] {
    switch (this.update.state) {
      case "unsupported":
        return [];
      case "ready":
        return [
          {
            label: `Restart to update${this.update.version ? ` to ${this.update.version}` : ""}`,
            click: () => this.options.onInstallUpdate(),
          },
        ];
      case "downloading":
        return [
          {
            label: `Downloading update… ${Math.round(this.update.percent ?? 0)}%`,
            enabled: false,
          },
        ];
      case "checking":
        return [{ label: "Checking for updates…", enabled: false }];
      default:
        return [{ label: "Check for updates…", click: () => this.options.onCheckForUpdates() }];
    }
  }
}

function describe(attention: SessionAttention): string {
  switch (attention) {
    case "waiting_for_input":
      return "waiting for you";
    case "working":
      return "running";
    case "finished_unread":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}
