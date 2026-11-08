namespace LiveDemo;

/// <summary>Everything read from .env. The API key never leaves this process.</summary>
public sealed class GeminiOptions
{
    public string? ApiKey { get; } =
        Environment.GetEnvironmentVariable("GEMINI_API_KEY") is { Length: > 0 } key ? key
        : Environment.GetEnvironmentVariable("GOOGLE_API_KEY") is { Length: > 0 } fallback ? fallback
        : null;

    public string ApiVersion { get; } = Env("GEMINI_API_VERSION", "v1beta");
    public string BaseUrl { get; } = Env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").TrimEnd('/');
    public string DefaultModel { get; } = Env("LIVE_DEFAULT_MODEL", "gemini-3.8-live");
    public string DefaultVoice { get; } = Env("LIVE_DEFAULT_VOICE", "Kore");
    public int Port { get; } = int.TryParse(Environment.GetEnvironmentVariable("BACKEND_PORT"), out var p) ? p : 5199;

    public string TokenUrl => $"{BaseUrl}/{ApiVersion}/auth_tokens";

    /// <summary>Used by the relay. Authenticates with the API key, sent as a header so it stays out of URLs and logs.</summary>
    public Uri RelayUri => new($"{WsBase}/ws/google.ai.generativelanguage.{ApiVersion}.GenerativeService.BidiGenerateContent");

    /// <summary>Used by the browser in direct mode. Authenticates with an ephemeral token.</summary>
    public string DirectUrl(string token) =>
        $"{WsBase}/ws/google.ai.generativelanguage.{ApiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token={Uri.EscapeDataString(token)}";

    private string WsBase => BaseUrl.Replace("https://", "wss://").Replace("http://", "ws://");

    private static string Env(string key, string fallback) =>
        Environment.GetEnvironmentVariable(key) is { Length: > 0 } value ? value : fallback;
}
