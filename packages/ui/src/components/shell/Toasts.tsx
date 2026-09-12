import { namespaced } from "@lasercode/protocol";
import type * as React from "react";
import { useEffect, useRef } from "react";
import { CircleX, Info, TriangleAlert } from "lucide-react";
import { Toaster, toast } from "sonner";

import { useIsMobile, useTheme } from "@/hooks";
import { useToasts } from "@/runtime";
import { useDirection } from "@/hooks/use-direction";

/**
 * Bridges the reducer's toast queue (extension `notify`, failed requests,
 * worker crashes) into sonner, then drops each entry from the store so the
 * queue never grows. Styled through sonner's CSS variables so both themes use
 * the design tokens rather than sonner's defaults.
 */
export function Toasts() {
  const { toasts, dismiss } = useToasts();
  const { theme } = useTheme();
  const isMobile = useIsMobile();
  const direction = useDirection();
  const shown = useRef(new Set<number>());

  useEffect(() => {
    for (const t of toasts) {
      if (shown.current.has(t.id)) continue;
      shown.current.add(t.id);
      const show = t.level === "error" ? toast.error : t.level === "warning" ? toast.warning : toast.info;
      show(t.text, { id: namespaced(String(t.id)), duration: t.level === "error" ? 8000 : 4000 });
      dismiss(t.id);
    }
  }, [toasts, dismiss]);

  return (
    <Toaster
      theme={theme}
      position={isMobile ? "top-center" : direction === "rtl" ? "bottom-left" : "bottom-right"}
      dir={direction}
      closeButton
      visibleToasts={4}
      gap={8}
      offset={16}
      mobileOffset={{ top: "calc(env(safe-area-inset-top) + 56px)", left: 12, right: 12 }}
      className="font-sans"
      icons={{
        info: <Info className="size-4 text-live" />,
        warning: <TriangleAlert className="size-4 text-attention" />,
        error: <CircleX className="size-4 text-danger" />,
      }}
      toastOptions={{
        classNames: {
          toast: "font-sans text-sm leading-sm shadow-float! rounded-xl! border-line! items-start!",
          title: "font-medium text-ink",
          description: "text-ink-2",
          closeButton: "bg-surface! border-line! text-ink-2! hover:bg-surface-2! hover:text-ink!",
          icon: "mt-px",
        },
      }}
      style={
        {
          "--normal-bg": "var(--surface)",
          "--normal-bg-hover": "var(--surface)",
          "--normal-border": "var(--line)",
          "--normal-border-hover": "var(--line)",
          "--normal-text": "var(--ink)",
          "--error-bg": "var(--surface)",
          "--error-border": "color-mix(in oklab, var(--danger) 45%, var(--line))",
          "--error-text": "var(--ink)",
          "--warning-bg": "var(--surface)",
          "--warning-border": "color-mix(in oklab, var(--attention) 45%, var(--line))",
          "--warning-text": "var(--ink)",
          "--info-bg": "var(--surface)",
          "--info-border": "var(--line)",
          "--info-text": "var(--ink)",
          "--border-radius": "12px",
          "--width": "340px",
        } as React.CSSProperties
      }
    />
  );
}
