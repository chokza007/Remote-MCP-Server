using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace RemoteMcp.Broker;

public sealed record VerifiedRequest(
    string Action,
    IReadOnlyList<string> Targets,
    JsonElement Payload,
    string CorrelationId,
    string GrantId,
    string PrincipalId,
    string ClientId,
    string DeviceId,
    int SecurityEpoch,
    string CallerSid,
    string TransportNonce);

public sealed class RequestVerifier : IDisposable
{
  private readonly BrokerOptions options;
  private readonly ECDsa verifier;
  private readonly byte[] sharedSecret;
  private readonly object gate = new();
  private readonly Dictionary<string, DateTimeOffset> consumedNonces = new(StringComparer.Ordinal);
  private long highestSnapshotSequence;

  public RequestVerifier(BrokerOptions options)
  {
    this.options = options;
    verifier = ECDsa.Create();
    verifier.ImportSubjectPublicKeyInfo(Convert.FromBase64String(options.PublicKey), out _);
    sharedSecret = Convert.FromBase64String(File.ReadAllText(options.SharedSecretPath).Trim());
    if (sharedSecret.Length != 32) throw new InvalidDataException("Broker shared secret must contain 32 bytes");
    LoadRuntimeState();
  }

  public VerifiedRequest Verify(JsonElement request, string actualCallerSid)
  {
    var transportNonce = VerifyTransport(request);
    if (request.GetProperty("protocolVersion").GetInt32() != 1)
      throw Denied("UNSUPPORTED_PROTOCOL", "Unsupported broker protocol version");
    var action = RequiredString(request, "action");
    var targets = request.GetProperty("targets").EnumerateArray()
        .Select(element => element.GetString() ?? throw Denied("MALFORMED_REQUEST", "Target is not a string"))
        .Select(value => value.Trim()).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
    var payload = request.GetProperty("payload").Clone();
    var capability = request.GetProperty("capability");
    if (capability.GetProperty("version").GetInt32() != 1)
      throw Denied("UNSUPPORTED_CAPABILITY", "Unsupported capability token version");
    var claims = capability.GetProperty("claims");
    VerifySignature(claims, RequiredString(capability, "signature"), "Capability");
    var snapshot = LoadAuthorizationSnapshot();
    var state = snapshot.GetProperty("state");

    var issuedAt = ParseTime(RequiredString(claims, "issuedAt"), "issuedAt");
    var expiresAt = ParseTime(RequiredString(claims, "expiresAt"), "expiresAt");
    var now = DateTimeOffset.UtcNow;
    if (issuedAt > now.AddSeconds(5)) throw Denied("CAPABILITY_NOT_YET_VALID", "Capability was issued in the future");
    if (expiresAt <= now) throw Denied("CAPABILITY_EXPIRED", "Capability has expired");
    if (state.GetProperty("emergencyStop").GetBoolean())
      throw Denied("EMERGENCY_STOP", "Emergency Stop is active");

    var claimAction = RequiredString(claims, "action");
    if (!string.Equals(action.Trim(), claimAction, StringComparison.Ordinal))
      throw Denied("ACTION_MISMATCH", "Capability action mismatch");
    var claimTargets = claims.GetProperty("targets").EnumerateArray()
        .Select(element => element.GetString() ?? string.Empty)
        .Order(StringComparer.Ordinal).ToArray();
    if (!targets.SequenceEqual(claimTargets, StringComparer.Ordinal))
      throw Denied("TARGET_MISMATCH", "Capability targets mismatch");
    var expectedPayloadHash = "sha256:" + Convert.ToHexStringLower(SHA256.HashData(
        Encoding.UTF8.GetBytes(CanonicalJson(payload))));
    if (!string.Equals(expectedPayloadHash, RequiredString(claims, "payloadHash"), StringComparison.Ordinal))
      throw Denied("PAYLOAD_MISMATCH", "Capability payload mismatch");

    var callerSid = RequiredString(claims, "callerSid");
    if (!string.Equals(callerSid, actualCallerSid, StringComparison.OrdinalIgnoreCase) ||
        !string.Equals(callerSid, options.CallerSid, StringComparison.OrdinalIgnoreCase))
      throw Denied("CALLER_SID_MISMATCH", "Caller SID mismatch");
    var deviceId = RequiredString(claims, "deviceId");
    var epoch = claims.GetProperty("securityEpoch").GetInt32();
    if (!string.Equals(deviceId, RequiredString(state, "deviceId"), StringComparison.Ordinal) ||
        epoch != state.GetProperty("securityEpoch").GetInt32())
      throw Denied("STALE_SECURITY_EPOCH", "Capability security epoch or device is stale");

    var grantId = RequiredString(claims, "grantId");
    var grant = state.GetProperty("grants").EnumerateArray()
        .FirstOrDefault(candidate => string.Equals(RequiredString(candidate, "grantId"), grantId, StringComparison.Ordinal));
    if (grant.ValueKind == JsonValueKind.Undefined || !grant.GetProperty("active").GetBoolean() ||
        (grant.TryGetProperty("revokedAt", out var revokedAt) && revokedAt.ValueKind != JsonValueKind.Null))
      throw Denied("GRANT_INACTIVE", "Capability grant is revoked or inactive");
    if (!string.Equals(RequiredString(grant, "mode"), "full_access", StringComparison.Ordinal) ||
        !string.Equals(RequiredString(claims, "grantMode"), "full_access", StringComparison.Ordinal))
      throw Denied("FULL_ACCESS_REQUIRED", "Capability does not have Full Access");

    var principalId = RequiredString(claims, "principalId");
    var clientId = RequiredString(claims, "clientId");
    if (!string.Equals(principalId, RequiredString(grant, "principalId"), StringComparison.Ordinal) ||
        !string.Equals(clientId, RequiredString(grant, "clientId"), StringComparison.Ordinal) ||
        !string.Equals(deviceId, RequiredString(grant, "deviceId"), StringComparison.Ordinal))
      throw Denied("GRANT_IDENTITY_MISMATCH", "Capability grant identity mismatch");

    ConsumeNonce(RequiredString(claims, "nonce"), expiresAt, now);
    return new VerifiedRequest(
        action,
        targets,
        payload,
        RequiredString(claims, "correlationId"),
        grantId,
        principalId,
        clientId,
        deviceId,
        epoch,
        callerSid,
        transportNonce);
  }

