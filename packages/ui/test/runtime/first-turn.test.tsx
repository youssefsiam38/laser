// @vitest-environment happy-dom
/**
 * The tentative first-turn choice and its leave boundary (M13-T89 U2): the
 * choice is one composer's, for as long as that composer's session is the one
 * on screen, and discarding it touches nothing else the composer holds.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardFirstTurn,
  effectiveFirstTurnModel,
  firstTurnFromRunConfig,
  useDiscardFirstTurnOnLeave,
  withFirstTurn,
  withoutFirstTurn,
  type FirstTurnComposer,
} from "../../src/runtime/first-turn.js";

type RunConfig = Parameters<typeof withoutFirstTurn>[0];

function fakeComposer(runConfig: RunConfig): FirstTurnComposer & { runConfig: RunConfig; writes: number } {
  const composer = {
    runConfig,
    writes: 0,
    getState: () => ({ runConfig: composer.runConfig }) as ReturnType<FirstTurnComposer["getState"]>,
    setRunConfig: vi.fn((next: RunConfig) => {
      composer.writes += 1;
      composer.runConfig = next;
    }),
  };
  return composer;
}

describe("first-turn model intent", () => {
  const sessionModel = { provider: "test", id: "session" };
  const agentModel = { provider: "test", id: "agent" };
  const projectDefault = { provider: "test", id: "default" };

  it("preserves absent, follow-agent, and later explicit model intent", () => {
    expect(firstTurnFromRunConfig(withFirstTurn(undefined, { agentName: "reviewer" })))
      .toEqual({ agentName: "reviewer" });
    expect(firstTurnFromRunConfig(withFirstTurn(undefined, { agentName: "reviewer", model: null })))
      .toEqual({ agentName: "reviewer", model: null });
    const explicit = { provider: "test", id: "manual", name: "Manual" };
    expect(firstTurnFromRunConfig(withFirstTurn(undefined, { agentName: "reviewer", model: explicit })))
      .toEqual({ agentName: "reviewer", model: explicit });
    expect(firstTurnFromRunConfig({ custom: { firstTurn: { agentName: "reviewer", model: {} } } })).toBeUndefined();
  });

  it("resolves the visible model from the same intent contract", () => {
    expect(effectiveFirstTurnModel({ agentName: "reviewer" }, sessionModel, agentModel, projectDefault)).toEqual(sessionModel);
    expect(effectiveFirstTurnModel({ agentName: "reviewer" }, null, agentModel, projectDefault)).toEqual(agentModel);
    expect(effectiveFirstTurnModel({ agentName: "reviewer", model: null }, sessionModel, agentModel, projectDefault)).toEqual(agentModel);
    expect(effectiveFirstTurnModel({ agentName: "reviewer", model: null }, sessionModel, null, projectDefault)).toEqual(projectDefault);
    expect(effectiveFirstTurnModel({ agentName: "reviewer", model: { provider: "test", id: "manual" } }, sessionModel, agentModel, projectDefault))
      .toEqual({ provider: "test", id: "manual" });
  });
});

describe("withoutFirstTurn", () => {
  it("removes only the choice and keeps every other field", () => {
    const config = withFirstTurn({ custom: { retained: "yes", streamingBehavior: "prompt" } }, { agentName: "reviewer", thinkingLevel: "high" });
    const next = withoutFirstTurn(config);
    expect(firstTurnFromRunConfig(next)).toBeUndefined();
    expect(next.custom).toEqual({ retained: "yes", streamingBehavior: "prompt" });
    expect("firstTurn" in (next.custom ?? {})).toBe(false);
  });

  it("is a no-op shape on an empty config", () => {
    expect(withoutFirstTurn(undefined)).toEqual({ custom: {} });
  });
});

describe("discardFirstTurn", () => {
  it("writes once when a choice is held and not at all when none is", () => {
    const holding = fakeComposer(withFirstTurn({ custom: { retained: "yes" } }, { agentName: "reviewer" }));
    expect(discardFirstTurn(holding)).toBe(true);
    expect(holding.writes).toBe(1);
    expect(firstTurnFromRunConfig(holding.runConfig)).toBeUndefined();
    expect(holding.runConfig?.custom?.["retained"]).toBe("yes");

    const empty = fakeComposer({ custom: { retained: "yes" } });
    expect(discardFirstTurn(empty)).toBe(false);
    expect(empty.writes).toBe(0);
  });
});

describe("useDiscardFirstTurnOnLeave", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function Bound({ composer, bound }: { composer: FirstTurnComposer; bound: boolean }) {
    useDiscardFirstTurnOnLeave(composer, bound);
    return null;
  }

  it("discards the choice of the composer that was left, and only that one", async () => {
    const left = fakeComposer(withFirstTurn({ custom: { retained: "yes" } }, { agentName: "reviewer", thinkingLevel: "high" }));
    const arrived = fakeComposer(withFirstTurn(undefined, { agentName: "reviewer", thinkingLevel: "low" }));
    await act(async () => root.render(<><Bound composer={left} bound /><Bound composer={arrived} bound={false} /></>));
    expect(left.writes).toBe(0);

    // The switch: the first composer's session is no longer on screen, the second's is.
    await act(async () => root.render(<><Bound composer={left} bound={false} /><Bound composer={arrived} bound /></>));
    expect(firstTurnFromRunConfig(left.runConfig)).toBeUndefined();
    expect(left.runConfig?.custom?.["retained"]).toBe("yes");
    expect(left.writes).toBe(1);
    // Becoming bound clears nothing: the composer the person arrived at keeps its choice.
    expect(firstTurnFromRunConfig(arrived.runConfig)).toEqual({ agentName: "reviewer", thinkingLevel: "low" });
    expect(arrived.writes).toBe(0);
  });

  it("discards on unmount and stays quiet when there is nothing to discard", async () => {
    const holding = fakeComposer(withFirstTurn(undefined, { agentName: "reviewer" }));
    const empty = fakeComposer({ custom: { retained: "yes" } });
    await act(async () => root.render(<><Bound composer={holding} bound /><Bound composer={empty} bound /></>));
    await act(async () => root.render(null));
    expect(firstTurnFromRunConfig(holding.runConfig)).toBeUndefined();
    expect(holding.writes).toBe(1);
    expect(empty.writes).toBe(0);
  });

  it("survives a composer that is already gone", async () => {
    const gone: FirstTurnComposer = {
      getState: () => { throw new Error("Composer is not available"); },
      setRunConfig: () => { throw new Error("Composer is not available"); },
    };
    await act(async () => root.render(<Bound composer={gone} bound />));
    await expect(act(async () => root.render(<Bound composer={gone} bound={false} />))).resolves.toBeUndefined();
  });
});
