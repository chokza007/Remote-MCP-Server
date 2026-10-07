import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FilesystemAdapter } from "../filesystem/contracts.js";
import { discoverProjectGuidance, type ProjectGuidanceReference } from "../filesystem/project-discovery.js";

export interface CheckpointArtifactReference {
  readonly artifactId: string;
  readonly storage: "managed" | "reference";
  readonly validationState: string;
  readonly contentHash: string;
  readonly canonicalLocation: string;
}

export interface CheckpointArtifactRegistry {
  register(input: {
    readonly namespace: string;
    readonly workspaceId: string;
    readonly sourcePath: string;
    readonly kind: string;
    readonly storage: "reference";
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<CheckpointArtifactReference>;
}

export interface ProjectCheckpointHelperOptions {
  readonly filesystem: FilesystemAdapter;
  readonly artifacts?: CheckpointArtifactRegistry;
  readonly maxReadBytes?: number;
}

export interface ReadProjectCheckpointInput {
  readonly projectRoot: string;
  readonly path?: string;
}

export interface ProjectCheckpointContents {
  readonly path: string;
  readonly projectRoot: string;
  readonly sha256: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export interface UpdateProjectCheckpointInput extends ReadProjectCheckpointInput {
  readonly namespace: string;
  readonly workspaceId: string;
  readonly content: string;
  readonly expectedSha256?: string;
}

export interface ProjectCheckpointUpdate {
  readonly path: string;
  readonly projectRoot: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly changed: boolean;
  readonly artifact?: CheckpointArtifactReference;
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

export class ProjectCheckpointHelper {
  private readonly filesystem: FilesystemAdapter;
  private readonly artifacts: CheckpointArtifactRegistry | undefined;
  private readonly maxReadBytes: number;

  public constructor(options: ProjectCheckpointHelperOptions) {
    this.filesystem = options.filesystem;
    this.artifacts = options.artifacts;
    this.maxReadBytes = options.maxReadBytes ?? 4 * 1024 * 1024;
  }

  public async discover(projectRootValue: string): Promise<readonly ProjectGuidanceReference[]> {
    const projectRoot = resolve(projectRootValue);
    const metadata = await this.filesystem.stat({ path: projectRoot });
    if (metadata.kind !== "directory") throw new Error("Project root must be a directory");
    return (await discoverProjectGuidance(projectRoot)).filter((reference) => reference.kind === "checkpoint");
  }

  public async read(input: ReadProjectCheckpointInput): Promise<ProjectCheckpointContents> {
    const { projectRoot, path } = await this.resolveCheckpoint(input, true);
    const metadata = await this.filesystem.stat({ path });
    if (metadata.kind !== "file") throw new Error("Project checkpoint must be a regular file");
    if (metadata.size > this.maxReadBytes) throw new Error(`Project checkpoint is bounded to ${this.maxReadBytes} bytes`);
    const [contents, hash] = await Promise.all([
      this.filesystem.readRange({ path, offset: 0, length: metadata.size, encoding: "utf8" }),
      this.filesystem.hash({ path, algorithm: "sha256" })
    ]);
    return { path, projectRoot, sha256: hash.digest, content: contents.data, sizeBytes: metadata.size };
  }

  public async update(input: UpdateProjectCheckpointInput): Promise<ProjectCheckpointUpdate> {
    const { projectRoot, path } = await this.resolveCheckpoint(input, false);
    let beforeHash: string | null = null;
    try {
      beforeHash = (await this.filesystem.hash({ path, algorithm: "sha256" })).digest;
    } catch (error) {
      if (!/does not exist/iu.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    if (input.expectedSha256 !== undefined && beforeHash !== input.expectedSha256) {
      throw new Error("Project checkpoint changed after it was read; refusing to overwrite it");
    }
    const result = await this.filesystem.write({
      path,
      data: input.content,
      encoding: "utf8",
      overwrite: beforeHash !== null
    });
    const metadata = await this.filesystem.stat({ path });
    const sha256 = (await this.filesystem.hash({ path, algorithm: "sha256" })).digest;
    const artifact = this.artifacts === undefined ? undefined : await this.artifacts.register({
      namespace: input.namespace,
      workspaceId: input.workspaceId,
      sourcePath: path,
      kind: "project-checkpoint-reference",
      storage: "reference",
      metadata: { projectRoot }
    });
    return {
      path,
      projectRoot,
      sha256,
      sizeBytes: metadata.size,
      changed: result.changed,
      ...(artifact === undefined ? {} : { artifact })
    };
  }

  private async resolveCheckpoint(
    input: ReadProjectCheckpointInput,
    mustExist: boolean
  ): Promise<{ readonly projectRoot: string; readonly path: string }> {
    const projectRoot = resolve(input.projectRoot);
    const rootMetadata = await this.filesystem.stat({ path: projectRoot });
    if (rootMetadata.kind !== "directory") throw new Error("Project root must be a directory");
    let path: string;
    if (input.path === undefined) {
      const discovered = await this.discover(projectRoot);
      if (discovered.length > 1) throw new Error("Multiple project checkpoints were found; specify an exact path");
      if (discovered.length === 1) path = discovered[0]!.path;
      else if (mustExist) throw new Error("No WORK_CHECKPOINT.md exists in this project");
      else path = resolve(projectRoot, "WORK_CHECKPOINT.md");
    } else {
      path = resolve(input.path);
    }
    if (!within(projectRoot, path)) throw new Error("Project checkpoint path escapes the project root");
    if (basename(path).toLowerCase() !== "work_checkpoint.md") {
      throw new Error("Project checkpoint helper only manages WORK_CHECKPOINT.md files");
    }
    await this.assertPhysicalContainment(projectRoot, path, mustExist);
    if (mustExist) await this.filesystem.stat({ path });
    return { projectRoot, path };
  }

  private async assertPhysicalContainment(projectRoot: string, path: string, mustExist: boolean): Promise<void> {
    const physicalRoot = await realpath(projectRoot);
    let physicalPath: string;
    try {
      physicalPath = await realpath(path);
    } catch (error) {
      if (mustExist || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      physicalPath = join(await realpath(dirname(path)), basename(path));
    }
    if (!within(physicalRoot, physicalPath)) {
      throw new Error("Project checkpoint resolves outside the project root");
    }
  }
}

export function createProjectCheckpointHelper(options: ProjectCheckpointHelperOptions): ProjectCheckpointHelper {
  return new ProjectCheckpointHelper(options);
}
