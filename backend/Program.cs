using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using LiveDemo;

DotEnv.Load();
var options = new GeminiOptions();

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://localhost:{options.Port}"); // Local demo: never expose this on a network.
builder.Services.AddSingleton(options);
builder.Services.AddHttpClient();
builder.Services.AddSingleton<TokenService>();
builder.Services.AddSingleton<LiveRelay>();

var app = builder.Build();
app.UseWebSockets();

// One-time tickets: the browser creates a session over HTTP, then redeems the ticket on the relay socket.
var pending = new ConcurrentDictionary<string, (LiveSettings Settings, JsonObject Setup)>();

app.MapGet("/api/health", () => Results.Ok(new
{
    hasApiKey = options.ApiKey is not null,
    apiVersion = options.ApiVersion,
    defaultModel = options.DefaultModel,
    defaultVoice = options.DefaultVoice
}));

app.MapGet("/api/options", () => Results.Ok(new
{
    models = Catalog.Models,
    voices = Catalog.Voices,
    scenarios = Catalog.Scenarios.Select(s => new { id = s.Id, label = s.Label, callerLine = s.CallerLine }),
    caller = new { name = Catalog.PassengerName, reference = Catalog.BookingReference }
}));

// Powers the "Setup JSON" tab: shows exactly what each toggle changes on the wire.
app.MapPost("/api/setup-preview", (LiveSettings settings) => Results.Ok(SetupBuilder.Build(settings, options)));

app.MapPost("/api/session", async (LiveSettings settings, TokenService tokens, CancellationToken ct) =>
{
    if (options.ApiKey is null)
        return Results.Json(new { message = "GEMINI_API_KEY is missing. Add it to .env and restart the backend." }, statusCode: 500);

    var setup = SetupBuilder.Build(settings, options);
    var trigger = Prompts.InitialTrigger();

    if (settings.Mode == "direct")
    {
        try
        {
            var token = await tokens.CreateAsync(setup, ct);
            return Results.Ok(new
            {
                mode = "direct",
                wsUrl = options.DirectUrl(token),
                // A setup message is still required, but the token's locked setup overrides it.
                clientSetup = new JsonObject { ["setup"] = new JsonObject { ["model"] = setup["model"]!.DeepClone() } },
                initialTrigger = trigger
            });
        }
        catch (InvalidOperationException ex)
        {
            return Results.Json(new { message = ex.Message }, statusCode: 502);
        }
    }

    var ticket = Guid.NewGuid().ToString("N");
    pending[ticket] = (settings, setup);
    return Results.Ok(new { mode = "relay", wsUrl = $"/ws/live?ticket={ticket}", clientSetup = (JsonObject?)null, initialTrigger = trigger });
});

app.Map("/ws/live", async (HttpContext http, LiveRelay relay) =>
{
    if (!http.WebSockets.IsWebSocketRequest)
    {
        http.Response.StatusCode = StatusCodes.Status400BadRequest;
        return;
    }

    var ticket = http.Request.Query["ticket"].ToString();
    if (!pending.TryRemove(ticket, out var session))
    {
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    using var browser = await http.WebSockets.AcceptWebSocketAsync();
    await relay.RunAsync(browser, session.Settings, session.Setup, http.RequestAborted);
});

app.Logger.LogInformation("API key configured: {HasKey}. Model: {Model}. API version: {Version}.",
    options.ApiKey is not null, options.DefaultModel, options.ApiVersion);

app.Run();
