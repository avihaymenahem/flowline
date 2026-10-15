import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
if (process.platform !== "darwin") {
  console.error("npm run setup:mac runs only on macOS. Use npm run setup:vision on Windows.");
  process.exit(2);
}
if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`Node.js 22 or newer is required for YouTube source support; found ${process.versions.node}.`);
  process.exit(2);
}

function supportedPython(command) {
  const result = spawnSync(command, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false,
  });
  if (result.status !== 0) return false;
  return ["3.13", "3.12"].includes(result.stdout.trim());
}

const python = ["python3.13", "python3.12", "python3"].find(supportedPython);
if (!python) {
  console.error("Python 3.12 or 3.13 was not found. Install it from python.org or your preferred package manager, then retry.");
  process.exit(2);
}
console.log(`Using ${python} for the isolated local vision runtime.`);
const result = spawnSync(python, [join(repo, "apps", "vision", "setup_mac.py")], {
  cwd: repo, stdio: "inherit", shell: false,
});
if (result.error) {
  console.error(`Could not start ${python}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
