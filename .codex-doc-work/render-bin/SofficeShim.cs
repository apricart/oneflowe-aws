using System;
using System.Diagnostics;
using System.IO;
using System.Text;

public static class SofficeShim
{
    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    public static int Main(string[] args)
    {
        string executablePath = Process.GetCurrentProcess().MainModule.FileName;
        string scriptPath = Path.Combine(Path.GetDirectoryName(executablePath), "soffice-shim.ps1");
        var arguments = new StringBuilder();
        arguments.Append("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ");
        arguments.Append(Quote(scriptPath));
        foreach (string arg in args)
        {
            arguments.Append(' ');
            arguments.Append(Quote(arg));
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = arguments.ToString(),
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using (Process process = Process.Start(startInfo))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }
}
