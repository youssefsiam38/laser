/**
 * Prototype mode: the declarative actions, played (M21-T11, D-354).
 *
 * A tree carries flows, and a flow is a trigger plus one of seven actions.
 * There is no script anywhere in a design: click-through flows, dialogs, tabs,
 * empty/loading/error toggles and theme/viewport switches are all expressible
 * as data, and logic — filtering, arithmetic, drag-sort — is what a Sketch is
 * for (`docs/design-phase.md`, "Interactivity: declarative prototypes").
 *
 * The machine is pure: a state, an action, a new state. The surface renders
 * it; nothing here touches the DOM, which is why every transition below is
 * checked by `test/design/prototype.test.ts` rather than by clicking.
 */
import type { DesignAction, DesignBody, DesignFlowEdge } from "@lasercode/protocol";

export interface PrototypeState {
  /** The screen the frame is showing. */
  screenId: string;
  /** The screen drawn on top, when a flow opened one. */
  overlayScreenId?: string;
  /** Per-node interaction state, e.g. `list → loading`. */
  nodeStates: Readonly<Record<string, string>>;
  /** Per-node variant, e.g. `tab → active`. */
  nodeVariants: Readonly<Record<string, string>>;
  theme?: string;
  viewport?: string;
  /** Where the person has been, so `close` and Back have somewhere to go. */
  history: readonly string[];
  /** The last action that was played, for the surface's live region. */
  last?: { action: DesignAction["type"]; said: string };
}

/** Start on the screen a person is looking at, or the design's first one. */
export function startPrototype(body: Pick<DesignBody, "screens">, screenId?: string): PrototypeState {
  const first = screenId ?? body.screens[0]?.id ?? "";
  const screen = body.screens.find((candidate) => candidate.id === first);
  return {
    screenId: first,
    nodeStates: {},
    nodeVariants: {},
    ...(screen?.theme !== undefined ? { theme: screen.theme } : {}),
    ...(screen?.viewport !== undefined ? { viewport: screen.viewport } : {}),
    history: [],
  };
}

function said(action: DesignAction, screenName: (id: string) => string): string {
  switch (action.type) {
    case "navigate":
      return `Went to ${screenName(action.screenId)}.`;
    case "overlay":
      return `Opened ${screenName(action.screenId)} on top.`;
    case "close":
      return "Closed it.";
    case "setState":
      return `${action.nodeId} is now ${action.state}.`;
    case "setVariant":
      return `${action.nodeId} is now ${action.variant}.`;
    case "switchTheme":
      return `Switched to the ${action.theme} theme.`;
    case "switchViewport":
      return `Switched to ${action.viewport}.`;
  }
}

/**
 * Play one action.
 *
 * `close` pops the overlay when there is one and otherwise goes back, which is
 * what a dialog's Cancel and a phone's back gesture both mean. An action that
 * names a screen this design does not have is ignored rather than throwing:
 * the body's own validation already reported it, and a prototype that crashes
 * mid-click teaches nobody anything.
 */
export function applyPrototypeAction(state: PrototypeState, action: DesignAction, body?: Pick<DesignBody, "screens">): PrototypeState {
  const names = new Map((body?.screens ?? []).map((screen) => [screen.id, screen.name]));
  const screenName = (id: string): string => names.get(id) ?? id;
  const known = (id: string): boolean => (body === undefined ? true : names.has(id));
  const last = { action: action.type, said: said(action, screenName) };

  switch (action.type) {
    case "navigate": {
      if (!known(action.screenId)) return state;
      const { overlayScreenId: _overlay, ...rest } = state;
      return { ...rest, screenId: action.screenId, history: [...state.history, state.screenId], last };
    }
    case "overlay": {
      if (!known(action.screenId)) return state;
      return { ...state, overlayScreenId: action.screenId, last };
    }
    case "close": {
      if (state.overlayScreenId !== undefined) {
        const { overlayScreenId: _overlay, ...rest } = state;
        return { ...rest, last };
      }
      const previous = state.history[state.history.length - 1];
      if (previous === undefined) return { ...state, last };
      return { ...state, screenId: previous, history: state.history.slice(0, -1), last };
    }
    case "setState":
      return { ...state, nodeStates: { ...state.nodeStates, [action.nodeId]: action.state }, last };
    case "setVariant":
      return { ...state, nodeVariants: { ...state.nodeVariants, [action.nodeId]: action.variant }, last };
    case "switchTheme":
      return { ...state, theme: action.theme, last };
    case "switchViewport":
      return { ...state, viewport: action.viewport, last };
  }
}

/** The flows that fire for one node (or the screen itself) on one trigger. */
export function flowsFor(
  body: Pick<DesignBody, "flows">,
  where: { screenId: string; nodeId?: string | undefined; trigger: DesignFlowEdge["trigger"] },
): DesignFlowEdge[] {
  return body.flows.filter(
    (flow) =>
      flow.fromScreenId === where.screenId &&
      flow.trigger === where.trigger &&
      (flow.fromNodeId === undefined ? where.nodeId === undefined : flow.fromNodeId === where.nodeId),
  );
}

/** Fire every flow that matches, in the order the design lists them. */
export function triggerPrototype(
  state: PrototypeState,
  body: Pick<DesignBody, "screens" | "flows">,
  where: { nodeId?: string | undefined; trigger: DesignFlowEdge["trigger"] },
): PrototypeState {
  const screenId = state.overlayScreenId ?? state.screenId;
  const flows = flowsFor(body, { screenId, trigger: where.trigger, nodeId: where.nodeId });
  return flows.reduce((current, flow) => applyPrototypeAction(current, flow.action, body), state);
}

/** True when a node has something to do in Prototype mode. */
export function nodeIsInteractive(body: Pick<DesignBody, "flows">, screenId: string, nodeId: string): boolean {
  return body.flows.some((flow) => flow.fromScreenId === screenId && flow.fromNodeId === nodeId);
}

/** Back, for the toolbar. Same rule as `close` with no overlay. */
export function prototypeBack(state: PrototypeState): PrototypeState {
  return applyPrototypeAction(state, { type: "close" });
}

/** The screens a prototype can reach from here, for the "nothing wired" state. */
export function reachableScreens(body: Pick<DesignBody, "flows">, screenId: string): string[] {
  const reachable = new Set<string>();
  for (const flow of body.flows) {
    if (flow.fromScreenId !== screenId) continue;
    if (flow.action.type === "navigate" || flow.action.type === "overlay") reachable.add(flow.action.screenId);
  }
  return [...reachable];
}
