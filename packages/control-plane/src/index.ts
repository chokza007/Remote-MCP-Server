export {
  DeviceIdentityService,
  DpapiSecretProtector,
  type SecretProtector,
  type ServerIdentity
} from "./auth/device-identity.js";
export { createGrantService, GrantService, type GrantServiceOptions } from "./auth/grant-service.js";
export type {
  AuthenticatedIdentity,
  GrantActor,
  GrantMode,
  GrantRequest,
  GrantRequestInput,
  GrantResolution,
  TrustedGrant,
  TrustedGrantSummary
} from "./auth/grant-types.js";
export {
  ApprovalService,
  createApprovalService,
  type ApprovalRequestResult,
  type ApprovalServiceOptions
} from "./approval/approval-service.js";
export type { ActionContext, ActionMetadata } from "./policy/action-context.js";
export type { AuthorizationDecision } from "./policy/authorization-decision.js";
export {
  createEmergencyStopService,
  EmergencyStopService,
  type EmergencyStopServiceOptions
} from "./policy/emergency-stop.js";
export {
  createPolicyEngine,
  PolicyEngine,
  type PolicyEngineOptions
} from "./policy/policy-engine.js";
export {
  createRedactor,
  Redactor,
  type RedactedValue
} from "./security/redactor.js";
export type { Disposable } from "./security/secret-fingerprints.js";
export {
  createAuditService,
  AuditService,
  type AuditIntegrityResult,
  type AuditPage,
  type AuditServiceOptions
} from "./audit/audit-service.js";
export type { AuditEventId, AuditEventInput } from "./audit/audit-event.js";
export {
  canonicalJson,
  CapabilityTokenService,
  createCapabilityTokenService,
  createNonceStore,
  hashBrokerPayload,
  verifyPrivilegedRequest,
  type BrokerAuthorizationStateV1,
  type BrokerGrantStateV1,
  type CapabilityClaimsV1,
  type CapabilityTokenServiceOptions,
  type CapabilityTokenV1,
  type IssueCapabilityInput,
  type NonceStore,
  type PrivilegedRequest,
  type SignedBrokerAuthorizationSnapshotV1,
  type VerifyPrivilegedRequestOptions
} from "./broker/capability-token.js";
export {
  BrokerClient,
  BrokerFrameDecoder,
  encodeBrokerFrame,
  type BrokerClientOptions,
  type PrivilegedResult
} from "./broker/broker-client.js";
export {
  CredentialStore,
  type CredentialMetadata
} from "./credentials/credential-store.js";
export {
  createCredentialService,
  CredentialService,
  type CreateCredentialInput,
  type CredentialLease,
  type CredentialServiceOptions,
  type UpdateCredentialInput
} from "./credentials/credential-service.js";
export {
  createWindowsCredentialManager,
  WindowsCredentialManager,
  type WindowsCredentialManagerOptions
} from "./credentials/windows-credential-manager.js";
export type {
  CredentialVault,
  VaultCredential
} from "./credentials/windows-credential-manager.js";
