/**
 * The adapter registry: the five that ship, and the two that do not.
 *
 * `scholarly` and `tracker` are descriptors with no implementation
 * (`docs/research-phase.md`, "Ships: second"). They are here rather than
 * absent so Settings can show what is coming and a tool call that names one
 * is refused with a sentence, not a stack trace — and so the day one is
 * built, the only change is an implementation beside its descriptor.
 */
import { RESEARCH_ADAPTERS, RESEARCH_GAPS, researchAdapter, type ResearchAdapterId } from "@lasercode/protocol";
import { ResearchRefused } from "../errors.js";
import { documentResearchAdapter } from "./document.js";
import { packageResearchAdapter } from "./package.js";
import { projectResearchAdapter } from "./project.js";
import { repositoryResearchAdapter } from "./repository.js";
import { webResearchAdapter } from "./web.js";
import type { ResearchAdapter } from "./types.js";

/** An adapter that exists as a promise and refuses as one. */
function notShipped(id: "scholarly" | "tracker"): ResearchAdapter {
  const refuse = (): never => {
    throw new ResearchRefused(
      "adapter_not_shipped",
      `${RESEARCH_GAPS[id]} ${id === "scholarly" ? "Search the web for the paper, or read the publisher's page." : "Read the repository itself instead."}`,
      "use one of the sources this version has: the web, this project, a repository, a package registry or a file",
    );
  };
  return {
    id,
    descriptor: researchAdapter(id),
    search: refuse,
    read: refuse,
  };
}

export const RESEARCH_ADAPTER_IMPLEMENTATIONS: Readonly<Record<ResearchAdapterId, ResearchAdapter>> = {
  web: webResearchAdapter,
  project: projectResearchAdapter,
  repository: repositoryResearchAdapter,
  package: packageResearchAdapter,
  document: documentResearchAdapter,
  scholarly: notShipped("scholarly"),
  tracker: notShipped("tracker"),
};

/** Every adapter, in the order the contract's table lists them. */
export const RESEARCH_ADAPTER_LIST: readonly ResearchAdapter[] = RESEARCH_ADAPTERS.map((descriptor) => RESEARCH_ADAPTER_IMPLEMENTATIONS[descriptor.id]);

export function researchAdapterImplementation(id: ResearchAdapterId): ResearchAdapter {
  return RESEARCH_ADAPTER_IMPLEMENTATIONS[id];
}

export { documentResearchAdapter, packageResearchAdapter, projectResearchAdapter, repositoryResearchAdapter, webResearchAdapter };
export * from "./types.js";
export { createResearchFetcher, checkFetchTarget, RESEARCH_USER_AGENT, RESEARCH_FETCH_MAX_BYTES } from "./fetch.js";
export { serveSource, INJECTION_PREFACE, type LoadedBody } from "./serve.js";
export { parseProviderAnswer } from "./web.js";
export { parseCoordinate, parsePackageRef, packageRef, PACKAGE_ECOSYSTEMS, type PackageEcosystem, type PackageCoordinate } from "./package.js";
export { resolveRepositoryInput, parseRepositoryRef, REPOSITORY_STAPLES } from "./repository.js";
export { documentRef, resolveDocumentPath } from "./document.js";
export { projectFileRef, projectCommitRef } from "./project.js";
