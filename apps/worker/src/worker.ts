import type { JobRunner } from "@remote-mcp/runtime";

import { reconcileAtStartup, type ReconcilerLike } from "./reconcile.js";

export interface RunnerLike {
  runNext(): Promise<string | null>;
}

export interface DurableWorkerOptions {
  readonly runner: RunnerLike;
  readonly reconciler: ReconcilerLike;
  readonly onError?: (error: unknown) => void;
}

export class DurableWorker {
  readonly #runner: RunnerLike;
  readonly #reconciler: ReconcilerLike;
  readonly #onError: (error: unknown) => void;
  #reconciled = false;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight: Promise<void> | null = null;

  public constructor(options: DurableWorkerOptions) {
    this.#runner = options.runner;
    this.#reconciler = options.reconciler;
    this.#onError = options.onError ?? (() => undefined);
  }

  public async runOnce(): Promise<string | null> {
    if (!this.#reconciled) {
      await reconcileAtStartup(this.#reconciler);
      this.#reconciled = true;
    }
    return this.#runner.runNext();
  }

  public start(pollIntervalMs = 250): void {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new Error("Worker poll interval must be a positive integer");
    }
    if (this.#running) return;
    this.#running = true;
    this.#inFlight = this.tick(pollIntervalMs);
  }

  public async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
    this.#inFlight = null;
  }

  private async tick(pollIntervalMs: number): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.#onError(error);
    }
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#inFlight = this.tick(pollIntervalMs);
    }, pollIntervalMs);
  }
}

export function createDurableWorker(options: DurableWorkerOptions): DurableWorker {
  return new DurableWorker(options);
}

export type { JobRunner };
