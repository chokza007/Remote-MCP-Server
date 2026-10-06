import type { GrantService } from "../auth/grant-service.js";
import type { TrustedGrant } from "../auth/grant-types.js";
import type { ApprovalService } from "../approval/approval-service.js";
import type { ActionContext } from "./action-context.js";
import type { AuthorizationDecision } from "./authorization-decision.js";
import type { EmergencyStopService } from "./emergency-stop.js";

export interface PolicyEngineOptions {
  readonly grants: GrantService;
  readonly approvals: ApprovalService;
  readonly emergencyStop: EmergencyStopService;
}

function scopeCovers(grant: TrustedGrant, requiredScope: string): boolean {
  return grant.scopes.some((scope) => {
    if (scope === "computer:*" || scope === requiredScope) {
      return true;
    }
    if (!scope.endsWith(":*")) {
      return false;
    }
    return requiredScope.startsWith(scope.slice(0, -1));
  });
}

function controls(
  context: ActionContext
): Extract<AuthorizationDecision, { kind: "allow" }>["controls"] {
  return {
    requiresPreview: context.action.riskTier >= 2,
    requiresRecoveryEvidence: context.action.riskTier >= 2 && context.action.mutates
  };
}

export class PolicyEngine {
  readonly #grants: GrantService;
  readonly #approvals: ApprovalService;
  readonly #emergencyStop: EmergencyStopService;

  public constructor(options: PolicyEngineOptions) {
    this.#grants = options.grants;
    this.#approvals = options.approvals;
    this.#emergencyStop = options.emergencyStop;
  }

  public async authorize(context: ActionContext): Promise<AuthorizationDecision> {
    if (this.#emergencyStop.isActive()) {
      return { kind: "deny", reason: "EMERGENCY_STOP" };
    }

    const resolution = this.#grants.resolve(context.identity);
    if (resolution.state === "restricted") {
      return { kind: "deny", reason: resolution.reason.toUpperCase() };
    }
    const grant = resolution.grant;
    if (!scopeCovers(grant, context.action.requiredScope)) {
      return { kind: "deny", reason: "SCOPE_NOT_GRANTED" };
    }

    if (grant.mode === "read_only") {
      if (context.action.mutates || context.action.riskTier > 0) {
        return { kind: "deny", reason: "READ_ONLY" };
      }
      return { kind: "allow", source: "read_only", grantId: grant.id, controls: controls(context) };
    }

    if (grant.mode === "full_access") {
      return {
        kind: "allow",
        source: "persistent_grant",
        grantId: grant.id,
        controls: controls(context)
      };
    }

    if (context.action.riskTier < 2) {
      return {
        kind: "allow",
        source: "restricted_grant",
        grantId: grant.id,
        controls: controls(context)
      };
    }

    if (context.approvalId) {
      this.#approvals.consume(context.approvalId, context);
      return {
        kind: "allow",
        source: "interactive_approval",
        grantId: grant.id,
        controls: controls(context)
      };
    }

    const approval = this.#approvals.request(context);
    return {
      kind: "require_approval",
      approvalId: approval.id,
      expiresAt: approval.expiresAt
    };
  }
}

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return new PolicyEngine(options);
}
