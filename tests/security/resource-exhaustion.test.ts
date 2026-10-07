import { describe, expect, test } from "vitest";

import { createSecurityLimiter } from "@remote-mcp/control-plane";
import { createProcessService } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";
import { createJobService } from "@remote-mcp/runtime";

describe("central security resource limits", () => {
  test("rejects oversized request, response, archive, and media work before allocation", () => {
    const limiter = createSecurityLimiter({
      maxRequestBytes: 8,
      maxResponseBytes: 16,
      maxArchiveEntries: 2,
      maxArchiveExpandedBytes: 32,
      maxArchiveCompressionRatio: 4,
      maxMediaInputBytes: 64
    });

    expect(() => limiter.assertRequestBytes(9)).toThrow(/request.*8/i);
    expect(() => limiter.assertResponseBytes(17)).toThrow(/response.*16/i);
    expect(() => limiter.assertArchive({ entries: 3, expandedBytes: 1, compressedBytes: 1 })).toThrow(/entries/i);
    expect(() => limiter.assertArchive({ entries: 1, expandedBytes: 33, compressedBytes: 33 })).toThrow(/expanded/i);
    expect(() => limiter.assertArchive({ entries: 1, expandedBytes: 20, compressedBytes: 4 })).toThrow(/ratio/i);
    expect(() => limiter.assertMediaInputBytes(65)).toThrow(/media.*64/i);
  });

  test("applies backpressure to process and job fork storms and releases capacity", () => {
    const limiter = createSecurityLimiter({ maxConcurrentProcesses: 2, maxConcurrentJobs: 1 });
    const first = limiter.acquire("process");
    const second = limiter.acquire("process");
    expect(() => limiter.acquire("process")).toThrow(/process.*capacity/i);
    first.dispose();
    expect(() => limiter.acquire("process")).not.toThrow();

    const job = limiter.acquire("job");
    expect(() => limiter.acquire("job")).toThrow(/job.*capacity/i);
    job.dispose();
    second.dispose();
  });

  test("enforces the central active-job ceiling in the durable queue", () => {
    const database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    try {
      const jobs = createJobService({ database, maxActiveJobs: 1 });
      const submission = {
        kind: "fixture",
        principalId: "principal",
        clientId: "client",
        steps: [{ stepId: "one", kind: "fixture", payload: {}, dependsOn: [], idempotent: true }]
      } as const;
      jobs.submit(submission);
      expect(() => jobs.submit(submission)).toThrow(/job.*capacity/i);
    } finally {
      database.close();
    }
  });

  test("enforces the process ceiling before spawning another child", async () => {
    const processes = createProcessService({
      limiter: createSecurityLimiter({ maxConcurrentProcesses: 1 })
    });
    const first = await processes.start({
      file: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 2"]
    });
    try {
      await expect(processes.start({
        file: "powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 2"]
      })).rejects.toThrow(/process.*capacity/i);
    } finally {
      await processes.terminateTree({ identity: first }).catch(() => undefined);
    }
  });
});
