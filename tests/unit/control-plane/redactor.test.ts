import { describe, expect, test } from "vitest";

interface Disposable {
  dispose(): void;
}

interface RedactorContract {
  registerEphemeral(secret: string): Disposable;
  redact(value: unknown): unknown;
}

interface ControlPlaneModule {
  createRedactor?: () => RedactorContract;
}

describe("secret redaction", () => {
  async function createRedactor(): Promise<RedactorContract> {
    const controlPlane = (await import("@remote-mcp/control-plane")) as ControlPlaneModule;
    expect(typeof controlPlane.createRedactor).toBe("function");
    return controlPlane.createRedactor!();
  }

  test("redacts bearer tokens, API keys, URL credentials, and command arguments", async () => {
    const redactor = await createRedactor();
    const input = [
      "Authorization: Bearer eyJhbGciOi-secret.signature",
      "OPENAI_API_KEY=sk-live-123456",
      "https://alice:hunter2@example.test/private",
      "tool.exe --password hunter2 --token=command-secret"
    ].join("\n");

    const output = redactor.redact(input);
    expect(output).toBe(
      [
        "Authorization: Bearer [REDACTED]",
        "OPENAI_API_KEY=[REDACTED]",
        "https://[REDACTED]@example.test/private",
        "tool.exe --password [REDACTED] --token=[REDACTED]"
      ].join("\n")
    );
  });

  test("redacts sensitive nested properties without mutating the source", async () => {
    const redactor = await createRedactor();
    const input = {
      environment: {
        PATH: "C:\\Windows\\System32",
        DATABASE_PASSWORD: "database-secret"
      },
      headers: {
        authorization: "Bearer nested-secret",
        "content-type": "application/json"
      },
      nested: [{ apiKey: "api-key-secret", label: "safe" }]
    };

    expect(redactor.redact(input)).toEqual({
      environment: {
        PATH: "C:\\Windows\\System32",
        DATABASE_PASSWORD: "[REDACTED]"
      },
      headers: {
        authorization: "[REDACTED]",
        "content-type": "application/json"
      },
      nested: [{ apiKey: "[REDACTED]", label: "safe" }]
    });
    expect(input.environment.DATABASE_PASSWORD).toBe("database-secret");
  });

  test("uses ephemeral known-secret fingerprints for Unicode and multiline values", async () => {
    const redactor = await createRedactor();
    const secret = "秘密-token\nsecond-line";
    const registration = redactor.registerEphemeral(secret);

    expect(redactor.redact(`prefix ${secret} suffix`)).toBe("prefix [REDACTED] suffix");
    registration.dispose();
    expect(redactor.redact(`prefix ${secret} suffix`)).toBe(`prefix ${secret} suffix`);
  });
});
