import { describe, expect, test } from "vitest";

import { createUrlPolicy } from "@remote-mcp/adapters";

describe("URL SSRF policy", () => {
  test("rejects private, loopback, link-local, unsupported, and credential-bearing targets", async () => {
    const policy = createUrlPolicy();
    await expect(policy.assertAllowed(new URL("http://127.0.0.1/private"))).rejects.toMatchObject({ code: "PRIVATE_NETWORK" });
    await expect(policy.assertAllowed(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toMatchObject({ code: "PRIVATE_NETWORK" });
    await expect(policy.assertAllowed(new URL("http://[::ffff:7f00:1]/private"))).rejects.toMatchObject({ code: "PRIVATE_NETWORK" });
    await expect(policy.assertAllowed(new URL("file:///C:/Windows/win.ini"))).rejects.toMatchObject({ code: "UNSUPPORTED_PROTOCOL" });
    await expect(policy.assertAllowed(new URL("https://user:secret@example.invalid"))).rejects.toMatchObject({ code: "CREDENTIALS_IN_URL" });
  });

  test("checks every DNS resolution so a rebinding answer is rejected", async () => {
    let calls = 0;
    const policy = createUrlPolicy({
      resolver: async () => {
        calls += 1;
        return calls === 1
          ? [{ address: "93.184.216.34", family: 4 as const }]
          : [{ address: "127.0.0.1", family: 4 as const }];
      }
    });
    await expect(policy.assertAllowed(new URL("https://rebind.example"))).resolves.toBeDefined();
    await expect(policy.assertAllowed(new URL("https://rebind.example"))).rejects.toMatchObject({ code: "PRIVATE_NETWORK" });
  });
});
