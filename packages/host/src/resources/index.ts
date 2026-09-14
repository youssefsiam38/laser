/**
 * The host's process inventory (RP-1). See `service.ts` for the contract and
 * the promises it keeps; this file is only the module's front door.
 */
export { ResourceService, physicalOf, roleTotalsOf, totalsOf, type ResourceServiceOptions } from "./service.js";
export { ProcessOwnershipRegistry, UNPROVEN_ADOPTION_WINDOW_MS, type ObservedProcess, type OwnershipLookups, type OwnershipRecord } from "./ownership.js";
export { ResourceHistory, type ResourceHistoryOptions } from "./history.js";
export { LinuxProcessCollector, type LinuxCollectorIo } from "./linux.js";
export { DarwinProcessCollector, parsePsCommands, parsePsTable, parseVmmapSummary } from "./darwin.js";
export { WindowsProcessCollector, parseCimDate, parseWindowsProcesses } from "./windows.js";
export { commFromStat, executableLabel, ppidFromStat, processKey, startTicksFromStat } from "./identity.js";
export type { ProcessCollector, ProcessRowMetrics, ProcessTableRow } from "./platform.js";
