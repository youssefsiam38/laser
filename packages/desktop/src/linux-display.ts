/**
 * The display backend on Linux, decided before Chromium opens a window.
 *
 * What goes wrong without this, on an NVIDIA GPU under GNOME on Wayland: the
 * window shows a frame from a moment ago. The layout has moved on — a resize,
 * a step change — but the picture on screen has not, so a button is live down
 * one edge and dead across the rest, and the cursor never turns into a
 * pointer because it is not over the button that is actually there. It looks
 * like broken CSS and it is not.
 *
 * The cause is synchronisation between the app and the compositor. The NVIDIA
 * driver does not do implicit sync; the fix is the explicit-sync protocol
 * (`wp_linux_drm_syncobj_manager_v1`), which needs three parties to agree:
 *
 *   - the driver: NVIDIA 555 or newer;
 *   - the compositor: Mutter 46.1+, KWin 6.1+ (Ubuntu 24.04 ships Mutter 46.2
 *     with the protocol deliberately switched off);
 *   - the app: Chromium supports it from 134 (Electron 35) but only when the
 *     `WaylandLinuxDrmSyncobj` feature is on, and Electron does not turn it on.
 *
 * So the policy is:
 *
 *   1. Native Wayland on a Wayland session (Chromium's own `ozone-platform-hint=auto`).
 *      Under XWayland the same NVIDIA bug needs Xwayland 24.1, which LTS
 *      distributions do not have, so X11 is not the safer default.
 *   2. Turn `WaylandLinuxDrmSyncobj` on. Where the compositor offers explicit
 *      sync, that is the whole fix, and it costs nothing elsewhere.
 *   3. If the session runs on NVIDIA and the compositor does *not* offer
 *      explicit sync, composite in software (`disable-gpu-compositing`).
 *      Frames then travel as plain shared memory, which needs no sync at all.
 *      This is the documented mitigation for the stale-frame bug and it is
 *      applied only to the machines that would hit it.
 *
 * Anyone who passes their own `--ozone-platform`, `--enable-features` or GPU
 * switches has made their choice, and it is respected.
 *
 * Sources: NVIDIA/open-gpu-kernel-modules#187 (the stale-frame bug and its
 * resolution through explicit sync), electron/electron#50455 (Electron leaves
 * the syncobj feature off), the Hyprland NVIDIA guide (enable it per app), and
 * Phoronix on Mutter 46.2 in Ubuntu 24.04 (explicit sync disabled there).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXPLICIT_SYNC_GLOBAL = "wp_linux_drm_syncobj_manager_v1";
export const NVIDIA_VENDOR = "0x10de";

export interface LinuxDisplayFacts {
  /** `process.argv` without the executable: the switches the person passed. */
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  /** PCI vendor ids of the GPUs with a display attached, e.g. `["0x10de"]`. */
  gpuVendors: readonly string[];
  /** Interface names the Wayland compositor advertises; `undefined` if the probe could not run. */
  waylandGlobals: readonly string[] | undefined;
}

export interface LinuxDisplayDecision {
  /** Chromium switches to append, in order: `[name]` or `[name, value]`. */
  switches: Array<[string] | [string, string]>;
  /** True when the window will be a native Wayland surface. */
  wayland: boolean;
  /** One line per decision, for the log. */
  notes: string[];
}

