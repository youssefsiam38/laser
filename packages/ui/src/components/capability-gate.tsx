"use client";
import { GuardrailNotice } from "@/components/assistant-ui/elements/guardrail-notice";
export function CapabilityNotice({ explanation, title = "Changes are unavailable here" }: { explanation: string; title?: string | undefined }) {
  return <GuardrailNotice title={title} explanation={explanation} />;
}
