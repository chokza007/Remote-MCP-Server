import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify
} from "node:crypto";
import { spawnSync } from "node:child_process";

import { asDeviceId, type DeviceId } from "@remote-mcp/contracts";
import type { OperationalDatabase } from "@remote-mcp/persistence";

export interface SecretProtector {
  protect(value: Uint8Array): Uint8Array;
  unprotect(value: Uint8Array): Uint8Array;
}

const dpapiScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String([string]$request.data)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
if ([string]$request.operation -eq 'protect') {
  $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} elseif ([string]$request.operation -eq 'unprotect') {
  $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
} else {
  throw 'Unknown DPAPI operation'
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

export class DpapiSecretProtector implements SecretProtector {
  public protect(value: Uint8Array): Uint8Array {
    return this.run("protect", value);
  }

  public unprotect(value: Uint8Array): Uint8Array {
    return this.run("unprotect", value);
  }

  private run(operation: "protect" | "unprotect", value: Uint8Array): Uint8Array {
    if (process.platform !== "win32") {
      throw new Error("DPAPI protection is available only on Windows");
    }

    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", dpapiScript],
      {
        input: JSON.stringify({ operation, data: Buffer.from(value).toString("base64") }),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1_048_576
      }
    );

    if (result.status !== 0) {
      throw new Error(`DPAPI ${operation} failed: ${result.stderr.trim()}`);
    }

    return Buffer.from(result.stdout.trim(), "base64");
  }
}

export interface ServerIdentity {
  readonly deviceId: DeviceId;
  readonly publicKey: string;
  readonly securityEpoch: number;
}

interface ServerIdentityRow {
  readonly device_id: string;
  readonly public_key: string;
  readonly protected_private_key: Buffer;
  readonly security_epoch: number;
}

export class DeviceIdentityService {
  readonly #database: OperationalDatabase;
  readonly #protector: SecretProtector;
  readonly #now: () => Date;

  public constructor(
    database: OperationalDatabase,
    protector: SecretProtector,
    now: () => Date
  ) {
    this.#database = database;
    this.#protector = protector;
    this.#now = now;
  }

  public loadOrCreate(): ServerIdentity {
    return this.#database.writeTransaction((connection) => {
      const existing = connection
        .prepare(
          "SELECT device_id, public_key, protected_private_key, security_epoch FROM server_identity WHERE id = 1"
        )
        .get() as ServerIdentityRow | undefined;
      if (existing) {
        return this.toIdentity(existing);
      }

      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
      const publicDer = publicKey.export({ format: "der", type: "spki" });
      const protectedPrivateKey = Buffer.from(this.#protector.protect(privateDer));
      privateDer.fill(0);
      const timestamp = this.#now().toISOString();
      const deviceId = asDeviceId(randomUUID());

      connection
        .prepare(
          `INSERT INTO server_identity(
             id, device_id, public_key, protected_private_key, security_epoch, created_at, updated_at
           ) VALUES (1, ?, ?, ?, 1, ?, ?)`
        )
        .run(deviceId, publicDer.toString("base64"), protectedPrivateKey, timestamp, timestamp);
      connection
        .prepare("INSERT INTO devices(id, label, linked_at) VALUES (?, ?, ?)")
        .run(deviceId, "Remote MCP Server", timestamp);

      return {
        deviceId,
        publicKey: publicDer.toString("base64"),
        securityEpoch: 1
      };
    });
  }

  public rotateSecurityEpoch(): number {
    return this.#database.writeTransaction((connection) => {
      connection
        .prepare(
          "UPDATE server_identity SET security_epoch = security_epoch + 1, updated_at = ? WHERE id = 1"
        )
        .run(this.#now().toISOString());
      const row = connection
        .prepare("SELECT security_epoch FROM server_identity WHERE id = 1")
        .get() as { security_epoch: number };
      return row.security_epoch;
    });
  }

  public sign(payload: string): string {
    const row = this.row();
    const privateDer = Buffer.from(this.#protector.unprotect(row.protected_private_key));
    try {
      const key = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
      return sign(null, Buffer.from(payload, "utf8"), key).toString("base64");
    } finally {
      privateDer.fill(0);
    }
  }

  public verify(payload: string, signature: string): boolean {
    const row = this.row();
    const key = createPublicKey({
      key: Buffer.from(row.public_key, "base64"),
      format: "der",
      type: "spki"
    });
    return verify(
      null,
      Buffer.from(payload, "utf8"),
      key,
      Buffer.from(signature, "base64")
    );
  }

  private row(): ServerIdentityRow {
    const row = this.#database.read(
      (connection) =>
        connection
          .prepare(
            "SELECT device_id, public_key, protected_private_key, security_epoch FROM server_identity WHERE id = 1"
          )
          .get() as ServerIdentityRow | undefined
    );
    if (!row) {
      throw new Error("Server identity has not been initialized");
    }
    return row;
  }

  private toIdentity(row: ServerIdentityRow): ServerIdentity {
    return {
      deviceId: asDeviceId(row.device_id),
      publicKey: row.public_key,
      securityEpoch: row.security_epoch
    };
  }
}
