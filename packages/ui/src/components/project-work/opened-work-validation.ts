import type { ProjectWorkKind } from "@lasercode/protocol";

export const WORK_LINE_MAX = 500;
export const WORK_COMMAND_MAX = 1_000;
export const WORK_PATH_MAX = 1_024;
export const WORK_SHORT_NAME_MAX = 200;

interface SchemaIssue {
  path: readonly PropertyKey[];
  code?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  origin?: string;
}

export interface WorkFieldError {
  path: readonly PropertyKey[];
  message: string;
}

const numbered = (noun: string, value: PropertyKey | undefined): string =>
  typeof value === "number" ? `${noun} ${value + 1}` : noun;

function fieldLabel(kind: ProjectWorkKind, path: readonly PropertyKey[]): string {
  const [section, row, field] = path;
  switch (kind) {
    case "spec":
      if (section === "brief") return "Brief";
      if (section === "problem") return "Problem";
      if (section === "outcomes") return numbered("Outcome", row);
      if (section === "nonGoals") return numbered("Non-goal", row);
      if (section === "requirements") return field === "id" ? numbered("Requirement identifier", row) : numbered("Requirement", row);
      if (section === "acceptance") return field === "id" ? numbered("Acceptance criterion identifier", row) : numbered("Acceptance criterion", row);
      if (section === "constraints") return numbered("Constraint", row);
      if (section === "document") return "Document";
      return "Spec field";
    case "research":
      if (section === "question") return "Question";
      if (section === "scope" && row === "in") return numbered("In scope", field);
      if (section === "scope" && row === "out") return numbered("Out of scope", field);
      if (section === "scope" && row === "constraints") return numbered("Constraint", field);
      if (section === "questions") return numbered(field === "id" ? "Question identifier" : "Question", row);
      return "Research field";
    case "design":
      if (section === "brief") return "Brief";
      if (section === "foundation" && row === "principles") return numbered("Foundation principle", field);
      if (section === "foundation" && row === "notes") return "Foundation notes";
      if (section === "screens") return numbered("Screen", row);
      if (section === "flows") return numbered("Flow", row);
      return "Design field";
    case "plan":
      if (section === "brief") return "Brief";
      if (section === "phases") return `${numbered("Phase", row)} ${field === "summary" ? "summary" : field === "taskKeys" ? "tasks" : "name"}`;
      if (section === "dependencies") return field === "reason" ? `${numbered("Dependency", row)} reason` : numbered("Dependency", row);
      if (section === "boundaries") return `${numbered("Boundary", row)} ${field === "rule" ? "rule" : "scope"}`;
      if (section === "migrations") return `${numbered("Migration", row)} ${field === "note" ? "note" : "summary"}`;
      if (section === "risks") return `${numbered("Risk", row)} ${field === "control" ? "control" : "summary"}`;
      if (section === "verification") return numbered("Verification command", row);
      if (section === "rollback") return "Rollback";
      if (section === "document") return "Document";
      return "Plan field";
    case "task":
      if (section === "outcome") return "Outcome";
      if (section === "nonGoals") return numbered("Non-goal", row);
      if (section === "dependencies") return numbered("Dependency", row);
      if (section === "scope" && row === "packages") return numbered("Package", field);
      if (section === "scope" && row === "repositories") return numbered("Repository", field);
      if (section === "scope" && row === "paths") return numbered("Path", field);
      if (section === "acceptance") return numbered(field === "command" ? "Acceptance command" : "Acceptance criterion", row);
      if (section === "verificationCommands") return numbered("Verification command", row);
      if (section === "assignment") return "Assignment";
      if (section === "planKey") return "Plan";
      if (section === "notes") return "Notes";
      return "Task field";
  }
}

export function workFieldError(kind: ProjectWorkKind, issue: SchemaIssue | undefined): WorkFieldError | undefined {
  if (!issue) return undefined;
  const label = fieldLabel(kind, issue.path);
  if (issue.code === "too_small") {
    const minimum = Number(issue.minimum);
    return { path: issue.path, message: minimum === 1 ? `${label} cannot be blank.` : `${label} needs at least ${minimum} entries.` };
  }
  if (issue.code === "too_big") {
    const maximum = Number(issue.maximum);
    return {
      path: issue.path,
      message: issue.origin === "array" ? `${label} can have at most ${maximum} entries.` : `${label} must be ${maximum} characters or fewer.`,
    };
  }
  return { path: issue.path, message: `${label} is not valid. Check it and try again.` };
}

export function errorAt(error: WorkFieldError | undefined, ...path: PropertyKey[]): string | undefined {
  if (!error || error.path.length !== path.length || error.path.some((part, index) => part !== path[index])) return undefined;
  return error.message;
}

export function errorWithin(error: WorkFieldError | undefined, section: PropertyKey): string | undefined {
  return error?.path[0] === section ? error.message : undefined;
}
