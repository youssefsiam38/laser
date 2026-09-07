import { parentPort, workerData } from "node:worker_threads";
import type { SearchJob } from "./web-search-execution.js";
import { searchFailure, searchWithProvider } from "./web-search-provider.js";

const job = workerData as SearchJob;
try {
  const result = await searchWithProvider(job);
  parentPort!.postMessage(result.length <= 262144 ? { result } : { error: "Web search returned too much content. Try a narrower query." });
} catch (error) {
  parentPort!.postMessage({ error: searchFailure(job, error) });
}
