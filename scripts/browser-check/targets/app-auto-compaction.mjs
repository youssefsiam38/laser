import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { target as appTarget, configureStubProvider } from "./app.mjs";

const self = fileURLToPath(import.meta.url);

export const checkout = fileURLToPath(new URL("../../../", import.meta.url));
export const target = (runtime) => appTarget(runtime, { provider: self });
export { fixture } from "./fixtures.mjs";

if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "--provider") {
  const root = process.argv[3];
  const { startStubProvider, writeStubModels } = await import("../../../packages/worker/test/agents/stub-provider.ts");
  const { answer } = await import("./fixtures.mjs");
  const provider = await startStubProvider((request, index) => {
    const response = answer(request);
    if (!("text" in response)) return response;
    return {
      ...response,
      usage: { prompt_tokens: 7_500, completion_tokens: 4, total_tokens: 7_504 },
      ...(index >= 120 ? { delayMs: 1_000 } : {}),
    };
  });
  const agentDir = join(root, "agent");
  writeStubModels(agentDir, provider.url);
  configureStubProvider(root, provider.url);
  const modelsPath = join(agentDir, "models.json");
  const models = JSON.parse(readFileSync(modelsPath, "utf8"));
  models.providers.stub.models[0].contextWindow = 8_000;
  writeFileSync(modelsPath, JSON.stringify(models));
  process.once("SIGTERM", () => void provider.close().then(() => process.exit(0)));
}
