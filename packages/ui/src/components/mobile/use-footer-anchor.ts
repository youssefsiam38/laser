import { useEffect, useState } from "react";

export interface FooterAnchor {
  /** px from the bottom of the layout viewport to the footer's top edge. */
  bottom: number;
  /** The footer's horizontal extent, so a strip can align with the composer column. */
  left: number;
  width: number;
}

const NONE: FooterAnchor = { bottom: 0, left: 0, width: 0 };

/**
 * Where the thread footer (composer + its cards) sits in the layout viewport. Islands and notices on a phone sit
 * directly above the composer (docs/ux-panels.md), and the footer already
 * rides the keyboard and the safe area, so anchoring to it is what keeps them
 * visible when the keyboard is up.
 *
 * Observed, not computed: the footer's height changes with queue chips,
 * attachments, extension cards and the keyboard inset.
 */
export function useFooterAnchor(selector = '[data-slot="thread-footer"]'): FooterAnchor {
  const [anchor, setAnchor] = useState<FooterAnchor>(NONE);

  useEffect(() => {
    let footer: Element | null = null;
    let resize: ResizeObserver | undefined;
    let raf = 0;

    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!footer) {
          setAnchor(NONE);
          return;
        }
        const rect = footer.getBoundingClientRect();
        const next: FooterAnchor = {
          bottom: Math.max(0, Math.round(window.innerHeight - rect.top)),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
        };
        setAnchor((cur) => (cur.bottom === next.bottom && cur.left === next.left && cur.width === next.width ? cur : next));
      });
    };

    const attach = () => {
      const next = document.querySelector(selector);
      if (next === footer) return;
      resize?.disconnect();
      footer = next;
      if (footer && typeof ResizeObserver !== "undefined") {
        resize = new ResizeObserver(measure);
        resize.observe(footer);
      }
      measure();
    };

    attach();
    // The thread may mount after us, or be replaced on a session switch.
    const mutations = new MutationObserver(attach);
    mutations.observe(document.body, { childList: true, subtree: true });
    const vv = window.visualViewport;
    vv?.addEventListener("resize", measure);
    vv?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);

    return () => {
      cancelAnimationFrame(raf);
      mutations.disconnect();
      resize?.disconnect();
      vv?.removeEventListener("resize", measure);
      vv?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [selector]);

  return anchor;
}
