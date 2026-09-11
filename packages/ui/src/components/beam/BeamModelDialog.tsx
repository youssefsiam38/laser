import type { AgentModelChoice, ModelRef } from "@lasercode/protocol";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useAgentsActions, useAgentsSnapshot, useBeamChoice } from "@/agents";
import { ErrorState } from "@/components/assistant-ui/elements/error-state";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { ModelPickerDialogPortal, ProviderModelPicker, modelOptionId } from "@/components/assistant-ui/elements/model-selector";
import { narrowToConnected } from "@/components/assistant-ui/elements/connected-models";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLaserStable } from "@/runtime";

import { BEAM_PURPOSE } from "./beam-model.js";

type Catalog = { models: ModelRef[] } | { error: string } | null;

/**
 * "Choose Beam's model": opened once by the store when the host says the
 * first provider is connected and Beam has no model (`agents/beam/choose-model`,
 * held as `agents.chooseBeamModel`), and again from the Beam empty state
 * while the choice is still pending. The picker is the catalog's
 * `model-selector` (provider first), preselected to the host's suggestion.
 *
 * "Use this model" saves through `actions.agents.setBuiltinModel`, which clears
 * the pending choice on success; "Later" only clears it here — Beam follows
 * the default model until a model is chosen on the Agents page.
 */
export function BeamModelDialog() {
  const choice = useBeamChoice();
  const snapshot = useAgentsSnapshot();
  const agents = useAgentsActions();
  const { client } = useLaserStable();
  const open = choice !== null;
  const cwd = snapshot?.workspaces.beam;
  const suggested: AgentModelChoice | null = choice?.suggested ?? snapshot?.beam.suggested ?? null;

  const [catalog, setCatalog] = useState<Catalog>(null);
  const [attempt, setAttempt] = useState(0);
  const [value, setValue] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(0);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);

  // The catalog, narrowed to providers that are signed in — a model nobody
  // can call is not offered. The providers list failing is not fatal: the
  // enabled catalog still stands.
  useEffect(() => {
    if (!open || !cwd) return;
    let live = true;
    setCatalog(null);
    void Promise.all([
      client.request("pi/models/catalog", { cwd }),
      client.request("pi/providers/list", { cwd }).then(({ providers }) => providers, () => undefined),
    ])
      .then(([result, providers]) => {
        if (!live) return;
        setCatalog({ models: narrowToConnected(result.models, providers).models });
      })
      .catch((error: unknown) => {
        if (live) setCatalog({ error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [attempt, client, cwd, open]);

  // Preselect the suggestion every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setValue(suggested ? modelOptionId(suggested) : undefined);
    setSaveError(undefined);
  }, [open, suggested]);

  // The suggestion is offered even when the narrowed list lacks it: it is
  // the host's own recommendation, and the person can still say no.
  const models = useMemo<ModelRef[]>(() => {
    const list = catalog && "models" in catalog ? [...catalog.models] : [];
    if (suggested && !list.some((model) => modelOptionId(model) === modelOptionId(suggested))) list.unshift(suggested);
    return list;
  }, [catalog, suggested]);
  const chosen = value ? models.find((model) => modelOptionId(model) === value) : undefined;
  const recommended = suggested !== null && value === modelOptionId(suggested);

  const later = () => agents.dismissBeamChoice();
  const use = async () => {
    if (!chosen) return;
    setSaving(true);
    setSaveError(undefined);
    await agents.setBuiltinModel("beam", { provider: chosen.provider, id: chosen.id });
    setSaving(false);
    setSaved((n) => n + 1);
  };
  // `setBuiltinModel` settles either way: success clears the pending choice and
  // this dialog with it; a failure toasts and leaves the choice open. Say it
  // here too, where the person is looking, rather than only in a corner.
  useEffect(() => {
    if (saved === 0) return;
    if (choice !== null) setSaveError("The choice could not be saved. Beam keeps the default model for now — try again, or choose later on the Agents page.");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per save attempt
  }, [saved]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && later()}>
      <DialogContent data-slot="beam-model-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-live" />
            Choose Beam’s model
          </DialogTitle>
          <DialogDescription>{BEAM_PURPOSE}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="eyebrow">Model</span>
            {recommended && (
              <Badge variant="live" data-slot="beam-model-recommended">
                Recommended
              </Badge>
            )}
          </div>
          {catalog && "error" in catalog ? (
            <ErrorState title="Couldn’t load the model list" detail={catalog.error} onRetry={() => setAttempt((n) => n + 1)} retryLabel="Try again" />
          ) : catalog === null ? (
            <div className="flex h-8 items-center px-1">
              <GenerationLoader label="Loading models" layout="inline" />
            </div>
          ) : models.length === 0 ? (
            <p className="rounded-lg border border-line px-3 py-3 text-sm text-ink-2">
              No models to choose from yet. Sign in to a provider in Settings, and Beam’s choice comes back here.
            </p>
          ) : (
            <ProviderModelPicker models={models} {...(value ? { value } : {})} onValueChange={setValue} disabled={saving} className="max-w-none" container={portalContainer} />
          )}
          {!recommended && suggested && chosen && (
            <p className="text-xs leading-xs text-ink-3">
              Recommended: <span className="typed text-ink-2">{suggested.id}</span>
              <Button variant="link" size="xs" className="ms-1 text-xs" onClick={() => setValue(modelOptionId(suggested))}>
                Use the recommendation
              </Button>
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-xs leading-xs text-danger">
              {saveError}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={later} disabled={saving} data-slot="beam-model-later">
            Later
          </Button>
          <Button onClick={() => void use()} disabled={!chosen || saving} data-slot="beam-model-use">
            {saving ? "Saving…" : "Use this model"}
          </Button>
        </DialogFooter>
        <ModelPickerDialogPortal ref={setPortalContainer} />
      </DialogContent>
    </Dialog>
  );
}
