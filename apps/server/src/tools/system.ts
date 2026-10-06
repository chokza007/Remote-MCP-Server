import { z } from "zod";

import type {
  EnvironmentService,
  PortService,
  ProcessIdentity,
  ProcessService,
  SystemDiscovery,
  WindowsServiceService
} from "@remote-mcp/adapters";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface SystemToolDependencies {
  readonly processes: ProcessService;
  readonly services: WindowsServiceService;
  readonly ports: PortService;
  readonly discovery: SystemDiscovery;
  readonly environment: EnvironmentService;
}

const identitySchema = z.object({
  pid: z.number().int().positive(),
  createdAt: z.iso.datetime()
});

export function registerSystemTools(
  registry: ToolRegistry,
  dependencies: SystemToolDependencies
): void {
  registry.register(
    coreDescriptor("environment_snapshot", "Environment snapshot", "Reports environment keys and redacted values.", 0),
    () => ({ schemaVersion: 1, ...dependencies.environment.snapshot() })
  );

  registry.register(
    coreDescriptor("port_listeners", "List port listeners", "Lists TCP and UDP listeners with owning PIDs.", 0),
    async () => ({ schemaVersion: 1, listeners: await dependencies.ports.listeners() })
  );

  registry.register(
    coreDescriptor("port_resolve", "Resolve port owner", "Resolves a local port to owning processes.", 0),
    async (args) => ({
      schemaVersion: 1,
      listeners: await dependencies.ports.resolve(
        Number(args.port),
        args.protocol as "tcp" | "udp" | undefined
      )
    }),
    {
      inputSchema: {
        port: z.number().int().min(1).max(65_535),
        protocol: z.enum(["tcp", "udp"]).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("process_inspect", "Inspect process", "Inspects one Windows process and its creation identity.", 0),
    async (args) => ({ schemaVersion: 1, ...(await dependencies.processes.inspect(Number(args.pid))) }),
    { inputSchema: { pid: z.number().int().positive() } }
  );

  registry.register(
    coreDescriptor("process_list", "List processes", "Lists Windows processes with redacted command lines.", 0),
    async () => ({ schemaVersion: 1, processes: await dependencies.processes.list() })
  );

  registry.register(
    coreDescriptor("process_start", "Start process", "Starts a controlled non-interactive process.", 2),
    async (args) => ({
      schemaVersion: 1,
      identity: await dependencies.processes.start({
        file: String(args.file),
        args: (args.args as string[] | undefined) ?? [],
        ...(args.cwd === undefined ? {} : { cwd: String(args.cwd) }),
        ...(args.env === undefined ? {} : { env: args.env as Record<string, string> })
      })
    }),
    {
      inputSchema: {
        file: z.string().min(1),
        args: z.array(z.string()).optional(),
        cwd: z.string().min(1).optional(),
        env: z.record(z.string(), z.string()).optional()
      }
    }
  );

  registry.register(
    coreDescriptor("process_terminate_tree", "Terminate process tree", "Terminates an exact creation-bound process tree.", 3),
    async (args) => {
      const identity = args.identity as ProcessIdentity;
      await dependencies.processes.terminateTree({ identity, force: args.force !== false });
      return { schemaVersion: 1, terminated: true, identity };
    },
    { inputSchema: { identity: identitySchema, force: z.boolean().optional() } }
  );

  registry.register(
    coreDescriptor("process_wait", "Wait for process", "Waits for an exact process identity to exit.", 0),
    async (args) => ({
      schemaVersion: 1,
      ...(await dependencies.processes.wait({
        identity: args.identity as ProcessIdentity,
        timeoutMs: Number(args.timeoutMs)
      }))
    }),
    { inputSchema: { identity: identitySchema, timeoutMs: z.number().int().nonnegative().max(3_600_000) } }
  );

  registry.register(
    coreDescriptor("service_inspect", "Inspect Windows service", "Inspects one Windows service.", 0),
    async (args) => ({ schemaVersion: 1, ...(await dependencies.services.inspect(String(args.name))) }),
    { inputSchema: { name: z.string().min(1) } }
  );

  registry.register(
    coreDescriptor("service_list", "List Windows services", "Lists Windows service state.", 0),
    async () => ({ schemaVersion: 1, services: await dependencies.services.list() })
  );

  for (const operation of ["start", "stop", "restart"] as const) {
    registry.register(
      coreDescriptor(`service_${operation}`, `${operation} Windows service`, `${operation}s a Windows service through the configured privilege boundary.`, 3),
      async (args) => {
        const name = String(args.name);
        await dependencies.services[operation](name);
        return { schemaVersion: 1, ...(await dependencies.services.inspect(name)) };
      },
      { inputSchema: { name: z.string().min(1) } }
    );
  }

  registry.register(
    coreDescriptor("system_capabilities", "System capabilities", "Reports detected local tool capabilities.", 0),
    async () => ({ schemaVersion: 1, capabilities: await dependencies.discovery.capabilities() })
  );

  registry.register(
    coreDescriptor("system_snapshot", "System snapshot", "Reports operating system and runtime identity.", 0),
    async () => ({ schemaVersion: 1, ...(await dependencies.discovery.snapshot()) })
  );
}
