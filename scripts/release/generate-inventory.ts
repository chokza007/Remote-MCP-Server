import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migrateDatabase, openDatabase } from "@remote-mcp/persistence";

import { createHttpServer } from "../../apps/server/src/http-server.js";

const database = openDatabase({ filename: ":memory:" });
migrateDatabase(database);
const handle = await createHttpServer({ database, host: "127.0.0.1", port: 0 });
const client = new Client({ name: "inventory-generator", version: "1.0.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(handle.url, {
    requestInit: {
      headers: {
        authorization: `Bearer ${handle.localDevelopmentToken}`,
        "x-remote-mcp-principal": "release-inventory",
        "x-remote-mcp-client": "release-inventory"
      }
    }
  }));
  const listed = await client.listTools();
  const tools = listed.tools.map((tool) => {
    const metadata = tool._meta as Record<string, unknown> | undefined;
    return {
      name: tool.name,
      version: String(metadata?.["remote-mcp/toolVersion"] ?? "unknown"),
      title: tool.title ?? tool.name,
      description: tool.description ?? "",
      riskTier: Number(metadata?.["remote-mcp/riskTier"] ?? -1),
      requiredScope: String(metadata?.["remote-mcp/requiredScope"] ?? "unknown"),
      annotations: tool.annotations ?? {},
      inputSchema: tool.inputSchema
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const inventory = {
    schemaVersion: 1,
    serverVersion: "0.1.0",
    generatedFrom: "runtime ToolRegistry through MCP tools/list",
    generatedAt: "release-generated",
    tools
  };
  await mkdir(resolve("config"), { recursive: true });
  await mkdir(resolve("docs"), { recursive: true });
  await writeFile(
    resolve("config/tool-inventory.v1.json"),
    JSON.stringify(inventory, null, 2) + "\n",
    "utf8"
  );
  const rows = tools.map((tool) => [
    "| `", tool.name, "` | ", tool.version, " | ", String(tool.riskTier), " | `",
    tool.requiredScope, "` | ", tool.description.replaceAll("|", "\\|"), " |"
  ].join(""));
  const markdown = [
    "# Tool Inventory",
    "",
    "> Generated from the runtime MCP tools/list response. Run npm run inventory after changing any registered tool.",
    "",
    "Total tools: **" + tools.length + "**. Risk tier 0 is read-only/public metadata; tiers 1-3 require policy authorization. A valid persistent Full Access grant satisfies that authorization without per-action prompts.",
    "",
    "| Tool | Version | Risk | Scope | Purpose |",
    "|---|---:|---:|---|---|",
    ...rows,
    ""
  ].join("\n");
  await writeFile(resolve("docs/TOOL_INVENTORY.md"), markdown, "utf8");
} finally {
  await client.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
  database.close();
}
