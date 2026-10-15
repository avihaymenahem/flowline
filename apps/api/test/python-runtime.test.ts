import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveVisionPython } from "../src/pythonRuntime.js";

test("discovers a macOS virtual environment and falls back to the legacy environment", () => {
  const root = path.resolve("fixture-root");
  const expected = path.join(root, "apps", "vision", ".venv", "bin", "python");
  const result = resolveVisionPython(root, "darwin", "", (candidate) => candidate === expected);
  assert.equal(result, expected);
});

test("discovers the Windows virtual environment layout", () => {
  const root = path.resolve("fixture-root");
  const expected = path.join(root, "apps", "vision", ".venv-worker", "Scripts", "python.exe");
  const result = resolveVisionPython(root, "win32", "", (candidate) => candidate === expected);
  assert.equal(result, expected);
});

test("uses an explicit interpreter override before local discovery", () => {
  assert.equal(resolveVisionPython("fixture-root", "darwin", "  custom/python  ", () => false), path.resolve("fixture-root", "custom/python"));
  const appRelative = path.resolve("fixture-root", "apps", "vision", ".venv-worker/bin/python");
  assert.equal(resolveVisionPython("fixture-root", "darwin", ".venv-worker/bin/python", (candidate) => candidate === appRelative), appRelative);
});
