import type { ZodRawShape } from "zod";

import { parseToolDescriptor, type ToolDescriptorV1 } from "@remote-mcp/contracts";

import type { ToolExecutionContext } from "./context.js";

export type ToolOutput = Record<string, unknown>;
export type ToolHandler = (
  argumentsValue: Record<string, unknown>,
  context: ToolExecutionContext
) => ToolOutput | Promise<ToolOutput>;

export interface RegisteredGatewayTool {
  readonly descriptor: ToolDescriptorV1;
  readonly inputSchema: ZodRawShape;
  readonly handler: ToolHandler;
  readonly public: boolean;
  readonly bypassEmergencyStop: boolean;
  readonly openWorld: boolean;
  readonly auditResult: (output: ToolOutput) => unknown;
}

export interface ToolRegistrationOptions {
  readonly inputSchema?: ZodRawShape;
  readonly public?: boolean;
  readonly bypassEmergencyStop?: boolean;
  readonly openWorld?: boolean;
  readonly auditResult?: (output: ToolOutput) => unknown;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredGatewayTool>();

  public register(
    descriptorValue: ToolDescriptorV1,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {}
  ): void {
    const descriptor = parseToolDescriptor(descriptorValue);
    if (this.#tools.has(descriptor.name)) {
      throw new Error(`Tool is already registered: ${descriptor.name}`);
    }
    this.#tools.set(descriptor.name, {
      descriptor,
      inputSchema: options.inputSchema ?? {},
      handler,
      public: options.public ?? false,
      bypassEmergencyStop: options.bypassEmergencyStop ?? false,
      openWorld: options.openWorld ?? false,
      auditResult: options.auditResult ?? ((output) => output)
    });
  }

  public entries(): readonly RegisteredGatewayTool[] {
    return [...this.#tools.values()].sort((left, right) =>
      left.descriptor.name.localeCompare(right.descriptor.name)
    );
  }
}

export function coreDescriptor(
  name: string,
  title: string,
  description: string,
  riskTier: 0 | 1 | 2 | 3,
  requiredScope = "computer:*"
): ToolDescriptorV1 {
  return {
    schemaVersion: 1,
    name,
    version: "1.0.0",
    title,
    description,
    riskTier,
    requiredScope,
    supportsDryRun: false,
    defaultTimeoutMs: 30_000,
    cancellable: false
  };
}
