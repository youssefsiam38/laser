/**
 * Durable in-memory settings overrides (M13-T12).
 *
 * The engine's `SettingsManager.applyOverrides()` is not durable: it merges the
 * override on top of the *currently computed* settings and keeps no record of
 * it. Every path that recomputes settings from the two files throws the
 * override away:
 *
 *   - `SettingsManager.reload()` recomputes `settings = merge(global, project)`;
 *   - `SettingsManager.setProjectTrusted()` does the same;
 *   - `ResourceLoader.reload()` calls `settingsManager.reload()`, and
 *     `createAgentSessionServices()` calls `resourceLoader.reload()` — so an
 *     override applied before service creation is already gone by the time the
 *     session exists;
 *   - `AgentSession.reload()` (an extension's `ctx.reload()`, a package or
 *     resource refresh) reloads settings and the resource loader again.
 *
 * That matters here because the overrides are not a convenience: they are how a
 * project's `.laser/settings.json` reaches the engine at all (nothing is written
 * to disk), and how the engine's package/extension/skill/prompt/theme discovery
 * is switched off. Losing them silently re-enables engine-owned machinery the
 * product does not offer.
 *
 * The engine exposes no hook to re-apply an override after a reload, so the
 * overrides are made durable here by wrapping the two methods that drop them on
 * the instance we own. Recorded upstream in `docs/upstream.md`.
 */

import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** The engine does not export its `Settings` type from the package root. */
export type EngineSettingsOverrides = Parameters<SettingsManager["applyOverrides"]>[0];

/**
 * Marks a manager we already wrapped, so re-registering does not stack wrappers.
 * Deliberately not a registry symbol: the marker means nothing outside this
 * module, and one process must never see two different wrappers agree on a key.
 */
const DURABLE = Symbol("durable settings overrides");

interface DurableState {
  overrides: EngineSettingsOverrides;
}

type Wrapped = SettingsManager & { [DURABLE]?: DurableState };

/**
 * Apply `overrides` and keep them applied for the life of `manager`.
 *
 * Calling it again on the same manager replaces the durable set rather than
 * adding a second layer, so a caller that re-reads `.laser` can simply call it
 * again. Overrides applied through the engine's own `applyOverrides()` stay
 * non-durable: only the values registered here are restored.
 */
export function applyDurableOverrides(manager: SettingsManager, overrides: EngineSettingsOverrides): void {
  const target = manager as Wrapped;
  const existing = target[DURABLE];
  if (existing) {
    existing.overrides = overrides;
    manager.applyOverrides(overrides);
    return;
  }

  const state: DurableState = { overrides };
  const reload = manager.reload.bind(manager);
  const setProjectTrusted = manager.setProjectTrusted.bind(manager);
  const reapply = (): void => {
    manager.applyOverrides(state.overrides);
  };

  Object.defineProperty(target, DURABLE, { value: state, enumerable: false, configurable: true });
  Object.defineProperty(target, "reload", {
    value: async (): Promise<void> => {
      await reload();
      reapply();
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(target, "setProjectTrusted", {
    value: (trusted: boolean): void => {
      setProjectTrusted(trusted);
      reapply();
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });

  reapply();
}

/** The overrides currently kept durable on `manager`, for tests and diagnostics. */
export function durableOverrides(manager: SettingsManager): EngineSettingsOverrides | undefined {
  return (manager as Wrapped)[DURABLE]?.overrides;
}
