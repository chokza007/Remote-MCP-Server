import type {
  CanonicalTarget,
  CorrelationId
} from "@remote-mcp/contracts";

import type { AuthenticatedIdentity } from "../auth/grant-types.js";

export interface ActionMetadata {
  readonly name: string;
  readonly version: string;
  readonly riskTier: 0 | 1 | 2 | 3;
  readonly requiredScope: string;
  readonly mutates: boolean;
  readonly actionClass: string;
}

export interface ActionContext {
  readonly identity: AuthenticatedIdentity;
  readonly correlationId: CorrelationId;
  readonly action: ActionMetadata;
  readonly payload: unknown;
  readonly targets: readonly CanonicalTarget[];
  readonly preview: unknown;
  readonly recoveryPlan: unknown;
  readonly approvalId?: string;
}
