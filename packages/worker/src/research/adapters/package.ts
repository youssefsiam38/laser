/**
 * The `package` adapter: what a registry publishes about a package.
 *
 * | | |
 * | --- | --- |
 * | Reach | network |
 * | Auth | none |
 * | Rate | 20 requests a minute, half a second apart |
 * | Search result | registry search hits: name, version, description |
 * | Read result | declared metadata: version, licence class, dependencies, repository, published date |
 *
 * Five registries, each through the endpoint **it documents**, and nothing
 * else (`docs/research-phase.md`, "Not shipped: undocumented third-party
 * search endpoints"):
 *
 * | Ecosystem | Metadata | Search |
 * | --- | --- | --- |
 * | `npm` | `registry.npmjs.org/<name>` | `registry.npmjs.org/-/v1/search` |
 * | `pypi` | `pypi.org/pypi/<name>/json` | none published — the name is looked up directly |
 * | `crates` | `crates.io/api/v1/crates/<name>` | `crates.io/api/v1/crates?q=` |
 * | `go` | `proxy.golang.org/<module>/@latest` and `/@v/list` | none published — the module path is looked up directly |
 * | `maven` | `search.maven.org/solrsearch/select` | the same endpoint |
 *
 * A coordinate is written the way a person says it: `npm:react`,
 * `pypi:requests@2.32.3`, `crates:serde`, `go:golang.org/x/net`,
 * `maven:com.google.guava:guava`.
 */
import { researchAdapter, type SourceRef } from "@lasercode/protocol";
import { digestOf } from "../cache.js";
import { ResearchRefused } from "../errors.js";
import { serveSource } from "./serve.js";
import { licenceClass, type ResearchAdapter, type ResearchAdapterContext, type ResearchHit, type ResearchReadInput, type ResearchReadResult, type ResearchSearchInput, type ResearchSearchResult } from "./types.js";

export const PACKAGE_ECOSYSTEMS = ["npm", "pypi", "crates", "go", "maven"] as const;
export type PackageEcosystem = (typeof PACKAGE_ECOSYSTEMS)[number];

export interface PackageCoordinate {
  ecosystem: PackageEcosystem;
  name: string;
  version?: string;
}

const ALIASES: Record<string, PackageEcosystem> = {
  npm: "npm",
  node: "npm",
  js: "npm",
  pypi: "pypi",
  pip: "pypi",
  python: "pypi",
  crates: "crates",
  cargo: "crates",
  rust: "crates",
  go: "go",
  golang: "go",
  maven: "maven",
  java: "maven",
};

/** `npm:react@19`, `go:golang.org/x/net`, `guava` — to one coordinate. */
export function parseCoordinate(value: string): PackageCoordinate & { assumed?: string } {
  const trimmed = value.trim();
  const prefixed = /^([a-z]+):(.+)$/i.exec(trimmed);
  const ecosystem = prefixed ? ALIASES[prefixed[1]!.toLowerCase()] : undefined;
  const body = (prefixed && ecosystem ? prefixed[2]! : trimmed).trim();
  if (body === "") {
    throw new ResearchRefused("bad_coordinate", "Name the package to look up.", "call search_sources with a name like npm:react or pypi:requests");
  }
  if (ecosystem === "maven" || (!ecosystem && /^[\w.-]+:[\w.-]+$/.test(body) && body.includes("."))) {
    const [group, artifact, version] = body.split(":");
    if (!group || !artifact) {
      throw new ResearchRefused("bad_coordinate", `"${body}" is not a Maven coordinate.`, "write it as maven:group:artifact, for example maven:com.google.guava:guava");
    }
    return { ecosystem: "maven", name: `${group}:${artifact}`, ...(version !== undefined ? { version } : {}) };
  }
  const at = body.lastIndexOf("@");
  const hasVersion = at > 0 && !body.slice(0, at).endsWith("/") && /^[\w.+-]+$/.test(body.slice(at + 1));
  const name = hasVersion ? body.slice(0, at) : body;
  const version = hasVersion ? body.slice(at + 1) : undefined;
  if (ecosystem) return { ecosystem, name, ...(version !== undefined ? { version } : {}) };
  // No prefix: a module path is Go, anything else is npm, and the answer says so.
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(name)) return { ecosystem: "go", name, ...(version !== undefined ? { version } : {}), assumed: "go" };
  return { ecosystem: "npm", name, ...(version !== undefined ? { version } : {}), assumed: "npm" };
}

