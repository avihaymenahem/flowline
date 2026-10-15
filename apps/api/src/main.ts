import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { DisabledWorker, NdjsonWorkerClient, type WorkerClient } from "./worker.js";
import { resolveVisionPython } from "./pythonRuntime.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
try {
  const envContents = await readFile(path.join(rootDir, ".env"), "utf8");
  for (const line of envContents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

const python = resolveVisionPython(rootDir);
const script = path.resolve(rootDir, process.env.VISION_WORKER_SCRIPT ?? "apps/vision/worker.py");
const defaultModel = path.join(rootDir, "apps", "vision", "models", "object_detection_yolox_2022nov.onnx");
const modelPath = process.env.VISION_MODEL_PATH?.trim() || (existsSync(defaultModel) ? defaultModel : undefined);
let worker: WorkerClient = new DisabledWorker();
if (python) worker = new NdjsonWorkerClient({ python, script, cwd: rootDir });

const app = createApp({
  worker,
  dataDir: path.resolve(rootDir, process.env.API_DATA_DIR ?? "./data"),
  uploadDir: path.resolve(rootDir, process.env.API_UPLOAD_DIR ?? "./uploads"),
  ...(modelPath ? { visionModelPath: path.resolve(rootDir, modelPath) } : {})
});
const host = process.env.API_HOST ?? "0.0.0.0";
const port = Number(process.env.API_PORT ?? 4100);
const uploadTimeoutMs = Number(process.env.API_UPLOAD_TIMEOUT_MS ?? 14_400_000);
if (!Number.isSafeInteger(uploadTimeoutMs) || uploadTimeoutMs < 60_000 || uploadTimeoutMs > 86_400_000) {
  throw new Error("API_UPLOAD_TIMEOUT_MS must be between 60000 and 86400000");
}
if (worker instanceof NdjsonWorkerClient && modelPath) {
  const sourceId = randomUUID();
  const sessionId = randomUUID();
  try {
    await worker.request("configure", { sourceId, sessionId, scene: { zones: [], countingLines: [] }, modelPath: path.resolve(rootDir, modelPath) });
    await worker.request("stop", { sourceId, sessionId });
  } catch { /* API still starts and reports the worker's exact unavailable detail. */ }
}
const server = createServer(app);
server.requestTimeout = uploadTimeoutMs;
server.headersTimeout = 60_000;
console.log(`Maximum video upload: ${Math.floor(Number(process.env.API_MAX_UPLOAD_MB ?? 4096))} MiB; request deadline: ${Math.round(uploadTimeoutMs / 60_000)} minutes`);
server.listen(port, host, () => console.log(`Traffic API listening at http://${host}:${port}`));

const shutdown = async () => {
  const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await serverClosed;
  await worker.close();
  await app.closeResources();
};
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
