/**
 * Remote URL parsing and the product's hidden ref namespace.
 *
 * Host discovery is from remotes only. A custom host (GitLab, a self-hosted
 * Bitbucket) is unsupported — said in a sentence, never probed.
 */
import { CHECKPOINT_REF_NAMESPACE, type GitActionHost } from "@lasercode/protocol";

export interface ParsedRemote {
  host: GitActionHost | "unsupported";
  /** Hostname the remote named, for the unsupported sentence. */
  hostname: string;
  owner: string;
  name: string;
}

const SSH = /^(?:ssh:\/\/)?(?:git@)?([^/:]+)[:/](.+?)(?:\.git)?$/i;
const HTTPS = /^(?:https?:\/\/)(?:[^/@]+@)?([^/]+)\/(.+?)(?:\.git)?$/i;

/** `refs/<product>/` — parent of {@link CHECKPOINT_REF_NAMESPACE}. */
export function hiddenRefPrefix(): string {
  const ns = CHECKPOINT_REF_NAMESPACE;
  return ns.endsWith("/checkpoints") ? ns.slice(0, -"checkpoints".length) : `${ns.replace(/\/$/, "")}/`;
}

/** True when a ref sits under the product's hidden namespace. */
export function isHiddenProductRef(ref: string): boolean {
  const trimmed = ref.trim().replace(/^\/+/, "");
  const prefix = hiddenRefPrefix();
  return trimmed === prefix.slice(0, -1) || trimmed.startsWith(prefix);
}

export function parseRemoteUrl(url: string): ParsedRemote | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const https = HTTPS.exec(trimmed);
  const ssh = https ? undefined : SSH.exec(trimmed);
  const match = https ?? ssh;
  if (!match) return undefined;
  const hostname = (match[1] ?? "").toLowerCase();
  const path = (match[2] ?? "").replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0]!;
  const name = parts[1]!;
  if (hostname === "github.com" || hostname === "www.github.com") {
    return { host: "github", hostname, owner, name };
  }
  if (hostname === "bitbucket.org" || hostname === "www.bitbucket.org") {
    return { host: "bitbucket", hostname, owner, name };
  }
  return { host: "unsupported", hostname, owner, name };
}

export function githubRepo(parsed: ParsedRemote): string {
  return `${parsed.owner}/${parsed.name}`;
}

export function bitbucketRepo(parsed: ParsedRemote): { workspace: string; repo: string } {
  return { workspace: parsed.owner, repo: parsed.name };
}