export function packageRef(coordinate: PackageCoordinate, title?: string): SourceRef {
  const id = `pkg:${coordinate.ecosystem}/${coordinate.name}${coordinate.version ? `@${coordinate.version}` : ""}`;
  return { kind: "package", id, title: (title ?? id).slice(0, 500), fetchedVia: "package", trust: "primary" };
}

export function parsePackageRef(id: string): PackageCoordinate {
  const body = id.startsWith("pkg:") ? id.slice(4) : id;
  const slash = body.indexOf("/");
  if (slash <= 0) return parseCoordinate(body);
  const ecosystem = ALIASES[body.slice(0, slash).toLowerCase()];
  if (!ecosystem) return parseCoordinate(body);
  return parseCoordinate(`${ecosystem}:${body.slice(slash + 1)}`);
}

const SEARCH_URL: Record<PackageEcosystem, ((query: string, limit: number) => string) | undefined> = {
  npm: (query, limit) => `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${String(Math.min(limit, 20))}`,
  crates: (query, limit) => `https://crates.io/api/v1/crates?q=${encodeURIComponent(query)}&per_page=${String(Math.min(limit, 20))}`,
  maven: (query, limit) => `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(query)}&rows=${String(Math.min(limit, 20))}&wt=json`,
  pypi: undefined,
  go: undefined,
};

const NO_SEARCH: Record<string, string> = {
  pypi: "PyPI publishes no search API, so this looks the name up directly. Search the web for the package name when you do not know it.",
  go: "The Go module proxy publishes no search API, so this looks the module path up directly. Search the web for the module path when you do not know it.",
};

function metadataUrl(coordinate: PackageCoordinate): string {
  const { ecosystem, name, version } = coordinate;
  switch (ecosystem) {
    case "npm":
      return `https://registry.npmjs.org/${name.split("/").map(encodeURIComponent).join("/")}${version ? `/${encodeURIComponent(version)}` : ""}`;
    case "pypi":
      return `https://pypi.org/pypi/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}/json`;
    case "crates":
      return `https://crates.io/api/v1/crates/${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}`;
    case "go":
      return `https://proxy.golang.org/${name.toLowerCase()}/@${version ? `v/${version}.mod` : "latest"}`;
    case "maven": {
      const [group, artifact] = name.split(":");
      return `https://search.maven.org/solrsearch/select?q=g:%22${encodeURIComponent(group ?? "")}%22+AND+a:%22${encodeURIComponent(artifact ?? "")}%22&core=gav&rows=20&wt=json`;
    }
  }
}

interface Metadata {
  text: string;
  title: string;
  licence: string | undefined;
  version?: string;
  publishedAt?: string;
}

function line(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
}

