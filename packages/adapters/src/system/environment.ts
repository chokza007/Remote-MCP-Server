export interface EnvironmentSnapshot {
  readonly keys: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export interface EnvironmentServiceOptions {
  readonly source?: Readonly<Record<string, string | undefined>>;
}

const sensitiveName = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|AUTH|COOKIE)/iu;

function redactValue(name: string, value: string): string {
  if (sensitiveName.test(name)) return "[REDACTED]";
  return value
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, "$1[REDACTED]@")
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED]");
}

export class EnvironmentService {
  readonly #source: Readonly<Record<string, string | undefined>>;

  public constructor(options: EnvironmentServiceOptions = {}) {
    this.#source = options.source ?? process.env;
  }

  public snapshot(): EnvironmentSnapshot {
    const entries = Object.entries(this.#source)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"));
    return {
      keys: entries.map(([name]) => name),
      values: Object.fromEntries(entries.map(([name, value]) => [name, redactValue(name, value)]))
    };
  }
}

export function createEnvironmentService(options: EnvironmentServiceOptions = {}): EnvironmentService {
  return new EnvironmentService(options);
}
