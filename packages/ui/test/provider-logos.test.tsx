import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BUILTIN_PROVIDER_IDS,
  ProviderLogo,
  hasCatalogProviderLogo,
  providerDisplayName,
} from "../src/components/assistant-ui/elements/logos.js";

describe("provider logos", () => {
  it("maps the complete 40-provider built-in catalog to real SVG marks", () => {
    expect(BUILTIN_PROVIDER_IDS).toHaveLength(40);
    expect(new Set(BUILTIN_PROVIDER_IDS).size).toBe(40);

    for (const provider of BUILTIN_PROVIDER_IDS) {
      expect(hasCatalogProviderLogo(provider), provider).toBe(true);
      const markup = renderToStaticMarkup(createElement(ProviderLogo, { provider }));
      expect(markup, provider).toContain("<svg");
      expect(markup, provider).not.toContain("<span");
    }
  });

  it("keeps a deterministic fallback only for custom providers", () => {
    expect(hasCatalogProviderLogo("private-cloud")).toBe(false);
    expect(renderToStaticMarkup(createElement(ProviderLogo, { provider: "private-cloud" }))).toContain(
      ">PC</span>",
    );
  });

  it("uses the billing provider mark even when it proxies another developer's model", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderLogo, { provider: "cloudflare-workers-ai" }),
    );
    expect(markup).toContain("<title>Cloudflare</title>");
    expect(markup).not.toContain("<title>DeepSeek</title>");
    expect(providerDisplayName("cloudflare-workers-ai")).toBe("Workers AI");
  });
});
