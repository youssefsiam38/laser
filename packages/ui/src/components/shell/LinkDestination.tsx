import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/** Browser-like chrome, not a content preview: never fetch a hovered URL.
 * Document delegation also covers links in portalled dialogs and streamed text. */
export function LinkDestination() {
  const [destination, setDestination] = useState("");
  useEffect(() => {
    let anchor: Element | null = null;
    const clear = () => { anchor = null; setDestination(""); observer.disconnect(); };
    const update = () => {
      if (!anchor?.isConnected) { clear(); return; }
      try {
        const href = anchor.getAttribute("href");
        if (!href || anchor.closest('[inert], [aria-disabled="true"]')) { clear(); return; }
        const url = new URL(href, document.baseURI);
        if (["javascript:", "data:", "blob:"].includes(url.protocol)) { clear(); return; }
        // Credentials are not useful destination information. Keep encoded
        // paths intact: decoding may turn control characters into misleading text.
        url.username = ""; url.password = "";
        setDestination(url.href);
      } catch { clear(); }
    };
    const observer = new MutationObserver(update);
    const show = (target: EventTarget | null) => {
      const link = target instanceof Element ? target.closest("a[href], area[href]") : null;
      if (link === anchor) return;
      clear(); anchor = link;
      if (anchor) {
        update();
        if (anchor) observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["href", "inert", "aria-disabled"] });
      }
    };
    const over = (event: PointerEvent) => { if (event.pointerType !== "touch") show(event.target); };
    const out = (event: PointerEvent) => { if (event.pointerType !== "touch") show(event.relatedTarget); };
    const focus = (event: FocusEvent) => show(event.target);
    const blur = (event: FocusEvent) => show(event.relatedTarget);
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", blur, true);
    document.addEventListener("scroll", clear, true);
    document.addEventListener("visibilitychange", clear);
    window.addEventListener("blur", clear);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", blur, true);
      document.removeEventListener("scroll", clear, true);
      document.removeEventListener("visibilitychange", clear);
      window.removeEventListener("blur", clear);
    };
  }, []);

  return destination ? createPortal(
    <div data-slot="link-destination" aria-hidden="true" dir="ltr"
      className="pointer-events-none fixed bottom-0 left-0 z-[200] max-w-full truncate rounded-tr-md border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2 shadow-sm"
      style={{ maxWidth: "min(100%, var(--measure-prose))", unicodeBidi: "isolate" }}>
      {destination}
    </div>, document.body,
  ) : null;
}
