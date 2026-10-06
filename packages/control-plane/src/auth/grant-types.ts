import type {
  ClientId,
  DeviceId,
  GrantId,
  PrincipalId,
  SessionId
} from "@remote-mcp/contracts";

export type GrantMode = "full_access" | "ask_sensitive" | "read_only";

export interface AuthenticatedIdentity {
  readonly principalId: PrincipalId;
  readonly clientId: ClientId;
  readonly deviceId: DeviceId;
  readonly sessionId?: SessionId;
}

export interface GrantActor {
  readonly id: string;
  readonly kind: "local_owner" | "authenticated_owner";
}

export interface GrantRequestInput {
  readonly identity: AuthenticatedIdentity;
  readonly mode: GrantMode;
  readonly scopes: readonly string[];
  readonly requestedBy: string;
}

export interface GrantRequest extends GrantRequestInput {
  readonly id: string;
  readonly createdAt: string;
  readonly status: "pending" | "granted";
  readonly grantId?: GrantId;
}

export interface TrustedGrant {
  readonly id: GrantId;
  readonly principalId: PrincipalId;
  readonly clientId: ClientId;
  readonly deviceId: DeviceId;
  readonly mode: GrantMode;
  readonly scopes: readonly string[];
  readonly securityEpoch: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly integrityTag: string;
}

export type GrantResolution =
  | { readonly state: "granted"; readonly grant: TrustedGrant }
  | {
      readonly state: "restricted";
      readonly reason:
        | "unknown_client"
        | "device_mismatch"
        | "device_unlinked"
        | "revoked"
        | "expired"
        | "security_epoch_changed"
        | "integrity_failure";
    };

export interface TrustedGrantSummary {
  readonly id: GrantId;
  readonly principalId: PrincipalId;
  readonly clientId: ClientId;
  readonly deviceId: DeviceId;
  readonly mode: GrantMode;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}
