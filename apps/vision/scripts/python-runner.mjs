import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolvePythonExecutable } from "./python-runtime.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2];
const executable = resolvePythonExecutable(root, process.platform, process.env, existsSync);
const localPython = join(root, ".venv-worker", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const hasVenv = existsSync(localPython) || Boolean(process.env.VISION_PYTHON?.trim());
if (mode === "test" && !hasVenv && !process.env.VISION_PYTHON?.trim()) {
  console.error("Run the explicit vision setup first; tests require the local OpenCV/NumPy runtime.");
  process.exit(1);
}

const args = mode === "test"
  ? ["-m", "unittest", "discover", "-s", "tests", "-v"]
  : ["-m", "py_compile", "worker.py", "vision_core.py"];
const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", shell: false });
if (result.error) {
  console.error(`Could not start Python at ${executable}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
