import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  StartupRestorationGate,
  StartupRestorationScreen,
} from "../src/components/assistant-ui/elements/loading-state.js";

describe("startup restoration", () => {
  it("renders the approved Laser mark and converging branded paths", () => {
    const markup = renderToStaticMarkup(
      createElement(StartupRestorationScreen, { label: "Returning to your last session" }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-label="Returning to your last session"');
    expect(markup).not.toContain('/icons/laser-mark-192.png');
    expect(markup).toContain("startup-mark relative");
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
});
