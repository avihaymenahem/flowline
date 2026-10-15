import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AnalysisEvent } from "@traffic/contracts";

export type WorkerCommand = "health" | "configure" | "start" | "process_frame" | "probe_youtube" | "analyze_upload" | "analyze_stream" | "analyze_youtube" | "extract_media_frame" | "stop" | "shutdown";
export type WorkerCapability = { available: boolean; detail: string };
export interface WorkerClient {
  capability(): WorkerCapability;
  request(command: WorkerCommand, payload?: Record<string, unknown>): Promise<unknown>;
  onEvent(listener: (event: unknown) => void): () => void;
  close(): Promise<void>;
}

export class WorkerUnavailableError extends Error {
  constructor(message = "Vision worker is unavailable") { super(message); this.name = "WorkerUnavailableError"; }
}

export class DisabledWorker implements WorkerClient {
  capability(): WorkerCapability { return { available: false, detail: "Vision worker is not configured. Sources can be managed, but analysis is unavailable." }; }
  async request(): Promise<never> { throw new WorkerUnavailableError(); }
  onEvent(): () => void { return () => undefined; }
  async close(): Promise<void> {}
}

type Pending = { command: WorkerCommand; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type WorkerOptions = { python: string; script: string; cwd: string; startupTimeoutMs?: number; requestTimeoutMs?: number; configureTimeoutMs?: number; probeTimeoutMs?: number; maxPending?: number };
type ModelIdentity = { backend: string; name: string; device: string; targetDevice?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeWorkerText(value: string): string {
  if (/https?:\/\/|googlevideo|videoplayback|(?:signature|sig|token|expire)=/i.test(value)) {
    return "Video stream failed. Check the source link and try again.";
  }
  return value.slice(0, 500);
}

function sanitizeWorkerEvent(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "job_error" || typeof value.message !== "string") return value;
  return { ...value, message: sanitizeWorkerText(value.message) };
}

/** Owns one long-lived worker process and communicates only through NDJSON pipes. */
export class NdjsonWorkerClient implements WorkerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events = new EventEmitter();
  private readonly pending = new Map<string, Pending>();
  private readonly startup: Promise<void>;
  private resolveStartup!: () => void;
  private rejectStartup!: (error: Error) => void;
  private readonly startupTimer: NodeJS.Timeout;
  private available = false;
  private readyReceived = false;
  private detail = "Starting vision worker.";
  private serial = Promise.resolve();
  private readonly maxPending: number;
  private readonly requestTimeoutMs: number;
  private readonly configureTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private modelIdentity: ModelIdentity | undefined;

  constructor(options: WorkerOptions) {
    this.maxPending = options.maxPending ?? 16;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    // Loading large local detector checkpoints can be slow on a cold process.
    // Keep the longer bound limited to configuration; frames and commands retain
    // the normal request deadline.
    this.configureTimeoutMs = options.configureTimeoutMs ?? 90_000;
    // A YouTube preflight has bounded resolver (12s) and FFmpeg open/read (10s/8s) deadlines.
    this.probeTimeoutMs = options.probeTimeoutMs ?? 55_000;
    this.startup = new Promise<void>((resolve, reject) => { this.resolveStartup = resolve; this.rejectStartup = reject; });
    this.startup.catch(() => undefined);
    this.child = spawn(options.python, [options.script], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    this.child.once("error", (error) => { this.detail = error.message; this.rejectStartup(error); });
    this.child.once("exit", (code) => {
      const error = new WorkerUnavailableError(`Vision worker exited (${code ?? "signal"})`);
      this.available = false; this.detail = error.message;
      for (const [, request] of this.pending) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear(); this.rejectStartup(error);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // Model libraries can log warnings during inference. Preserve the verified
      // configured model identity while healthy. Native FFmpeg diagnostics can
      // contain signed CDN URLs, so never copy stderr text into API-visible state.
      if (chunk.length && !this.available) this.detail = "Vision worker reported a diagnostic message; source details are withheld.";
    });
    // A readiness message is parsed asynchronously after the constructor returns.
    this.startupTimer = setTimeout(() => { this.available = false; this.detail = "Vision worker did not report readiness."; this.rejectStartup(new WorkerUnavailableError(this.detail)); }, options.startupTimeoutMs ?? 8_000);
    this.startup.then(() => clearTimeout(this.startupTimer), () => clearTimeout(this.startupTimer));
  }
  private handleLine(line: string): void {
    if (Buffer.byteLength(line) > 1_000_000) { this.detail = "Worker sent an oversized message."; return; }
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; }
    catch { this.detail = "Worker sent invalid JSON."; return; }
    if (message.type === "ready") {
      this.readyReceived = true;
      this.available = message.available === true;
      this.detail = typeof message.detail === "string" ? message.detail : "Worker ready.";
      this.resolveStartup();
      return;
    }
    if (message.type === "event") {
      const safeEvent = sanitizeWorkerEvent(message.event);
      this.updateModelIdentityFromEvent(safeEvent);
      this.events.emit("event", safeEvent);
      return;
    }
    if (message.type !== "response" || typeof message.requestId !== "string") return;
    const request = this.pending.get(message.requestId);
    if (!request) return;
    this.pending.delete(message.requestId); clearTimeout(request.timer);
    if (message.ok === true) {
      if (request.command === "configure") {
        this.available = true;
        this.modelIdentity = this.modelFromResponse(message.result) ?? undefined;
        this.detail = this.modelIdentity ? this.modelDetail(this.modelIdentity) : "Local vision model loaded and ready.";
      }
      request.resolve(message.result);
    } else {
      const error = typeof message.error === "string" ? sanitizeWorkerText(message.error) : "Worker request failed";
      if (request.command === "configure") { this.available = false; this.detail = error; }
      request.reject(new Error(error));
    }
  }

  private modelFromResponse(value: unknown): ModelIdentity | null {
    if (!isRecord(value) || !isRecord(value.model)) return null;
    const { backend, name, device, targetDevice } = value.model;
    if (typeof backend !== "string" || typeof name !== "string" || typeof device !== "string") return null;
    return { backend, name, device, ...(typeof targetDevice === "string" ? { targetDevice } : {}) };
  }

  private modelDetail(model: ModelIdentity): string {
    const formatDevice = (device: string) => {
      if (/^cuda(?::\d+)?$/i.test(device)) return `GPU (${device})`;
      if (/^cpu$/i.test(device)) return "CPU";
      return device;
    };
    const target = model.targetDevice && model.targetDevice !== model.device
      ? `; inference target ${formatDevice(model.targetDevice)}`
      : "";
    return `${model.name} · actual ${formatDevice(model.device)}${target}`;
  }

  private updateModelIdentityFromEvent(value: unknown): void {
    if (!isRecord(value) || !isRecord(value.quality) || !Array.isArray(value.quality.notes)) return;
    for (const note of value.quality.notes) {
      if (typeof note !== "string") continue;
      const backend = note.match(/(?:^|;)detector_backend=([^;]+)/)?.[1];
      const name = note.match(/(?:^|;)detector_model=([^;]+)/)?.[1];
      const device = note.match(/(?:^|;)detector_device=([^;]+)/)?.[1];
      if (!backend || !name || !device) continue;
      this.modelIdentity = { backend, name, device };
      this.detail = this.modelDetail(this.modelIdentity);
      return;
    }
  }

  capability(): WorkerCapability { return { available: this.available, detail: this.detail }; }
  onEvent(listener: (event: unknown) => void): () => void { this.events.on("event", listener); return () => this.events.off("event", listener); }

  async request(command: WorkerCommand, payload?: Record<string, unknown>): Promise<unknown> {
    await this.startup;
    if (!this.available && command !== "configure" && command !== "health") throw new WorkerUnavailableError(this.detail);
    if (this.pending.size >= this.maxPending) throw new Error("Vision worker queue is full; try again shortly");
    const requestId = randomUUID();
    const line = `${JSON.stringify({ requestId, command, ...(payload ? { payload } : {}) })}\n`;
    const execute = () => new Promise<unknown>((resolve, reject) => {
      const timeoutMs = command === "configure" ? this.configureTimeoutMs : command === "probe_youtube" ? this.probeTimeoutMs : this.requestTimeoutMs;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error(`Worker ${command} request timed out`)); }, timeoutMs);
      this.pending.set(requestId, { command, resolve, reject, timer });
      this.child.stdin.write(line, (error) => {
        if (error) { const pending = this.pending.get(requestId); if (pending) { clearTimeout(pending.timer); this.pending.delete(requestId); pending.reject(error); } }
      });
    });
    const result = this.serial.then(execute, execute);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    let acknowledged = false;
    try { await this.request("shutdown"); acknowledged = true; }
    catch { /* process may already be gone or failed to acknowledge shutdown */ }
    if (!acknowledged || this.child.exitCode !== null || this.child.signalCode !== null) {
      if (!this.child.killed) this.child.kill();
      return;
    }
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.child.off("exit", finish);
        if (!this.child.killed) this.child.kill();
        resolve();
      }, 15_000);
      this.child.once("exit", finish);
      if (this.child.exitCode !== null || this.child.signalCode !== null) finish();
    });
  }
}
