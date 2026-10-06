import { createHash } from "node:crypto";

export interface Disposable {
  dispose(): void;
}

interface RegisteredSecret {
  readonly secret: string;
  references: number;
}

export class SecretFingerprints {
  readonly #secrets = new Map<string, RegisteredSecret>();

  public register(secret: string): Disposable {
    if (secret.length === 0) {
      throw new Error("Cannot register an empty secret");
    }
    const fingerprint = createHash("sha256").update(secret, "utf8").digest("hex");
    const existing = this.#secrets.get(fingerprint);
    if (existing) {
      existing.references += 1;
    } else {
      this.#secrets.set(fingerprint, { secret, references: 1 });
    }

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const registered = this.#secrets.get(fingerprint);
        if (!registered) {
          return;
        }
        registered.references -= 1;
        if (registered.references === 0) {
          this.#secrets.delete(fingerprint);
        }
      }
    };
  }

  public redact(value: string): string {
    let redacted = value;
    const secrets = [...this.#secrets.values()].sort(
      (left, right) => right.secret.length - left.secret.length
    );
    for (const registered of secrets) {
      redacted = redacted.replaceAll(registered.secret, "[REDACTED]");
    }
    return redacted;
  }
}
