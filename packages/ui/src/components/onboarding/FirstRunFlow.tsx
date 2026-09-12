"use client";
/**
 * First run (M10-T6): a person opens the app for the first time and, without
 * leaving the window, connects a provider, signs in, picks a model, opens a
 * project and lands in a session. Five steps in the thread column where the
 * conversation will be, resumable after a quit, skippable at every step.
 *
 * What is remembered where:
 *   - whether setup finished: the host (`pi/setup/state`), so it is the same
 *     on every device and survives a cleared browser;
 *   - the step the person was on: this device, so Back works after a reload;
 *   - the facts (a provider signed in, a default model, a project): read from
 *     the host on every open and never assumed, so a step done elsewhere is
 *     not asked again and a credential removed since is asked for again.
 *
 * Provider and model settings are global but every settings method is routed
 * by directory, so before a project exists they go through the directory the
 * host owns for that purpose (`SetupState.cwd`). The last step is the
 * finish line: one card in the same frame as every other step, whose action
 * starts the first session. It never describes a screen that is not on show —
 * a second "1 of 3" tour about a composer the person cannot see yet was the
 * app talking about itself instead of opening.
 */
import { PRODUCT_NAME } from "@lasercode/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, MessageSquare } from "lucide-react";

import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { modKey, shortCwd } from "@/format";
import { useLaserStable, useLaserState } from "@/runtime";
import type { SetupState } from "@lasercode/protocol";

import { ModelStep } from "./ModelStep.js";
import { ProjectStep } from "./ProjectStep.js";
import { ProviderStep } from "./ProviderStep.js";
import { SetupCard } from "./SetupCard.js";
import {
  SETUP_STEPS,
  STEP_TITLES,
  nextStep,
  previousStep,
  readRememberedStep,
  rememberStep,
  resumeStep,
  stepIndex,
  type SetupStep,
} from "./setup-model.js";

// --- state -------------------------------------------------------------------

export interface SetupPending {
  /** `undefined` until the host answers; `false` when setup finished or the host has no setup state. */
  pending: boolean | undefined;
  state: SetupState | undefined;
  complete: (completed: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Whether first-run setup still needs doing, from the host. A host that does
 * not answer `pi/setup/state` (an older one) counts as nothing pending, so the
 * app never blocks on a screen it cannot finish.
 */
export function useSetupPending(): SetupPending {
  const { client } = useLaserStable();
  const connection = useLaserState((s) => s.connection);
  const [state, setState] = useState<SetupState>();
  const [unsupported, setUnsupported] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await client.request("pi/setup/state", {}));
      setUnsupported(false);
    } catch {
      setUnsupported(true);
    }
  }, [client]);

  useEffect(() => {
    if (connection === "open") void refresh();
  }, [connection, refresh]);

  const complete = useCallback(
    async (completed: boolean) => {
      try {
        setState(await client.request("pi/setup/complete", { completed }));
      } catch {
        setUnsupported(true);
      }
    },
    [client],
  );

  return useMemo(
    () => ({ pending: unsupported ? false : state ? !state.completed : undefined, state, complete, refresh }),
    [complete, refresh, state, unsupported],
  );
}

// --- the flow -----------------------------------------------------------------

export interface FirstRunFlowProps {
  setup: SetupPending;
  /** Called after Finish, Skip, or the first session is started. */
  onFinished?: (() => void) | undefined;
}

/**
 * The steps that count. `welcome` and `ready` are bookends — one explains what
 * is about to happen, the other is the finish line — so counting them would
 * make the eyebrow disagree with the sentence beside it ("Three short steps",
 * "1 of 5"). The dots and the counter track the three things a person actually
 * does; `stepIndex` still owns navigation across all five.
 */
const COUNTED_STEPS: readonly SetupStep[] = ["provider", "model", "project"];
const TITLES = COUNTED_STEPS.map((step) => STEP_TITLES[step]);
const countedIndex = (step: SetupStep): number => COUNTED_STEPS.indexOf(step);

