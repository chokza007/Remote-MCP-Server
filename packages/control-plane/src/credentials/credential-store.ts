import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface CredentialMetadata {
  readonly credentialId: string;
  readonly namespace: string;
  readonly credentialType: string;
  readonly vaultTarget: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface CredentialRow {
  readonly id: string;
  readonly namespace: string;
  readonly credential_type: string;
  readonly vault_target: string;
  readonly metadata_json: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

function metadata(row: CredentialRow): CredentialMetadata {
  return {
    credentialId: row.id,
    namespace: row.namespace,
    credentialType: row.credential_type,
    vaultTarget: row.vault_target,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

export class CredentialStore {
  public constructor(private readonly database: OperationalDatabase) {}

  public insert(value: CredentialMetadata): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO credential_refs(
          id, namespace, credential_type, vault_target, metadata_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      ).run(
        value.credentialId,
        value.namespace,
        value.credentialType,
        value.vaultTarget,
        JSON.stringify(value.metadata),
        value.createdAt,
        value.updatedAt
      );
    });
  }

  public get(credentialId: string): CredentialMetadata | null {
    const row = this.database.read((connection) => connection.prepare(
      "SELECT * FROM credential_refs WHERE id = ?"
    ).get(credentialId) as CredentialRow | undefined);
    return row ? metadata(row) : null;
  }

  public list(namespace: string): readonly CredentialMetadata[] {
    return this.database.read((connection) =>
      (connection.prepare(
        "SELECT * FROM credential_refs WHERE namespace = ? AND deleted_at IS NULL ORDER BY created_at, id"
      ).all(namespace) as CredentialRow[]).map(metadata)
    );
  }

  public touch(credentialId: string, updatedAt: string): void {
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE credential_refs SET updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(updatedAt, credentialId);
    });
  }

  public tombstone(credentialId: string, deletedAt: string): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        "UPDATE credential_refs SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
      ).run(deletedAt, deletedAt, credentialId);
    });
  }
}
