import type { GrantService } from "@remote-mcp/control-plane";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export function registerServerInfoTool(registry: ToolRegistry, grants: GrantService): void {
  registry.register(
    coreDescriptor("server_info", "Server information", "Reports this MCP server and device identity.", 0),
    () => ({
      schemaVersion: 1,
      name: "remote-mcp-server",
      version: "0.1.0",
      protocol: "streamable-http",
      deviceId: grants.serverIdentity().deviceId
    }),
    { public: true }
  );
}
