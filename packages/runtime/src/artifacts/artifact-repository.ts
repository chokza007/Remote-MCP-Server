import { RemoteMcpError } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export type ArtifactStorage = "managed" | "reference";
export type ArtifactValidationState = "valid" | "missing" | "mismatch";

export interface ArtifactRetention {
  readonly pinned?: boolean;
  readonly retainUntil?: string;
}

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly namespace: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly storage: ArtifactStorage;
  readonly canonicalLocation: string;
  readonly originalLocation: string | null;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mimeType: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly validationState: ArtifactValidationState;
  readonly retention: ArtifactRetention;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ArtifactRelation {
  readonly parentArtifactId: string;
  readonly childArtifactId: string;
  readonly relation: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface ArtifactRow {
  readonly id: string;
  readonly namespace: string;
  readonly workspace_id: string | null;
  readonly kind: string;
  readonly storage_mode: ArtifactStorage;
  readonly canonical_location: string;
  readonly original_location: string | null;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly mime_type: string | null;
  readonly metadata_json: string;
  readonly validation_state: ArtifactValidationState;
  readonly retention_json: string;
  readonly created_at: string;
  readonly updated_at: string | null;
}

interface RelationRow {
  readonly parent_artifact_id: string;
  readonly child_artifact_id: string;
  readonly relation: string;
  readonly metadata_json: string;
}

function artifact(row: ArtifactRow): ArtifactRecord {
  return {
    artifactId: row.id,
    namespace: row.namespace,
    workspaceId: row.workspace_id ?? "",
    kind: row.kind,
    storage: row.storage_mode,
    canonicalLocation: row.canonical_location,
    originalLocation: row.original_location,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    validationState: row.validation_state,
    retention: JSON.parse(row.retention_json) as ArtifactRetention,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at
  };
}

function relation(row: RelationRow): ArtifactRelation {
  return {
    parentArtifactId: row.parent_artifact_id,
    childArtifactId: row.child_artifact_id,
    relation: row.relation,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>
  };
}

function notFound(id: string): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "ARTIFACT_NOT_FOUND",
    message: "The artifact does not exist in this workspace.",
    retryable: false,
    suggestedAction: "Refresh the workspace artifact list before retrying.",
    target: id
  });
}

export class ArtifactRepository {
  public constructor(private readonly database: OperationalDatabase) {}

  public insert(record: ArtifactRecord): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO artifacts(
          id, workspace_id, kind, canonical_location, content_hash, size_bytes, mime_type,
          metadata_json, validation_state, retention_json, created_at, namespace,
          storage_mode, original_location, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.artifactId, record.workspaceId, record.kind, record.canonicalLocation,
        record.contentHash, record.sizeBytes, record.mimeType, JSON.stringify(record.metadata),
        record.validationState, JSON.stringify(record.retention), record.createdAt,
        record.namespace, record.storage, record.originalLocation, record.updatedAt
      );
    });
  }

  public get(id: string): ArtifactRecord {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined
    );
    if (!row) throw notFound(id);
    return artifact(row);
  }

  public owned(id: string, namespace: string, workspaceId: string): ArtifactRecord {
    const value = this.get(id);
    if (value.namespace !== namespace || value.workspaceId !== workspaceId) throw notFound(id);
    return value;
  }

  public list(namespace: string, workspaceId: string): readonly ArtifactRecord[] {
    return this.database.read((connection) =>
      (connection.prepare(
        "SELECT * FROM artifacts WHERE namespace = ? AND workspace_id = ? ORDER BY created_at, id"
      ).all(namespace, workspaceId) as ArtifactRow[]).map(artifact)
    );
  }

  public updateVerification(
    id: string,
    validationState: ArtifactValidationState,
    canonicalLocation: string,
    sizeBytes: number,
    now: string
  ): void {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        "UPDATE artifacts SET validation_state = ?, canonical_location = ?, size_bytes = ?, updated_at = ? WHERE id = ?"
      ).run(validationState, canonicalLocation, sizeBytes, now, id);
    });
  }

  public updateRetention(id: string, retention: ArtifactRetention, now: string): void {
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE artifacts SET retention_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(retention), now, id);
    });
  }

  public relate(value: ArtifactRelation): ArtifactRelation {
    this.database.writeTransaction((connection) => {
      connection.prepare(
        `INSERT INTO artifact_relations(parent_artifact_id, child_artifact_id, relation, metadata_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(parent_artifact_id, child_artifact_id, relation)
         DO UPDATE SET metadata_json = excluded.metadata_json`
      ).run(value.parentArtifactId, value.childArtifactId, value.relation, JSON.stringify(value.metadata));
    });
    return value;
  }

  public parents(id: string): readonly ArtifactRelation[] {
    return this.database.read((connection) =>
      (connection.prepare(
        "SELECT * FROM artifact_relations WHERE child_artifact_id = ? ORDER BY parent_artifact_id, relation"
      ).all(id) as RelationRow[]).map(relation)
    );
  }

  public children(id: string): readonly ArtifactRelation[] {
    return this.database.read((connection) =>
      (connection.prepare(
        "SELECT * FROM artifact_relations WHERE parent_artifact_id = ? ORDER BY child_artifact_id, relation"
      ).all(id) as RelationRow[]).map(relation)
    );
  }

  public locationReferenceCount(location: string, excludingId: string): number {
    return (this.database.read((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM artifacts WHERE canonical_location = ? AND id != ?"
    ).get(location, excludingId)) as { count: number }).count;
  }

  public delete(id: string): void {
    this.database.writeTransaction((connection) => {
      connection.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    });
  }
}
