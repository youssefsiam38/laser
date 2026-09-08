/**
 * panels — the declared panel protocol on Pi's event bus (docs/ux-panels.md,
 * "The contract", way 2).
 *
 * Always active. An extension that opts in emits `laser:panel` with a kind,
 * an intent and strict JSON data; this module validates it (refusing anything
 * that smells of presentation), flattens it into a `Panel` and hands it to the
 * worker as `laser/panel/upsert`. `laser:panel:close` retires a panel.
 * When a person presses an action, the worker sends the command back here and
 * it is replayed on `laser:panel:action` for the extension to answer.
 *
 * A terminal Pi has nobody listening on these channels, so emitting costs an
 * unaware host nothing. Delivery is at-least-once (R9): an identical re-emit
 * is dropped here so the wire carries changes, not heartbeats.
 *
 * The fallback (setWidget → stream, setStatus → ambient, dialogs → decision)
 * is deliberately NOT here: Pi hands every extension its own `ctx.ui`, so the
 * only place that sees all of them is the worker's ui-bridge, and the client
 * derives the fallback panels from the `pi/ui/*` stream it already receives
 * (`@lasercode/ui` src/panels/fallback.ts).
 */
import {
  PANEL_ACTION_EVENT,
  PANEL_CLOSE_EVENT,
  PANEL_EVENT,
  validatePanelClose,
  validatePanelEvent,
  type PanelActionEvent,
} from "@lasercode/protocol";
import type { LaserModule } from "./index.js";

/** Ids remembered for dedupe and for answering "is anyone still holding this panel?". */
const MAX_KNOWN = 1000;

export const panelsModule: LaserModule = {
  name: "panels",
  detect: () => true,
  activate({ pi, send, commands, panels }) {
    /** id → last serialized panel, so an identical re-emit is not re-sent. */
    const known = new Map<string, string>();

    const remember = (id: string, serialized: string): void => {
      if (!known.has(id) && known.size >= MAX_KNOWN) {
        const oldest = known.keys().next().value;
        if (oldest !== undefined) known.delete(oldest);
      }
      known.set(id, serialized);
    };

    const warn = (message: string): void =>
      send({ type: "lasercode/module/log", module: "panels", level: "warn", message });

    const offPanel = pi.events.on(PANEL_EVENT, (raw) => {
      const result = validatePanelEvent(raw);
      if (!result.ok) {
        warn(`ignored a ${PANEL_EVENT} event — ${result.error}`);
        return;
      }
      const serialized = JSON.stringify(result.panel);
      if (known.get(result.panel.id) === serialized) return;
      remember(result.panel.id, serialized);
      send({ type: "lasercode/panel/upsert", panel: result.panel });
    });

    const offClose = pi.events.on(PANEL_CLOSE_EVENT, (raw) => {
      const result = validatePanelClose(raw);
      if (!result.ok) {
        warn(`ignored a ${PANEL_CLOSE_EVENT} event — ${result.error}`);
        return;
      }
      // Forwarded even for an id we never saw: the host may hold it from a
      // previous activation, and a close nobody needed is harmless.
      known.delete(result.event.id);
      send({
        type: "lasercode/panel/close",
        id: result.event.id,
        ...(result.event.reason !== undefined ? { reason: result.event.reason } : {}),
      });
    });

    const offCommand = commands?.on((command) => {
      if (command.type !== "lasercode/panel/action") return false;
      // A panel may have been declared by the host — it persists agent runs
      // and can show them for sessions with no extension — and another module
      // in this process can still answer for it. Replaying is
      // safe (nothing listens for an id nobody owns), and `handled` stays
      // honest by asking who claimed the namespace rather than the cache.
      const mine = known.has(command.id);
      if (!mine && !panels?.claimed(command.id)) return false;
      const event: PanelActionEvent = {
        id: command.id,
        actionId: command.actionId,
        ...(command.value !== undefined ? { value: command.value } : {}),
      };
      pi.events.emit(PANEL_ACTION_EVENT, event);
      return true;
    });

    return () => {
      offPanel();
      offClose();
      offCommand?.();
      known.clear();
    };
  },
};
