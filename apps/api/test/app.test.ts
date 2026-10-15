import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import request from "supertest";
import { sceneGeometrySignature, type AnalysisEvent, type DetectionFeedback, type Scene, type Source, type SourceFolder } from "@traffic/contracts";
import { createApp as createTrafficApp } from "../src/app.js";
import { canonicalizeOffsetDateTime } from "../src/mediaMetadata.js";
import { buildSummary, DiskSourceRepository, type SourceAggregate, type SourceRepository } from "../src/repository.js";
import { DisabledWorker, NdjsonWorkerClient, type WorkerClient, type WorkerCommand } from "../src/worker.js";

class MemoryRepository implements SourceRepository {
  sources = new Map<string, Source>(); folders: SourceFolder[] = []; scenes = new Map<string, Scene>(); events = new Map<string, AnalysisEvent[]>(); assets = new Map<string, string>(); uploadKeys = new Map<string, string>();
  feedbackReports = new Map<string, DetectionFeedback>();
  async listSources() { return [...this.sources.values()]; }
  async getLibrarySnapshot() { return { sources: [...this.sources.values()].map((source) => structuredClone(source)), folders: structuredClone(this.folders) }; }
  private folderSnapshot() { return this.getLibrarySnapshot(); }
  async createSourceFolder(folder: SourceFolder) { this.folders.push(structuredClone(folder)); return this.folderSnapshot(); }
  async renameSourceFolder(id: string, name: string) { const folder = this.folders.find((item) => item.id === id); if (!folder) throw new Error("Folder not found"); folder.name = name; return this.folderSnapshot(); }
  async deleteSourceFolder(id: string) { this.folders = this.folders.filter((item) => item.id !== id); for (const source of this.sources.values()) if (source.folderId === id) delete source.folderId; return this.folderSnapshot(); }
  async organizeSource(id: string, folderId: string | null, beforeSourceId?: string | null) {
    const source = this.sources.get(id); if (!source) throw new Error("Source not found");
    const rows = [...this.sources.values()]; this.sources.delete(id);
    if (folderId === null) delete source.folderId; else source.folderId = folderId;
    const index = beforeSourceId ? rows.findIndex((item) => item.id === beforeSourceId) : -1;
    rows.splice(index < 0 ? rows.length : index, 0, source);
    this.sources = new Map(rows.map((item) => [item.id, item]));
    return this.folderSnapshot();
  }
  async getSource(id: string) { return this.sources.get(id); }
  async putSource(source: Source) {
    const current = this.sources.get(source.id);
    if (!current) { this.sources.set(source.id, structuredClone(source)); return; }
    const merged: Source = { ...source, name: current.name };
    if (current.location === undefined) delete merged.location;
    else merged.location = structuredClone(current.location);
    if (current.folderId === undefined) delete merged.folderId;
    else merged.folderId = current.folderId;
    this.sources.set(source.id, structuredClone(merged));
  }
  async setLocation(id: string, location: Source["location"] | undefined) {
    const current = this.sources.get(id);
    if (!current) return undefined;
    const updated: Source = { ...current };
    if (location === undefined) delete updated.location;
    else updated.location = structuredClone(location);
    this.sources.set(id, structuredClone(updated));
    return structuredClone(updated);
  }
  async renameSource(id: string, name: string) {
    const current = this.sources.get(id);
    if (!current) return undefined;
    const updated = { ...current, name };
    this.sources.set(id, structuredClone(updated));
    return structuredClone(updated);
  }
  async deleteSource(id: string) { this.sources.delete(id); this.scenes.delete(id); this.events.delete(id); this.assets.delete(id); for (const [key, sourceId] of this.uploadKeys) if (sourceId === id) this.uploadKeys.delete(key); for (const [key, report] of this.feedbackReports) if (report.sourceId === id) this.feedbackReports.delete(key); }
  async getScene(id: string) { return this.scenes.get(id) ?? { zones: [], countingLines: [] }; }
  async putScene(id: string, scene: Scene) { this.scenes.set(id, structuredClone(scene)); }
  async appendEvent(id: string, event: AnalysisEvent) { const events = this.events.get(id) ?? []; if (!events.some((old) => old.id === event.id)) events.push(event); this.events.set(id, events); }
  async getEvents(id: string) { return this.events.get(id) ?? []; }
  async listFeedbackReports(sourceId: string) { return [...this.feedbackReports.values()].filter((report) => report.sourceId === sourceId).map((report) => structuredClone(report)); }
  async getFeedbackReport(sourceId: string, reportId: string) { const report = this.feedbackReports.get(reportId); return report?.sourceId === sourceId ? structuredClone(report) : undefined; }
  async putFeedbackReport(report: DetectionFeedback) { this.feedbackReports.set(report.id, structuredClone(report)); }
  async getAssetPath(id: string) { return this.assets.get(id); }
  async setAssetPath(id: string, assetPath: string) { this.assets.set(id, assetPath); }
  async commitUpload(source: Source, assetPath: string, idempotencyKey?: string) {
    const existingId = idempotencyKey ? this.uploadKeys.get(idempotencyKey) : undefined;
    const existing = existingId ? this.sources.get(existingId) : undefined;
    if (existing) return { source: structuredClone(existing), created: false };
    this.sources.set(source.id, structuredClone(source)); this.assets.set(source.id, assetPath);
    if (idempotencyKey) this.uploadKeys.set(idempotencyKey, source.id);
    return { source: structuredClone(source), created: true };
  }
  async getAggregate(_id: string, sessionId?: string): Promise<SourceAggregate> { return { latestSession: undefined, ...(sessionId ? { requestedSessionId: sessionId } : {}), historyTruncated: false }; }
}

class SlowAppendRepository extends MemoryRepository {
  async appendEvent(id: string, event: AnalysisEvent) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await super.appendEvent(id, event);
  }
}

class StubWorker implements WorkerClient {
  available = true; delayMs = 0; calls: Array<{ command: WorkerCommand; payload?: Record<string, unknown> }> = []; listeners = new Set<(event: unknown) => void>(); scenes = new Map<string, Scene>();
  capability() { return { available: this.available, detail: this.available ? "Test detector ready" : "Test detector unavailable" }; }
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.calls.push({ command, ...(payload ? { payload } : {}) });
    if (command === "configure" && payload && typeof payload.sourceId === "string" && typeof payload.sessionId === "string" && payload.scene) {
      this.scenes.set(`${payload.sourceId}:${payload.sessionId}`, structuredClone(payload.scene as Scene));
    }
    if (command === "process_frame" && payload) {
      const scene = this.scenes.get(`${payload.sourceId}:${payload.sessionId}`) ?? { zones: [], countingLines: [] };
      const analysisContext = { settingsCaptured: true, detector: { backend: "stub", modelName: "Test detector", device: "cpu" }, sampling: { sampleEveryMs: 500 }, tracker: { backend: "StubTracker" },
        scene: { geometrySignature: sceneGeometrySignature(scene), snapshot: scene } };
      const event = { sourceId: payload.sourceId, sessionId: payload.sessionId, sourceTimeMs: payload.sourceTimeMs, frameWidth: 640, frameHeight: 480, ...(typeof payload.frameId === "string" ? { frameId: payload.frameId } : {}), detections: [{ bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 }, class: "car", confidence: 0.95, trackId: "track-1" }], crossings: [{ lineId: "line-a", direction: "A to B", trackId: "track-1" }], quality: { coverage: "known", notes: [] }, analysisContext };
      for (const listener of this.listeners) listener(event);
    }
    return { accepted: true };
  }
  emit(event: unknown) { for (const listener of this.listeners) listener(event); }
  onEvent(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close() {}
}

class YoutubeStubWorker extends StubWorker {
  failVideoId?: string;
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    const result = await super.request(command, payload);
    if (command !== "probe_youtube" || !payload) return result;
    if (typeof payload.url === "string" && this.failVideoId && payload.url.includes(this.failVideoId)) {
      throw new Error("YouTube could not provide a playable video for this link.");
    }
    const sessionId = String(payload.sessionId);
    const sourceId = String(payload.sourceId);
    const frameId = randomUUID();
    const previewDir = String(payload.previewDir);
    const frameDir = path.join(previewDir, sourceId, sessionId);
    await mkdir(frameDir, { recursive: true });
    await writeFile(path.join(frameDir, `${frameId}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    return { sourceId, sessionId, sourceTimeMs: 0, frameId, width: 1280, height: 720, sourceWidth: 1920, sourceHeight: 1080,
      videoId: payload.url === "https://www.youtube.com/watch?v=1H0iTzv2jiQ" ? "1H0iTzv2jiQ" : "1EiC9bvVGnk",
      title: "Public YouTube live source", isLive: true, liveStatus: "is_live",
      media_url: "https://rr.googlevideo.com/videoplayback?signature=never-persist-this" };
  }
  async writeAndEmitPreview(payload: Record<string, unknown>, sourceTimeMs: number) {
    const sourceId = String(payload.sourceId); const sessionId = String(payload.sessionId);
    const frameId = randomUUID(); const previewDir = String(payload.previewDir);
    const frameDir = path.join(previewDir, sourceId, sessionId);
    await mkdir(frameDir, { recursive: true });
    await writeFile(path.join(frameDir, `${frameId}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    this.emit({ id: randomUUID(), sourceId, sessionId, sourceTimeMs,
      frameWidth: 1920, frameHeight: 1080, detections: [], crossings: [], quality: { coverage: "known", notes: [] } });
    this.emit({ type: "preview_frame", sourceId, sessionId, sourceTimeMs, frameId, width: 1280, height: 720 });
    return { sourceId, sessionId, sourceTimeMs, frameId, width: 1280, height: 720 };
  }
}

class GatedYoutubeProbeWorker extends YoutubeStubWorker {
  private probeStartedResolve?: () => void;
  private releaseProbeResolve?: () => void;
  private probeRelease?: Promise<void>;
  armProbeGate() {
    const probeStarted = new Promise<void>((resolve) => { this.probeStartedResolve = resolve; });
    this.probeRelease = new Promise<void>((resolve) => { this.releaseProbeResolve = resolve; });
    return { probeStarted, release: () => this.releaseProbeResolve?.() };
  }
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    if (command === "probe_youtube" && this.probeRelease) {
      const release = this.probeRelease;
      this.probeRelease = undefined;
      this.probeStartedResolve?.();
      await release;
    }
    return super.request(command, payload);
  }
}

class GatedStopWorker extends StubWorker {
  private stopStartedResolve?: () => void;
  private releaseStopResolve?: () => void;
  private stopRelease?: Promise<void>;
  armStopGate() {
    const stopStarted = new Promise<void>((resolve) => { this.stopStartedResolve = resolve; });
    this.stopRelease = new Promise<void>((resolve) => { this.releaseStopResolve = resolve; });
    return { stopStarted, release: () => this.releaseStopResolve?.() };
  }
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    if (command === "stop" && this.stopRelease) {
      const release = this.stopRelease;
      this.stopRelease = undefined;
      this.stopStartedResolve?.();
      await release;
    }
    return super.request(command, payload);
  }
}

class GatedStartWorker extends StubWorker {
  private startStartedResolve?: () => void;
  private releaseStartResolve?: () => void;
  private startRelease?: Promise<void>;
  armStartGate() {
    const startStarted = new Promise<void>((resolve) => { this.startStartedResolve = resolve; });
    this.startRelease = new Promise<void>((resolve) => { this.releaseStartResolve = resolve; });
    return { startStarted, release: () => this.releaseStartResolve?.() };
  }
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    if (command === "start" && this.startRelease) {
      const release = this.startRelease;
      this.startRelease = undefined;
      this.startStartedResolve?.();
      await release;
    }
    return super.request(command, payload);
  }
}

class FailFirstConfigureWorker extends StubWorker {
  private failFirst = true;
  async request(command: WorkerCommand, payload?: Record<string, unknown>) {
    if (command === "configure" && this.failFirst) {
      this.failFirst = false;
      throw new Error("fixture configure failure");
    }
    return super.request(command, payload);
  }
}

