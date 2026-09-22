"use client";
/**
 * One screen, rendered inside its own Shadow DOM root (M21-T11, D-354).
 *
 * The root is the whole point. The project's tokens go **inside** it as
 * `--design-*` custom properties and this app's tokens stay outside, so a
 * project whose brand colour is called `--live` cannot repaint the app around
 * it, and the app's own theme cannot leak into a design that is supposed to
 * look like the project. Nothing about the project is executed to get there
 * (D-353): the kit draws the contract, the index's tokens skin it.
 *
 * The frame is a real DOM subtree, not a picture: comments anchor to node ids,
 * text is selectable, the keyboard reaches it and the phone gets the same
 * bundle.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { kitStyleSheet } from "@/design/kit-css";

import { KitTree, type KitRenderContext } from "./kit/KitNode.js";

export function TreeFrame({
  context,
  tokenProperties,
  width,
  height,
  theme,
  label,
}: {
  context: KitRenderContext;
  /** `--design-*` from the index's DTCG document. Empty is a valid state. */
  tokenProperties: Readonly<Record<string, string>>;
  width: number;
  height: number;
  /** The theme the prototype is in, recorded on the root for the project's own modes. */
  theme?: string | undefined;
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<ShadowRoot | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // `attachShadow` throws if it is called twice on the same element, and
    // React may re-run an effect on the same node after a hot update.
    setRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
  }, []);

  const rootStyle = { ...tokenProperties } as CSSProperties;

  return (
    <div
      ref={hostRef}
      data-slot="design-tree-frame"
      data-screen-id={context.screen.id}
      role="group"
      aria-label={label}
      style={{ width: `${String(width)}px`, height: `${String(height)}px` }}
      className="overflow-hidden"
    >
      {root
        ? createPortal(
            <>
              <style>{kitStyleSheet()}</style>
              <div
                className="kit-root"
                data-design-root="true"
                data-token-count={String(Object.keys(tokenProperties).length)}
                {...(theme ? { "data-design-theme": theme } : {})}
                style={rootStyle}
                onClick={() => context.onSelect?.("")}
              >
                <KitTree context={context} />
              </div>
            </>,
            root,
          )
        : null}
    </div>
  );
}
