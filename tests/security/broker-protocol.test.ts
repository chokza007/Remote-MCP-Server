import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  BrokerFrameDecoder,
  BrokerClient,
  createCapabilityTokenService,
  createGrantService,
  createNonceStore,
  encodeBrokerFrame,
  verifyPrivilegedRequest
} from "@remote-mcp/control-plane";
import {
  asClientId,
  asCorrelationId,
  asDeviceId,
  asPrincipalId
} from "@remote-mcp/contracts";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

const protector = {
  protect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x42),
  unprotect: (value: Uint8Array): Uint8Array => Uint8Array.from(value, (byte) => byte ^ 0x42)
};

function fixture(mode: "full_access" | "read_only" = "full_access") {
  const database = openDatabase({ filename: ":memory:" });
  migrateDatabase(database);
  const now = { value: new Date("2026-10-07T00:00:00.000Z") };
  const grants = createGrantService({ database, protector, now: () => now.value });
  const identity = {
    principalId: asPrincipalId("broker-principal"),
    clientId: asClientId(`broker-client-${mode}`),
    deviceId: asDeviceId(grants.serverIdentity().deviceId)
  };
  const request = grants.request({ identity, mode, scopes: ["computer:*"], requestedBy: "test" });
  const grant = grants.grant(request.id, { id: "owner", kind: "local_owner" });
  const capabilities = createCapabilityTokenService({
    database,
    grants,
    protector,
    now: () => now.value,
    isEmergencyStopActive: () => false
  });
  return { database, grants, grant, identity, capabilities, now };
}

