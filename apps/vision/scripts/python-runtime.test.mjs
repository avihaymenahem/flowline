import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { resolvePythonExecutable } from "./python-runtime.mjs";

test("resolves the Mac venv and can fall back to an explicit environment", () => {
  const root = join("fixture", "vision");
  const expected = join(root, ".venv-worker", "bin/python");
  assert.equal(resolvePythonExecutable(root, "darwin", {}, (candidate) => candidate === expected), expected);
  assert.equal(resolvePythonExecutable(root, "darwin", { PYTHON: "/usr/local/bin/python3" }, () => false), "/usr/local/bin/python3");
});

test("resolves the Windows venv layout and keeps the py launcher fallback", () => {
  const root = join("fixture", "vision");
  const expected = join(root, ".venv-worker", "Scripts/python.exe");
  assert.equal(resolvePythonExecutable(root, "win32", {}, (candidate) => candidate === expected), expected);
  assert.equal(resolvePythonExecutable(root, "win32", {}, () => false), "py");
});

test("honors the documented interpreter override", () => {
  assert.equal(resolvePythonExecutable("fixture", "darwin", { VISION_PYTHON: "  /custom/python  " }, () => false), "/custom/python");
});

test("resolves a repository-relative override when Turbo runs from apps/vision", () => {
  const visionRoot = join("repo", "apps", "vision");
  const expected = join(visionRoot, ".venv-worker", "bin/python");
  assert.equal(resolvePythonExecutable(visionRoot, "darwin", { VISION_PYTHON: "apps/vision/.venv-worker/bin/python" }, (candidate) => candidate === expected), expected);
});
