import path from "node:path";
import { existsSync } from "node:fs";

type RuntimePlatform = NodeJS.Platform;
type Exists = (candidate: string) => boolean;

/** Find the local vision interpreter without assuming a Windows venv layout. */
export function resolveVisionPython(
  rootDir: string,
  platform: RuntimePlatform = process.platform,
  configuredPython = process.env.VISION_PYTHON,
  exists: Exists = existsSync
): string | undefined {
  const override = configuredPython?.trim();
  if (override) {
    if (path.isAbsolute(override)) return override;
    const candidates = [path.resolve(rootDir, override), path.resolve(rootDir, "apps", "vision", override)];
    return candidates.find(exists) ?? candidates[0];
  }

  const executable = platform === "win32"
    ? path.join("Scripts", "python.exe")
    : path.join("bin", "python");
  return [".venv-worker", ".venv"]
    .map((environment) => path.join(rootDir, "apps", "vision", environment, executable))
    .find(exists);
}
