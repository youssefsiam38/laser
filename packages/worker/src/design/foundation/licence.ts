/**
 * Licence checks for what a foundation proposes to import (M21-T14).
 *
 * The leap's Design contract is narrow on purpose: open-source libraries only,
 * behind Laser's own adapters, exact-pinned, permissive, with the licence
 * provenance retained for every imported component or asset. So an icon set,
 * a font family or a component library only becomes a recommendation once its
 * licence has been *read* — from a declared field in the source's own manifest
 * text, or from a known-set table of licences this file states outright.
 *
 * The one rule that matters: **unknown blocks the recommendation, and says
 * so.** Not "probably MIT", not silence. A person reading the Foundation sees
 * a source that cannot be used and the sentence explaining what would make it
 * usable, which is the only honest answer when nothing declared a licence.
 *
 * Nothing here fetches anything. It classifies text the caller already has:
 * the `license` field of a parsed manifest, a `LICENSE` file's first lines, or
 * the name a person typed.
 */
import {
  FOUNDATION_LICENCE_CLASSES,
  type FoundationLicenceClass,
  type FoundationSource,
  type FoundationSourceKind,
} from "@lasercode/protocol";

export { FOUNDATION_LICENCE_CLASSES };

/** What a classification decided, and what it read to decide it. */
export interface LicenceVerdict {
  classification: FoundationLicenceClass;
  /** The SPDX identifier, when the declaration was one. */
  spdx?: string;
  /** The licence's human name, when there is one. */
  name?: string;
  /** Where the classification came from: `manifest:license`, `known-set`, … */
  declaredIn?: string;
  /** The declared text it was made from, bounded. */
  evidence?: string;
  /** True only for a permissive licence that was actually declared. */
  recommended: boolean;
  /** Why it may be used, or why it may not. Always a sentence for a person. */
  reason: string;
}

/**
 * The known set, by SPDX identifier.
 *
 * Small and explicit rather than a dependency: these are the licences the
 * assets a design system imports actually carry. Anything outside it is
 * `unknown`, which is a refusal, not a guess.
 */
const PERMISSIVE: Readonly<Record<string, string>> = {
  MIT: "MIT",
  "MIT-0": "MIT No Attribution",
  ISC: "ISC",
  "BSD-2-CLAUSE": "BSD 2-Clause",
  "BSD-3-CLAUSE": "BSD 3-Clause",
  "APACHE-2.0": "Apache 2.0",
  "OFL-1.1": "SIL Open Font License 1.1",
  "CC0-1.0": "CC0 1.0",
  UNLICENSE: "The Unlicense",
  "CC-BY-4.0": "Creative Commons Attribution 4.0",
  "ZLIB": "zlib",
};

const COPYLEFT: Readonly<Record<string, string>> = {
  "GPL-2.0": "GPL 2.0",
  "GPL-3.0": "GPL 3.0",
  "AGPL-3.0": "AGPL 3.0",
  "LGPL-2.1": "LGPL 2.1",
  "LGPL-3.0": "LGPL 3.0",
  "MPL-2.0": "Mozilla Public License 2.0",
  "EPL-2.0": "Eclipse Public License 2.0",
  "CC-BY-SA-4.0": "Creative Commons Attribution-ShareAlike 4.0",
};

const PROPRIETARY: Readonly<Record<string, string>> = {
  UNLICENSED: "not licensed for use",
  PROPRIETARY: "proprietary",
  "CC-BY-NC-4.0": "Creative Commons Attribution-NonCommercial 4.0",
  "CC-BY-ND-4.0": "Creative Commons Attribution-NoDerivatives 4.0",
  "SEE LICENSE IN": "a licence file this check has not read",
};

