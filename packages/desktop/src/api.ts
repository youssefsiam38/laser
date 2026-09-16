/**
 * The contract between the Electron shell and the one web app.
 *
 * `@lasercode/ui` is the same bundle in a browser tab, a phone, and this window.
 * So everything here is **additive and optional**: the shell exposes
 * `window.laser`, and the web build simply does not have it. A feature that
 * only works on the desktop must degrade to something that works everywhere —
 * popping a panel out becomes opening a tab, and desktop window controls become
 * the browser's own frame.
 *
 * This module is types and channel names only. It is imported by the main
 * process, by the preload bridge, and (for types) by the renderer, so it must
 * stay free of any `electron` import.
 */
import { PRODUCT_NAME, URL_SCHEME } from "@lasercode/protocol";

export type DesktopPlatform = "darwin" | "win32" | "linux";

/** How much of the window frame laser draws itself, and where it must not draw. */
export interface DesktopChrome {
  /**
   * `system`: the OS owns the controls (and, on Linux, the whole titlebar).
   * `custom`: the window is frameless and the UI draws minimise/maximise/close.
   */
  controls: "system" | "custom";
  /** Height in CSS pixels of the draggable strip at the top of the window. */
  height: number;
  /** Left gutter the UI must leave empty (macOS traffic lights live there). */
  insetLeft: number;
  /** Right gutter the UI must leave empty (the Windows controls overlay). */
  insetRight: number;
}

export type HostState = "starting" | "ready" | "failed" | "stopped";

/** What the shell knows about the host process it drives. */
export interface DesktopHostInfo {
  state: HostState;
  url: string;
  wsUrl: string;
  port: number;
  /** Written for a person: what happened and what to do about it. */
  message?: string;
  /** False when we attached to a host somebody else (`laser up`) started. */
  startedByUs: boolean;
  /** The stock Node the host runs on, and its own `process.execPath` (M5-T2). */
  runtime?: {
    binary: string;
    version: string;
    execPath: string;
    /**
     * The agent laser ships, as the *bundled* Node resolved it — never
     * anything installed on this machine (M10-T3).
     */
    agent?: { package: string; version: string; packageDir: string };
  };
  /** Where the host writes its log, for an error state that needs a next step. */
  logFile: string;
}

export type DeepLink =
  | { kind: "session"; path: string }
  | { kind: "project"; cwd: string }
  | { kind: "open" };

export type MicrophoneStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

/** Never carries key material — only enough to show what identity is in play. */
export interface IdentitySummary {
  /** base64url device id derived from the root public key. */
  deviceId: string;
  /** Where the secret actually lives, for the settings screen and for errors. */
  storage: string;
  /** True when this run generated the key, which invalidates every pairing. */
  created: boolean;
  /**
   * Set when the keychain refused and laser fell back to a 0600 file. The UI
   * must say so: the security story changed, and silence would be a lie.
   */
  degraded?: string;
}

/**
 * The key this computer keeps for conversations cached in the renderer (RP-10).
 *
 * `key` is 32 bytes, base64url, held in the operating system's own secret
 * store (`store` names it, for the settings screen). `available: false` is the
 * honest answer and carries a sentence written for a person: a machine with no
 * usable keyring gets no key at all rather than a key in a file, because a key
 * beside the ciphertext is not encryption.
 */
export type DeviceCacheKey =
  | { available: true; key: string; store: string }
  | { available: false; reason: string };

export type UpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "error"
  | "downloaded"
  | "parking"
  | "ready"
  | "restarting"
  | "succeeded"
  | "failed";

interface UpdateStatusBase {
  /** The version waiting to be installed, when there is one. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** Written for a person. */
  message?: string;
}

export type UpdateStatus =
  | (UpdateStatusBase & { state: "unsupported" | "idle" | "checking" | "available" | "downloading" | "error"; updateId?: never })
  | (UpdateStatusBase & {
      state: "downloaded" | "parking" | "ready" | "restarting" | "succeeded" | "failed";
      /** Durable correlation across download, gate, restart and result. */
      updateId: string;
      blockers?: { conversations: number; agents: number; questions: number; approvals: number; commands: number; mutations: number; workers: number };
    });

export interface WindowChromeState {
  maximized: boolean;
  fullScreen: boolean;
  focused: boolean;
}

