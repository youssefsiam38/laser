import {
  UpdateTransactionStore,
  completeMigrationLaunch,
  restoreUpdateData,
  selectRuntimeGeneration,
  type LaserPaths,
  type MigrationLaunchEvent,
  type UpdateTransaction,
} from "@lasercode/cli";
import { runtimeUpdatePresentation, type ActivationBlockers, type RuntimeActivationState, type RuntimeUpdateNoticeState } from "@lasercode/protocol";
import type { UpdateStatus } from "./api.js";
import type { HostLink } from "./host-link.js";
import type { NativeUpdateMarker } from "./native-update.js";

const POLL_MS = 1_000;

export class DesktopUpdateActivation {
  private readonly transactions: UpdateTransactionStore;
  private marker: NativeUpdateMarker | undefined;
  private status: UpdateStatus = { state: "idle" };
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: {
    stateDir: string;
    paths: LaserPaths;
    link: HostLink;
    publish: (status: UpdateStatus) => void;
    log?: (category: string, error: unknown) => void;
  }) {
    this.transactions = new UpdateTransactionStore(options.stateDir);
  }

  current(): UpdateStatus { return this.status; }

  resume(marker: NativeUpdateMarker): UpdateStatus | undefined {
    const transaction = this.transactions.read(marker.updateId);
    if (!transaction) return undefined;
    this.marker = marker;
    return this.set(this.statusFor(transaction, marker));
  }

  discover(marker: NativeUpdateMarker): UpdateStatus {
    this.marker = marker;
    const transaction = this.transactions.read(marker.updateId);
    if (!transaction) return this.set(this.notice("failed", marker));
    return this.set(this.statusFor(transaction, marker));
  }

  async prepare(): Promise<UpdateStatus> {
    const marker = this.marker;
    if (!marker) return this.status;
    try {
      let transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase === "staged" || transaction.phase === "failed" || transaction.phase === "rolled_back") {
        transaction = this.transactions.transition(marker.updateId, "parking");
      }
      if (transaction.phase !== "parking" && transaction.phase !== "ready") return this.set(this.statusFor(transaction, marker));
      const gate = transaction.phase === "ready"
        ? await this.options.link.activationStatus(marker.updateId)
        : await this.options.link.prepareActivation(marker.updateId, marker.generationId);
      return this.applyGate(gate);
    } catch (error) {
      this.options.log?.("activation_prepare_failed", error);
      return this.fail("activation_prepare_failed");
    }
  }

  async cancel(): Promise<UpdateStatus> {
    const marker = this.marker;
    if (!marker) return this.status;
    try {
      await this.options.link.cancelActivation(marker.updateId);
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase === "parking") this.transactions.transition(marker.updateId, "staged");
      this.stopPolling();
      return this.set(this.notice("downloaded", marker));
    } catch (error) {
      this.options.log?.("activation_cancel_failed", error);
      return this.fail("activation_cancel_failed");
    }
  }

  async restore(updateId = this.marker?.updateId): Promise<UpdateStatus> {
    if (!updateId) return this.status;
    const transaction = this.transactions.read(updateId);
    if (!transaction) return this.set(this.noSnapshot(updateId));
    const marker = this.marker?.updateId === updateId ? this.marker : this.markerFrom(transaction);
    try {
      this.set(this.notice("restoring", marker));
      restoreUpdateData(this.options.paths, updateId, (event) => this.applyMigrationEvent(event));
      this.stopPolling();
      return this.set(this.notice("restored", marker));
    } catch (error) {
      this.options.log?.("migration_restore_failed", error);
      return this.set(this.notice("migration-failed", marker));
    }
  }

  applyMigrationEvent(event: MigrationLaunchEvent): void {
    const marker = this.marker;
    if (!marker || event.updateId !== marker.updateId) return;
    if (event.phase === "preparing" || event.phase === "migrating") this.set(this.notice("preparing-data", marker));
    else if (event.phase === "restoring") this.set(this.notice("restoring", marker));
    else if (event.phase === "restored") this.set(this.notice("restored", marker));
    else if (event.phase === "failed") this.set(this.notice("migration-failed", marker));
  }

  async activate(): Promise<boolean> {
    const marker = this.marker;
    if (!marker) return false;
    try {
      const gate = await this.options.link.activationStatus(marker.updateId);
      if (gate.phase !== "parked" || Object.values(gate.blockers).some((count) => count !== 0)) {
        this.applyGate(gate);
        return false;
      }
      let transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase !== "ready") {
        this.set(this.statusFor(transaction, marker));
        return false;
      }
      const pointer = selectRuntimeGeneration(this.options.stateDir, marker.generationId);
      if (pointer.active.generationId !== marker.generationId) return false;
      transaction = this.transactions.transition(marker.updateId, "selected");
      transaction = this.transactions.transition(marker.updateId, "restarting");
      this.stopPolling();
      this.set(this.notice("restarting", marker));
      return transaction.phase === "restarting";
    } catch (error) {
      this.options.log?.("activation_selection_failed", error);
      this.fail("activation_selection_failed");
      return false;
    }
  }

  failLaunch(): void {
    const marker = this.marker;
    if (!marker) return;
    try {
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase !== "restarting") return;
      this.transactions.transition(marker.updateId, "failed", { failureCategory: "verified_launch_failed" });
    } catch (error) { this.options.log?.("verified_launch_failed", error); }
    this.stopPolling();
    this.set(this.notice("failed", marker));
  }

  completeLaunch(launch: { launchId: string; generationId: string; version: string; updateId?: string }): void {
    const updateId = launch.updateId ?? this.marker?.updateId;
    if (!updateId) return;
    let transaction: UpdateTransaction;
    try { transaction = this.requireTransaction(updateId); }
    catch (error) { this.options.log?.("verified_launch_transaction", error); return; }
    if ((transaction.phase !== "restarting" && transaction.phase !== "succeeded")
      || launch.generationId !== transaction.targetGenerationId
      || launch.version !== transaction.targetVersion) return;
    const newlySucceeded = transaction.phase === "restarting";
    if (!completeMigrationLaunch(this.options.paths, { ...launch, updateId })) return;
    const marker = this.marker?.updateId === updateId ? this.marker : this.markerFrom(transaction);
    if (newlySucceeded) this.set(this.notice("succeeded", marker));
  }

  stop(): void { this.stopPolling(); }

  private applyGate(gate: RuntimeActivationState): UpdateStatus {
    const marker = this.marker;
    if (!marker) return this.status;
    if (gate.updateId !== marker.updateId || gate.generationId !== marker.generationId) {
      return this.fail("activation_identity_mismatch");
    }
    if (gate.phase === "parked" && Object.values(gate.blockers).every((count) => count === 0)) {
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase === "parking") this.transactions.transition(marker.updateId, "ready");
      this.stopPolling();
      return this.set(this.notice("ready", marker, gate.blockers));
    }
    this.startPolling();
    return this.set(this.notice("parking", marker, gate.blockers));
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const marker = this.marker;
      if (!marker) return;
      void this.options.link.activationStatus(marker.updateId)
        .then((gate) => this.applyGate(gate))
        .catch((error) => { this.options.log?.("activation_poll_failed", error); });
    }, POLL_MS);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(category: string): UpdateStatus {
    const marker = this.marker;
    if (!marker) return this.set({ state: "error", message: runtimeUpdatePresentation("failed").detail });
    try {
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase !== "succeeded" && transaction.phase !== "rolled_back") {
        this.transactions.transition(marker.updateId, "failed", { failureCategory: category });
      }
    } catch (error) { this.options.log?.(category, error); }
    this.stopPolling();
    return this.set(this.notice("failed", marker));
  }

  private markerFrom(transaction: UpdateTransaction): NativeUpdateMarker {
    return {
      schemaVersion: 1,
      updateId: transaction.updateId,
      version: transaction.targetVersion,
      buildIdentity: transaction.buildIdentity,
      generationId: transaction.targetGenerationId,
      manifestDigest: transaction.manifestDigest,
    };
  }

  private noSnapshot(updateId: string): UpdateStatus {
    const presentation = runtimeUpdatePresentation("no-snapshot");
    return {
      state: "no-snapshot",
      updateId,
      version: "",
      title: presentation.title,
      message: presentation.detail,
      action: presentation.action,
      ...(presentation.actionLabel ? { actionLabel: presentation.actionLabel } : {}),
    };
  }

  private requireTransaction(updateId: string): UpdateTransaction {
    const transaction = this.transactions.read(updateId);
    if (!transaction) throw new Error("missing update transaction");
    return transaction;
  }

  private statusFor(transaction: UpdateTransaction, marker: NativeUpdateMarker): UpdateStatus {
    if (transaction.phase === "parking") return this.notice("parking", marker);
    if (transaction.phase === "ready") return this.notice("ready", marker);
    if (transaction.phase === "selected" || transaction.phase === "restarting") return this.notice("restarting", marker);
    if (transaction.phase === "succeeded") return this.notice("succeeded", marker);
    if (transaction.phase === "rolled_back") return this.notice("restored", marker);
    if (transaction.phase === "failed" || transaction.phase === "restoring") return this.notice("failed", marker);
    return this.notice("downloaded", marker);
  }

  private notice(state: RuntimeUpdateNoticeState, marker: NativeUpdateMarker, blockers?: ActivationBlockers): UpdateStatus {
    const presentation = runtimeUpdatePresentation(state, blockers);
    return {
      state,
      updateId: marker.updateId,
      version: marker.version,
      title: presentation.title,
      message: presentation.detail,
      action: presentation.action,
      ...(presentation.actionLabel ? { actionLabel: presentation.actionLabel } : {}),
      ...(presentation.secondaryAction ? { secondaryAction: presentation.secondaryAction } : {}),
      ...(presentation.secondaryActionLabel ? { secondaryActionLabel: presentation.secondaryActionLabel } : {}),
      ...(blockers ? { blockers } : {}),
    };
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.options.publish(status);
    return status;
  }
}