/** Free text that names a licence, mapped to the identifier it means. */
const ALIASES: ReadonlyArray<{ match: RegExp; spdx: string }> = [
  { match: /\bmit licen[cs]e\b/i, spdx: "MIT" },
  { match: /\bapache licen[cs]e,? version 2\.0\b/i, spdx: "APACHE-2.0" },
  { match: /\bapache[- ]2(\.0)?\b/i, spdx: "APACHE-2.0" },
  { match: /\bisc licen[cs]e\b/i, spdx: "ISC" },
  { match: /\bbsd 3-clause\b/i, spdx: "BSD-3-CLAUSE" },
  { match: /\bbsd 2-clause\b/i, spdx: "BSD-2-CLAUSE" },
  { match: /\bsil open font licen[cs]e\b/i, spdx: "OFL-1.1" },
  { match: /\bgnu general public licen[cs]e,? version 3\b/i, spdx: "GPL-3.0" },
  { match: /\bgnu affero\b/i, spdx: "AGPL-3.0" },
  { match: /\bmozilla public licen[cs]e\b/i, spdx: "MPL-2.0" },
];

const EVIDENCE_MAX = 400;

/** `MIT OR Apache-2.0` and `(MIT AND ISC)` — the expression forms npm allows. */
function identifiers(declared: string): string[] {
  return declared
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|AND|or|and)\s+|\s*\/\s*|\s*,\s*/)
    .map((part) => part.trim().replace(/\+$/, ""))
    .filter((part) => part !== "");
}

function classifyIdentifier(identifier: string): { classification: FoundationLicenceClass; spdx?: string; name?: string } {
  const key = identifier.toUpperCase();
  if (PERMISSIVE[key]) return { classification: "permissive", spdx: identifier, name: PERMISSIVE[key] };
  if (COPYLEFT[key]) return { classification: "copyleft", spdx: identifier, name: COPYLEFT[key] };
  for (const [prefix, name] of Object.entries(PROPRIETARY)) {
    if (key === prefix || key.startsWith(prefix)) return { classification: "proprietary", spdx: identifier, name };
  }
  return { classification: "unknown" };
}

/**
 * Classify one declaration.
 *
 * `declared` is what the source itself said — a manifest's `license` field, a
 * licence file's heading, a person's own words. An empty or absent
 * declaration is `unknown`; so is a name this table does not hold, because a
 * licence nobody here recognises is exactly the case that needs a person.
 */
export function classifyLicence(
  declared: string | undefined,
  options: { declaredIn?: string; sourceName?: string } = {},
): LicenceVerdict {
  const text = (declared ?? "").trim();
  const name = options.sourceName ?? "This source";
  if (text === "") {
    return {
      classification: "unknown",
      ...(options.declaredIn !== undefined ? { declaredIn: options.declaredIn } : {}),
      recommended: false,
      reason: `${name} declares no licence anywhere this check can read, so it is not recommended. Add the licence it ships under, or choose a source that declares one.`,
    };
  }
  const evidence = text.slice(0, EVIDENCE_MAX);
  const parts = identifiers(text);
  const verdicts = parts.map((part) => classifyIdentifier(part));
  // An expression offering a choice is taken at its most permissive: `MIT OR
  // GPL-3.0` may be used under MIT, and saying otherwise would refuse a
  // source the contract allows.
  const permissive = verdicts.find((verdict) => verdict.classification === "permissive");
  const decided =
    permissive ??
    verdicts.find((verdict) => verdict.classification === "copyleft") ??
    verdicts.find((verdict) => verdict.classification === "proprietary");
  if (!decided) {
    const alias = ALIASES.find((entry) => entry.match.test(text));
    if (alias) {
      const aliased = classifyIdentifier(alias.spdx);
      return verdict(aliased, { evidence, declaredIn: options.declaredIn ?? "licence text", name });
    }
    return {
      classification: "unknown",
      evidence,
      ...(options.declaredIn !== undefined ? { declaredIn: options.declaredIn } : {}),
      recommended: false,
      reason: `${name} declares "${evidence.slice(0, 80)}", which this check does not recognise, so it is not recommended. Someone has to read that licence before anything from it is used.`,
    };
  }
  return verdict(decided, { evidence, declaredIn: options.declaredIn ?? "declared licence", name });
}

