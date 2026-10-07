import { z } from "zod";

import type { BrowserService, BrowserTarget } from "@remote-mcp/adapters";

import type { ToolExecutionContext } from "../context.js";
import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const contextId = z.string().uuid();
const tabId = z.string().uuid();
const timeoutMs = z.number().int().positive().max(3_600_000).optional();
const target = z.object({
  role: z.string().min(1).max(128).optional(),
  name: z.string().max(4_096).optional(),
  label: z.string().max(4_096).optional(),
  text: z.string().max(16_384).optional(),
  testId: z.string().max(4_096).optional(),
  css: z.string().max(16_384).optional()
}).refine((value) => Object.keys(value).length > 0, "A browser target is required");

function workspace(context: ToolExecutionContext, workspaceId: string): string {
  return `${context.identity.principalId}\u0000${context.identity.clientId}\u0000${workspaceId}`;
}

export function registerBrowserTools(registry: ToolRegistry, browser: BrowserService): void {
  registry.register(
    coreDescriptor("browser_launch", "Launch managed browser", "Launches a workspace-namespaced persistent browser profile.", 2),
    async (args, context) => ({ schemaVersion: 1, context: await browser.launch({
      workspaceId: workspace(context, String(args.workspaceId)),
      headless: args.headless !== false
    }) }),
    { inputSchema: { workspaceId: z.string().min(1).max(512), headless: z.boolean().optional() } }
  );

  registry.register(
    coreDescriptor("browser_close", "Close managed browser", "Closes a managed context and releases its profile lock.", 2),
    async (args) => {
      await browser.close(String(args.contextId));
      return { schemaVersion: 1, closed: true, contextId: args.contextId };
    },
    { inputSchema: { contextId } }
  );

  registry.register(
    coreDescriptor("browser_contexts", "List browser contexts", "Lists active managed browser contexts without cookies or tokens.", 0),
    () => ({ schemaVersion: 1, contexts: browser.contexts() })
  );

  registry.register(
    coreDescriptor("browser_tabs", "List browser tabs", "Lists tabs in a managed browser context.", 0),
    async (args) => ({ schemaVersion: 1, tabs: await browser.tabs(String(args.contextId)) }),
    { inputSchema: { contextId } }
  );

  registry.register(
    coreDescriptor("browser_navigate", "Navigate browser", "Navigates an existing or initial tab under browser URL policy.", 2),
    async (args) => ({ schemaVersion: 1, tab: await browser.navigate({
      contextId: String(args.contextId),
      url: String(args.url),
      ...(args.tabId === undefined ? {} : { tabId: String(args.tabId) }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    }) }),
    {
      inputSchema: { contextId, tabId: tabId.optional(), url: z.url(), timeoutMs },
      openWorld: true
    }
  );

  registry.register(
    coreDescriptor("browser_inspect", "Inspect browser page", "Returns a redacted semantic page model without form values, cookies, or tokens.", 0),
    async (args) => ({ schemaVersion: 1, ...(await browser.inspect(String(args.tabId))) }),
    { inputSchema: { tabId } }
  );

  for (const operation of ["click", "type"] as const) {
    registry.register(
      coreDescriptor(`browser_${operation}`, `${operation} browser target`, `${operation}s one exact semantic target and verifies completion.`, 2),
      async (args) => ({ schemaVersion: 1, ...(await browser[operation]({
        tabId: String(args.tabId),
        target: args.target as BrowserTarget,
        ...(operation === "type" ? { text: String(args.text) } : {}),
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
      } as never)) }),
      {
        inputSchema: {
          tabId,
          target,
          ...(operation === "type" ? { text: z.string().max(1_048_576) } : {}),
          timeoutMs
        },
        ...(operation === "type" ? {
          auditResult: (output: Record<string, unknown>) => ({ ...output, typedValue: "[REDACTED]" })
        } : {})
      }
    );
  }

  registry.register(
    coreDescriptor("browser_upload", "Upload browser files", "Sets files on one semantic file input.", 2),
    async (args) => ({ schemaVersion: 1, ...(await browser.upload({
      tabId: String(args.tabId),
      target: args.target as BrowserTarget,
      paths: args.paths as string[],
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    { inputSchema: { tabId, target, paths: z.array(z.string().min(1)).min(1).max(1_000), timeoutMs } }
  );

  registry.register(
    coreDescriptor("browser_download", "Download browser artifact", "Downloads through one semantic target and returns hash evidence.", 2),
    async (args) => ({ schemaVersion: 1, ...(await browser.download({
      tabId: String(args.tabId),
      target: args.target as BrowserTarget,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    { inputSchema: { tabId, target, timeoutMs }, openWorld: true }
  );

  registry.register(
    coreDescriptor("browser_wait", "Wait for browser state", "Waits for a semantic element state.", 0),
    async (args) => ({ schemaVersion: 1, ...(await browser.wait({
      tabId: String(args.tabId),
      target: args.target as BrowserTarget,
      state: args.state as "attached" | "detached" | "visible" | "hidden",
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    { inputSchema: { tabId, target, state: z.enum(["attached", "detached", "visible", "hidden"]), timeoutMs } }
  );

  registry.register(
    coreDescriptor("browser_screenshot", "Capture browser screenshot", "Captures a full-page PNG with hash evidence.", 1),
    async (args) => ({ schemaVersion: 1, ...(await browser.screenshot({
      tabId: String(args.tabId),
      ...(args.name === undefined ? {} : { name: String(args.name) })
    })) }),
    { inputSchema: { tabId, name: z.string().min(1).max(255).optional() } }
  );

  registry.register(
    coreDescriptor("browser_pdf", "Render browser PDF", "Renders the current page to a PDF artifact with hash evidence.", 1),
    async (args) => ({ schemaVersion: 1, ...(await browser.pdf({
      tabId: String(args.tabId),
      ...(args.name === undefined ? {} : { name: String(args.name) })
    })) }),
    { inputSchema: { tabId, name: z.string().min(1).max(255).optional() } }
  );

  registry.register(
    coreDescriptor("browser_evaluate", "Evaluate page expression", "Evaluates a bounded same-origin expression under non-exporting policy.", 2),
    async (args) => ({ schemaVersion: 1, value: await browser.evaluate({
      tabId: String(args.tabId),
      expression: String(args.expression)
    }) }),
    {
      inputSchema: { tabId, expression: z.string().min(1).max(64 * 1024) },
      openWorld: true
    }
  );
}
