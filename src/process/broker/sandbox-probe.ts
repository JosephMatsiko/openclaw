import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type SandboxRuntime =
  | "docker-desktop"
  | "orbstack"
  | "colima"
  | "rancher-desktop"
  | "docker";

export type SandboxProbeResult = {
  available: boolean;
  runtime?: SandboxRuntime;
  socketPath?: string;
};

// Socket paths to probe in preference order per platform.
function getCandidates(home: string): Array<{ runtime: SandboxRuntime; socketPath: string }> {
  const platform = process.platform;
  if (platform === "darwin") {
    return [
      // OrbStack registers its socket at a well-known user path.
      { runtime: "orbstack", socketPath: path.join(home, ".orbstack", "run", "docker.sock") },
      // Docker Desktop canonical socket (symlinked from /var/run/docker.sock on newer versions).
      { runtime: "docker-desktop", socketPath: "/var/run/docker.sock" },
      // Private var symlink on macOS.
      { runtime: "docker-desktop", socketPath: "/private/var/run/docker.sock" },
      // Colima default profile.
      { runtime: "colima", socketPath: path.join(home, ".colima", "default", "docker.sock") },
      // Rancher Desktop (nerdctl/containerd).
      { runtime: "rancher-desktop", socketPath: path.join(home, ".rd", "docker.sock") },
    ];
  }
  // Linux
  return [
    { runtime: "docker", socketPath: "/run/docker.sock" },
    { runtime: "docker", socketPath: "/var/run/docker.sock" },
  ];
}

function isSocket(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isSocket();
  } catch {
    return false;
  }
}

// Cache result for the lifetime of this process — Docker doesn't disappear mid-run.
let _cachedResult: SandboxProbeResult | null = null;

export function probeSandboxRuntime(options?: { bypassCache?: boolean }): SandboxProbeResult {
  if (_cachedResult && !options?.bypassCache) {
    return _cachedResult;
  }
  const home = process.env.HOME ?? os.homedir();
  for (const { runtime, socketPath } of getCandidates(home)) {
    if (isSocket(socketPath)) {
      _cachedResult = { available: true, runtime, socketPath };
      return _cachedResult;
    }
  }
  _cachedResult = { available: false };
  return _cachedResult;
}

export function formatSandboxUnavailableMessage(platform: string = process.platform): string {
  if (platform === "darwin") {
    return (
      "exec broker: sandbox runtime unavailable (security mode requires Docker or OrbStack). " +
      "Install Docker Desktop (https://docs.docker.com/desktop/mac/) or OrbStack (https://orbstack.dev) " +
      "and run: pnpm openclaw sandbox setup"
    );
  }
  return (
    "exec broker: sandbox runtime unavailable (security mode requires Docker). " +
    "Install Docker and run: pnpm openclaw sandbox setup"
  );
}
