using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace LiveDemo;

/// <summary>
/// Relay mode: browser ⇄ this backend ⇄ Gemini Live. Adds one network hop, and in exchange the server
/// holds the key, sends the setup itself, and can see (and steer) the conversation.
/// </summary>
public sealed class LiveRelay(GeminiOptions options, ILogger<LiveRelay> log)
{
    public async Task RunAsync(WebSocket browser, LiveSettings settings, JsonObject setup, CancellationToken ct)
    {
        using var gemini = new ClientWebSocket();
        gemini.Options.SetRequestHeader("x-goog-api-key", options.ApiKey);

        try
        {
            await gemini.ConnectAsync(options.RelayUri, ct);
        }
        catch (Exception ex)
        {
            log.LogError("Could not reach Gemini: {Message}", ex.Message);
            await CloseAsync(browser, WebSocketCloseStatus.EndpointUnavailable, "Could not reach Gemini Live");
            return;
        }

        var turn = new TurnState(settings, browser, gemini);
        await turn.SendToGeminiAsync(new JsonObject { ["setup"] = setup }, ct);

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var downstream = PumpAsync(gemini, browser, turn.OnGeminiMessageAsync, turn.BrowserLock, linked.Token);
        var upstream = PumpAsync(browser, gemini, turn.OnBrowserMessageAsync, turn.GeminiLock, linked.Token);

        var finished = await Task.WhenAny(downstream, upstream);

        if (finished == downstream)
        {
            linked.Cancel();
            // Pass Gemini's close code and reason to the browser so the UI can show why (for example 1008).
            await CloseAsync(browser, gemini.CloseStatus ?? WebSocketCloseStatus.NormalClosure, gemini.CloseStatusDescription ?? "");
        }
        else
        {
            // Close Gemini first. Cancelling a pending read aborts the socket, and until Gemini notices, it
            // rejects a resume with 1008 "session is already connected to an existing client".
            await CloseAsync(gemini, WebSocketCloseStatus.NormalClosure, "Client left");
            linked.Cancel();
            await CloseAsync(browser, WebSocketCloseStatus.NormalClosure, "");
        }

        await Task.WhenAll(Quiet(downstream), Quiet(upstream));
        log.LogInformation("Relay session ended. Gemini close: {Status} {Reason}", gemini.CloseStatus, gemini.CloseStatusDescription);
    }

