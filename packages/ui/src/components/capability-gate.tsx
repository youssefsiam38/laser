"use client";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
export function CapabilityNotice({ explanation, title = "Changes are unavailable here" }: { explanation: string; title?: string | undefined }) {
  return <div data-slot="capability-notice"><GuardrailNotice title={title} explanation={explanation} /></div>;
}
