import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface BuildInfo {
  readonly name: "remote-mcp-server";
  readonly version: string;
  readonly node: string;
  readonly schemaVersion: 1;
}

export async function loadBuildInfo(packageJsonPath?: string): Promise<BuildInfo> {
  const manifestPath = packageJsonPath ?? resolve(process.cwd(), "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };

  if (manifest.name !== "remote-mcp-server" || typeof manifest.version !== "string") {
    throw new Error(`Invalid remote MCP package manifest: ${manifestPath}`);
  }

  return {
    name: "remote-mcp-server",
    version: manifest.version,
    node: process.version,
    schemaVersion: 1
  };
}
