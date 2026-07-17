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
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){Write-Output $d.SelectedPath}";
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], { timeout: 120_000 });
      return stdout.trim() || null;
    } catch { return null; }
  }
  for (const [command, args] of [["zenity", ["--file-selection", "--directory"]], ["kdialog", ["--getexistingdirectory"]]] as const) {
    try {
      const { stdout } = await execFileAsync(command, [...args], { timeout: 120_000 });
      return stdout.trim() || null;
    } catch { /* try next picker */ }
  }
  return null;
}

export async function revealDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", directoryPath]);
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("explorer.exe", [directoryPath]);
    return;
  }
  await execFileAsync("xdg-open", [directoryPath]);
}