const tempDirs: string[] = [];
const createdApps: Array<{ closeResources(): Promise<void> }> = [];
const createApp = (options: Parameters<typeof createTrafficApp>[0]) => {
  const app = createTrafficApp(options);
  createdApps.push(app);
  return app;
};
afterEach(async () => {
  await Promise.all(createdApps.splice(0).map((app) => app.closeResources()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const appFor = async (worker: WorkerClient, options: { maxUploadBytes?: number; onInvalidWorkerEvent?: (paths: string[]) => void; additionalCorsOrigins?: string[] } = {}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-test-")); tempDirs.push(dir);
  return { app: createApp({ repository: new MemoryRepository(), worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), ...options }), dir };
};

it("allows only explicitly configured extra dashboard origins", async () => {
  const { app } = await appFor(new StubWorker(), { additionalCorsOrigins: ["http://127.0.0.1:5174"] });
  const allowed = await request(app).get("/api/health").set("Origin", "http://127.0.0.1:5174").expect(200);
  assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:5174");
  const rejected = await request(app).get("/api/health").set("Origin", "http://127.0.0.1:7777").expect(200);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
});

const mp4Atom = (type: string, payload: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, payload.length + 8]), Buffer.from(type, "ascii"), payload]);
function mp4FixtureWithMovieHeader(movieHeader: Buffer) {
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(1920 * 65_536, trackHeader.length - 8);
  trackHeader.writeUInt32BE(1080 * 65_536, trackHeader.length - 4);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8, "ascii");
  const ftyp = mp4Atom("ftyp", Buffer.from("mp42\0\0\0\0isommp42", "ascii"));
  const mediaData = mp4Atom("mdat", Buffer.alloc(24));
  const movie = mp4Atom("moov", Buffer.concat([
    mp4Atom("mvhd", movieHeader),
    mp4Atom("trak", Buffer.concat([mp4Atom("tkhd", trackHeader), mp4Atom("mdia", mp4Atom("hdlr", handler))]))
  ]));
  return Buffer.concat([ftyp, mediaData, movie]);
}
function mp4MetadataFixture(creationTimeSeconds1904: number) {
  const movieHeader = Buffer.alloc(20);
  movieHeader.writeUInt32BE(creationTimeSeconds1904, 4);
  movieHeader.writeUInt32BE(1_000, 12);
  movieHeader.writeUInt32BE(181_053, 16);
  return mp4FixtureWithMovieHeader(movieHeader);
}
function mp4VersionOneOverflowFixture() {
  const movieHeader = Buffer.alloc(32);
  movieHeader.writeUInt8(1, 0);
  movieHeader.writeBigUInt64BE(8_700_000_000_000n, 4);
  movieHeader.writeUInt32BE(1_000, 20);
  movieHeader.writeBigUInt64BE(181_053n, 24);
  return mp4FixtureWithMovieHeader(movieHeader);
}

