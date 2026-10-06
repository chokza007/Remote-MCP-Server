import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

interface BuildInfoContract {
  readonly name: "remote-mcp-server";
  readonly version: string;
  readonly node: string;
  readonly schemaVersion: 1;
}

type ContractsModule = {
  loadBuildInfo?: (packageJsonPath?: string) => Promise<BuildInfoContract>;
};

const workspacePackages = [
  ["apps/server", "@remote-mcp/server"],
  ["apps/worker", "@remote-mcp/worker"],
  ["packages/contracts", "@remote-mcp/contracts"],
  ["packages/control-plane", "@remote-mcp/control-plane"],
  ["packages/persistence", "@remote-mcp/persistence"],
  ["packages/runtime", "@remote-mcp/runtime"],
  ["packages/adapters", "@remote-mcp/adapters"],
  ["packages/test-support", "@remote-mcp/test-support"]
] as const;

describe("workspace contract", () => {
  test("every declared workspace has the expected package identity", async () => {
    for (const [directory, expectedName] of workspacePackages) {
      const manifestPath = resolve(process.cwd(), directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
        type?: string;
      };

      expect(manifest.name).toBe(expectedName);
      expect(manifest.type).toBe("module");
    }
  });

  test("the contracts workspace exposes deterministic ESM build information", async () => {
    const contracts = (await import("@remote-mcp/contracts")) as ContractsModule;

    expect(typeof contracts.loadBuildInfo).toBe("function");

    const info = await contracts.loadBuildInfo?.();
    expect(info).toEqual({
      name: "remote-mcp-server",
      version: "0.1.0",
      node: process.version,
      schemaVersion: 1
    });
    expect(Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10)).toBe(24);
  });
});
