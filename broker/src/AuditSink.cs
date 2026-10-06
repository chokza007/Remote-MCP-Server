using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace RemoteMcp.Broker;

public sealed partial class AuditSink(BrokerOptions options)
{
  private readonly SemaphoreSlim gate = new(1, 1);

  public async Task<string> RecordAsync(
      VerifiedRequest request,
      bool success,
      object result,
      string? error,
      CancellationToken cancellationToken)
  {
    var auditId = Guid.NewGuid().ToString();
    await AppendAsync(new
    {
      timestamp = DateTimeOffset.UtcNow,
      auditId,
      correlationId = request.CorrelationId,
      grantId = request.GrantId,
      principalId = request.PrincipalId,
      clientId = request.ClientId,
      callerSid = request.CallerSid,
      action = request.Action,
      targets = request.Targets,
      success,
      result,
      error
    }, cancellationToken);
    return auditId;
  }

  public async Task<string> RecordDeniedAsync(
      JsonElement request,
      BrokerDeniedException error,
      CancellationToken cancellationToken)
  {
    var auditId = Guid.NewGuid().ToString();
    var action = request.TryGetProperty("action", out var actionElement) ? actionElement.GetString() : null;
    await AppendAsync(new
    {
      timestamp = DateTimeOffset.UtcNow,
      auditId,
      action,
      success = false,
      error = new { code = error.Code, message = error.Message }
    }, cancellationToken);
    return auditId;
  }

  public Task RecordTransportFailureAsync(Exception error, CancellationToken cancellationToken) =>
      AppendAsync(new
      {
        timestamp = DateTimeOffset.UtcNow,
        auditId = Guid.NewGuid().ToString(),
        action = "transport",
        success = false,
        error = new { code = "TRANSPORT_FAILURE", message = error.Message }
      }, cancellationToken);

  private async Task AppendAsync(object value, CancellationToken cancellationToken)
  {
    var node = JsonSerializer.SerializeToNode(value, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? new JsonObject();
    Redact(node, null);
    var line = node.ToJsonString(new JsonSerializerOptions(JsonSerializerDefaults.Web)) + Environment.NewLine;
    Directory.CreateDirectory(Path.GetDirectoryName(options.AuditPath)
        ?? throw new InvalidOperationException("Audit path has no parent directory"));
    await gate.WaitAsync(cancellationToken);
    try
    {
      await File.AppendAllTextAsync(options.AuditPath, line, cancellationToken);
    }
    finally
    {
      gate.Release();
    }
  }

  private static JsonNode? Redact(JsonNode? node, string? propertyName)
  {
    if (propertyName is not null && SecretName().IsMatch(propertyName))
      return JsonValue.Create("[REDACTED]");
    if (node is JsonObject objectNode)
    {
      foreach (var property in objectNode.ToArray())
        objectNode[property.Key] = Redact(property.Value, property.Key);
      return objectNode;
    }
    if (node is JsonArray arrayNode)
    {
      for (var index = 0; index < arrayNode.Count; index += 1)
        arrayNode[index] = Redact(arrayNode[index], null);
      return arrayNode;
    }
    if (node is JsonValue valueNode && valueNode.TryGetValue<string>(out var text))
    {
      return JsonValue.Create(Bearer().Replace(text, "$1[REDACTED]"));
    }
    return node;
  }

  [GeneratedRegex("token|secret|password|api[_-]?key|authorization|credential", RegexOptions.IgnoreCase)]
  private static partial Regex SecretName();

  [GeneratedRegex("(?i)(Bearer\\s+)[^\\s]+")]
  private static partial Regex Bearer();
}
