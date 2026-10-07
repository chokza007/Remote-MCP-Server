import type { OperationalDatabase } from "@remote-mcp/persistence";

import { createJobRunner, type JobRunner } from "../jobs/runner.js";
import type { JobService } from "../jobs/job-service.js";
import type { CapabilityRegistry } from "./capability-registry.js";

declare const capabilityRunBrand: unique symbol;
export type CapabilityRunId = string & { readonly [capabilityRunBrand]: true };

export class SelfTestService {
  readonly #jobs: JobService;
  readonly #registry: CapabilityRegistry;
  readonly #runner: JobRunner;

  public constructor(options: {
    readonly database: OperationalDatabase;
    readonly jobs: JobService;
    readonly registry: CapabilityRegistry;
  }) {
    this.#jobs = options.jobs;
    this.#registry = options.registry;
    this.#runner = createJobRunner({ database: options.database, authorizeStep: () => ({ allowed: true }) });
    this.#runner.register("capability-self-test", async (step) => {
      const capabilityId = String((step.payload as { readonly capabilityId: string }).capabilityId);
      const result = await this.#registry.get(capabilityId).selfTest();
      this.#registry.recordTest(capabilityId, result);
      return result.verified
        ? { result, verification: { verified: true, evidence: { capabilityId, ...result.evidence as object } } }
        : { result };
    });
  }

  public async run(
    selection: readonly string[],
    identity: { readonly principalId: string; readonly clientId: string }
  ): Promise<CapabilityRunId> {
    const selected = selection.length === 0 ? this.#registry.definitions().map(({ id }) => id) : [...new Set(selection)];
    for (const id of selected) this.#registry.get(id);
    if (selected.length === 0) throw new Error("No capabilities are registered");
    const submitted = this.#jobs.submit({
      kind: "capability-self-test",
      principalId: identity.principalId,
      clientId: identity.clientId,
      retryPolicy: { maxAttempts: 1 },
      steps: selected.map((capabilityId, index) => ({
        stepId: `capability-${index + 1}`,
        kind: "capability-self-test",
        payload: { capabilityId },
        dependsOn: index === 0 ? [] : [`capability-${index}`],
        idempotent: true
      }))
    });
    while (["queued", "running"].includes(this.#jobs.get(submitted.jobId).state)) {
      if (await this.#runner.runNext() === null) break;
    }
    return submitted.jobId as CapabilityRunId;
  }
}
