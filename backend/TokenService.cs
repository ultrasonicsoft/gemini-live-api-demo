using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LiveDemo;

/// <summary>
/// Direct mode: mints an ephemeral token with the whole setup locked inside it.
/// Google's reference: with an empty fieldMask, the effective setup is "taken entirely from
/// bidiGenerateContentSetup" and the setup message sent by the client is ignored.
/// So the system prompt stays on the server and the browser cannot change it.
/// </summary>
public sealed class TokenService(IHttpClientFactory httpFactory, GeminiOptions options)
{
    public async Task<string> CreateAsync(JsonObject setup, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["uses"] = 1,
            ["expireTime"] = DateTime.UtcNow.AddMinutes(30).ToString("O"),
            ["newSessionExpireTime"] = DateTime.UtcNow.AddMinutes(2).ToString("O"),
            ["bidiGenerateContentSetup"] = setup.DeepClone()
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, options.TokenUrl)
        {
            Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json")
        };
        request.Headers.Add("x-goog-api-key", options.ApiKey);

        var response = await httpFactory.CreateClient().SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"Token request failed ({(int)response.StatusCode}): {text}");

        using var json = JsonDocument.Parse(text);
        return json.RootElement.GetProperty("name").GetString()
            ?? throw new InvalidOperationException("Token response did not contain a name.");
    }
}
