import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sceneGeometryParts, sceneGeometrySignature, type AnalysisEvent, type DetectionFeedback, type Scene, type Source, type SourceFolder, type Summary, type UniqueVehiclesSummary } from "@traffic/contracts";

export interface SourceRepository {
  listSources(): Promise<Source[]>;
  getLibrarySnapshot(): Promise<SourceLibrarySnapshot>;
  createSourceFolder(folder: SourceFolder): Promise<SourceLibrarySnapshot>;
  renameSourceFolder(id: string, name: string): Promise<SourceLibrarySnapshot>;
  deleteSourceFolder(id: string): Promise<SourceLibrarySnapshot>;
  organizeSource(id: string, folderId: string | null, beforeSourceId?: string | null): Promise<SourceLibrarySnapshot>;
  getSource(id: string): Promise<Source | undefined>;
  putSource(source: Source): Promise<void>;
  setLocation(id: string, location: Source["location"] | undefined): Promise<Source | undefined>;
  renameSource(id: string, name: string): Promise<Source | undefined>;
  deleteSource(id: string): Promise<void>;
  getScene(id: string): Promise<Scene>;
  putScene(id: string, scene: Scene): Promise<void>;
  appendEvent(id: string, event: AnalysisEvent): Promise<void>;
  getEvents(id: string): Promise<AnalysisEvent[]>;
  listFeedbackReports(sourceId: string): Promise<DetectionFeedback[]>;
  getFeedbackReport(sourceId: string, reportId: string): Promise<DetectionFeedback | undefined>;
  putFeedbackReport(report: DetectionFeedback): Promise<void>;
  getAssetPath(id: string): Promise<string | undefined>;
  setAssetPath(id: string, assetPath: string): Promise<void>;
  commitUpload(source: Source, assetPath: string, idempotencyKey?: string): Promise<{ source: Source; created: boolean }>;
  getAggregate(id: string, sessionId?: string): Promise<SourceAggregate>;
}

export type SourceLibrarySnapshot = { sources: Source[]; folders: SourceFolder[] };

export class SourceFolderOperationError extends Error {
  constructor(readonly statusCode: 400 | 404 | 409, message: string) { super(message); }
}
export class FeedbackCapacityError extends Error {
  constructor() { super("Feedback report storage limit reached"); }
}

export type DiskSourceRepositoryOptions = {
  renameFile?: (from: string, to: string) => Promise<void>;
  onPersistenceError?: (error: unknown) => void;
  renameMaxAttempts?: number;
  renameRetryDelayMs?: number;
};

export type SessionAggregate = {
  sessionId: string;
  crossings: Record<string, number>;
  minTimeMs: number;
  maxTimeMs: number;
  lastTimeMs: number;
  latestDetections: AnalysisEvent["detections"];
  qualityKnown: boolean;
  clockReset: boolean;
};
export type SourceAggregate = { latestSession: SessionAggregate | undefined; requestedSessionId?: string; historyTruncated: boolean; discardedEventCount?: number; uniqueVehicles?: UniqueVehiclesSummary };
type PersistedUniqueIndex = {
  sessionId: string; geometrySignature: string; zoneGeometrySignature: string; lineGeometrySignature: string;
  allTrackIds: string[]; zoneTrackIds: Array<{ id: string; trackIds: string[] }>; lineTrackIds: Array<{ id: string; trackIds: string[] }>;
  hasKnownCoverage: boolean; allComplete: boolean; zonesComplete: boolean; linesComplete: boolean;
};
type RuntimeUniqueIndex = Omit<PersistedUniqueIndex, "allTrackIds" | "zoneTrackIds" | "lineTrackIds"> & {
  allTrackIds: Set<string>; zoneTrackIds: Map<string, Set<string>>; lineTrackIds: Map<string, Set<string>>;
};
type DiskState = {
  sources: Source[]; sourceFolders: SourceFolder[]; scenes: Record<string, Scene>; events: Record<string, AnalysisEvent[]>; assets: Record<string, string>;
  uploadRequests: Record<string, string>;
  eventIds: Record<string, string[]>; aggregates: Record<string, Record<string, SessionAggregate>>; historyTruncated: Record<string, boolean>; discardedEventCount: Record<string, number>;
  uniqueVehicles?: Record<string, PersistedUniqueIndex[]>;
  feedbackReports?: Record<string, DetectionFeedback>;
};
const emptyState = (): DiskState => ({ sources: [], sourceFolders: [], scenes: {}, events: {}, assets: {}, uploadRequests: {}, eventIds: {}, aggregates: {}, historyTruncated: {}, discardedEventCount: {}, uniqueVehicles: {}, feedbackReports: {} });

