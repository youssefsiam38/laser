/**
 * What the renderer is allowed to ask the operating system for (M5-T4).
 *
 * Default deny. The UI is our own code, but it renders agent output, and an
 * agent that can talk a page into asking for the camera is a much worse bug
 * than one that cannot dictate. So the allowlist is short and every entry has a
 * reason:
 *
 *   media (audio)    dictation — pi-gpt-transcribe's whole point
 *   clipboard-*      copying a command or a diff out of the transcript
 *   fullscreen       a surface asking for the whole window
 *
 * Everything else — geolocation, MIDI, HID, serial, USB, notifications from
 * the page (the shell raises those itself, so it can deep-link them) — is
 * refused without asking, and refused for every origin including our own.
 *
 * macOS is the platform with real teeth here. Chromium's own permission is not
 * enough: the process needs TCC consent, and asking for it requires
 * `NSMicrophoneUsageDescription` in Info.plist (electron-builder.yml sets it).
 * Without the key the app is killed the moment it touches the microphone, and
 * an ad-hoc-signed build silently loses the entitlement — which is why
 * electron-builder is pinned at 26.15.3 and the mac build is `hardenedRuntime`
 * with an explicit entitlements file.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { shell, systemPreferences, type Session } from "electron";
import type { MicrophoneStatus } from "./api.js";
import type { DesktopLog } from "./log.js";

/** Permissions we will consider, before the per-request checks below. */
const ALLOWED = new Set(["media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);

export interface PermissionGateOptions {
  /** The one origin our windows may run — anything else is denied outright. */
  isOurOrigin: (url: string) => boolean;
  log: DesktopLog;
}

export function installPermissionGates(target: Session, options: PermissionGateOptions): void {
  const { log } = options;

  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl || contents?.getURL() || "";
    if (!ALLOWED.has(permission) || !options.isOurOrigin(requestingUrl)) {
      log.line(`refused the ${permission} permission for ${requestingUrl || "an unknown page"}`);
      callback(false);
      return;
    }
    if (permission === "media") {
      // Audio, and nothing but audio. A request that does not say what it wants
      // is refused too: a permission granted by default is a permission nobody
      // reviewed.
      const types = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      if (types.length === 0 || types.some((type) => type !== "audio")) {
        log.line(`refused a media request for [${types.join(", ")}]: ${PRODUCT_NAME} only uses the microphone`);
        callback(false);
        return;
      }
      if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
        // Chromium would otherwise hand back a silent stream while macOS
        // quietly refuses. Better to say no and let the UI offer the fix.
        log.line(`refused the microphone: macOS has not granted ${PRODUCT_NAME} microphone access`);
        callback(false);
        return;
      }
    }
    callback(true);
  });

  target.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (!ALLOWED.has(permission) || !options.isOurOrigin(requestingOrigin)) return false;
    if (permission === "media" && process.platform === "darwin") {
      return systemPreferences.getMediaAccessStatus("microphone") === "granted";
    }
    return true;
  });

  // Device pickers (WebHID, WebUSB, serial, Bluetooth) have no place in a chat
  // window. The request handler above already refuses to ask; this refuses the
  // grant itself, so a device cannot be reached even if a permission were held
  // over from an older build.
  target.setDevicePermissionHandler(() => false);
}

export function microphoneStatus(): MicrophoneStatus {
  if (process.platform === "linux") {
    // Linux has no TCC equivalent; the page-level permission is the whole gate.
    return "granted";
  }
  return systemPreferences.getMediaAccessStatus("microphone") as MicrophoneStatus;
}

/**
 * Ask once. macOS shows its own dialog the first time and then remembers
 * forever, so calling this again after a refusal does nothing visible — the UI
 * has to offer `openMicrophoneSettings()` instead, which is why both exist.
 */
export async function requestMicrophone(log: DesktopLog): Promise<MicrophoneStatus> {
  if (process.platform !== "darwin") return microphoneStatus();
  const before = systemPreferences.getMediaAccessStatus("microphone");
  if (before === "granted") return "granted";
  try {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    log.line(`microphone access ${granted ? "granted" : "refused"} by macOS`);
  } catch (error) {
    log.error("asking macOS for microphone access failed", error);
  }
  return microphoneStatus();
}

/** Open the exact pane a person needs after saying no once. */
export function openMicrophoneSettings(): void {
  if (process.platform === "darwin") {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    return;
  }
  if (process.platform === "win32") {
    void shell.openExternal("ms-settings:privacy-microphone");
  }
}