describe("privileged broker protocol", () => {
  test("issues and verifies a one-shot capability bound to action, payload, targets, grant, epoch, correlation, and SID", () => {
    const state = fixture();
    try {
      const payload = { name: "RemoteMcpFixture", operation: "restart" };
      const capability = state.capabilities.issue({
        identity: state.identity,
        action: "service.restart",
        targets: ["service://RemoteMcpFixture"],
        payload,
        correlationId: asCorrelationId("broker-correlation"),
        callerSid: "S-1-5-21-1000",
        ttlMs: 10_000
      });
      expect(capability.claims).toMatchObject({
        action: "service.restart",
        targets: ["service://RemoteMcpFixture"],
        grantId: state.grant.id,
        securityEpoch: 1,
        correlationId: "broker-correlation",
        callerSid: "S-1-5-21-1000",
        payloadHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
      });
      const snapshot = state.capabilities.authorizationSnapshot();
      const nonceStore = createNonceStore({ now: () => state.now.value });
      expect(
        verifyPrivilegedRequest(
          { action: "service.restart", targets: ["service://RemoteMcpFixture"], payload, capability },
          {
            publicKey: state.capabilities.publicKey(),
            authorizationSnapshot: snapshot,
            actualCallerSid: "S-1-5-21-1000",
            now: () => state.now.value,
            nonceStore
          }
        )
      ).toMatchObject({ grantId: state.grant.id, action: "service.restart" });
      expect(() =>
        verifyPrivilegedRequest(
          { action: "service.restart", targets: ["service://RemoteMcpFixture"], payload, capability },
          {
            publicKey: state.capabilities.publicKey(),
            authorizationSnapshot: snapshot,
            actualCallerSid: "S-1-5-21-1000",
            now: () => state.now.value,
            nonceStore
          }
        )
      ).toThrow(/nonce|replay/i);
    } finally {
      state.database.close();
    }
  });

  test("denies read-only, revoked, stale-epoch, expired, SID-mismatched, and altered requests", () => {
    const readOnly = fixture("read_only");
    try {
      expect(() => readOnly.capabilities.issue({
        identity: readOnly.identity,
        action: "filesystem.create_directory",
        targets: ["C:\\fixture"],
        payload: {},
        correlationId: asCorrelationId("read-only"),
        callerSid: "S-1-5-21-1000"
      })).toThrow(/full access/i);
    } finally {
      readOnly.database.close();
    }

    const state = fixture();
    try {
      const request = {
        action: "fixture.echo",
        targets: ["fixture://echo"],
        payload: { value: "safe" }
      };
      const capability = state.capabilities.issue({
        identity: state.identity,
        ...request,
        correlationId: asCorrelationId("security-negative"),
        callerSid: "S-1-5-21-1000",
        ttlMs: 1_000
      });
      const snapshot = state.capabilities.authorizationSnapshot();
      const options = () => ({
        publicKey: state.capabilities.publicKey(),
        authorizationSnapshot: snapshot,
        actualCallerSid: "S-1-5-21-1000",
        now: () => state.now.value,
        nonceStore: createNonceStore()
      });
      expect(() => verifyPrivilegedRequest(
        { ...request, payload: { value: "altered" }, capability },
        options()
      )).toThrow(/payload/i);
      expect(() => verifyPrivilegedRequest(
        { ...request, action: "service.stop", capability },
        options()
      )).toThrow(/action/i);
      expect(() => verifyPrivilegedRequest(
        { ...request, capability },
        { ...options(), actualCallerSid: "S-1-5-21-9999" }
      )).toThrow(/sid|caller/i);
      expect(() => verifyPrivilegedRequest(
        { ...request, capability: { ...capability, signature: `${capability.signature.slice(0, -2)}AA` } },
        options()
      )).toThrow(/signature/i);

      state.now.value = new Date("2026-10-07T00:00:02.000Z");
      expect(() => verifyPrivilegedRequest({ ...request, capability }, options())).toThrow(/expired/i);

      state.grants.revoke(state.grant.id, { id: "owner", kind: "local_owner" }, "test revoke");
      expect(() => state.capabilities.issue({
        identity: state.identity,
        ...request,
        correlationId: asCorrelationId("revoked"),
        callerSid: "S-1-5-21-1000"
      })).toThrow(/revoked|grant/i);

      const stale = fixture();
      try {
        stale.grants.rotateSecurityEpoch({ id: "owner", kind: "local_owner" });
        expect(() => stale.capabilities.issue({
          identity: stale.identity,
          ...request,
          correlationId: asCorrelationId("stale"),
          callerSid: "S-1-5-21-1000"
        })).toThrow(/epoch|grant/i);
      } finally {
        stale.database.close();
      }
    } finally {
      state.database.close();
    }
  });

  test("rejects revoked grants and emergency stop from an independently signed authorization snapshot", () => {
    const state = fixture();
    try {
      const payload = { value: "before-revoke" };
      const capability = state.capabilities.issue({
        identity: state.identity,
        action: "fixture.echo",
        targets: ["fixture://echo"],
        payload,
        correlationId: asCorrelationId("snapshot-revoke"),
        callerSid: "S-1-5-21-1000"
      });
      state.grants.revoke(state.grant.id, { id: "owner", kind: "local_owner" }, "operator revoke");
      const revokedSnapshot = state.capabilities.authorizationSnapshot();
      expect(() => verifyPrivilegedRequest(
        { action: "fixture.echo", targets: ["fixture://echo"], payload, capability },
        {
          publicKey: state.capabilities.publicKey(),
          authorizationSnapshot: revokedSnapshot,
          actualCallerSid: "S-1-5-21-1000",
          now: () => state.now.value,
          nonceStore: createNonceStore()
        }
      )).toThrow(/revoked|inactive/i);

      const stoppedCapabilities = createCapabilityTokenService({
        database: state.database,
        grants: state.grants,
        protector,
        now: () => state.now.value,
        isEmergencyStopActive: () => true
      });
      const stoppedSnapshot = stoppedCapabilities.authorizationSnapshot();
      expect(() => verifyPrivilegedRequest(
        { action: "fixture.echo", targets: ["fixture://echo"], payload, capability },
        {
          publicKey: stoppedCapabilities.publicKey(),
          authorizationSnapshot: stoppedSnapshot,
          actualCallerSid: "S-1-5-21-1000",
          now: () => state.now.value,
          nonceStore: createNonceStore()
        }
      )).toThrow(/emergency stop/i);
      expect(() => stoppedCapabilities.issue({
        identity: state.identity,
        action: "fixture.echo",
        targets: ["fixture://echo"],
        payload,
        correlationId: asCorrelationId("emergency-stop"),
        callerSid: "S-1-5-21-1000"
      })).toThrow(/emergency stop/i);
    } finally {
      state.database.close();
    }
  });

  test("uses bounded length-prefixed framing and rejects malformed frames", () => {
    const frame = encodeBrokerFrame({ protocolVersion: 1, requestId: "frame", ok: true });
    const decoder = new BrokerFrameDecoder({ maxFrameBytes: 1_024 });
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([
      { protocolVersion: 1, requestId: "frame", ok: true }
    ]);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(2_000, 0);
    expect(() => decoder.push(oversized)).toThrow(/frame|size|large/i);
    expect(() => encodeBrokerFrame({ bad: "x".repeat(2_000) }, 100)).toThrow(/frame|size|large/i);
  });

  test("restricts the named pipe ACL to the configured caller, LocalSystem, and administrators", () => {
    const source = readFileSync(resolve(process.cwd(), "broker/src/NamedPipeServer.cs"), "utf8");
    expect(source).toContain("SetAccessRuleProtection(true, false)");
    expect(source).toContain("new SecurityIdentifier(options.CallerSid)");
    expect(source).toContain("WellKnownSidType.LocalSystemSid");
    expect(source).toContain("WellKnownSidType.BuiltinAdministratorsSid");
    expect(source).not.toMatch(/WorldSid|AuthenticatedUserSid|Everyone/iu);
  });

  test("routes every privileged action class through an explicit structured handler", () => {
    const source = readFileSync(resolve(process.cwd(), "broker/src/Handlers.cs"), "utf8");
    for (const action of [
      "service.start",
      "service.stop",
      "service.restart",
      "package.install",
      "package.uninstall",
      "registry.set",
      "registry.delete",
      "firewall.add",
      "firewall.delete",
      "process.terminate",
      "filesystem.create_directory",
      "filesystem.write_file",
      "command.execute"
    ]) {
      expect(source).toContain(`\"${action}\"`);
    }
    expect(source).toContain("ProcessStartInfo");
    expect(source).toContain("ArgumentList.Add");
    expect(source).toContain("UseShellExecute = false");
  });

  test("rejects an unsigned response from a process impersonating the broker pipe", async () => {
    const pipeName = `remote-mcp-impostor-${crypto.randomUUID()}`;
    const path = `\\\\.\\pipe\\${pipeName}`;
    const server = createServer((socket) => {
      const decoder = new BrokerFrameDecoder();
      socket.on("data", (chunk) => {
        const envelope = decoder.push(chunk)[0] as { requestId: string } | undefined;
        if (envelope) {
          socket.write(encodeBrokerFrame({
            protocolVersion: 1,
            requestId: envelope.requestId,
            ok: true,
            result: { forged: true }
          }));
        }
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(path, resolveListen);
    });
    try {
      const client = new BrokerClient({
        pipeName,
        sharedSecret: Buffer.alloc(32, 0x7a).toString("base64"),
        timeoutMs: 2_000
      });
      await expect(client.execute({
        action: "fixture.echo",
        targets: ["fixture://echo"],
        payload: {},
        capability: {
          version: 1,
          claims: {
            version: 1,
            action: "fixture.echo",
            targets: ["fixture://echo"],
            payloadHash: `sha256:${"0".repeat(64)}`,
            nonce: crypto.randomUUID(),
            correlationId: "impostor",
            grantId: "grant",
            grantMode: "full_access",
            principalId: "principal",
            clientId: "client",
            deviceId: "device",
            securityEpoch: 1,
            callerSid: "S-1-5-21-1000",
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 10_000).toISOString()
          },
          signature: "fixture"
        }
      })).rejects.toThrow(/proof|authentic|signature/i);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