describe("local traffic API", () => {
  it("renames only the display name, persists it, and preserves a later stale lifecycle write", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-source-rename-")); tempDirs.push(dir);
    const sourceId = randomUUID();
    const sessionId = randomUUID();
    const source: Source = {
      id: sourceId, name: "Original name", kind: "youtube", status: "running", createdAt: new Date(0).toISOString(),
      url: "https://www.youtube.com/watch?v=1EiC9bvVGnk",
      youtube: { videoId: "1EiC9bvVGnk", title: "Camera title", isLive: true, liveStatus: "is_live" }, width: 1920, height: 1080
    };
    const scene: Scene = {
      zones: [{ id: "zone-1", name: "Crosswalk", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.8 }] }],
      countingLines: [{ id: "line-1", name: "Main road", start: { x: 0.2, y: 0.6 }, end: { x: 0.8, y: 0.6 }, directionLabels: ["Inbound", "Outbound"] }]
    };
    const event: AnalysisEvent = {
      id: randomUUID(), sourceId, sessionId, sourceTimeMs: 1000, frameWidth: 1280, frameHeight: 720,
      type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] }
    };
    const repository = new DiskSourceRepository(dir);
    await repository.putSource({ ...source, status: "idle" });
    await repository.putScene(sourceId, scene);
    await repository.setAssetPath(sourceId, path.join(dir, "source.mp4"));
    await repository.appendEvent(sourceId, event);
    const app = createTrafficApp({ repository, dataDir: dir, uploadDir: path.join(dir, "uploads"), worker: new StubWorker() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repository.putSource(source);
    const staleLifecycleSnapshot = await repository.getSource(sourceId);

    const response = await request(app).patch(`/api/sources/${sourceId}`).send({ name: "  Downtown camera  " }).expect(200);
    assert.equal(response.body.source.name, "Downtown camera");
    assert.equal(response.body.source.status, "running", "rename must preserve the active lifecycle status");
    assert.equal(response.body.source.id, source.id);
    assert.equal(response.body.source.url, source.url);
    assert.deepEqual(response.body.source.youtube, source.youtube);
    assert.equal(response.body.source.width, source.width);
    assert.equal(response.body.source.height, source.height);

    assert.ok(staleLifecycleSnapshot);
    await repository.putSource({ ...staleLifecycleSnapshot!, status: "completed" });
    const reopened = new DiskSourceRepository(dir);
    const persisted = await reopened.getSource(sourceId);
    assert.equal(persisted?.name, "Downtown camera", "a queued whole-source lifecycle write cannot revert a newer name");
    assert.equal(persisted?.status, "completed", "the lifecycle update itself must still be applied");
    assert.deepEqual(await reopened.getScene(sourceId), scene);
    assert.deepEqual(await reopened.getEvents(sourceId), [event]);
    assert.equal(await reopened.getAssetPath(sourceId), path.join(dir, "source.mp4"));
    assert.deepEqual(persisted?.youtube, source.youtube);
    assert.equal(persisted?.url, source.url);
    assert.equal(persisted?.width, source.width);
    assert.equal(persisted?.height, source.height);
  });

  it("rejects malformed rename payloads and reports missing sources", async () => {
    const repository = new MemoryRepository();
    const app = createTrafficApp({ repository, worker: new StubWorker() });
    const source: Source = { id: randomUUID(), name: "Keep me", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    const invalidBodies: unknown[] = [null, [], {}, { name: " \t " }, { name: "x".repeat(121) }, { name: 7 }, { name: "Valid", status: "running" }];
    for (const body of invalidBodies) {
      await request(app).patch(`/api/sources/${source.id}`).send(body).expect(400);
    }
    await request(app).patch(`/api/sources/${randomUUID()}`).send({ name: "Missing target" }).expect(404);
    assert.deepEqual(await repository.getSource(source.id), source);
  });

  it("retries persistence when the same renamed value is submitted after a failed disk replacement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-rename-retry-")); tempDirs.push(dir);
    let failNextRename = false;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (failNextRename) { failNextRename = false; throw Object.assign(new Error("fixture replacement failure"), { code: "EIO" }); }
        await rename(from, to);
      },
      onPersistenceError: () => undefined,
      renameRetryDelayMs: 0
    });
    const source: Source = { id: randomUUID(), name: "Before", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    failNextRename = true;
    await assert.rejects(repository.renameSource(source.id, "After"), /fixture replacement failure/);
    await repository.renameSource(source.id, "After");
    assert.equal((await new DiskSourceRepository(dir).getSource(source.id))?.name, "After");
  });

  it("does not report success or recreate a source deleted while rename persistence is pending", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-rename-delete-race-")); tempDirs.push(dir);
    let blockRename = false;
    let startedResolve!: () => void;
    let releaseResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (blockRename) {
          blockRename = false;
          startedResolve();
          await held;
        }
        await rename(from, to);
      },
      renameRetryDelayMs: 0
    });
    const source: Source = { id: randomUUID(), name: "Before", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    blockRename = true;
    const pendingRename = repository.renameSource(source.id, "After");
    await started;
    const pendingDelete = repository.deleteSource(source.id);
    for (let attempt = 0; attempt < 20 && await repository.getSource(source.id); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(await repository.getSource(source.id), undefined, "delete removes the in-memory record before waiting for its disk write");
    releaseResolve();
    const [renamed] = await Promise.all([pendingRename, pendingDelete]);
    assert.equal(renamed, undefined, "the rename response must recheck that the source still exists after save");
    assert.equal(await new DiskSourceRepository(dir).getSource(source.id), undefined);
  });

  it("saves and clears a running source location without changing related data or stale lifecycle writes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-location-save-")); tempDirs.push(dir);
    const sourceId = randomUUID();
    const sessionId = randomUUID();
    const source: Source = {
      id: sourceId, name: "Jackson Hole camera", kind: "youtube", status: "running", createdAt: new Date(0).toISOString(),
      url: "https://www.youtube.com/watch?v=1EiC9bvVGnk",
      youtube: { videoId: "1EiC9bvVGnk", title: "Public camera", isLive: true, liveStatus: "is_live" }, width: 1920, height: 1080
    };
    const scene: Scene = {
      zones: [{ id: "zone-1", name: "Crosswalk", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.1 }, { x: 0.8, y: 0.8 }] }],
      countingLines: [{ id: "line-1", name: "Main road", start: { x: 0.2, y: 0.6 }, end: { x: 0.8, y: 0.6 }, directionLabels: ["Inbound", "Outbound"] }]
    };
    const event: AnalysisEvent = {
      id: randomUUID(), sourceId, sessionId, sourceTimeMs: 1000, frameWidth: 1280, frameHeight: 720,
      type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] }
    };
    const repository = new DiskSourceRepository(dir);
    await repository.putSource({ ...source, status: "idle" });
    await repository.putScene(sourceId, scene);
    await repository.setAssetPath(sourceId, path.join(dir, "source.mp4"));
    await repository.appendEvent(sourceId, event);
    const app = createApp({ repository, dataDir: dir, uploadDir: path.join(dir, "uploads"), worker: new StubWorker() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await repository.putSource(source);
    const staleBeforeSave = await repository.getSource(sourceId);

    const saved = await request(app).put(`/api/sources/${sourceId}/location`).send({ location: { latitude: 43.479, longitude: -110.762, label: "  Town Square  " } }).expect(200);
    assert.deepEqual(saved.body.source.location, { latitude: 43.479, longitude: -110.762, label: "Town Square" });
    assert.equal(saved.body.source.status, "running", "location edits are allowed while analysis is running");
    assert.equal(saved.body.source.name, source.name);
    assert.equal(saved.body.source.url, source.url);
    assert.deepEqual(saved.body.source.youtube, source.youtube);

    const afterSave = await new DiskSourceRepository(dir).getSource(sourceId);
    assert.deepEqual(afterSave?.location, saved.body.source.location);
    assert.equal(afterSave?.status, "running");
    assert.ok(staleBeforeSave);
    await repository.putSource({ ...staleBeforeSave!, status: "completed" });
    let persisted = await new DiskSourceRepository(dir).getSource(sourceId);
    assert.deepEqual(persisted?.location, saved.body.source.location, "a stale lifecycle snapshot cannot revert the saved location");
    assert.equal(persisted?.status, "completed", "the lifecycle snapshot can still update status");

    const staleBeforeClear = persisted;
    const cleared = await request(app).put(`/api/sources/${sourceId}/location`).send({ location: null }).expect(200);
    assert.equal(Object.hasOwn(cleared.body.source, "location"), false);
    assert.ok(staleBeforeClear);
    await repository.putSource({ ...staleBeforeClear!, status: "stopped" });
    persisted = await new DiskSourceRepository(dir).getSource(sourceId);
    assert.equal(Object.hasOwn(persisted!, "location"), false, "a stale snapshot cannot restore an explicitly cleared location");
    assert.equal(persisted?.status, "stopped");
    assert.equal(persisted?.id, sourceId);
    assert.equal(persisted?.name, source.name);
    assert.equal(persisted?.url, source.url);
    assert.deepEqual(persisted?.youtube, source.youtube);
    assert.equal(persisted?.width, source.width);
    assert.equal(persisted?.height, source.height);
    assert.deepEqual(await new DiskSourceRepository(dir).getScene(sourceId), scene);
    assert.deepEqual(await new DiskSourceRepository(dir).getEvents(sourceId), [event]);
    assert.equal(await new DiskSourceRepository(dir).getAssetPath(sourceId), path.join(dir, "source.mp4"));
  });

  it("rejects malformed location payloads and returns 404 for a missing source", async () => {
    const repository = new MemoryRepository();
    const app = createApp({ repository, worker: new StubWorker() });
    const source: Source = { id: randomUUID(), name: "Keep location empty", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    const invalidBodies: unknown[] = [
      null, [], {}, { location: "coordinates" }, { location: { latitude: 91, longitude: 0 } },
      { location: { latitude: 0, longitude: -181 } }, { location: { latitude: "0", longitude: 0 } },
      { location: { latitude: 0, longitude: 0, label: " \t " } }, { location: { latitude: 0, longitude: 0, label: "x".repeat(121) } },
      { location: { latitude: 0, longitude: 0, extra: true } }, { location: null, name: "extra" }
    ];
    for (const body of invalidBodies) await request(app).put(`/api/sources/${source.id}/location`).send(body).expect(400);
    await request(app).put(`/api/sources/${randomUUID()}/location`).send({ location: { latitude: 0, longitude: 0 } }).expect(404);
    assert.deepEqual(await repository.getSource(source.id), source);
  });

  it("returns saved location metadata when a delayed start response uses an older source snapshot", async () => {
    const worker = new GatedStartWorker();
    const repository = new MemoryRepository();
    const app = createApp({ repository, worker });
    const source = (await request(app).post("/api/sources").send({ name: "Start race camera", kind: "webcam" }).expect(201)).body.source as Source;
    const gate = worker.armStartGate();
    const pendingStart = request(app).post(`/api/sources/${source.id}/start`).then((response) => response);
    await gate.startStarted;
    await request(app).put(`/api/sources/${source.id}/location`).send({ location: { latitude: 90, longitude: -180 } }).expect(200);
    gate.release();
    const started = await pendingStart;
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.source.status, "running");
    assert.deepEqual(started.body.source.location, { latitude: 90, longitude: -180 });
  });

  it("retries the same location after a failed disk replacement", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-location-retry-")); tempDirs.push(dir);
    let failNextRename = false;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (failNextRename) { failNextRename = false; throw Object.assign(new Error("fixture replacement failure"), { code: "EIO" }); }
        await rename(from, to);
      }, onPersistenceError: () => undefined, renameRetryDelayMs: 0
    });
    const source: Source = { id: randomUUID(), name: "Retry location", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    const location = { latitude: 1.5, longitude: -3.25, label: "Retry" };
    failNextRename = true;
    await assert.rejects(repository.setLocation(source.id, location), /fixture replacement failure/);
    await repository.setLocation(source.id, location);
    assert.deepEqual((await new DiskSourceRepository(dir).getSource(source.id))?.location, location);
  });

  it("returns 404 and does not resurrect a source deleted during a location save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-location-delete-race-")); tempDirs.push(dir);
    let blockRename = false;
    let startedResolve!: () => void;
    let releaseResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const held = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (blockRename) { blockRename = false; startedResolve(); await held; }
        await rename(from, to);
      }, renameRetryDelayMs: 0
    });
    const source: Source = { id: randomUUID(), name: "Delete race", kind: "webcam", status: "idle", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    const app = createApp({ repository, dataDir: dir, uploadDir: path.join(dir, "uploads"), worker: new StubWorker() });
    blockRename = true;
    const pendingLocation = request(app).put(`/api/sources/${source.id}/location`).send({ location: { latitude: 0, longitude: 0 } }).then((response) => response);
    await started;
    const pendingDelete = request(app).delete(`/api/sources/${source.id}`).then((response) => response);
    for (let attempt = 0; attempt < 20 && await repository.getSource(source.id); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(await repository.getSource(source.id), undefined);
    releaseResolve();
    const [locationResponse, deleteResponse] = await Promise.all([pendingLocation, pendingDelete]);
    assert.equal(locationResponse.status, 404);
    assert.equal(deleteResponse.status, 204);
    assert.equal(await new DiskSourceRepository(dir).getSource(source.id), undefined);
  });

  it("cleans only the API-owned temporary YouTube preview directory on shutdown", async () => {
    const before = new Set(await readdir(os.tmpdir()));
    const app = createApp({ repository: new MemoryRepository(), worker: new StubWorker() });
    let ownedPath: string | undefined;
    for (let attempt = 0; attempt < 20 && !ownedPath; attempt += 1) {
      const entries = await readdir(os.tmpdir());
      const created = entries.find((entry) => !before.has(entry) && entry.startsWith(`traffic-dash-youtube-preview-${process.pid}-`));
      if (created) ownedPath = path.join(os.tmpdir(), created);
      else await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(ownedPath, "API creates its owned preview cache directory");
    await app.closeResources();
    await assert.rejects(stat(ownedPath));

    const callerOwned = path.join(os.tmpdir(), `traffic-dash-caller-preview-${randomUUID()}`);
    await mkdir(callerOwned, { recursive: true });
    const explicitApp = createApp({ repository: new MemoryRepository(), worker: new StubWorker(), previewDir: callerOwned });
    await explicitApp.closeResources();
    await stat(callerOwned);
    await rm(callerOwned, { recursive: true, force: true });
  });

  it("blocks restart and deletion until the worker confirms stop", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-stop-race-")); tempDirs.push(dir);
    const repository = new MemoryRepository();
    const worker = new GatedStopWorker();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir: path.join(dir, "preview") });
    const source = (await request(app).post("/api/sources").send({ name: "Camera", kind: "webcam" }).expect(201)).body.source as Source;
    await request(app).post(`/api/sources/${source.id}/start`).expect(200);
    const gate = worker.armStopGate();
    const pendingStop = request(app).post(`/api/sources/${source.id}/stop`).then((response) => response);
    await gate.stopStarted;
    await request(app).post(`/api/sources/${source.id}/start`).expect(409);
    await request(app).delete(`/api/sources/${source.id}`).expect(409);
    gate.release();
    assert.equal((await pendingStop).body.source.status, "stopped");
    await request(app).post(`/api/sources/${source.id}/start`).expect(200);
  });

  it("does not delete a source while its YouTube preview refresh is pending", async () => {
    const worker = new GatedYoutubeProbeWorker();
    const repository = new MemoryRepository();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-youtube-delete-race-")); tempDirs.push(dir);
    const api = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir: path.join(dir, "preview") });
    const created = (await request(api).post("/api/sources").send({ name: "Eastbound live", kind: "youtube", url: "https://youtu.be/1EiC9bvVGnk" }).expect(201)).body.source as Source;
    const gate = worker.armProbeGate();
    const pendingRefresh = request(api).post(`/api/sources/${created.id}/preview`).then((response) => response);
    await gate.probeStarted;
    await request(api).delete(`/api/sources/${created.id}`).expect(409);
    gate.release();
    const refreshed = await pendingRefresh;
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    await request(api).delete(`/api/sources/${created.id}`).expect(204);
    assert.equal(await repository.getSource(created.id), undefined);
  });

  it("publishes a YouTube preview only after its matching analysis event is durable", async () => {
    const repository = new SlowAppendRepository();
    const worker = new YoutubeStubWorker();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-youtube-pairing-")); tempDirs.push(dir);
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir: path.join(dir, "preview") });
    const source = (await request(app).post("/api/sources").send({ name: "Eastbound live", kind: "youtube", url: "https://youtu.be/1EiC9bvVGnk" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const analyzeCall = worker.calls.find((call) => call.command === "analyze_youtube")!;
    await worker.writeAndEmitPreview(analyzeCall.payload!, 500);
    const metadataResponse = await request(app).get(`/api/sources/${source.id}/preview`).expect(200);
    assert.match(metadataResponse.headers["cache-control"], /no-store/);
    const beforeDurability = metadataResponse.body.preview;
    assert.equal(beforeDurability, null);
    let published: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      published = (await request(app).get(`/api/sources/${source.id}/preview`).expect(200)).body.preview;
      if (published?.sessionId === started.sessionId) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(published?.sessionId, started.sessionId);
    assert.equal(published?.sourceTimeMs, 500);
    const saved = (await request(app).get(`/api/sources/${source.id}/events`).expect(200)).body.events as AnalysisEvent[];
    assert.ok(saved.some((event) => event.sessionId === started.sessionId && event.sourceTimeMs === 500));
    const diagnostics = (await request(app).get("/api/debug/youtube-preview").expect(200)).body.diagnostics as Array<Record<string, unknown>>;
    const sourceDiagnostics = diagnostics.find((item) => item.sourceId === source.id)!;
    assert.equal(sourceDiagnostics.notifications, 1);
    assert.equal(sourceDiagnostics.copied, 1);
    assert.equal(sourceDiagnostics.enqueued, 1);
    assert.equal(sourceDiagnostics.durableCompleted, 1);
    assert.equal(sourceDiagnostics.published, 2, "one preflight preview and one analyzed preview should publish");
    assert.equal(sourceDiagnostics.latestPublishedSourceTimeMs, 500);
  });

  it("serves copied preview bytes after worker pruning while bounding pending and published frames", async () => {
    const repository = new SlowAppendRepository();
    const worker = new YoutubeStubWorker();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-youtube-preview-prune-race-")); tempDirs.push(dir);
    const previewDir = path.join(dir, "preview");
    const app = createTrafficApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir });
    const source = (await request(app).post("/api/sources").send({ name: "Eastbound live", kind: "youtube", url: "https://youtu.be/1EiC9bvVGnk" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const analyzeCall = worker.calls.find((call) => call.command === "analyze_youtube")!;
    const first = await worker.writeAndEmitPreview(analyzeCall.payload!, 500);
    const recent = [first];
    await rm(path.join(previewDir, source.id, started.sessionId, `${first.frameId}.jpg`), { force: true });
    for (let sample = 2; sample <= 40; sample += 1) {
      const preview = await worker.writeAndEmitPreview(analyzeCall.payload!, sample * 500);
      recent.push(preview);
      const framePath = path.join(previewDir, source.id, started.sessionId, `${preview.frameId}.jpg`);
      await rm(framePath, { force: true });
    }

    let latest: Pick<typeof first, "sessionId" | "frameId" | "sourceTimeMs"> | null = null;
    for (let attempt = 0; attempt < 240; attempt += 1) {
      latest = (await request(app).get(`/api/sources/${source.id}/preview`).expect(200)).body.preview as typeof latest;
      if (latest?.sourceTimeMs === 20_000) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(latest?.sourceTimeMs, 20_000, "latest preview must publish after its matching delayed analysis write");
    for (const preview of recent.slice(-4)) {
      await request(app).get(`/api/sources/${source.id}/preview/${preview.sessionId}/${preview.frameId}`).expect(200);
    }
    await request(app).get(`/api/sources/${source.id}/preview/${first.sessionId}/${first.frameId}`).expect(404);
    const latestImage = await request(app).get(`/api/sources/${source.id}/preview/${latest!.sessionId}/${latest!.frameId}`).expect(200);
    assert.equal(latestImage.headers["x-source-time-ms"], "20000");
    assert.deepEqual(latestImage.body, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const latestPath = path.join(previewDir, source.id, started.sessionId, `${latest!.frameId}.jpg`);
    await assert.rejects(stat(latestPath));
  });

  it("never advertises preview metadata when the notification JPEG cannot be copied", async () => {
    const repository = new MemoryRepository();
    const worker = new YoutubeStubWorker();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-youtube-preview-missing-bytes-")); tempDirs.push(dir);
    const app = createTrafficApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir: path.join(dir, "preview") });
    const source = (await request(app).post("/api/sources").send({ name: "Eastbound live", kind: "youtube", url: "https://youtu.be/1EiC9bvVGnk" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const frameId = randomUUID();
    worker.emit({ id: randomUUID(), sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 500,
      frameWidth: 1920, frameHeight: 1080, detections: [], crossings: [], quality: { coverage: "known", notes: [] } });
    worker.emit({ type: "preview_frame", sourceId: source.id, sessionId: started.sessionId,
      sourceTimeMs: 500, frameId, width: 1280, height: 720 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await request(app).get(`/api/sources/${source.id}/preview`).expect(200)).body.preview, null);
    await request(app).get(`/api/sources/${source.id}/preview/${started.sessionId}/${frameId}`).expect(404);
  });

  it("probes and caches exact YouTube preview frames without persisting media URLs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-youtube-")); tempDirs.push(dir);
    const repository = new MemoryRepository();
    const worker = new YoutubeStubWorker();
    const previewDir = path.join(dir, "volatile-preview");
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads"), previewDir });
    await request(app).post("/api/sources").send({ name: "External video", kind: "youtube", url: "https://example.com/watch?v=1EiC9bvVGnk" }).expect(400);
    await request(app).post("/api/sources").send({ name: "Playlist", kind: "youtube", url: "https://www.youtube.com/playlist?list=PL00000000000000000" }).expect(400);
    await request(app).post("/api/sources").send({ name: "Non-local stream", kind: "stream", url: "http://8.8.8.8/live" }).expect(400);
    await request(app).post("/api/sources").send({ name: "Local network URL is not YouTube", kind: "youtube", url: "http://127.0.0.1:8080/live" }).expect(400);
    assert.equal(worker.calls.some((call) => call.command === "probe_youtube"), false);
    const createResponse = await request(app).post("/api/sources").send({ name: "Eastbound live", kind: "youtube", url: "https://www.youtube.com/watch?v=1EiC9bvVGnk&list=PL00000000000000000" });
    assert.equal(createResponse.status, 201, JSON.stringify(createResponse.body));
    const created = createResponse.body.source as Source;
    assert.equal(created.url, "https://www.youtube.com/watch?v=1EiC9bvVGnk");
    assert.deepEqual(created.youtube, { videoId: "1EiC9bvVGnk", title: "Public YouTube live source", isLive: true, liveStatus: "is_live" });
    assert.equal(created.width, 1920); assert.equal(created.height, 1080);
    assert.equal(JSON.stringify(created).includes("never-persist-this"), false);
    assert.equal(JSON.stringify(await repository.getSource(created.id)).includes("googlevideo"), false);

    const initial = (await request(app).get(`/api/sources/${created.id}/preview`).expect(200)).body.preview;
    assert.equal(initial.sourceId, created.id); assert.equal(initial.sourceTimeMs, 0);
    assert.equal(initial.width, 1280); assert.equal(initial.height, 720);
    const image = await request(app).get(`/api/sources/${created.id}/preview/${initial.sessionId}/${initial.frameId}`).expect(200);
    assert.match(image.headers["content-type"], /image\/jpeg/);
    assert.equal(image.headers["cache-control"], "no-store");
    await request(app).get(`/api/sources/${created.id}/preview/00000000-0000-4000-8000-000000000000/${initial.frameId}`).expect(404);

    const refreshed = (await request(app).post(`/api/sources/${created.id}/preview`).expect(200)).body;
    assert.notEqual(refreshed.preview.sessionId, initial.sessionId);
    await request(app).get(`/api/sources/${created.id}/preview/${initial.sessionId}/${initial.frameId}`).expect(404);
    const failedSourceCount = repository.sources.size;
    worker.failVideoId = "1H0iTzv2jiQ";
    await request(app).post("/api/sources").send({ name: "Private live", kind: "youtube", url: "https://youtu.be/1H0iTzv2jiQ" }).expect(502);
    assert.equal(repository.sources.size, failedSourceCount);

    const started = (await request(app).post(`/api/sources/${created.id}/start`).expect(200)).body;
    assert.equal(started.source.status, "running");
    const analyzeCall = worker.calls.find((call) => call.command === "analyze_youtube")!;
    assert.equal(analyzeCall.payload?.sampleEveryMs, 500);
    assert.equal(analyzeCall.payload?.url, created.url);
    const stale = await worker.writeAndEmitPreview(analyzeCall.payload!, 500);
    assert.equal(stale.sessionId, started.sessionId);
    let newest: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      newest = (await request(app).get(`/api/sources/${created.id}/preview`).expect(200)).body.preview;
      if (newest?.sessionId === started.sessionId) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(newest.sessionId, started.sessionId);
    assert.equal(newest.sourceTimeMs, 500);
    await request(app).get(`/api/sources/${created.id}/preview/${newest.sessionId}/${newest.frameId}`).expect(200);

    await request(app).post(`/api/sources/${created.id}/stop`).expect(200);
    await worker.writeAndEmitPreview(analyzeCall.payload!, 1000);
    const afterStop = (await request(app).get(`/api/sources/${created.id}/preview`).expect(200)).body.preview;
    assert.equal(afterStop.frameId, newest.frameId);
  });

  it("extracts bounded MP4 metadata and supports explicit recording-time override and refresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-metadata-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads");
    const repository = new MemoryRepository();
    const app = createApp({ repository, worker: new StubWorker(), dataDir: dir, uploadDir });
    const embeddedSeconds = Math.floor((Date.parse("2026-10-12T11:46:25Z") - Date.UTC(1904, 0, 1)) / 1000);
    const fixture = mp4MetadataFixture(embeddedSeconds);
    const upload = await request(app).post("/api/uploads").attach("file", fixture, { filename: "metadata.mp4", contentType: "video/mp4" }).expect(201);
    const sourceId = upload.body.source.id as string;
    assert.equal(upload.body.source.width, 1920);
    assert.equal(upload.body.source.height, 1080);
    assert.equal(upload.body.source.durationMs, 181_053);
    assert.deepEqual(upload.body.source.recordingTime, {
      effectiveStartAt: "2026-10-12T11:46:25.000Z",
      provenance: "embedded_metadata",
      embeddedStartAt: "2026-10-12T11:46:25.000Z",
      embeddedField: "mvhd_creation_time"
    });
    const camera = (await request(app).post("/api/sources").send({ name: "Live camera", kind: "webcam" }).expect(201)).body.source as Source;
    await request(app).put(`/api/sources/${camera.id}/recording-time`).send({ manualStartAt: "2026-10-12T11:46:25Z" }).expect(409);

    const savedScene = { zones: [], countingLines: [{ id: "line-n", name: "North", start: { x: 0.2, y: 0.3 }, end: { x: 0.8, y: 0.4 }, directionLabels: ["A to B", "B to A"] as [string, string] }] };
    await repository.putScene(sourceId, savedScene);
    const savedEvent: AnalysisEvent = { id: "prior-event", sourceId, sessionId: "prior-session", sourceTimeMs: 25_000, frameWidth: 1920, frameHeight: 1080, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } };
    await repository.appendEvent(sourceId, savedEvent);

    const refreshed = (await request(app).post(`/api/sources/${sourceId}/metadata/refresh`).expect(200)).body.source as Source;
    assert.deepEqual(refreshed.recordingTime, upload.body.source.recordingTime);
    assert.deepEqual((await request(app).get(`/api/sources/${sourceId}/scene`).expect(200)).body.scene, savedScene);
    assert.deepEqual((await request(app).get(`/api/sources/${sourceId}/events`).expect(200)).body.events, [savedEvent]);

    const overridden = (await request(app).put(`/api/sources/${sourceId}/recording-time`).send({ manualStartAt: "2026-10-12T14:46:25+03:00" }).expect(200)).body.source as Source;
    assert.equal(overridden.recordingTime?.effectiveStartAt, "2026-10-12T11:46:25.000Z");
    assert.equal(overridden.recordingTime?.provenance, "manual_override");
    assert.equal(overridden.recordingTime?.embeddedStartAt, "2026-10-12T11:46:25.000Z");
    await request(app).put(`/api/sources/${sourceId}/recording-time`).send({ manualStartAt: "2026-10-12T14:46:25" }).expect(400);
    await request(app).put(`/api/sources/${sourceId}/recording-time`).send({ manualStartAt: "2026-02-31T14:46:25Z" }).expect(400);
    const restored = (await request(app).put(`/api/sources/${sourceId}/recording-time`).send({ manualStartAt: null }).expect(200)).body.source as Source;
    assert.deepEqual(restored.recordingTime, upload.body.source.recordingTime);
  });

  it("leaves zero or implausible embedded movie times unknown and canonicalizes offset times strictly", async () => {
    assert.equal(canonicalizeOffsetDateTime("2026-10-12T14:46:25+03:00"), "2026-10-12T11:46:25.000Z");
    assert.equal(canonicalizeOffsetDateTime("2026-02-31T14:46:25Z"), undefined);
    assert.equal(canonicalizeOffsetDateTime("2026-02-31T14:46:25+03:00"), undefined);
    assert.equal(canonicalizeOffsetDateTime("2026-10-12T14:46:25-00:00"), undefined);
    assert.equal(canonicalizeOffsetDateTime("2026-10-12T14:46:25"), undefined);
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-unknown-metadata-")); tempDirs.push(dir);
    const app = createApp({ repository: new MemoryRepository(), worker: new StubWorker(), dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const upload = await request(app).post("/api/uploads").attach("file", mp4MetadataFixture(0), { filename: "unknown-time.mp4", contentType: "video/mp4" }).expect(201);
    assert.equal(upload.body.source.recordingTime, undefined);
    assert.equal(upload.body.source.width, 1920);
    const overflowUpload = await request(app).post("/api/uploads").attach("file", mp4VersionOneOverflowFixture(), { filename: "overflow-time.mp4", contentType: "video/mp4" }).expect(201);
    assert.equal(overflowUpload.body.source.recordingTime, undefined);
    assert.equal(overflowUpload.body.source.width, 1920, "DateTimeClip overflow must not discard otherwise usable track metadata");
    assert.equal(overflowUpload.body.source.height, 1080);
    assert.equal(overflowUpload.body.source.durationMs, 181_053);
  });

  it("merges refreshed metadata into the latest source state after asynchronous extraction", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-metadata-race-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const assetPath = path.join(uploadDir, "existing.mp4");
    await writeFile(assetPath, mp4MetadataFixture(3_874_650_385));
    const repository = new MemoryRepository();
    const embeddedStartAt = "2026-10-12T11:46:25.000Z";
    const source: Source = {
      id: "00000000-0000-4000-8000-000000000099", name: "Existing upload", kind: "upload", status: "completed",
      createdAt: new Date(0).toISOString(), recordingTime: { effectiveStartAt: "2026-10-13T00:00:00.000Z", provenance: "manual_override", embeddedStartAt, embeddedField: "mvhd_creation_time" }
    };
    await repository.putSource(source);
    await repository.setAssetPath(source.id, assetPath);
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const metadataInspector = async () => {
      markEntered();
      await gate;
      return { width: 1920, height: 1080, durationMs: 181_053, recordingTime: { effectiveStartAt: embeddedStartAt, provenance: "embedded_metadata" as const, embeddedStartAt, embeddedField: "mvhd_creation_time" as const } };
    };
    const app = createApp({ repository, worker: new StubWorker(), dataDir: dir, uploadDir, metadataInspector });
    const pending = request(app).post(`/api/sources/${source.id}/metadata/refresh`).then((response) => response);
    await entered;
    await repository.putSource({ ...source, status: "error", error: "concurrent source failure" });
    release();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.body.source.status, "error");
    assert.equal(response.body.source.error, "concurrent source failure");
    assert.equal(response.body.source.recordingTime.provenance, "manual_override");
    assert.equal(response.body.source.recordingTime.effectiveStartAt, "2026-10-13T00:00:00.000Z");
    assert.equal(response.body.source.recordingTime.embeddedStartAt, embeddedStartAt);
  });

  it("preserves last-known media metadata when a refresh returns no usable result", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-metadata-empty-refresh-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const assetPath = path.join(uploadDir, "existing.mp4");
    await writeFile(assetPath, mp4MetadataFixture(0));
    const repository = new MemoryRepository();
    const timestamp = "2026-10-12T11:46:25.000Z";
    const source: Source = {
      id: "00000000-0000-4000-8000-000000000098", name: "Known metadata", kind: "upload", status: "completed",
      createdAt: new Date(0).toISOString(), width: 1920, height: 1080, durationMs: 181_053,
      recordingTime: { effectiveStartAt: timestamp, provenance: "embedded_metadata", embeddedStartAt: timestamp, embeddedField: "mvhd_creation_time" }
    };
    await repository.putSource(source);
    await repository.setAssetPath(source.id, assetPath);
    const app = createApp({ repository, worker: new StubWorker(), dataDir: dir, uploadDir, metadataInspector: async () => ({}) });
    const response = await request(app).post(`/api/sources/${source.id}/metadata/refresh`).expect(200);
    assert.deepEqual(response.body.source, source);
  });

  it("reports worker unavailability and never claims analysis without a worker", async () => {
    const { app } = await appFor(new DisabledWorker());
    const health = await request(app).get("/api/health").expect(200);
    assert.equal(health.body.worker.available, false);
    const created = await request(app).post("/api/sources").send({ name: "Test camera", kind: "webcam" }).expect(201);
    await request(app).post(`/api/sources/${created.body.source.id}/start`).expect(503);
    const summary = await request(app).get(`/api/sources/${created.body.source.id}/summary`).expect(200);
    assert.equal(summary.body.summary.visibleVehicleCount, null);
    assert.equal(summary.body.summary.coverage, "unknown");
  });

  it("allows the dashboard origin and idempotency header while rejecting unrelated origins", async () => {
    const { app } = await appFor(new DisabledWorker());
    const allowed = await request(app).options("/api/uploads")
      .set("Origin", "http://laptop.tail6485dc.ts.net:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type,idempotency-key")
      .expect(204);
    assert.equal(allowed.headers["access-control-allow-origin"], "http://laptop.tail6485dc.ts.net:5173");
    assert.match(allowed.headers["access-control-allow-headers"], /idempotency-key/i);
    const denied = await request(app).options("/api/uploads")
      .set("Origin", "http://attacker.example:5173")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "idempotency-key")
      .expect(200);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
  });

  it("persists scene, submits one frame, de-duplicates worker events, and counts crossings", async () => {
    const worker = new StubWorker(); const { app } = await appFor(worker);
    const source = (await request(app).post("/api/sources").send({ name: "North cam", kind: "webcam" }).expect(201)).body.source as Source;
    const scene = { zones: [{ id: "z1", name: "Road", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }], countingLines: [{ id: "line-a", name: "Stop line", start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 }, directionLabels: ["A to B", "B to A"] }] };
    await request(app).put(`/api/sources/${source.id}/scene`).send(scene).expect(200);
    assert.deepEqual((await request(app).get(`/api/sources/${source.id}/scene`).expect(200)).body.scene, scene);
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    await request(app).post(`/api/sources/${source.id}/frame`).field("sourceTimeMs", "1250").attach("file", jpeg, { filename: "frame.jpg", contentType: "image/jpeg" }).expect(202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rows = await request(app).get(`/api/sources/${source.id}/events`).expect(200);
    assert.equal(rows.body.events.length, 1);
    assert.equal(rows.body.events[0].sessionId, started.sessionId);
    const summary = await request(app).get(`/api/sources/${source.id}/summary`).expect(200);
    assert.equal(summary.body.summary.visibleVehicleCount, 1);
    assert.deepEqual(summary.body.summary.crossings, [{ lineId: "line-a", direction: "A to B", count: 1 }]);
    await request(app).post(`/api/sources/${source.id}/stop`).expect(200);
    assert.deepEqual(worker.calls.map((call) => call.command), ["configure", "start", "process_frame", "stop"]);
  });

  it("migrates legacy repository state without changing source, scene, or analysis events while adding feedback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-feedback-migration-")); tempDirs.push(dir);
    const source: Source = { id: randomUUID(), name: "Legacy history", kind: "upload", status: "completed", createdAt: new Date(0).toISOString() };
    const scene: Scene = { zones: [{ id: "zone", name: "Road", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }], countingLines: [] };
    const event: AnalysisEvent = { id: "legacy-event", sourceId: source.id, sessionId: "legacy-session", sourceTimeMs: 50, frameWidth: 100, frameHeight: 80, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } };
    await writeFile(path.join(dir, "repository.json"), JSON.stringify({ sources: [source], sourceFolders: [], scenes: { [source.id]: scene }, events: { [source.id]: [event] }, assets: {}, uploadRequests: {} }));
    const repository = new DiskSourceRepository(dir);
    assert.deepEqual(await repository.listFeedbackReports(source.id), []);
    assert.deepEqual(await repository.getSource(source.id), source);
    assert.deepEqual(await repository.getScene(source.id), scene);
    assert.deepEqual(await repository.getEvents(source.id), [event]);
    const report: DetectionFeedback = { id: randomUUID(), sourceId: source.id, sessionId: event.sessionId, eventId: event.id, sourceTimeMs: event.sourceTimeMs,
      frameWidth: event.frameWidth, frameHeight: event.frameHeight, analysisContext: { qualityCoverage: "known", qualityNotes: [], settingsCaptured: false }, frame: { provenance: "unavailable" }, evidenceAvailability: "unavailable", annotationCoverage: "partial",
      kind: "missed_vehicle", bbox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, proposedCorrection: { class: "car" }, reviewStatus: "open", reviewHistory: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    await repository.putFeedbackReport(report);
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual(await reopened.listFeedbackReports(source.id), [report]);
    assert.deepEqual(await reopened.getEvents(source.id), [event]);
    assert.deepEqual(await reopened.getScene(source.id), scene);
  });

  it("rolls back failed feedback persistence so a retry creates one durable report", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-feedback-rollback-")); tempDirs.push(dir);
    let failNextReplacement = false;
    const repository = new DiskSourceRepository(dir, { renameFile: async (from, to) => {
      if (failNextReplacement) { failNextReplacement = false; throw Object.assign(new Error("injected report write failure"), { code: "EIO" }); }
      await rename(from, to);
    } });
    const source: Source = { id: randomUUID(), name: "Feedback persistence", kind: "webcam", status: "completed", createdAt: new Date(0).toISOString() };
    const event: AnalysisEvent = { id: "retry-feedback-event", sourceId: source.id, sessionId: "feedback-session", sourceTimeMs: 0, frameWidth: 100, frameHeight: 80, type: "analysis", detections: [{ bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, class: "car", confidence: 0.8, trackId: "feedback-track" }], crossings: [], quality: { coverage: "known", notes: [] } };
    await repository.putSource(source); await repository.appendEvent(source.id, event);
    const app = createApp({ repository, worker: new StubWorker(), dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const draft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event.id }).expect(201)).body.draft;
    const body = { draftId: draft.draftId, eventId: event.id, kind: "false_positive", detectionIndex: 0, note: "Retry after injected disk failure" };
    failNextReplacement = true;
    await request(app).post(`/api/sources/${source.id}/feedback`).send(body).expect(500);
    assert.deepEqual(await repository.listFeedbackReports(source.id), []);
    const saved = (await request(app).post(`/api/sources/${source.id}/feedback`).send(body).expect(201)).body.report as DetectionFeedback;
    assert.equal((await repository.listFeedbackReports(source.id)).length, 1);
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual(await reopened.listFeedbackReports(source.id), [saved]);
    assert.deepEqual(await reopened.getEvents(source.id), [event]);
  });

  it("pins native frame feedback, keeps reports partial, and pages a track with scene contributions", async () => {
    const worker = new StubWorker(), repository = new MemoryRepository();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-native-feedback-")); tempDirs.push(dir);
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Feedback camera", kind: "webcam" }).expect(201)).body.source as Source;
    await request(app).put(`/api/sources/${source.id}/scene`).send({
      zones: [{ id: "road", name: "Road", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }],
      countingLines: [{ id: "line-a", name: "North", start: { x: 0.5, y: 0 }, end: { x: 0.5, y: 1 } }]
    }).expect(200);
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const nativeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    await request(app).post(`/api/sources/${source.id}/frame`).field("sourceTimeMs", "1250").attach("file", nativeJpeg, { filename: "frame.jpg", contentType: "image/jpeg" }).expect(202);
    let event: AnalysisEvent | undefined;
    for (let attempt = 0; attempt < 40 && !event; attempt++) {
      event = (await repository.getEvents(source.id))[0];
      if (!event) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(event?.frameId);
    assert.deepEqual((await request(app).get(`/api/sources/${source.id}/frames/${event!.frameId}`).expect(200)).body, nativeJpeg);
    const draft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event!.id }).expect(201)).body.draft;
    assert.equal(draft.frame.provenance, "analysis_source_frame");
    assert.deepEqual((await request(app).get(draft.frame.url).expect(200)).body, nativeJpeg);
    const saved = (await request(app).post(`/api/sources/${source.id}/feedback`).send({
      draftId: draft.draftId, eventId: event!.id, frameId: event!.frameId, kind: "wrong_color", detectionIndex: 0,
      proposedCorrection: { color: "blue" }, note: "Paint appears blue in the source frame"
    }).expect(201)).body.report;
    assert.equal(saved.annotationCoverage, "partial");
    assert.equal(saved.evidenceAvailability, "native_frame");
    assert.equal(saved.originalDetection.trackId, "track-1");
    assert.deepEqual((await request(app).get(saved.frame.url).expect(200)).body, nativeJpeg);
    await request(app).patch(`/api/sources/${source.id}/feedback/${saved.id}`).send({ reviewStatus: "reviewed", annotationCoverage: "complete" }).expect(409);
    const reviewed = (await request(app).patch(`/api/sources/${source.id}/feedback/${saved.id}`).send({ reviewStatus: "reviewed", reviewLabel: "confirmed" }).expect(200)).body.report;
    assert.equal(reviewed.annotationCoverage, "partial");
    assert.equal(reviewed.reviewStatus, "reviewed");
    assert.equal(reviewed.originalDetection.trackId, "track-1");
    const listed = (await request(app).get(`/api/sources/${source.id}/feedback?sessionId=${started.sessionId}&limit=1`).expect(200)).body;
    assert.equal(listed.reports[0].id, saved.id);
    assert.equal(listed.coverage, "known");
    const track = (await request(app).get(`/api/sources/${source.id}/tracks/track-1?sessionId=${started.sessionId}&limit=1`).expect(200)).body;
    assert.equal(track.track.observationCount, 1);
    assert.equal(track.observations[0].zoneIds[0], "road");
    assert.deepEqual(track.observations[0].crossings, [{ lineId: "line-a", direction: "A to B" }]);
    assert.deepEqual(await repository.getEvents(source.id), [event]);
  });

  it("attributes track zones from each event scene and marks legacy attribution unavailable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-track-scene-history-")); tempDirs.push(dir);
    const source: Source = { id: randomUUID(), name: "Historical track", kind: "webcam", status: "completed", createdAt: new Date(0).toISOString() };
    const repository = new MemoryRepository(), sceneAtAnalysis: Scene = { zones: [{ id: "then-road", name: "Road then", polygon: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 1 }, { x: 0, y: 1 }] }], countingLines: [] };
    const currentScene: Scene = { zones: [{ id: "now-road", name: "Road now", polygon: [{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }] }], countingLines: [] };
    await repository.putSource(source);
    await repository.putScene(source.id, currentScene);
    const detection = { bbox: { x: 0.1, y: 0.3, width: 0.2, height: 0.2 }, class: "car", confidence: 0.9, trackId: "historical-track" };
    const captured: AnalysisEvent = { id: "captured-event", sourceId: source.id, sessionId: "historic-session", sourceTimeMs: 100, frameWidth: 100, frameHeight: 100, type: "analysis", detections: [detection], crossings: [], quality: { coverage: "known", notes: [] },
      analysisContext: { settingsCaptured: true, detector: { backend: "test" }, tracker: { backend: "test" }, scene: { geometrySignature: sceneGeometrySignature(sceneAtAnalysis), snapshot: sceneAtAnalysis } } };
    const legacy: AnalysisEvent = { id: "legacy-event", sourceId: source.id, sessionId: "historic-session", sourceTimeMs: 200, frameWidth: 100, frameHeight: 100, type: "analysis", detections: [detection], crossings: [], quality: { coverage: "known", notes: [] } };
    await repository.appendEvent(source.id, captured); await repository.appendEvent(source.id, legacy);
    const app = createApp({ repository, worker: new StubWorker(), dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const result = (await request(app).get(`/api/sources/${source.id}/tracks/historical-track?sessionId=historic-session`).expect(200)).body;
    assert.deepEqual(result.observations.map((row: { eventId: string; zoneIds: string[]; zoneAttribution: string }) => ({ eventId: row.eventId, zoneIds: row.zoneIds, zoneAttribution: row.zoneAttribution })), [
      { eventId: "captured-event", zoneIds: ["then-road"], zoneAttribution: "captured_scene" },
      { eventId: "legacy-event", zoneIds: [], zoneAttribution: "unavailable" }
    ]);
  });

  it("keeps feedback event-bound and requires a labeled normalized missed-vehicle box", async () => {
    const worker = new StubWorker(), repository = new MemoryRepository();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-feedback-validation-")); tempDirs.push(dir);
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Report validation", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const event: AnalysisEvent = { id: "event-validation", sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 5, frameWidth: 100, frameHeight: 100, type: "analysis", detections: [{ bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, class: "car", confidence: 0.8, trackId: "track" }], crossings: [], quality: { coverage: "known", notes: [] } };
    worker.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const draft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event.id }).expect(201)).body.draft;
    await request(app).post(`/api/sources/${source.id}/feedback`).send({ draftId: draft.draftId, eventId: event.id, kind: "missed_vehicle" }).expect(400);
    await request(app).post(`/api/sources/${source.id}/feedback`).send({ draftId: draft.draftId, eventId: event.id, kind: "duplicate", detectionIndex: 0, duplicateOfDetectionIndex: 0 }).expect(400);
    const missedDraft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event.id }).expect(201)).body.draft;
    const saved = (await request(app).post(`/api/sources/${source.id}/feedback`).send({ draftId: missedDraft.draftId, eventId: event.id, kind: "missed_vehicle", bbox: { x: 0.4, y: 0.5, width: 0.1, height: 0.1 }, proposedCorrection: { correctedClassLabel: "van" } }).expect(201)).body.report;
    assert.equal(saved.frame.provenance, "unavailable");
    assert.equal(saved.evidenceAvailability, "unavailable");
    assert.equal(saved.annotationCoverage, "partial");
    assert.equal(saved.proposedCorrection.correctedClassLabel, "van");
  });

  it("copies nested native analysis-frame artifacts after the matching event becomes durable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-native-analysis-frame-")); tempDirs.push(dir);
    const worker = new StubWorker(), repository = new MemoryRepository();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Analysis frame camera", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const frameId = randomUUID();
    const analysisContext: AnalysisEvent["analysisContext"] = { settingsCaptured: true, detector: { backend: "yolo26", modelName: "YOLO26 Medium", device: "cuda:0", inputSize: 1280, nms: true },
      tracker: { backend: "IoUTracker" }, scene: { geometrySignature: "g1:[[],[]]", snapshot: { zones: [], countingLines: [] } } };
    worker.emit({ sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 1000, frameWidth: 640, frameHeight: 480, frameId,
      detections: [{ bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, class: "car", confidence: 0.95, trackId: "frame-track" }], crossings: [], quality: { coverage: "known", notes: [] }, analysisContext });
    const stagedDir = path.join(dir, "analysis-frame-staging", source.id, started.sessionId);
    await mkdir(stagedDir, { recursive: true });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    await writeFile(path.join(stagedDir, `${frameId}.jpg`), jpeg);
    worker.emit({ type: "analysis_frame", sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 1000, frameId, frameWidth: 640, frameHeight: 480, mimeType: "image/jpeg", artifactName: `${frameId}.jpg` });
    let event: AnalysisEvent | undefined;
    for (let attempt = 0; attempt < 40 && !event; attempt++) {
      event = (await repository.getEvents(source.id))[0];
      if (!event) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(event);
    assert.deepEqual(event.analysisContext, analysisContext);
    const draft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event.id }).expect(201)).body.draft;
    assert.equal(draft.frame.provenance, "analysis_source_frame");
    assert.deepEqual((await request(app).get(draft.frame.url).expect(200)).body, jpeg);
    assert.equal((await readdir(stagedDir)).includes(`${frameId}.jpg`), false);
  });

  it("recovers a legacy upload frame only with matching media time and dimensions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-legacy-feedback-frame-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads"), sourceId = randomUUID(), sessionId = "old-upload-session", eventId = "legacy-upload-event";
    await mkdir(uploadDir, { recursive: true });
    const assetPath = path.join(uploadDir, `${sourceId}.mp4`); await writeFile(assetPath, Buffer.from("test media"));
    const source: Source = { id: sourceId, name: "Old upload", kind: "upload", status: "completed", createdAt: new Date(0).toISOString() };
    const event: AnalysisEvent = { id: eventId, sourceId, sessionId, sourceTimeMs: 1250, frameWidth: 640, frameHeight: 480, type: "analysis",
      detections: [{ bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, class: "car", confidence: 0.9, trackId: "old-track" }], crossings: [], quality: { coverage: "known", notes: [] },
      analysisContext: { settingsCaptured: true, detector: { backend: "yolo26", modelName: "YOLO26 Medium", device: "cuda:0", inputSize: 1280, nms: true, confidenceThreshold: 0.25, iouThreshold: 0.7 },
        sampling: { sampleEveryMs: 1000 }, detectionMode: "auto", tracker: { backend: "IoUTracker" }, scene: { geometrySignature: "g1:[[],[]]", snapshot: { zones: [], countingLines: [] } } } };
    const repository = new MemoryRepository(); await repository.putSource(source); await repository.setAssetPath(sourceId, assetPath); await repository.appendEvent(sourceId, event);
    const nativeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    class ReDecodeWorker extends StubWorker {
      async request(command: WorkerCommand, payload?: Record<string, unknown>) {
        if (command === "extract_media_frame" && payload) {
          await writeFile(path.join(String(payload.artifactDir), `${payload.artifactId}.jpg`), nativeJpeg);
          return { sourceId, sessionId, eventId, sourceTimeMs: event.sourceTimeMs, decodedTimeMs: event.sourceTimeMs + 0.5, frameWidth: 640, frameHeight: 480, mimeType: "image/jpeg", artifactName: `${payload.artifactId}.jpg`, provenance: "verified_media_redecode" };
        }
        return super.request(command, payload);
      }
    }
    const app = createApp({ repository, worker: new ReDecodeWorker(), dataDir: dir, uploadDir });
    const draft = (await request(app).post(`/api/sources/${sourceId}/feedback/drafts`).send({ eventId }).expect(201)).body.draft;
    assert.equal(draft.frame.provenance, "verified_media_redecode");
    assert.deepEqual((await request(app).get(draft.frame.url).expect(200)).body, nativeJpeg);
    const report = (await request(app).post(`/api/sources/${sourceId}/feedback`).send({ draftId: draft.draftId, eventId, kind: "wrong_type", detectionIndex: 0, proposedCorrection: { correctedClassLabel: "van" } }).expect(201)).body.report;
    assert.equal(report.frame.provenance, "verified_media_redecode");
    assert.deepEqual(report.analysisContext, event.analysisContext);
    assert.equal(report.originalDetection.class, "car");
    assert.equal(report.proposedCorrection.correctedClassLabel, "van");
    const savedImage = await request(app).get(report.frame.url);
    assert.equal(savedImage.status, 200, JSON.stringify(savedImage.body));
    assert.deepEqual(savedImage.body, nativeJpeg);
    assert.deepEqual(await repository.getEvents(sourceId), [event]);
  });

  it("keeps a re-decoded frame unavailable when its timestamp differs by more than one millisecond", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-feedback-time-mismatch-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads"), sourceId = randomUUID(), sessionId = "timed-upload-session", eventId = "timed-upload-event";
    await mkdir(uploadDir, { recursive: true });
    const assetPath = path.join(uploadDir, `${sourceId}.mp4`); await writeFile(assetPath, Buffer.from("test media"));
    const source: Source = { id: sourceId, name: "Timed upload", kind: "upload", status: "completed", createdAt: new Date(0).toISOString() };
    const event: AnalysisEvent = { id: eventId, sourceId, sessionId, sourceTimeMs: 1250, frameWidth: 640, frameHeight: 480, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } };
    const repository = new MemoryRepository(); await repository.putSource(source); await repository.setAssetPath(sourceId, assetPath); await repository.appendEvent(sourceId, event);
    const nativeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    class MismatchedTimeWorker extends StubWorker {
      async request(command: WorkerCommand, payload?: Record<string, unknown>) {
        if (command === "extract_media_frame" && payload) {
          await writeFile(path.join(String(payload.artifactDir), `${payload.artifactId}.jpg`), nativeJpeg);
          return { sourceId, sessionId, eventId, sourceTimeMs: event.sourceTimeMs, decodedTimeMs: event.sourceTimeMs + 1.01, frameWidth: 640, frameHeight: 480, mimeType: "image/jpeg", artifactName: `${payload.artifactId}.jpg`, provenance: "verified_media_redecode" };
        }
        return super.request(command, payload);
      }
    }
    const app = createApp({ repository, worker: new MismatchedTimeWorker(), dataDir: dir, uploadDir });
    const draft = (await request(app).post(`/api/sources/${sourceId}/feedback/drafts`).send({ eventId }).expect(201)).body.draft;
    assert.deepEqual(draft.frame, { provenance: "unavailable" });
    await assert.rejects(() => readFile(path.join(dir, "feedback-drafts", `${draft.draftId}.jpg`)), { code: "ENOENT" });
    assert.deepEqual(await repository.getEvents(sourceId), [event]);
  });

  it("serializes source deletion behind an awaited frame draft and cleans the reserved draft", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-draft-delete-race-")); tempDirs.push(dir);
    const sourceId = randomUUID(), sessionId = randomUUID(), eventId = "draft-delete-event", uploadDir = path.join(dir, "uploads");
    await mkdir(uploadDir, { recursive: true });
    const assetPath = path.join(uploadDir, `${sourceId}.mp4`); await writeFile(assetPath, Buffer.from("fixture"));
    const source: Source = { id: sourceId, name: "Draft delete race", kind: "upload", status: "completed", createdAt: new Date(0).toISOString() };
    const event: AnalysisEvent = { id: eventId, sourceId, sessionId, sourceTimeMs: 25, frameWidth: 640, frameHeight: 480, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } };
    const repository = new MemoryRepository(); await repository.putSource(source); await repository.setAssetPath(sourceId, assetPath); await repository.appendEvent(sourceId, event);
    let markStarted!: () => void, release!: () => void;
    const extractionStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const extractionGate = new Promise<void>((resolve) => { release = resolve; });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    class DelayedExtractWorker extends StubWorker {
      async request(command: WorkerCommand, payload?: Record<string, unknown>) {
        if (command === "extract_media_frame" && payload) {
          markStarted(); await extractionGate;
          await writeFile(path.join(String(payload.artifactDir), `${payload.artifactId}.jpg`), jpeg);
          return { sourceId, sessionId, eventId, sourceTimeMs: event.sourceTimeMs, decodedTimeMs: event.sourceTimeMs, frameWidth: 640, frameHeight: 480, mimeType: "image/jpeg", artifactName: `${payload.artifactId}.jpg`, provenance: "verified_media_redecode" };
        }
        return super.request(command, payload);
      }
    }
    const app = createApp({ repository, worker: new DelayedExtractWorker(), dataDir: dir, uploadDir });
    const draftPromise = request(app).post(`/api/sources/${sourceId}/feedback/drafts`).send({ eventId }).expect(201).then((response) => response);
    await extractionStarted;
    let deletionSettled = false;
    const deletionRequest = request(app).delete(`/api/sources/${sourceId}`).expect(204).then((result) => { deletionSettled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(deletionSettled, false, "delete waits while the source frame draft is being copied");
    release();
    const draft = (await draftPromise).body.draft;
    await deletionRequest;
    assert.equal(await repository.getSource(sourceId), undefined);
    await request(app).get(draft.frame.url).expect(404);
    await assert.rejects(() => readFile(path.join(dir, "feedback-drafts", `${draft.draftId}.jpg`)), { code: "ENOENT" });
  });

  it("serializes source deletion behind report persistence and removes committed report evidence", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-report-delete-race-")); tempDirs.push(dir);
    let markStarted!: () => void, release!: () => void;
    const persistenceStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const persistenceGate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedFeedbackRepository extends MemoryRepository {
      async putFeedbackReport(report: DetectionFeedback) { markStarted(); await persistenceGate; await super.putFeedbackReport(report); }
    }
    const repository = new DelayedFeedbackRepository(), worker = new StubWorker();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Report delete race", kind: "webcam" }).expect(201)).body.source as Source;
    await request(app).post(`/api/sources/${source.id}/start`).expect(200);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9]);
    await request(app).post(`/api/sources/${source.id}/frame`).field("sourceTimeMs", "1250").attach("file", jpeg, { filename: "frame.jpg", contentType: "image/jpeg" }).expect(202);
    await request(app).post(`/api/sources/${source.id}/stop`).expect(200);
    let event: AnalysisEvent | undefined;
    for (let attempt = 0; attempt < 40 && !event; attempt++) { event = (await repository.getEvents(source.id))[0]; if (!event) await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.ok(event);
    const draft = (await request(app).post(`/api/sources/${source.id}/feedback/drafts`).send({ eventId: event.id }).expect(201)).body.draft;
    const feedbackPromise = request(app).post(`/api/sources/${source.id}/feedback`).send({ draftId: draft.draftId, eventId: event.id, kind: "false_positive", detectionIndex: 0 }).expect(201).then((response) => response);
    await persistenceStarted;
    let deletionSettled = false;
    const deletionRequest = request(app).delete(`/api/sources/${source.id}`).expect(204).then((result) => { deletionSettled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(deletionSettled, false, "delete waits while the report and evidence are committed");
    release();
    const report = (await feedbackPromise).body.report as DetectionFeedback;
    await deletionRequest;
    assert.equal(await repository.getSource(source.id), undefined);
    assert.deepEqual(await repository.listFeedbackReports(source.id), []);
    await assert.rejects(() => readFile(path.join(dir, "feedback-evidence", `${report.id}.jpg`)), { code: "ENOENT" });
  });

  it("accepts a positive detection and crossing event from the real NDJSON bridge", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/ndjson-worker.mjs", import.meta.url));
    const worker = new NdjsonWorkerClient({ python: process.execPath, script: fixture, cwd: path.dirname(fixture) });
    const { app } = await appFor(worker);
    try {
      const source = (await request(app).post("/api/sources").send({ name: "NDJSON camera", kind: "webcam" }).expect(201)).body.source as Source;
      await request(app).put(`/api/sources/${source.id}/scene`).send({ zones: [], countingLines: [{ id: "north-line", name: "North", start: { x: 0.45, y: 0.65 }, end: { x: 0.65, y: 0.65 } }] }).expect(200);
      const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
      assert.equal(worker.capability().detail, "RF-DETR Medium (COCO) · actual CPU; inference target GPU (cuda:0)");
      await request(app).post(`/api/sources/${source.id}/frame`).field("sourceTimeMs", "1250").attach("file", Buffer.from([0xff, 0xd8, 0xff, 0x00]), { filename: "frame.jpg", contentType: "image/jpeg" }).expect(202);
      let rows = { body: { events: [] as AnalysisEvent[] } };
      for (let attempt = 0; attempt < 40; attempt++) {
        rows = await request(app).get(`/api/sources/${source.id}/events`).expect(200) as typeof rows;
        if (rows.body.events.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(rows.body.events.length, 1);
      assert.equal(rows.body.events[0]?.sessionId, started.sessionId);
      assert.equal(rows.body.events[0]?.detections[0]?.trackId, "track-17");
      assert.equal(worker.capability().detail, "RF-DETR Medium (COCO) · actual GPU (cuda:0)");
      assert.equal((await request(app).get("/api/health").expect(200)).body.worker.detail, "RF-DETR Medium (COCO) · actual GPU (cuda:0)");
      const summary = (await request(app).get(`/api/sources/${source.id}/summary`).expect(200)).body.summary;
      assert.equal(summary.visibleVehicleCount, 1);
      assert.deepEqual(summary.crossings, [{ lineId: "north-line", direction: "A to B", count: 1 }]);
    } finally {
      await worker.close();
    }
  });

  it("withholds signed YouTube media URLs from worker errors and diagnostics", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/sensitive-ndjson-worker.mjs", import.meta.url));
    const worker = new NdjsonWorkerClient({ python: process.execPath, script: fixture, cwd: path.dirname(fixture) });
    let reportedEvent: unknown;
    const unsubscribe = worker.onEvent((event) => { reportedEvent = event; });
    try {
      await worker.request("start", {});
      await assert.rejects(worker.request("probe_youtube", {}), /Video stream failed/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const safe = JSON.stringify({ reportedEvent, detail: worker.capability().detail });
      assert.doesNotMatch(safe, /googlevideo|videoplayback|signature=private|expire=999/);
      assert.match(safe, /Video stream failed/);
    } finally {
      unsubscribe();
      await worker.close();
    }
  });

  it("gives bounded YouTube preflight its own deadline without extending frame requests", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/timeout-ndjson-worker.mjs", import.meta.url));
    const worker = new NdjsonWorkerClient({ python: process.execPath, script: fixture, cwd: path.dirname(fixture), requestTimeoutMs: 15, probeTimeoutMs: 100 });
    try {
      assert.deepEqual(await worker.request("probe_youtube", {}), { accepted: true });
      await assert.rejects(worker.request("process_frame", {}), /request timed out/);
    } finally {
      await worker.close();
    }
  });

  it("reports invalid worker event schema paths without logging payload values", async () => {
    const worker = new StubWorker();
    const diagnostics: string[][] = [];
    const { app } = await appFor(worker, { onInvalidWorkerEvent: (paths) => diagnostics.push(paths) });
    const source = (await request(app).post("/api/sources").send({ name: "Camera", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    worker.emit({ sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 10, frameWidth: 640, frameHeight: 480,
      detections: [{ bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 }, class: "car", confidence: 0.91, trackId: 17 }],
      crossings: [{ lineId: "line-a", direction: "A to B", trackId: 17 }], quality: { coverage: "known", notes: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(diagnostics, [["detections.[*].trackId", "crossings.[*].trackId"]]);
    assert.equal((await request(app).get(`/api/sources/${source.id}/events`).expect(200)).body.events.length, 0);
  });

  it("rejects malformed geometry and public stream targets", async () => {
    const { app } = await appFor(new StubWorker());
    const source = (await request(app).post("/api/sources").send({ name: "Camera", kind: "webcam" }).expect(201)).body.source as Source;
    await request(app).put(`/api/sources/${source.id}/scene`).send({ zones: [{ id: "z", name: "bad", polygon: [{ x: 3, y: 0 }] }], countingLines: [] }).expect(400);
    await request(app).post("/api/sources").send({ name: "Remote", kind: "stream", url: "http://8.8.8.8/live" }).expect(400);
    await request(app).post("/api/sources").send({ name: "Local", kind: "stream", url: "rtsp://127.0.0.1:8554/live" }).expect(201);
  });

  it("stores uploaded video under a generated name and serves byte ranges for seeking", async () => {
    const { app } = await appFor(new StubWorker());
    const bytes = Buffer.concat([Buffer.from("0000ftypisom"), Buffer.from("video-data")]);
    const result = await request(app).post("/api/uploads").field("name", "Traffic sample").attach("file", bytes, { filename: "unsafe name.mp4", contentType: "video/mp4" }).expect(201);
    assert.equal(result.body.source.kind, "upload");
    const video = await request(app).get(`/api/sources/${result.body.source.id}/video`).set("Range", "bytes=4-11").expect(206);
    assert.equal(video.headers["content-range"], `bytes 4-11/${bytes.length}`);
    assert.deepEqual(video.body, bytes.subarray(4, 12));
  });

  it("starts uploaded video at 2 fps while direct streams keep the worker default", async () => {
    const worker = new StubWorker();
    const { app } = await appFor(worker);
    const video = Buffer.from("0000ftypisomvideo-data");
    const uploaded = (await request(app).post("/api/uploads").attach("file", video, { filename: "traffic.mp4", contentType: "video/mp4" }).expect(201)).body.source as Source;
    await request(app).post(`/api/sources/${uploaded.id}/start`).expect(200);
    const uploadCalls = worker.calls.filter((call) => call.command === "configure" || call.command === "analyze_upload");
    assert.deepEqual(uploadCalls.map((call) => call.payload?.sampleEveryMs), [500, 500]);

    const stream = (await request(app).post("/api/sources").send({ name: "Local stream", kind: "stream", url: "http://127.0.0.1:8080/live" }).expect(201)).body.source as Source;
    await request(app).post(`/api/sources/${stream.id}/start`).expect(200);
    const streamCalls = worker.calls.filter((call) => (call.command === "configure" || call.command === "analyze_stream") && call.payload?.sourceId === stream.id);
    assert.equal(streamCalls.length, 2);
    assert.ok(streamCalls.every((call) => call.payload?.sampleEveryMs === undefined));
  });

  it("streams files above a small configured cap to disk and rejects oversize uploads with cleanup", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-large-upload-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads");
    const repository = new MemoryRepository();
    const worker = new StubWorker();
    const acceptedBytes = Buffer.alloc(1_250_000);
    Buffer.from("0000ftypisom").copy(acceptedBytes);
    const acceptingApp = createApp({ repository, worker, dataDir: dir, uploadDir, maxUploadBytes: 2 * 1024 * 1024 });
    const health = await request(acceptingApp).get("/api/health").expect(200);
    assert.equal(health.body.upload.maxBytes, 2 * 1024 * 1024);
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    const accepted = await request(acceptingApp).post("/api/uploads")
      .set("Idempotency-Key", idempotencyKey)
      .attach("file", acceptedBytes, { filename: "larger-than-old-cap.mp4", contentType: "video/mp4" }).expect(201);
    const acceptedPath = await repository.getAssetPath(accepted.body.source.id as string);
    assert.ok(acceptedPath);
    assert.equal((await stat(acceptedPath)).size, acceptedBytes.length);
    const retry = await request(acceptingApp).post("/api/uploads")
      .set("Idempotency-Key", idempotencyKey)
      .attach("file", acceptedBytes, { filename: "larger-than-old-cap.mp4", contentType: "video/mp4" }).expect(200);
    assert.equal(retry.body.source.id, accepted.body.source.id);

    const rejectingApp = createApp({ repository, worker, dataDir: dir, uploadDir, maxUploadBytes: 1024 * 1024 });
    const tooLarge = Buffer.alloc(1_250_000);
    Buffer.from("0000ftypisom").copy(tooLarge);
    const response = await request(rejectingApp).post("/api/uploads")
      .set("Idempotency-Key", "00000000-0000-4000-8000-000000000002")
      .attach("file", tooLarge, { filename: "too-large.mp4", contentType: "video/mp4" }).expect(413);
    assert.match(response.body.error, /1 MiB upload limit/);
    assert.deepEqual(await readdir(uploadDir), [path.basename(acceptedPath)]);
    assert.equal((await stat(acceptedPath)).size, acceptedBytes.length, "rejected upload cleanup must preserve accepted media");
    const retryAfterRejection = await request(acceptingApp).post("/api/uploads")
      .set("Idempotency-Key", "00000000-0000-4000-8000-000000000002")
      .attach("file", acceptedBytes, { filename: "recovered.mp4", contentType: "video/mp4" }).expect(201);
    assert.notEqual(retryAfterRejection.body.source.id, accepted.body.source.id);

    const concurrentKey = "00000000-0000-4000-8000-000000000003";
    const concurrentBytes = Buffer.from(acceptedBytes);
    const concurrent = await Promise.all([1, 2].map(() => request(acceptingApp).post("/api/uploads")
      .set("Idempotency-Key", concurrentKey)
      .attach("file", concurrentBytes, { filename: "concurrent.mp4", contentType: "video/mp4" })));
    assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 201]);
    assert.equal(concurrent[0]!.body.source.id, concurrent[1]!.body.source.id);
    assert.equal((await readdir(uploadDir)).length, 3, "duplicate retries must remove only their own temporary asset");
  });

  it("replays upload idempotency keys after the disk repository is reopened", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-upload-retry-")); tempDirs.push(dir);
    const uploadDir = path.join(dir, "uploads");
    const bytes = Buffer.alloc(128 * 1024);
    Buffer.from("0000ftypisom").copy(bytes);
    const key = "00000000-0000-4000-8000-000000000004";
    const firstApp = createApp({ repository: new DiskSourceRepository(dir), uploadDir, dataDir: dir, worker: new StubWorker() });
    const first = await request(firstApp).post("/api/uploads").set("Idempotency-Key", key)
      .attach("file", bytes, { filename: "persisted.mp4", contentType: "video/mp4" }).expect(201);
    const reopenedApp = createApp({ repository: new DiskSourceRepository(dir), uploadDir, dataDir: dir, worker: new StubWorker() });
    const replay = await request(reopenedApp).post("/api/uploads").set("Idempotency-Key", key)
      .attach("file", bytes, { filename: "persisted.mp4", contentType: "video/mp4" }).expect(200);
    assert.equal(replay.body.source.id, first.body.source.id);
    assert.equal((await new DiskSourceRepository(dir).listSources()).length, 1);
    assert.equal((await readdir(uploadDir)).length, 1);
  });

  it("writes compact repository snapshots and reloads source, scene, event, and aggregate data unchanged", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-compact-repository-")); tempDirs.push(dir);
    const sourceId = randomUUID();
    const sessionId = randomUUID();
    const source: Source = {
      id: sourceId, name: "Compact YouTube source", kind: "youtube", status: "stopped",
      createdAt: new Date("2026-10-13T12:00:00.000Z").toISOString(), url: "https://www.youtube.com/watch?v=1EiC9bvVGnk",
      youtube: { videoId: "1EiC9bvVGnk", title: "Downtown camera", isLive: true, liveStatus: "is_live" },
      width: 1920, height: 1080
    };
    const scene: Scene = {
      zones: [{ id: "zone-a", name: "Intersection", polygon: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.8, y: 0.8 }] }],
      countingLines: [{ id: "line-a", name: "Northbound", start: { x: 0.2, y: 0.6 }, end: { x: 0.8, y: 0.6 }, directionLabels: ["A to B", "B to A"] }]
    };
    const event: AnalysisEvent = {
      id: randomUUID(), sourceId, sessionId, sourceTimeMs: 1500, frameWidth: 1280, frameHeight: 720,
      type: "crossing", detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.25, height: 0.25 }, class: "car", confidence: 0.91, trackId: "vehicle-1" }],
      crossings: [{ lineId: "line-a", direction: "A to B", trackId: "vehicle-1" }],
      quality: { coverage: "known", notes: ["sampled frames only"] }
    };
    const repository = new DiskSourceRepository(dir);
    await repository.putSource(source);
    await repository.putScene(sourceId, scene);
    await repository.appendEvent(sourceId, event);
    const snapshot = await readFile(path.join(dir, "repository.json"), "utf8");
    assert.ok(!snapshot.startsWith("{\n"), "snapshot should not include pretty-print whitespace");
    assert.deepEqual(JSON.parse(snapshot).sources, [source]);

    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual(await reopened.listSources(), [source]);
    assert.deepEqual(await reopened.getScene(sourceId), scene);
    assert.deepEqual(await reopened.getEvents(sourceId), [event]);
    const aggregate = await reopened.getAggregate(sourceId, sessionId);
    assert.equal(aggregate.latestSession?.sessionId, sessionId);
    assert.equal(aggregate.latestSession?.crossings["line-a\u0000A to B"], 1);
  });

  it("recovers the serialized disk writer after a failed replacement and persists later state", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-writer-recovery-")); tempDirs.push(dir);
    const diagnostics: unknown[] = [];
    let failNextRename = true;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (failNextRename) { failNextRename = false; throw Object.assign(new Error("fixture replacement failure"), { code: "EIO" }); }
        await rename(from, to);
      },
      onPersistenceError: (error) => diagnostics.push(error),
      renameRetryDelayMs: 0
    });
    const source: Source = { id: "source-writer-recovery", name: "Writer recovery", kind: "webcam", status: "completed", createdAt: new Date(0).toISOString() };
    await assert.rejects(repository.putSource(source), /fixture replacement failure/);
    assert.equal(diagnostics.length, 1, "terminal persistence failures must reach the diagnostic hook");

    const event: AnalysisEvent = { id: "recovered-event", sourceId: source.id, sessionId: "session-recovered", sourceTimeMs: 1, frameWidth: 10, frameHeight: 10, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } };
    await repository.appendEvent(source.id, event);
    await repository.putSource(source);
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual(await reopened.getEvents(source.id), [event]);
    assert.equal((await reopened.getSource(source.id))?.status, "completed");
  });

  it("retries only bounded transient replacement failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-writer-retry-")); tempDirs.push(dir);
    let attempts = 0;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error("fixture sharing violation"), { code: "EPERM" });
        await rename(from, to);
      },
      renameRetryDelayMs: 0
    });
    const source: Source = { id: "source-writer-retry", name: "Transient replacement", kind: "webcam", status: "completed", createdAt: new Date(0).toISOString() };
    await repository.putSource(source);
    assert.equal(attempts, 3);
    assert.equal((await new DiskSourceRepository(dir).getSource(source.id))?.status, "completed");
  });

  it("drains pending analysis event persistence before marking a worker job completed", async () => {
    const worker = new StubWorker();
    const repository = new SlowAppendRepository();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-completion-order-")); tempDirs.push(dir);
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Durable camera", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    worker.emit({ sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 125, frameWidth: 640, frameHeight: 480,
      detections: [], crossings: [], quality: { coverage: "known", notes: [] } });
    worker.emit({ type: "job_complete", sourceId: source.id, sessionId: started.sessionId, framesAnalyzed: 1 });
    let completed: Source | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      completed = (await request(app).get(`/api/sources/${source.id}`).expect(200)).body.source as Source;
      if (completed.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed?.status, "completed");
    const saved = (await request(app).get(`/api/sources/${source.id}/events`).expect(200)).body.events as AnalysisEvent[];
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.sessionId, started.sessionId);
  });

  it("recovers frame appends after one terminal persistence error and durably completes later frames", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-frame-write-recovery-")); tempDirs.push(dir);
    let failNextRename = false;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (failNextRename) { failNextRename = false; throw Object.assign(new Error("fixture replacement failure"), { code: "EIO" }); }
        await rename(from, to);
      },
      onPersistenceError: () => undefined,
      renameRetryDelayMs: 0
    });
    const worker = new StubWorker();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Recovering camera", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    const row = (id: string, sourceTimeMs: number): AnalysisEvent => ({ id, sourceId: source.id, sessionId: started.sessionId, sourceTimeMs, frameWidth: 640, frameHeight: 480, type: "analysis", detections: [], crossings: [], quality: { coverage: "known", notes: [] } });
    failNextRename = true;
    worker.emit(row("first-frame", 10));
    worker.emit(row("second-frame", 20));
    worker.emit({ type: "job_complete", sourceId: source.id, sessionId: started.sessionId, framesAnalyzed: 2 });

    let completed: Source | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      completed = await repository.getSource(source.id);
      if (completed?.status === "completed" || completed?.status === "error") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed?.status, "completed");
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual(await reopened.getEvents(source.id), [row("first-frame", 10), row("second-frame", 20)]);
    assert.equal((await reopened.getSource(source.id))?.status, "completed");
  });

  it("marks a job errored when its last event cannot persist and no later frame recovers it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-frame-write-terminal-")); tempDirs.push(dir);
    let failNextRename = false;
    const repository = new DiskSourceRepository(dir, {
      renameFile: async (from, to) => {
        if (failNextRename) { failNextRename = false; throw Object.assign(new Error("fixture final replacement failure"), { code: "EIO" }); }
        await rename(from, to);
      },
      onPersistenceError: () => undefined,
      renameRetryDelayMs: 0
    });
    const worker = new StubWorker();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Terminal write camera", kind: "webcam" }).expect(201)).body.source as Source;
    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    failNextRename = true;
    worker.emit({ id: "last-frame", sourceId: source.id, sessionId: started.sessionId, sourceTimeMs: 10, frameWidth: 640, frameHeight: 480,
      detections: [], crossings: [], quality: { coverage: "known", notes: [] } });
    worker.emit({ type: "job_complete", sourceId: source.id, sessionId: started.sessionId, framesAnalyzed: 1 });

    let finalSource: Source | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      finalSource = await repository.getSource(source.id);
      if (finalSource?.status === "error" || finalSource?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(finalSource?.status, "error");
    assert.match(finalSource?.error ?? "", /could not be saved/);
    const reopened = new DiskSourceRepository(dir);
    assert.equal((await reopened.getSource(source.id))?.status, "error");
    assert.deepEqual((await reopened.getEvents(source.id)).map((event) => event.id), ["last-frame"]);
  });

  it("serializes concurrent starts and ignores completion from a stopped session", async () => {
    const worker = new StubWorker(); worker.delayMs = 30; const { app } = await appFor(worker);
    const source = (await request(app).post("/api/sources").send({ name: "Local stream", kind: "stream", url: "rtsp://127.0.0.1:8554/live" }).expect(201)).body.source as Source;
    const starts = await Promise.all([
      request(app).post(`/api/sources/${source.id}/start`),
      request(app).post(`/api/sources/${source.id}/start`)
    ]);
    assert.deepEqual(starts.map((response) => response.status).sort(), [200, 409]);
    await request(app).post(`/api/sources/${source.id}/stop`).expect(200);
    const sessionId = starts.find((response) => response.status === 200)!.body.sessionId as string;
    worker.emit({ type: "job_complete", sourceId: source.id, sessionId, cancelled: true, framesAnalyzed: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = await request(app).get(`/api/sources/${source.id}`).expect(200);
    assert.equal(current.body.source.status, "stopped");
  });

  it("clears a prior start error on successful retry and completion, and repairs stale restart text", async () => {
    const worker = new FailFirstConfigureWorker();
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-retry-status-")); tempDirs.push(dir);
    const repository = new MemoryRepository();
    const app = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    const source = (await request(app).post("/api/sources").send({ name: "Retry camera", kind: "webcam" }).expect(201)).body.source as Source;

    await request(app).post(`/api/sources/${source.id}/start`).expect(502);
    const failed = (await request(app).get(`/api/sources/${source.id}`).expect(200)).body.source as Source;
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "fixture configure failure");

    const started = (await request(app).post(`/api/sources/${source.id}/start`).expect(200)).body;
    assert.equal(started.source.status, "running");
    assert.equal(started.source.error, undefined);
    worker.emit({ type: "job_complete", sourceId: source.id, sessionId: started.sessionId, framesAnalyzed: 0 });
    let completed: Source | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      completed = (await request(app).get(`/api/sources/${source.id}`).expect(200)).body.source as Source;
      if (completed.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.error, undefined);

    await repository.putSource({ ...completed!, error: "API restarted while this source was running. Start it again to resume analysis." });
    const recoveredApp = createApp({ repository, worker, dataDir: dir, uploadDir: path.join(dir, "uploads") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const repaired = (await request(recoveredApp).get(`/api/sources/${source.id}`).expect(200)).body.source as Source;
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.error, undefined);
  });

  it("keeps summaries scoped to the latest session", () => {
    const event = (sessionId: string, id: string, time: number, direction: string): AnalysisEvent => ({ id, sourceId: "00000000-0000-4000-8000-000000000000", sessionId, sourceTimeMs: time, frameWidth: 10, frameHeight: 10, type: "crossing", detections: [], crossings: [{ lineId: "line", direction, trackId: `t-${id}` }], quality: { coverage: "known", notes: [] } });
    const result = buildSummary("00000000-0000-4000-8000-000000000000", [event("old", "1", 100, "A to B"), event("new", "2", 15, "B to A")]);
    assert.equal(result.sessionId, "new"); assert.deepEqual(result.crossings, [{ lineId: "line", direction: "B to A", count: 1 }]);
  });

  it("keeps persisted crossing totals cumulative when the returned event window evicts old rows", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "traffic-api-retention-")); tempDirs.push(dir);
    const sourceId = "00000000-0000-4000-8000-000000000000";
    const sessionId = "session-current";
    const row = (index: number): AnalysisEvent => ({
      id: `old-${index}`, sourceId, sessionId, sourceTimeMs: index, frameWidth: 10, frameHeight: 10, type: "crossing",
      detections: [], crossings: [{ lineId: "line", direction: "A to B", trackId: `track-${index}` }], quality: { coverage: "known", notes: [] }
    });
    const retained = Array.from({ length: 20_000 }, (_unused, index) => row(index));
    const key = "line\u0000A to B";
    await writeFile(path.join(dir, "repository.json"), JSON.stringify({
      sources: [{ id: sourceId, name: "Road", kind: "webcam", status: "stopped", createdAt: new Date(0).toISOString() }],
      scenes: {}, events: { [sourceId]: retained }, assets: {}, eventIds: { [sourceId]: retained.map((event) => event.id) },
      aggregates: { [sourceId]: { [sessionId]: { sessionId, crossings: { [key]: 20_000 }, minTimeMs: 0, maxTimeMs: 20_000, lastTimeMs: 20_000, latestDetections: [], qualityKnown: true, clockReset: false } } },
      historyTruncated: {}, discardedEventCount: {}
    }));
    const repository = new DiskSourceRepository(dir);
    await repository.appendEvent(sourceId, row(20_000));
    const nextSessionEvent: AnalysisEvent = { ...row(20_001), id: "session-b-event", sessionId: "session-next", crossings: [{ lineId: "line", direction: "B to A", trackId: "next-track" }] };
    await repository.appendEvent(sourceId, nextSessionEvent);
    const app = createApp({ repository, uploadDir: path.join(dir, "uploads") });
    const eventResponse = await request(app).get(`/api/sources/${sourceId}/events`).expect(200);
    assert.equal(eventResponse.body.events.length, 20_000);
    assert.equal(eventResponse.body.truncated, true);
    assert.equal(eventResponse.body.discardedCount, 2);
    const summary = (await request(app).get(`/api/sources/${sourceId}/summary`).expect(200)).body.summary;
    assert.deepEqual(summary.crossings, [{ lineId: "line", direction: "B to A", count: 1 }]);
    assert.equal(summary.historyTruncated, true);
    assert.equal(summary.discardedEventCount, 2);
    assert.equal(summary.sessionId, "session-next");
    const priorSession = await repository.getAggregate(sourceId, sessionId);
    assert.equal(priorSession.latestSession?.crossings[key], 20_001);
    assert.equal(priorSession.discardedEventCount, 2);
  });
});
