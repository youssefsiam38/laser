/**
 * The contract between the Electron shell and the one web app.
 *
 * `@lasercode/ui` is the same bundle in a browser tab, a phone, and this window.
 * So everything here is **additive and optional**: the shell exposes
 * `window.laser`, and the web build simply does not have it. A feature that
 * only works on the desktop must degrade to something that works everywhere —
 * popping a panel out becomes opening a tab, the custom titlebar becomes no
 * titlebar at all.
 *
 * This module is types and channel names only. It is imported by the main
 * process, by the preload bridge, and (for types) by the renderer, so it must
 * stay free of any `electron` import.
 */
import { PRODUCT_NAME, URL_SCHEME } from "@lasercode/protocol";
import type { PanelKind } from "@lasercode/protocol";

export type DesktopPlatform = "darwin" | "win32" | "linux";

/** How much of the window frame laser draws itself, and where it must not draw. */
export interface DesktopChrome {
  /**
   * `system`: macOS still draws the traffic lights, inset into our own bar.
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

/** A panel asked to live in its own window. Identity survives the move (R6). */
export interface PanelDescriptor {
  /** The panel id from the panel contract; the window is keyed on it. */
  id: string;
  kind: PanelKind;
  /** Untrusted text. Used as the window title, never as markup. */
  title: string;
  /** The session the panel belongs to, so the window can load it. */
  sessionPath?: string;
  cwd?: string;
}

/** Set on `window.laser.panel` inside a popped-out window; null in the main one. */
export type PanelWindowDescriptor = PanelDescriptor;

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

export type UpdateState =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** The version waiting to be installed, when there is one. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** Written for a person. */
  message?: string;
}

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
  /** Non-null only inside a popped-out panel window. */
  readonly panel: PanelWindowDescriptor | null;

  host(): Promise<DesktopHostInfo>;
  onHost(listener: (info: DesktopHostInfo) => void): () => void;
  /** Try to start the host again after a failure. Safe to call when it is up. */
  retryHost(): void;

  /** Open a panel in its own window. Returns `opened: false` with a reason. */
  popOutPanel(descriptor: PanelDescriptor): Promise<{ opened: boolean; reason?: string }>;
  /** From inside a panel window: put the panel back and close this window. */
  closePanelWindow(): void;

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

  /** Keep the native frame (Windows overlay, macOS vibrancy) in step with the UI theme. */
  setTheme(theme: "light" | "dark"): void;

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

  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    /** Quit and install a downloaded update. No-op unless the state is `ready`. */
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
