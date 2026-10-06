type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type PrincipalId = Brand<string, "PrincipalId">;
export type ClientId = Brand<string, "ClientId">;
export type DeviceId = Brand<string, "DeviceId">;
export type SessionId = Brand<string, "SessionId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type GrantId = Brand<string, "GrantId">;
export type JobId = Brand<string, "JobId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type CorrelationId = Brand<string, "CorrelationId">;

function asStableId<Name extends string>(
  value: string,
  _brand: Name,
  label: string
): Brand<string, Name> {
  if (value.trim().length === 0) {
    throw new Error(`${label} ID must not be empty`);
  }

  if (value !== value.trim()) {
    throw new Error(`${label} ID must not contain surrounding whitespace`);
  }

  return value as Brand<string, Name>;
}

export const asPrincipalId = (value: string): PrincipalId =>
  asStableId(value, "PrincipalId", "Principal");
export const asClientId = (value: string): ClientId => asStableId(value, "ClientId", "Client");
export const asDeviceId = (value: string): DeviceId => asStableId(value, "DeviceId", "Device");
export const asSessionId = (value: string): SessionId =>
  asStableId(value, "SessionId", "Session");
export const asWorkspaceId = (value: string): WorkspaceId =>
  asStableId(value, "WorkspaceId", "Workspace");
export const asGrantId = (value: string): GrantId => asStableId(value, "GrantId", "Grant");
export const asJobId = (value: string): JobId => asStableId(value, "JobId", "Job");
export const asArtifactId = (value: string): ArtifactId =>
  asStableId(value, "ArtifactId", "Artifact");
export const asCorrelationId = (value: string): CorrelationId =>
  asStableId(value, "CorrelationId", "Correlation");
