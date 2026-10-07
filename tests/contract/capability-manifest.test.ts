import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import { CORE_CAPABILITY_MANIFEST } from "@remote-mcp/runtime";

describe("capability manifest contract", () => {
  test("matches the checked-in versioned runtime manifest without schema drift", async () => {
    const checkedIn = JSON.parse(await readFile(resolve("config/capability-manifest.v1.json"), "utf8"));
    expect(checkedIn).toEqual(CORE_CAPABILITY_MANIFEST);
    expect(checkedIn).toMatchObject({ schemaVersion: 1, capabilities: expect.any(Array) });
    expect(new Set(checkedIn.capabilities.map((entry: { id: string }) => entry.id)).size)
      .toBe(checkedIn.capabilities.length);
  });
});
