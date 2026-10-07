export type BrowserPolicyErrorCode =
  | "url_policy_denied"
  | "evaluation_policy_denied"
  | "needs_attention";

export class BrowserPolicyError extends Error {
  public readonly code: BrowserPolicyErrorCode;

  public constructor(code: BrowserPolicyErrorCode, message: string) {
    super(message);
    this.name = "BrowserPolicyError";
    this.code = code;
  }
}

export interface BrowserPolicyOptions {
  readonly allowedOrigins?: readonly string[];
}

const deniedEvaluation = /\b(?:document\.cookie|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|EventSource)\b/iu;

export class BrowserPolicy {
  readonly #allowedOrigins: ReadonlySet<string> | undefined;

  public constructor(options: BrowserPolicyOptions = {}) {
    this.#allowedOrigins = options.allowedOrigins === undefined
      ? undefined
      : new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  }

  public validateUrl(value: string): URL {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BrowserPolicyError("url_policy_denied", "Browser URL is invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new BrowserPolicyError("url_policy_denied", `Browser URL scheme is denied: ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new BrowserPolicyError("url_policy_denied", "Credentials in browser URLs are denied");
    }
    if (this.#allowedOrigins !== undefined && !this.#allowedOrigins.has(url.origin)) {
      throw new BrowserPolicyError("url_policy_denied", `Browser origin is outside policy: ${url.origin}`);
    }
    return url;
  }

  public validateEvaluation(expression: string, pageUrl: string): void {
    this.validateUrl(pageUrl);
    if (expression.length === 0 || expression.length > 64 * 1024) {
      throw new BrowserPolicyError("evaluation_policy_denied", "Evaluation expression size is outside policy");
    }
    if (deniedEvaluation.test(expression)) {
      throw new BrowserPolicyError("evaluation_policy_denied", "Evaluation was denied by the non-exporting browser policy");
    }
  }
}

export function createBrowserPolicy(options: BrowserPolicyOptions = {}): BrowserPolicy {
  return new BrowserPolicy(options);
}
