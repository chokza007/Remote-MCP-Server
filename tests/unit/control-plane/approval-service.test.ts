import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  asClientId,
  asCorrelationId,
  asPrincipalId,
  asSessionId,
  canonicalizeTarget
} from "@remote-mcp/contracts";
import { migrateDatabase, openDatabase, type OperationalDatabase } from "@remote-mcp/persistence";

interface ApprovalContract {
  request(context: unknown): {
    readonly id: string;
    readonly payloadHash: string;
    readonly expiresAt: string;
  };
  approveOnce(id: string, actor: { readonly id: string; readonly kind: "local_owner" }): void;
  deny(id: string, actor: { readonly id: string; readonly kind: "local_owner" }): void;
  consume(id: string, context: unknown): { readonly id: string };
}

interface ControlPlaneModule {
  createApprovalService?: (options: {
    database: OperationalDatabase;
    now: () => Date;
    ttlMs?: number;
  }) => ApprovalContract;
}

const owner = { id: "local-owner", kind: "local_owner" as const };

describe("exact interactive approvals", () => {
  let database: OperationalDatabase;
  let now: Date;
  let approvals: ApprovalContract;
  let action: Record<string, unknown>;

  beforeEach(async () => {
    database = openDatabase({ filename: ":memory:" });
    migrateDatabase(database);
    now = new Date("2026-10-06T15:00:00.000Z");
    const controlPlane = (await import("@remote-mcp/control-plane")) as ControlPlaneModule;
    expect(typeof controlPlane.createApprovalService).toBe("function");
    approvals = controlPlane.createApprovalService!({
      database,
      now: () => new Date(now),
      ttlMs: 300_000
    });
    action = {
      identity: {
        principalId: asPrincipalId("principal-approval"),
        clientId: asClientId("client-approval"),
        deviceId: "device-approval",
        sessionId: asSessionId("session-approval")
      },
      correlationId: asCorrelationId("corr-approval"),
      action: {
        name: "filesystem_remove",
        version: "1.0.0",
        riskTier: 2,
        requiredScope: "filesystem:write",
        mutates: true,
        actionClass: "filesystem"
      },
      payload: { path: "C:\\Fixture\\old.txt", permanent: true },
      targets: [await canonicalizeTarget("C:\\Fixture\\old.txt")],
      preview: { removes: ["C:\\Fixture\\old.txt"] },
      recoveryPlan: { strategy: "backup" }
    };
  });

  afterEach(() => {
    database.close();
  });

  test("binds and consumes one approved action exactly once", () => {
    const approval = approvals.request(action);
    expect(approval.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(approval.expiresAt).toBe("2026-10-06T15:05:00.000Z");

    approvals.approveOnce(approval.id, owner);
    expect(approvals.consume(approval.id, action)).toEqual({ id: approval.id });
    expect(() => approvals.consume(approval.id, action)).toThrow(/used|replay/i);
  });

  test("rejects payload substitution after approval", () => {
    const approval = approvals.request(action);
    approvals.approveOnce(approval.id, owner);

    expect(() =>
      approvals.consume(approval.id, {
        ...action,
        payload: { path: "C:\\Fixture\\different.txt", permanent: true }
      })
    ).toThrow(/payload|binding/i);
  });

  test("rejects expired and denied approvals", () => {
    const expired = approvals.request(action);
    approvals.approveOnce(expired.id, owner);
    now = new Date("2026-10-06T15:05:01.000Z");
    expect(() => approvals.consume(expired.id, action)).toThrow(/expired/i);

    now = new Date("2026-10-06T15:00:00.000Z");
    const denied = approvals.request(action);
    approvals.deny(denied.id, owner);
    expect(() => approvals.consume(denied.id, action)).toThrow(/denied|approved/i);
  });
});