  public BrokerResponse SignResponse(BrokerResponse response)
  {
    var element = JsonSerializer.SerializeToElement(response, ProtocolJsonOptions);
    var proof = ComputeProof(element);
    return response with { BrokerProof = proof };
  }

  public static string TryTransportNonce(JsonElement request) =>
      request.TryGetProperty("transportNonce", out var nonce) && nonce.ValueKind == JsonValueKind.String
          ? nonce.GetString() ?? "unknown"
          : "unknown";

  private string VerifyTransport(JsonElement request)
  {
    var transportNonce = RequiredString(request, "transportNonce");
    var clientProof = RequiredString(request, "clientProof");
    var node = JsonNode.Parse(request.GetRawText()) as JsonObject
        ?? throw Denied("MALFORMED_REQUEST", "Broker request must be an object");
    node.Remove("clientProof");
    var unsigned = JsonSerializer.SerializeToElement(node, ProtocolJsonOptions);
    var expected = Convert.FromBase64String(ComputeProof(unsigned));
    byte[] presented;
    try
    {
      presented = Convert.FromBase64String(clientProof);
    }
    catch (FormatException)
    {
      throw Denied("CLIENT_PROOF_INVALID", "Broker client authentication proof is malformed");
    }
    if (!CryptographicOperations.FixedTimeEquals(expected, presented))
      throw Denied("CLIENT_PROOF_INVALID", "Broker client authentication proof is invalid");
    return transportNonce;
  }

  private string ComputeProof(JsonElement value)
  {
    using var hmac = new HMACSHA256(sharedSecret);
    return Convert.ToBase64String(hmac.ComputeHash(Encoding.UTF8.GetBytes(CanonicalJson(value))));
  }

  private JsonElement LoadAuthorizationSnapshot()
  {
    using var document = JsonDocument.Parse(File.ReadAllText(options.AuthorizationStatePath));
    var root = document.RootElement;
    if (root.GetProperty("version").GetInt32() != 1)
      throw Denied("AUTHORIZATION_STATE_INVALID", "Unsupported authorization snapshot");
    var state = root.GetProperty("state");
    VerifySignature(state, RequiredString(root, "signature"), "Authorization snapshot");
    var sequence = state.GetProperty("sequence").GetInt64();
    lock (gate)
    {
      if (sequence < highestSnapshotSequence)
        throw Denied("AUTHORIZATION_STATE_ROLLBACK", "Authorization snapshot sequence moved backwards");
      if (sequence > highestSnapshotSequence)
      {
        highestSnapshotSequence = sequence;
        SaveRuntimeState();
      }
    }
    return root.Clone();
  }