export function FirstRunFlow({ setup, onFinished }: FirstRunFlowProps) {
  const { actions, client, projects, currentProject } = useLaserStable();
  const [step, setStep] = useState<SetupStep>();
  const [providersConfigured, setProvidersConfigured] = useState<number>();
  const [defaultModel, setDefaultModel] = useState<string>();
  const [modelKnown, setModelKnown] = useState(false);
  const [projectCwd, setProjectCwd] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [confirmSkip, setConfirmSkip] = useState(false);
  /** A provider sign-in is on screen and owns its own Continue. */
  const [signingIn, setSigningIn] = useState(false);
  const cwd = setup.state?.cwd;

  // Land on the right step once the facts are in: ask the host what is
  // already done before choosing, so a quit halfway resumes where the work
  // actually stands. When the host cannot answer, the remembered step wins.
  useEffect(() => {
    if (step !== undefined || !cwd) return undefined;
    let cancelled = false;
    const remembered = readRememberedStep();
    void (async () => {
      let facts = { providersConfigured: undefined as number | undefined, hasDefaultModel: undefined as boolean | undefined, projects: projects.length };
      try {
        const [providerResult, catalog] = await Promise.all([
          client.request("pi/providers/list", { cwd }),
          client.request("pi/models/catalog", { cwd }),
        ]);
        const configured = providerResult.providers.filter((p) => p.configured).length;
        const ref = catalog.defaultProvider && catalog.defaultModel ? `${catalog.defaultProvider}/${catalog.defaultModel}` : undefined;
        facts = { providersConfigured: configured, hasDefaultModel: ref !== undefined, projects: projects.length };
        if (!cancelled) {
          setProvidersConfigured(configured);
          setDefaultModel(ref);
          setModelKnown(true);
        }
      } catch {
        // The worker for the setup directory did not answer; the steps ask again themselves.
      }
      if (!cancelled) setStep(resumeStep(facts, remembered));
    })();
    return () => {
      cancelled = true;
    };
    // Only when the flow first learns its directory; `projects.length` is read then, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cwd, step]);

  useEffect(() => {
    if (step) rememberStep(step);
  }, [step]);

  const go = (next: SetupStep) => setStep(next);

  const finish = useCallback(async () => {
    rememberStep(undefined);
    await setup.complete(true);
    onFinished?.();
  }, [onFinished, setup]);

  const startSession = useCallback(async () => {
    const target = projectCwd ?? currentProject ?? projects[0];
    if (!target) {
      go("project");
      return;
    }
    setStarting(true);
    setStartError(undefined);
    try {
      await actions.newSession(target);
      await finish();
    } catch (sessionError) {
      setStartError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setStarting(false);
    }
  }, [actions, currentProject, finish, projectCwd, projects]);

  const onConfigured = useCallback((count: number) => setProvidersConfigured(count), []);
  const onChosen = useCallback((ref: string | undefined) => {
    setDefaultModel(ref);
    setModelKnown(true);
  }, []);

  if (!cwd || step === undefined) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-8">
        <GenerationLoader label="Getting ready" layout="inline" />
      </div>
    );
  }

  const index = countedIndex(step);
  // Skipping is a one-way door in the sense that matters: the flow never comes
  // back on its own. So it asks first, and the answer names where to find it
  // again — Settings → This device — rather than leaving a new person to work
  // out that a ghost button on the welcome screen was the whole onboarding.
  const skip = () => setConfirmSkip(true);
  const card = (title: string, description: string | undefined, body: React.ReactNode, actionsNode: React.ReactNode) => (
    <SetupCard
      index={index}
      total={COUNTED_STEPS.length}
      titles={TITLES}
      title={title}
      description={description}
      actions={actionsNode}
      onStepChange={(i) => go(COUNTED_STEPS[i] ?? "welcome")}
      onSkip={skip}
    >
      {body}
    </SetupCard>
  );
  const back = (
    <Button variant="ghost" size="sm" onClick={() => go(previousStep(step))} aria-label="Previous step">
      <ArrowLeft className="rtl:-scale-x-100" /> Back
    </Button>
  );
  const next = (enabled: boolean, label = "Continue") => (
    <Button size="sm" disabled={!enabled} onClick={() => go(nextStep(step))}>
      {label} <ArrowRight className="rtl:-scale-x-100" />
    </Button>
  );

  const skipDialog = (
    <Dialog open={confirmSkip} onOpenChange={setConfirmSkip}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Skip setting up?</DialogTitle>
          <DialogDescription>
            {PRODUCT_NAME} cannot run an agent until a provider is connected and a project is open, so the app will be mostly empty
            until you do those two things yourself. You can start this again any time from Settings → This device → Run setup
            again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" autoFocus onClick={() => setConfirmSkip(false)}>
            Keep setting up
          </Button>
          <Button
            type="button"
            onClick={() => {
              setConfirmSkip(false);
              void finish();
            }}
          >
            Skip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 py-8 sm:items-center">
      {skipDialog}
      {step === "welcome" &&
        card(
          STEP_TITLES.welcome,
          "A place to run and watch coding agents across every project you have — from this window, and from your phone. Three short steps and you are talking to one.",
          <ul className="flex flex-col gap-1.5 text-sm leading-6 text-ink-2">
            <li>
              <span className="font-medium text-ink">Connect a provider.</span> Sign in with an account you already have, or paste an API key.
            </li>
            <li>
              <span className="font-medium text-ink">Choose a model.</span> The one new sessions start with; you can change it any time.
            </li>
            <li>
              <span className="font-medium text-ink">Open a project.</span> A folder on this computer the agent will work in.
            </li>
          </ul>,
          next(true, "Set up"),
        )}

      {step === "provider" &&
        card(
          STEP_TITLES.provider,
          "The company whose models the agent will use. Sign in with an account you already have, or paste an API key. You can add more later in Settings.",
          <ProviderStep cwd={cwd} onConfigured={onConfigured} onBusyChange={setSigningIn} />,
          <>
            {back}
            {!signingIn && next((providersConfigured ?? 0) > 0)}
          </>,
        )}

      {step === "model" &&
        card(
          STEP_TITLES.model,
          "What a new session starts with. Each session can switch models as it goes; this is only the starting point.",
          <ModelStep cwd={cwd} onChosen={onChosen} />,
          <>
            {back}
            {next(defaultModel !== undefined)}
          </>,
        )}

      {step === "project" &&
        card(
          STEP_TITLES.project,
          "A folder on this computer the agent works in. Every session you start there, and every session already saved for it, shows up in the sessions panel.",
          <ProjectStep
            onAdded={(added) => {
              setProjectCwd(added);
              go("ready");
            }}
          />,
          <>
            {back}
            {projects.length > 0 && next(true, `Continue with ${shortCwd(projectCwd ?? currentProject ?? projects[0] ?? "")}`)}
          </>,
        )}

      {step === "ready" && (
        <SetupCard
          index={index}
          total={COUNTED_STEPS.length}
          titles={TITLES}
          title={STEP_TITLES.ready}
          description={`A provider is connected, a model is chosen, and the folder ${shortCwd(projectCwd ?? currentProject ?? projects[0] ?? "")} is open. Everything else is in the app: features, more providers, keyboard shortcuts and how it looks.`}
          actions={
            <>
              {back}
              <Button variant="ghost" size="sm" onClick={() => void finish()}>
                Not now
              </Button>
              <Button size="sm" disabled={starting} onClick={() => void startSession()}>
                {starting ? "Starting…" : "Start a session"} <MessageSquare />
              </Button>
            </>
          }
        >
          <ul className="flex flex-col gap-1.5 text-sm leading-6 text-ink-2">
            <li>
              <span className="font-medium text-ink">Type and press Enter.</span> While it works, Enter steers it mid-turn and {modKey()}+Enter queues a
              follow-up for after.
            </li>
            <li>
              <span className="font-medium text-ink">Every project in one list.</span> The sessions that need you sort to the top, across all of them.
            </li>
            <li>
              <span className="font-medium text-ink">Nothing needs a terminal.</span> The gear in the rail opens settings, features and providers.
            </li>
          </ul>
          {startError && <ErrorState title="Could not start a session" detail={startError} onRetry={() => void startSession()} retryLabel="Try again" />}
        </SetupCard>
      )}
    </div>
  );
}
