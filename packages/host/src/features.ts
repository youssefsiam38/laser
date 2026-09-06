import {
  FEATURE_MANIFESTS,
  ErrorCodes,
  ProtocolError,
  type FeatureId,
  type FeatureScope,
  type FeatureState,
} from "@lasercode/protocol";
import type { PrefsStore } from "./prefs.js";

const NAMESPACE = "features";

interface StoredFeatures {
  version: 1;
  global: Record<string, boolean>;
  projects: Record<string, Record<string, boolean>>;
}

const EMPTY: StoredFeatures = { version: 1, global: {}, projects: {} };

/** Laser's feature policy. It stores product intent, never package sources. */
export class FeatureService {
  constructor(private readonly prefs: PrefsStore) {}

  list(cwd?: string): FeatureState[] {
    const stored = this.read();
    return FEATURE_MANIFESTS.map((manifest) => {
      const project = cwd ? stored.projects[cwd]?.[manifest.id] : undefined;
      const savedGlobal = stored.global[manifest.id];
      const globalEnabled = savedGlobal ?? manifest.defaultEnabled;
      const enabled = project ?? globalEnabled;
      const source: FeatureState["source"] = project !== undefined ? "project" : savedGlobal !== undefined ? "global" : "default";
      return {
        manifest: { ...manifest, scopes: [...manifest.scopes], dependencies: [...manifest.dependencies], capabilities: [...manifest.capabilities] },
        globalEnabled,
        globalSource: savedGlobal !== undefined ? "global" : "default",
        ...(project !== undefined ? { projectEnabled: project } : {}),
        enabled,
        source,
        health: enabled ? "ready" : "disabled",
      };
    });
  }

  set(id: string, enabled: boolean | null, scope: FeatureScope, cwd?: string): FeatureState[] {
    const manifest = FEATURE_MANIFESTS.find((entry) => entry.id === id);
    if (!manifest) throw new ProtocolError(ErrorCodes.InvalidParams, `Unknown feature ${JSON.stringify(id)}.`);
    if (!manifest.scopes.includes(scope)) {
      throw new ProtocolError(ErrorCodes.InvalidParams, `${manifest.name} cannot be changed for ${scope} scope.`);
    }
    if (scope === "project" && !cwd) {
      throw new ProtocolError(ErrorCodes.InvalidParams, "Choose a project before changing a project feature.");
    }
    const stored = this.read();
    if (scope === "global") {
      if (enabled === null) delete stored.global[manifest.id];
      else stored.global[manifest.id] = enabled;
    }
    else {
      const project = { ...(stored.projects[cwd!] ?? {}) };
      if (enabled === null) delete project[manifest.id];
      else project[manifest.id] = enabled;
      if (Object.keys(project).length === 0) delete stored.projects[cwd!];
      else stored.projects[cwd!] = project;
    }
    this.prefs.set(NAMESPACE, stored);
    return this.list(cwd);
  }

  enabled(cwd?: string): FeatureId[] {
    return this.list(cwd).filter((entry) => entry.enabled).map((entry) => entry.manifest.id);
  }

  private read(): StoredFeatures {
    const value = this.prefs.get(NAMESPACE)[0]?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return structuredClone(EMPTY);
    const raw = value as Partial<StoredFeatures>;
    const global = readFlags(raw.global);
    const projects: StoredFeatures["projects"] = {};
    if (raw.projects && typeof raw.projects === "object" && !Array.isArray(raw.projects)) {
      for (const [cwd, flags] of Object.entries(raw.projects)) projects[cwd] = readFlags(flags);
    }
    return { version: 1, global, projects };
  }
}

function readFlags(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, flag] of Object.entries(value as Record<string, unknown>)) {
    if (typeof flag === "boolean") result[id] = flag;
  }
  return result;
}
