namespace LiveDemo;

/// <summary>
/// Server-side settings from the control panel. Each one maps to a field of the Live API setup message,
/// so changing any of them requires a new session. Client-only settings (chunk size, echo cancellation,
/// playback flush) live in the Angular app and apply immediately.
/// </summary>
public sealed class LiveSettings
{
    public string Mode { get; set; } = "relay"; // relay | direct
    public string? Model { get; set; }
    public string? Voice { get; set; }
    public string Scenario { get; set; } = "cancelled";
    public double Temperature { get; set; } = 0.8;
    public int MaxOutputTokens { get; set; } = 0; // 0 = leave unset
    public string ThinkingLevel { get; set; } = ""; // extended-thinking and 3.1 models only

    // Prompt layers
    public bool StayOnTrack { get; set; } = true;
    public bool PlainSpeech { get; set; } = true;
    public bool LanguageLock { get; set; } = true;
    public bool Guardrails { get; set; } = true;
    public string CustomInstruction { get; set; } = "";

    // VAD and interruption
    public bool AutoVad { get; set; } = true;
    public string StartSensitivity { get; set; } = "START_SENSITIVITY_LOW";
    public string EndSensitivity { get; set; } = "END_SENSITIVITY_LOW";
    public int SilenceMs { get; set; } = 800;
    public int PrefixPaddingMs { get; set; } = 40;
    public bool AllowInterruption { get; set; } = true;

    // Session management
    public bool InputTranscription { get; set; } = true;
    public bool OutputTranscription { get; set; } = true;
    public bool Compression { get; set; } = true;
    public bool Resumption { get; set; } = true;
    public string? ResumeHandle { get; set; }

    // Server-side guard. Relay mode only: with a direct socket the backend cannot see the conversation.
    public bool TranscriptGuard { get; set; } = true;
    public int ReanchorEveryTurns { get; set; } = 0;
}

public sealed record ModelInfo(string Id, string Label, string Note, string[] ThinkingLevels);

/// <summary>Situation goes into the prompt. CallerLine is what the presenter can say to open the call.</summary>
public sealed record CallScenario(string Id, string Label, string Situation, string CallerLine);

public static class Catalog
{
    public static readonly ModelInfo[] Models =
    [
        new("gemini-3.8-live", "Gemini 3.8 Live", "GA. Default choice. Thinking is built in and not configurable.", []),
        new("gemini-3.8-live-extended-thinking", "Gemini 3.8 Live Extended Thinking", "GA. Adds background reasoning.", ["low", "medium", "high"]),
        new("gemini-3.1-flash-live-preview", "Gemini 3.1 Flash Live (preview)", "Earliest shutdown 17 Nov 2026.", ["minimal", "low", "medium", "high"]),
    ];

    public static readonly string[] Voices = ["Kore", "Puck", "Charon", "Aoede", "Fenrir", "Leda", "Orus", "Zephyr"];

    // Everything here is fictional, including the airline. 555 numbers and example.com are reserved for samples.
    public const string PassengerName = "Alex Morgan";
    public const string BookingReference = "MALTA7";
    public const string PhoneOnFile = "+1 202 555 0142";
    public const string EmailOnFile = "alex.morgan@example.com";

    public static readonly CallScenario[] Scenarios =
    [
        new("cancelled", "A cancelled flight",
            "Flight CA 214 from Malta to Munich, today at 18:40, is cancelled because of a storm in Munich. Option one: free rebooking on CA 216 tomorrow at 07:15, with a hotel voucher of up to 120 euros tonight. Option two: a full refund to the original card within 7 days. Because the cause is weather, there is no extra cash compensation.",
            "Hi, this is Alex Morgan, reference Malta seven. My flight to Munich was cancelled."),
        new("baggage", "A delayed bag",
            "Flight CA 213 from Munich to Malta landed yesterday without the caller's one checked bag. The bag has been found in Munich and arrives tonight. Option one: free delivery to the caller's address tomorrow before noon. Option two: free collection at Malta airport from 8 tomorrow morning. Essential purchases are reimbursed up to 100 euros with receipts.",
            "Hi, this is Alex Morgan, reference Malta seven. My bag did not arrive yesterday."),
        new("change", "Changing a flight",
            "Flight CA 214 from Malta to Munich is booked for next Friday at 18:40, seat 14C. A change costs 45 euros plus any fare difference. Option one: the following Friday at 18:40, fare difference 30 euros. Option two: next Sunday at 09:30, no fare difference. Upgrades cannot be arranged on this line.",
            "Hi, this is Alex Morgan, reference Malta seven. I need to move my flight."),
    ];
}