function describe(coordinate: PackageCoordinate, body: string): Metadata {
  const { ecosystem, name } = coordinate;
  if (ecosystem === "go") {
    // The proxy answers `@latest` as JSON and `.mod` as the module file.
    try {
      const latest = JSON.parse(body) as { Version?: string; Time?: string };
      const rows = [`Module: ${name}`, ...[line("Latest version", latest.Version), line("Published", latest.Time)].filter((row): row is string => row !== undefined)];
      return {
        text: rows.join("\n"),
        title: `${name}${latest.Version ? `@${latest.Version}` : ""}`,
        licence: undefined,
        ...(latest.Version !== undefined ? { version: latest.Version } : {}),
        ...(latest.Time !== undefined ? { publishedAt: latest.Time } : {}),
      };
    } catch {
      return { text: `Module file for ${name}:\n\n${body}`, title: name, licence: undefined };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ResearchRefused(
      "registry_unreadable",
      `The registry answered something that is not the metadata for ${name}.`,
      "check the package name, or read the project's repository instead",
    );
  }
  const data = parsed as Record<string, unknown>;
  if (ecosystem === "npm") {
    const distTags = (data["dist-tags"] ?? {}) as Record<string, string>;
    const version = typeof data["version"] === "string" ? (data["version"] as string) : distTags["latest"];
    const versions = data["versions"] as Record<string, Record<string, unknown>> | undefined;
    const current = (versions && version ? versions[version] : undefined) ?? data;
    const time = data["time"] as Record<string, string> | undefined;
    const licence = typeof current["license"] === "string" ? (current["license"] as string) : typeof data["license"] === "string" ? (data["license"] as string) : undefined;
    const repository = current["repository"] ?? data["repository"];
    const dependencies = Object.keys((current["dependencies"] ?? {}) as Record<string, string>);
    const rows = [
      `Package: ${name}${version ? `@${version}` : ""} (npm)`,
      ...[
        line("Description", current["description"] ?? data["description"]),
        line("Licence", licence ?? "not declared"),
        line("Homepage", current["homepage"] ?? data["homepage"]),
        line("Repository", typeof repository === "object" && repository !== null ? (repository as { url?: string }).url : repository),
        line("Runtime dependencies", dependencies.length === 0 ? "none" : `${String(dependencies.length)} — ${dependencies.slice(0, 20).join(", ")}`),
        line("Published", version && time ? time[version] : undefined),
        line("Versions", versions ? `${String(Object.keys(versions).length)} published, latest ${distTags["latest"] ?? "unknown"}` : undefined),
        line("Deprecated", current["deprecated"]),
      ].filter((row): row is string => row !== undefined),
    ];
    return {
      text: rows.join("\n"),
      title: `${name}${version ? `@${version}` : ""}`,
      licence,
      ...(version !== undefined ? { version } : {}),
      ...(version && time?.[version] !== undefined ? { publishedAt: time[version]! } : {}),
    };
  }
  if (ecosystem === "pypi") {
    const info = (data["info"] ?? {}) as Record<string, unknown>;
    const version = typeof info["version"] === "string" ? (info["version"] as string) : undefined;
    const classifiers = (info["classifiers"] ?? []) as string[];
    const licence =
      (typeof info["license"] === "string" && info["license"] !== "" ? (info["license"] as string) : undefined) ??
      classifiers.find((entry) => entry.startsWith("License ::"))?.split("::").pop()?.trim();
    const requires = (info["requires_dist"] ?? []) as string[] | null;
    const urls = (data["urls"] ?? []) as Array<{ upload_time_iso_8601?: string }>;
    const rows = [
      `Package: ${name}${version ? `@${version}` : ""} (PyPI)`,
      ...[
        line("Summary", info["summary"]),
        line("Licence", licence ?? "not declared"),
        line("Homepage", info["home_page"] ?? (info["project_urls"] as Record<string, string> | undefined)?.["Homepage"]),
        line("Repository", (info["project_urls"] as Record<string, string> | undefined)?.["Source"] ?? (info["project_urls"] as Record<string, string> | undefined)?.["Repository"]),
        line("Requires Python", info["requires_python"]),
        line("Dependencies", Array.isArray(requires) ? `${String(requires.length)} — ${requires.slice(0, 20).join("; ")}` : "none declared"),
        line("Published", urls[0]?.upload_time_iso_8601),
      ].filter((row): row is string => row !== undefined),
    ];
    return {
      text: rows.join("\n"),
      title: `${name}${version ? `@${version}` : ""}`,
      licence,
      ...(version !== undefined ? { version } : {}),
      ...(urls[0]?.upload_time_iso_8601 !== undefined ? { publishedAt: urls[0].upload_time_iso_8601 } : {}),
    };
  }
  if (ecosystem === "crates") {
    const crate = (data["crate"] ?? {}) as Record<string, unknown>;
    const versions = (data["versions"] ?? []) as Array<Record<string, unknown>>;
    const newest = versions[0];
    const version = typeof crate["max_stable_version"] === "string" ? (crate["max_stable_version"] as string) : (newest?.["num"] as string | undefined);
    const licence = typeof newest?.["license"] === "string" ? (newest["license"] as string) : undefined;
    const rows = [
      `Package: ${name}${version ? `@${version}` : ""} (crates.io)`,
      ...[
        line("Description", crate["description"]),
        line("Licence", licence ?? "not declared"),
        line("Repository", crate["repository"]),
        line("Documentation", crate["documentation"]),
        line("Downloads", crate["downloads"]),
        line("Published", newest?.["created_at"]),
        line("Versions", versions.length === 0 ? undefined : String(versions.length)),
      ].filter((row): row is string => row !== undefined),
    ];
    return {
      text: rows.join("\n"),
      title: `${name}${version ? `@${version}` : ""}`,
      licence,
      ...(version !== undefined ? { version } : {}),
      ...(typeof newest?.["created_at"] === "string" ? { publishedAt: newest["created_at"] } : {}),
    };
  }
  // Maven Central answers a Solr document per released version.
  const docs = ((data["response"] ?? {}) as { docs?: Array<Record<string, unknown>> }).docs ?? [];
  const newest = docs[0];
  const version = typeof newest?.["v"] === "string" ? (newest["v"] as string) : typeof newest?.["latestVersion"] === "string" ? (newest["latestVersion"] as string) : undefined;
  const timestamp = typeof newest?.["timestamp"] === "number" ? new Date(newest["timestamp"] as number).toISOString() : undefined;
  const rows = [
    `Package: ${name}${version ? `@${version}` : ""} (Maven Central)`,
    ...[
      line("Packaging", newest?.["p"]),
      line("Versions", docs.length === 0 ? undefined : `${String(docs.length)} returned, newest ${version ?? "unknown"}`),
      line("Published", timestamp),
      "Licence: Maven Central's index does not publish the licence; read the project's repository or its POM.",
    ].filter((row): row is string => row !== undefined),
  ];
  return { text: rows.join("\n"), title: `${name}${version ? `@${version}` : ""}`, licence: undefined, ...(version !== undefined ? { version } : {}), ...(timestamp !== undefined ? { publishedAt: timestamp } : {}) };
}

function searchHits(ecosystem: PackageEcosystem, body: string, limit: number): ResearchHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const data = parsed as Record<string, unknown>;
  const hits: ResearchHit[] = [];
  if (ecosystem === "npm") {
    for (const entry of ((data["objects"] ?? []) as Array<{ package?: Record<string, unknown> }>).slice(0, limit)) {
      const pkg = entry.package ?? {};
      const name = typeof pkg["name"] === "string" ? pkg["name"] : undefined;
      if (!name) continue;
      const version = typeof pkg["version"] === "string" ? pkg["version"] : undefined;
      hits.push({
        sourceRef: packageRef({ ecosystem, name, ...(version !== undefined ? { version } : {}) }, `${name}${version ? `@${version}` : ""}`),
        title: `${name}${version ? `@${version}` : ""}`,
        snippet: typeof pkg["description"] === "string" ? pkg["description"].slice(0, 400) : "",
        ...(typeof pkg["date"] === "string" ? { date: pkg["date"] } : {}),
      });
    }
    return hits;
  }
  if (ecosystem === "crates") {
    for (const crate of ((data["crates"] ?? []) as Array<Record<string, unknown>>).slice(0, limit)) {
      const name = typeof crate["name"] === "string" ? crate["name"] : undefined;
      if (!name) continue;
      const version = typeof crate["max_stable_version"] === "string" ? crate["max_stable_version"] : undefined;
      hits.push({
        sourceRef: packageRef({ ecosystem, name, ...(version !== undefined ? { version } : {}) }, `${name}${version ? `@${version}` : ""}`),
        title: `${name}${version ? `@${version}` : ""}`,
        snippet: typeof crate["description"] === "string" ? crate["description"].slice(0, 400) : "",
        ...(typeof crate["updated_at"] === "string" ? { date: crate["updated_at"] } : {}),
      });
    }
    return hits;
  }
  for (const doc of (((data["response"] ?? {}) as { docs?: Array<Record<string, unknown>> }).docs ?? []).slice(0, limit)) {
    const group = typeof doc["g"] === "string" ? doc["g"] : undefined;
    const artifact = typeof doc["a"] === "string" ? doc["a"] : undefined;
    if (!group || !artifact) continue;
    const version = typeof doc["latestVersion"] === "string" ? doc["latestVersion"] : typeof doc["v"] === "string" ? doc["v"] : undefined;
    hits.push({
      sourceRef: packageRef({ ecosystem: "maven", name: `${group}:${artifact}`, ...(version !== undefined ? { version } : {}) }),
      title: `${group}:${artifact}${version ? `@${version}` : ""}`,
      snippet: typeof doc["p"] === "string" ? `Packaging ${doc["p"]}.` : "",
      ...(typeof doc["timestamp"] === "number" ? { date: new Date(doc["timestamp"]).toISOString() } : {}),
    });
  }
  return hits;
}