/** Small local-only JSON repository. The interface allows a database adapter later. */
export class DiskSourceRepository implements SourceRepository {
  private state: DiskState = emptyState();
  private eventIdSets = new Map<string, Set<string>>();
  private uniqueIndexes = new Map<string, Map<string, RuntimeUniqueIndex>>();
  private ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private organizationWrites: Promise<void> = Promise.resolve();
  private feedbackMutations: Promise<void> = Promise.resolve();
  private readonly filePath: string;
  private readonly renameFile: (from: string, to: string) => Promise<void>;
  private readonly onPersistenceError: (error: unknown) => void;
  private readonly renameMaxAttempts: number;
  private readonly renameRetryDelayMs: number;
  private writeSequence = 0;

  constructor(dataDir: string, options: DiskSourceRepositoryOptions = {}) {
    this.filePath = path.join(dataDir, "repository.json");
    this.renameFile = options.renameFile ?? rename;
    this.onPersistenceError = options.onPersistenceError ?? ((error) => console.error("Local repository persistence failed", error));
    this.renameMaxAttempts = options.renameMaxAttempts ?? 4;
    this.renameRetryDelayMs = options.renameRetryDelayMs ?? 25;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && "sources" in parsed && Array.isArray(parsed.sources)) {
        const data = parsed as Partial<DiskState>;
        this.state = {
          sources: data.sources as Source[], sourceFolders: data.sourceFolders ?? [], scenes: data.scenes ?? {}, events: data.events ?? {}, assets: data.assets ?? {}, uploadRequests: data.uploadRequests ?? {},
          eventIds: data.eventIds ?? {}, aggregates: data.aggregates ?? {}, historyTruncated: data.historyTruncated ?? {}, discardedEventCount: data.discardedEventCount ?? {}, uniqueVehicles: data.uniqueVehicles ?? {},
          feedbackReports: data.feedbackReports ?? {}
        };
        for (const [sourceId, ids] of Object.entries(this.state.eventIds)) this.eventIdSets.set(sourceId, new Set(ids));
        for (const [sourceId, events] of Object.entries(this.state.events)) {
          const retainedIds = events.map((event) => event.id);
          this.state.eventIds[sourceId] = retainedIds;
          this.eventIdSets.set(sourceId, new Set(retainedIds));
        }
        if (!data.eventIds || !data.aggregates) {
          for (const [sourceId, events] of Object.entries(this.state.events)) {
            if (events.length >= 20_000) this.state.historyTruncated[sourceId] = true;
            const ids = this.state.eventIds[sourceId] ?? (this.state.eventIds[sourceId] = []);
            const knownIds = this.eventIdSets.get(sourceId) ?? new Set(ids);
            this.eventIdSets.set(sourceId, knownIds);
            for (const event of events) {
              if (!knownIds.has(event.id)) { ids.push(event.id); knownIds.add(event.id); }
              if (!data.aggregates) this.recordAggregateEvent(sourceId, event);
            }
          }
          await this.persist();
        }
        if (!data.uniqueVehicles) {
          this.backfillUniqueIndexes();
          await this.persist();
        } else this.hydrateUniqueIndexes();
        if (!Array.isArray(data.sourceFolders)) await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    const operation = this.writes.then(async () => {
      // Serialize only when this write reaches the head of the queue. A burst of frame events
      // must not retain one full repository snapshot per queued write in memory.
      const snapshot = JSON.stringify(this.state);
      const tempPath = `${this.filePath}.${process.pid}.${++this.writeSequence}.tmp`;
      try {
        await writeFile(tempPath, snapshot, "utf8");
        for (let attempt = 1; ; attempt++) {
          try {
            await this.renameFile(tempPath, this.filePath);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
            if (!transient || attempt >= this.renameMaxAttempts) throw error;
            await new Promise((resolve) => setTimeout(resolve, this.renameRetryDelayMs * attempt));
          }
        }
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
    // Keep the returned operation rejecting for its caller, but recover the serialization tail
    // so one failed write cannot permanently poison every subsequent repository mutation.
    this.writes = operation.catch((error) => {
      try { this.onPersistenceError(error); } catch { /* diagnostics must not poison the queue */ }
    });
    return operation;
  }
  private serializeFeedbackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.feedbackMutations.then(operation);
    this.feedbackMutations = result.then(() => undefined, () => undefined);
    return result;
  }
  private async awaitOrganization(): Promise<void> {
    // Capture the barrier before yielding on readiness so a write that began first
    // cannot accidentally wait behind an organization operation that is waiting for it.
    const barrier = this.organizationWrites;
    await this.ready;
    await barrier;
  }

  async getLibrarySnapshot(): Promise<SourceLibrarySnapshot> {
    await this.ready;
    // Organization changes are transactional from readers' perspective: never expose
    // a membership/order snapshot that may still be rolled back after a failed save.
    await this.organizationWrites;
    return { sources: structuredClone(this.state.sources), folders: structuredClone(this.state.sourceFolders ?? []) };
  }
  async listSources(): Promise<Source[]> { return (await this.getLibrarySnapshot()).sources; }
  private captureOrganization(): { folders: SourceFolder[]; sourceOrder: string[]; folderIds: Map<string, string | undefined> } {
    return {
      folders: structuredClone(this.state.sourceFolders ?? []),
      sourceOrder: this.state.sources.map((source) => source.id),
      folderIds: new Map(this.state.sources.map((source) => [source.id, source.folderId]))
    };
  }
  private restoreOrganization(snapshot: ReturnType<DiskSourceRepository["captureOrganization"]>): void {
    this.state.sourceFolders = structuredClone(snapshot.folders);
    const currentById = new Map(this.state.sources.map((source) => [source.id, source]));
    for (const [sourceId, folderId] of snapshot.folderIds) {
      const source = currentById.get(sourceId);
      if (!source) continue;
      if (folderId === undefined) delete source.folderId;
      else source.folderId = folderId;
    }
    const priorIds = new Set(snapshot.sourceOrder);
    const restoredOrder = snapshot.sourceOrder.flatMap((sourceId) => {
      const source = currentById.get(sourceId);
      return source ? [source] : [];
    });
    // Keep concurrently created sources in their current relative order at the tail;
    // deleted rows remain deleted and are never recreated from the rollback snapshot.
    restoredOrder.push(...this.state.sources.filter((source) => !priorIds.has(source.id)));
    this.state.sources = restoredOrder;
  }
  private async mutateOrganization(mutate: () => void): Promise<SourceLibrarySnapshot> {
    const operation = this.organizationWrites.then(async () => {
      await this.ready;
      await this.writes;
      const before = this.captureOrganization();
      try {
        mutate();
        await this.persist();
        return { sources: structuredClone(this.state.sources), folders: structuredClone(this.state.sourceFolders) };
      } catch (error) {
        this.restoreOrganization(before);
        throw error;
      }
    });
    this.organizationWrites = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private assertFolderNameAvailable(name: string, excludedId?: string): void {
    const normalized = name.trim().toLocaleLowerCase("en-US");
    if (this.state.sourceFolders.some((folder) => folder.id !== excludedId && folder.name.toLocaleLowerCase("en-US") === normalized)) {
      throw new SourceFolderOperationError(409, "A folder with this name already exists");
    }
  }
  async createSourceFolder(folder: SourceFolder): Promise<SourceLibrarySnapshot> {
    return this.mutateOrganization(() => {
      this.assertFolderNameAvailable(folder.name);
      this.state.sourceFolders.push({ ...structuredClone(folder), name: folder.name.trim() });
    });
  }
  async renameSourceFolder(id: string, name: string): Promise<SourceLibrarySnapshot> {
    return this.mutateOrganization(() => {
      const folder = this.state.sourceFolders.find((item) => item.id === id);
      if (!folder) throw new SourceFolderOperationError(404, "Folder not found");
      this.assertFolderNameAvailable(name, id);
      folder.name = name.trim();
    });
  }
  async deleteSourceFolder(id: string): Promise<SourceLibrarySnapshot> {
    return this.mutateOrganization(() => {
      if (!this.state.sourceFolders.some((item) => item.id === id)) throw new SourceFolderOperationError(404, "Folder not found");
      this.state.sourceFolders = this.state.sourceFolders.filter((item) => item.id !== id);
      for (const source of this.state.sources) if (source.folderId === id) delete source.folderId;
    });
  }
  async organizeSource(id: string, folderId: string | null, beforeSourceId?: string | null): Promise<SourceLibrarySnapshot> {
    return this.mutateOrganization(() => {
      const currentIndex = this.state.sources.findIndex((source) => source.id === id);
      if (currentIndex < 0) throw new SourceFolderOperationError(404, "Source not found");
      if (folderId !== null && !this.state.sourceFolders.some((folder) => folder.id === folderId)) {
        throw new SourceFolderOperationError(404, "Folder not found");
      }
      if (beforeSourceId === id) throw new SourceFolderOperationError(400, "A source cannot be moved before itself");
      const anchor = beforeSourceId ? this.state.sources.find((source) => source.id === beforeSourceId) : undefined;
      if (beforeSourceId && !anchor) throw new SourceFolderOperationError(404, "Destination source not found");
      if (anchor && (anchor.folderId ?? null) !== folderId) {
        throw new SourceFolderOperationError(400, "Destination source must belong to the target folder");
      }
      const [source] = this.state.sources.splice(currentIndex, 1);
      if (!source) throw new SourceFolderOperationError(404, "Source not found");
      if (folderId === null) delete source.folderId;
      else source.folderId = folderId;
      let insertionIndex: number;
      if (anchor) {
        insertionIndex = this.state.sources.findIndex((item) => item.id === anchor.id);
        if (insertionIndex < 0) throw new SourceFolderOperationError(404, "Destination source not found");
      } else {
        insertionIndex = -1;
        for (let index = 0; index < this.state.sources.length; index++) {
          if ((this.state.sources[index]!.folderId ?? null) === folderId) insertionIndex = index;
        }
        insertionIndex = insertionIndex < 0 ? this.state.sources.length : insertionIndex + 1;
      }
      this.state.sources.splice(insertionIndex, 0, source);
    });
  }
  async getSource(id: string): Promise<Source | undefined> { await this.ready; await this.organizationWrites; const item = this.state.sources.find((s) => s.id === id); return item ? structuredClone(item) : undefined; }
  async putSource(source: Source): Promise<void> {
    await this.awaitOrganization();
    const index = this.state.sources.findIndex((s) => s.id === source.id);
    if (index < 0) this.state.sources.push(structuredClone(source));
    else {
      const current = this.state.sources[index]!;
      const merged: Source = { ...source, name: current.name };
      if (current.location === undefined) delete merged.location;
      else merged.location = structuredClone(current.location);
      if (current.folderId === undefined) delete merged.folderId;
      else merged.folderId = current.folderId;
      this.state.sources[index] = structuredClone(merged);
    }
    await this.persist();
  }
  async setLocation(id: string, location: Source["location"] | undefined): Promise<Source | undefined> {
    await this.awaitOrganization();
    const source = this.state.sources.find((item) => item.id === id);
    if (!source) return undefined;
    if (location === undefined) delete source.location;
    else source.location = structuredClone(location);
    await this.persist();
    const current = this.state.sources.find((item) => item.id === id);
    return current ? structuredClone(current) : undefined;
  }
  async renameSource(id: string, name: string): Promise<Source | undefined> {
    await this.awaitOrganization();
    const source = this.state.sources.find((item) => item.id === id);
    if (!source) return undefined;
    source.name = name;
    await this.persist();
    const current = this.state.sources.find((item) => item.id === id);
    return current ? structuredClone(current) : undefined;
  }
  async deleteSource(id: string): Promise<void> {
    return this.serializeFeedbackMutation(async () => {
      await this.awaitOrganization();
      this.state.sources = this.state.sources.filter((s) => s.id !== id);
      delete this.state.scenes[id]; delete this.state.events[id]; delete this.state.assets[id];
      for (const [key, sourceId] of Object.entries(this.state.uploadRequests)) if (sourceId === id) delete this.state.uploadRequests[key];
      delete this.state.eventIds[id]; delete this.state.aggregates[id]; delete this.state.historyTruncated[id]; delete this.state.discardedEventCount[id];
      delete this.state.uniqueVehicles?.[id]; this.uniqueIndexes.delete(id);
      for (const [reportId, report] of Object.entries(this.state.feedbackReports ?? {})) if (report.sourceId === id) delete this.state.feedbackReports![reportId];
      await this.persist();
      this.eventIdSets.delete(id);
    });
  }
  async getScene(id: string): Promise<Scene> { await this.ready; return structuredClone(this.state.scenes[id] ?? { zones: [], countingLines: [] }); }
  async putScene(id: string, scene: Scene): Promise<void> {
    await this.awaitOrganization();
    const previous = this.state.scenes[id] ?? { zones: [], countingLines: [] };
    const before = sceneGeometryParts(previous), after = sceneGeometryParts(scene);
    this.state.scenes[id] = structuredClone(scene);
    if (before.zones !== after.zones || before.lines !== after.lines) this.rebuildUniqueIndexes(id, before.zones !== after.zones, before.lines !== after.lines);
    else this.refreshUniqueGeometrySignature(id);
    if (this.uniqueIndexes.has(id)) this.syncUniqueIndexes(id);
    await this.persist();
  }
  async appendEvent(id: string, event: AnalysisEvent): Promise<void> {
    await this.awaitOrganization();
    const items = this.state.events[id] ?? (this.state.events[id] = []);
    const eventIds = this.state.eventIds[id] ?? (this.state.eventIds[id] = []);
    // The worker bridge is local and emits each frame once. Retained IDs make duplicate writes idempotent
    // across retries/restarts without allowing the dedupe index to grow past the bounded event window.
    const knownIds = this.eventIdSets.get(id) ?? (this.eventIdSets.set(id, new Set(eventIds)), this.eventIdSets.get(id)!);
    if (knownIds.has(event.id)) { await this.persist(); return; }
    knownIds.add(event.id);
    eventIds.push(event.id);
    items.push(structuredClone(event));
    this.recordAggregateEvent(id, event);
    this.updateUniqueIndex(id, event);
    if (items.length > 20_000) {
      const discarded = items.length - 20_000;
      items.splice(0, discarded);
      this.state.historyTruncated[id] = true;
      this.state.discardedEventCount[id] = (this.state.discardedEventCount[id] ?? 0) + discarded;
      const retainedIds = items.map((item) => item.id);
      this.state.eventIds[id] = retainedIds;
      this.eventIdSets.set(id, new Set(retainedIds));
    }
    this.syncUniqueIndexes(id);
    await this.persist();
  }
  private sceneFor(id: string): Scene { return this.state.scenes[id] ?? { zones: [], countingLines: [] }; }
  private indexMap(id: string): Map<string, RuntimeUniqueIndex> {
    let sessions = this.uniqueIndexes.get(id);
    if (!sessions) { sessions = new Map(); this.uniqueIndexes.set(id, sessions); }
    return sessions;
  }
  private makeUniqueIndex(id: string, sessionId: string): RuntimeUniqueIndex {
    const scene = this.sceneFor(id), parts = sceneGeometryParts(scene);
    return {
      sessionId, geometrySignature: sceneGeometrySignature(scene), zoneGeometrySignature: parts.zones, lineGeometrySignature: parts.lines,
      allTrackIds: new Set(), zoneTrackIds: new Map(scene.zones.map((zone) => [zone.id, new Set<string>()])),
      lineTrackIds: new Map(scene.countingLines.map((line) => [line.id, new Set<string>()])),
      hasKnownCoverage: false, allComplete: true, zonesComplete: true, linesComplete: true
    };
  }
  private ensureUniqueIndex(id: string, sessionId: string): RuntimeUniqueIndex {
    const sessions = this.indexMap(id);
    let index = sessions.get(sessionId);
    if (!index) { index = this.makeUniqueIndex(id, sessionId); sessions.set(sessionId, index); }
    return index;
  }
  private hydrateUniqueIndexes(): void {
    this.uniqueIndexes.clear();
    for (const [sourceId, records] of Object.entries(this.state.uniqueVehicles ?? {})) {
      const sessions = this.indexMap(sourceId);
      for (const record of records) sessions.set(record.sessionId, {
        ...record, allTrackIds: new Set(record.allTrackIds),
        zoneTrackIds: new Map(record.zoneTrackIds.map((item) => [item.id, new Set(item.trackIds)])),
        lineTrackIds: new Map(record.lineTrackIds.map((item) => [item.id, new Set(item.trackIds)]))
      });
    }
  }
  private syncUniqueIndexes(id: string): void {
    const records = [...(this.uniqueIndexes.get(id)?.values() ?? [])].map((index) => ({
      ...index,
      allTrackIds: [...index.allTrackIds].sort(),
      zoneTrackIds: [...index.zoneTrackIds].map(([scopeId, ids]) => ({ id: scopeId, trackIds: [...ids].sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      lineTrackIds: [...index.lineTrackIds].map(([scopeId, ids]) => ({ id: scopeId, trackIds: [...ids].sort() })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }));
    if (!this.state.uniqueVehicles) this.state.uniqueVehicles = {};
    this.state.uniqueVehicles[id] = records;
  }
  private backfillUniqueIndexes(): void {
    this.uniqueIndexes.clear();
    for (const [sourceId, events] of Object.entries(this.state.events)) {
      for (const event of events) this.updateUniqueIndex(sourceId, event);
      const sessions = this.state.aggregates[sourceId] ?? {};
      for (const aggregate of Object.values(sessions)) {
        if (!this.indexMap(sourceId).has(aggregate.sessionId)) {
          const index = this.makeUniqueIndex(sourceId, aggregate.sessionId);
          index.hasKnownCoverage = aggregate.qualityKnown;
          if (this.state.historyTruncated[sourceId]) index.allComplete = index.zonesComplete = index.linesComplete = false;
          this.indexMap(sourceId).set(aggregate.sessionId, index);
        }
      }
      // Legacy truncation predates these per-session indexes, so we cannot know which
      // retained session lost rows. Keep every migrated legacy session as a lower bound.
      if (this.state.historyTruncated[sourceId]) {
        for (const index of this.indexMap(sourceId).values()) index.allComplete = index.zonesComplete = index.linesComplete = false;
      }
      this.syncUniqueIndexes(sourceId);
    }
  }
  private updateUniqueIndex(id: string, event: AnalysisEvent): void {
    const index = this.ensureUniqueIndex(id, event.sessionId);
    this.addUniqueObservation(index, event, this.sceneFor(id), { zones: true, lines: true });
  }
  private addUniqueObservation(index: RuntimeUniqueIndex, event: AnalysisEvent, scene: Scene, scopes: { zones: boolean; lines: boolean }): void {
    const notes = event.quality.notes.join(" ").toLowerCase();
    if (event.quality.coverage !== "known") {
      if (scopes.zones) index.allComplete = index.zonesComplete = false;
      if (scopes.lines) index.linesComplete = false;
      return;
    }
    index.hasKnownCoverage = true;
    if (notes.includes("counting_line_regions_only")) {
      if (scopes.zones) index.allComplete = index.zonesComplete = false;
      if (scopes.lines) index.linesComplete = false;
    }
    const nonblank = (value: string): boolean => value.trim().length > 0;
    if (scopes.zones) {
      for (const detection of event.detections) {
        const trackId = detection.trackId;
        if (!["car", "truck", "bus", "motorcycle", "bicycle"].includes(detection.class.toLowerCase())) continue;
        if (!trackId || !nonblank(trackId)) continue;
        const centerX = detection.bbox.x + detection.bbox.width / 2;
        const centerY = detection.bbox.y + detection.bbox.height / 2;
        const containing = scene.zones.filter((zone) => pointInPolygon(centerX, centerY, zone.polygon));
        if (scene.zones.length === 0 || containing.length > 0) index.allTrackIds.add(trackId);
        for (const zone of containing) {
          let ids = index.zoneTrackIds.get(zone.id);
          if (!ids) { ids = new Set(); index.zoneTrackIds.set(zone.id, ids); }
          ids.add(trackId);
        }
      }
    }
    if (scopes.lines) {
      for (const crossing of event.crossings) {
        if (!nonblank(crossing.trackId) || !scene.countingLines.some((line) => line.id === crossing.lineId)) continue;
        let ids = index.lineTrackIds.get(crossing.lineId);
        if (!ids) { ids = new Set(); index.lineTrackIds.set(crossing.lineId, ids); }
        ids.add(crossing.trackId);
      }
    }
  }
  private rebuildUniqueIndexes(id: string, rebuildZones: boolean, rebuildLines: boolean): void {
    const scene = this.sceneFor(id), parts = sceneGeometryParts(scene), truncated = this.state.historyTruncated[id] === true;
    const sessions = this.indexMap(id);
    const retained = this.state.events[id] ?? [];
    for (const index of sessions.values()) {
      if (rebuildZones) {
        index.allTrackIds.clear(); index.zoneTrackIds = new Map(scene.zones.map((zone) => [zone.id, new Set<string>()]));
        index.allComplete = !truncated; index.zonesComplete = !truncated;
      }
      if (rebuildLines) {
        index.lineTrackIds = new Map(scene.countingLines.map((line) => [line.id, new Set<string>()]));
        index.linesComplete = !truncated;
      }
      index.zoneGeometrySignature = parts.zones; index.lineGeometrySignature = parts.lines;
      index.geometrySignature = sceneGeometrySignature(scene);
    }
    for (const event of retained) {
      const index = sessions.get(event.sessionId);
      if (index) this.addUniqueObservation(index, event, scene, { zones: rebuildZones, lines: rebuildLines });
    }
  }
  private refreshUniqueGeometrySignature(id: string): void {
    const scene = this.sceneFor(id), parts = sceneGeometryParts(scene);
    for (const index of this.uniqueIndexes.get(id)?.values() ?? []) {
      index.geometrySignature = sceneGeometrySignature(scene); index.zoneGeometrySignature = parts.zones; index.lineGeometrySignature = parts.lines;
    }
  }
  private summarizeUniqueIndex(id: string, sessionId: string): UniqueVehiclesSummary {
    const index = this.ensureUniqueIndex(id, sessionId), scene = this.sceneFor(id);
    const status = (count: number, hasCoverage: boolean, complete: boolean) => ({ count: hasCoverage ? count : null, completeness: (hasCoverage ? complete ? "known" : "partial" : "unknown") as "known" | "partial" | "unknown" });
    const all = status(index.allTrackIds.size, index.hasKnownCoverage, index.allComplete);
    const zones = scene.zones.map((zone) => {
      const ids = index.zoneTrackIds.get(zone.id);
      return { zoneId: zone.id, ...status(ids?.size ?? 0, index.hasKnownCoverage, index.zonesComplete) };
    });
    const lines = scene.countingLines.map((line) => {
      const ids = index.lineTrackIds.get(line.id);
      return { lineId: line.id, ...status(ids?.size ?? 0, index.hasKnownCoverage, index.linesComplete) };
    });
    const statuses = [all.completeness, ...zones.map((item) => item.completeness), ...lines.map((item) => item.completeness)];
    const completeness = statuses.includes("partial") ? "partial" : statuses.includes("known") ? "known" : "unknown";
    return { sessionId, geometrySignature: sceneGeometrySignature(scene), completeness, all, zones, lines,
      note: "Distinct tracked IDs observed in sampled frames; IDs may fragment or be reused." };
  }
  private recordAggregateEvent(id: string, event: AnalysisEvent): void {
    const sessions = this.state.aggregates[id] ?? (this.state.aggregates[id] = {});
    const aggregate = sessions[event.sessionId] ?? (sessions[event.sessionId] = {
      sessionId: event.sessionId, crossings: {}, minTimeMs: event.sourceTimeMs, maxTimeMs: event.sourceTimeMs,
      lastTimeMs: event.sourceTimeMs, latestDetections: [], qualityKnown: false, clockReset: false
    });
    if (event.sourceTimeMs < aggregate.lastTimeMs) aggregate.clockReset = true;
    aggregate.lastTimeMs = event.sourceTimeMs;
    aggregate.minTimeMs = Math.min(aggregate.minTimeMs, event.sourceTimeMs);
    aggregate.maxTimeMs = Math.max(aggregate.maxTimeMs, event.sourceTimeMs);
    aggregate.latestDetections = structuredClone(event.detections);
    aggregate.qualityKnown ||= event.quality.coverage === "known";
    for (const crossing of event.crossings) {
      const key = `${crossing.lineId}\u0000${crossing.direction}`;
      aggregate.crossings[key] = (aggregate.crossings[key] ?? 0) + 1;
    }
  }
  async getEvents(id: string): Promise<AnalysisEvent[]> { await this.ready; return structuredClone(this.state.events[id] ?? []); }
  async listFeedbackReports(sourceId: string): Promise<DetectionFeedback[]> {
    await this.ready;
    return Object.values(this.state.feedbackReports ?? {}).filter((report) => report.sourceId === sourceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((report) => structuredClone(report));
  }
  async getFeedbackReport(sourceId: string, reportId: string): Promise<DetectionFeedback | undefined> {
    await this.ready;
    const report = this.state.feedbackReports?.[reportId];
    return report?.sourceId === sourceId ? structuredClone(report) : undefined;
  }
  async putFeedbackReport(report: DetectionFeedback): Promise<void> {
    return this.serializeFeedbackMutation(async () => {
      await this.awaitOrganization();
      const reports = this.state.feedbackReports ?? (this.state.feedbackReports = {});
      if (!this.state.sources.some((source) => source.id === report.sourceId)) throw new Error("Feedback source no longer exists");
      if (!reports[report.id] && (Object.values(reports).filter((item) => item.sourceId === report.sourceId).length >= 500 || Object.keys(reports).length >= 5_000)) throw new FeedbackCapacityError();
      const previous = reports[report.id];
      reports[report.id] = structuredClone(report);
      try { await this.persist(); }
      catch (error) {
        if (previous) reports[report.id] = previous;
        else delete reports[report.id];
        throw error;
      }
    });
  }
  async getAssetPath(id: string): Promise<string | undefined> { await this.ready; return this.state.assets[id]; }
  async setAssetPath(id: string, assetPath: string): Promise<void> { await this.awaitOrganization(); this.state.assets[id] = assetPath; await this.persist(); }
  async commitUpload(source: Source, assetPath: string, idempotencyKey?: string): Promise<{ source: Source; created: boolean }> {
    await this.awaitOrganization();
    const existingId = idempotencyKey ? this.state.uploadRequests[idempotencyKey] : undefined;
    const existing = existingId ? this.state.sources.find((item) => item.id === existingId) : undefined;
    if (existing) return { source: structuredClone(existing), created: false };
    this.state.sources.push(structuredClone(source));
    this.state.assets[source.id] = assetPath;
    if (idempotencyKey) this.state.uploadRequests[idempotencyKey] = source.id;
    await this.persist();
    return { source: structuredClone(source), created: true };
  }
  async getAggregate(id: string, sessionId?: string): Promise<SourceAggregate> {
    await this.ready;
    const sessions = Object.values(this.state.aggregates[id] ?? {});
    const latestSession = sessionId ? this.state.aggregates[id]?.[sessionId] : sessions.at(-1);
    const uniqueSessionId = sessionId ?? latestSession?.sessionId;
    const uniqueVehicles = uniqueSessionId ? this.summarizeUniqueIndex(id, uniqueSessionId) : undefined;
    return {
      latestSession: latestSession ? structuredClone(latestSession) : undefined,
      ...(sessionId ? { requestedSessionId: sessionId } : {}),
      historyTruncated: this.state.historyTruncated[id] === true,
      ...(Object.hasOwn(this.state.discardedEventCount, id) ? { discardedEventCount: this.state.discardedEventCount[id] } : {})
      , ...(uniqueVehicles ? { uniqueVehicles } : {})
    };
  }
}

export function buildSummary(sourceId: string, events: AnalysisEvent[], aggregate?: SourceAggregate): Summary {
  const mostRecentSession = events.at(-1)?.sessionId;
  const sessionAggregate = aggregate?.latestSession;
  const latestSessionId = sessionAggregate?.sessionId ?? aggregate?.requestedSessionId ?? mostRecentSession;
  const sessionEvents = latestSessionId ? events.filter((event) => event.sessionId === latestSessionId) : [];
  const lineCounts = new Map<string, number>();
  if (sessionAggregate) {
    for (const [key, count] of Object.entries(sessionAggregate.crossings)) lineCounts.set(key, count);
  } else {
    for (const event of sessionEvents) {
      for (const crossing of event.crossings) {
        const key = `${crossing.lineId}\u0000${crossing.direction}`;
        lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const lastEvent = sessionEvents.at(-1);
  const counts = [...lineCounts].map(([key, count]) => {
    const [lineId, direction] = key.split("\u0000");
    return { lineId: lineId!, direction: direction!, count };
  });
  const known = sessionAggregate?.qualityKnown ?? (sessionEvents.length > 0 && sessionEvents.some((e) => e.quality.coverage === "known"));
  const latestDetections = sessionAggregate?.latestDetections ?? lastEvent?.detections;
  const historyTruncated = aggregate?.historyTruncated ?? false;
  return {
    sourceId,
    ...(latestSessionId ? { sessionId: latestSessionId } : {}),
    visibleVehicleCount: known && latestDetections ? latestDetections.filter((d) => ["car", "truck", "bus", "motorcycle", "bicycle"].includes(d.class.toLowerCase())).length : null,
    crossings: counts,
    coverage: known ? "known" : "unknown",
    analyzedDurationMs: sessionAggregate ? sessionAggregate.clockReset ? null : sessionAggregate.maxTimeMs - sessionAggregate.minTimeMs : sessionEvents.length > 1 ? Math.max(0, (lastEvent?.sourceTimeMs ?? 0) - (sessionEvents[0]?.sourceTimeMs ?? 0)) : sessionEvents.length === 1 ? 0 : null,
    historyTruncated,
    discardedEventCount: aggregate?.discardedEventCount ?? (historyTruncated ? null : 0),
    ...(aggregate?.uniqueVehicles ? { uniqueVehicles: aggregate.uniqueVehicles } : {}),
    ...(!known ? { note: "No analyzed frames are available for this source." } : historyTruncated ? { note: aggregate?.discardedEventCount === undefined ? "Older event history is truncated; the discarded count is unavailable. Crossing totals remain cumulative for this session." : `The newest 20,000 events are retained; ${aggregate.discardedEventCount} older events were discarded. Crossing totals remain cumulative for this session.` } : {})
  };
}

function pointInPolygon(x: number, y: number, polygon: Scene["zones"][number]["polygon"]): boolean {
  const epsilon = 1e-10;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!;
    const cross = (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
    const within = x >= Math.min(a.x, b.x) - epsilon && x <= Math.max(a.x, b.x) + epsilon && y >= Math.min(a.y, b.y) - epsilon && y <= Math.max(a.y, b.y) + epsilon;
    if (Math.abs(cross) <= epsilon && within) return true;
    const intersects = (a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
