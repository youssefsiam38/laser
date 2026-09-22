/**
 * Grounding a host page: route in, frozen `HostPage` out (M21-T12).
 *
 * This is the composition step — `resolve-route` finds the files,
 * `outline` reads their structure, `reference-image` bounds the pictures,
 * `strategy` proposes Conform or Island — and the thing it produces is what
 * `docs/design-phase.md` calls a **frozen `HostPage` node**: a structural
 * outline plus an optional reference image, not editable, with its files
 * listed.
 *
 * Fidelity follows the contract's table exactly: an outline parsed from the
 * project's real templates is `Mapped`; a person-supplied screenshot is
 * `Proposed` and stays a reference beside the outline rather than becoming
 * the host. Nothing here runs the project, opens a browser or captures a
 * page (D-353).
 */
import type { DesignIndex, HostPage, HostReference } from "@lasercode/protocol";
import type { Gap } from "../index/facts.js";
import { basenameOf, dirnameOf, scanHostFiles, type HostFiles, type HostScanOptions } from "./files.js";
import { composeHostOutline, isMarkupPath, toProtocolOutline, type HostOutline } from "./outline.js";
import { acceptSuppliedImage, repositoryReferences, type ReferenceRefused, type SuppliedImage } from "./reference-image.js";
import { resolveRoute, type RouteResolution } from "./resolve-route.js";
import { proposeStrategy, type FeatureSize, type StrategyEra, type StrategyProposal } from "./strategy.js";

export interface HostGroundingRequest {
  /** A route (`/orders`), a template path, or a Blade-style view name. */
  routeOrPath: string;
  /** The app root inside the project, for a repository with several apps. */
  appRoot?: string;
  /** A person-supplied screenshot already in the blob store. */
  referenceBlobId?: string;
  /** Inputs to the Conform/Island proposal. */
  featureSize?: FeatureSize;
  hostStackCanExpress?: boolean;
  migrationWanted?: boolean;
  teamKnowsHostStack?: boolean;
}

export interface HostGroundingResult {
  /** The frozen host page, when a template was found. */
  hostPage?: HostPage;
  /** The rich outline, with structural paths and text hashes per node. */
  outline: HostOutline;
  route: RouteResolution;
  /** Both strategies with their reasons, when the index says what the eras are. */
  strategy?: StrategyProposal;
  /** Pages that could have been meant, when nothing matched. */
  candidates: string[];
  gaps: Gap[];
  /** Why a supplied image was not taken, when one was refused. */
  referenceRefused?: ReferenceRefused;
}

export interface GroundHostPageInput extends HostGroundingRequest {
  /** A screenshot the person supplied, bytes and all. Bounded, untrusted. */
  supplied?: SuppliedImage;
  /** The reviewed index, for eras and therefore for the strategy proposal. */
  index?: DesignIndex;
  maxNodes?: number;
}

/** The era a template belongs to: the era root that owns its path. */
export function hostEraFor(index: DesignIndex | undefined, templatePath: string): StrategyEra | undefined {
  if (!index || index.eras.length === 0) return undefined;
  let best: (typeof index.eras)[number] | undefined;
  for (const era of index.eras) {
    for (const root of era.roots) {
      const owns = root === "." || templatePath === root || templatePath.startsWith(`${root}/`);
      if (!owns) continue;
      const better = best === undefined || root.length > Math.max(...best.roots.map((candidate) => (candidate === "." ? 0 : candidate.length)));
      if (better) best = era;
    }
  }
  const era = best ?? index.eras[0];
  return era === undefined ? undefined : toStrategyEra(era);
}

/** An index era as the strategy reads it: its name already names its stack. */
export function toStrategyEra(era: DesignIndex["eras"][number]): StrategyEra {
  return { id: era.id, name: era.name, stack: era.name.split(/\s*\+\s*/).filter((part) => part !== ""), useForNewWork: era.useForNewWork };
}

