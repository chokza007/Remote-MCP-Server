import { randomUUID } from "node:crypto";

import { asGrantId, type DeviceId } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import {
  DeviceIdentityService,
  DpapiSecretProtector,
  type SecretProtector,
  type ServerIdentity
} from "./device-identity.js";
import { GrantRepository } from "./grant-repository.js";
import type {
  AuthenticatedIdentity,
  GrantActor,
  GrantRequest,
  GrantRequestInput,
  GrantResolution,
  TrustedGrant,
  TrustedGrantSummary
} from "./grant-types.js";

export interface GrantServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
  readonly protector?: SecretProtector;
}

function grantIntegrityMaterial(grant: Omit<TrustedGrant, "integrityTag">): string {
  return JSON.stringify({
    id: grant.id,
    principalId: grant.principalId,
    clientId: grant.clientId,
    deviceId: grant.deviceId,
    mode: grant.mode,
    scopes: [...grant.scopes].sort(),
    securityEpoch: grant.securityEpoch,
    createdAt: grant.createdAt,
    createdBy: grant.createdBy,
    expiresAt: grant.expiresAt
  });
}

export class GrantService {
  readonly #repository: GrantRepository;
  readonly #deviceIdentity: DeviceIdentityService;
  readonly #now: () => Date;

  public constructor(options: GrantServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#repository = new GrantRepository(options.database);
    this.#deviceIdentity = new DeviceIdentityService(
      options.database,
      options.protector ?? new DpapiSecretProtector(),
      this.#now
    );
    this.#deviceIdentity.loadOrCreate();
  }

  public serverIdentity(): ServerIdentity {
    return this.#deviceIdentity.loadOrCreate();
  }

  public request(input: GrantRequestInput): GrantRequest {
    if (input.identity.deviceId !== this.serverIdentity().deviceId) {
      throw new Error("Grant request is bound to a different server device");
    }
    if (input.scopes.length === 0 || input.scopes.some((scope) => scope.trim().length === 0)) {
      throw new Error("Grant request must contain at least one non-empty scope");
    }

    const request: GrantRequest = {
      ...input,
      scopes: [...new Set(input.scopes)].sort(),
      id: randomUUID(),
      createdAt: this.#now().toISOString(),
      status: "pending"
    };
    this.#repository.saveRequest(request);
    return request;
  }

  public grant(requestId: string, actor: GrantActor): TrustedGrant {
    const request = this.#repository.loadRequest(requestId);
    if (!request) {
      throw new Error(`Unknown grant request: ${requestId}`);
    }
    if (request.status !== "pending") {
      throw new Error(`Grant request was already consumed: ${requestId}`);
    }

    const serverIdentity = this.serverIdentity();
    if (request.identity.deviceId !== serverIdentity.deviceId) {
      throw new Error("Grant request no longer matches this server device");
    }

    const unsigned: Omit<TrustedGrant, "integrityTag"> = {
      id: asGrantId(randomUUID()),
      principalId: request.identity.principalId,
      clientId: request.identity.clientId,
      deviceId: request.identity.deviceId,
      mode: request.mode,
      scopes: request.scopes,
      securityEpoch: serverIdentity.securityEpoch,
      createdAt: this.#now().toISOString(),
      createdBy: `${actor.kind}:${actor.id}`,
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null
    };
    const grant: TrustedGrant = {
      ...unsigned,
      integrityTag: this.#deviceIdentity.sign(grantIntegrityMaterial(unsigned))
    };
    this.#repository.createGrant(request, grant, actor, this.#now().toISOString());
    return grant;
  }

  public resolve(identity: AuthenticatedIdentity): GrantResolution {
    const serverIdentity = this.serverIdentity();
    if (identity.deviceId !== serverIdentity.deviceId) {
      return { state: "restricted", reason: "device_mismatch" };
    }
    if (this.#repository.isDeviceUnlinked(identity.deviceId)) {
      return { state: "restricted", reason: "device_unlinked" };
    }

    const matching = this.#repository.matching(identity);
    if (matching.length === 0) {
      return { state: "restricted", reason: "unknown_client" };
    }

    for (const grant of matching) {
      const { integrityTag, ...unsigned } = grant;
      if (!this.#deviceIdentity.verify(grantIntegrityMaterial(unsigned), integrityTag)) {
        return { state: "restricted", reason: "integrity_failure" };
      }
      if (grant.revokedAt !== null) {
        return { state: "restricted", reason: "revoked" };
      }
      if (grant.securityEpoch !== serverIdentity.securityEpoch) {
        return { state: "restricted", reason: "security_epoch_changed" };
      }
      if (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= this.#now().getTime()) {
        return { state: "restricted", reason: "expired" };
      }
      return { state: "granted", grant };
    }

    return { state: "restricted", reason: "unknown_client" };
  }

  public revoke(grantId: string, actor: GrantActor, reason: string): void {
    this.#repository.revoke(asGrantId(grantId), actor, reason, this.#now().toISOString());
  }

  public rotateSecurityEpoch(_actor: GrantActor): number {
    return this.#deviceIdentity.rotateSecurityEpoch();
  }

  public unlinkDevice(deviceId: DeviceId, actor: GrantActor, reason: string): void {
    this.#repository.unlinkDevice(deviceId, actor, reason, this.#now().toISOString());
  }

  public list(): readonly TrustedGrantSummary[] {
    return this.#repository.list();
  }
}

export function createGrantService(options: GrantServiceOptions): GrantService {
  return new GrantService(options);
}
