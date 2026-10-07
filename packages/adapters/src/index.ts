export {
  createFilesystemAdapter,
  NodeFilesystemAdapter
} from "./filesystem/filesystem-adapter.js";
export type {
  ApplyPatchInput,
  FilesystemAdapter,
  FilesystemAdapterOptions,
  FilesystemEntry,
  FilesystemStat,
  HashInput,
  HashResult,
  LinkResult,
  ListInput,
  MutationResult,
  OperationControl,
  PatchEdit,
  PathInput,
  PermissionResult,
  ReadRangeInput,
  ReadRangeResult,
  RecycleResult,
  RemoveInput,
  RenameInput,
  TransferInput,
  WriteInput
} from "./filesystem/contracts.js";
export {
  discoverProjectGuidance,
  type ProjectGuidanceKind,
  type ProjectGuidanceReference
} from "./filesystem/project-discovery.js";
export {
  createSearchService,
  SearchService,
  type SearchPage,
  type SearchRequest,
  type SearchResult,
  type SearchServiceOptions,
  type SearchStatus
} from "./search/search-service.js";
export {
  createTerminalService,
  TerminalService,
  type CreateTerminalInput,
  type PromotionMetadata,
  type TerminalControl,
  type TerminalServiceOptions,
  type TerminalState,
  type TerminalStatus
} from "./terminal/terminal-service.js";
export type { TerminalShell } from "./terminal/pty-adapter.js";
export { OutputBuffer, type OutputPage } from "./terminal/output-buffer.js";
export {
  createProcessService,
  ProcessService,
  type ProcessIdentity,
  type ProcessInfo,
  type StartProcessInput,
  type TerminateProcessInput,
  type WaitProcessInput
} from "./system/processes.js";
export {
  createWindowsServiceService,
  WindowsServiceService,
  type WindowsServiceBackend,
  type WindowsServiceInfo
} from "./system/services.js";
export { createPortService, PortService, type PortListener } from "./system/ports.js";
export {
  createEnvironmentService,
  EnvironmentService,
  type EnvironmentServiceOptions,
  type EnvironmentSnapshot
} from "./system/environment.js";
export {
  createSystemDiscovery,
  SystemDiscovery,
  type CapabilityStatus,
  type SystemSnapshot
} from "./system/discovery.js";
export {
  createGitAdapter,
  ProcessGitAdapter,
  type GitAdapter,
  type GitAdapterOptions,
  type GitBranch,
  type GitBranchesResult,
  type GitConflict,
  type GitControl,
  type GitCredentialProvider,
  type GitDiffOptions,
  type GitDiffResult,
  type GitLogEntry,
  type GitLogOptions,
  type GitMutationResult,
  type GitRemoteOptions,
  type GitStatusEntry,
  type GitStatusResult
} from "./git/git-adapter.js";
export { GitAdapterError, redactGitOutput, type GitErrorCode } from "./git/git-errors.js";
export {
  discoverGitRepository,
  requireExactRepositoryRoot,
  type RepositoryDiscoveryResult
} from "./git/repository-discovery.js";
export {
  createUrlPolicy,
  DefaultUrlPolicy,
  isPrivateAddress,
  NetworkError,
  redactNetworkText,
  type AllowedUrl,
  type NetworkErrorCode,
  type ResolvedAddress,
  type UrlPolicy,
  type UrlPolicyOptions
} from "./network/url-policy.js";
export {
  createHttpService,
  NodeHttpService,
  type HttpCredentialProvider,
  type HttpRequestInput,
  type HttpResponseResult,
  type HttpService,
  type HttpServiceOptions
} from "./network/http-client.js";
export {
  createDownloadService,
  InMemoryDownloadService,
  type DownloadInput,
  type DownloadService,
  type DownloadServiceOptions,
  type DownloadState,
  type DownloadStatus,
  type DownloadVerification
} from "./network/download-service.js";
export {
  createExtractionPolicy,
  DefaultExtractionPolicy,
  ArchiveError,
  assertArchiveTarget,
  type ArchiveErrorCode,
  type ArchivePolicyOptions,
  type ExtractionPolicy,
  type RawArchiveEntry,
  type ValidatedArchiveEntry
} from "./archive/extraction-policy.js";
export {
  createArchiveService,
  ZipArchiveService,
  type ArchiveCreateEntry,
  type ArchiveCreateInput,
  type ArchiveEntry,
  type ArchiveExtractInput,
  type ArchiveMutationResult,
  type ArchiveService,
  type ArchiveServiceOptions,
  type ArchiveVerification
} from "./archive/archive-service.js";