/** Compose the host page. Pure over a file set; the class below walks a project. */
export function groundHostPage(files: HostFiles, input: GroundHostPageInput): HostGroundingResult {
  const route = resolveRoute(files, input.routeOrPath);
  const gaps: Gap[] = [...route.gaps];

  let referenceRefused: ReferenceRefused | undefined;
  let supplied: HostReference | undefined;
  if (input.supplied) {
    const decision = acceptSuppliedImage(input.supplied);
    if (decision.ok) supplied = decision.reference;
    else referenceRefused = decision;
  }

  if (route.templatePath === undefined) {
    return {
      outline: { nodes: [], gaps: [], truncated: false },
      route,
      candidates: route.candidates,
      gaps,
      ...(referenceRefused !== undefined ? { referenceRefused } : {}),
    };
  }

  const markup = [...route.layouts, route.templatePath, ...route.partials].filter((path, index, all) => all.indexOf(path) === index && isMarkupPath(path));
  const outline = composeHostOutline({
    files: markup.map((path) => ({ path, text: files.read(path) ?? "" })),
    options: {
      resolvePartial: (name) => matchPartial(name, route.partials),
      resolveComponent: (name) => matchPartial(name, route.partials),
    },
    ...(input.maxNodes !== undefined ? { maxNodes: input.maxNodes } : {}),
  });
  gaps.push(...outline.gaps);

  const mentions = [route.route, route.templatePath, basenameOf(route.templatePath).split(".")[0], basenameOf(dirnameOf(route.templatePath))].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  const references: HostReference[] = [...repositoryReferences(files, { mentions }), ...(supplied ? [supplied] : [])];

  const hostPage: HostPage = {
    routeOrPath: route.route ?? route.routeOrPath,
    templatePath: route.templatePath,
    outline: toProtocolOutline(outline),
    files: route.files,
    ...(supplied?.blobId !== undefined ? { referenceBlobId: supplied.blobId } : {}),
    ...(references.length > 0 ? { references } : {}),
    stack: route.stack,
    ...(gaps.length > 0 ? { gaps: gaps.slice(0, 20).map((gap) => ({ path: gap.path, reason: gap.reason.slice(0, 500) })) } : {}),
    // The outline is parsed from the project's real templates, so the host is
    // Mapped; a supplied screenshot sits beside it as its own Proposed
    // reference and never becomes the host itself.
    fidelity: outline.nodes.length > 0 ? "mapped" : "proposed",
  };

  const host = hostEraFor(input.index, route.templatePath);
  const strategy =
    host === undefined || input.index === undefined
      ? undefined
      : proposeStrategy({
          host,
          eras: input.index.eras.map(toStrategyEra),
          featureSize: input.featureSize ?? "medium",
          ...(input.hostStackCanExpress !== undefined ? { hostStackCanExpress: input.hostStackCanExpress } : {}),
          ...(input.migrationWanted !== undefined ? { migrationWanted: input.migrationWanted } : {}),
          ...(input.teamKnowsHostStack !== undefined ? { teamKnowsHostStack: input.teamKnowsHostStack } : {}),
        });

  return {
    hostPage,
    outline,
    route,
    ...(strategy !== undefined ? { strategy } : {}),
    candidates: [],
    gaps,
    ...(referenceRefused !== undefined ? { referenceRefused } : {}),
  };
}

/** `shared/filters`, `partials.filters`, `x-order-row`, `Sidebar` → a file. */
export function matchPartial(name: string, candidates: readonly string[]): string | undefined {
  const wanted = name
    .replace(/^x-/, "")
    .replace(/\./g, "/")
    .replace(/\.(html|htm|erb|blade\.php|php|twig|jinja2?|j2|vue|svelte|tsx|jsx)$/i, "");
  const base = wanted.split("/").pop() ?? wanted;
  const kebab = base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const normalised = (path: string): string => path.replace(/\.[^/]+$/, "").replace(/\.(html|blade)$/, "");
  for (const candidate of candidates) {
    const plain = normalised(candidate);
    const file = (plain.split("/").pop() ?? "").replace(/^_/, "");
    if (plain.endsWith(`/${wanted}`) || plain.endsWith(`/_${base}`) || plain === wanted) return candidate;
    if (file === base || file.toLowerCase() === kebab) return candidate;
  }
  return undefined;
}

// --------------------------------------------------------------- the bridge

/** What the `ground_host_page` tool needs from the worker. */
export interface HostGroundingBridge {
  ground(request: HostGroundingRequest): Promise<HostGroundingResult>;
}

export interface ProjectHostGroundingOptions {
  projectCwd: string;
  /** The reviewed index, when this project has one: eras for the strategy. */
  index?: () => Promise<DesignIndex | undefined>;
  /** Person-supplied screenshots already stored as blobs. */
  readBlob?: (blobId: string) => Promise<{ bytes: Uint8Array; mediaType?: string; label?: string } | undefined>;
  scan?: HostScanOptions;
}

/** One project's host grounding: a bounded walk and a parse, nothing else. */
export class ProjectHostGrounding implements HostGroundingBridge {
  constructor(private readonly options: ProjectHostGroundingOptions) {}

  async ground(request: HostGroundingRequest): Promise<HostGroundingResult> {
    const scanned = scanHostFiles(this.options.projectCwd, {
      ...this.options.scan,
      ...(request.appRoot !== undefined ? { appRoot: request.appRoot } : {}),
    });
    const index = await this.options.index?.();
    let supplied: SuppliedImage | undefined;
    let missingBlob: ReferenceRefused | undefined;
    if (request.referenceBlobId !== undefined) {
      const blob = await this.options.readBlob?.(request.referenceBlobId);
      if (blob === undefined) {
        missingBlob = {
          ok: false,
          code: "image_unreadable",
          message: "That reference image is not in this project's store any more, so the host page was grounded without it.",
          next: "attach the screenshot again from the design workspace",
        };
      } else {
        supplied = {
          bytes: blob.bytes,
          ...(blob.mediaType !== undefined ? { mediaType: blob.mediaType } : {}),
          ...(blob.label !== undefined ? { label: blob.label } : {}),
          blobId: request.referenceBlobId,
        };
      }
    }
    const result = groundHostPage(scanned.files, {
      ...request,
      ...(supplied !== undefined ? { supplied } : {}),
      ...(index !== undefined ? { index } : {}),
    });
    const gaps = [...scanned.gaps.slice(0, 10), ...result.gaps];
    return {
      ...result,
      gaps,
      ...(missingBlob !== undefined ? { referenceRefused: missingBlob } : {}),
    };
  }
}
