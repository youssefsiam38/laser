import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { identity } from "../identity/identity.mjs";

// The public page is the commit point. Never expose partially uploaded assets.
export function verifyAssets(expected, remote) {
  for (const asset of expected) {
    const uploaded = remote.find((item) => item.name === asset.name);
    if (!uploaded || uploaded.state !== "uploaded" || uploaded.size !== asset.size || uploaded.digest !== asset.digest) {
      throw new Error(`Release asset is missing or does not match: ${asset.name}`);
    }
  }
  if (remote.length !== expected.length) throw new Error("Release contains unexpected assets; review the draft before publishing.");
}

export function releaseInventory(version) {
  const required = ["install.sh", "SHA256SUMS", "provenance.jsonl"];
  for (const arch of ["x86_64", "arm64"]) {
    required.push(`${identity.displayName}-${version}-${arch}.AppImage`);
  }
  for (const arch of ["amd64", "arm64"]) required.push(`${identity.binary}_${version}_${arch}.deb`);
  for (const arch of ["x86_64", "aarch64"]) {
    required.push(`${identity.binary}-${version}.${arch}.rpm`, `${identity.binary}-${version}-${arch}.tar.gz`);
  }
  return required;
}

export function verifyInventory(assets, version) {
  const names = new Set(assets.map((asset) => asset.name));
  const required = releaseInventory(version);
  for (const name of required) if (!names.has(name)) throw new Error(`Incomplete release: missing ${name}`);
  if (names.size !== assets.length || assets.some((asset) => asset.size <= 0)) throw new Error("Duplicate or empty release asset.");
}

export function publishRelease({ tag, version, repo, assets, notes = "", draft = false }, gh) {
  if (tag !== `v${version}`) throw new Error("Release tag and version disagree.");
  verifyInventory(assets, version);
  // The REST /tags route omits drafts. Let gh resolve draft tags, then inspect
  // the release by ID to retain raw asset state and SHA-256 digest fields.
  const inspect = () => {
    const found = gh(["release", "view", tag, "--repo", repo, "--json", "databaseId"], true);
    return found ? gh(["api", `repos/${repo}/releases/${found.databaseId}`]) : null;
  };
  let release = inspect();
  // A published release is immutable to this script, including retries.
  if (release && !release.draft) {
    verifyAssets(assets, release.assets);
    return "already published";
  }
  if (!release) {
    gh(["release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--latest=false",
      "--title", `${identity.displayName} ${version}`, ...(notes ? ["--notes", notes] : ["--generate-notes"])]);
  }
  gh(["release", "upload", tag, "--repo", repo, "--clobber", ...assets.map((asset) => asset.path)]);
  release = inspect();
  if (!release) throw new Error("Uploaded draft could not be inspected.");
  if (!release.draft) throw new Error("Release became public during upload; refusing further changes.");
  verifyAssets(assets, release.assets);
  if (draft) return "draft verified";
  const prerelease = version.includes("-");
  gh(["release", "edit", tag, "--repo", repo, "--draft=false",
    `--prerelease=${prerelease}`, `--latest=${!prerelease}`]);
  return "published";
}

function github(args, allowMissing = false) {
  let output;
  try {
    output = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowMissing && /^(release not found|.*\(HTTP 404\).*)$/m.test(String(error.stderr).trim())) return null;
    throw error;
  }
  return args[0] === "api" || args.includes("--json") ? JSON.parse(output) : output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, version, repo, dir, provenance, draft, notes] = process.argv.slice(2);
  const paths = (await readdir(dir, { withFileTypes: true })).filter((file) => file.isFile()).map((file) => join(dir, file.name));
  // Kept outside the manifest: the provenance bundle cannot attest itself.
  if (provenance) paths.push(provenance);
  const assets = [];
  for (const path of paths) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    assets.push({ name: basename(path), path, size: (await stat(path)).size, digest: `sha256:${hash.digest("hex")}` });
  }
  console.log(publishRelease({ tag, version, repo, assets, draft: draft === "1", notes }, github));
}
