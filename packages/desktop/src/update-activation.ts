import {
  UpdateTransactionStore,
  selectRuntimeGeneration,
  type UpdateTransaction,
} from "@lasercode/cli";
import type { RuntimeActivationState } from "@lasercode/protocol";
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
    link: HostLink;
    publish: (status: UpdateStatus) => void;
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
    if (!transaction) return this.set({ state: "failed", updateId: marker.updateId, version: marker.version, message: "The downloaded update could not be prepared. Download it again." });
    return this.set(this.statusFor(transaction, marker));
  }

  async prepare(): Promise<UpdateStatus> {
    const marker = this.marker;
    if (!marker) return this.status;
    try {
      let transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase === "staged" || transaction.phase === "failed") {
        transaction = this.transactions.transition(marker.updateId, "parking");
      }
      if (transaction.phase !== "parking" && transaction.phase !== "ready") return this.set(this.statusFor(transaction, marker));
      const gate = transaction.phase === "ready"
        ? await this.options.link.activationStatus(marker.updateId)
        : await this.options.link.prepareActivation(marker.updateId, marker.generationId);
      return this.applyGate(gate);
    } catch {
      return this.fail("activation_prepare_failed", "The update could not be prepared. Your current work is still running.");
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
      return this.set({
        state: "downloaded",
        updateId: marker.updateId,
        version: marker.version,
        message: "Update downloaded. Prepare a restart when your current work is finished.",
      });
    } catch {
      return this.fail("activation_cancel_failed", "The app could not reopen new work yet. Try Keep working again.");
    }
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
      if (transaction.phase !== "ready") return false;
      const pointer = selectRuntimeGeneration(this.options.stateDir, marker.generationId);
      if (pointer.active.generationId !== marker.generationId) return false;
      transaction = this.transactions.transition(marker.updateId, "selected");
      transaction = this.transactions.transition(marker.updateId, "restarting");
      this.stopPolling();
      this.set({
        state: "restarting",
        updateId: marker.updateId,
        version: marker.version,
        message: "Restarting into the verified update…",
      });
      return transaction.phase === "restarting";
    } catch {
      this.fail("activation_selection_failed", "The update could not be selected. Your current version remains active.");
      return false;
    }
  }

  failLaunch(): void {
    const marker = this.marker;
    if (!marker) return;
    try {
      let transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase !== "restarting") return;
      transaction = this.transactions.transition(marker.updateId, "failed", { failureCategory: "verified_launch_failed" });
      transaction = this.transactions.transition(marker.updateId, "restoring");
      selectRuntimeGeneration(this.options.stateDir, transaction.previousGenerationId);
      this.transactions.transition(marker.updateId, "rolled_back");
      this.set({
        state: "failed",
        updateId: marker.updateId,
        version: marker.version,
        message: "The update could not start. The previous verified version remains selected.",
      });
    } catch {
      this.set({
        state: "failed",
        updateId: marker.updateId,
        version: marker.version,
        message: "The update could not start or restore the previous version. Reinstall the app before starting it.",
      });
    }
  }

  completeLaunch(launch: { launchId: string; generationId: string; version: string }): void {
    const marker = this.marker;
    if (!marker) return;
    let transaction: UpdateTransaction;
    try { transaction = this.requireTransaction(marker.updateId); }
    catch { return; }
    if (transaction.phase !== "restarting"
      || launch.generationId !== transaction.targetGenerationId
      || launch.version !== transaction.targetVersion) return;
    this.transactions.transition(marker.updateId, "succeeded", {
      selectedLaunchId: launch.launchId,
      selectedVersion: launch.version,
    });
    this.set({
      state: "succeeded",
      updateId: marker.updateId,
      version: marker.version,
      message: "The update is active.",
    });
  }

  stop(): void { this.stopPolling(); }

  private applyGate(gate: RuntimeActivationState): UpdateStatus {
    const marker = this.marker!;
    if (gate.updateId !== marker.updateId || gate.generationId !== marker.generationId) {
      return this.fail("activation_identity_mismatch", "The update preparation reply did not match this update. Nothing was restarted.");
    }
    if (gate.phase === "parked" && Object.values(gate.blockers).every((count) => count === 0)) {
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase === "parking") this.transactions.transition(marker.updateId, "ready");
      this.stopPolling();
      return this.set({
        state: "ready",
        updateId: marker.updateId,
        version: marker.version,
        blockers: gate.blockers,
        message: "The update is ready to activate. Saved sessions are kept. No active work will be stopped.",
      });
    }
    this.startPolling();
    return this.set({
      state: "parking",
      updateId: marker.updateId,
      version: marker.version,
      blockers: gate.blockers,
      message: "Waiting for current work to finish.",
    });
  }

  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const marker = this.marker;
      if (!marker) return;
      void this.options.link.activationStatus(marker.updateId)
        .then((gate) => this.applyGate(gate))
        .catch(() => { /* Reconnect keeps the same durable update id; the next poll resumes. */ });
    }, POLL_MS);
    this.timer.unref();
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private fail(category: string, message: string): UpdateStatus {
    const marker = this.marker;
    if (!marker) return this.set({ state: "error", message });
    try {
      const transaction = this.requireTransaction(marker.updateId);
      if (transaction.phase !== "succeeded" && transaction.phase !== "rolled_back") {
        this.transactions.transition(marker.updateId, "failed", { failureCategory: category });
      }
    } catch { /* The person-facing refusal still stands. */ }
    this.stopPolling();
    return this.set({ state: "failed", updateId: marker.updateId, version: marker.version, message });
  }

  private requireTransaction(updateId: string): UpdateTransaction {
    const transaction = this.transactions.read(updateId);
    if (!transaction) throw new Error("missing update transaction");
    return transaction;
  }

  private statusFor(transaction: UpdateTransaction, marker: NativeUpdateMarker): UpdateStatus {
    if (transaction.phase === "parking") return { state: "parking", updateId: marker.updateId, version: marker.version, message: "Waiting for current work to finish." };
    if (transaction.phase === "ready") return { state: "ready", updateId: marker.updateId, version: marker.version, message: "The update is ready to activate. Saved sessions are kept. No active work will be stopped." };
    if (transaction.phase === "selected" || transaction.phase === "restarting") return { state: "restarting", updateId: marker.updateId, version: marker.version, message: "Restarting into the verified update…" };
    if (transaction.phase === "succeeded") return { state: "succeeded", updateId: marker.updateId, version: marker.version, message: "The update is active." };
    if (transaction.phase === "failed") return { state: "failed", updateId: marker.updateId, version: marker.version, message: "The update could not be activated. Your current version remains selected." };
    if (transaction.phase === "restoring" || transaction.phase === "rolled_back") return { state: "failed", updateId: marker.updateId, version: marker.version, message: "The update could not start. The previous verified version remains selected." };
    return { state: "downloaded", updateId: marker.updateId, version: marker.version, message: "Update downloaded. Prepare a restart when your current work is finished." };
  }

  private set(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.options.publish(status);
    return status;
  }
}
