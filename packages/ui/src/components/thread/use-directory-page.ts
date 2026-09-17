import { useEffect, useState } from "react";
import type { ExplorerEntry } from "@lasercode/protocol";
import { useLaserStable } from "@/runtime";
import { resolveProjectPath } from "./project-path.js";

const EMPTY: ExplorerEntry[] = [];
const PAGE_SIZE = 80;

type ExplorerListingSchema = typeof import("./explorer-listing.js")["explorerListingSchema"];
type ExplorerListing = ReturnType<ExplorerListingSchema["parse"]>;

/**
 * The validator, fetched once and kept for the session (M16-T31). It is asked
 * for beside the listing request, never before: a conversation that never
 * opens the explorer never downloads the schema library.
 */
let listingSchema: ExplorerListingSchema | undefined;
let listingSchemaLoad: Promise<ExplorerListingSchema> | undefined;
const loadListingSchema = (): Promise<ExplorerListingSchema> =>
  listingSchema
    ? Promise.resolve(listingSchema)
    : (listingSchemaLoad ??= import("./explorer-listing.js").then((module) => {
        listingSchema = module.explorerListingSchema;
        return module.explorerListingSchema;
      }).catch((error: unknown) => {
        // A failed chunk must be retryable: forget it, so Try again asks again.
        listingSchemaLoad = undefined;
        throw error;
      }));
export interface ExplorerNavigationState {
  cwd: string | undefined;
  query: string;
  head: string;
  commonPrefix: string;
  loading: boolean;
  next: (() => void) | undefined;
  previous: (() => void) | undefined;
}
export interface DirectoryPageState {
  entries: readonly ExplorerEntry[];
  directory: string | undefined;
  loading: boolean;
  issue: { kind: "refusal" | "failure"; message: string } | undefined;
  retry: (() => void) | undefined;
  navigation: ExplorerNavigationState;
}

/** A bounded, validated host page. A stale reply cannot become the current path. */
export function useDirectoryPage(cwd: string | undefined, query: string, active = true): DirectoryPageState {
  const { client } = useLaserStable();
  const resolution = resolveProjectPath(query);
  const directory = resolution.ok ? resolution.directory : undefined;
  const prefix = resolution.ok ? resolution.prefix : undefined;
  const key = JSON.stringify([cwd, query]);
  const [page, setPage] = useState({ key, offset: 0 });
  if (page.key !== key) setPage({ key, offset: 0 });
  const offset = page.key === key ? page.offset : 0;
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; offset: number; attempt: number; result?: ExplorerListing; failed?: boolean }>();
  useEffect(() => {
    if (!cwd || !active || directory === undefined || prefix === undefined) { setResponse(undefined); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      // The page and its validator travel together; neither waits for the other.
      void Promise.all([
        client.request("pi/project/browse", { path: directory, explorer: { mode: "explorer", cwd, prefix, offset, limit: PAGE_SIZE } }),
        loadListingSchema(),
      ]).then(
        ([reply, schema]) => {
          if (cancelled) return;
          const parsed = schema.safeParse(reply);
          setResponse(parsed.success ? { key, offset, attempt, result: parsed.data } : { key, offset, attempt, failed: true });
        },
        () => { if (!cancelled) setResponse({ key, offset, attempt, failed: true }); },
      );
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, cwd, key, offset, attempt, active, directory, prefix]);
  const current = response?.key === key && response.offset === offset && response.attempt === attempt ? response : undefined;
  const failure = current?.result?.error ?? (current?.failed ? "Couldn’t read this folder. Try again." : undefined);
  const issue: DirectoryPageState["issue"] = !resolution.ok ? { kind: "refusal", message: resolution.error }
    : failure ? { kind: current?.result?.errorKind === "refusal" ? "refusal" : "failure", message: failure } : undefined;
  const loading = active && !!cwd && !issue && !current;
  const nextOffset = current?.result?.nextOffset;
  return {
    entries: current?.result?.entries ?? EMPTY,
    directory: cwd ? current?.result?.path ?? directory : undefined,
    loading, issue,
    retry: issue?.kind === "failure" ? () => setAttempt(value => value + 1) : undefined,
    navigation: {
      cwd, query, loading, head: resolution.ok ? resolution.head : "", commonPrefix: current?.result?.commonPrefix ?? "",
      next: nextOffset === undefined ? undefined : () => setPage({ key, offset: nextOffset }),
      previous: offset ? () => setPage({ key, offset: Math.max(0, offset - PAGE_SIZE) }) : undefined,
    },
  };
}
