import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OperationalDatabase } from "@remote-mcp/persistence";

import {
  ArtifactRepository,
  type ArtifactRecord,
  type ArtifactRelation,
  type ArtifactRetention,
  type ArtifactStorage,
  type ArtifactValidationState
} from "./artifact-repository.js";
import { ArtifactLineageService, type ArtifactLineage } from "./lineage.js";

export interface ArtifactStoreOptions {
  readonly root: string;
}

export interface StoredArtifactBytes {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export async function hashArtifactFile(path: string): Promise<{ readonly sha256: string; readonly sizeBytes: number }> {
  const value = await stat(path);
  if (!value.isFile()) throw new Error(`Artifact source must be a file: ${path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return { sha256: digest.digest("hex"), sizeBytes: value.size };
}

export class ArtifactStore {
  private readonly root: string;

  public constructor(options: ArtifactStoreOptions) {
    this.root = resolve(options.root);
  }

  public async put(sourcePathValue: string): Promise<StoredArtifactBytes> {
    const sourcePath = resolve(sourcePathValue);
    const hashed = await hashArtifactFile(sourcePath);
    const destination = join(this.root, hashed.sha256.slice(0, 2), hashed.sha256);
    try {
      const existing = await hashArtifactFile(destination);
      if (existing.sha256 !== hashed.sha256 || existing.sizeBytes !== hashed.sizeBytes) {
        throw new Error(`Artifact store hash collision at ${destination}`);
      }
      return { path: destination, ...hashed };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await copyFile(sourcePath, temporary);
      const copied = await hashArtifactFile(temporary);
      if (copied.sha256 !== hashed.sha256 || copied.sizeBytes !== hashed.sizeBytes) {
        throw new Error("Artifact changed while it was being copied");
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    return { path: destination, ...hashed };
  }

  public async remove(pathValue: string): Promise<void> {
    const path = resolve(pathValue);
    const fromRoot = relative(this.root, path);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`Refusing to remove a path outside the artifact store: ${path}`);
    }
    await rm(path, { force: true });
  }
}

export interface RegisterArtifactInput {
  readonly namespace: string;
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly kind: string;
  readonly storage: ArtifactStorage;
  readonly mimeType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly retention?: ArtifactRetention;
}

export interface RelateArtifactsInput {
  readonly namespace: string;
  readonly workspaceId: string;
  readonly parentArtifactId: string;
  readonly childArtifactId: string;
  readonly relation: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ArtifactVerification extends ArtifactRecord {
  readonly relocated: boolean;
}

export interface ArtifactServiceOptions {
  readonly database: OperationalDatabase;
  readonly storeRoot: string;
  readonly now?: () => Date;
}

export class ArtifactService {
  private readonly repository: ArtifactRepository;
  private readonly lineageService: ArtifactLineageService;
  private readonly store: ArtifactStore;
  private readonly now: () => Date;

  public constructor(options: ArtifactServiceOptions) {
    this.repository = new ArtifactRepository(options.database);
    this.lineageService = new ArtifactLineageService(this.repository);
    this.store = new ArtifactStore({ root: options.storeRoot });
    this.now = options.now ?? (() => new Date());
  }

  public async register(input: RegisterArtifactInput): Promise<ArtifactRecord> {
    this.validateScope(input.namespace, input.workspaceId);
    if (input.kind.trim().length === 0) throw new Error("Artifact kind must not be empty");
    const sourcePath = resolve(input.sourcePath);
    const stored = input.storage === "managed" ? await this.store.put(sourcePath) : { path: sourcePath, ...(await hashArtifactFile(sourcePath)) };
    const timestamp = this.now().toISOString();
    const record: ArtifactRecord = {
      artifactId: randomUUID(),
      namespace: input.namespace,
      workspaceId: input.workspaceId,
      kind: input.kind,
      storage: input.storage,
      canonicalLocation: stored.path,
      originalLocation: input.storage === "managed" ? sourcePath : null,
      contentHash: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mimeType: input.mimeType ?? null,
      metadata: input.metadata ?? {},
      validationState: "valid",
      retention: input.retention ?? {},
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.repository.insert(record);
    return record;
  }

  public get(artifactId: string, namespace: string, workspaceId: string): ArtifactRecord {
    return this.repository.owned(artifactId, namespace, workspaceId);
  }

  public list(namespace: string, workspaceId: string): readonly ArtifactRecord[] {
    this.validateScope(namespace, workspaceId);
    return this.repository.list(namespace, workspaceId);
  }

  public async verify(
    artifactId: string,
    namespace: string,
    workspaceId: string,
    candidatePaths: readonly string[] = []
  ): Promise<ArtifactVerification> {
    const current = this.repository.owned(artifactId, namespace, workspaceId);
    const currentCheck = await this.check(current.canonicalLocation, current.contentHash);
    if (currentCheck.state === "valid") {
      this.repository.updateVerification(artifactId, "valid", current.canonicalLocation, currentCheck.sizeBytes, this.now().toISOString());
      return { ...this.repository.get(artifactId), relocated: false };
    }
    for (const candidateValue of current.storage === "reference" ? candidatePaths : []) {
      const candidate = resolve(candidateValue);
      const candidateCheck = await this.check(candidate, current.contentHash);
      if (candidateCheck.state === "valid") {
        this.repository.updateVerification(artifactId, "valid", candidate, candidateCheck.sizeBytes, this.now().toISOString());
        return { ...this.repository.get(artifactId), relocated: candidate !== current.canonicalLocation };
      }
    }
    this.repository.updateVerification(
      artifactId, currentCheck.state, current.canonicalLocation, current.sizeBytes, this.now().toISOString()
    );
    return { ...this.repository.get(artifactId), relocated: false };
  }

  public relate(input: RelateArtifactsInput): ArtifactRelation {
    const parent = this.repository.owned(input.parentArtifactId, input.namespace, input.workspaceId);
    const child = this.repository.owned(input.childArtifactId, input.namespace, input.workspaceId);
    if (parent.artifactId === child.artifactId) throw new Error("An artifact cannot be related to itself");
    if (input.relation.trim().length === 0) throw new Error("Artifact relation must not be empty");
    return this.repository.relate({
      parentArtifactId: parent.artifactId,
      childArtifactId: child.artifactId,
      relation: input.relation,
      metadata: input.metadata ?? {}
    });
  }

  public lineage(artifactId: string, namespace: string, workspaceId: string): ArtifactLineage {
    this.repository.owned(artifactId, namespace, workspaceId);
    return this.lineageService.get(artifactId);
  }

  public retain(
    artifactId: string,
    namespace: string,
    workspaceId: string,
    retention: ArtifactRetention
  ): ArtifactRecord {
    this.repository.owned(artifactId, namespace, workspaceId);
    if (retention.retainUntil !== undefined && !Number.isFinite(new Date(retention.retainUntil).getTime())) {
      throw new Error("Artifact retainUntil must be an ISO timestamp");
    }
    this.repository.updateRetention(artifactId, retention, this.now().toISOString());
    return this.repository.get(artifactId);
  }

  public async delete(
    artifactId: string,
    namespace: string,
    workspaceId: string,
    options: { readonly force?: boolean } = {}
  ): Promise<{ readonly artifactId: string; readonly deleted: true; readonly contentDeleted: boolean }> {
    const current = this.repository.owned(artifactId, namespace, workspaceId);
    const retainedUntil = current.retention.retainUntil === undefined ? 0 : new Date(current.retention.retainUntil).getTime();
    if (!options.force && (current.retention.pinned === true || retainedUntil > this.now().getTime())) {
      throw new Error("Artifact retention policy prevents deletion");
    }
    const removeContent = current.storage === "managed" &&
      this.repository.locationReferenceCount(current.canonicalLocation, current.artifactId) === 0;
    this.repository.delete(current.artifactId);
    if (removeContent) await this.store.remove(current.canonicalLocation);
    return { artifactId, deleted: true, contentDeleted: removeContent };
  }

  private async check(path: string, expectedHash: string): Promise<{ readonly state: ArtifactValidationState; readonly sizeBytes: number }> {
    try {
      const actual = await hashArtifactFile(path);
      return { state: actual.sha256 === expectedHash ? "valid" : "mismatch", sizeBytes: actual.sizeBytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", sizeBytes: 0 };
      throw error;
    }
  }

  private validateScope(namespace: string, workspaceId: string): void {
    if (namespace.trim().length === 0 || workspaceId.trim().length === 0) {
      throw new Error("Artifact namespace and workspace are required");
    }
  }
}

export function createArtifactService(options: ArtifactServiceOptions): ArtifactService {
  return new ArtifactService(options);
}
