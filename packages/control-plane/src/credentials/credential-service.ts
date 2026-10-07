import { randomUUID } from "node:crypto";

import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { Redactor } from "../security/redactor.js";
import { CredentialStore, type CredentialMetadata } from "./credential-store.js";
import type { CredentialVault } from "./windows-credential-manager.js";

export interface CreateCredentialInput {
  readonly namespace: string;
  readonly credentialType: string;
  readonly secret: string;
  readonly username?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateCredentialInput {
  readonly secret: string;
  readonly username?: string;
}

export interface CredentialLease {
  readonly credentialId: string;
  readonly credentialType: string;
  readonly username?: string;
  readonly secret: string;
}

export interface CredentialServiceOptions {
  readonly database: OperationalDatabase;
  readonly vault: CredentialVault;
  readonly redactor: Redactor;
  readonly authorizeUse?: (metadata: CredentialMetadata) => boolean | Promise<boolean>;
  readonly now?: () => Date;
}

function credentialError(code: string, message: string, target: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: code,
    message,
    retryable: code === "CREDENTIAL_VAULT_ITEM_MISSING",
    suggestedAction: code === "CREDENTIAL_AUTHORIZATION_REVOKED"
      ? "Restore a covering authorization before using this credential."
      : "Inspect credential metadata and recreate the missing vault item if necessary.",
    target
  });
}

export class CredentialService {
  private readonly store: CredentialStore;
  private readonly vault: CredentialVault;
  private readonly redactor: Redactor;
  private readonly authorizeUse: NonNullable<CredentialServiceOptions["authorizeUse"]>;
  private readonly now: () => Date;

  public constructor(options: CredentialServiceOptions) {
    this.store = new CredentialStore(options.database);
    this.vault = options.vault;
    this.redactor = options.redactor;
    this.authorizeUse = options.authorizeUse ?? (() => true);
    this.now = options.now ?? (() => new Date());
  }

  public async create(input: CreateCredentialInput): Promise<CredentialMetadata> {
    this.validate(input.namespace, input.credentialType, input.secret);
    const credentialId = randomUUID();
    const vaultTarget = `RemoteMCP/${credentialId}`;
    const secretBytes = Buffer.from(input.secret, "utf8");
    const fingerprint = this.redactor.registerEphemeral(input.secret);
    try {
      const safeMetadata = this.redactor.redact(input.metadata ?? {}) as Record<string, unknown>;
      await this.vault.write(vaultTarget, {
        secret: secretBytes,
        ...(input.username === undefined ? {} : { username: input.username })
      });
      const timestamp = this.now().toISOString();
      const record: CredentialMetadata = {
        credentialId,
        namespace: input.namespace,
        credentialType: input.credentialType,
        vaultTarget,
        metadata: safeMetadata,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null
      };
      try {
        this.store.insert(record);
      } catch (error) {
        await this.vault.delete(vaultTarget).catch(() => false);
        throw error;
      }
      return record;
    } catch (error) {
      throw this.sanitizedError(error);
    } finally {
      fingerprint.dispose();
      secretBytes.fill(0);
    }
  }

  public async update(
    credentialId: string,
    namespace: string,
    input: UpdateCredentialInput
  ): Promise<CredentialMetadata> {
    const current = this.owned(credentialId, namespace);
    if (input.secret.length === 0) throw new Error("Credential secret must not be empty");
    const secretBytes = Buffer.from(input.secret, "utf8");
    const fingerprint = this.redactor.registerEphemeral(input.secret);
    try {
      await this.vault.write(current.vaultTarget, {
        secret: secretBytes,
        ...(input.username === undefined ? {} : { username: input.username })
      });
      this.store.touch(credentialId, this.now().toISOString());
      return this.owned(credentialId, namespace);
    } catch (error) {
      throw this.sanitizedError(error);
    } finally {
      fingerprint.dispose();
      secretBytes.fill(0);
    }
  }

  public async use<Result>(
    credentialId: string,
    namespace: string,
    callback: (credential: CredentialLease) => Result | Promise<Result>
  ): Promise<Result> {
    const current = this.owned(credentialId, namespace);
    if (!await this.authorizeUse(current)) {
      throw credentialError(
        "CREDENTIAL_AUTHORIZATION_REVOKED",
        "Credential authorization was revoked before use.",
        credentialId
      );
    }
    const vaultValue = await this.vault.read(current.vaultTarget);
    if (!vaultValue) {
      throw credentialError(
        "CREDENTIAL_VAULT_ITEM_MISSING",
        "The credential vault item is missing.",
        credentialId
      );
    }
    const secretBuffer = Buffer.from(vaultValue.secret);
    const secret = secretBuffer.toString("utf8");
    const fingerprint = this.redactor.registerEphemeral(secret);
    try {
      const result = await callback({
        credentialId,
        credentialType: current.credentialType,
        secret,
        ...(vaultValue.username === undefined ? {} : { username: vaultValue.username })
      });
      return this.redactor.redact(result) as Result;
    } catch (error) {
      const message = this.redactor.redact(error instanceof Error ? error.message : String(error));
      throw new Error(String(message));
    } finally {
      fingerprint.dispose();
      secretBuffer.fill(0);
      if (Buffer.isBuffer(vaultValue.secret)) vaultValue.secret.fill(0);
    }
  }

  public async delete(
    credentialId: string,
    namespace: string
  ): Promise<{ readonly credentialId: string; readonly deleted: true; readonly vaultItemDeleted: boolean }> {
    const current = this.owned(credentialId, namespace);
    const vaultItemDeleted = await this.vault.delete(current.vaultTarget);
    this.store.tombstone(credentialId, this.now().toISOString());
    return { credentialId, deleted: true, vaultItemDeleted };
  }

  public getMetadata(credentialId: string, namespace: string): CredentialMetadata {
    return this.owned(credentialId, namespace);
  }

  public listMetadata(namespace: string): readonly CredentialMetadata[] {
    if (namespace.trim().length === 0) throw new Error("Credential namespace must not be empty");
    return this.store.list(namespace);
  }

  private owned(credentialId: string, namespace: string): CredentialMetadata {
    const value = this.store.get(credentialId);
    if (!value || value.deletedAt !== null || value.namespace !== namespace) {
      throw credentialError("CREDENTIAL_NOT_FOUND", "The credential does not exist in this namespace.", credentialId);
    }
    return value;
  }

  private validate(namespace: string, credentialType: string, secret: string): void {
    if (namespace.trim().length === 0 || credentialType.trim().length === 0 || secret.length === 0) {
      throw new Error("Credential namespace, type, and secret are required");
    }
    if (Buffer.byteLength(secret, "utf8") > 64 * 1024) throw new Error("Credential secret exceeds 64 KiB");
  }

  private sanitizedError(error: unknown): Error {
    const message = this.redactor.redact(error instanceof Error ? error.message : String(error));
    return new Error(String(message));
  }
}

export function createCredentialService(options: CredentialServiceOptions): CredentialService {
  return new CredentialService(options);
}
