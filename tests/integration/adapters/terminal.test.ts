import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTerminalService, type TerminalService } from "@remote-mcp/adapters";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

async function waitForOutput(
  service: TerminalService,
  terminalId: string,
  pattern: RegExp,
  timeoutMs = 5_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let output = "";
  while (Date.now() < deadline) {
    const page = service.read(terminalId, offset, 64 * 1024);
    output += page.data;
    offset = page.nextOffset;
    if (pattern.test(output)) return output;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Output did not match ${pattern}: ${output}`);
}

describe("interactive terminal service", () => {
  let root: string;
  let database: OperationalDatabase;
  let service: TerminalService;
  const terminalIds: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-terminal-"));
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    service = createTerminalService({ database, allowedShells: ["powershell", "cmd", "python", "node"] });
  });

  afterEach(async () => {
    await Promise.allSettled(terminalIds.splice(0).map((id) => service.close(id)));
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  test.each([
    ["powershell", "Write-Output 'SHELL_POWERSHELL'", /SHELL_POWERSHELL/u],
    ["cmd", "echo SHELL_CMD", /SHELL_CMD/u],
    ["python", "print('SHELL_PYTHON')", /SHELL_PYTHON/u],
    ["node", "console.log('SHELL_NODE')", /SHELL_NODE/u]
  ] as const)("runs an interactive %s prompt", async (shell, command, expected) => {
    const created = await service.create({ shell, cwd: root, cols: 100, rows: 30 });
    terminalIds.push(created.terminalId);
    service.send(created.terminalId, `${command}\r`);
    expect(await waitForOutput(service, created.terminalId, expected)).toMatch(expected);
  });

  test("preserves Unicode, exact merged output order, and monotonic incremental offsets", async () => {
    const created = await service.create({ shell: "node", cwd: root, cols: 100, rows: 30 });
    terminalIds.push(created.terminalId);
    service.send(
      created.terminalId,
      'console.log("OUT_หนึ่ง");console.error("ERR_二");console.log("OUT_สาม")\r'
    );
    await waitForOutput(service, created.terminalId, /OUT_สาม/u);

    const first = service.read(created.terminalId, 0, 64 * 1024);
    expect(first.data.indexOf("OUT_หนึ่ง")).toBeLessThan(first.data.indexOf("ERR_二"));
    expect(first.data.indexOf("ERR_二")).toBeLessThan(first.data.indexOf("OUT_สาม"));
    service.send(created.terminalId, 'console.log("AFTER_OFFSET")\r');
    await waitForOutput(service, created.terminalId, /AFTER_OFFSET/u);
    const incremental = service.read(created.terminalId, first.nextOffset, 64 * 1024);
    expect(incremental.data).toContain("AFTER_OFFSET");
    expect(incremental.nextOffset).toBeGreaterThan(first.nextOffset);
  });

  test("supports control input, resize, process exit, and explicit close", async () => {
    const created = await service.create({ shell: "node", cwd: root, cols: 80, rows: 24 });
    terminalIds.push(created.terminalId);
    service.resize(created.terminalId, 120, 40);
    expect(service.status(created.terminalId)).toMatchObject({ cols: 120, rows: 40, state: "running" });
    await waitForOutput(service, created.terminalId, />/u);

    service.send(created.terminalId, "const unfinished = (");
    await new Promise((resolve) => setTimeout(resolve, 25));
    service.sendControl(created.terminalId, "ctrl_c");
    await new Promise((resolve) => setTimeout(resolve, 25));
    service.send(created.terminalId, 'console.log("CONTROL_RECOVERED")\r');
    expect(await waitForOutput(service, created.terminalId, /CONTROL_RECOVERED/u)).toContain(
      "CONTROL_RECOVERED"
    );

    service.send(created.terminalId, ".exit\r");
    const deadline = Date.now() + 15_000;
    while (service.status(created.terminalId).state === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(service.status(created.terminalId)).toMatchObject({ state: "exited", exitCode: 0 });
    await service.close(created.terminalId);
    expect(service.status(created.terminalId).state).toBe("closed");
  });

  test("marks truncated output and enforces shell policy", async () => {
    const bounded = createTerminalService({ database, allowedShells: ["node"], maxBufferBytes: 128 });
    await expect(bounded.create({ shell: "cmd", cwd: root })).rejects.toThrow(/not allowed/i);
    const created = await bounded.create({ shell: "node", cwd: root });
    terminalIds.push(created.terminalId);
    service = bounded;
    bounded.send(created.terminalId, 'console.log("X".repeat(1000))\r');
    await waitForOutput(bounded, created.terminalId, /XXXX/u);
    const page = bounded.read(created.terminalId, 0, 64 * 1024);
    expect(page.truncated).toBe(true);
    expect(page.truncatedBefore).toBeGreaterThan(0);
    expect(page.data).toContain("[output truncated]");
  });

  test("reconciles persisted running sessions as orphaned after restart", async () => {
    const created = await service.create({ shell: "node", cwd: root });
    terminalIds.push(created.terminalId);
    const restarted = createTerminalService({ database, allowedShells: ["node"] });

    expect(restarted.status(created.terminalId)).toMatchObject({ state: "orphaned", exitCode: null });
    await service.close(created.terminalId);
    terminalIds.splice(terminalIds.indexOf(created.terminalId), 1);
  });

  test("returns promotion metadata without claiming a terminal is already a job", async () => {
    const created = await service.create({ shell: "node", cwd: root });
    terminalIds.push(created.terminalId);
    expect(service.promoteToJob(created.terminalId)).toMatchObject({
      terminalId: created.terminalId,
      shell: "node",
      cwd: root,
      state: "running",
      promoted: false,
      reason: "durable_job_runtime_not_attached"
    });
  });
});
