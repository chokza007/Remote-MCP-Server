import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  BrokerClient,
  createCapabilityTokenService,
  createGrantService
} from "@remote-mcp/control-plane";
import { asClientId, asCorrelationId, asDeviceId, asPrincipalId } from "@remote-mcp/contracts";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

const execFileAsync = promisify(execFile);
const project = resolve(process.cwd(), "broker/RemoteMcp.Broker.csproj");
const assembly = resolve(process.cwd(), "broker/bin/Release/net10.0-windows/RemoteMcp.Broker.dll");
const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x6d),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x6d)
};

async function currentSid(): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"
  ], { windowsHide: true });
  return stdout.trim();
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("Broker ready timeout")), 10_000);
    const onData = (chunk: Buffer): void => {
      if (chunk.toString("utf8").includes("BROKER_READY")) {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        resolveReady();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Broker exited before ready: ${code}`));
    });
  });
}

describe("Windows privileged broker", () => {
  const roots: string[] = [];
  const children: ChildProcess[] = [];
  const databases: OperationalDatabase[] = [];

  beforeAll(async () => {
    await execFileAsync("dotnet", ["build", project, "-c", "Release", "--nologo"], {
      cwd: process.cwd(),
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024
    });
  }, 130_000);

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill();
      await new Promise((resolveDone) => child.once("exit", resolveDone));
    }
    for (const database of databases.splice(0)) database.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(() => undefined);

  test("executes covered actions without per-command approval, rejects replay/revoke, and redacts audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-mcp-broker-"));
    roots.push(root);
    const database = openDatabase({ filename: join(root, "operational.db") });
    databases.push(database);
    migrateDatabase(database);
    const grants = createGrantService({ database, protector });
    const identity = {
      principalId: asPrincipalId("broker-integration-principal"),
      clientId: asClientId("broker-integration-client"),
      deviceId: asDeviceId(grants.serverIdentity().deviceId)
    };
    const pending = grants.request({
      identity,
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: "integration"
    });
    const grant = grants.grant(pending.id, { id: "owner", kind: "local_owner" });
    const capabilities = createCapabilityTokenService({ database, grants, protector });
    const snapshotPath = join(root, "authorization.json");
    const auditPath = join(root, "audit.jsonl");
    const sharedSecret = Buffer.alloc(32, 0x5c).toString("base64");
    const sharedSecretPath = join(root, "transport-secret.txt");
    const runtimeStatePath = join(root, "runtime-state.json");
    await capabilities.writeAuthorizationSnapshot(snapshotPath);
    await writeFile(sharedSecretPath, sharedSecret, "utf8");
    const sid = await currentSid();
    const pipeName = `remote-mcp-test-${crypto.randomUUID()}`;
    const brokerArguments = [
      assembly,
      "--console",
      "--allow-fixtures",
      "--pipe", pipeName,
      "--public-key", capabilities.publicKey(),
      "--authorization-state", snapshotPath,
      "--audit", auditPath,
      "--shared-secret-file", sharedSecretPath,
      "--runtime-state", runtimeStatePath,
      "--caller-sid", sid
    ];
    const startBroker = async (): Promise<ChildProcess> => {
      const running = spawn("dotnet", brokerArguments, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(running);
      await waitForReady(running);
      return running;
    };
    let child = await startBroker();
    const client = new BrokerClient({ pipeName, sharedSecret, timeoutMs: 5_000 });

    await new Promise<void>((resolveMalformed, rejectMalformed) => {
      const socket = createConnection(`\\\\.\\pipe\\${pipeName}`);
      const timer = setTimeout(() => {
        socket.destroy();
        rejectMalformed(new Error("Malformed frame was not disconnected"));
      }, 5_000);
      socket.once("connect", () => {
        const oversized = Buffer.alloc(4);
        oversized.writeUInt32LE(2_000_000, 0);
        socket.write(oversized);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        resolveMalformed();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        rejectMalformed(error);
      });
    });

    const payload = { message: "hello", apiToken: "BROKER_AUDIT_CANARY" };
    const capability = capabilities.issue({
      identity,
      action: "fixture.echo",
      targets: ["fixture://echo"],
      payload,
      correlationId: asCorrelationId("broker-integration-one"),
      callerSid: sid
    });
    const request = { action: "fixture.echo", targets: ["fixture://echo"], payload, capability };

    await expect(client.execute(request)).resolves.toMatchObject({
      ok: true,
      result: { message: "hello", apiToken: "[REDACTED]" }
    });

    child.kill();
    await new Promise((resolveDone) => child.once("exit", resolveDone));
    children.splice(children.indexOf(child), 1);
    child = await startBroker();
    await expect(client.execute(request)).rejects.toThrow(/replay|nonce/i);

    const directoryPath = join(root, "privileged-directory-fixture");
    const directoryPayload = { path: directoryPath };
    const directoryCapability = capabilities.issue({
      identity,
      action: "filesystem.create_directory",
      targets: [directoryPath],
      payload: directoryPayload,
      correlationId: asCorrelationId("broker-integration-directory"),
      callerSid: sid
    });
    const directoryResult = await client.execute({
      action: "filesystem.create_directory",
      targets: [directoryPath],
      payload: directoryPayload,
      capability: directoryCapability
    });
    expect(directoryResult).toMatchObject({ ok: true, result: { created: true } });
    expect((directoryResult.result as { path: string }).path).toBe(await realpath(directoryPath));
    expect((await stat(directoryPath)).isDirectory()).toBe(true);

    const unused = capabilities.issue({
      identity,
      action: "fixture.echo",
      targets: ["fixture://echo"],
      payload: { message: "after revoke" },
      correlationId: asCorrelationId("broker-integration-two"),
      callerSid: sid
    });
    grants.revoke(grant.id, { id: "owner", kind: "local_owner" }, "integration revoke");
    await capabilities.writeAuthorizationSnapshot(snapshotPath);
    await expect(client.execute({
      action: "fixture.echo",
      targets: ["fixture://echo"],
      payload: { message: "after revoke" },
      capability: unused
    })).rejects.toThrow(/revoked|inactive/i);

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain("fixture.echo");
    expect(audit).toContain("filesystem.create_directory");
    expect(audit).toContain("transport");
    expect(audit).not.toContain("BROKER_AUDIT_CANARY");

    child.kill();
    await new Promise((resolveDone) => child.once("exit", resolveDone));
    children.splice(children.indexOf(child), 1);
    await expect(client.execute(request)).rejects.toThrow(/disconnect|pipe|broker/i);
  }, 30_000);
});
