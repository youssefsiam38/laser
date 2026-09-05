/**
 * Auto-update (M5-T5).
 *
 * `electron-updater` is loaded lazily, and only in a packaged app that has an
 * update feed. In a development run there is no `app-update.yml`, and
 * importing it eagerly means a stack trace on every `pnpm dev` — so the
 * development state is `unsupported` and says so in words rather than failing.
 *
 * A packaged build without a feed says the same thing, for the same reason:
 * every check would reject forever, and "it will try again later" is a lie
 * when there is nothing to try. See `electron-builder.yml` for why `publish`
 * is unset and what to set it to.
 *
 * The update is downloaded quietly and installed when a person chooses to
 * restart. An agent may be mid-turn: restarting the app underneath a running
 * session would abandon work that a person is waiting for, so nothing here ever
 * restarts on its own. `autoInstallOnAppQuit` means the next ordinary quit
 * picks it up, which is the polite version of the same thing.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { UpdateStatus } from "./api.js";
import type { DesktopLog } from "./log.js";

export interface UpdaterOptions {
  packaged: boolean;
  log: DesktopLog;
  onStatus: (status: UpdateStatus) => void;
  /** Quit properly (stop the host, save window state) and then install. */
  quitAndInstall: () => void;
}

/**
 * Is there an update feed at all?
 *
 * electron-builder writes `app-update.yml` next to the app only when the build
 * declares a `publish` target. Without one, `checkForUpdates()` rejects on
 * every call and the app would tell people a check failed when it structurally
 * cannot succeed.
 */
function feedConfigured(): boolean {
  try {
    return existsSync(join(process.resourcesPath, "app-update.yml"));
  } catch {
    return false;
  }
}

/** Six hours: often enough to matter, rare enough that nobody notices. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Long enough after launch that the first check never competes with startup. */
const FIRST_CHECK_DELAY_MS = 20_000;

type AutoUpdater = typeof import("electron-updater").autoUpdater;

export class Updater {
  private status: UpdateStatus = { state: "idle" };
  private updater: AutoUpdater | undefined;
  private timer: NodeJS.Timeout | undefined;
  private firstCheck: NodeJS.Timeout | undefined;

  constructor(private readonly options: UpdaterOptions) {
    if (!options.packaged) {
      this.status = {
        state: "unsupported",
        message: "This is a development build, so it updates when you rebuild it.",
      };
    } else if (!feedConfigured()) {
      // A build with no `publish` target ships no `app-update.yml`, so every
      // check would fail forever. "It will try again later" is then a lie:
      // there is nothing to try. Say what is true instead.
      this.status = {
        state: "unsupported",
        message: "This build has no update feed, so piorbit will not update itself. Download new versions from the releases page.",
      };
    }
  }

  current(): UpdateStatus {
    return this.status;
  }

  start(): void {
    if (!this.options.packaged || this.status.state === "unsupported") return;
    const updater = this.load();
    if (!updater) return;
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstCheck) clearTimeout(this.firstCheck);
  }

  async check(): Promise<UpdateStatus> {
    const updater = this.load();
    if (!updater) return this.status;
    try {
      await updater.checkForUpdates();
    } catch (error) {
      this.options.log.error("checking for updates failed", error);
      this.publish({
        state: "error",
        message: "piorbit could not check for updates. It will try again later.",
      });
    }
    return this.status;
  }

  install(): void {
    if (this.status.state !== "ready") return;
    this.options.quitAndInstall();
  }

  /** Called from the quit path once the host is stopped. */
  quitAndInstall(): boolean {
    if (this.status.state !== "ready" || !this.updater) return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }

  private load(): AutoUpdater | undefined {
    if (this.updater) return this.updater;
    if (!this.options.packaged || this.status.state === "unsupported") return undefined;
    try {
      // `createRequire` rather than an import so a build without the updater
      // (or a development run) degrades to "unsupported" instead of failing to
      // start the whole app.
      const { autoUpdater } = createRequire(import.meta.url)("electron-updater") as typeof import("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = {
        info: (message: unknown) => this.options.log.line(`updater: ${String(message)}`),
        warn: (message: unknown) => this.options.log.line(`updater: ${String(message)}`),
        error: (message: unknown) => this.options.log.line(`updater: ${String(message)}`),
        debug: () => {},
      };

      autoUpdater.on("checking-for-update", () => this.publish({ state: "checking" }));
      autoUpdater.on("update-not-available", () =>
        this.publish({ state: "idle", message: "piorbit is up to date." }),
      );
      autoUpdater.on("update-available", (info: { version: string }) =>
        this.publish({ state: "available", version: info.version, message: `Version ${info.version} is downloading.` }),
      );
      autoUpdater.on("download-progress", (progress: { percent: number }) =>
        this.publish({ state: "downloading", percent: progress.percent }),
      );
      autoUpdater.on("update-downloaded", (info: { version: string }) =>
        this.publish({
          state: "ready",
          version: info.version,
          message: `Version ${info.version} is ready. It installs the next time piorbit restarts.`,
        }),
      );
      autoUpdater.on("error", (error: Error) => {
        this.options.log.error("updater", error);
        this.publish({ state: "error", message: "piorbit could not download the update. It will try again later." });
      });

      this.updater = autoUpdater;
      return autoUpdater;
    } catch (error) {
      this.options.log.error("the updater is not available in this build", error);
      this.publish({ state: "unsupported", message: "This build does not update itself." });
      return undefined;
    }
  }

  private publish(status: UpdateStatus): void {
    this.status = status;
    this.options.onStatus(status);
  }
}
