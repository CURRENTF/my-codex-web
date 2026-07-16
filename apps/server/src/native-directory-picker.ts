import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function pickDirectory(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("osascript", [
        "-e", "POSIX path of (choose folder with prompt \"Choose a Codex Web project\")",
      ], { timeout: 120_000 });
      return stdout.trim().replace(/\/$/, "") || null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("User canceled") || message.includes("-128")) return null;
      throw error;
    }
  }
  if (process.platform === "win32") {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}";
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], { timeout: 120_000 });
    return stdout.trim() || null;
  }
  for (const [command, args] of [["zenity", ["--file-selection", "--directory"]], ["kdialog", ["--getexistingdirectory"]]] as const) {
    try {
      const { stdout } = await execFileAsync(command, [...args], { timeout: 120_000 });
      return stdout.trim() || null;
    } catch { /* try next picker */ }
  }
  return null;
}
