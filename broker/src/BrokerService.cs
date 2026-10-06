using Microsoft.Extensions.Hosting;
using System.Text.Json;

namespace RemoteMcp.Broker;

public sealed class BrokerService(
    BrokerOptions options,
    NamedPipeServer pipeServer,
    RequestVerifier verifier,
    Handlers handlers,
    AuditSink audit) : BackgroundService
{
  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    await pipeServer.RunAsync(
        HandleAsync,
        () => Console.WriteLine($"BROKER_READY {options.PipeName}"),
        stoppingToken);
  }

  private async Task<BrokerResponse> HandleAsync(
      string requestId,
      JsonElement request,
      string actualCallerSid,
      CancellationToken cancellationToken)
  {
    try
    {
      var verified = verifier.Verify(request, actualCallerSid);
      var result = await handlers.ExecuteAsync(verified, cancellationToken);
      var auditId = await audit.RecordAsync(verified, true, result, null, cancellationToken);
      return verifier.SignResponse(BrokerResponse.Success(
          requestId,
          result,
          auditId,
          verified.TransportNonce));
    }
    catch (BrokerDeniedException error)
    {
      var auditId = await audit.RecordDeniedAsync(request, error, cancellationToken);
      return verifier.SignResponse(BrokerResponse.Failure(
          requestId,
          error.Code,
          error.Message,
          auditId,
          RequestVerifier.TryTransportNonce(request)));
    }
    catch (Exception error)
    {
      var denied = new BrokerDeniedException("BROKER_OPERATION_FAILED", error.Message);
      var auditId = await audit.RecordDeniedAsync(request, denied, cancellationToken);
      return verifier.SignResponse(BrokerResponse.Failure(
          requestId,
          denied.Code,
          denied.Message,
          auditId,
          RequestVerifier.TryTransportNonce(request)));
    }
  }
}

public sealed record BrokerResponse(
    int ProtocolVersion,
    string RequestId,
    bool Ok,
    object? Result,
    string? AuditId,
    BrokerError? Error,
    string TransportNonce,
    string? BrokerProof)
{
  public static BrokerResponse Success(string requestId, object result, string auditId, string transportNonce) =>
      new(1, requestId, true, result, auditId, null, transportNonce, null);

  public static BrokerResponse Failure(
      string requestId,
      string code,
      string message,
      string auditId,
      string transportNonce) =>
      new(1, requestId, false, null, auditId, new BrokerError(code, message), transportNonce, null);
}

public sealed record BrokerError(string Code, string Message);

public sealed class BrokerDeniedException(string code, string message) : Exception(message)
{
  public string Code { get; } = code;
}
