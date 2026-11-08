using System.Text.Json.Nodes;

namespace LiveDemo;

/// <summary>Translates control-panel settings into the Live API BidiGenerateContentSetup message.</summary>
public static class SetupBuilder
{
    public static JsonObject Build(LiveSettings s, GeminiOptions options)
    {
        var model = Normalize(s.Model, options.DefaultModel);
        var modelInfo = Catalog.Models.FirstOrDefault(m => m.Id == model);

        var generationConfig = new JsonObject
        {
            // Native audio models only support AUDIO. Use outputAudioTranscription for text.
            ["responseModalities"] = new JsonArray("AUDIO"),
            ["temperature"] = s.Temperature,
            ["speechConfig"] = new JsonObject
            {
                ["voiceConfig"] = new JsonObject
                {
                    ["prebuiltVoiceConfig"] = new JsonObject { ["voiceName"] = Normalize(s.Voice, options.DefaultVoice) }
                }
            }
        };

        if (s.MaxOutputTokens > 0)
            generationConfig["maxOutputTokens"] = s.MaxOutputTokens;

        // gemini-3.8-live rejects thinking settings, so only send them to models that accept the chosen value.
        if (s.ThinkingLevel.Length > 0 && modelInfo is not null && modelInfo.ThinkingLevels.Contains(s.ThinkingLevel))
            generationConfig["thinkingConfig"] = new JsonObject { ["thinkingLevel"] = s.ThinkingLevel };

        var activityDetection = s.AutoVad
            ? new JsonObject
            {
                ["startOfSpeechSensitivity"] = s.StartSensitivity,
                ["endOfSpeechSensitivity"] = s.EndSensitivity,
                ["silenceDurationMs"] = s.SilenceMs,
                ["prefixPaddingMs"] = s.PrefixPaddingMs
            }
            : new JsonObject { ["disabled"] = true };

        var setup = new JsonObject
        {
            ["model"] = $"models/{model}",
            ["generationConfig"] = generationConfig,
            ["systemInstruction"] = new JsonObject
            {
                ["parts"] = new JsonArray(new JsonObject { ["text"] = Prompts.Build(s) })
            },
            ["realtimeInputConfig"] = new JsonObject
            {
                ["automaticActivityDetection"] = activityDetection,
                ["activityHandling"] = s.AllowInterruption ? "START_OF_ACTIVITY_INTERRUPTS" : "NO_INTERRUPTION"
            }
        };

        if (s.InputTranscription) setup["inputAudioTranscription"] = new JsonObject();
        if (s.OutputTranscription) setup["outputAudioTranscription"] = new JsonObject();
        if (s.Compression) setup["contextWindowCompression"] = new JsonObject { ["slidingWindow"] = new JsonObject() };

        if (s.Resumption)
        {
            var resumption = new JsonObject();
            if (!string.IsNullOrEmpty(s.ResumeHandle)) resumption["handle"] = s.ResumeHandle;
            setup["sessionResumption"] = resumption;
        }

        return setup;
    }

    private static string Normalize(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}