export function linuxDisplayDecision(facts: LinuxDisplayFacts): LinuxDisplayDecision {
  const { argv, env } = facts;
  const asked = (flag: string): boolean => argv.some((a) => a === `--${flag}` || a.startsWith(`--${flag}=`));
  const value = (flag: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${flag}=`))?.slice(flag.length + 3);

  const switches: LinuxDisplayDecision["switches"] = [];
  const notes: string[] = [];

  // 1. Which backend will run.
  const chosePlatform = asked("ozone-platform") || asked("ozone-platform-hint");
  if (!chosePlatform) switches.push(["ozone-platform-hint", "auto"]);
  const onWaylandSession = Boolean(env["WAYLAND_DISPLAY"]);
  const platform = value("ozone-platform");
  const hint = value("ozone-platform-hint");
  const wayland = platform
    ? platform === "wayland"
    : hint
      ? hint === "wayland" || (hint === "auto" && onWaylandSession)
      : onWaylandSession;
  if (!wayland) {
    notes.push(chosePlatform ? `display: ${argv.filter((a) => a.includes("ozone")).join(" ")} (yours)` : "display: X11");
    return { switches, wayland, notes };
  }

  // 2. Explicit sync, for the compositors that have it.
  const featuresChosen = asked("enable-features") || asked("disable-features");
  if (!featuresChosen) switches.push(["enable-features", "WaylandLinuxDrmSyncobj"]);

  // 3. Software compositing, only where the stale-frame bug would otherwise show.
  const nvidia = facts.gpuVendors.includes(NVIDIA_VENDOR);
  const explicitSync = facts.waylandGlobals?.includes(EXPLICIT_SYNC_GLOBAL);
  const gpuChosen = ["disable-gpu-compositing", "disable-gpu", "use-gl", "use-angle", "in-process-gpu"].some(asked);
  const compositor = facts.waylandGlobals === undefined ? "unknown" : explicitSync ? "explicit sync" : "no explicit sync";
  let line = `display: native Wayland, ${nvidia ? "NVIDIA" : "GPU " + (facts.gpuVendors.join("/") || "unknown")}, compositor ${compositor}`;
  if (nvidia && facts.waylandGlobals !== undefined && !explicitSync && !gpuChosen) {
    switches.push(["disable-gpu-compositing"]);
    line += "; compositing in software so every frame on screen is the current one";
  } else if (nvidia && !explicitSync && gpuChosen) {
    line += "; GPU switches are yours, left as given";
  }
  notes.push(line);
  return { switches, wayland, notes };
}

function readVendor(device: string): string | undefined {
  try {
    const vendor = readFileSync(join(device, "vendor"), "utf8").trim().toLowerCase();
    return vendor || undefined;
  } catch {
    return undefined;
  }
}

/** PCI vendor ids of the GPUs that have a display connected, from sysfs. */
export function connectedGpuVendors(drmRoot = "/sys/class/drm"): string[] {
  const vendors = new Set<string>();
  let entries: string[] = [];
  try {
    entries = readdirSync(drmRoot);
  } catch {
    // No DRM at all: a container, or a machine we cannot read. Fall through.
  }
  for (const entry of entries) {
    if (!/^card\d+-/.test(entry)) continue;
    try {
      if (readFileSync(join(drmRoot, entry, "status"), "utf8").trim() !== "connected") continue;
      // A connector's `device` is its card; the card's `device` is the PCI function.
      const vendor = readVendor(join(drmRoot, entry, "device", "device")) ?? readVendor(join(drmRoot, entry, "device"));
      if (vendor) vendors.add(vendor);
    } catch {
      // A connector without a readable device: skip it.
    }
  }
  if (vendors.size === 0 && existsSync("/proc/driver/nvidia/version")) vendors.add(NVIDIA_VENDOR);
  return [...vendors];
}

/**
 * Run `wayland-globals.js` as a child Node process and wait for its answer.
 * Synchronous on purpose: Chromium switches must be in place before the main
 * script returns, and there is no synchronous socket API in Node.
 */
export function probeWaylandGlobals(
  env: NodeJS.ProcessEnv,
  execPath: string,
  script: string,
  timeoutMs = 1500,
): string[] | undefined {
  if (!env["WAYLAND_DISPLAY"]) return undefined;
  const result = spawnSync(execPath, [script], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { globals?: unknown; error?: unknown };
    if (!Array.isArray(parsed.globals)) return undefined;
    if (parsed.error) return undefined;
    return parsed.globals.filter((g): g is string => typeof g === "string");
  } catch {
    return undefined;
  }
}
