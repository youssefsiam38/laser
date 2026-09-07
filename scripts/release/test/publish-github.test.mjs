import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publishRelease, verifyInventory } from "../publish-github.mjs";
import { identity } from "../../identity/identity.mjs";

function fixture(version = "0.2.12", options = {}) {
  const names = ["install.sh", "SHA256SUMS", "SHA256SUMS.sig", "provenance.jsonl"];
  for (const arch of ["x86_64", "arm64"]) names.push(`${identity.displayName}-${version}-${arch}.AppImage`);
  for (const arch of ["amd64", "arm64"]) names.push(`${identity.binary}_${version}_${arch}.deb`);
  for (const arch of ["x86_64", "aarch64"]) names.push(`${identity.binary}-${version}.${arch}.rpm`, `${identity.binary}-${version}-${arch}.tar.gz`);
  const assets = names.map((name) => ({ name, path: `/staged/${name}`, size: 123, digest: `sha256:${"a".repeat(64)}` }));
  let release = options.existing ? { draft: options.existing === "draft", assets: assets.map((asset) => ({ ...asset, state: "uploaded" })) } : null;
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[1] === "view") {
      if (options.apiError) throw new Error("HTTP 403");
      return release ? { databaseId: 42 } : null;
    }
    if (args[0] === "api") {
      assert.match(args[1], /\/releases\/42$/); // never the published-only /tags route
      if (options.apiError) throw new Error("HTTP 403");
      return release;
    }
    if (args[1] === "create") {
      assert.ok(args.includes("--draft"));
      assert.ok(args.includes("--verify-tag"));
      release = { draft: true, assets: [] };
    }
    if (args[1] === "upload") {
      assert.equal(release.draft, true);
      if (options.uploadError) throw new Error("upload interrupted");
      release.assets = assets.map((asset) => ({ ...asset, state: "uploaded" }));
      options.corrupt?.(release.assets);
    }
    if (args[1] === "edit") release.draft = false;
  };
  return { assets, calls, gh, get release() { return release; }, run(extra = {}) {
    return publishRelease({ tag: `v${version}`, version, repo: identity.repository, assets, ...extra }, gh);
  } };
}

test("only publishes after draft creation, upload and remote verification", () => {
  const f = fixture();
  assert.equal(f.run(), "published");
  assert.deepEqual(f.calls.map((args) => args[0] === "api" ? "inspect" : args[1]), ["view", "create", "upload", "view", "inspect", "edit"]);
  assert.ok(f.calls.at(-1).includes("--draft=false"));
  assert.ok(f.calls.at(-1).includes("--latest=true"));
});
test("upload failure leaves a private draft", () => {
  const f = fixture(undefined, { uploadError: true });
  assert.throws(() => f.run(), /interrupted/);
  assert.equal(f.release.draft, true);
  assert.ok(!f.calls.some((args) => args[1] === "edit"));
});
for (const [name, corrupt] of [
  ["missing", (assets) => assets.pop()],
  ["wrong size", (assets) => assets[0].size++],
  ["wrong digest", (assets) => assets[0].digest = "sha256:wrong"],
  ["unfinished", (assets) => assets[0].state = "starter"],
  ["unexpected", (assets) => assets.push({ name: "stale-file" })],
]) test(`${name} remote asset blocks publication`, () => {
  const f = fixture(undefined, { corrupt });
  assert.throws(() => f.run(), /asset/);
  assert.equal(f.release.draft, true);
});
test("an incomplete local architecture or provenance fails before any GitHub write", () => {
  const f = fixture();
  for (const asset of f.assets) {
    if (asset.name === "SHA256SUMS.sig") continue; // unsigned manual staging remains supported
    assert.throws(() => verifyInventory(f.assets.filter((item) => item !== asset), "0.2.12"), /missing/);
  }
  assert.throws(() => f.run({ assets: [] }), /missing/);
  assert.equal(f.calls.length, 0);
});
test("explicit draft stays private after upload", () => {
  const f = fixture();
  assert.equal(f.run({ draft: true }), "draft verified");
  assert.equal(f.release.draft, true);
});
test("existing draft resumes and prerelease never becomes Latest", () => {
  const f = fixture("0.3.0-rc.1", { existing: "draft" });
  f.run();
  assert.ok(!f.calls.some((args) => args[1] === "create"));
  assert.ok(f.calls.at(-1).includes("--prerelease=true"));
  assert.ok(f.calls.at(-1).includes("--latest=false"));
});
test("published release retry verifies but never overwrites assets", () => {
  const f = fixture(undefined, { existing: "public" });
  assert.equal(f.run(), "already published");
  assert.equal(f.calls.length, 2);
  f.assets[0].digest = "changed";
  assert.throws(() => f.run(), /does not match/);
  assert.equal(f.calls.length, 4);
});
test("inspection failures do not create a release", () => {
  const f = fixture(undefined, { apiError: true });
  assert.throws(() => f.run(), /403/);
  assert.equal(f.calls.length, 1);
});
test("workflow supplies offline provenance in the same publication transaction", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/release.yml.tpl", import.meta.url), "utf8");
  assert.match(workflow, /publish\.sh --tag .* --dir release --provenance/);
  assert.doesNotMatch(workflow, /gh release upload/);
});
