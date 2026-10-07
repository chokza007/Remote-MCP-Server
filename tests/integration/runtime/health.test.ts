import { describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CapabilityRegistry,
  HealthService,
  SelfTestService,
  createJobService
} from "@remote-mcp/runtime";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import {
  createBrowserService,
  createGuiService,
  createSystemDiscovery,
  createWindowsServiceService
} from "@remote-mcp/adapters";
import { createDefaultCapabilityRegistry } from "../../../apps/server/src/tools/health.js";

describe("capability diagnostics", () => {
  test("reports optional dependencies, failed probes, and secret-safe evidence truthfully", async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: "core.database",
      version: "1.0.0",
      required: true,
      description: "Database",
      probe: async () => ({ status: "ready", dependencies: { sqlite: "3" }, evidence: { token: "HEALTH_SECRET_CANARY" } }),
      selfTest: async () => ({ verified: true, evidence: { isolated: true } })
    });
    registry.register({
      id: "optional.browser",
      version: "1.0.0",
      required: false,
      description: "Browser",
      remediation: "Install Edge or Chrome.",
      probe: async () => ({ status: "unavailable", dependencies: { executable: "missing" } }),
      selfTest: async () => ({ verified: false, evidence: { reason: "missing" } })
    });
    registry.register({
      id: "optional.broker",
      version: "1.0.0",
      required: false,
      description: "Broker",
      probe: async () => { throw new Error("broker disconnected"); },
      selfTest: async () => ({ verified: false, evidence: {} })
    });
    const database = {
      integrityCheck: () => ["ok"],
      read: <T>(reader: (connection: { pragma(value: string): unknown }) => T): T => reader({ pragma: () => 0 })
    };
    const health = new HealthService({ database, registry });

    const report = await health.report();
    expect(report.status).toBe("degraded");
    expect(report.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "core.database", status: "ready" }),
      expect.objectContaining({ id: "optional.browser", status: "unavailable", remediation: "Install Edge or Chrome." }),
      expect.objectContaining({ id: "optional.broker", status: "failed" })
    ]));
    expect(JSON.stringify(report)).not.toContain("HEALTH_SECRET_CANARY");
  });

  test("reports database corruption and read-only operational storage as failed", async () => {
    const registry = new CapabilityRegistry();
    const corrupt = new HealthService({
      database: { integrityCheck: () => ["database disk image is malformed"], read: () => 0 },
      registry
    });
    expect(await corrupt.report()).toMatchObject({ status: "failed", database: { status: "failed" } });

    const readOnly = new HealthService({
      database: {
        integrityCheck: () => ["ok"],
        read: <T>(reader: (connection: { pragma(value: string): unknown }) => T): T => reader({ pragma: () => 1 })
      },
      registry
    });
    expect(await readOnly.report()).toMatchObject({ status: "failed", database: { status: "failed", writable: false } });
  });

  test("runs isolated capability checks as durable verified jobs", async () => {
    const database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    const registry = new CapabilityRegistry();
    let runs = 0;
    registry.register({
      id: "fixture.safe",
      version: "1.0.0",
      required: true,
      description: "Safe fixture",
      probe: async () => ({ status: "ready", dependencies: {} }),
      selfTest: async () => {
        runs += 1;
        return { verified: true, evidence: { fixture: "isolated", mutation: "temporary-only" } };
      }
    });
    const jobs = createJobService({ database });
    const selfTests = new SelfTestService({ database, jobs, registry });
    const runId = await selfTests.run(["fixture.safe"], { principalId: "system", clientId: "health" });

    expect(runs).toBe(1);
    expect(jobs.get(runId)).toMatchObject({ state: "succeeded", verification: { verified: true } });
    expect(registry.lastTest("fixture.safe")).toMatchObject({ verified: true, evidence: { fixture: "isolated" } });
    database.close();
  });

  test.runIf(process.platform === "win32")("runs selected self-tests against the local Windows machine truthfully", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-health-local-"));
    const database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    const browser = createBrowserService({
      profileRoot: join(root, "profiles"),
      artifactRoot: join(root, "artifacts")
    });
    try {
      const registry = createDefaultCapabilityRegistry({
        databaseIntegrity: () => database.integrityCheck(),
        discovery: createSystemDiscovery(),
        browser,
        gui: createGuiService({ modulePath: resolve("helpers/powershell/RemoteMcp.UIAutomation.psm1") }),
        services: createWindowsServiceService()
      });
      const jobs = createJobService({ database });
      const selfTests = new SelfTestService({ database, jobs, registry });
      const runId = await selfTests.run(
        ["core.database", "system.powershell", "browser.playwright"],
        { principalId: "local-health", clientId: "local-health" }
      );
      expect(jobs.get(runId).state).toBe("succeeded");
      const reports = await registry.probeAll();
      expect(reports.every((entry) => ["ready", "degraded", "unavailable", "failed"].includes(entry.status))).toBe(true);
      expect(reports.find((entry) => entry.id === "privileged.broker")?.status)
        .toMatch(/^(?:ready|degraded|unavailable)$/u);
    } finally {
      await browser.dispose();
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
