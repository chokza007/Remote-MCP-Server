import type { OperationalDatabase } from "@remote-mcp/persistence";

import type { GrantActor } from "../auth/grant-types.js";

interface EmergencyStopState {
  readonly active: boolean;
  readonly actor: string;
  readonly reason: string;
  readonly changedAt: string;
}

export interface EmergencyStopServiceOptions {
  readonly database: OperationalDatabase;
  readonly now?: () => Date;
}

export class EmergencyStopService {
  readonly #database: OperationalDatabase;
  readonly #now: () => Date;

  public constructor(options: EmergencyStopServiceOptions) {
    this.#database = options.database;
    this.#now = options.now ?? (() => new Date());
  }

  public activate(actor: GrantActor, reason: string): void {
    this.write({
      active: true,
      actor: `${actor.kind}:${actor.id}`,
      reason,
      changedAt: this.#now().toISOString()
    });
  }

  public clear(actor: GrantActor): void {
    this.write({
      active: false,
      actor: `${actor.kind}:${actor.id}`,
      reason: "cleared",
      changedAt: this.#now().toISOString()
    });
  }

  public status(): EmergencyStopState {
    const row = this.#database.read(
      (connection) =>
        connection
          .prepare(
            "SELECT value_json FROM operational_state WHERE namespace = 'security' AND key = 'emergency_stop'"
          )
          .get() as { value_json: string } | undefined
    );
    return row
      ? (JSON.parse(row.value_json) as EmergencyStopState)
      : { active: false, actor: "system", reason: "not_activated", changedAt: "" };
  }

  public isActive(): boolean {
    return this.status().active;
  }

  private write(state: EmergencyStopState): void {
    this.#database.writeTransaction((connection) => {
      connection
        .prepare(
          `INSERT INTO operational_state(namespace, key, value_json, updated_at)
           VALUES ('security', 'emergency_stop', ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`
        )
        .run(JSON.stringify(state), state.changedAt);
    });
  }
}

export function createEmergencyStopService(
  options: EmergencyStopServiceOptions
): EmergencyStopService {
  return new EmergencyStopService(options);
}
