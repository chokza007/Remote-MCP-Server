import type { GrantId } from "@remote-mcp/contracts";

export type AuthorizationDecision =
  | {
      readonly kind: "allow";
      readonly source: "persistent_grant" | "restricted_grant" | "read_only" | "interactive_approval";
      readonly grantId: GrantId;
      readonly controls: {
        readonly requiresPreview: boolean;
        readonly requiresRecoveryEvidence: boolean;
      };
    }
  | {
      readonly kind: "require_approval";
      readonly approvalId: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "deny";
      readonly reason: string;
    };
