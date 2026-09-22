/**
 * Route → the files that draw the page (M21-T12).
 *
 * Four real fixture projects — a Next app route, a Rails ERB view, a Laravel
 * Blade view and a plain HTML page — and, for the conventions a fixture would
 * only repeat, a literal file set. Grounding never writes, so these read the
 * fixtures where they sit.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostFilesFromTexts, scanHostFiles, type HostFiles } from "../../src/design/host/files.js";
import { hostStackOf, resolveRoute, routeForTemplate } from "../../src/design/host/resolve-route.js";
import { FIXTURE_ROOT } from "./helpers.js";

function fixture(name: string): HostFiles {
  return scanHostFiles(join(FIXTURE_ROOT, name)).files;
}

describe("a Next.js app route", () => {
  const files = fixture("host-next");

  it("resolves the route to its page, its layout and its two components", () => {
    const resolved = resolveRoute(files, "/dashboard");
    expect(resolved.stack).toBe("next-app");
    expect(resolved.route).toBe("/dashboard");
    expect(resolved.templatePath).toBe("app/dashboard/page.tsx");
    expect(resolved.layouts).toEqual(["app/layout.tsx"]);
    expect(resolved.partials.sort()).toEqual(["app/dashboard/SummaryCards.tsx", "components/InvoiceList.tsx", "components/SiteHeader.tsx"]);
    expect(resolved.stylesheets.sort()).toEqual(["app/dashboard/dashboard.module.css", "app/globals.css"]);
    expect(resolved.files[0]).toBe("app/layout.tsx");
    expect(resolved.files).toContain("app/dashboard/page.tsx");
  });

  it("answers the same for the file path as for the route", () => {
    expect(resolveRoute(files, "app/dashboard/page.tsx").files).toEqual(resolveRoute(files, "/dashboard").files);
  });

  it("says what it could not find, and offers the pages it did", () => {
    const missing = resolveRoute(files, "/settings/billing");
    expect(missing.templatePath).toBeUndefined();
    expect(missing.candidates.join(" ")).toContain("/dashboard");
    expect(missing.gaps[0]?.reason).toContain("no template matches");
  });
});

describe("a Rails ERB view", () => {
  const files = fixture("host-rails");

  it("resolves the view, its layout, both partials, the controller and the stylesheets", () => {
    const resolved = resolveRoute(files, "/invoices");
    expect(resolved.stack).toBe("rails");
    expect(resolved.templatePath).toBe("app/views/invoices/index.html.erb");
    expect(resolved.layouts).toEqual(["app/views/layouts/application.html.erb"]);
    expect(resolved.partials.sort()).toEqual(["app/views/invoices/_row.html.erb", "app/views/shared/_filters.html.erb"]);
    expect(resolved.controllers).toEqual(["app/controllers/invoices_controller.rb"]);
    expect(resolved.stylesheets).toContain("app/assets/stylesheets/application.scss");
    expect(resolved.stylesheets).toContain("app/assets/stylesheets/invoices.scss");
  });

  it("knows Rails' own action → route convention", () => {
    expect(routeForTemplate("app/views/invoices/index.html.erb")).toBe("/invoices");
    expect(routeForTemplate("app/views/invoices/show.html.erb")).toBe("/invoices/:id");
    expect(routeForTemplate("app/views/invoices/_row.html.erb")).toBeUndefined();
    expect(routeForTemplate("app/views/layouts/application.html.erb")).toBeUndefined();
  });
});

describe("a Laravel Blade view", () => {
  const files = fixture("host-laravel");

  it("follows @extends, @include and the <x-…> component to their files", () => {
    const resolved = resolveRoute(files, "/orders");
    expect(resolved.stack).toBe("blade");
    expect(resolved.templatePath).toBe("resources/views/orders/index.blade.php");
    expect(resolved.layouts).toEqual(["resources/views/layouts/app.blade.php"]);
    expect(resolved.partials.sort()).toEqual(["resources/views/components/order-row.blade.php", "resources/views/partials/filters.blade.php"]);
    expect(resolved.controllers).toEqual(["app/Http/Controllers/OrderController.php"]);
    expect(resolved.stylesheets).toEqual(["public/css/app.css"]);
  });

  it("takes a Blade view name as well as a route", () => {
    expect(resolveRoute(files, "orders.index").templatePath).toBe("resources/views/orders/index.blade.php");
  });
});

describe("plain HTML with comment includes", () => {
  const files = fixture("host-html");

  it("resolves SSI and comment includes and the linked stylesheet", () => {
    const resolved = resolveRoute(files, "/");
    expect(resolved.stack).toBe("html");
    expect(resolved.templatePath).toBe("index.html");
    expect(resolved.partials.sort()).toEqual(["partials/footer.html", "partials/nav.html"]);
    expect(resolved.stylesheets).toEqual(["styles/site.css"]);
  });
});

describe("the other conventions it knows", () => {
  it("SvelteKit: +page.svelte, its layouts up the tree and its loader", () => {
    const files = hostFilesFromTexts({
      "src/routes/+layout.svelte": "<slot />",
      "src/routes/orders/+layout.svelte": "<slot />",
      "src/routes/orders/+page.svelte": `<script>import Row from "$lib/components/Row.svelte";</script><main><Row /></main>`,
      "src/routes/orders/+page.server.ts": "export const load = () => ({});",
      "src/lib/components/Row.svelte": "<tr></tr>",
    });
    const resolved = resolveRoute(files, "/orders");
    expect(resolved.stack).toBe("sveltekit");
    expect(resolved.layouts).toEqual(["src/routes/+layout.svelte", "src/routes/orders/+layout.svelte"]);
    expect(resolved.controllers).toEqual(["src/routes/orders/+page.server.ts"]);
    expect(resolved.partials).toEqual(["src/lib/components/Row.svelte"]);
  });

  it("Nuxt: the layout the page names, and a component used as a tag", () => {
    const files = hostFilesFromTexts({
      "pages/orders.vue": `<template><TheToolbar /></template><script setup>definePageMeta({ layout: "wide" });</script>`,
      "layouts/wide.vue": "<template><slot /></template>",
      "layouts/default.vue": "<template><slot /></template>",
      "components/TheToolbar.vue": "<template><nav /></template>",
    });
    const resolved = resolveRoute(files, "/orders");
    expect(resolved.stack).toBe("nuxt");
    expect(resolved.layouts).toEqual(["layouts/wide.vue"]);
    expect(resolved.partials).toEqual(["components/TheToolbar.vue"]);
  });

  it("Remix: the dotted route name, its parent and the root", () => {
    const files = hostFilesFromTexts({
      "app/root.tsx": "export default function Root() { return null; }",
      "app/routes/orders.tsx": "export default function Orders() { return null; }",
      "app/routes/orders.index.tsx": `import { Row } from "../components/Row"; export default function Index() { return <Row />; }`,
      "app/components/Row.tsx": "export function Row() { return null; }",
    });
    const resolved = resolveRoute(files, "/orders");
    expect(resolved.stack).toBe("remix");
    expect(resolved.templatePath).toBe("app/routes/orders.index.tsx");
    expect(resolved.layouts).toEqual(["app/root.tsx", "app/routes/orders.tsx"]);
    expect(resolved.partials).toEqual(["app/components/Row.tsx"]);
  });

  it("Django/Jinja: extends, include, the view that renders it and the static stylesheet", () => {
    const files = hostFilesFromTexts({
      "reports/templates/reports/detail.html": `{% extends "base.html" %}{% block content %}{% include "reports/_table.html" %}{% endblock %}`,
      "reports/templates/base.html": `<html><head><link rel="stylesheet" href="{% static 'css/site.css' %}"></head><body>{% block content %}{% endblock %}</body></html>`,
      "reports/templates/reports/_table.html": "<table></table>",
      "reports/views.py": 'def detail(request):\n    return render(request, "reports/detail.html")\n',
      "static/css/site.css": "body { margin: 0; }",
    });
    const resolved = resolveRoute(files, "/reports/detail");
    expect(resolved.stack).toBe("jinja");
    expect(resolved.layouts).toEqual(["reports/templates/base.html"]);
    expect(resolved.partials).toEqual(["reports/templates/reports/_table.html"]);
    expect(resolved.controllers).toEqual(["reports/views.py"]);
    expect(resolved.stylesheets).toEqual(["static/css/site.css"]);
  });

  it("reads a stack off the path and nothing else", () => {
    expect(hostStackOf("app/orders/page.tsx")).toBe("next-app");
    expect(hostStackOf("src/pages/orders.vue")).toBe("nuxt");
    expect(hostStackOf("pages/orders.tsx")).toBe("next-pages");
    expect(hostStackOf("resources/views/orders/index.blade.php")).toBe("blade");
    expect(hostStackOf("src/lib/util.ts")).toBe("unknown");
  });
});