function verdict(
  decided: { classification: FoundationLicenceClass; spdx?: string; name?: string },
  context: { evidence: string; declaredIn: string; name: string },
): LicenceVerdict {
  const label = decided.name ?? decided.spdx ?? decided.classification;
  if (decided.classification === "permissive") {
    return {
      classification: "permissive",
      ...(decided.spdx !== undefined ? { spdx: decided.spdx } : {}),
      ...(decided.name !== undefined ? { name: decided.name } : {}),
      declaredIn: context.declaredIn,
      evidence: context.evidence,
      recommended: true,
      reason: `${label}: permissive, so it can be pinned exactly and shipped with its licence kept beside it.`,
    };
  }
  if (decided.classification === "copyleft") {
    return {
      classification: "copyleft",
      ...(decided.spdx !== undefined ? { spdx: decided.spdx } : {}),
      ...(decided.name !== undefined ? { name: decided.name } : {}),
      declaredIn: context.declaredIn,
      evidence: context.evidence,
      recommended: false,
      reason: `${label} is copyleft, and this product only takes permissive sources, so it is not recommended. Pick a permissive alternative, or decide this deliberately with whoever owns licensing.`,
    };
  }
  return {
    classification: decided.classification,
    ...(decided.spdx !== undefined ? { spdx: decided.spdx } : {}),
    ...(decided.name !== undefined ? { name: decided.name } : {}),
    declaredIn: context.declaredIn,
    evidence: context.evidence,
    recommended: false,
    reason: `${label} is not an open-source licence this product can use, so it is not recommended.`,
  };
}

/**
 * The `license` field of a manifest, read as text.
 *
 * The manifest is parsed as JSON when it is JSON and scanned as text when it
 * is not — no project file is ever executed or imported (D-353). A manifest
 * that cannot be parsed yields no declaration, which classifies as `unknown`.
 */
export function declaredLicenceFrom(manifestText: string | undefined): { declared?: string; declaredIn?: string } {
  const text = (manifestText ?? "").trim();
  if (text === "") return {};
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        const field = record["license"] ?? record["licence"];
        if (typeof field === "string" && field.trim() !== "") return { declared: field.trim(), declaredIn: "manifest: license" };
        if (field !== null && typeof field === "object") {
          const type = (field as Record<string, unknown>)["type"];
          if (typeof type === "string" && type.trim() !== "") return { declared: type.trim(), declaredIn: "manifest: license.type" };
        }
        const licenses = record["licenses"];
        if (Array.isArray(licenses)) {
          const first = licenses[0];
          if (typeof first === "string") return { declared: first, declaredIn: "manifest: licenses[0]" };
          const type = first !== null && typeof first === "object" ? (first as Record<string, unknown>)["type"] : undefined;
          if (typeof type === "string" && type.trim() !== "") return { declared: type.trim(), declaredIn: "manifest: licenses[0].type" };
        }
      }
    } catch {
      // A manifest that is not readable JSON declares nothing; the caller's
      // text scan below is the second chance, and `unknown` is the third.
    }
  }
  const spdxLine = /^\s*(?:"?licen[cs]e"?\s*[:=]\s*"?)([A-Za-z0-9.\-+ ]{2,80})"?\s*,?\s*$/m.exec(text);
  if (spdxLine?.[1]) return { declared: spdxLine[1].trim(), declaredIn: "manifest text: license" };
  const heading = text.split(/\r?\n/).find((line) => line.trim() !== "");
  if (heading !== undefined && ALIASES.some((alias) => alias.match.test(heading))) {
    return { declared: heading.trim(), declaredIn: "licence file heading" };
  }
  return {};
}