export interface LaserDesktop {
  /** The app version, so the UI can show it without asking the host. */
  readonly version: string;
  readonly platform: DesktopPlatform;
  readonly chrome: DesktopChrome;
  host(): Promise<DesktopHostInfo>;
  onHost(listener: (info: DesktopHostInfo) => void): () => void;
  /** Try to start the host again after a failure. Safe to call when it is up. */
  retryHost(): void;

  onDeepLink(listener: (link: DeepLink) => void): () => void;
  /** Links that arrived before the UI could listen (a cold start from a link). */
  pendingDeepLinks(): Promise<DeepLink[]>;

  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    state(): Promise<WindowChromeState>;
    onState(listener: (state: WindowChromeState) => void): () => void;
  };

  /**
   * Keep the native frame (Windows overlay, macOS vibrancy) in step with the UI
   * theme, and record what the opening screen should be painted with.
   *
   * `ground` carries the declarations in `STARTUP_SCREEN_TOKEN_NAMES` for the
   * applied theme and for both halves of the follow-the-system pair. The shell
   * keeps them so the screen it shows before the app exists is the person's own
   * theme rather than the default preset (M13-T32). It is validated in the main
   * process; sending nothing is allowed and simply leaves the last record.
   */
  setTheme(theme: "light" | "dark", ground?: unknown): void;

  /** Open the operating system's folder picker. Null means it was cancelled. */
  chooseDirectory(): Promise<string | null>;
  /**
   * Open a source file in the operating system's text editor.
   *
   * Absent when this platform has no text-editor path at all, exactly as it is
   * absent in the browser and on the phone: every caller already checks for it
   * and offers the path to copy instead, which is the honest answer.
   */
  openSourceFile?(path: string): Promise<{ opened: boolean; reason?: string }>;

  /**
   * What this desktop window can read about its own renderer process.
   *
   * The sandboxed preload owns this capability, so there is no IPC hop and no
   * process identity leaves it. Browsers and phones have no desktop bridge;
   * every desktop window always offers this field. A failed read resolves
   * `undefined`, never an error string or a substituted number.
   */
  memory: {
    /** Private-resident memory in Electron's native kilobyte unit. */
    process(): Promise<{ private?: number } | undefined>;
  };

  microphone: {
    status(): Promise<MicrophoneStatus>;
    /** Prompts once on macOS; resolves with whatever the system decided. */
    request(): Promise<MicrophoneStatus>;
    /**
     * macOS and Windows only ask once. After a refusal the sole way back is the
     * system settings pane, so the UI's "denied" state needs a button that
     * opens it rather than a request that will never prompt again.
     */
    openSettings(): void;
  };

  identity(): Promise<IdentitySummary>;

  /**
   * Encryption for the device conversation cache (RP-10).
   *
   * Absent in a browser and on a phone, exactly as `openSourceFile` is: the
   * renderer then stores what it caches in the browser's own storage and says
   * so, and never claims encryption it cannot prove.
   */
  deviceCache?: {
    key(): Promise<DeviceCacheKey>;
    /** Replace the key. Everything already cached becomes unreadable. */
    reset(): Promise<DeviceCacheKey>;
  };

  updates: {
    /** Ask before restarting this desktop and its host together. */
    restart(): void;
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    /** Close new-work admission and wait without cancelling anything. */
    prepare(): Promise<UpdateStatus>;
    /** Reopen admission for the same update id. */
    cancel(): Promise<UpdateStatus>;
    /** Activate only after the exact transaction is parked and verified. */
    install(): void;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
}

/** IPC channel names, generated from product.json so both sides agree. */
export { IPC } from "./ipc.generated.js";
export type { IpcChannel } from "./ipc.generated.js";

/** The protocol scheme the OS hands back to us. product.json owns the value. */
export const DEEP_LINK_SCHEME = URL_SCHEME;

/**
 * The renderer bridge, and the argv switches the main process passes to it.
 *
 * Deliberately name-free. `src/preload.cts` runs in a *sandboxed* preload,
 * where `require` resolves only `electron` and a handful of Node builtins — it
 * cannot import `@lasercode/protocol`, so anything it names has to be a literal
 * in that file. Rather than leave the product's name written twice, the two
 * strings say what they are instead of who they belong to: they are an internal
 * contract inside one build, never stored, never seen by a person, and a
 * rename does not touch them.
 *
 * `preload.cts` repeats these two values and says so. `test/preload.test.ts`
 * is what keeps the two copies equal.
 */
export const DESKTOP_BRIDGE = "desktop";
export const DESKTOP_ARGUMENT_PREFIX = "--desktop-";
