import type { CanonicalTarget } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface LockRow {
  readonly resourceIdentity: string;
  readonly target: CanonicalTarget;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

interface DatabaseLockRow {
  readonly resource_identity: string;
  readonly canonical_target_json: string;
  readonly lease_id: string;
  readonly owner_id: string;
  readonly fencing_token: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

function lockRow(row: DatabaseLockRow): LockRow {
  return {
    resourceIdentity: row.resource_identity,
    target: JSON.parse(row.canonical_target_json) as CanonicalTarget,
    leaseId: row.lease_id,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at
  };
}

export class LockRepository {
  public constructor(private readonly database: OperationalDatabase) {}

  public acquire(
    targets: readonly CanonicalTarget[],
    leaseId: string,
    ownerId: string,
    acquiredAt: string,
    expiresAt: string
  ): readonly LockRow[] {
    return this.database.writeTransaction((connection) => {
      const identities = targets.map((target) => target.identityKey);
      const existing = identities.length === 0 ? [] : connection.prepare(
        `SELECT * FROM resource_locks WHERE resource_identity IN (${identities.map(() => "?").join(",")})`
      ).all(...identities) as DatabaseLockRow[];
      const active = existing.filter((row) => row.expires_at > acquiredAt);
      if (active.length > 0) return active.map(lockRow);
      if (existing.length > 0) {
        connection.prepare(
          `DELETE FROM resource_locks WHERE resource_identity IN (${existing.map(() => "?").join(",")})`
        ).run(...existing.map((row) => row.resource_identity));
      }

      const insertCounter = connection.prepare(
        "INSERT OR IGNORE INTO resource_lock_counters(resource_identity, current_token) VALUES (?, 0)"
      );
      const incrementCounter = connection.prepare(
        "UPDATE resource_lock_counters SET current_token = current_token + 1 WHERE resource_identity = ?"
      );
      const readCounter = connection.prepare(
        "SELECT current_token FROM resource_lock_counters WHERE resource_identity = ?"
      );
      const insertLock = connection.prepare(
        `INSERT INTO resource_locks(
          resource_identity, canonical_target_json, lease_id, owner_type, owner_id, fencing_token, acquired_at, expires_at
        ) VALUES (?, ?, ?, 'principal', ?, ?, ?, ?)`
      );
      const rows: LockRow[] = [];
      for (const target of targets) {
        insertCounter.run(target.identityKey);
        incrementCounter.run(target.identityKey);
        const token = (readCounter.get(target.identityKey) as { current_token: number }).current_token;
        insertLock.run(target.identityKey, JSON.stringify(target), leaseId, ownerId, token, acquiredAt, expiresAt);
        rows.push({
          resourceIdentity: target.identityKey,
          target,
          leaseId,
          ownerId,
          fencingToken: token,
          acquiredAt,
          expiresAt
        });
      }
      return rows;
    });
  }

  public byLease(leaseId: string): readonly LockRow[] {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM resource_locks WHERE lease_id = ? ORDER BY resource_identity").all(leaseId) as DatabaseLockRow[])
        .map(lockRow)
    );
  }

  public byResource(identity: string): LockRow | null {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM resource_locks WHERE resource_identity = ?").get(identity) as DatabaseLockRow | undefined
    );
    return row ? lockRow(row) : null;
  }

  public renew(leaseId: string, expiresAt: string): readonly LockRow[] {
    this.database.writeTransaction((connection) => {
      connection.prepare("UPDATE resource_locks SET expires_at = ? WHERE lease_id = ?").run(expiresAt, leaseId);
    });
    return this.byLease(leaseId);
  }

  public release(leaseId: string): number {
    return this.database.writeTransaction((connection) =>
      connection.prepare("DELETE FROM resource_locks WHERE lease_id = ?").run(leaseId).changes
    );
  }

  public reconcile(now: string): { readonly released: number; readonly leaseIds: readonly string[] } {
    return this.database.writeTransaction((connection) => {
      const leaseIds = (connection.prepare(
        "SELECT DISTINCT lease_id FROM resource_locks WHERE expires_at <= ? ORDER BY lease_id"
      ).all(now) as Array<{ lease_id: string }>).map((row) => row.lease_id);
      const released = connection.prepare("DELETE FROM resource_locks WHERE expires_at <= ?").run(now).changes;
      return { released, leaseIds };
    });
  }

  public list(ownerId?: string): readonly LockRow[] {
    return this.database.read((connection) => {
      const rows = ownerId === undefined
        ? connection.prepare("SELECT * FROM resource_locks ORDER BY resource_identity").all()
        : connection.prepare("SELECT * FROM resource_locks WHERE owner_id = ? ORDER BY resource_identity").all(ownerId);
      return (rows as DatabaseLockRow[]).map(lockRow);
    });
  }
}
