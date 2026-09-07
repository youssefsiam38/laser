// Bundle the upstream TypeScript search library, not its terminal extension.
// Packaged execution needs neither a transpiler nor a binary on PATH.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { copyFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
await build({
  entryPoints: [join(dirname(require.resolve("pi-web-access/package.json")), "gemini-search.ts")],
  outfile: new URL("../dist/web-search-upstream.js", import.meta.url).pathname,
  bundle: true, platform: "node", format: "esm", target: "node24",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  plugins: [{ name: "api-only-google-auth", setup(builder) {
    builder.onResolve({ filter: /\/gemini-web\.ts$/ }, () => ({ path: "gemini-web", namespace: "api-only" }));
    builder.onLoad({ filter: /.*/, namespace: "api-only" }, () => ({ contents: `
      export const isGeminiWebAvailable = async () => null;
      export const getGeminiWebAvailabilityDiagnostic = () => undefined;
      export const queryWithCookies = async () => { throw new Error("Browser authentication is not enabled."); };
    `, loader: "js" }));
  } }],
});
await copyFile(join(dirname(require.resolve("pi-web-access/package.json")), "LICENSE"), new URL("../dist/web-search-LICENSE.txt", import.meta.url));
