export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly maxSessions: number;
  readonly maxRequestBodyBytes: number;
}

export const defaultServerConfig: ServerConfig = Object.freeze({
  host: "127.0.0.1",
  port: 7331,
  endpoint: "/mcp",
  maxSessions: 1_000,
  maxRequestBodyBytes: DEFAULT_SECURITY_LIMITS.maxRequestBytes
});

export function resolveServerConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const config = { ...defaultServerConfig, ...overrides };
  if (!config.endpoint.startsWith("/")) throw new Error("MCP endpoint must start with /");
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error("MCP port must be an integer from 0 through 65535");
  }
  if (!Number.isInteger(config.maxSessions) || config.maxSessions < 1) {
    throw new Error("maxSessions must be a positive integer");
  }
  if (!Number.isInteger(config.maxRequestBodyBytes) || config.maxRequestBodyBytes < 1) {
    throw new Error("maxRequestBodyBytes must be a positive integer");
  }
  return Object.freeze(config);
}
import { DEFAULT_SECURITY_LIMITS } from "@remote-mcp/control-plane";