/** What a candidate source is, before it has been checked. */
export interface SourceCandidate {
  id: string;
  kind: FoundationSourceKind;
  name: string;
  url?: string;
  version?: string;
  /** The source's own manifest or licence text, when the caller has it. */
  manifestText?: string;
  /** A licence the caller already knows, e.g. from the known set below. */
  declaredLicence?: string;
}

/**
 * Check one candidate and answer with the record a foundation stores.
 *
 * A source without an exact version is still classifiable, but it is not
 * recommended: "exact-pinned" is part of the contract, not a preference, and
 * a range is how a permissive dependency silently becomes something else.
 */
export function checkSource(candidate: SourceCandidate): FoundationSource {
  const fromManifest = declaredLicenceFrom(candidate.manifestText);
  const declared = candidate.declaredLicence ?? fromManifest.declared;
  const verdict = classifyLicence(declared, {
    ...(fromManifest.declaredIn !== undefined ? { declaredIn: fromManifest.declaredIn } : candidate.declaredLicence !== undefined ? { declaredIn: "known set" } : {}),
    sourceName: candidate.name,
  });
  const pinned = candidate.version !== undefined && /^\d+\.\d+\.\d+/.test(candidate.version);
  const recommended = verdict.recommended && pinned;
  const reason = verdict.recommended && !pinned
    ? `${verdict.reason.replace(/\.$/, "")}, but it is not recommended until an exact version is pinned: a range can bring in something licensed differently.`
    : verdict.reason;
  return {
    id: candidate.id,
    kind: candidate.kind,
    name: candidate.name,
    ...(candidate.url !== undefined ? { url: candidate.url } : {}),
    ...(candidate.version !== undefined ? { version: candidate.version } : {}),
    licence: {
      classification: verdict.classification,
      ...(verdict.spdx !== undefined ? { spdx: verdict.spdx } : {}),
      ...(verdict.name !== undefined ? { name: verdict.name } : {}),
      ...(verdict.declaredIn !== undefined ? { declaredIn: verdict.declaredIn } : {}),
      ...(verdict.evidence !== undefined ? { evidence: verdict.evidence } : {}),
    },
    recommended,
    reason,
  };
}

/**
 * The icon, illustration and font sources Laser knows the licence of.
 *
 * Each one is here because its licence is declared in its own repository and
 * has been read; the version is the pin a Plan would carry. A source that is
 * not in this table is not thereby refused — it is classified from whatever
 * text the caller has, and `unknown` if there is none.
 */
export const KNOWN_SOURCES: readonly SourceCandidate[] = [
  { id: "lucide", kind: "icons", name: "Lucide", url: "https://lucide.dev", version: "0.544.0", declaredLicence: "ISC" },
  { id: "phosphor", kind: "icons", name: "Phosphor Icons", url: "https://phosphoricons.com", version: "2.1.7", declaredLicence: "MIT" },
  { id: "heroicons", kind: "icons", name: "Heroicons", url: "https://heroicons.com", version: "2.2.0", declaredLicence: "MIT" },
  { id: "inter", kind: "fonts", name: "Inter", url: "https://rsms.me/inter/", version: "4.1.0", declaredLicence: "OFL-1.1" },
  { id: "source-sans", kind: "fonts", name: "Source Sans 3", url: "https://github.com/adobe-fonts/source-sans", version: "3.052.0", declaredLicence: "OFL-1.1" },
  { id: "jetbrains-mono", kind: "fonts", name: "JetBrains Mono", url: "https://www.jetbrains.com/lp/mono/", version: "2.304.0", declaredLicence: "OFL-1.1" },
  { id: "undraw", kind: "illustrations", name: "unDraw", url: "https://undraw.co", version: "2024.1.0", declaredLicence: "MIT" },
];

/** One known source, checked. `undefined` when the id is not in the table. */
export function knownSource(id: string): FoundationSource | undefined {
  const candidate = KNOWN_SOURCES.find((entry) => entry.id === id);
  return candidate ? checkSource(candidate) : undefined;
}
