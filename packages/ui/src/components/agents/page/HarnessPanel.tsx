"use client";
/**
 * The harness policy: how deep agents may nest, and how long a foreground
 * command runs before it becomes a background task. Two numbers, each saved
 * on its own the moment it is committed.
 */
import type { AgentPolicy, AgentsSnapshot } from "@lasercode/protocol";
import { SlidersHorizontal } from "lucide-react";
import { useEffect, useId, useState, type KeyboardEvent } from "react";

import { useAgentsActions } from "@/agents";
import { AgentCard } from "@/components/assistant-ui/elements/agent-card";
import { GenerationLoader } from "@/components/assistant-ui/elements/loading-state";
import { Input } from "@/components/ui/input";

import { Hint, IssueNotice, Section } from "./fields.js";
import { POLICY_LIMITS, checkRange } from "./model.js";

export function HarnessPanel({ snapshot }: { snapshot: AgentsSnapshot }) {
  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-6 px-4 py-5 md:px-6">
      <AgentCard
        name="Harness"
        eyebrow="Limits for every agent"
        icon={<SlidersHorizontal />}
        description="These apply to every agent that starts another. A child runs in its own session and worktree in the background; the limits keep a tree of agents from running away."
        facts={[
          { label: "depth", value: `${snapshot.policy.maxDepth} level${snapshot.policy.maxDepth === 1 ? "" : "s"}`, typed: true },
          { label: "commands", value: `${snapshot.policy.foregroundCommandSeconds} s in the foreground`, typed: true },
        ]}
      />
      <PolicyField
        id="maxDepth"
        title="Maximum nesting depth"
        description="How many levels of agents may start agents. A top-level session's children are depth 1; their children depth 2. Deeper trees cost more and are harder to follow."
        unit="levels"
        limits={POLICY_LIMITS.maxDepth}
        value={snapshot.policy.maxDepth}
      />
      <PolicyField
        id="foregroundCommandSeconds"
        title="Foreground command seconds"
        description="A command an agent runs in the foreground is moved to a background task after this long, so a slow build never freezes the turn. Agents can also choose to run a command in the background from the start."
        unit="seconds"
        limits={POLICY_LIMITS.foregroundCommandSeconds}
        value={snapshot.policy.foregroundCommandSeconds}
      />
    </div>
  );
}

function PolicyField({
  id,
  title,
  description,
  unit,
  limits,
  value,
}: {
  id: keyof AgentPolicy;
  title: string;
  description: string;
  unit: string;
  limits: { min: number; max: number };
  value: number;
}) {
  const agents = useAgentsActions();
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const inputId = useId();
  useEffect(() => setText(String(value)), [value]);

  const commit = async () => {
    const result = checkRange(text, limits, unit);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(undefined);
    if (result.value === value) return;
    setSaving(true);
    try {
      await agents.setPolicy({ [id]: result.value });
    } finally {
      setSaving(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
    }
  };

  return (
    <Section id={`policy-${id}`} title={title} description={description} notices={<IssueNotice messages={error ? [error] : []} />}>
      <label htmlFor={inputId} className="flex items-center gap-2 text-sm text-ink">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={limits.min}
          max={limits.max}
          value={text}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          data-policy={id}
          className="w-28 tnum"
          onChange={(event) => setText(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={onKeyDown}
        />
        {unit}
        {saving ? <GenerationLoader label="Saving" layout="inline" /> : null}
      </label>
      <Hint>
        Between {limits.min} and {limits.max}. Saved when you leave the field.
      </Hint>
    </Section>
  );
}
