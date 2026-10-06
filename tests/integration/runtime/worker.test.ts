import { describe, expect, test, vi } from "vitest";

import { createDurableWorker } from "../../../apps/worker/src/worker.js";

describe("durable worker", () => {
  test("reconciles persisted work before claiming a new job", async () => {
    const order: string[] = [];
    const worker = createDurableWorker({
      reconciler: {
        reconcile: async () => {
          order.push("reconcile");
          return { reattached: 0, requeued: 1, orphaned: 0 };
        }
      },
      runner: {
        runNext: async () => {
          order.push("run");
          return "job-one";
        }
      }
    });

    await expect(worker.runOnce()).resolves.toBe("job-one");
    await expect(worker.runOnce()).resolves.toBe("job-one");
    expect(order).toEqual(["reconcile", "run", "run"]);
  });

  test("polls in the background and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      let runs = 0;
      const worker = createDurableWorker({
        reconciler: {
          reconcile: async () => ({ reattached: 0, requeued: 0, orphaned: 0 })
        },
        runner: {
          runNext: async () => {
            runs += 1;
            return null;
          }
        }
      });

      worker.start(10);
      await vi.advanceTimersByTimeAsync(35);
      await worker.stop();
      const stoppedAt = runs;
      await vi.advanceTimersByTimeAsync(50);
      expect(runs).toBe(stoppedAt);
      expect(runs).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
