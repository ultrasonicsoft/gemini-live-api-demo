namespace LiveDemo;

/// <summary>Loads the nearest .env file walking up from the working directory. Real environment variables win.</summary>
public static class DotEnv
{
    public static void Load()
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, ".env");
            if (File.Exists(path))
            {
                foreach (var raw in File.ReadAllLines(path))
                {
                    var line = raw.Trim();
                    if (line.Length == 0 || line.StartsWith('#')) continue;
                    var eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    var key = line[..eq].Trim();
                    var value = line[(eq + 1)..].Trim().Trim('"', '\'');
                    if (Environment.GetEnvironmentVariable(key) is null)
                        Environment.SetEnvironmentVariable(key, value);
                }
                return;
            }
            dir = dir.Parent;
        }
    }
}