export const packageResearchAdapter: ResearchAdapter = {
  id: "package",
  descriptor: researchAdapter("package"),

  async search(input: ResearchSearchInput, context: ResearchAdapterContext): Promise<ResearchSearchResult> {
    const coordinate = parseCoordinate(input.query);
    context.ledger.chargeSearch("package", input.query);
    const notes: string[] = [];
    if (coordinate.assumed) notes.push(`Read as a ${coordinate.assumed === "go" ? "Go module path" : "npm package"}. Write npm:, pypi:, crates:, go: or maven: to choose another registry.`);
    const url = SEARCH_URL[coordinate.ecosystem]?.(coordinate.name, input.limit);
    if (!url) {
      notes.push(NO_SEARCH[coordinate.ecosystem] ?? "This registry publishes no search API.");
      return {
        hits: [
          {
            sourceRef: packageRef(coordinate),
            title: coordinate.name,
            snippet: `Read ${coordinate.name} for its declared version, licence and dependencies.`,
          },
        ],
        notes,
      };
    }
    const response = await context.fetch({ url }, context.signal);
    if (response.status >= 400) {
      throw new ResearchRefused(
        "registry_refused",
        `The ${coordinate.ecosystem} registry answered ${String(response.status)} for that search.`,
        "look the package up by name with read_source, or try another registry",
      );
    }
    context.ledger.chargeBytes(response.bytes);
    const hits = searchHits(coordinate.ecosystem, response.body, input.limit);
    if (hits.length === 0) notes.push(`The ${coordinate.ecosystem} registry returned no package matching that.`);
    return { hits, ...(notes.length > 0 ? { notes } : {}) };
  },

  async read(input: ResearchReadInput, context: ResearchAdapterContext): Promise<ResearchReadResult> {
    const coordinate = parsePackageRef(input.ref.id);
    const source = packageRef(coordinate, input.ref.title);
    return serveSource({
      context,
      source,
      ...(input.offset !== undefined ? { offset: input.offset } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      load: async () => {
        const url = metadataUrl(coordinate);
        const response = await context.fetch({ url, headers: { accept: "application/json" } }, context.signal);
        if (response.status === 404) {
          throw new ResearchRefused(
            "package_not_found",
            `The ${coordinate.ecosystem} registry has no package called ${coordinate.name}${coordinate.version ? ` at ${coordinate.version}` : ""}.`,
            "check the name and the registry prefix, or search the registry with search_sources",
          );
        }
        if (response.status >= 400) {
          throw new ResearchRefused(
            "registry_refused",
            `The ${coordinate.ecosystem} registry answered ${String(response.status)} for ${coordinate.name}.`,
            "try again later, or read the project's repository instead",
          );
        }
        const described = describe(coordinate, response.body);
        const text = [`[${coordinate.ecosystem}] ${described.title}`, `Source: ${url}`, "", described.text].join("\n");
        return {
          text,
          digest: digestOf(response.body),
          bytes: response.bytes,
          canonical: url,
          title: described.title,
          licence: licenceClass(described.licence),
          ...(described.publishedAt !== undefined ? { publishedAt: described.publishedAt } : {}),
          contentType: "application/json",
          notices: described.licence === undefined ? ["This registry does not declare a licence here; read the repository's licence file before recording reuse."] : [],
        };
      },
    });
  },
};
