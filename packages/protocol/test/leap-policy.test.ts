/**
 * The leap's own rows in the authorization table (M21-T22, threat model §1, §8).
 *
 * `METHOD_POLICY satisfies Record<ClientMethod, MethodPolicy>` proves a row
 * *exists* for every method; it cannot prove the row is the right one. A
 * mutation typed `scope: "read"`, or a method that quietly became local-only,
 * would compile and ship.
 *
 * So this is the documented matrix — the one `docs/leap/m21-threat-model.md`
 * §8 publishes — written once, as data, and checked against the table. A new
 * `project/*` or `design/*` method fails here until somebody decides what a
 * phone may do with it and writes that decision down.
 */
import { describe, expect, it } from "vitest";
import {
  METHOD_POLICY,
  PROJECT_WORK_INTEROP_METHODS,
  PROJECT_WORK_METHODS,
  PROJECT_WORK_READ_METHODS,
  methodPolicy,
  reachAllows,
  type MethodScope,
} from "../src/index.js";

/** The matrix in §8 of the threat model, as data. */
const DOCUMENTED: Readonly<Record<string, MethodScope>> = {
  // Reading the product's own state.
  "project/work/list": "read",
  "project/work/get": "read",
  "project/work/search": "read",
  "project/work/blob/read": "read",
  "design/index/get": "read",
  "pi/project/verify/state": "read",
  // Changing this project's work.
  "project/work/create": "project_write",
  "project/work/revise": "project_write",
  "project/work/archive": "project_write",
  "project/work/delete": "project_write",
  "project/work/comment": "project_write",
  "project/work/review": "project_write",
  "project/work/approve": "project_write",
  "project/work/resolve-comment": "project_write",
  "project/work/link": "project_write",
  "project/work/unlink": "project_write",
  "project/task/action": "project_write",
  "project/task/link-execution": "project_write",
  "project/work/import/preview": "project_write",
  "project/work/import/apply": "project_write",
  "project/work/export/preview": "project_write",
  "project/work/export/apply": "project_write",
  "project/work/publish/preview": "project_write",
  "project/work/publish/apply": "project_write",
  "design/index/build": "project_write",
  "design/index/stop": "project_write",
  "design/index/review": "project_write",
  "design/host/ground": "project_write",
  "design/sketch/ground": "project_write",
  // Running the Task's declared commands is an execution, wherever it started.
  "pi/project/verify/start": "execution",
  "pi/project/verify/stop": "execution",
};

describe("the leap's method policy", () => {
  it("gives every project-work and design method the scope the matrix documents", () => {
    for (const [method, scope] of Object.entries(DOCUMENTED)) {
      const policy = methodPolicy(method);
      expect(policy, `${method} has no policy row`).toBeDefined();
      expect(policy!.scope, `${method} is documented as ${scope}`).toBe(scope);
    }
  });

  it("documents every leap method the protocol declares, and no more", () => {
    const declared = new Set<string>([...PROJECT_WORK_METHODS, ...PROJECT_WORK_INTEROP_METHODS]);
    for (const method of Object.keys(METHOD_POLICY)) {
      if (method.startsWith("design/") || method.startsWith("pi/project/verify/")) declared.add(method);
    }
    for (const method of declared) {
      expect(Object.prototype.hasOwnProperty.call(DOCUMENTED, method), `${method} is not in the documented phone matrix`).toBe(true);
    }
    for (const method of Object.keys(DOCUMENTED)) {
      expect(Object.prototype.hasOwnProperty.call(METHOD_POLICY, method), `${method} is documented but has no policy row`).toBe(true);
    }
  });

  it("keeps every read a read and every mutation a project write", () => {
    const reads = new Set<string>(PROJECT_WORK_READ_METHODS);
    for (const method of PROJECT_WORK_METHODS) {
      expect(methodPolicy(method)!.scope).toBe(reads.has(method) ? "read" : "project_write");
    }
    for (const method of PROJECT_WORK_INTEROP_METHODS) {
      // Every interop call reads or writes the project's own files, previews
      // included: none of them is the product-state `read` above.
      expect(methodPolicy(method)!.scope).toBe("project_write");
    }
  });

  it("reaches a paired device for every leap method, by design", () => {
    for (const method of Object.keys(DOCUMENTED)) {
      const policy = methodPolicy(method)!;
      expect(policy.reach, `${method} would be refused on a phone`).toBe("any");
      expect(reachAllows(policy.reach, "paired_device")).toBe(true);
    }
  });

  it("never lets a leap mutation be started while an update parks the host", () => {
    // `startsWork` fences a new root of work during activation. No project
    // method claims it: the leap's writes settle inside the host.
    for (const method of Object.keys(DOCUMENTED)) {
      expect(methodPolicy(method)!.startsWork).toBeUndefined();
    }
  });

  it("counts project work as its own authority, separate from settings and approval", () => {
    // D-332: lifecycle approval must not borrow the authority to answer a
    // session's questions, and must not require the authority to reconfigure
    // this machine.
    const scopes = new Set(Object.values(DOCUMENTED));
    expect(scopes.has("settings")).toBe(false);
    expect(scopes.has("approval")).toBe(false);
    expect(methodPolicy("project/work/approve")!.scope).not.toBe(methodPolicy("pi/ui/response")!.scope);
  });
});
