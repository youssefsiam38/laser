/**
 * Verification and convergence, host side (M21-T19).
 *
 * `authorities` derives the question from the store at exact revisions,
 * `evaluate` answers it from facts, `report` stores the answer as evidence and
 * makes the one move it is allowed to make.
 */
export {
  blockersOf,
  gatherAuthorities,
  parseBrowserMatrix,
  planFrom,
  readerOf,
  sourceRefOf,
  type GatheredAuthorities,
  type VerificationReader,
} from "./authorities.js";
export { acceptedPreview, evaluate, type Evaluation, type EvaluationInput } from "./evaluate.js";
export { buildReport, convergeTask, storeReport, type StoredReport, type StoreReportInput } from "./report.js";
