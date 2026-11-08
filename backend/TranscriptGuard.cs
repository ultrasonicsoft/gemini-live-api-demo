using System.Text.RegularExpressions;

namespace LiveDemo;

/// <summary>
/// A deliberately simple second line of defence. It runs on transcripts, so for speech it always acts
/// after the model has heard the words. The prompt has to hold on its own: this only catches and logs.
/// </summary>
public static partial class TranscriptGuard
{
    [GeneratedRegex(@"ignore\s+(all\s+|any\s+)?(your\s+|the\s+|my\s+|previous\s+|prior\s+|above\s+)+(instructions?|rules?|prompts?)|(system|your)\s+(prompt|instructions)|you\s+are\s+now\b|pretend\s+(to\s+be|you\s+are)|developer\s+mode|jailbreak|repeat\s+(the\s+|your\s+)?(words\s+)?(above|instructions|prompt)", RegexOptions.IgnoreCase)]
    private static partial Regex InputAttack();

    [GeneratedRegex(@"canary|7741|seven\s+seven\s+four\s+one|555[\s-]*0142|example(\.|\s+dot\s+)com|my\s+(system\s+)?(instructions|prompt)\s+(say|are|is|tell)", RegexOptions.IgnoreCase)]
    private static partial Regex OutputLeak();

    public static string? CheckInput(string text) => InputAttack().Match(text) is { Success: true } m ? m.Value : null;
    public static string? CheckOutput(string text) => OutputLeak().Match(text) is { Success: true } m ? m.Value : null;
}