  private void VerifySignature(JsonElement value, string signature, string label)
  {
    var valid = verifier.VerifyData(
        Encoding.UTF8.GetBytes(CanonicalJson(value)),
        Convert.FromBase64String(signature),
        HashAlgorithmName.SHA256,
        DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
    if (!valid) throw Denied("SIGNATURE_INVALID", $"{label} signature is invalid");
  }

  private void ConsumeNonce(string nonce, DateTimeOffset expiresAt, DateTimeOffset now)
  {
    lock (gate)
    {
      foreach (var expired in consumedNonces.Where(pair => pair.Value <= now).Select(pair => pair.Key).ToArray())
        consumedNonces.Remove(expired);
      if (!consumedNonces.TryAdd(nonce, expiresAt))
        throw Denied("NONCE_REPLAY", "Capability nonce replay detected");
      SaveRuntimeState();
    }
  }

  private void LoadRuntimeState()
  {
    if (!File.Exists(options.RuntimeStatePath)) return;
    using var document = JsonDocument.Parse(File.ReadAllText(options.RuntimeStatePath));
    var root = document.RootElement;
    if (root.GetProperty("version").GetInt32() != 1)
      throw new InvalidDataException("Unsupported broker runtime state");
    highestSnapshotSequence = root.GetProperty("highestSnapshotSequence").GetInt64();
    if (root.TryGetProperty("consumedNonces", out var nonces))
    {
      foreach (var property in nonces.EnumerateObject())
      {
        if (DateTimeOffset.TryParse(
            property.Value.GetString(),
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal,
            out var expiry) && expiry > DateTimeOffset.UtcNow)
        {
          consumedNonces[property.Name] = expiry.ToUniversalTime();
        }
      }
    }
  }

  private void SaveRuntimeState()
  {
    var directory = Path.GetDirectoryName(options.RuntimeStatePath)
        ?? throw new InvalidOperationException("Broker runtime state path has no parent directory");
    Directory.CreateDirectory(directory);
    var temporary = options.RuntimeStatePath + $".{Environment.ProcessId}.{Guid.NewGuid():N}.tmp";
    var state = new
    {
      version = 1,
      highestSnapshotSequence,
      consumedNonces = consumedNonces.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            StringComparer.Ordinal)
    };
    File.WriteAllText(temporary, JsonSerializer.Serialize(state, ProtocolJsonOptions));
    File.Move(temporary, options.RuntimeStatePath, true);
  }

  public static string CanonicalJson(JsonElement value)
  {
    var builder = new StringBuilder();
    WriteCanonical(value, builder);
    return builder.ToString();
  }

  private static void WriteCanonical(JsonElement value, StringBuilder builder)
  {
    switch (value.ValueKind)
    {
      case JsonValueKind.Object:
        builder.Append('{');
        var firstProperty = true;
        foreach (var property in value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal))
        {
          if (!firstProperty) builder.Append(',');
          firstProperty = false;
          builder.Append(JsonSerializer.Serialize(property.Name, CanonicalJsonOptions));
          builder.Append(':');
          WriteCanonical(property.Value, builder);
        }
        builder.Append('}');
        break;
      case JsonValueKind.Array:
        builder.Append('[');
        var firstItem = true;
        foreach (var item in value.EnumerateArray())
        {
          if (!firstItem) builder.Append(',');
          firstItem = false;
          WriteCanonical(item, builder);
        }
        builder.Append(']');
        break;
      case JsonValueKind.String:
        builder.Append(JsonSerializer.Serialize(value.GetString(), CanonicalJsonOptions));
        break;
      default:
        builder.Append(value.GetRawText());
        break;
    }
  }

  private static readonly JsonSerializerOptions CanonicalJsonOptions = new()
  {
    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  };

  private static readonly JsonSerializerOptions ProtocolJsonOptions = new(JsonSerializerDefaults.Web)
  {
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
  };

  private static string RequiredString(JsonElement source, string property) =>
      source.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
          ? value.GetString() ?? throw Denied("MALFORMED_REQUEST", $"{property} is empty")
          : throw Denied("MALFORMED_REQUEST", $"{property} is missing or invalid");

  private static DateTimeOffset ParseTime(string value, string name) =>
      DateTimeOffset.TryParse(value, System.Globalization.CultureInfo.InvariantCulture,
          System.Globalization.DateTimeStyles.AssumeUniversal, out var parsed)
          ? parsed.ToUniversalTime()
          : throw Denied("MALFORMED_REQUEST", $"{name} is invalid");

  public void Dispose()
  {
    verifier.Dispose();
    CryptographicOperations.ZeroMemory(sharedSecret);
  }

  private static BrokerDeniedException Denied(string code, string message) => new(code, message);
}
