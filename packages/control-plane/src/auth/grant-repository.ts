import {
  asClientId,
  asDeviceId,
  asGrantId,
  asPrincipalId,
  type DeviceId,
  type GrantId
} from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

import type {
  AuthenticatedIdentity,
  GrantActor,
  GrantRequest,
  TrustedGrant,
  TrustedGrantSummary
} from "./grant-types.js";

interface GrantRow {
  readonly id: string;
  readonly principal_id: string;
  readonly client_id: string;
  readonly device_id: string;
  readonly mode: TrustedGrant["mode"];
  readonly security_epoch: number;
  readonly created_at: string;
  readonly created_by: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
  readonly revoke_reason: string | null;
  readonly integrity_tag: string;
}

export class GrantRepository {
  readonly #database: OperationalDatabase;

  public constructor(database: OperationalDatabase) {
    this.#database = database;
  }

  public saveRequest(request: GrantRequest): void {
    this.#database.writeTransaction((connection) => {
      connection
        .prepare(
          "INSERT INTO operational_state(namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)"
        )
        .run("grant_requests", request.id, JSON.stringify(request), request.createdAt);
    });
  }

  public loadRequest(requestId: string): GrantRequest | undefined {
    const row = this.#database.read(
      (connection) =>
        connection
          .prepare(
            "SELECT value_json FROM operational_state WHERE namespace = 'grant_requests' AND key = ?"
          )
          .get(requestId) as { value_json: string } | undefined
    );
    return row ? (JSON.parse(row.value_json) as GrantRequest) : undefined;
  }

  public createGrant(
    request: GrantRequest,
    grant: TrustedGrant,
    actor: GrantActor,
    timestamp: string
  ): void {
    this.#database.writeTransaction((connection) => {
      const currentRow = connection
        .prepare(
          "SELECT value_json FROM operational_state WHERE namespace = 'grant_requests' AND key = ?"
        )
        .get(request.id) as { value_json: string } | undefined;
      if (!currentRow) {
        throw new Error(`Unknown grant request: ${request.id}`);
      }
      const current = JSON.parse(currentRow.value_json) as GrantRequest;
      if (current.status !== "pending") {
        throw new Error(`Grant request was already consumed: ${request.id}`);
      }

      connection
        .prepare("INSERT OR IGNORE INTO principals(id, display_name, created_at) VALUES (?, ?, ?)")
        .run(grant.principalId, grant.principalId, timestamp);
      connection
        .prepare(
          `INSERT OR IGNORE INTO clients(
             id, principal_id, label, credential_state, created_at
           ) VALUES (?, ?, ?, 'active', ?)`
        )
        .run(grant.clientId, grant.principalId, grant.clientId, timestamp);

      const client = connection
        .prepare("SELECT principal_id FROM clients WHERE id = ?")
        .get(grant.clientId) as { principal_id: string };
      if (client.principal_id !== grant.principalId) {
        throw new Error("Client identity is already bound to another principal");
      }

      connection
        .prepare(
          `INSERT INTO trusted_grants(
             id, principal_id, client_id, device_id, mode, security_epoch,
             created_at, created_by, expires_at, integrity_tag
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          grant.id,
          grant.principalId,
          grant.clientId,
          grant.deviceId,
          grant.mode,
          grant.securityEpoch,
          grant.createdAt,
          grant.createdBy,
          grant.expiresAt,
          grant.integrityTag
        );
      const insertScope = connection.prepare(
        "INSERT INTO grant_scopes(grant_id, scope) VALUES (?, ?)"
      );
      for (const scope of grant.scopes) {
        insertScope.run(grant.id, scope);
      }
      connection
        .prepare(
          `INSERT INTO grant_events(grant_id, event_type, actor, occurred_at, details_json)
           VALUES (?, 'granted', ?, ?, ?)`
        )
        .run(grant.id, `${actor.kind}:${actor.id}`, timestamp, "{}");

      const consumed: GrantRequest = { ...request, status: "granted", grantId: grant.id };
      connection
        .prepare(
          `UPDATE operational_state SET value_json = ?, updated_at = ?
           WHERE namespace = 'grant_requests' AND key = ?`
        )
        .run(JSON.stringify(consumed), timestamp, request.id);
    });
  }

  public matching(identity: AuthenticatedIdentity): readonly TrustedGrant[] {
    const rows = this.#database.read(
      (connection) =>
        connection
          .prepare(
            `SELECT * FROM trusted_grants
             WHERE principal_id = ? AND client_id = ? AND device_id = ?
             ORDER BY created_at DESC, id DESC`
          )
          .all(identity.principalId, identity.clientId, identity.deviceId) as GrantRow[]
    );
    return rows.map((row) => this.toGrant(row));
  }

  public revoke(grantId: GrantId, actor: GrantActor, reason: string, timestamp: string): void {
    this.#database.writeTransaction((connection) => {
      const result = connection
        .prepare(
          `UPDATE trusted_grants SET revoked_at = ?, revoked_by = ?, revoke_reason = ?
           WHERE id = ? AND revoked_at IS NULL`
        )
        .run(timestamp, `${actor.kind}:${actor.id}`, reason, grantId);
      if (result.changes !== 1) {
        throw new Error(`Grant is unknown or already revoked: ${grantId}`);
      }
      connection
        .prepare(
          `INSERT INTO grant_events(grant_id, event_type, actor, occurred_at, details_json)
           VALUES (?, 'revoked', ?, ?, ?)`
        )
        .run(grantId, `${actor.kind}:${actor.id}`, timestamp, JSON.stringify({ reason }));
    });
  }

  public unlinkDevice(deviceId: DeviceId, actor: GrantActor, reason: string, timestamp: string): void {
    this.#database.writeTransaction((connection) => {
      const result = connection
        .prepare("UPDATE devices SET unlinked_at = ? WHERE id = ? AND unlinked_at IS NULL")
        .run(timestamp, deviceId);
      if (result.changes !== 1) {
        throw new Error(`Device is unknown or already unlinked: ${deviceId}`);
      }
      const grants = connection
        .prepare("SELECT id FROM trusted_grants WHERE device_id = ?")
        .all(deviceId) as Array<{ id: string }>;
      const insertEvent = connection.prepare(
        `INSERT INTO grant_events(grant_id, event_type, actor, occurred_at, details_json)
         VALUES (?, 'device_unlinked', ?, ?, ?)`
      );
      for (const grant of grants) {
        insertEvent.run(
          grant.id,
          `${actor.kind}:${actor.id}`,
          timestamp,
          JSON.stringify({ reason })
        );
      }
    });
  }

  public isDeviceUnlinked(deviceId: DeviceId): boolean {
    const row = this.#database.read(
      (connection) =>
        connection.prepare("SELECT unlinked_at FROM devices WHERE id = ?").get(deviceId) as
          | { unlinked_at: string | null }
          | undefined
    );
    return row?.unlinked_at !== null && row?.unlinked_at !== undefined;
  }

  public list(): readonly TrustedGrantSummary[] {
    const rows = this.#database.read(
      (connection) =>
        connection.prepare("SELECT * FROM trusted_grants ORDER BY created_at, id").all() as GrantRow[]
    );
    return rows.map((row) => {
      const grant = this.toGrant(row);
      return {
        id: grant.id,
        principalId: grant.principalId,
        clientId: grant.clientId,
        deviceId: grant.deviceId,
        mode: grant.mode,
        scopes: grant.scopes,
        createdAt: grant.createdAt,
        expiresAt: grant.expiresAt,
        revokedAt: grant.revokedAt
      };
    });
  }

  private toGrant(row: GrantRow): TrustedGrant {
    const scopes = this.#database.read(
      (connection) =>
        connection
          .prepare("SELECT scope FROM grant_scopes WHERE grant_id = ? ORDER BY scope")
          .all(row.id)
          .map((scopeRow) => (scopeRow as { scope: string }).scope)
    );
    return {
      id: asGrantId(row.id),
      principalId: asPrincipalId(row.principal_id),
      clientId: asClientId(row.client_id),
      deviceId: asDeviceId(row.device_id),
      mode: row.mode,
      scopes,
      securityEpoch: row.security_epoch,
      createdAt: row.created_at,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      revokeReason: row.revoke_reason,
      integrityTag: row.integrity_tag
    };
  }
}
