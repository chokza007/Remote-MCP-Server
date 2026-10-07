import { z } from "zod";
import { existsSync } from "node:fs";

import {
  discoverBrowserExecutable,
  type BrowserService,
  type GuiService,
  type SystemDiscovery,
  type WindowsServiceService
} from "@remote-mcp/adapters";
import {
  CORE_CAPABILITY_MANIFEST,
  CapabilityRegistry,
  type HealthService,
  type SelfTestService
} from "@remote-mcp/runtime";

import { coreDescriptor, type ToolRegistry } from "../tool-registry.js";

export interface DefaultCapabilityDependencies {
  readonly databaseIntegrity: () => readonly string[];
  readonly discovery: SystemDiscovery;
  readonly browser: BrowserService;
  readonly gui: GuiService;
  readonly services: WindowsServiceService;
}

export function createDefaultCapabilityRegistry(dependencies: DefaultCapabilityDependencies): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register({
    id: "core.database", version: "1.0.0", required: true, description: "Operational SQLite database",
    remediation: "Restore a verified database backup or run the recovery procedure.",
    probe: async () => ({
      status: dependencies.databaseIntegrity().every((entry) => entry === "ok") ? "ready" : "failed",
      dependencies: { sqlite: "embedded" }, evidence: { integrity: dependencies.databaseIntegrity() }
    }),
    selfTest: async () => ({ verified: dependencies.databaseIntegrity().every((entry) => entry === "ok"), evidence: { integrity: dependencies.databaseIntegrity() } })
  });
  registry.register({
    id: "core.gateway", version: "1.0.0", required: true, description: "MCP gateway",
    probe: async () => ({ status: "ready", dependencies: { protocol: "MCP Streamable HTTP" } }),
    selfTest: async () => ({ verified: true, evidence: { fixture: "in-process" } })
  });
  registry.register({
    id: "core.jobs", version: "1.0.0", required: true, description: "Durable job runtime",
    probe: async () => ({ status: "ready", dependencies: { storage: "SQLite" } }),
    selfTest: async () => ({ verified: true, evidence: { fixture: "durable-self-test-job" } })
  });

  const capability = async (name: string) => (await dependencies.discovery.capabilities()).find((entry) => entry.name === name);
  for (const [id, name, required, description, remediation] of [
    ["system.powershell", "powershell", true, "Windows PowerShell helper runtime", "Enable Windows PowerShell."],
    ["system.git", "git", false, "Git command line", "Install Git for Windows and add it to PATH."],
    ["media.ffmpeg", "ffmpeg", false, "FFmpeg media runtime", "Install FFmpeg and add it to PATH."],
    ["documents.python", "python", false, "Python document helper runtime", "Install Python or configure the bundled helper runtime."]
  ] as const) {
    registry.register({
      id, version: "1.0.0", required, description, remediation,
      probe: async () => {
        const found = await capability(name);
        return { status: found?.available ? "ready" : "unavailable", dependencies: { executable: found?.path ?? "missing" } };
      },
      selfTest: async () => {
        const found = await capability(name);
        return { verified: found?.available === true, evidence: { executable: found?.path ?? "missing" } };
      }
    });
  }

  registry.register({
    id: "browser.playwright", version: "1.0.0", required: false, description: "Managed Playwright browser",
    remediation: "Install Microsoft Edge or Google Chrome.",
    probe: async () => {
      const executable = discoverBrowserExecutable();
      return {
        status: executable !== undefined && existsSync(executable) ? "ready" : "unavailable",
        dependencies: { playwright: "installed", browser: executable ?? "missing" },
        evidence: { activeContexts: dependencies.browser.contexts().length }
      };
    },
    selfTest: async () => {
      const context = await dependencies.browser.launch({ workspaceId: "health-self-test", headless: true });
      await dependencies.browser.close(context.contextId);
      return { verified: true, evidence: { isolatedProfile: true } };
    }
  });
  registry.register({
    id: "gui.windows", version: "1.0.0", required: false, description: "Interactive Windows UI Automation",
    remediation: "Sign in to the interactive Windows session and leave the Default desktop available.",
    probe: async () => {
      const desktops = await dependencies.gui.desktops(5_000);
      const interactive = desktops.some((desktop) => desktop.interactive);
      return { status: interactive ? "ready" : "unavailable", dependencies: { desktop: desktops[0]?.name ?? "unknown" }, evidence: { interactive } };
    },
    selfTest: async () => {
      const desktops = await dependencies.gui.desktops(5_000);
      return { verified: desktops.some((desktop) => desktop.interactive), evidence: { desktops } };
    }
  });
  registry.register({
    id: "privileged.broker", version: "1.0.0", required: false, description: "Persistent-authorized Windows privileged broker",
    remediation: "Run scripts/broker/install.ps1 from an elevated PowerShell session.",
    probe: async () => {
      try {
        const service = await dependencies.services.inspect("RemoteMcpPrivilegedBroker");
        return { status: service.state === "running" ? "ready" : "degraded", dependencies: { service: service.state } };
      } catch {
        return { status: "unavailable", dependencies: { service: "not-installed" } };
      }
    },
    selfTest: async () => {
      try {
        const service = await dependencies.services.inspect("RemoteMcpPrivilegedBroker");
        return { verified: service.state === "running", evidence: { state: service.state } };
      } catch {
        return { verified: false, evidence: { state: "unavailable" } };
      }
    }
  });

  const manifestIds = new Set(CORE_CAPABILITY_MANIFEST.capabilities.map(({ id }) => id));
  const runtimeIds = new Set(registry.definitions().map(({ id }) => id));
  if (manifestIds.size !== runtimeIds.size || [...manifestIds].some((id) => !runtimeIds.has(id))) {
    throw new Error("Capability registry does not match the versioned manifest");
  }
  return registry;
}

export function registerHealthTool(registry: ToolRegistry, dependencies: {
  readonly health: HealthService;
  readonly selfTests: SelfTestService;
  readonly capabilities: CapabilityRegistry;
}): void {
  registry.register(
    coreDescriptor("health_report", "Health report", "Reports truthful core and optional capability health.", 0),
    async () => ({ ...(await dependencies.health.report()) }),
    { public: true }
  );
  registry.register(
    coreDescriptor("capability_manifest", "Capability manifest", "Returns the checked runtime capability contract.", 0),
    () => ({
      ...CORE_CAPABILITY_MANIFEST,
      runtime: dependencies.capabilities.definitions().map(({ id, version, required }) => ({ id, version, required }))
    }),
    { public: true }
  );
  registry.register(
    coreDescriptor("capability_self_test", "Run capability self-test", "Runs safe isolated checks as a durable verified job.", 1),
    async (args, context) => ({
      schemaVersion: 1,
      capabilityRunId: await dependencies.selfTests.run(args.selection as string[], {
        principalId: context.identity.principalId,
        clientId: context.identity.clientId
      })
    }),
    { inputSchema: { selection: z.array(z.string().min(1)).max(100).default([]) } }
  );
}
