import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { STARTUP_SCREEN_CSS } from "@lasercode/protocol/startup-screen";

import {
  StartupRestorationGate,
  StartupRestorationScreen,
} from "../src/components/assistant-ui/elements/loading-state.js";

describe("startup restoration", () => {
  it("renders the approved product mark and converging branded paths", () => {
    const markup = renderToStaticMarkup(
      createElement(StartupRestorationScreen, { label: "Returning to your last session" }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Returning to your last session"');
    expect(markup).not.toContain('/icons/mark-192.png');
    expect(markup).toContain('class="startup-mark"');
    expect(markup).toContain('class="startup-beam-live"');
    expect(markup.match(/pathLength="1"/g)).toHaveLength(6);
    expect(markup).toContain("C548 341 578 369 590 400");
  });

  it("does not mount the operational shell while restoration is active", () => {
    const active = renderToStaticMarkup(
      createElement(
        StartupRestorationGate,
        { active: true, label: "Connecting" },
        createElement("main", null, "Operational shell"),
      ),
    );
    const ready = renderToStaticMarkup(
      createElement(
        StartupRestorationGate,
        { active: false, label: "Connecting" },
        createElement("main", null, "Operational shell"),
      ),
    );

    expect(active).not.toContain("Operational shell");
    expect(ready).toContain("Operational shell");
    expect(ready).not.toContain('data-slot="startup-restoration"');
  });

  it("mounts the host's questions in both states, so an answer can bring the screen down", () => {
    const prompts = createElement("dialog", null, "Trust this project?");
    const active = renderToStaticMarkup(
      createElement(
        StartupRestorationGate,
        { active: true, label: "Returning to your last session", prompts },
        createElement("main", null, "Operational shell"),
      ),
    );
    const ready = renderToStaticMarkup(
      createElement(
        StartupRestorationGate,
        { active: false, label: "Returning to your last session", prompts },
        createElement("main", null, "Operational shell"),
      ),
    );

    expect(active).toContain("Trust this project?");
    expect(active).not.toContain("Operational shell");
    expect(ready).toContain("Trust this project?");
    expect(ready).toContain("Operational shell");
  });

  it("carries the shell's one trust dialog on the gate, never inside the frame", () => {
    // The host holds the restored session's worker start behind the trust
    // question; a dialog inside the frame could not appear until it gave up.
    const shell = readFileSync(new URL("../src/components/shell/Shell.tsx", import.meta.url), "utf8");
    expect(shell.match(/<TrustDialog \/>/g)).toHaveLength(1);
    expect(shell).toContain("prompts={<TrustDialog />}");
  });

  it("stacks below the overlays a person may have to answer", () => {
    const rule = /\.startup-restoration \{[^}]*?z-index: (\d+);/.exec(STARTUP_SCREEN_CSS);
    expect(rule).not.toBeNull();
    // Dialogs, sheets and popovers sit at Tailwind's z-50; a screen above
    // them would hide the trust question that holds the restored session.
    expect(Number(rule![1])).toBeLessThan(50);
  });
});
