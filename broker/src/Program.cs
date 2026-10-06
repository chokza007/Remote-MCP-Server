using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace RemoteMcp.Broker;

internal static class Program
{
  public static async Task<int> Main(string[] args)
  {
    try
    {
      var options = BrokerOptions.Parse(args);
      var builder = Host.CreateApplicationBuilder(args);
      if (!options.ConsoleMode)
      {
        builder.Services.AddWindowsService(service => service.ServiceName = options.ServiceName);
      }

      builder.Services.AddSingleton(options);
      builder.Services.AddSingleton<AuditSink>();
      builder.Services.AddSingleton<RequestVerifier>();
      builder.Services.AddSingleton<Handlers>();
      builder.Services.AddSingleton<NamedPipeServer>();
      builder.Services.AddHostedService<BrokerService>();
      using var host = builder.Build();
      await host.RunAsync();
      return 0;
    }
    catch (Exception error)
    {
      Console.Error.WriteLine($"BROKER_FATAL {error.Message}");
      return 1;
    }
  }
}

public sealed record ApprovedCommand(string File, IReadOnlyList<string> ArgumentPrefix);

public sealed class BrokerOptions
{
  public required string PipeName { get; init; }
  public required string PublicKey { get; init; }
  public required string AuthorizationStatePath { get; init; }
  public required string AuditPath { get; init; }
  public required string CallerSid { get; init; }
  public required string SharedSecretPath { get; init; }
  public required string RuntimeStatePath { get; init; }
  public string ServiceName { get; init; } = "RemoteMcpPrivilegedBroker";
  public bool ConsoleMode { get; init; }
  public bool AllowFixtures { get; init; }
  public int MaxFrameBytes { get; init; } = 1_048_576;
  public IReadOnlyDictionary<string, ApprovedCommand> ApprovedCommands { get; init; } =
      new Dictionary<string, ApprovedCommand>(StringComparer.Ordinal);

  public static BrokerOptions Parse(string[] args)
  {
    var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    for (var index = 0; index < args.Length; index += 1)
    {
      var current = args[index];
      if (!current.StartsWith("--", StringComparison.Ordinal)) continue;
      if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
      {
        values[current] = args[++index];
      }
      else
      {
        flags.Add(current);
      }
    }

    static string Required(Dictionary<string, string> source, string name) =>
        source.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : throw new ArgumentException($"Missing required broker option: {name}");

    var commands = new Dictionary<string, ApprovedCommand>(StringComparer.Ordinal);
    if (values.TryGetValue("--approved-commands", out var commandPath))
    {
      using var document = System.Text.Json.JsonDocument.Parse(File.ReadAllText(commandPath));
      foreach (var property in document.RootElement.EnumerateObject())
      {
        var file = property.Value.GetProperty("file").GetString()
            ?? throw new InvalidDataException("Approved command file is missing");
        var prefix = property.Value.TryGetProperty("argumentPrefix", out var prefixElement)
            ? prefixElement.EnumerateArray().Select(value => value.GetString() ?? string.Empty).ToArray()
            : Array.Empty<string>();
        commands.Add(property.Name, new ApprovedCommand(file, prefix));
      }
    }

    return new BrokerOptions
    {
      PipeName = Required(values, "--pipe"),
      PublicKey = Required(values, "--public-key"),
      AuthorizationStatePath = Path.GetFullPath(Required(values, "--authorization-state")),
      AuditPath = Path.GetFullPath(Required(values, "--audit")),
      CallerSid = Required(values, "--caller-sid"),
      SharedSecretPath = Path.GetFullPath(Required(values, "--shared-secret-file")),
      RuntimeStatePath = Path.GetFullPath(Required(values, "--runtime-state")),
      ServiceName = values.GetValueOrDefault("--service-name") ?? "RemoteMcpPrivilegedBroker",
      ConsoleMode = flags.Contains("--console"),
      AllowFixtures = flags.Contains("--allow-fixtures"),
      MaxFrameBytes = values.TryGetValue("--max-frame-bytes", out var maxValue)
            ? int.Parse(maxValue, System.Globalization.CultureInfo.InvariantCulture)
            : 1_048_576,
      ApprovedCommands = commands
    };
  }
}
