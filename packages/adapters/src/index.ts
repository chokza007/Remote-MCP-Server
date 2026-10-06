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