    /// <summary>Forwards one socket to the other. The callback may inspect a message and returns false to block it.</summary>
    private static async Task PumpAsync(
        WebSocket from, WebSocket to, Func<byte[], int, CancellationToken, Task<bool>> onMessage, SemaphoreSlim toLock, CancellationToken ct)
    {
        var chunk = new byte[64 * 1024];
        using var message = new MemoryStream();

        while (!ct.IsCancellationRequested && from.State == WebSocketState.Open)
        {
            message.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await from.ReceiveAsync(chunk, ct);
                if (result.MessageType == WebSocketMessageType.Close) return;
                message.Write(chunk, 0, result.Count);
            } while (!result.EndOfMessage);

            var buffer = message.GetBuffer();
            var length = (int)message.Length;
            if (!await onMessage(buffer, length, ct)) continue;

            await toLock.WaitAsync(ct);
            try
            {
                if (to.State == WebSocketState.Open)
                    await to.SendAsync(buffer.AsMemory(0, length), result.MessageType, true, ct);
            }
            finally { toLock.Release(); }
        }
    }

    private static async Task Quiet(Task task)
    {
        try { await task; } catch (Exception) { /* a socket closing mid-read is the normal way a session ends */ }
    }

    private static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string reason)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived)) return;
        // WebSocket close reasons are limited to 123 bytes. Codes such as 1006 cannot be sent, so map them.
        var safe = Enum.IsDefined(status) && status != WebSocketCloseStatus.Empty ? status : WebSocketCloseStatus.InternalServerError;
        var text = reason.Length > 120 ? reason[..120] : reason;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await socket.CloseAsync(safe, text, timeout.Token); } catch (Exception) { /* already gone */ }
    }

    /// <summary>Per-connection guard state: transcript buffers, turn count and send locks.</summary>
    private sealed class TurnState(LiveSettings settings, WebSocket browser, WebSocket gemini)
    {
        private readonly StringBuilder _input = new();
        private readonly StringBuilder _output = new();
        private readonly string _scenario = Prompts.ScenarioFor(settings.Scenario).Label;
        private bool _inputFlagged;
        private bool _outputFlagged;
        private int _turns;

        public SemaphoreSlim BrowserLock { get; } = new(1, 1);
        public SemaphoreSlim GeminiLock { get; } = new(1, 1);

        public async Task<bool> OnBrowserMessageAsync(byte[] buffer, int length, CancellationToken ct)
        {
            if (!settings.TranscriptGuard) return true;

            // Audio never contains a text field, so skip JSON parsing on the hot path.
            var span = buffer.AsSpan(0, length);
            if (span.IndexOf("\"text\""u8) < 0) return true;

            using var doc = JsonDocument.Parse(buffer.AsMemory(0, length));
            if (!doc.RootElement.TryGetProperty("realtimeInput", out var input) ||
                !input.TryGetProperty("text", out var textProperty)) return true;

            var text = textProperty.GetString() ?? "";
            if (TranscriptGuard.CheckInput(text) is not { } match) return true;

            // Typed text can be stopped before the model sees it. Speech cannot.
            await NotifyBrowserAsync("guard-input", $"Blocked typed attack before it reached the model: \"{match}\"", ct);
            await SteerAsync(Prompts.InputGuardNotice(_scenario), turnComplete: true, ct);
            return false;
        }

        public async Task<bool> OnGeminiMessageAsync(byte[] buffer, int length, CancellationToken ct)
        {
            var span = buffer.AsSpan(0, length);
            var hasTranscript = span.IndexOf("Transcription\""u8) >= 0;
            var hasTurnEnd = span.IndexOf("\"turnComplete\""u8) >= 0 || span.IndexOf("\"interrupted\""u8) >= 0;
            if (!hasTranscript && !hasTurnEnd) return true;

            using var doc = JsonDocument.Parse(buffer.AsMemory(0, length));
            if (!doc.RootElement.TryGetProperty("serverContent", out var content)) return true;

            if (settings.TranscriptGuard)
            {
                if (TryText(content, "inputTranscription", out var heard))
                {
                    _input.Append(heard);
                    if (!_inputFlagged && TranscriptGuard.CheckInput(_input.ToString()) is { } attack)
                    {
                        _inputFlagged = true;
                        await NotifyBrowserAsync("guard-input", $"Attack heard in speech: \"{attack}\". The model already heard it, so steering it back.", ct);
                        await SteerAsync(Prompts.InputGuardNotice(_scenario), turnComplete: true, ct);
                    }
                }

                if (TryText(content, "outputTranscription", out var said))
                {
                    _output.Append(said);
                    if (!_outputFlagged && TranscriptGuard.CheckOutput(_output.ToString()) is { } leak)
                    {
                        _outputFlagged = true;
                        await NotifyBrowserAsync("guard-output", $"Possible prompt leak in model speech: \"{leak}\". Interrupting the model.", ct);
                        await SteerAsync(Prompts.OutputGuardNotice(_scenario), turnComplete: true, ct);
                    }
                }
            }

            if (content.TryGetProperty("turnComplete", out var complete) && complete.GetBoolean())
            {
                _turns++;
                _input.Clear();
                _output.Clear();
                _inputFlagged = false;
                _outputFlagged = false;

                // Between turns is the safe moment: clientContent can interrupt an active generation.
                if (settings.ReanchorEveryTurns > 0 && _turns % settings.ReanchorEveryTurns == 0)
                {
                    await NotifyBrowserAsync("reanchor", $"Turn {_turns}: sent a hidden reminder of role and call reason.", ct);
                    await SteerAsync(Prompts.ReanchorNotice(_scenario), turnComplete: false, ct);
                }
            }

            return true;
        }

        private static bool TryText(JsonElement content, string field, out string text)
        {
            text = "";
            if (content.TryGetProperty(field, out var value) && value.TryGetProperty("text", out var t))
                text = t.GetString() ?? "";
            return text.Length > 0;
        }

        private Task SteerAsync(string notice, bool turnComplete, CancellationToken ct) =>
            SendToGeminiAsync(new JsonObject
            {
                ["clientContent"] = new JsonObject
                {
                    ["turns"] = new JsonArray(new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = notice })
                    }),
                    ["turnComplete"] = turnComplete
                }
            }, ct);

        public async Task SendToGeminiAsync(JsonObject message, CancellationToken ct)
        {
            await GeminiLock.WaitAsync(ct);
            try
            {
                if (gemini.State == WebSocketState.Open)
                    await gemini.SendAsync(Encoding.UTF8.GetBytes(message.ToJsonString()), WebSocketMessageType.Text, true, ct);
            }
            finally { GeminiLock.Release(); }
        }

        private async Task NotifyBrowserAsync(string kind, string detail, CancellationToken ct)
        {
            var payload = new JsonObject { ["relayEvent"] = new JsonObject { ["kind"] = kind, ["detail"] = detail } };
            await BrowserLock.WaitAsync(ct);
            try
            {
                if (browser.State == WebSocketState.Open)
                    await browser.SendAsync(Encoding.UTF8.GetBytes(payload.ToJsonString()), WebSocketMessageType.Text, true, ct);
            }
            finally { BrowserLock.Release(); }
        }
    }
}
