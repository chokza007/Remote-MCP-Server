import { z } from "zod";

import type { TerminalControl, TerminalService } from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

const terminalIdSchema = { terminalId: z.string().uuid() };

export function registerTerminalTools(registry: ToolRegistry, terminal: TerminalService): void {
  registry.register(
    coreDescriptor("terminal_close", "Close terminal", "Terminates a terminal process tree and closes its session.", 2),
    async (args) => {
      const terminalId = String(args.terminalId);
      await terminal.close(terminalId);
      return { schemaVersion: 1, ...terminal.status(terminalId) };
    },
    { inputSchema: terminalIdSchema }
  );

  registry.register(
    coreDescriptor("terminal_create", "Create terminal", "Creates an interactive Windows ConPTY session.", 1),
    async (args) => ({
      schemaVersion: 1,
      ...(await terminal.create({
        shell: args.shell as "powershell" | "cmd" | "python" | "node",
        cwd: String(args.cwd),
        ...(args.cols === undefined ? {} : { cols: Number(args.cols) }),
        ...(args.rows === undefined ? {} : { rows: Number(args.rows) })
      }))
    }),
    {
      inputSchema: {
        shell: z.enum(["powershell", "cmd", "python", "node"]),
        cwd: z.string().min(1),
        cols: z.number().int().min(2).max(500).optional(),
        rows: z.number().int().min(1).max(300).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("terminal_promote_to_job", "Promote terminal to job", "Returns durable-job promotion metadata.", 0),
    (args) => ({ schemaVersion: 1, ...terminal.promoteToJob(String(args.terminalId)) }),
    { inputSchema: terminalIdSchema }
  );

  registry.register(
    coreDescriptor("terminal_read", "Read terminal output", "Reads output using monotonic byte offsets.", 0),
    (args) => ({
      schemaVersion: 1,
      ...terminal.read(String(args.terminalId), Number(args.offset), Number(args.limit))
    }),
    {
      inputSchema: {
        ...terminalIdSchema,
        offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(1_048_576)
      }
    }
  );

  registry.register(
    coreDescriptor("terminal_resize", "Resize terminal", "Resizes an interactive terminal viewport.", 1),
    (args) => {
      const terminalId = String(args.terminalId);
      terminal.resize(terminalId, Number(args.cols), Number(args.rows));
      return { schemaVersion: 1, ...terminal.status(terminalId) };
    },
    {
      inputSchema: {
        ...terminalIdSchema,
        cols: z.number().int().min(2).max(500),
        rows: z.number().int().min(1).max(300)
      }
    }
  );

  registry.register(
    coreDescriptor("terminal_send", "Send terminal input", "Writes exact text to terminal stdin.", 1),
    (args) => {
      const terminalId = String(args.terminalId);
      terminal.send(terminalId, String(args.data));
      return { schemaVersion: 1, accepted: true, terminalId };
    },
    { inputSchema: { ...terminalIdSchema, data: z.string() } }
  );

  registry.register(
    coreDescriptor("terminal_send_control", "Send terminal control key", "Sends Ctrl+C, Ctrl+Break, or EOF.", 1),
    (args) => {
      const terminalId = String(args.terminalId);
      terminal.sendControl(terminalId, args.control as TerminalControl);
      return { schemaVersion: 1, accepted: true, terminalId };
    },
    {
      inputSchema: {
        ...terminalIdSchema,
        control: z.enum(["ctrl_c", "ctrl_break", "eof"])
      }
    }
  );

  registry.register(
    coreDescriptor("terminal_status", "Terminal status", "Reports interactive terminal lifecycle state.", 0),
    (args) => ({ schemaVersion: 1, ...terminal.status(String(args.terminalId)) }),
    { inputSchema: terminalIdSchema }
  );
}
