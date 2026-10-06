using System.Buffers.Binary;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RemoteMcp.Broker;

public sealed class NamedPipeServer(BrokerOptions options, AuditSink audit)
{
  private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
  {
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
  };

  public async Task RunAsync(
      Func<string, JsonElement, string, CancellationToken, Task<BrokerResponse>> handler,
      Action onReady,
      CancellationToken cancellationToken)
  {
    var ready = false;
    while (!cancellationToken.IsCancellationRequested)
    {
      await using var pipe = CreatePipe();
      if (!ready)
      {
        ready = true;
        onReady();
      }
      try
      {
        await pipe.WaitForConnectionAsync(cancellationToken);
        await HandleConnectionAsync(pipe, handler, cancellationToken);
      }
      catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
      {
        return;
      }
      catch (Exception error)
      {
        await audit.RecordTransportFailureAsync(error, cancellationToken);
      }
    }
  }

  private NamedPipeServerStream CreatePipe()
  {
    var security = new PipeSecurity();
    security.SetAccessRuleProtection(true, false);
    var caller = new SecurityIdentifier(options.CallerSid);
    security.AddAccessRule(new PipeAccessRule(
        caller,
        PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance,
        AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        PipeAccessRights.FullControl,
        AccessControlType.Allow));
    security.AddAccessRule(new PipeAccessRule(
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        PipeAccessRights.FullControl,
        AccessControlType.Allow));
    return NamedPipeServerStreamAcl.Create(
        options.PipeName,
        PipeDirection.InOut,
        NamedPipeServerStream.MaxAllowedServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous | PipeOptions.WriteThrough,
        64 * 1024,
        64 * 1024,
        security,
        HandleInheritability.None,
        PipeAccessRights.ChangePermissions);
  }

  private async Task HandleConnectionAsync(
      NamedPipeServerStream pipe,
      Func<string, JsonElement, string, CancellationToken, Task<BrokerResponse>> handler,
      CancellationToken cancellationToken)
  {
    var header = new byte[4];
    await ReadExactlyAsync(pipe, header, cancellationToken);
    var length = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(header));
    if (length < 1 || length > options.MaxFrameBytes)
    {
      throw new BrokerDeniedException("MALFORMED_FRAME", $"Broker frame size is invalid: {length}");
    }
    var body = new byte[length];
    await ReadExactlyAsync(pipe, body, cancellationToken);
    using var document = JsonDocument.Parse(body, new JsonDocumentOptions
    {
      AllowTrailingCommas = false,
      CommentHandling = JsonCommentHandling.Disallow,
      MaxDepth = 64
    });
    var request = document.RootElement.Clone();
    var requestId = request.TryGetProperty("requestId", out var idElement)
        ? idElement.GetString() ?? "unknown"
        : "unknown";
    var callerSid = GetCallerSid(pipe);
    var response = await handler(requestId, request, callerSid, cancellationToken);
    var responseBody = JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions);
    if (responseBody.Length > options.MaxFrameBytes) throw new InvalidDataException("Broker response is too large");
    BinaryPrimitives.WriteUInt32LittleEndian(header, checked((uint)responseBody.Length));
    await pipe.WriteAsync(header, cancellationToken);
    await pipe.WriteAsync(responseBody, cancellationToken);
    await pipe.FlushAsync(cancellationToken);
  }

  private static string GetCallerSid(NamedPipeServerStream pipe)
  {
    string? sid = null;
    pipe.RunAsClient(() => sid = WindowsIdentity.GetCurrent().User?.Value);
    return sid ?? throw new BrokerDeniedException("CALLER_IDENTITY_UNAVAILABLE", "Unable to resolve pipe caller SID");
  }

  private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
  {
    var offset = 0;
    while (offset < buffer.Length)
    {
      var read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken);
      if (read == 0) throw new EndOfStreamException("Broker client disconnected mid-frame");
      offset += read;
    }
  }
}
