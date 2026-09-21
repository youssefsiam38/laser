/**
 * The budget ledger and the research cache: the two loop rules the contract
 * asks for, and the quota the host owns.
 *
 * - "never re-run an identical query" (loop step 2) — the ledger refuses it,
 *   with the call to make instead;
 * - "budget stop" (loop step 7) — every ceiling stops the run and the refusal
 *   says what was spent;
 * - "bodies are fetched once, digested, bounded and cached" — one fetch per
 *   source per run, and a size-bounded, evictable per-project cache.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESEARCH_BUDGET_DEFAULTS } from "@lasercode/protocol";
import { ResearchBudgetRefused, ResearchLedger, normaliseQuery, researchBudgetLine } from "../../src/research/budget.js";
import { cacheKey, digestOf, fileResearchCache, memoryResearchCache } from "../../src/research/cache.js";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function stateDir(): string {
  const path = mkdtempSync(join(tmpdir(), "research-cache-"));
  temporary.push(path);
  return path;
}

describe("the budget ledger", () => {
  it("refuses an identical query and says what to do instead", () => {
    const ledger = new ResearchLedger();
    ledger.chargeSearch("web", "PDF text extraction in Node");
    let refusal: ResearchBudgetRefused | undefined;
    try {
      ledger.chargeSearch("web", "  pdf TEXT extraction in node  ");
    } catch (failure) {
      refusal = failure as ResearchBudgetRefused;
    }
    expect(refusal?.code).toBe("identical_query");
    expect(refusal?.message).toContain("already asked web");
    expect(refusal?.next).toContain("read_source");
    expect(refusal?.committed).toBe(false);
    // The spend of a refused call is not charged.
    expect(ledger.spent().searches).toBe(1);
    // Another adapter, or another date window, is not the same query.
    expect(() => ledger.chargeSearch("package", "PDF text extraction in Node")).not.toThrow();
    expect(() => ledger.chargeSearch("web", "PDF text extraction in Node", "2026-01-01..")).not.toThrow();
    expect(normaliseQuery(" A   b ")).toBe("a b");
  });

  it("stops the run when the searches are spent, and reports the spend", () => {
    const ledger = new ResearchLedger({ budget: { maxSearches: 2 } });
    ledger.chargeSearch("web", "one");
    ledger.chargeSearch("web", "two");
    const refusal = (() => {
      try {
        ledger.chargeSearch("web", "three");
        return undefined;
      } catch (failure) {
        return failure as ResearchBudgetRefused;
      }
    })();
    expect(refusal?.code).toBe("budget_spent");
    expect(refusal?.exhausted).toBe(true);
    expect(refusal?.message).toContain("all 2 of its searches");
    expect(refusal?.message).toContain("Spent:");
    expect(refusal?.next).toContain("report what the budget stopped");
  });

  it("stops on reads, on bytes and on the clock", () => {
    const reads = new ResearchLedger({ budget: { maxReads: 1 } });
    reads.chargeRead("https://a.example/1");
    expect(() => reads.chargeRead("https://a.example/2")).toThrow(/all 1 of its reads/);

    const bytes = new ResearchLedger({ budget: { maxBytes: 2048 } });
    expect(() => bytes.chargeBytes(4096)).toThrow(/as much as it was given/);

    let clock = 1_000;
    const wall = new ResearchLedger({ budget: { maxWallClockMs: 60_000 }, now: () => clock });
    wall.chargeSearch("web", "one");
    clock += 61_000;
    expect(() => wall.chargeSearch("web", "two")).toThrow(/the time it was given/);
    expect(wall.stopped()).toBe("the time this research was given is spent");
  });

  it("charges one read per source per run, and the second is the cache's", () => {
    const ledger = new ResearchLedger();
    expect(ledger.chargeRead("https://a.example/1").cached).toBe(false);
    expect(ledger.chargeRead("https://a.example/1").cached).toBe(true);
    expect(ledger.spent().reads).toBe(1);
    expect(ledger.hasFetched("https://a.example/1")).toBe(true);
  });

  it("writes the budget line the fleet row and the header show", () => {
    const line = researchBudgetLine({ searches: 3, reads: 5, bytes: 312 * 1024, elapsedMs: 130_000 }, RESEARCH_BUDGET_DEFAULTS);
    expect(line).toBe("3/24 searches · 5/32 reads · 312 KB of 4.0 MB · 2m 10s");
    // No percentage, ever.
    expect(line).not.toContain("%");
  });

  it("a person's stop ends the run with a sentence the model can report", () => {
    const ledger = new ResearchLedger();
    ledger.stop();
    const refusal = (() => {
      try {
        ledger.chargeSearch("web", "anything");
        return undefined;
      } catch (failure) {
        return failure as ResearchBudgetRefused;
      }
    })();
    expect(refusal?.code).toBe("research_stopped");
    expect(refusal?.message).toContain("This research was stopped");
    expect(refusal?.next).toContain("report what remains");
  });
});

describe("the research cache", () => {
  const entry = (id: string, text: string) => ({ id, digest: digestOf(text), text, canonical: id, title: id });

  it("keys by the digest of the source id and round-trips an entry", () => {
    const state = stateDir();
    const cache = fileResearchCache({ stateDir: state, projectKey: "p1" });
    const stored = cache.put({ ...entry("https://a.example/one", "hello"), fetchedAt: 1000 });
    expect(stored.bytes).toBe(5);
    expect(cacheKey("https://a.example/one")).toMatch(/^[0-9a-f]{64}$/);
    const read = cache.get("https://a.example/one");
    expect(read?.text).toBe("hello");
    expect(read?.digest).toBe(digestOf("hello"));
    expect(cache.has("https://a.example/two")).toBe(false);
  });

  it("is per project: one project's cache never answers another's", () => {
    const state = stateDir();
    const one = fileResearchCache({ stateDir: state, projectKey: "p1" });
    const two = fileResearchCache({ stateDir: state, projectKey: "p2" });
    one.put(entry("https://a.example/one", "hello"));
    expect(two.get("https://a.example/one")).toBeUndefined();
  });

  it("evicts oldest first to stay inside the quota the host gives it", () => {
    const cache = memoryResearchCache(120);
    cache.put({ ...entry("https://a.example/1", "a".repeat(50)), fetchedAt: 1 });
    cache.put({ ...entry("https://a.example/2", "b".repeat(50)), fetchedAt: 2 });
    expect(cache.bytes()).toBe(100);
    cache.put({ ...entry("https://a.example/3", "c".repeat(50)), fetchedAt: 3 });
    expect(cache.bytes()).toBeLessThanOrEqual(120);
    expect(cache.get("https://a.example/1")).toBeUndefined();
    expect(cache.get("https://a.example/3")?.text).toHaveLength(50);
  });

  it("ignores a cache file it cannot read instead of failing the run", () => {
    const state = stateDir();
    const cache = fileResearchCache({ stateDir: state, projectKey: "p1" });
    cache.put(entry("https://a.example/one", "hello"));
    writeFileSync(join(state, "research", "p1", `${cacheKey("https://a.example/bad")}.json`), "{not json");
    expect(cache.entries()).toHaveLength(1);
    expect(cache.get("https://a.example/bad")).toBeUndefined();
  });
});
