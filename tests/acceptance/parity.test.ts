import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

interface Inventory {
  readonly schemaVersion: number;
  readonly generatedFrom: string;
  readonly tools: readonly { readonly name: string; readonly version: string; readonly riskTier: number }[];
}

describe("release parity and documentation", () => {
  test("ships a machine-readable inventory and all required operator/developer documents", async () => {
    const inventory = JSON.parse(await readFile("config/tool-inventory.v1.json", "utf8")) as Inventory;
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.generatedFrom).toContain("ToolRegistry");
    expect(inventory.tools.length).toBeGreaterThan(50);
    expect(new Set(inventory.tools.map((tool) => tool.name)).size).toBe(inventory.tools.length);
    expect(inventory.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "request_full_access" }),
      expect.objectContaining({ name: "filesystem_write" }),
      expect.objectContaining({ name: "terminal_create" }),
      expect.objectContaining({ name: "gui_capture" }),
      expect.objectContaining({ name: "browser_navigate" }),
      expect.objectContaining({ name: "document_docx_replace" }),
      expect.objectContaining({ name: "document_xlsx_update" })
    ]));

    const required = [
      "README.md", "AGENTS.md", "CONTRIBUTING.md", "CHANGELOG.md",
      "docs/TOOL_INVENTORY.md", "docs/PARITY_MATRIX.md", "docs/ACCEPTANCE_REPORT.md",
      "docs/THAI_QUICKSTART.md", "docs/THAI_USER_GUIDE.md", "docs/TROUBLESHOOTING.md",
      "docs/architecture/DATA_FLOW.md", "docs/architecture/OPERATIONS.md",
      "docs/security/AUTHORIZATION.md", "docs/security/PRIVILEGED_BROKER.md",
      "docs/security/CREDENTIALS.md", "docs/security/THREAT_MODEL.md"
    ];
    for (const path of required) {
      expect((await readFile(path, "utf8")).trim().length, path).toBeGreaterThan(100);
    }
  });
});
