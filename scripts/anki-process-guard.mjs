import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

export function isAnkiProcess(processInfo) {
  const name = String(
    processInfo?.Name ?? processInfo?.name ?? "",
  ).toLowerCase();
  const commandLine = String(
    processInfo?.CommandLine ?? processInfo?.commandLine ?? "",
  );
  const normalizedCommandLine = commandLine.replaceAll("/", "\\");

  return (
    name === "anki.exe" ||
    name === "ankiw.exe" ||
    ((name === "python.exe" || name === "pythonw.exe") &&
      (/\\scripts\\ankiw?\.exe\b/iu.test(normalizedCommandLine) ||
        /\bimport\s+aqt\b/iu.test(commandLine)))
  );
}

export function activeAnkiProcessCount() {
  const listing = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        "$processes = @(Get-CimInstance Win32_Process | Select-Object Name, CommandLine)",
        "ConvertTo-Json -Compress -InputObject $processes",
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
  if (listing.error || listing.status !== 0) {
    throw new Error(
      `Could not inspect Anki processes: ${
        listing.error?.message ?? listing.stderr.trim()
      }`,
    );
  }

  let processes;
  try {
    const parsed = JSON.parse(listing.stdout.trim() || "[]");
    processes = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("Could not parse the active process list");
  }
  return processes.filter(isAnkiProcess).length;
}

export async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}
