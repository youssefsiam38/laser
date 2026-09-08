"use client";
/**
 * The fullscreen host: the map over everything right of the rail, the way
 * the workbench covers it. Escape returns to the session — never while a
 * dialog, a popover or a text field is using Escape for its own purpose —
 * and what the person did to the map (selection, camera, "show ended")
 * survives the switch because it lives in `map-state`, not here.
 */
import { useEffect, useRef } from "react";

import { useLaserView } from "@/runtime";

import { AgentMapConnected, useMapRoot } from "./AgentMapView.js";
import { mapUi, useMapUi } from "./map-state.js";

export function AgentMapFullscreen() {
  const { fullscreen } = useMapUi();
  const view = useLaserView();
  const rootPath = useMapRoot(view?.path);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role='dialog'],[data-radix-popper-content-wrapper],input,textarea,[contenteditable='true']")) return;
      event.preventDefault();
      mapUi.setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // The session went away: nothing to draw fullscreen.
  useEffect(() => {
    if (fullscreen && !rootPath) mapUi.setFullscreen(false);
  }, [fullscreen, rootPath]);

  // Focus lands on the host so Escape and the map's keyboard paths work at once.
  useEffect(() => {
    if (fullscreen) ref.current?.focus({ preventScroll: true });
  }, [fullscreen]);

  if (!fullscreen || !view || !rootPath) return null;
  return (
    <section
      ref={ref}
      tabIndex={-1}
      data-slot="agent-map-fullscreen"
      aria-label="Agent map, fullscreen"
      className="absolute inset-0 z-30 flex min-w-0 flex-col bg-bg outline-none"
    >
      <AgentMapConnected rootPath={rootPath} frame="fullscreen" focusPath={view.path} />
    </section>
  );
}
