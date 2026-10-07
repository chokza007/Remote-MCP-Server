import { z } from "zod";

import type { GuiService, GuiTargetSelector, WindowSelector } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const windowSelector = z.object({
  handle: z.string().min(1).optional(),
  processId: z.number().int().positive().optional(),
  title: z.string().max(1_024).optional(),
  titleRegex: z.string().max(1_024).optional(),
  className: z.string().max(1_024).optional(),
  modal: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one window selector is required");

const targetSelector = z.object({
  runtimeId: z.string().min(1).max(4_096).optional(),
  automationId: z.string().max(4_096).optional(),
  name: z.string().max(4_096).optional(),
  controlType: z.string().max(256).optional(),
  coordinates: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    relativeTo: z.enum(["window", "screen"])
  }).optional()
}).refine(
  (value) => value.runtimeId !== undefined || value.automationId !== undefined
    || value.name !== undefined || value.controlType !== undefined || value.coordinates !== undefined,
  "A semantic selector or coordinates are required"
);

const timeoutMs = z.number().int().positive().max(3_600_000).optional();

export function registerGuiTools(registry: ToolRegistry, gui: GuiService): void {
  registry.register(
    coreDescriptor("gui_desktops", "Inspect Windows desktop", "Reports whether the interactive Windows desktop is available.", 0),
    async (args) => ({ schemaVersion: 1, desktops: await gui.desktops(args.timeoutMs as number | undefined) }),
    { inputSchema: { timeoutMs } }
  );

  registry.register(
    coreDescriptor("gui_windows", "List GUI windows", "Lists top-level windows on the current interactive desktop.", 0),
    async (args) => ({ schemaVersion: 1, windows: await gui.windows(args.timeoutMs as number | undefined) }),
    { inputSchema: { timeoutMs } }
  );

  registry.register(
    coreDescriptor("gui_inspect", "Inspect GUI window", "Inspects UI Automation controls in an exact window.", 0),
    async (args) => ({ schemaVersion: 1, ...(await gui.inspect({
      window: args.window as WindowSelector,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    { inputSchema: { window: windowSelector, timeoutMs } }
  );

  registry.register(
    coreDescriptor("gui_focus", "Focus GUI window", "Focuses a window and verifies the observed foreground window.", 2),
    async (args) => ({
      schemaVersion: 1,
      ...(await gui.focus(args.window as WindowSelector, args.timeoutMs as number | undefined))
    }),
    { inputSchema: { window: windowSelector, timeoutMs } }
  );

  const actionSchema = {
    window: windowSelector,
    target: targetSelector,
    allowCoordinateFallback: z.boolean().optional(),
    timeoutMs
  };
  for (const operation of ["invoke", "click"] as const) {
    registry.register(
      coreDescriptor(`gui_${operation}`, `${operation} GUI control`, `${operation}s a UI Automation control and verifies its postcondition.`, 2),
      async (args) => ({ schemaVersion: 1, ...(await gui[operation]({
        window: args.window as WindowSelector,
        target: args.target as GuiTargetSelector,
        allowCoordinateFallback: args.allowCoordinateFallback === true,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
      })) }),
      { inputSchema: actionSchema }
    );
  }

  registry.register(
    coreDescriptor("gui_type", "Type into GUI control", "Types Unicode text through UI Automation with password-field result redaction.", 2),
    async (args) => ({ schemaVersion: 1, ...(await gui.type({
      window: args.window as WindowSelector,
      target: args.target as GuiTargetSelector,
      text: String(args.text),
      replace: args.replace !== false,
      allowCoordinateFallback: args.allowCoordinateFallback === true,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    {
      inputSchema: {
        ...actionSchema,
        text: z.string().max(1_048_576),
        replace: z.boolean().optional()
      },
      auditResult: (output) => ({ ...output, evidence: {
        ...(output.evidence as Record<string, unknown> | undefined),
        value: "[REDACTED]"
      } })
    }
  );

  registry.register(
    coreDescriptor("gui_keys", "Send GUI keys", "Sends a bounded key chord and verifies foreground focus.", 2),
    async (args) => ({ schemaVersion: 1, ...(await gui.keys({
      window: args.window as WindowSelector,
      keys: args.keys as string[],
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    { inputSchema: { window: windowSelector, keys: z.array(z.string().min(1).max(64)).min(1).max(32), timeoutMs } }
  );

  registry.register(
    coreDescriptor("gui_wait", "Wait for GUI state", "Waits for an observed UI Automation condition.", 0),
    async (args) => ({ schemaVersion: 1, ...(await gui.wait({
      window: args.window as WindowSelector,
      ...(args.target === undefined ? {} : { target: args.target as GuiTargetSelector }),
      condition: args.condition as "exists" | "not_exists" | "enabled" | "focused",
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) }),
      ...(args.pollMs === undefined ? {} : { pollMs: Number(args.pollMs) })
    })) }),
    {
      inputSchema: {
        window: windowSelector,
        target: targetSelector.optional(),
        condition: z.enum(["exists", "not_exists", "enabled", "focused"]),
        timeoutMs,
        pollMs: z.number().int().min(5).max(60_000).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("gui_capture", "Capture GUI screenshot", "Captures a window or desktop PNG with hash and size evidence.", 1),
    async (args) => ({ schemaVersion: 1, ...(await gui.capture({
      ...(args.window === undefined ? {} : { window: args.window as WindowSelector }),
      ...(args.name === undefined ? {} : { name: String(args.name) }),
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: Number(args.timeoutMs) })
    })) }),
    {
      inputSchema: {
        window: windowSelector.optional(),
        name: z.string().min(1).max(255).optional(),
        timeoutMs
      }
    }
  );
}
