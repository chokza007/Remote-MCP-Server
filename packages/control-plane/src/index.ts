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
