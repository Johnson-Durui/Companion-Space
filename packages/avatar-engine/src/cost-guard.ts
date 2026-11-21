import type { VideoDriverCostEvent } from "./types";

export interface CostGuardConfig {
  idleSuspendSec: number;
  maxSessionMinutes: number;
  maxSessionCostCny: number;
  costPerMinuteCny: number;
}

export interface CostGuardCallbacks {
  onTick?: (usage: VideoDriverCostEvent) => void;
  onSuspend: (reason: string) => void;
  onResume: () => void;
  onBudgetExceeded: (reason: string) => void;
}

export class LiveCostGuard {
  private activeSec = 0;
  private idleSec = 0;
  private suspended = false;
  private tripped = false;

  constructor(
    private readonly config: CostGuardConfig,
    private readonly callbacks: CostGuardCallbacks,
  ) {}

  get snapshot(): VideoDriverCostEvent {
    const estimated = Number(((this.activeSec / 60) * this.config.costPerMinuteCny).toFixed(2));
    return {
      activeSec: this.activeSec,
      estimatedCostCny: this.config.costPerMinuteCny > 0 ? estimated : undefined,
      suspended: this.suspended,
    };
  }

  recordActivity(): void {
    this.idleSec = 0;
    if (this.suspended && !this.tripped) {
      this.suspended = false;
      this.callbacks.onResume();
      this.callbacks.onTick?.(this.snapshot);
    }
  }

  tick(deltaSec: number, isIdle: boolean): void {
    if (this.tripped || deltaSec <= 0) return;
    if (this.suspended) {
      this.callbacks.onTick?.(this.snapshot);
      return;
    }

    this.activeSec += deltaSec;
    if (isIdle) {
      this.idleSec += deltaSec;
    } else {
      this.idleSec = 0;
    }

    const usage = this.snapshot;
    this.callbacks.onTick?.(usage);

    if (this.activeSec >= this.config.maxSessionMinutes * 60) {
      this.tripped = true;
      this.suspended = true;
      this.callbacks.onBudgetExceeded("Session time limit reached.");
      return;
    }
    if (
      this.config.costPerMinuteCny > 0 &&
      (usage.estimatedCostCny ?? 0) >= this.config.maxSessionCostCny
    ) {
      this.tripped = true;
      this.suspended = true;
      this.callbacks.onBudgetExceeded("Session cost cap reached.");
      return;
    }
    if (this.idleSec >= this.config.idleSuspendSec) {
      this.suspended = true;
      this.callbacks.onSuspend("Suspended after learner silence.");
      this.callbacks.onTick?.(this.snapshot);
    }
  }

  forceSuspend(reason: string): void {
    if (this.suspended) return;
    this.suspended = true;
    this.callbacks.onSuspend(reason);
    this.callbacks.onTick?.(this.snapshot);
  }
}
