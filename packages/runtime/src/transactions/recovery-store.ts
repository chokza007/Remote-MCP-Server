import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { RemoteMcpError } from "@remote-mcp/contracts";

export interface FileRecoveryPoint {
  readonly type: "file";
  readonly target: string;
  readonly existed: boolean;
  readonly backupPath?: string;
  readonly originalSha256?: string;
}

export interface StagedFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface RecoveryStoreOptions {
  readonly root: string;
}

function hashBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recoveryError(message: string, target: string, cause?: unknown): RemoteMcpError {
  return new RemoteMcpError({
    errorCode: "TRANSACTION_RECOVERY_FAILED",
    message,
    retryable: false,
    suggestedAction: "Preserve the recovery directory and inspect the transaction before making further changes.",
    target,
    cause
  });
}

export class RecoveryStore {
  private readonly root: string;

  public constructor(options: RecoveryStoreOptions) {
    this.root = resolve(options.root);
  }

  public async snapshotFile(transactionId: string, changeId: string, targetValue: string): Promise<FileRecoveryPoint> {
    const target = resolve(targetValue);
    const info = await lstat(target).catch(() => undefined);
    if (info?.isSymbolicLink() || (info !== undefined && !info.isFile())) {
      throw recoveryError("Transactional file replacement supports only regular files or new paths.", target);
    }
    if (!info) return { type: "file", target, existed: false };
    const directory = this.changeDirectory(transactionId, changeId);
    await mkdir(directory, { recursive: true });
    const backupPath = join(directory, "original.bin");
    const content = await readFile(target);
    await writeFile(backupPath, content, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(backupPath);
      if (hashBuffer(existing) !== hashBuffer(content)) {
        throw recoveryError("An existing recovery point does not match the current file.", target);
      }
    });
    return { type: "file", target, existed: true, backupPath, originalSha256: hashBuffer(content) };
  }

  public async stageFile(transactionId: string, changeId: string, content: Uint8Array): Promise<StagedFile> {
    const directory = this.changeDirectory(transactionId, changeId);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "staged.bin");
    await writeFile(path, content);
    return { path, sha256: hashBuffer(content), sizeBytes: content.byteLength };
  }

  public async currentHash(targetValue: string): Promise<string | null> {
    const target = resolve(targetValue);
    const info = await lstat(target).catch(() => undefined);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw recoveryError("Expected a regular non-symbolic file.", target);
    return hashBuffer(await readFile(target));
  }

  public async install(stagedValue: unknown, targetValue: string): Promise<void> {
    const staged = this.asStaged(stagedValue);
    const target = resolve(targetValue);
    const content = await readFile(staged.path);
    if (hashBuffer(content) !== staged.sha256) throw recoveryError("The staged file hash does not match its recovery record.", staged.path);
    await this.atomicWrite(target, content);
  }

  public async restore(referenceValue: unknown): Promise<void> {
    const reference = this.asRecovery(referenceValue);
    if (!reference.existed) {
      await rm(reference.target, { force: true });
      return;
    }
    const backupPath = reference.backupPath!;
    const content = await readFile(backupPath).catch((cause) => {
      throw recoveryError("The recovery backup is missing or unreadable.", backupPath, cause);
    });
    if (hashBuffer(content) !== reference.originalSha256) {
      throw recoveryError("The recovery backup hash is invalid.", backupPath);
    }
    await this.atomicWrite(reference.target, content);
  }

  private changeDirectory(transactionId: string, changeId: string): string {
    return join(this.root, safeSegment(transactionId), safeSegment(changeId));
  }

  private async atomicWrite(target: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(target), { recursive: true });
    const extension = extname(target);
    const temporary = join(dirname(target), `.${basename(target, extension)}.${randomUUID()}.remote-mcp-tmp${extension}`);
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private asStaged(value: unknown): StagedFile {
    if (
      typeof value !== "object" || value === null || typeof (value as StagedFile).path !== "string" ||
      typeof (value as StagedFile).sha256 !== "string" || typeof (value as StagedFile).sizeBytes !== "number"
    ) throw recoveryError("The staged recovery record is invalid.", this.root);
    return value as StagedFile;
  }

  private asRecovery(value: unknown): FileRecoveryPoint {
    if (
      typeof value !== "object" || value === null || (value as FileRecoveryPoint).type !== "file" ||
      typeof (value as FileRecoveryPoint).target !== "string" || typeof (value as FileRecoveryPoint).existed !== "boolean"
    ) throw recoveryError("The file recovery record is invalid.", this.root);
    const reference = value as FileRecoveryPoint;
    if (reference.existed && (typeof reference.backupPath !== "string" || typeof reference.originalSha256 !== "string")) {
      throw recoveryError("The existing-file recovery record is incomplete.", reference.target);
    }
    return reference;
  }
}

export function createRecoveryStore(options: RecoveryStoreOptions): RecoveryStore {
  return new RecoveryStore(options);
}
