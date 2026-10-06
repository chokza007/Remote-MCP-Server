import type { OperationalDatabase } from "@remote-mcp/persistence";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export function registerHealthTool(registry: ToolRegistry, database: OperationalDatabase): void {
  registry.register(
    coreDescriptor("health_report", "Health report", "Reports core gateway health.", 0),
    () => {
      const integrity = database.integrityCheck();
      return {
        schemaVersion: 1,
        status: integrity.every((entry) => entry === "ok") ? "ready" : "degraded",
        database: integrity.every((entry) => entry === "ok") ? "ok" : "failed",
        checkedAt: new Date().toISOString()
      };
    },
    { public: true }
  );
}
