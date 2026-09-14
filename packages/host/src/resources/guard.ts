/**
 * `resource/report` is the desktop shell's measurement **input**, and it is
 * local by nature: only the process running Electron on this machine can see
 * Electron's own metrics, and the host proves the claimed process is its own
 * ancestor before believing a number.
 *
 * The gate itself now lives in `METHOD_POLICY` (`@lasercode/protocol`), which
 * gives this one method reach `native` and refuses it before the request is
 * parsed (RP-13). What a phone reads — the redacted snapshot, history and
 * export the host built itself — stays reachable, because a summary a person
 * can see on their desktop is a summary they can see from their phone.
 *
 * The constant stays here so the Router's `resource/*` routing keeps naming
 * the method in one place.
 */
export const RESOURCE_REPORT_METHOD = "resource/report";
