using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace RemoteMcp.Broker;

public sealed partial class Handlers(BrokerOptions options)
{
  public async Task<object> ExecuteAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    return request.Action switch
    {
      "fixture.echo" when options.AllowFixtures => RedactedPayload(request.Payload),
      "filesystem.create_directory" => CreateDirectory(request),
      "filesystem.write_file" => await WriteFileAsync(request, cancellationToken),
      "service.start" => await ServiceAsync(request, "start", cancellationToken),
      "service.stop" => await ServiceAsync(request, "stop", cancellationToken),
      "service.restart" => await RestartServiceAsync(request, cancellationToken),
      "package.install" => await PackageAsync(request, "install", cancellationToken),
      "package.uninstall" => await PackageAsync(request, "uninstall", cancellationToken),
      "registry.set" => await RegistrySetAsync(request, cancellationToken),
      "registry.delete" => await RegistryDeleteAsync(request, cancellationToken),
      "firewall.add" => await FirewallAddAsync(request, cancellationToken),
      "firewall.delete" => await FirewallDeleteAsync(request, cancellationToken),
      "process.terminate" => await TerminateProcessAsync(request, cancellationToken),
      "command.execute" => await ApprovedCommandAsync(request, cancellationToken),
      _ => throw new BrokerDeniedException("ACTION_NOT_ALLOWED", $"Unsupported privileged action: {request.Action}")
    };
  }

  private static object CreateDirectory(VerifiedRequest request)
  {
    var path = ValidatedPath(request);
    Directory.CreateDirectory(path);
    return new { path, created = true };
  }

  private static async Task<object> WriteFileAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var path = ValidatedPath(request);
    var content = RequiredString(request.Payload, "content");
    var overwrite = request.Payload.TryGetProperty("overwrite", out var overwriteElement) && overwriteElement.GetBoolean();
    Directory.CreateDirectory(Path.GetDirectoryName(path)
        ?? throw new BrokerDeniedException("INVALID_TARGET", "File target has no parent directory"));
    await using var stream = new FileStream(
        path,
        overwrite ? FileMode.Create : FileMode.CreateNew,
        FileAccess.Write,
        FileShare.None,
        64 * 1024,
        FileOptions.Asynchronous | FileOptions.WriteThrough);
    await using var writer = new StreamWriter(stream);
    await writer.WriteAsync(content.AsMemory(), cancellationToken);
    return new { path, bytes = stream.Position };
  }

  private static async Task<object> ServiceAsync(VerifiedRequest request, string operation, CancellationToken cancellationToken)
  {
    var name = ValidName(RequiredString(request.Payload, "name"), "service");
    await RunAsync("sc.exe", [operation, name], cancellationToken, allowNonZero: operation == "stop");
    return new { name, operation };
  }

  private static async Task<object> RestartServiceAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    await ServiceAsync(request, "stop", cancellationToken);
    return await ServiceAsync(request, "start", cancellationToken);
  }

  private static async Task<object> PackageAsync(VerifiedRequest request, string operation, CancellationToken cancellationToken)
  {
    var id = ValidPackageId(RequiredString(request.Payload, "id"));
    var args = operation == "install"
        ? new[] { "install", "--id", id, "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements" }
        : new[] { "uninstall", "--id", id, "--exact", "--silent" };
    await RunAsync("winget.exe", args, cancellationToken);
    return new { id, operation };
  }

  private static async Task<object> RegistrySetAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var key = ValidRegistryKey(RequiredString(request.Payload, "key"));
    var name = RequiredString(request.Payload, "name");
    var value = RequiredString(request.Payload, "value");
    var type = request.Payload.TryGetProperty("type", out var typeElement)
        ? typeElement.GetString() ?? "REG_SZ"
        : "REG_SZ";
    if (!new[] { "REG_SZ", "REG_EXPAND_SZ", "REG_DWORD", "REG_QWORD", "REG_MULTI_SZ" }.Contains(type, StringComparer.Ordinal))
      throw new BrokerDeniedException("INVALID_REGISTRY_TYPE", "Registry value type is not allowed");
    await RunAsync("reg.exe", ["ADD", key, "/v", name, "/t", type, "/d", value, "/f"], cancellationToken);
    return new { key, name, operation = "set" };
  }

  private static async Task<object> RegistryDeleteAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var key = ValidRegistryKey(RequiredString(request.Payload, "key"));
    var name = RequiredString(request.Payload, "name");
    await RunAsync("reg.exe", ["DELETE", key, "/v", name, "/f"], cancellationToken);
    return new { key, name, operation = "delete" };
  }

  private static async Task<object> FirewallAddAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var name = RequiredString(request.Payload, "name");
    var direction = RequiredString(request.Payload, "direction").ToLowerInvariant();
    var ruleAction = RequiredString(request.Payload, "ruleAction").ToLowerInvariant();
    if (direction is not ("in" or "out") || ruleAction is not ("allow" or "block"))
      throw new BrokerDeniedException("INVALID_FIREWALL_RULE", "Firewall direction or action is invalid");
    var args = new List<string> { "advfirewall", "firewall", "add", "rule", $"name={name}", $"dir={direction}", $"action={ruleAction}" };
    if (request.Payload.TryGetProperty("program", out var program)) args.Add($"program={Path.GetFullPath(program.GetString()!)}");
    if (request.Payload.TryGetProperty("protocol", out var protocol)) args.Add($"protocol={protocol.GetString()}");
    if (request.Payload.TryGetProperty("localPort", out var localPort)) args.Add($"localport={localPort.GetInt32()}");
    await RunAsync("netsh.exe", args, cancellationToken);
    return new { name, operation = "add" };
  }

  private static async Task<object> FirewallDeleteAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var name = RequiredString(request.Payload, "name");
    await RunAsync("netsh.exe", ["advfirewall", "firewall", "delete", "rule", $"name={name}"], cancellationToken);
    return new { name, operation = "delete" };
  }

  private static async Task<object> TerminateProcessAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var pid = request.Payload.GetProperty("pid").GetInt32();
    var createdAt = DateTimeOffset.Parse(RequiredString(request.Payload, "createdAt"), System.Globalization.CultureInfo.InvariantCulture);
    using var process = Process.GetProcessById(pid);
    var actual = process.StartTime.ToUniversalTime();
    if (Math.Abs((actual - createdAt.UtcDateTime).TotalSeconds) > 1)
      throw new BrokerDeniedException("PROCESS_IDENTITY_MISMATCH", "Process creation identity mismatch");
    await RunAsync("taskkill.exe", ["/PID", pid.ToString(System.Globalization.CultureInfo.InvariantCulture), "/T", "/F"], cancellationToken);
    return new { pid, terminated = true };
  }

  private async Task<object> ApprovedCommandAsync(VerifiedRequest request, CancellationToken cancellationToken)
  {
    var commandId = RequiredString(request.Payload, "commandId");
    if (!options.ApprovedCommands.TryGetValue(commandId, out var command))
      throw new BrokerDeniedException("COMMAND_NOT_APPROVED", "Privileged command is not approved");
    var supplied = request.Payload.TryGetProperty("args", out var argsElement)
        ? argsElement.EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray()
        : Array.Empty<string>();
    var arguments = command.ArgumentPrefix.Concat(supplied).ToArray();
    var result = await RunAsync(command.File, arguments, cancellationToken);
    return new { commandId, exitCode = result.ExitCode, stdout = result.Stdout };
  }

  private static string ValidatedPath(VerifiedRequest request)
  {
    var path = Path.GetFullPath(RequiredString(request.Payload, "path"));
    if (!request.Targets.Any(target => string.Equals(Path.GetFullPath(target), path, StringComparison.OrdinalIgnoreCase)))
      throw new BrokerDeniedException("TARGET_MISMATCH", "Filesystem payload path is not capability-bound");
    return path;
  }

  private static string RequiredString(JsonElement source, string name) =>
      source.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(value.GetString())
          ? value.GetString()!
          : throw new BrokerDeniedException("MALFORMED_PAYLOAD", $"Payload field is missing or invalid: {name}");

  private static string ValidName(string value, string kind) =>
      SafeName().IsMatch(value) ? value : throw new BrokerDeniedException("INVALID_NAME", $"Invalid {kind} name");

  private static string ValidPackageId(string value) =>
      PackageId().IsMatch(value) ? value : throw new BrokerDeniedException("INVALID_PACKAGE_ID", "Invalid package ID");

  private static string ValidRegistryKey(string value) =>
      value.StartsWith("HKLM\\", StringComparison.OrdinalIgnoreCase) || value.StartsWith("HKCU\\", StringComparison.OrdinalIgnoreCase)
          ? value
          : throw new BrokerDeniedException("INVALID_REGISTRY_KEY", "Only HKLM and HKCU registry keys are allowed");

  private static object RedactedPayload(JsonElement payload)
  {
    var node = JsonNode.Parse(payload.GetRawText()) ?? new JsonObject();
    Redact(node);
    return node;
  }

  private static void Redact(JsonNode? node)
  {
    if (node is JsonObject objectNode)
    {
      foreach (var property in objectNode.ToArray())
      {
        if (SecretName().IsMatch(property.Key)) objectNode[property.Key] = "[REDACTED]";
        else Redact(property.Value);
      }
    }
    else if (node is JsonArray arrayNode)
    {
      foreach (var child in arrayNode) Redact(child);
    }
  }

  private static async Task<CommandResult> RunAsync(
      string file,
      IEnumerable<string> arguments,
      CancellationToken cancellationToken,
      bool allowNonZero = false)
  {
    var start = new ProcessStartInfo(file)
    {
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true
    };
    foreach (var argument in arguments) start.ArgumentList.Add(argument);
    using var process = Process.Start(start) ?? throw new InvalidOperationException($"Failed to start {file}");
    var stdoutTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
    var stderrTask = process.StandardError.ReadToEndAsync(cancellationToken);
    await process.WaitForExitAsync(cancellationToken);
    var stdout = await stdoutTask;
    var stderr = await stderrTask;
    if (process.ExitCode != 0 && !allowNonZero)
      throw new BrokerDeniedException("PRIVILEGED_COMMAND_FAILED", $"{file} exited {process.ExitCode}: {stderr.Trim()}");
    return new CommandResult(process.ExitCode, stdout, stderr);
  }

  private sealed record CommandResult(int ExitCode, string Stdout, string Stderr);

  [GeneratedRegex("^[A-Za-z0-9_. -]{1,256}$", RegexOptions.CultureInvariant)]
  private static partial Regex SafeName();

  [GeneratedRegex("^[A-Za-z0-9_.-]{1,256}$", RegexOptions.CultureInvariant)]
  private static partial Regex PackageId();

  [GeneratedRegex("token|secret|password|api[_-]?key|authorization|credential", RegexOptions.IgnoreCase)]
  private static partial Regex SecretName();
}
