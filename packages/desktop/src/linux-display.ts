/**
 * The display backend on Linux, decided before Chromium opens a window.
 *
 * Two things, both cheap and both defensible on their own:
 *
 *   1. Native Wayland on a Wayland session, through Chromium's own
 *      `ozone-platform-hint=auto`. That is the supported way to say it.
 *   2. Chromium's `WaylandLinuxDrmSyncobj` feature, which is how a Wayland
 *      client uses the explicit-sync protocol (`wp_linux_drm_syncobj_manager_v1`).
 *      It matters on NVIDIA, whose driver does no implicit sync: without
 *      explicit sync those machines get flickering and frames out of order
 *      (NVIDIA/open-gpu-kernel-modules#187). Chromium has supported it since
 *      134 but leaves it off, and Electron does not turn it on
 *      (electron/electron#50455); the Hyprland NVIDIA guide tells every
 *      Electron app to add it. Where the compositor does not offer the
 *      protocol the feature simply does nothing.
 *
 * What is *not* done here: switching the GPU off. An earlier revision
 * composited in software on NVIDIA when the compositor lacked explicit sync,
 * on the theory that a "button that only works down one edge" was a stale
 * frame. The real cause was a preload that failed to load, and with that fixed
 * the theory has no evidence behind it — so the fallback is gone rather than
 * left in to cost every NVIDIA user their GPU. The facts are still gathered and
 * logged, because the next person to see a rendering complaint on Linux should
 * be told which GPU and which compositor they are on without asking for it.
 *
 * Anyone who passes their own `--ozone-platform` or feature list has made their
 * choice, and it is respected.
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

  // 3. Say what this machine is, so a rendering report starts with facts.
  const nvidia = facts.gpuVendors.includes(NVIDIA_VENDOR);
  const explicitSync = facts.waylandGlobals?.includes(EXPLICIT_SYNC_GLOBAL);
  const compositor = facts.waylandGlobals === undefined ? "unknown" : explicitSync ? "explicit sync" : "no explicit sync";
  const gpu = nvidia ? "NVIDIA" : `GPU ${facts.gpuVendors.join("/") || "unknown"}`;
  notes.push(`display: native Wayland, ${gpu}, compositor ${compositor}`);
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
