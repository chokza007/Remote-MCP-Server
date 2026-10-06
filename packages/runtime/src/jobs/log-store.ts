import type { JobLogEntry, JobPage } from "./job-types.js";
import type { JobRepository } from "./job-repository.js";

export class JobLogStore {
  readonly #repository: JobRepository;
  readonly #redact: (value: string) => string;
  readonly #now: () => Date;

  public constructor(
    repository: JobRepository,
    options: { readonly redact?: (value: string) => string; readonly now?: () => Date } = {}
  ) {
    this.#repository = repository;
    this.#redact = options.redact ?? ((value) => value);
    this.#now = options.now ?? (() => new Date());
  }

  public append(jobId: string, stream: JobLogEntry["stream"], content: string): void {
    this.#repository.appendLog(jobId, stream, this.#redact(content), this.#now().toISOString());
  }

  public page(jobId: string, cursor = 0, limit = 100): JobPage<JobLogEntry> {
    return this.#repository.logs(jobId, cursor, limit);
  }
}
