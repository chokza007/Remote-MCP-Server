import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  asClientId,
  asDeviceId,
  asPrincipalId,
  asSessionId,
  type ClientId,
  type DeviceId,
  type PrincipalId,
  type SessionId
} from "@remote-mcp/contracts";
import {
  migrateDatabase,
  openDatabase,
  type OperationalDatabase
} from "@remote-mcp/persistence";

interface AuthenticatedIdentity {
  readonly principalId: PrincipalId;
  readonly clientId: ClientId;
  readonly deviceId: DeviceId;
  readonly sessionId?: SessionId;
}

interface GrantServiceContract {
  serverIdentity(): { readonly deviceId: DeviceId; readonly securityEpoch: number };
  request(input: {
    readonly identity: AuthenticatedIdentity;
    readonly mode: "full_access" | "ask_sensitive" | "read_only";
    readonly scopes: readonly string[];
    readonly requestedBy: string;
  }): { readonly id: string; readonly status: "pending" };
  grant(
    requestId: string,
    actor: { readonly id: string; readonly kind: "local_owner" | "authenticated_owner" }
  ): {
    readonly id: string;
    readonly mode: string;
    readonly scopes: readonly string[];
    readonly expiresAt: string | null;
    readonly securityEpoch: number;
  };
  resolve(identity: AuthenticatedIdentity):
    | { readonly state: "granted"; readonly grant: { readonly id: string } }
    | { readonly state: "restricted"; readonly reason: string };
  revoke(
    grantId: string,
    actor: { readonly id: string; readonly kind: "local_owner" | "authenticated_owner" },
    reason: string
  ): void;
  rotateSecurityEpoch(actor: {
    readonly id: string;
    readonly kind: "local_owner" | "authenticated_owner";
  }): number;
  unlinkDevice(
    deviceId: DeviceId,
    actor: { readonly id: string; readonly kind: "local_owner" | "authenticated_owner" },
    reason: string
  ): void;
  list(): readonly { readonly id: string; readonly revokedAt: string | null }[];
}

interface ControlPlaneModule {
  createGrantService?: (options: {
    database: OperationalDatabase;
    now?: () => Date;
    protector?: {
      protect(value: Uint8Array): Uint8Array;
      unprotect(value: Uint8Array): Uint8Array;
    };
  }) => GrantServiceContract;
}

const owner = { id: "local-owner", kind: "local_owner" as const };

describe("persistent trusted grants", () => {
  let database: OperationalDatabase;
  let now: Date;
  let service: GrantServiceContract;

  beforeEach(async () => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    now = new Date("2026-10-06T15:00:00.000Z");
    const controlPlane = (await import("@remote-mcp/control-plane")) as ControlPlaneModule;
    expect(typeof controlPlane.createGrantService).toBe("function");
    service = controlPlane.createGrantService!({
      database,
      now: () => new Date(now),
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0xa5),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0xa5)
      }
    });
  });

  afterEach(() => {
    database.close();
  });

  function identity(session = "session-1"): AuthenticatedIdentity {
    return {
      principalId: asPrincipalId("principal-1"),
      clientId: asClientId("client-1"),
      deviceId: service.serverIdentity().deviceId,
      sessionId: asSessionId(session)
    };
  }

  function grantFullAccess(): { readonly id: string } {
    const request = service.request({
      identity: identity(),
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: "principal-1"
    });
    expect(request.status).toBe("pending");
    return service.grant(request.id, owner);
  }

  test("keeps an unknown client restricted until first-time authorization", () => {
    expect(service.resolve(identity())).toEqual({ state: "restricted", reason: "unknown_client" });
  });

  test("grants Full Access once with no default expiry and recognizes a new session weeks later", () => {
    const request = service.request({
      identity: identity(),
      mode: "full_access",
      scopes: ["computer:*"],
      requestedBy: "principal-1"
    });
    const grant = service.grant(request.id, owner);

    expect(grant.mode).toBe("full_access");
    expect(grant.scopes).toEqual(["computer:*"]);
    expect(grant.expiresAt).toBeNull();
    expect(grant.securityEpoch).toBe(1);
    expect(() => service.grant(request.id, owner)).toThrow(/already|consumed/i);

    now = new Date("2026-11-27T15:00:00.000Z");
    expect(service.resolve(identity("new-chat-session"))).toEqual({
      state: "granted",
      grant: expect.objectContaining({ id: grant.id })
    });
  });

  test("rejects a grant bound to a different server device", () => {
    grantFullAccess();
    expect(
      service.resolve({
        ...identity(),
        deviceId: asDeviceId("different-device")
      })
    ).toEqual({ state: "restricted", reason: "device_mismatch" });
  });

  test("revocation blocks the next resolution immediately", () => {
    const grant = grantFullAccess();
    service.revoke(grant.id, owner, "user requested revoke");

    expect(service.resolve(identity())).toEqual({ state: "restricted", reason: "revoked" });
    expect(service.list()).toEqual([
      expect.objectContaining({ id: grant.id, revokedAt: "2026-10-06T15:00:00.000Z" })
    ]);
  });

  test("security reset invalidates grants from the previous epoch", () => {
    grantFullAccess();
    expect(service.rotateSecurityEpoch(owner)).toBe(2);

    expect(service.resolve(identity())).toEqual({
      state: "restricted",
      reason: "security_epoch_changed"
    });
  });

  test("unlinking the server device invalidates its grants", () => {
    grantFullAccess();
    service.unlinkDevice(service.serverIdentity().deviceId, owner, "device removed");

    expect(service.resolve(identity())).toEqual({ state: "restricted", reason: "device_unlinked" });
  });
});
