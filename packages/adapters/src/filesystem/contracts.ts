export interface OperationControl {
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

export interface PathInput extends OperationControl {
  readonly path: string;
}

export interface ListInput extends PathInput {
  readonly recursive?: boolean;
  readonly maxDepth?: number;
}

export interface FilesystemEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "link" | "other";
  readonly size: number;
}

export interface FilesystemStat extends FilesystemEntry {
  readonly createdAt: string;
  readonly modifiedAt: string;
}

export interface ReadRangeInput extends PathInput {
  readonly offset: number;
  readonly length: number;
  readonly encoding?: "utf8" | "base64";
}

export interface ReadRangeResult {
  readonly data: string;
  readonly bytesRead: number;
  readonly offset: number;
  readonly eof: boolean;
}

export interface WriteInput extends PathInput {
  readonly data: string;
  readonly encoding?: "utf8" | "base64";
  readonly overwrite?: boolean;
}

export interface PatchEdit {
  readonly search: string;
  readonly replace: string;
  readonly expectedOccurrences?: number;
}

export interface ApplyPatchInput extends PathInput {
  readonly edits: readonly PatchEdit[];
}

export interface TransferInput extends OperationControl {
  readonly source: string;
  readonly destination: string;
  readonly recursive?: boolean;
  readonly overwrite?: boolean;
}

export interface RenameInput extends PathInput {
  readonly newName: string;
}

export interface RemoveInput extends PathInput {
  readonly permanent: boolean;
  readonly recursive?: boolean;
}

export interface MutationResult {
  readonly dryRun: boolean;
  readonly changed: boolean;
  readonly operation: string;
  readonly source?: string;
  readonly destination?: string;
}

export interface RecycleResult extends MutationResult {
  readonly recoverable: boolean;
  readonly recycledPath?: string;
}

export interface HashInput extends PathInput {
  readonly algorithm?: "sha256" | "sha512";
}

export interface HashResult {
  readonly algorithm: "sha256" | "sha512";
  readonly digest: string;
}

export interface PermissionResult {
  readonly readable: boolean;
  readonly writable: boolean;
  readonly executable: boolean;
  readonly mode: number;
}

export interface LinkResult {
  readonly isLink: boolean;
  readonly target: string | null;
  readonly resolvedTarget: string | null;
  readonly escapesAllowedRoots: boolean;
}

export interface FilesystemAdapterOptions {
  readonly allowedRoots?: readonly string[];
  readonly recycleDirectory?: string;
  readonly maxReadBytes?: number;
  readonly beforeAtomicCommit?: (temporaryPath: string, destination: string) => void | Promise<void>;
}

export interface FilesystemAdapter {
  list(input: ListInput): Promise<readonly FilesystemEntry[]>;
  stat(input: PathInput): Promise<FilesystemStat>;
  readRange(input: ReadRangeInput): Promise<ReadRangeResult>;
  write(input: WriteInput): Promise<MutationResult>;
  applyPatch(input: ApplyPatchInput): Promise<MutationResult>;
  copy(input: TransferInput): Promise<MutationResult>;
  move(input: TransferInput): Promise<MutationResult>;
  rename(input: RenameInput): Promise<MutationResult>;
  recycle(input: PathInput): Promise<RecycleResult>;
  remove(input: RemoveInput): Promise<MutationResult>;
  hash(input: HashInput): Promise<HashResult>;
  permissions(input: PathInput): Promise<PermissionResult>;
  links(input: PathInput): Promise<LinkResult>;
}
