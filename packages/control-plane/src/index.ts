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
