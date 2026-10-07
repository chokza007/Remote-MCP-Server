import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify
} from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CorrelationId } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { SecretProtector } from "../auth/device-identity.js";
import type { GrantService } from "../auth/grant-service.js";
import type { AuthenticatedIdentity, GrantMode } from "../auth/grant-types.js";

export interface CapabilityClaimsV1 {
  readonly version: 1;
  readonly action: string;
  readonly targets: readonly string[];
  readonly payloadHash: string;
  readonly nonce: string;
  readonly correlationId: string;
  readonly grantId: string;
  readonly grantMode: GrantMode;
  readonly principalId: string;
  readonly clientId: string;
  readonly deviceId: string;
  readonly securityEpoch: number;
  readonly callerSid: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface CapabilityTokenV1 {
  readonly version: 1;
  readonly claims: CapabilityClaimsV1;
  readonly signature: string;
}

export interface BrokerGrantStateV1 {
  readonly grantId: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly deviceId: string;
  readonly mode: GrantMode;
  readonly active: boolean;
  readonly revokedAt: string | null;
}

export interface BrokerAuthorizationStateV1 {
  readonly version: 1;
  readonly sequence: number;
  readonly deviceId: string;
  readonly securityEpoch: number;
  readonly emergencyStop: boolean;
  readonly issuedAt: string;
  readonly grants: readonly BrokerGrantStateV1[];
}

export interface SignedBrokerAuthorizationSnapshotV1 {
  readonly version: 1;
  readonly state: BrokerAuthorizationStateV1;
  readonly signature: string;
}

export interface PrivilegedRequest {
  readonly action: string;
  readonly targets: readonly string[];
  readonly payload: unknown;
  readonly capability: CapabilityTokenV1;
}

export interface CapabilityTokenServiceOptions {
  readonly database: OperationalDatabase;
  readonly grants: GrantService;
  readonly protector: SecretProtector;
  readonly now?: () => Date;
  readonly isEmergencyStopActive?: () => boolean;
}

export interface IssueCapabilityInput {
  readonly identity: AuthenticatedIdentity;
  readonly action: string;
  readonly targets: readonly string[];
  readonly payload: unknown;
  readonly correlationId: CorrelationId;
  readonly callerSid: string;
  readonly ttlMs?: number;
}

interface SigningKeyRecord {
  readonly publicKey: string;
  readonly protectedPrivateKey: string;
  readonly createdAt: string;
}

const signingKeyNamespace = "broker_identity";
const signingKeyName = "capability_signing_key_v1";

function jsonValue(value: unknown): unknown {
  if (value === undefined) throw new Error("Protocol values must be JSON serializable");
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export function canonicalJson(value: unknown): string {
  const normalized = jsonValue(value);
  const visit = (current: unknown): string => {
    if (current === null || typeof current !== "object") return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map(visit).join(",")}]`;
    const object = current as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${visit(object[key])}`
    ).join(",")}}`;
  };
  return visit(normalized);
}

export function hashBrokerPayload(payload: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}

function canonicalTargets(targets: readonly string[]): readonly string[] {
  if (targets.some((target) => target.trim().length === 0)) {
    throw new Error("Broker targets must not be empty");
  }
  return [...new Set(targets.map((target) => target.trim()))].sort();
}

function signatureValid(publicKey: string, value: unknown, signature: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki"
    });
    return verify(
      "sha256",
      Buffer.from(canonicalJson(value), "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64")
    );
  } catch {
    return false;
  }
}

export class CapabilityTokenService {
  readonly #database: OperationalDatabase;
  readonly #grants: GrantService;
  readonly #protector: SecretProtector;
  readonly #now: () => Date;
  readonly #isEmergencyStopActive: () => boolean;
  #lastSnapshotSequence = 0;

  public constructor(options: CapabilityTokenServiceOptions) {
    this.#database = options.database;
    this.#grants = options.grants;
    this.#protector = options.protector;
    this.#now = options.now ?? (() => new Date());
    this.#isEmergencyStopActive = options.isEmergencyStopActive ?? (() => false);
    this.loadOrCreateKey();
  }

  public publicKey(): string {
    return this.loadOrCreateKey().publicKey;
  }

  public issue(input: IssueCapabilityInput): CapabilityTokenV1 {
    if (this.#isEmergencyStopActive()) throw new Error("Emergency Stop blocks privileged capabilities");
    const resolution = this.#grants.resolve(input.identity);
    if (resolution.state !== "granted") {
      throw new Error(`Persistent grant unavailable: ${resolution.reason}`);
    }
    if (resolution.grant.mode !== "full_access") {
      throw new Error("A persistent Full Access grant is required for privileged capabilities");
    }
    const action = input.action.trim();
    if (action.length === 0) throw new Error("Broker action must not be empty");
    const callerSid = input.callerSid.trim();
    if (!/^S-\d(?:-\d+)+$/u.test(callerSid)) throw new Error("Caller SID is invalid");
    const ttlMs = input.ttlMs ?? 15_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 60_000) {
      throw new Error("Capability TTL must be from 1 through 60000 milliseconds");
    }
    const issued = this.#now();
    const claims: CapabilityClaimsV1 = {
      version: 1,
      action,
      targets: canonicalTargets(input.targets),
      payloadHash: hashBrokerPayload(input.payload),
      nonce: randomUUID(),
      correlationId: input.correlationId,
      grantId: resolution.grant.id,
      grantMode: resolution.grant.mode,
      principalId: resolution.grant.principalId,
      clientId: resolution.grant.clientId,
      deviceId: resolution.grant.deviceId,
      securityEpoch: resolution.grant.securityEpoch,
      callerSid,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + ttlMs).toISOString()
    };
    return { version: 1, claims, signature: this.sign(claims) };
  }

  public authorizationSnapshot(): SignedBrokerAuthorizationSnapshotV1 {
    const identity = this.#grants.serverIdentity();
    const now = this.#now();
    this.#lastSnapshotSequence = Math.max(this.#lastSnapshotSequence + 1, now.getTime());
    const grants = this.#grants.list().map((grant): BrokerGrantStateV1 => {
      const resolution = this.#grants.resolve({
        principalId: grant.principalId,
        clientId: grant.clientId,
        deviceId: grant.deviceId
      });
      return {
        grantId: grant.id,
        principalId: grant.principalId,
        clientId: grant.clientId,
        deviceId: grant.deviceId,
        mode: grant.mode,
        active: resolution.state === "granted" && resolution.grant.id === grant.id,
        revokedAt: grant.revokedAt
      };
    });
    const state: BrokerAuthorizationStateV1 = {
      version: 1,
      sequence: this.#lastSnapshotSequence,
      deviceId: identity.deviceId,
      securityEpoch: identity.securityEpoch,
      emergencyStop: this.#isEmergencyStopActive(),
      issuedAt: now.toISOString(),
      grants
    };
    return { version: 1, state, signature: this.sign(state) };
  }

  public async writeAuthorizationSnapshot(path: string): Promise<SignedBrokerAuthorizationSnapshotV1> {
    const snapshot = this.authorizationSnapshot();
    const destination = path.trim();
    if (destination.length === 0) throw new Error("Authorization snapshot path must not be empty");
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return snapshot;
  }

  private sign(value: unknown): string {
    const record = this.loadOrCreateKey();
    const privateDer = Buffer.from(this.#protector.unprotect(Buffer.from(record.protectedPrivateKey, "base64")));
    try {
      const key = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
      return sign(
        "sha256",
        Buffer.from(canonicalJson(value), "utf8"),
        { key, dsaEncoding: "ieee-p1363" }
      ).toString("base64");
    } finally {
      privateDer.fill(0);
    }
  }

  private loadOrCreateKey(): SigningKeyRecord {
    return this.#database.writeTransaction((connection) => {
      const existing = connection.prepare(
        "SELECT value_json FROM operational_state WHERE namespace = ? AND key = ?"
      ).get(signingKeyNamespace, signingKeyName) as { value_json: string } | undefined;
      if (existing) return JSON.parse(existing.value_json) as SigningKeyRecord;
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const privateDer = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
      const record: SigningKeyRecord = {
        publicKey: Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64"),
        protectedPrivateKey: Buffer.from(this.#protector.protect(privateDer)).toString("base64"),
        createdAt: this.#now().toISOString()
      };
      privateDer.fill(0);
      connection.prepare(
        "INSERT INTO operational_state(namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run(signingKeyNamespace, signingKeyName, JSON.stringify(record), record.createdAt);
      return record;
    });
  }
}

export interface NonceStore {
  consume(nonce: string, expiresAt: string): boolean;
}

export function createNonceStore(options: { readonly now?: () => Date } = {}): NonceStore {
  const consumed = new Map<string, number>();
  return {
    consume: (nonce, expiresAt) => {
      const now = (options.now ?? (() => new Date()))().getTime();
      for (const [key, expiry] of consumed) if (expiry <= now) consumed.delete(key);
      if (consumed.has(nonce)) return false;
      consumed.set(nonce, Date.parse(expiresAt));
      return true;
    }
  };
}

export interface VerifyPrivilegedRequestOptions {
  readonly publicKey: string;
  readonly authorizationSnapshot: SignedBrokerAuthorizationSnapshotV1;
  readonly actualCallerSid: string;
  readonly now?: () => Date;
  readonly nonceStore: NonceStore;
}

export function verifyPrivilegedRequest(
  request: PrivilegedRequest,
  options: VerifyPrivilegedRequestOptions
): CapabilityClaimsV1 {
  const snapshot = options.authorizationSnapshot;
  if (snapshot.version !== 1 || snapshot.state.version !== 1) throw new Error("Unsupported authorization snapshot");
  if (!signatureValid(options.publicKey, snapshot.state, snapshot.signature)) {
    throw new Error("Authorization snapshot signature is invalid");
  }
  const token = request.capability;
  if (token.version !== 1 || token.claims.version !== 1) throw new Error("Unsupported capability token");
  if (!signatureValid(options.publicKey, token.claims, token.signature)) {
    throw new Error("Capability signature is invalid");
  }
  const claims = token.claims;
  const now = (options.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(Date.parse(claims.issuedAt)) || !Number.isFinite(Date.parse(claims.expiresAt))) {
    throw new Error("Capability time is malformed");
  }
  if (Date.parse(claims.issuedAt) > now + 5_000) throw new Error("Capability was issued in the future");
  if (Date.parse(claims.expiresAt) <= now) throw new Error("Capability has expired");
  if (snapshot.state.emergencyStop) throw new Error("Emergency Stop is active");
  if (claims.deviceId !== snapshot.state.deviceId || claims.securityEpoch !== snapshot.state.securityEpoch) {
    throw new Error("Capability security epoch or device is stale");
  }
  if (claims.callerSid !== options.actualCallerSid) throw new Error("Caller SID mismatch");
  if (claims.action !== request.action.trim()) throw new Error("Capability action mismatch");
  if (canonicalJson(claims.targets) !== canonicalJson(canonicalTargets(request.targets))) {
    throw new Error("Capability targets mismatch");
  }
  if (claims.payloadHash !== hashBrokerPayload(request.payload)) throw new Error("Capability payload mismatch");
  const grant = snapshot.state.grants.find((candidate) => candidate.grantId === claims.grantId);
  if (!grant || !grant.active || grant.revokedAt !== null) throw new Error("Capability grant is revoked or inactive");
  if (grant.mode !== "full_access" || claims.grantMode !== "full_access") {
    throw new Error("Capability does not have Full Access");
  }
  if (
    grant.principalId !== claims.principalId ||
    grant.clientId !== claims.clientId ||
    grant.deviceId !== claims.deviceId
  ) {
    throw new Error("Capability grant identity mismatch");
  }
  if (!options.nonceStore.consume(claims.nonce, claims.expiresAt)) {
    throw new Error("Capability nonce replay detected");
  }
  return claims;
}

export function createCapabilityTokenService(
  options: CapabilityTokenServiceOptions
): CapabilityTokenService {
  return new CapabilityTokenService(options);
}
