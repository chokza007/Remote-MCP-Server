import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createEnvironmentService,
  createPortService,
  createProcessService,
  createSystemDiscovery,
  createWindowsServiceService,
  type ProcessIdentity,
  type WindowsServiceBackend,
  type WindowsServiceInfo
} from "@remote-mcp/adapters";

describe("process, service, port, and system adapters", () => {
  let root: string;
  const processIdentities: ProcessIdentity[] = [];
  const listeners: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "remote-mcp-system-"));
  });

  afterEach(async () => {
    const processes = createProcessService();
    await Promise.allSettled(
      processIdentities.splice(0).map((identity) =>
        processes.terminateTree({ identity, force: true }).catch(() => undefined)
      )
    );
    await Promise.allSettled(
      listeners.splice(0).map((listener) => new Promise<void>((resolve) => listener.close(() => resolve())))
    );
    await rm(root, { recursive: true, force: true });
  });

  test("starts, inspects, waits for, and terminates an exact process tree identity", async () => {
    const processes = createProcessService();
    const identity = await processes.start({
      file: process.execPath,
      args: [
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
        "--",
        "--token=PROCESS_CANARY"
      ],
      cwd: root
    });
    processIdentities.push(identity);

    expect(await processes.inspect(identity.pid)).toMatchObject({
      identity,
      name: expect.stringMatching(/node/i),
      commandLine: expect.not.stringContaining("PROCESS_CANARY")
    });
    expect((await processes.list()).some((entry) => entry.identity.pid === identity.pid)).toBe(true);
    await expect(
      processes.wait({ identity, timeoutMs: 50 })
    ).rejects.toThrow(/timeout/i);

    await processes.terminateTree({ identity, force: true });
    expect(await processes.wait({ identity, timeoutMs: 5_000 })).toMatchObject({ exitCode: expect.any(Number) });
    processIdentities.splice(processIdentities.indexOf(identity), 1);
  });

  test("rejects stale creation identity and reports a missing PID", async () => {
    const processes = createProcessService();
    const identity = await processes.start({
      file: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root
    });
    processIdentities.push(identity);

    await expect(
      processes.terminateTree({
        identity: { ...identity, createdAt: "2000-01-01T00:00:00.000Z" },
        force: true
      })
    ).rejects.toThrow(/identity|creation/i);
    await expect(processes.inspect(999_999_999)).rejects.toThrow(/not found/i);
  });

  test("supports cancellation while waiting", async () => {
    const processes = createProcessService();
    const identity = await processes.start({
      file: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      cwd: root
    });
    processIdentities.push(identity);
    const controller = new AbortController();
    controller.abort();

    await expect(
      processes.wait({ identity, timeoutMs: 1_000, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("resolves ephemeral TCP listeners to their owning PID", async () => {
    const listener = createServer();
    listeners.push(listener);
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP listener address");

    const ports = createPortService();
    const resolved = await ports.resolve(address.port, "tcp");
    expect(resolved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: address.port, protocol: "tcp", pid: process.pid })
      ])
    );
    expect((await ports.listeners()).some((entry) => entry.port === address.port)).toBe(true);
  });

  test("routes Windows service lifecycle through a backend suitable for the privileged broker", async () => {
    let state: WindowsServiceInfo["state"] = "stopped";
    const backend: WindowsServiceBackend = {
      list: async () => [{ name: "RemoteMcpFixture", displayName: "Fixture", state, startMode: "manual", processId: null }],
      inspect: async (name) => ({ name, displayName: "Fixture", state, startMode: "manual", processId: null }),
      start: async () => {
        state = "running";
      },
      stop: async () => {
        state = "stopped";
      }
    };
    const services = createWindowsServiceService({ backend });

    expect(await services.inspect("RemoteMcpFixture")).toMatchObject({ state: "stopped" });
    await services.start("RemoteMcpFixture");
    expect(await services.inspect("RemoteMcpFixture")).toMatchObject({ state: "running" });
    await services.restart("RemoteMcpFixture");
    expect(await services.inspect("RemoteMcpFixture")).toMatchObject({ state: "running" });
    await services.stop("RemoteMcpFixture");
    expect(await services.list()).toEqual([expect.objectContaining({ state: "stopped" })]);
  });

  test("redacts sensitive environment values and reports truthful capabilities", async () => {
    const environment = createEnvironmentService({
      source: {
        PATH: "C:\\Windows",
        API_TOKEN: "ENVIRONMENT_CANARY",
        DATABASE_URL: "https://user:pass@example.test/db"
      }
    });
    const snapshot = environment.snapshot();
    expect(snapshot.values).toMatchObject({
      PATH: "C:\\Windows",
      API_TOKEN: "[REDACTED]",
      DATABASE_URL: "https://[REDACTED]@example.test/db"
    });
    expect(JSON.stringify(snapshot)).not.toContain("ENVIRONMENT_CANARY");

    const discovery = createSystemDiscovery();
    const system = await discovery.snapshot();
    expect(system).toMatchObject({ platform: "win32", arch: process.arch, hostname: expect.any(String) });
    const capabilities = await discovery.capabilities();
    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "powershell", available: true }),
        expect.objectContaining({ name: "node", available: true })
      ])
    );
  });
});
