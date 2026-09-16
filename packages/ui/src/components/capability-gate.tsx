"use client";
import type { ClientMethod } from "@lasercode/protocol";
import type { ReactNode } from "react";

import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
import { useCapability, type CapabilityRequirements } from "@/runtime";

export function CapabilityNotice({ explanation, title = "Changes are unavailable here" }: { explanation: string; title?: string | undefined }) {
  return <GuardrailNotice title={title} explanation={explanation} />;
}

/**
 * Keep readable settings visible while the authenticated environment removes
 * their write authority. Native controls are disabled as one group and the
 * existing guardrail element explains where the change can be made.
 */
export function CapabilityGate({
  method,
  requirements,
  children,
  title,
}: {
  method: ClientMethod;
  requirements?: CapabilityRequirements | undefined;
  children: ReactNode;
  title?: string | undefined;
}) {
  const capability = useCapability(method, { ...requirements, presentation: "explained" });
  if (capability.state === "hidden") return null;
  if (capability.state === "available") return children;
  return (
    <>
      <div className="p-4 pb-0">
        <CapabilityNotice title={title} explanation={capability.explanation ?? "This action is not available in this environment."} />
      </div>
      <fieldset disabled className="contents">
        {children}
      </fieldset>
    </>
  );
}
