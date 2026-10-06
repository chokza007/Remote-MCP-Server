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
