import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolvePythonExecutable(root, platform, env = process.env, exists = undefined) {
  const override = env.VISION_PYTHON?.trim();
  if (override) {
    if (isAbsolute(override)) return override;
    const visionPrefix = /^apps[\\/]vision[\\/]/i;
    const candidates = [
      join(root, override),
      ...(visionPrefix.test(override) ? [join(root, override.replace(visionPrefix, ""))] : [])
    ];
    return candidates.find((candidate) => (exists ?? existsSync)(candidate)) ?? candidates[0];
  }

  const localPython = join(root, ".venv-worker", platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if ((exists ?? existsSync)(localPython)) {
    return localPython;
  }
  return env.PYTHON?.trim() || (platform === "win32" ? "py" : "python3");
}
