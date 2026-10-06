import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  asClientId,
  asCorrelationId,
  asPrincipalId,
  asSessionId,
  canonicalizeTarget
} from "@remote-mcp/contracts";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";
import {
  createGrantService,
  type AuthenticatedIdentity,
  type GrantMode,
  type GrantService
} from "@remote-mcp/control-plane";

interface ActionContext {
  readonly identity: AuthenticatedIdentity;
  readonly correlationId: string;
  readonly action: {
    readonly name: string;
    readonly version: string;
    readonly riskTier: 0 | 1 | 2 | 3;
    readonly requiredScope: string;
    readonly mutates: boolean;
    readonly actionClass: string;
  };
  readonly payload: unknown;
  readonly targets: readonly unknown[];
  readonly preview: unknown;
  readonly recoveryPlan: unknown;
  readonly approvalId?: string;
}

interface PolicyContract {
  authorize(context: ActionContext): Promise<
    | { readonly kind: "allow"; readonly source: string; readonly grantId: string }
    | { readonly kind: "require_approval"; readonly approvalId: string }
    | { readonly kind: "deny"; readonly reason: string }
  >;
}

interface ApprovalContract {
  approveOnce(id: string, actor: { readonly id: string; readonly kind: "local_owner" }): void;
}

interface EmergencyContract {
  activate(actor: { readonly id: string; readonly kind: "local_owner" }, reason: string): void;
  clear(actor: { readonly id: string; readonly kind: "local_owner" }): void;
}

interface ControlPlaneModule {
  createApprovalService?: (options: {
    database: OperationalDatabase;
    now: () => Date;
  }) => ApprovalContract;
  createEmergencyStopService?: (options: {
    database: OperationalDatabase;
    now: () => Date;
  }) => EmergencyContract;
  createPolicyEngine?: (options: {
    grants: GrantService;
    approvals: ApprovalContract;
    emergencyStop: EmergencyContract;
  }) => PolicyContract;
}

const owner = { id: "local-owner", kind: "local_owner" as const };

describe("central authorization policy", () => {
  let database: OperationalDatabase;
  let grants: GrantService;
  let approvals: ApprovalContract;
  let emergencyStop: EmergencyContract;
  let policy: PolicyContract;
  let identity: AuthenticatedIdentity;
  let now: Date;

  beforeEach(async () => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    now = new Date("2026-10-06T15:00:00.000Z");
    grants = createGrantService({
      database,
      now: () => new Date(now),
      protector: {
        protect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x5a),
        unprotect: (value) => Uint8Array.from(value, (byte) => byte ^ 0x5a)
      }
    });
    identity = {
      principalId: asPrincipalId("principal-policy"),
      clientId: asClientId("client-policy"),
      deviceId: grants.serverIdentity().deviceId,
      sessionId: asSessionId("session-policy")
    };

    const controlPlane = (await import("@remote-mcp/control-plane")) as ControlPlaneModule;
    expect(typeof controlPlane.createApprovalService).toBe("function");
    expect(typeof controlPlane.createEmergencyStopService).toBe("function");
    expect(typeof controlPlane.createPolicyEngine).toBe("function");
    approvals = controlPlane.createApprovalService!({ database, now: () => new Date(now) });
    emergencyStop = controlPlane.createEmergencyStopService!({
      database,
      now: () => new Date(now)
    });
    policy = controlPlane.createPolicyEngine!({ grants, approvals, emergencyStop });
  });

  afterEach(() => {
    database.close();
  });

  function grant(mode: GrantMode, scopes: readonly string[] = ["computer:*"]): string {
    const request = grants.request({ identity, mode, scopes, requestedBy: identity.principalId });
    return grants.grant(request.id, owner).id;
  }

  async function context(
    riskTier: 0 | 1 | 2 | 3,
    overrides: Partial<ActionContext> = {}
  ): Promise<ActionContext> {
    return {
      identity,
      correlationId: asCorrelationId(`corr-${riskTier}`),
      action: {
        name: "filesystem_write",
        version: "1.0.0",
        riskTier,
        requiredScope: "filesystem:write",
        mutates: riskTier > 0,
        actionClass: "filesystem"
      },
      payload: { path: "C:\\Fixture\\file.txt", content: "safe fixture" },
      targets: [await canonicalizeTarget("C:\\Fixture\\file.txt")],
      preview: { operation: "write" },
      recoveryPlan: { strategy: "restore_backup" },
      ...overrides
    };
  }

  test("a covering Full Access Grant allows Tier 0 through Tier 3 without approval", async () => {
    const grantId = grant("full_access");

    for (const tier of [0, 1, 2, 3] as const) {
      await expect(policy.authorize(await context(tier))).resolves.toEqual(
        expect.objectContaining({ kind: "allow", source: "persistent_grant", grantId })
      );
    }

    const approvalCount = database.read(
      (connection) =>
        (connection.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number })
          .count
    );
    expect(approvalCount).toBe(0);
  });

  test("Read Only permits inspection and denies mutation", async () => {
    grant("read_only");

    await expect(policy.authorize(await context(0))).resolves.toEqual(
      expect.objectContaining({ kind: "allow", source: "read_only" })
    );
    await expect(policy.authorize(await context(1))).resolves.toEqual({
      kind: "deny",
      reason: "READ_ONLY"
    });
  });

  test("Ask for Sensitive Actions requests approval only for Tier 2 and Tier 3", async () => {
    grant("ask_sensitive");
    await expect(policy.authorize(await context(1))).resolves.toEqual(
      expect.objectContaining({ kind: "allow", source: "restricted_grant" })
    );

    const sensitive = await context(2);
    const firstDecision = await policy.authorize(sensitive);
    expect(firstDecision).toEqual(
      expect.objectContaining({ kind: "require_approval", approvalId: expect.any(String) })
    );
    if (firstDecision.kind !== "require_approval") {
      throw new Error("Expected an approval request");
    }
    approvals.approveOnce(firstDecision.approvalId, owner);
    await expect(
      policy.authorize({ ...sensitive, approvalId: firstDecision.approvalId })
    ).resolves.toEqual(expect.objectContaining({ kind: "allow", source: "interactive_approval" }));
  });

  test("a Full Access Grant cannot bypass a scope mismatch", async () => {
    grant("full_access", ["filesystem:read"]);

    await expect(policy.authorize(await context(2))).resolves.toEqual({
      kind: "deny",
      reason: "SCOPE_NOT_GRANTED"
    });
  });

  test("revocation wins before the next action dispatch", async () => {
    const grantId = grant("full_access");
    grants.revoke(grantId, owner, "stop now");

    await expect(policy.authorize(await context(1))).resolves.toEqual({
      kind: "deny",
      reason: "REVOKED"
    });
  });

  test("Emergency Stop denies every action until locally cleared", async () => {
    grant("full_access");
    emergencyStop.activate(owner, "owner pressed stop");
    await expect(policy.authorize(await context(0))).resolves.toEqual({
      kind: "deny",
      reason: "EMERGENCY_STOP"
    });

    emergencyStop.clear(owner);
    await expect(policy.authorize(await context(0))).resolves.toEqual(
      expect.objectContaining({ kind: "allow", source: "persistent_grant" })
    );
  });
});
