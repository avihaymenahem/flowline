import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lookup } from "node:dns/promises";
import net from "node:net";
import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import multer from "multer";
import { z } from "zod";
import {
  AnalysisEventSchema, DetectionFeedbackRequestSchema, DetectionFeedbackSchema, DetectionFeedbackUpdateSchema,
  FeedbackDraftResponseSchema, FeedbackListResponseSchema, HealthSchema, SceneSchema, SourceFolderSchema, SourceFoldersResponseSchema, SourceLocationSchema, SourceSchema, SummaryResponseSchema, TrackPageResponseSchema,
  type AnalysisEvent, type DetectionFeedback, type FeedbackDraft, type Scene, type Source, type SourceFolder, type SourceKind
} from "@traffic/contracts";
import { buildSummary, DiskSourceRepository, FeedbackCapacityError, SourceFolderOperationError, type SourceRepository } from "./repository.js";
import { canonicalizeOffsetDateTime, inspectMediaMetadata, type ExtractedMediaMetadata } from "./mediaMetadata.js";
import { DisabledWorker, WorkerUnavailableError, type WorkerClient } from "./worker.js";

export type AppOptions = {
  repository?: SourceRepository;
  worker?: WorkerClient;
  dataDir?: string;
  uploadDir?: string;
  previewDir?: string;
  maxUploadBytes?: number;
  visionModelPath?: string;
  /** Injectable bounded metadata reader for deterministic API tests. */
  metadataInspector?: (filePath: string) => Promise<ExtractedMediaMetadata>;
  /** Receives schema paths only; worker payload values are never included. */
  onInvalidWorkerEvent?: (paths: string[]) => void;
  /** Narrow additional browser origins for isolated local QA services. */
  additionalCorsOrigins?: string[];
};

export type TrafficApp = express.Express & { closeResources(): Promise<void> };

const MAX_ALLOWED_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_PREVIEW_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_PENDING_PREVIEWS_PER_SOURCE = 32;
const MAX_CACHED_PREVIEW_FRAMES_PER_SOURCE = 4;
const MAX_CACHED_PREVIEW_SOURCES = 6;
const MAX_PREVIEW_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_NATIVE_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_NATIVE_FRAME_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_FRAME_CACHE_FILES = 240;
const MAX_FEEDBACK_EVIDENCE_BYTES = 256 * 1024 * 1024;
const MAX_FEEDBACK_DRAFTS = 32;
const FEEDBACK_DRAFT_TTL_MS = 15 * 60 * 1000;
const RESTARTED_SOURCE_ERROR = "API restarted while this source was running. Start it again to resume analysis.";

function sourceWithStatus(source: Source, status: Source["status"], error?: string): Source {
  const updated: Record<string, unknown> = { ...source, status };
  if (error) updated.error = error.slice(0, 1000);
  else delete updated.error;
  return SourceSchema.parse(updated);
}

async function persistSourceAndRead(repository: SourceRepository, source: Source): Promise<Source | undefined> {
  await repository.putSource(source);
  return repository.getSource(source.id);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SourceFolderNameRequestSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const SourceOrganizationRequestSchema = z.object({
  folderId: z.string().uuid().nullable(),
  beforeSourceId: z.string().uuid().nullable().optional()
}).strict();

function sourceFolderHttpError(error: unknown): never {
  if (error instanceof SourceFolderOperationError) throw new HttpError(error.statusCode, error.message);
  throw error;
}

function isSafeLocalAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0 || a === 169 && b === 254 || a === 192 && b === 168 || a === 172 && b! >= 16 && b! <= 31 || a! >= 224) return true;
    return false;
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isSafeLocalAddress(normalized.slice(7));
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }
  return false;
}

async function validateLocalStreamUrl(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "Stream URL is invalid"); }
  if (!["http:", "https:", "rtsp:", "rtsps:"].includes(url.protocol) || url.username || url.password) throw new HttpError(400, "Stream URL must use HTTP(S) or RTSP(S) without embedded credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (net.isIP(hostname)) addresses = [hostname];
  else {
    try { addresses = (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address); }
    catch { throw new HttpError(400, "Stream host could not be resolved on the local network"); }
  }
  if (!addresses.length || addresses.some((address) => !isSafeLocalAddress(address))) throw new HttpError(400, "Stream URLs must resolve only to loopback or private local-network addresses");
  return url.toString();
}

function normalizeYouTubeUrl(raw: string): { videoId: string; url: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError(400, "YouTube URL is invalid"); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new HttpError(400, "Enter a public YouTube video link");
  }
  let videoId = "";
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(hostname)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") {
      const ids = url.searchParams.getAll("v");
      videoId = ids.length === 1 ? ids[0]! : "";
    } else if (parts.length === 2 && parts[0] === "live") videoId = parts[1]!;
  } else if (hostname === "youtu.be") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1) videoId = parts[0]!;
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    throw new HttpError(400, "Enter a YouTube watch, live, or youtu.be link with a valid video ID");
  }
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

type PreviewMetadata = { sourceId: string; sessionId: string; sourceTimeMs: number; frameId: string; width: number; height: number };
type CachedPreview = { metadata: PreviewMetadata; bytes: Buffer; storedAt: number };
type PendingFeedbackDraft = { data: FeedbackDraft; imagePath?: string; expiresAtMs: number };
type PendingPreview = { metadata: PreviewMetadata; bytes: Buffer; durable: Promise<boolean>; enqueuedAt: number };
type PreviewDiagnostics = {
  updatedAt: number;
  notifications: number;
  invalidMetadata: number;
  inactiveSession: number;
  analysisMismatch: number;
  fileCopyFailures: Record<string, number>;
  copied: number;
  enqueued: number;
  budgetRejected: number;
  pendingEvicted: number;
  durableCompleted: number;
  durableFailed: number;
  queueWaitTotalMs: number;
  queueWaitMaxMs: number;
  durableWaitTotalMs: number;
  durableWaitMaxMs: number;
  published: number;
  publishRejected: Record<string, number>;
  latestReceivedSourceTimeMs?: number;
  latestCopiedSourceTimeMs?: number;
  latestEnqueuedSourceTimeMs?: number;
  latestPublishedSourceTimeMs?: number;
};
function isPreviewMetadata(value: unknown): value is PreviewMetadata & Record<string, unknown> {
  return isRecord(value) && typeof value.sourceId === "string" && typeof value.sessionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId) &&
    typeof value.frameId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.frameId) &&
    typeof value.sourceTimeMs === "number" && Number.isFinite(value.sourceTimeMs) && value.sourceTimeMs >= 0 &&
    typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0 &&
    typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "HttpError"; }
}

const acceptedVideos: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi" };
const jpegSignature = (buffer: Buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (!jpegSignature(buffer)) return undefined;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset++]!;
    if (marker === 0xd8 || marker === 0xd9 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length;
  }
  return undefined;
}

function parsePageQuery(query: express.Request["query"]): { offset: number; limit: number } {
  const rawLimit = typeof query.limit === "string" ? Number(query.limit) : 50;
  const rawOffset = typeof query.cursor === "string" ? Number(query.cursor) : 0;
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100 || !Number.isSafeInteger(rawOffset) || rawOffset < 0) {
    throw new HttpError(400, "cursor must be a non-negative offset and limit must be between 1 and 100");
  }
  return { offset: rawOffset, limit: rawLimit };
}
const videoSignatureOk = (mime: string, bytes: Buffer) => {
  if (mime === "video/mp4" || mime === "video/quicktime") return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (mime === "video/webm" || mime === "video/x-matroska") return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === "video/x-msvideo") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "AVI ";
  return false;
};

function withMediaMetadata(source: Source, metadata: ExtractedMediaMetadata): Source {
  const updated: Record<string, unknown> = { ...source };
  if (metadata.width !== undefined) updated.width = metadata.width;
  if (metadata.height !== undefined) updated.height = metadata.height;
  if (metadata.durationMs !== undefined) updated.durationMs = metadata.durationMs;
  const prior = source.recordingTime;
  if (prior?.provenance === "manual_override") {
    updated.recordingTime = {
      effectiveStartAt: prior.effectiveStartAt,
      provenance: "manual_override",
      ...((metadata.recordingTime?.embeddedStartAt ?? prior.embeddedStartAt) ? { embeddedStartAt: metadata.recordingTime?.embeddedStartAt ?? prior.embeddedStartAt } : {}),
      ...((metadata.recordingTime?.embeddedField ?? prior.embeddedField) ? { embeddedField: metadata.recordingTime?.embeddedField ?? prior.embeddedField } : {})
    };
  } else if (metadata.recordingTime) updated.recordingTime = metadata.recordingTime;
  return SourceSchema.parse(updated);
}

export function createApp(options: AppOptions = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.API_DATA_DIR ?? "./data");
  const uploadDir = path.resolve(options.uploadDir ?? process.env.API_UPLOAD_DIR ?? "./uploads");
  const ownsPreviewDir = options.previewDir === undefined;
  const previewDir = path.resolve(options.previewDir ?? path.join(tmpdir(), `traffic-dash-youtube-preview-${process.pid}-${randomUUID()}`));
  const frameStagingDir = path.join(dataDir, "analysis-frame-staging");
  const nativeFrameDir = path.join(dataDir, "analysis-frames");
  const feedbackDraftDir = path.join(dataDir, "feedback-drafts");
  const feedbackEvidenceDir = path.join(dataDir, "feedback-evidence");
  const app = express() as TrafficApp;
  app.closeResources = async () => {
    const tempRoot = path.resolve(tmpdir());
    const safeOwnedName = /^traffic-dash-youtube-preview-\d+-[0-9a-f-]{36}$/i.test(path.basename(previewDir));
    if (ownsPreviewDir && path.dirname(previewDir) === tempRoot && safeOwnedName) {
      await rm(previewDir, { recursive: true, force: true });
    }
  };
  const configuredMaxUploadBytes = options.maxUploadBytes ?? Number(process.env.API_MAX_UPLOAD_MB ?? 4096) * 1024 * 1024;
  if (!Number.isSafeInteger(configuredMaxUploadBytes) || configuredMaxUploadBytes < 1024 * 1024 || configuredMaxUploadBytes > MAX_ALLOWED_UPLOAD_BYTES) {
    throw new Error("API upload limit must be between 1 MiB and 16384 MiB");
  }
  const maxUploadBytes = configuredMaxUploadBytes;
  const repository = options.repository ?? new DiskSourceRepository(dataDir);
  const metadataInspector = options.metadataInspector ?? inspectMediaMetadata;
  const worker = options.worker ?? new DisabledWorker();
  const streamSubscribers = new Map<string, Set<express.Response>>();
  const framesInFlight = new Set<string>();
  const startsInProgress = new Set<string>();
  const stopsInProgress = new Set<string>();
  const stoppingSessions = new Map<string, string>();
  const activeSessions = new Map<string, string>();
  const probesInProgress = new Set<string>();
  const pendingWorkerWrites = new Map<string, {
    tail: Promise<void>;
    failure?: unknown;
    lastAnalysis?: { sessionId: string; sourceTimeMs: number; durable: Promise<boolean> } | undefined;
  }>();
  const pendingFrameEvents = new Map<string, { event: AnalysisEvent; durable: Promise<boolean> }>();
  const pendingFrameBytes = new Map<string, { sourceId: string; sessionId: string; sourceTimeMs: number; width: number; height: number; bytes: Buffer }>();
  const framePublications = new Map<string, Promise<void>>();
  const directFrameBytes = new Map<string, Buffer>();
  const feedbackDrafts = new Map<string, PendingFeedbackDraft>();
  const sourceMutationTails = new Map<string, Promise<void>>();
  const withSourceMutation = async <T>(sourceId: string, operation: () => Promise<T>): Promise<T> => {
    const prior = sourceMutationTails.get(sourceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => current);
    sourceMutationTails.set(sourceId, tail);
    await prior.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (sourceMutationTails.get(sourceId) === tail) sourceMutationTails.delete(sourceId);
    }
  };
  let feedbackDraftFilesScanned = false;
  const reportedWorkerEventIssues = new Set<string>();
  const previewBySource = new Map<string, PreviewMetadata>();
  const previewFrames = new Map<string, Map<string, CachedPreview>>();
  const pendingPreviewFrames = new Map<string, Map<string, PendingPreview>>();
  const previewDrainRunning = new Set<string>();
  const previewDrainFrame = new Map<string, string>();
  const previewDiagnostics = new Map<string, PreviewDiagnostics>();
  let previewCacheBytes = 0;
  const pruneExpiredFeedbackDrafts = async () => {
    const now = Date.now();
    if (!feedbackDraftFilesScanned) {
      feedbackDraftFilesScanned = true;
      await mkdir(feedbackDraftDir, { recursive: true });
      for (const name of await readdir(feedbackDraftDir)) {
        if (!/^[0-9a-f-]{36}\.jpg$/i.test(name)) continue;
        await rm(path.join(feedbackDraftDir, name), { force: true }).catch(() => undefined);
      }
    }
    for (const [id, draft] of feedbackDrafts) if (draft.expiresAtMs <= now) {
      feedbackDrafts.delete(id);
      if (draft.imagePath) await rm(draft.imagePath, { force: true }).catch(() => undefined);
    }
  };
  const publishNativeFrame = async (frameId: string) => {
    const eventRecord = pendingFrameEvents.get(frameId), candidate = pendingFrameBytes.get(frameId);
    if (!eventRecord || !candidate) return;
    pendingFrameEvents.delete(frameId); pendingFrameBytes.delete(frameId);
    const event = eventRecord.event;
    if (event.sourceId !== candidate.sourceId || event.sessionId !== candidate.sessionId || event.sourceTimeMs !== candidate.sourceTimeMs ||
      event.frameWidth !== candidate.width || event.frameHeight !== candidate.height || event.frameId !== frameId) return;
    if (!await eventRecord.durable) return;
    await mkdir(nativeFrameDir, { recursive: true });
    const files = (await readdir(nativeFrameDir)).filter((name) => /^[0-9a-f-]{36}\.jpg$/i.test(name));
    const rows: Array<{ name: string; size: number; mtime: number }> = [];
    for (const name of files) { try { const info = await stat(path.join(nativeFrameDir, name)); rows.push({ name, size: info.size, mtime: info.mtimeMs }); } catch { /* concurrently evicted */ } }
    rows.sort((a, b) => a.mtime - b.mtime);
    let total = rows.reduce((sum, row) => sum + row.size, 0);
    while (rows.length && (total + candidate.bytes.length > MAX_NATIVE_FRAME_CACHE_BYTES || rows.length >= MAX_NATIVE_FRAME_CACHE_FILES)) {
      const row = rows.shift()!;
      await rm(path.join(nativeFrameDir, row.name), { force: true }).catch(() => undefined);
      total -= row.size;
    }
    if (candidate.bytes.length > MAX_NATIVE_FRAME_BYTES || total + candidate.bytes.length > MAX_NATIVE_FRAME_CACHE_BYTES) return;
    const target = path.join(nativeFrameDir, `${frameId}.jpg`), temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, candidate.bytes, { flag: "wx" }); await rename(temp, target); }
    finally { await rm(temp, { force: true }).catch(() => undefined); }
  };
  const queueNativeFramePublish = (frameId: string) => {
    const publication = publishNativeFrame(frameId).catch((error) => { console.warn("Native analysis frame could not be cached", error); });
    framePublications.set(frameId, publication);
    void publication.finally(() => {
      if (framePublications.get(frameId) === publication) framePublications.delete(frameId);
    });
  };
  const rememberFrameEvent = (event: AnalysisEvent, durable: Promise<boolean>) => {
    if (!event.frameId) return;
    const frameId = event.frameId;
    while (pendingFrameEvents.size >= 64) pendingFrameEvents.delete(pendingFrameEvents.keys().next().value!);
    pendingFrameEvents.set(frameId, { event, durable });
    const pending = pendingFrameEvents.get(frameId);
    const timer = setTimeout(() => { if (pendingFrameEvents.get(frameId) === pending) pendingFrameEvents.delete(frameId); }, 120_000);
    timer.unref?.();
    queueNativeFramePublish(frameId);
  };
  const rememberFrameBytes = (frameId: string, metadata: { sourceId: string; sessionId: string; sourceTimeMs: number; width: number; height: number }, bytes: Buffer) => {
    if (bytes.length > MAX_NATIVE_FRAME_BYTES || !jpegSignature(bytes) || pendingFrameBytes.size >= 16 && !pendingFrameBytes.has(frameId)) return;
    pendingFrameBytes.set(frameId, { ...metadata, bytes });
    queueNativeFramePublish(frameId);
  };
  let previewStoredAt = 0;
  const previewDiag = (sourceId: string) => {
    let diag = previewDiagnostics.get(sourceId);
    if (!diag) {
      if (previewDiagnostics.size >= MAX_CACHED_PREVIEW_SOURCES) {
        let oldest: { sourceId: string; updatedAt: number } | undefined;
        for (const [id, value] of previewDiagnostics) if (!oldest || value.updatedAt < oldest.updatedAt) oldest = { sourceId: id, updatedAt: value.updatedAt };
        if (oldest) previewDiagnostics.delete(oldest.sourceId);
      }
      diag = { updatedAt: Date.now(), notifications: 0, invalidMetadata: 0, inactiveSession: 0,
        analysisMismatch: 0, fileCopyFailures: {}, copied: 0, enqueued: 0, budgetRejected: 0,
        pendingEvicted: 0, durableCompleted: 0, durableFailed: 0, durableWaitTotalMs: 0,
        queueWaitTotalMs: 0, queueWaitMaxMs: 0, durableWaitMaxMs: 0, published: 0, publishRejected: {} };
      previewDiagnostics.set(sourceId, diag);
    }
    diag.updatedAt = Date.now();
    return diag;
  };
  const countPreviewRejection = (sourceId: string, reason: string) => {
    const diag = previewDiag(sourceId);
    diag.publishRejected[reason] = (diag.publishRejected[reason] ?? 0) + 1;
  };
  const previewSessionKey = (sourceId: string, sessionId: string) => `${sourceId}:${sessionId}`;
  const previewFrameKey = (preview: PreviewMetadata) => `${preview.sessionId}:${preview.frameId}`;
  const removePendingPreview = (sourceId: string, frameKey: string, evicted = false) => {
    const frames = pendingPreviewFrames.get(sourceId);
    const old = frames?.get(frameKey);
    if (!old) return;
    if (evicted) previewDiag(sourceId).pendingEvicted += 1;
    frames!.delete(frameKey);
    previewCacheBytes -= old.bytes.length;
    if (!frames!.size) pendingPreviewFrames.delete(sourceId);
  };
  const removePublishedFrame = (sessionKey: string, frameId: string) => {
    const frames = previewFrames.get(sessionKey);
    const old = frames?.get(frameId);
    if (!old) return;
    frames!.delete(frameId);
    previewCacheBytes -= old.bytes.length;
    if (previewBySource.get(old.metadata.sourceId)?.frameId === frameId) previewBySource.delete(old.metadata.sourceId);
    if (!frames!.size) previewFrames.delete(sessionKey);
  };
  const removePublishedSource = (sourceId: string) => {
    for (const [key, frames] of previewFrames) {
      if (!key.startsWith(`${sourceId}:`)) continue;
      for (const cached of frames.values()) previewCacheBytes -= cached.bytes.length;
      previewFrames.delete(key);
    }
    previewBySource.delete(sourceId);
  };
  const removePendingSource = (sourceId: string) => {
    const frames = pendingPreviewFrames.get(sourceId);
    if (!frames) return;
    const activeFrame = previewDrainFrame.get(sourceId);
    for (const [frameKey, cached] of frames) {
      if (frameKey === activeFrame) continue;
      frames.delete(frameKey);
      previewCacheBytes -= cached.bytes.length;
    }
    if (!frames.size) pendingPreviewFrames.delete(sourceId);
  };
  const evictOldestPreview = () => {
    for (const [sourceId, frames] of pendingPreviewFrames) {
      const first = [...frames.keys()].find((key) => key !== previewDrainFrame.get(sourceId));
      if (first) { removePendingPreview(sourceId, first, true); return true; }
    }
    let oldest: { key: string; frameId: string; storedAt: number } | undefined;
    for (const [key, frames] of previewFrames) for (const [frameId, cached] of frames) {
      if (!oldest || cached.storedAt < oldest.storedAt) oldest = { key, frameId, storedAt: cached.storedAt };
    }
    if (oldest) { removePublishedFrame(oldest.key, oldest.frameId); return true; }
    return false;
  };
  const makePreviewRoom = (bytes: number) => {
    while (previewCacheBytes + bytes > MAX_PREVIEW_CACHE_BYTES) if (!evictOldestPreview()) return false;
    return true;
  };
  const rememberPreview = async (preview: PreviewMetadata, bytes: Buffer, activeOnly = false) => {
    if (!isPreviewMetadata(preview)) { countPreviewRejection(isRecord(preview) && typeof preview.sourceId === "string" ? preview.sourceId : "unknown", "invalid_metadata"); return false; }
    if (bytes.length < 4 || bytes.length > MAX_PREVIEW_IMAGE_BYTES || !jpegSignature(bytes)) { countPreviewRejection(preview.sourceId, "invalid_image"); return false; }
    const source = await repository.getSource(preview.sourceId);
    if (!source || source.kind !== "youtube") { countPreviewRejection(preview.sourceId, "source_unavailable"); return false; }
    if (activeOnly && (activeSessions.get(source.id) !== preview.sessionId || source.status !== "running")) { countPreviewRejection(preview.sourceId, "inactive_session"); return false; }
    const current = previewBySource.get(source.id);
    if (current?.sessionId === preview.sessionId && current.sourceTimeMs >= preview.sourceTimeMs) { countPreviewRejection(preview.sourceId, "non_monotonic"); return false; }
    const sessionKey = previewSessionKey(preview.sourceId, preview.sessionId);
    const obsoleteSessionDirs: string[] = [];
    for (const [oldKey, oldFrames] of previewFrames) {
      if (oldKey.startsWith(`${preview.sourceId}:`) && oldKey !== sessionKey) {
        for (const cached of oldFrames.values()) previewCacheBytes -= cached.bytes.length;
        previewFrames.delete(oldKey);
        obsoleteSessionDirs.push(path.join(previewDir, preview.sourceId, oldKey.slice(preview.sourceId.length + 1)));
      }
    }
    const frames = previewFrames.get(sessionKey) ?? new Map<string, CachedPreview>();
    const replaced = frames.get(preview.frameId);
    if (replaced) {
      frames.delete(preview.frameId);
      previewCacheBytes -= replaced.bytes.length;
    }
    if (!makePreviewRoom(bytes.length)) { countPreviewRejection(preview.sourceId, "cache_budget"); return false; }
    frames.set(preview.frameId, { metadata: preview, bytes, storedAt: ++previewStoredAt });
    previewCacheBytes += bytes.length;
    previewFrames.set(sessionKey, frames);
    previewBySource.delete(preview.sourceId);
    previewBySource.set(preview.sourceId, preview);
    const diag = previewDiag(preview.sourceId);
    diag.published += 1;
    diag.latestPublishedSourceTimeMs = preview.sourceTimeMs;
    while (frames.size > MAX_CACHED_PREVIEW_FRAMES_PER_SOURCE) {
      const oldest = frames.keys().next().value as string | undefined;
      if (!oldest) break;
      removePublishedFrame(sessionKey, oldest);
    }
    const cachedSourceIds = () => new Set([...previewFrames.keys()].map((key) => key.slice(0, key.indexOf(":"))));
    while (cachedSourceIds().size > MAX_CACHED_PREVIEW_SOURCES) {
      let oldestSource: { sourceId: string; storedAt: number } | undefined;
      for (const [key, cachedFrames] of previewFrames) {
        const sourceId = key.slice(0, key.indexOf(":"));
        for (const cached of cachedFrames.values()) {
          if (!oldestSource || cached.storedAt < oldestSource.storedAt) oldestSource = { sourceId, storedAt: cached.storedAt };
        }
      }
      if (!oldestSource) break;
      removePublishedSource(oldestSource.sourceId);
      removePendingSource(oldestSource.sourceId);
      if (!activeSessions.has(oldestSource.sourceId)) {
        void rm(path.join(previewDir, oldestSource.sourceId), { recursive: true, force: true }).catch(() => undefined);
      }
    }
    for (const obsoleteDir of obsoleteSessionDirs) void rm(obsoleteDir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  };
  const drainPendingPreviews = async (sourceId: string) => {
    if (previewDrainRunning.has(sourceId)) return;
    previewDrainRunning.add(sourceId);
    try {
      let frames = pendingPreviewFrames.get(sourceId);
      while (frames?.size) {
        const frameKey = frames.keys().next().value as string | undefined;
        if (!frameKey) break;
        const pending = frames.get(frameKey);
        if (!pending) { frames.delete(frameKey); continue; }
        previewDrainFrame.set(sourceId, frameKey);
        const queueWaitMs = Date.now() - pending.enqueuedAt;
        const durableStartedAt = Date.now();
        let durable = false;
        try { durable = await pending.durable; } catch { durable = false; }
        const diag = previewDiag(sourceId);
        const durableWaitMs = Date.now() - durableStartedAt;
        diag.queueWaitTotalMs += queueWaitMs;
        diag.queueWaitMaxMs = Math.max(diag.queueWaitMaxMs, queueWaitMs);
        diag.durableWaitTotalMs += durableWaitMs;
        diag.durableWaitMaxMs = Math.max(diag.durableWaitMaxMs, durableWaitMs);
        if (durable) diag.durableCompleted += 1; else diag.durableFailed += 1;
        if (frames.get(frameKey) === pending) {
          if (durable) await rememberPreview(pending.metadata, pending.bytes, true);
          removePendingPreview(sourceId, frameKey);
        }
        frames = pendingPreviewFrames.get(sourceId);
      }
    } catch (error) {
      console.error("YouTube preview cache update failed", error);
    } finally {
      previewDrainFrame.delete(sourceId);
      previewDrainRunning.delete(sourceId);
      if (pendingPreviewFrames.get(sourceId)?.size) void drainPendingPreviews(sourceId);
    }
  };
  const enqueuePendingPreview = (preview: PreviewMetadata, bytes: Buffer, durable: Promise<boolean>) => {
    const sourceId = preview.sourceId;
    const frames = pendingPreviewFrames.get(sourceId) ?? new Map<string, PendingPreview>();
    const frameKey = previewFrameKey(preview);
    const old = frames.get(frameKey);
    if (old) { previewCacheBytes -= old.bytes.length; frames.delete(frameKey); }
    if (!makePreviewRoom(bytes.length)) {
      previewDiag(sourceId).budgetRejected += 1;
      countPreviewRejection(sourceId, "pending_cache_budget");
      return false;
    }
    frames.set(frameKey, { metadata: preview, bytes, durable, enqueuedAt: Date.now() });
    previewCacheBytes += bytes.length;
    pendingPreviewFrames.set(sourceId, frames);
    const diag = previewDiag(sourceId);
    diag.enqueued += 1;
    diag.latestEnqueuedSourceTimeMs = preview.sourceTimeMs;
    while (frames.size > MAX_PENDING_PREVIEWS_PER_SOURCE) {
      const oldest = [...frames.keys()].find((key) => key !== previewDrainFrame.get(sourceId));
      if (!oldest) break;
      removePendingPreview(sourceId, oldest, true);
    }
    void drainPendingPreviews(sourceId);
    return true;
  };
  const forgetPreviews = async (sourceId: string) => {
    removePublishedSource(sourceId);
    removePendingSource(sourceId);
    await rm(path.join(previewDir, sourceId), { recursive: true, force: true }).catch(() => undefined);
  };
  const probeYoutube = async (source: Source, sessionId = randomUUID()) => {
    if (source.kind !== "youtube" || !source.url || !source.youtube) throw new HttpError(409, "This source is not a YouTube video");
    let result: unknown;
    try {
      result = await worker.request("probe_youtube", {
        sourceId: source.id, sessionId, url: source.url, previewDir
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "YouTube could not provide a playable video frame.";
      throw new HttpError(worker.capability().available ? 502 : 503, message);
    }
    if (!isRecord(result) || result.sourceId !== source.id || result.sessionId !== sessionId ||
        result.videoId !== source.youtube.videoId || !isPreviewMetadata(result)) {
      throw new HttpError(502, "YouTube returned an invalid preview frame.");
    }
    if (typeof result.title !== "string" || (result.isLive !== undefined && typeof result.isLive !== "boolean")) {
      throw new HttpError(502, "YouTube returned invalid source metadata.");
    }
    const liveStatusValues = ["is_live", "not_live", "was_live", "post_live", "is_upcoming", "unknown"] as const;
    const liveStatus = liveStatusValues.find((value) => value === result.liveStatus);
    if (typeof result.sourceWidth !== "number" || !Number.isInteger(result.sourceWidth) || result.sourceWidth <= 0 || result.sourceWidth < result.width ||
        typeof result.sourceHeight !== "number" || !Number.isInteger(result.sourceHeight) || result.sourceHeight <= 0 || result.sourceHeight < result.height) {
      throw new HttpError(502, "YouTube returned invalid source dimensions.");
    }
    const updated = SourceSchema.parse({
      ...source,
      youtube: { videoId: source.youtube.videoId, title: result.title.slice(0, 200),
        ...(result.isLive !== undefined ? { isLive: result.isLive } : {}),
        ...(liveStatus ? { liveStatus } : {}) },
      width: result.sourceWidth, height: result.sourceHeight
    });
    const imagePath = path.join(previewDir, source.id, sessionId, `${result.frameId}.jpg`);
    let bytes: Buffer;
    try {
      const file = await open(imagePath, "r");
      const signature = Buffer.alloc(4);
      try { await file.read(signature, 0, signature.length, 0); } finally { await file.close(); }
      const imageStat = await stat(imagePath);
      if (!jpegSignature(signature) || imageStat.size < 4 || imageStat.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error();
      bytes = await readFile(imagePath);
      if (!jpegSignature(bytes) || bytes.length !== imageStat.size) throw new Error();
    } catch {
      throw new HttpError(502, "YouTube preview could not be verified.");
    }
    return { source: updated, preview: result as PreviewMetadata, bytes };
  };
  void mkdir(uploadDir, { recursive: true });
  void mkdir(previewDir, { recursive: true });
  void repository.listSources().then(async (sources) => {
    for (const source of sources) {
      if (source.status === "running") await repository.putSource(sourceWithStatus(source, "error", RESTARTED_SOURCE_ERROR));
      else if (source.status === "completed" && source.error === RESTARTED_SOURCE_ERROR) {
        await repository.putSource(sourceWithStatus(source, "completed"));
      }
    }
  }).catch(() => undefined);

  worker.onEvent((raw) => {
    if (!isRecord(raw) || typeof raw.sourceId !== "string") return;
    if (raw.type === "analysis_frame") {
      const frameId = typeof raw.frameId === "string" ? raw.frameId : "";
      const eventRecord = pendingFrameEvents.get(frameId);
      if (!/^[0-9a-f-]{36}$/i.test(frameId) || !eventRecord || raw.artifactName !== `${frameId}.jpg` || raw.mimeType !== "image/jpeg" ||
        typeof raw.sessionId !== "string" || typeof raw.sourceTimeMs !== "number" || typeof raw.frameWidth !== "number" || typeof raw.frameHeight !== "number") return;
      const event = eventRecord.event;
      if (raw.sourceId !== event.sourceId || raw.sessionId !== event.sessionId || raw.sourceTimeMs !== event.sourceTimeMs || raw.frameWidth !== event.frameWidth || raw.frameHeight !== event.frameHeight) return;
      const artifact = path.resolve(frameStagingDir, event.sourceId, event.sessionId, raw.artifactName);
      const stagingRoot = `${path.resolve(frameStagingDir)}${path.sep}`;
      if (!artifact.startsWith(stagingRoot) || path.basename(artifact) !== raw.artifactName) return;
      try {
        const size = statSync(artifact).size;
        if (size < 4 || size > MAX_NATIVE_FRAME_BYTES) { void rm(artifact, { force: true }); return; }
        const bytes = readFileSync(artifact);
        const dimensions = jpegDimensions(bytes);
        if (bytes.length !== size || !dimensions || dimensions.width !== event.frameWidth || dimensions.height !== event.frameHeight) { void rm(artifact, { force: true }); return; }
        rememberFrameBytes(frameId, { sourceId: event.sourceId, sessionId: event.sessionId, sourceTimeMs: event.sourceTimeMs, width: event.frameWidth, height: event.frameHeight }, bytes);
      } catch { /* Missing or unreadable native evidence does not invalidate its analysis event. */ }
      finally { void rm(artifact, { force: true }); }
      return;
    }
    if (raw.type === "preview_frame") {
      const diag = previewDiag(raw.sourceId);
      diag.notifications += 1;
      if (typeof raw.sourceTimeMs === "number" && Number.isFinite(raw.sourceTimeMs)) diag.latestReceivedSourceTimeMs = raw.sourceTimeMs;
      if (!isPreviewMetadata(raw)) { diag.invalidMetadata += 1; return; }
      if (activeSessions.get(raw.sourceId) !== raw.sessionId) { diag.inactiveSession += 1; return; }
      const pending = pendingWorkerWrites.get(raw.sourceId);
      const analysis = pending?.lastAnalysis;
      if (!analysis || analysis.sessionId !== raw.sessionId || analysis.sourceTimeMs !== raw.sourceTimeMs) {
        diag.analysisMismatch += 1;
        return;
      }
      try {
        // Copy before returning to the worker event loop. Its disk cache is a
        // rolling window and may prune this frame while event persistence waits.
        const imagePath = path.join(previewDir, raw.sourceId, raw.sessionId, `${raw.frameId}.jpg`);
        const imageSize = statSync(imagePath).size;
        if (imageSize < 4 || imageSize > MAX_PREVIEW_IMAGE_BYTES) {
          diag.fileCopyFailures.invalid_size = (diag.fileCopyFailures.invalid_size ?? 0) + 1;
          return;
        }
        const bytes = readFileSync(imagePath);
        if (bytes.length !== imageSize || !jpegSignature(bytes)) {
          diag.fileCopyFailures.invalid_bytes = (diag.fileCopyFailures.invalid_bytes ?? 0) + 1;
          return;
        }
        diag.copied += 1;
        diag.latestCopiedSourceTimeMs = raw.sourceTimeMs;
        enqueuePendingPreview(raw, bytes, analysis.durable);
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" && ["ENOENT", "EACCES", "EPERM", "EIO", "EBUSY"].includes(error.code)
          ? error.code : "other";
        diag.fileCopyFailures[code] = (diag.fileCopyFailures[code] ?? 0) + 1;
      }
      return;
    }
    if (raw.type === "job_complete" || raw.type === "job_error") {
      const sourceId = raw.sourceId;
      if (typeof raw.sessionId === "string" && stoppingSessions.get(sourceId) === raw.sessionId) {
        stoppingSessions.delete(sourceId);
        stopsInProgress.delete(sourceId);
      }
      const pending = pendingWorkerWrites.get(sourceId);
      const priorWrites = pending?.tail ?? Promise.resolve();
      const markPersistenceFailure = async (error: unknown) => {
        console.error(`Analysis event persistence failed for source ${sourceId}`, error);
        const source = await repository.getSource(sourceId);
        if (!source || typeof raw.sessionId !== "string" || activeSessions.get(source.id) !== raw.sessionId) return;
        const updated = sourceWithStatus(source, "error", "An analysis event could not be saved to local storage.");
        const current = await persistSourceAndRead(repository, updated);
        if (!current) return;
        activeSessions.delete(source.id);
        const watchers = streamSubscribers.get(source.id);
        if (watchers) for (const response of watchers) response.write(`event: status\ndata: ${JSON.stringify({ source: current })}\n\n`);
      };
      const completion = priorWrites.then(async () => {
        if (pending?.failure !== undefined) {
          await markPersistenceFailure(pending.failure);
          return;
        }
        const source = await repository.getSource(sourceId);
        if (!source || typeof raw.sessionId !== "string" || activeSessions.get(source.id) !== raw.sessionId) return;
        const status = raw.type === "job_error" ? "error" : raw.cancelled === true ? "stopped" : "completed";
        const detail = raw.type === "job_error" && typeof raw.message === "string" ? raw.message.slice(0, 1000) : undefined;
        const updated = sourceWithStatus(source, status, detail);
        const current = await persistSourceAndRead(repository, updated);
        if (raw.type === "job_complete") activeSessions.delete(source.id);
        const watchers = streamSubscribers.get(source.id);
        if (current && watchers) for (const response of watchers) response.write(`event: status\ndata: ${JSON.stringify({ source: current })}\n\n`);
      }, markPersistenceFailure);
      void completion.catch((error) => console.error(`Analysis completion could not be persisted for source ${sourceId}`, error)).finally(() => {
        if (pendingWorkerWrites.get(sourceId) === pending) pendingWorkerWrites.delete(sourceId);
      });
      return;
    }
    const eventId = typeof raw.id === "string" ? raw.id : createHash("sha256").update(JSON.stringify(raw)).digest("hex");
    const eventData = { ...raw, id: eventId, type: raw.type === "crossing" || (Array.isArray(raw.crossings) && raw.crossings.length > 0) ? "crossing" : "analysis" };
    const checked = AnalysisEventSchema.safeParse(eventData);
    if (!checked.success) {
      const paths = [...new Set(checked.error.issues.map((issue) => issue.path.map((part) => typeof part === "number" ? "[*]" : String(part)).join(".") || "<root>"))].slice(0, 8);
      const key = paths.join(",").slice(0, 300);
      if (!reportedWorkerEventIssues.has(key)) {
        reportedWorkerEventIssues.add(key);
        if (options.onInvalidWorkerEvent) options.onInvalidWorkerEvent(paths);
        else console.warn(`Ignoring invalid vision analysis event (schema paths: ${key})`);
      }
      return;
    }
    const sourceId = checked.data.sourceId;
    const pending = pendingWorkerWrites.get(sourceId) ?? {
      tail: Promise.resolve(), failure: undefined as unknown,
      lastAnalysis: undefined as { sessionId: string; sourceTimeMs: number; durable: Promise<boolean> } | undefined
    };
    const operation = pending.tail.then(async () => {
      const source = await repository.getSource(sourceId);
      if (!source || activeSessions.get(source.id) !== checked.data.sessionId || source.status !== "running") return false;
      await repository.appendEvent(source.id, checked.data);
      const watchers = streamSubscribers.get(source.id);
      if (watchers) for (const response of watchers) response.write(`event: analysis\ndata: ${JSON.stringify(checked.data)}\n\n`);
      return true;
    });
    const durable = operation.then((saved) => {
      if (saved) pending.failure = undefined;
      return saved;
    }, (error) => {
      pending.failure = error;
      console.error(`Analysis event could not be persisted for source ${sourceId}`, error);
      return false;
    });
    pending.tail = durable.then(() => undefined);
    pending.lastAnalysis = { sessionId: checked.data.sessionId, sourceTimeMs: checked.data.sourceTimeMs, durable };
    pendingWorkerWrites.set(sourceId, pending);
    rememberFrameEvent(checked.data, durable);
    const directBytes = checked.data.frameId ? directFrameBytes.get(checked.data.frameId) : undefined;
    if (checked.data.frameId && directBytes) {
      directFrameBytes.delete(checked.data.frameId);
      const dimensions = jpegDimensions(directBytes);
      if (dimensions && dimensions.width === checked.data.frameWidth && dimensions.height === checked.data.frameHeight) {
        rememberFrameBytes(checked.data.frameId, { sourceId, sessionId: checked.data.sessionId, sourceTimeMs: checked.data.sourceTimeMs, width: checked.data.frameWidth, height: checked.data.frameHeight }, directBytes);
      }
    }
  });

  const uploadStorage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => {
      const extension = acceptedVideos[file.mimetype];
      callback(extension ? null : new HttpError(415, "Upload must be an MP4, MOV, WebM, MKV, or AVI video"), `${randomUUID()}${extension ?? ".invalid"}`);
    }
  });
  const uploadVideo = multer({ storage: uploadStorage, limits: { fileSize: maxUploadBytes, files: 1 } }).single("file");
  const uploadFrame = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, callback) => callback(null, file.mimetype === "image/jpeg") }).single("file");

  app.disable("x-powered-by");
  const dashboardOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://100.120.252.61:5173",
    "http://laptop.tail6485dc.ts.net:5173",
    ...(options.additionalCorsOrigins ?? [])
  ]);
  app.use(cors({
    origin: (origin, callback) => callback(null, origin === undefined || dashboardOrigins.has(origin)),
    allowedHeaders: ["Content-Type", "Idempotency-Key"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    const capability = worker.capability();
    res.json(HealthSchema.parse({ status: capability.available ? "ok" : "degraded", worker: capability, upload: { maxBytes: maxUploadBytes } }));
  });

  app.get("/api/sources", async (_req, res) => res.json(SourceFoldersResponseSchema.parse(await repository.getLibrarySnapshot())));

  app.post("/api/source-folders", async (req, res) => {
    const checked = SourceFolderNameRequestSchema.safeParse(req.body);
    if (!checked.success) throw new HttpError(400, "Provide only a folder name between 1 and 120 characters");
    const folder: SourceFolder = SourceFolderSchema.parse({ id: randomUUID(), name: checked.data.name, createdAt: new Date().toISOString() });
    try {
      const snapshot = await repository.createSourceFolder(folder);
      res.status(201).json(SourceFoldersResponseSchema.parse(snapshot));
    } catch (error) { sourceFolderHttpError(error); }
  });

  app.patch("/api/source-folders/:id", async (req, res) => {
    const checked = SourceFolderNameRequestSchema.safeParse(req.body);
    if (!checked.success) throw new HttpError(400, "Provide only a folder name between 1 and 120 characters");
    try {
      const snapshot = await repository.renameSourceFolder(req.params.id!, checked.data.name);
      res.json(SourceFoldersResponseSchema.parse(snapshot));
    } catch (error) { sourceFolderHttpError(error); }
  });

  app.delete("/api/source-folders/:id", async (req, res) => {
    try {
      const snapshot = await repository.deleteSourceFolder(req.params.id!);
      res.json(SourceFoldersResponseSchema.parse(snapshot));
    } catch (error) { sourceFolderHttpError(error); }
  });

  app.put("/api/sources/:id/organization", async (req, res) => {
    const checked = SourceOrganizationRequestSchema.safeParse(req.body);
    if (!checked.success) throw new HttpError(400, "Provide a folderId UUID or null and an optional destination source UUID");
    try {
      const snapshot = await repository.organizeSource(req.params.id!, checked.data.folderId, checked.data.beforeSourceId);
      res.json(SourceFoldersResponseSchema.parse(snapshot));
    } catch (error) { sourceFolderHttpError(error); }
  });

  app.patch("/api/sources/:id", async (req, res) => {
    if (!isRecord(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "name") || typeof req.body.name !== "string") {
      throw new HttpError(400, "Provide only a source name");
    }
    const name = req.body.name.trim();
    if (name.length < 1 || name.length > 120) throw new HttpError(400, "Source name must be between 1 and 120 characters");
    const source = await repository.renameSource(req.params.id!, name);
    if (!source) throw new HttpError(404, "Source not found");
    res.json({ source });
  });

  app.put("/api/sources/:id/location", async (req, res) => {
    if (!isRecord(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "location")) {
      throw new HttpError(400, "Provide only a location object or null");
    }
    let location: Source["location"] | undefined;
    if (req.body.location !== null) {
      const checked = SourceLocationSchema.safeParse(req.body.location);
      if (!checked.success) throw new HttpError(400, checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      location = checked.data;
    }
    const source = await repository.setLocation(req.params.id!, location);
    if (!source) throw new HttpError(404, "Source not found");
    res.json({ source });
  });

  app.post("/api/sources", async (req, res) => {
    if (!isRecord(req.body)) throw new HttpError(400, "Expected a JSON object");
    const { name, kind, url } = req.body;
    if (typeof name !== "string" || !["webcam", "stream", "youtube"].includes(String(kind))) throw new HttpError(400, "Provide a source name and kind webcam, stream, or youtube");
    if (kind === "stream" && typeof url !== "string") throw new HttpError(400, "A stream source needs a local network URL");
    if (kind === "youtube" && typeof url !== "string") throw new HttpError(400, "A YouTube source needs a video link");
    const safeUrl = kind === "stream" ? await validateLocalStreamUrl(url as string) : undefined;
    const youtubeLink = kind === "youtube" ? normalizeYouTubeUrl(url as string) : undefined;
    const checked = SourceSchema.safeParse({ id: randomUUID(), name: name.trim(), kind: kind as SourceKind, status: "idle", createdAt: new Date().toISOString(), ...(safeUrl ? { url: safeUrl } : {}), ...(youtubeLink ? { url: youtubeLink.url, youtube: { videoId: youtubeLink.videoId } } : {}) });
    if (!checked.success) throw new HttpError(400, checked.error.issues.map((issue) => issue.message).join("; "));
    if (checked.data.kind === "youtube") {
      const sessionId = randomUUID();
      try {
        const probed = await probeYoutube(checked.data, sessionId);
        await repository.putSource(probed.source);
        await rememberPreview(probed.preview, probed.bytes);
        res.status(201).json({ source: probed.source });
      } catch (error) {
        await rm(path.join(previewDir, checked.data.id), { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return;
    }
    await repository.putSource(checked.data);
    res.status(201).json({ source: checked.data });
  });

  app.post("/api/uploads", (req, _res, next) => {
    const key = req.get("Idempotency-Key");
    if (key && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return next(new HttpError(400, "Idempotency-Key must be a UUID"));
    void mkdir(uploadDir, { recursive: true }).then(() => next(), next);
  }, (req, res, next) => uploadVideo(req, res, next), async (req, res) => {
    const file = req.file;
    if (!file) throw new HttpError(400, "Attach a video using the file field");
    let finalPath: string | undefined;
    let committed = false;
    try {
      const handle = await open(file.path, "r");
      const header = Buffer.alloc(16);
      try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
      if (!videoSignatureOk(file.mimetype, header)) throw new HttpError(415, "The uploaded file contents do not match its declared video type");
      const id = randomUUID();
      finalPath = path.join(uploadDir, `${id}${acceptedVideos[file.mimetype]}`);
      await rename(file.path, finalPath);
      const source = withMediaMetadata(SourceSchema.parse({ id, name: typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 120) : path.parse(file.originalname).name.slice(0, 120) || "Uploaded video", kind: "upload", status: "idle", createdAt: new Date().toISOString() }), await metadataInspector(finalPath));
      const result = await repository.commitUpload(source, finalPath, req.get("Idempotency-Key"));
      committed = result.created;
      if (!committed) await rm(finalPath, { force: true });
      res.status(result.created ? 201 : 200).json({ source: result.source });
    } catch (error) {
      await rm(file.path, { force: true });
      if (finalPath && !committed) await rm(finalPath, { force: true });
      throw error;
    }
  });

  app.get("/api/sources/:id", async (req, res) => {
    const source = await repository.getSource(req.params.id!);
    if (!source) throw new HttpError(404, "Source not found");
    res.json({ source });
  });

  app.get("/api/sources/:id/preview", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    const current = source.kind === "youtube" ? previewBySource.get(source.id) : undefined;
    const cached = current ? previewFrames.get(previewSessionKey(source.id, current.sessionId))?.get(current.frameId) : undefined;
    res.set("Cache-Control", "no-store").json({ preview: cached?.metadata ?? null });
  });

  app.get("/api/debug/youtube-preview", (req, res) => {
    const remoteAddress = req.socket.remoteAddress?.toLowerCase();
    if (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1" && remoteAddress !== "::ffff:127.0.0.1") {
      res.status(404).end();
      return;
    }
    const diagnostics = [...previewDiagnostics].map(([sourceId, diag]) => {
      const pending = pendingPreviewFrames.get(sourceId);
      const activeFrame = previewDrainFrame.get(sourceId);
      const activePending = activeFrame ? pending?.get(activeFrame) : undefined;
      return {
        sourceId,
        ...diag,
        queueDepth: pending?.size ?? 0,
        drainRunning: previewDrainRunning.has(sourceId),
        drainingSourceTimeMs: activePending?.metadata.sourceTimeMs ?? null,
        oldestPendingAgeMs: pending?.size ? Math.max(0, Date.now() - Math.min(...[...pending.values()].map((item) => item.enqueuedAt))) : 0,
        lastAnalysisSourceTimeMs: pendingWorkerWrites.get(sourceId)?.lastAnalysis?.sourceTimeMs ?? null,
        currentPublishedSourceTimeMs: previewBySource.get(sourceId)?.sourceTimeMs ?? null
      };
    });
    res.set("Cache-Control", "no-store").json({ cacheBytes: previewCacheBytes, diagnostics });
  });

  app.get("/api/sources/:id/preview/:sessionId/:frameId", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.kind !== "youtube") throw new HttpError(404, "Preview not found");
    const sessionId = req.params.sessionId!;
    const frameId = req.params.frameId!;
    const known = previewFrames.get(previewSessionKey(source.id, sessionId))?.get(frameId);
    if (!known || !jpegSignature(known.bytes)) throw new HttpError(404, "Preview frame expired; refresh the YouTube preview.");
    res.status(200).set({ "Cache-Control": "no-store", "X-Frame-Id": frameId,
      "X-Source-Time-Ms": String(known.metadata.sourceTimeMs) }).type("image/jpeg").send(known.bytes);
  });

  app.post("/api/sources/:id/preview", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.kind !== "youtube") throw new HttpError(409, "Only YouTube sources have a refreshable preview.");
    if (source.status === "running" || startsInProgress.has(source.id) || probesInProgress.has(source.id)) throw new HttpError(409, "Stop analysis before refreshing the YouTube preview.");
    probesInProgress.add(source.id);
    const sessionId = randomUUID();
    try {
      const probed = await probeYoutube(source, sessionId);
      const updated = await persistSourceAndRead(repository, probed.source);
      if (!updated) throw new HttpError(404, "Source not found");
      await rememberPreview(probed.preview, probed.bytes);
      res.json({ source: updated, preview: probed.preview });
    } catch (error) {
      await rm(path.join(previewDir, source.id, sessionId), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally { probesInProgress.delete(source.id); }
  });

  app.put("/api/sources/:id/recording-time", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.kind !== "upload") throw new HttpError(409, "Recording-time overrides are available only for uploaded videos");
    if (source.status === "running") throw new HttpError(409, "Stop the source before changing its recording time");
    if (!isRecord(req.body) || !("manualStartAt" in req.body)) throw new HttpError(400, "Provide manualStartAt as an offset-qualified ISO timestamp or null");
    const manualStartAt = req.body.manualStartAt;
    let recordingTime: Source["recordingTime"];
    if (manualStartAt === null) {
      const embeddedStartAt = source.recordingTime?.embeddedStartAt
        ?? (source.recordingTime?.provenance === "embedded_metadata" ? source.recordingTime.effectiveStartAt : undefined);
      recordingTime = embeddedStartAt ? {
        effectiveStartAt: embeddedStartAt,
        provenance: "embedded_metadata",
        embeddedStartAt,
        embeddedField: source.recordingTime?.embeddedField
      } : undefined;
    } else {
      const canonical = canonicalizeOffsetDateTime(manualStartAt);
      if (!canonical) throw new HttpError(400, "manualStartAt must be a valid ISO timestamp with an explicit UTC offset");
      const embeddedStartAt = source.recordingTime?.embeddedStartAt
        ?? (source.recordingTime?.provenance === "embedded_metadata" ? source.recordingTime.effectiveStartAt : undefined);
      recordingTime = {
        effectiveStartAt: canonical,
        provenance: "manual_override",
        ...(embeddedStartAt ? { embeddedStartAt } : {}),
        ...(embeddedStartAt && source.recordingTime?.embeddedField ? { embeddedField: source.recordingTime.embeddedField } : {})
      };
    }
    const updated = SourceSchema.parse({ ...source, ...(recordingTime ? { recordingTime } : {}) });
    if (!recordingTime) delete (updated as Partial<Source>).recordingTime;
    const persisted = await persistSourceAndRead(repository, updated);
    if (!persisted) throw new HttpError(404, "Source not found");
    res.json({ source: persisted });
  });

  app.post("/api/sources/:id/metadata/refresh", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.kind !== "upload") throw new HttpError(409, "Metadata refresh is available only for uploaded videos");
    if (source.status === "running") throw new HttpError(409, "Stop the source before refreshing its metadata");
    const assetPath = await repository.getAssetPath(source.id);
    if (!assetPath) throw new HttpError(404, "Uploaded video file is missing");
    const resolvedAsset = path.resolve(assetPath);
    if (!resolvedAsset.startsWith(`${uploadDir}${path.sep}`)) throw new HttpError(403, "Stored video path is outside the upload directory");
    try { await stat(resolvedAsset); } catch { throw new HttpError(404, "Uploaded video file is missing"); }
    const metadata = await metadataInspector(resolvedAsset);
    const current = await requireSource(repository, source.id);
    if (current.status === "running") throw new HttpError(409, "Stop the source before refreshing its metadata");
    const updated = withMediaMetadata(current, metadata);
    const persisted = await persistSourceAndRead(repository, updated);
    if (!persisted) throw new HttpError(404, "Source not found");
    res.json({ source: persisted });
  });

  app.put("/api/sources/:id/scene", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.status === "running") throw new HttpError(409, "Stop the source before changing its scene");
    const result = SceneSchema.safeParse(req.body);
    if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
    await repository.putScene(source.id, result.data);
    res.json({ scene: result.data });
  });

  app.get("/api/sources/:id/scene", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    res.json({ scene: await repository.getScene(source.id) });
  });

  app.post("/api/sources/:id/start", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (stopsInProgress.has(source.id)) throw new HttpError(409, "Source is still stopping; wait for it to finish before restarting.");
    if (source.status === "running") { res.json({ source }); return; }
    if (startsInProgress.has(source.id) || stopsInProgress.has(source.id) || probesInProgress.has(source.id)) throw new HttpError(409, "A source operation is already in progress");
    startsInProgress.add(source.id);
    try {
      const sessionId = randomUUID();
      const scene = await repository.getScene(source.id);
      const payload: Record<string, unknown> = { sourceId: source.id, sessionId, kind: source.kind, scene, frameArtifactDir: frameStagingDir };
      if (source.kind === "upload" || source.kind === "youtube") payload.sampleEveryMs = 500;
      if (source.kind === "youtube") {
        if (!source.url) throw new HttpError(409, "YouTube source URL is missing");
        payload.url = source.url;
        payload.previewDir = previewDir;
        payload.youtubeIsLive = source.youtube?.isLive;
      }
      const modelPath = options.visionModelPath ?? process.env.VISION_MODEL_PATH;
      if (modelPath) payload.modelPath = path.resolve(modelPath);
      if (source.kind === "upload") {
        const filePath = await repository.getAssetPath(source.id);
        if (!filePath) throw new HttpError(404, "Uploaded video file is missing");
        payload.filePath = filePath;
      }
      if (source.kind === "stream") payload.url = source.url;
      try {
        activeSessions.set(source.id, sessionId);
        if (source.kind === "youtube") {
          previewBySource.delete(source.id);
          removePendingSource(source.id);
        }
        await worker.request("configure", payload);
        if (source.kind === "upload") await worker.request("analyze_upload", payload);
        else if (source.kind === "stream") await worker.request("analyze_stream", payload);
        else if (source.kind === "youtube") await worker.request("analyze_youtube", payload);
        else await worker.request("start", payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Worker could not start this source";
        activeSessions.delete(source.id);
        await persistSourceAndRead(repository, sourceWithStatus(source, "error", message));
        throw new HttpError(error instanceof WorkerUnavailableError || !worker.capability().available ? 503 : 502, message);
      }
      const running = await persistSourceAndRead(repository, sourceWithStatus(source, "running"));
      if (!running) throw new HttpError(404, "Source not found");
      const watchers = streamSubscribers.get(source.id);
      if (watchers) for (const response of watchers) response.write(`event: status\ndata: ${JSON.stringify({ source: running })}\n\n`);
      res.json({ source: running, sessionId });
    } finally {
      startsInProgress.delete(source.id);
    }
  });

  app.post("/api/sources/:id/stop", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (startsInProgress.has(source.id)) throw new HttpError(409, "Source start is still in progress; try stopping again when it is ready.");
    if (probesInProgress.has(source.id)) throw new HttpError(409, "Preview refresh is still in progress; try again when it is ready.");
    if (stopsInProgress.has(source.id)) throw new HttpError(409, "Source is still stopping; wait for it to finish.");
    if (source.status !== "running") { res.json({ source }); return; }
    stopsInProgress.add(source.id);
    const sessionId = activeSessions.get(source.id);
    if (sessionId) stoppingSessions.set(source.id, sessionId);
    activeSessions.delete(source.id);
    let awaitingWorkerCompletion = false;
    try {
      await worker.request("stop", { sourceId: source.id, sessionId });
      const stopped = await persistSourceAndRead(repository, sourceWithStatus(source, "stopped"));
      if (!stopped) throw new HttpError(404, "Source not found");
      activeSessions.delete(source.id);
      const watchers = streamSubscribers.get(source.id);
      if (watchers) for (const response of watchers) response.write(`event: status\ndata: ${JSON.stringify({ source: stopped })}\n\n`);
      res.json({ source: stopped });
    } catch (error) {
      const workerMessage = error instanceof Error ? error.message : "";
      awaitingWorkerCompletion = /still stopping|stop request timed out/i.test(workerMessage);
      await persistSourceAndRead(repository, sourceWithStatus(source, "error", "Vision worker is still stopping or could not stop the source cleanly."));
      throw new HttpError(502, awaitingWorkerCompletion ? "Vision worker is still stopping. Wait for it to finish before restarting." : "Vision worker could not stop the source cleanly.");
    } finally {
      if (!awaitingWorkerCompletion) {
        stoppingSessions.delete(source.id);
        stopsInProgress.delete(source.id);
      }
    }
  });

  app.post("/api/sources/:id/frame", (req, res, next) => uploadFrame(req, res, next), async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    if (source.kind !== "webcam") throw new HttpError(409, "Frames can be submitted only to webcam sources");
    if (source.status !== "running") throw new HttpError(409, "Start the webcam source before submitting frames");
    if (framesInFlight.has(source.id)) throw new HttpError(429, "A frame is already being analyzed for this source");
    const file = req.file;
    if (!file || !jpegSignature(file.buffer)) throw new HttpError(415, "Attach a valid JPEG image using the file field");
    const sourceTimeMs = Number(req.body.sourceTimeMs);
    if (!Number.isFinite(sourceTimeMs) || sourceTimeMs < 0) throw new HttpError(400, "sourceTimeMs must be a non-negative number");
    framesInFlight.add(source.id);
    const frameDir = path.join(uploadDir, "frames");
    const frameId = randomUUID();
    const framePath = path.join(frameDir, `${frameId}.jpg`);
    try {
      await mkdir(frameDir, { recursive: true });
      await writeFile(framePath, file.buffer, { flag: "wx" });
      const sessionId = activeSessions.get(source.id) ?? (typeof req.body.sessionId === "string" ? req.body.sessionId : undefined);
      if (!sessionId) throw new HttpError(409, "No active analysis session exists for this source");
      if (directFrameBytes.size >= 16) throw new HttpError(429, "Native frame evidence queue is busy; retry shortly");
      directFrameBytes.set(frameId, file.buffer);
      const directTimer = setTimeout(() => directFrameBytes.delete(frameId), 120_000);
      directTimer.unref?.();
      await worker.request("process_frame", { sourceId: source.id, sessionId, sourceTimeMs, framePath, frameId });
      res.status(202).json({ accepted: true });
    } finally { framesInFlight.delete(source.id); await rm(framePath, { force: true }); }
  });

  app.get("/api/sources/:id/events", async (req, res) => {
    await requireSource(repository, req.params.id!);
    const [events, aggregate] = await Promise.all([repository.getEvents(req.params.id!), repository.getAggregate(req.params.id!)]);
    res.json({ events, truncated: aggregate.historyTruncated, discardedCount: aggregate.discardedEventCount ?? null });
  });

  app.post("/api/sources/:id/feedback/drafts", async (req, res) => {
    const sourceId = req.params.id!;
    await withSourceMutation(sourceId, async () => {
    const source = await requireSource(repository, sourceId);
    await pruneExpiredFeedbackDrafts();
    if (feedbackDrafts.size >= MAX_FEEDBACK_DRAFTS) throw new HttpError(429, "Too many open feedback drafts; cancel an unused draft and try again");
    const eventId = typeof req.body?.eventId === "string" ? req.body.eventId : "";
    const event = (await repository.getEvents(source.id)).find((item) => item.id === eventId);
    if (!event) throw new HttpError(404, "Analysis event is not in retained history");
    const draftId = randomUUID(), expiresAtMs = Date.now() + FEEDBACK_DRAFT_TTL_MS;
    const draftPath = path.join(feedbackDraftDir, `${draftId}.jpg`);
    let frame: FeedbackDraft["frame"] = { provenance: "unavailable" };
    let imagePath: string | undefined;
    if (event.frameId) {
      await framePublications.get(event.frameId);
      const cachedPath = path.join(nativeFrameDir, `${event.frameId}.jpg`);
      try {
        const info = await stat(cachedPath);
        if (info.size > 0 && info.size <= MAX_NATIVE_FRAME_BYTES) {
          await mkdir(feedbackDraftDir, { recursive: true });
          await copyFile(cachedPath, draftPath);
          const bytes = await readFile(draftPath), dims = jpegDimensions(bytes);
          if (dims && dims.width === event.frameWidth && dims.height === event.frameHeight) {
            imagePath = draftPath;
            frame = { frameId: event.frameId, provenance: "analysis_source_frame", url: `/api/sources/${source.id}/feedback/drafts/${draftId}/frame`, mimeType: "image/jpeg", width: dims.width, height: dims.height };
          } else await rm(draftPath, { force: true });
        }
      } catch { /* Native image can be unavailable after bounded-cache eviction. */ }
    }
    if (!imagePath && source.kind === "upload" && worker.capability().available && /^[A-Za-z0-9_-]{1,128}$/.test(event.id)) {
      const assetPath = await repository.getAssetPath(source.id);
      const resolved = assetPath ? path.resolve(assetPath) : "";
      const extension = path.extname(resolved).toLowerCase();
      const allowedExtension = Object.values(acceptedVideos).includes(extension);
      if (resolved && resolved.startsWith(`${uploadDir}${path.sep}`) && path.basename(resolved) === `${source.id}${extension}` && allowedExtension) {
        await mkdir(frameStagingDir, { recursive: true });
        const artifactId = randomUUID();
        try {
          const result: unknown = await worker.request("extract_media_frame", {
            sourceId: source.id, sessionId: event.sessionId, eventId: event.id, artifactId, filePath: resolved,
            sourceTimeMs: event.sourceTimeMs, expectedWidth: event.frameWidth, expectedHeight: event.frameHeight, artifactDir: frameStagingDir
          });
          if (isRecord(result) && result.sourceId === source.id && result.sessionId === event.sessionId && result.eventId === event.id &&
            result.sourceTimeMs === event.sourceTimeMs && typeof result.decodedTimeMs === "number" && Number.isFinite(result.decodedTimeMs) && Math.abs(result.decodedTimeMs - event.sourceTimeMs) <= 1 &&
            result.frameWidth === event.frameWidth && result.frameHeight === event.frameHeight && result.mimeType === "image/jpeg" &&
            result.provenance === "verified_media_redecode" && result.artifactName === `${artifactId}.jpg`) {
            const artifactPath = path.resolve(frameStagingDir, result.artifactName);
            if (path.dirname(artifactPath) === path.resolve(frameStagingDir)) {
              const bytes = await readFile(artifactPath), dimensions = jpegDimensions(bytes);
              if (bytes.length <= MAX_NATIVE_FRAME_BYTES && dimensions?.width === event.frameWidth && dimensions.height === event.frameHeight) {
                await mkdir(feedbackDraftDir, { recursive: true });
                await writeFile(draftPath, bytes, { flag: "wx" });
                imagePath = draftPath;
                frame = { provenance: "verified_media_redecode", url: `/api/sources/${source.id}/feedback/drafts/${draftId}/frame`, mimeType: "image/jpeg", width: dimensions.width, height: dimensions.height };
              }
            }
          }
        } catch (error) {
          // An unavailable worker or a verification mismatch is honest evidence unavailability.
          console.warn(`Legacy frame recovery unavailable for source ${source.id}`);
        } finally { await rm(path.join(frameStagingDir, `${artifactId}.jpg`), { force: true }).catch(() => undefined); }
      }
    }
    const draft = FeedbackDraftResponseSchema.parse({ draft: {
      draftId, sourceId: source.id, sessionId: event.sessionId, eventId: event.id,
      ...(event.frameId ? { frameId: event.frameId } : {}), frame, expiresAt: new Date(expiresAtMs).toISOString()
    } }).draft;
    const latestSource = await repository.getSource(source.id);
    const latestEvents = latestSource ? await repository.getEvents(source.id) : [];
    if (!latestSource || !latestEvents.some((item) => item.id === event.id && item.sessionId === event.sessionId)) {
      if (imagePath) await rm(imagePath, { force: true }).catch(() => undefined);
      throw new HttpError(409, "The analysis source was removed before the frame draft could be reserved");
    }
    feedbackDrafts.set(draftId, { data: draft, ...(imagePath ? { imagePath } : {}), expiresAtMs });
    res.status(201).json({ draft });
    });
  });

  app.get("/api/sources/:id/feedback/drafts/:draftId/frame", async (req, res, next) => {
    await requireSource(repository, req.params.id!);
    await pruneExpiredFeedbackDrafts();
    const draft = feedbackDrafts.get(req.params.draftId!);
    if (!draft || draft.data.sourceId !== req.params.id || !draft.imagePath) throw new HttpError(404, "Pinned native frame is unavailable or the draft expired");
    try { await stat(draft.imagePath); } catch { throw new HttpError(404, "Pinned native frame is unavailable"); }
    res.type("image/jpeg").set("Cache-Control", "no-store");
    createReadStream(draft.imagePath).on("error", next).pipe(res);
  });

  app.delete("/api/sources/:id/feedback/drafts/:draftId", async (req, res) => {
    await withSourceMutation(req.params.id!, async () => {
      await requireSource(repository, req.params.id!);
      const draft = feedbackDrafts.get(req.params.draftId!);
      if (draft?.data.sourceId === req.params.id) {
        feedbackDrafts.delete(req.params.draftId!);
        if (draft.imagePath) await rm(draft.imagePath, { force: true });
      }
      res.status(204).end();
    });
  });

  app.post("/api/sources/:id/feedback", async (req, res) => {
    const sourceId = req.params.id!;
    await withSourceMutation(sourceId, async () => {
    const source = await requireSource(repository, sourceId);
    await pruneExpiredFeedbackDrafts();
    const parsed = DetectionFeedbackRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid feedback report");
    const input = parsed.data, draft = feedbackDrafts.get(input.draftId);
    if (!draft || draft.data.sourceId !== source.id) throw new HttpError(409, "Feedback draft is missing, expired, or belongs to another source");
    if (draft.data.eventId !== input.eventId || (input.frameId !== undefined && draft.data.frameId !== input.frameId)) throw new HttpError(409, "Feedback does not match its pinned analysis event");
    const event = (await repository.getEvents(source.id)).find((item) => item.id === draft.data.eventId && item.sessionId === draft.data.sessionId);
    if (!event) throw new HttpError(409, "The pinned analysis event is no longer retained");
    const detection = input.detectionIndex === undefined ? undefined : event.detections[input.detectionIndex];
    if (input.detectionIndex !== undefined && !detection) throw new HttpError(400, "Detection index is not present in this event");
    const duplicate = input.duplicateOfDetectionIndex === undefined ? undefined : event.detections[input.duplicateOfDetectionIndex];
    if (input.duplicateOfDetectionIndex !== undefined && !duplicate) throw new HttpError(400, "Duplicate reference is not present in this event");
    const reports = await repository.listFeedbackReports(source.id);
    if (reports.length >= 500) throw new HttpError(507, "This source has reached its bounded feedback-report limit");
    const id = randomUUID(), now = new Date().toISOString();
    let frame: DetectionFeedback["frame"] = { provenance: "unavailable" };
    let evidencePath: string | undefined;
    if (draft.imagePath) {
      await mkdir(feedbackEvidenceDir, { recursive: true });
      const evidenceFiles = (await readdir(feedbackEvidenceDir)).filter((name) => /^[0-9a-f-]{36}\.jpg$/i.test(name));
      let evidenceBytes = 0;
      for (const name of evidenceFiles) { try { evidenceBytes += (await stat(path.join(feedbackEvidenceDir, name))).size; } catch { /* concurrently removed */ } }
      const draftBytes = await readFile(draft.imagePath);
      if (evidenceBytes + draftBytes.length > MAX_FEEDBACK_EVIDENCE_BYTES) throw new HttpError(507, "Pinned feedback evidence storage is full");
      evidencePath = path.join(feedbackEvidenceDir, `${id}.jpg`);
      await writeFile(evidencePath, draftBytes, { flag: "wx" });
      const dims = jpegDimensions(draftBytes)!;
      frame = { ...draft.data.frame, ...(event.frameId ? { frameId: event.frameId } : {}), url: `/api/sources/${source.id}/feedback/${id}/frame`, mimeType: "image/jpeg", width: dims.width, height: dims.height };
    }
    const report = DetectionFeedbackSchema.parse({
      id, sourceId: source.id, sessionId: event.sessionId, eventId: event.id, sourceTimeMs: event.sourceTimeMs,
      frameWidth: event.frameWidth, frameHeight: event.frameHeight, ...(event.frameId ? { analysisFrameId: event.frameId } : {}),
      analysisContext: event.analysisContext ?? { qualityCoverage: event.quality.coverage, qualityNotes: event.quality.notes, settingsCaptured: false }, frame,
      evidenceAvailability: evidencePath ? "native_frame" : "unavailable", annotationCoverage: "partial", kind: input.kind,
      ...(input.detectionIndex !== undefined ? { detectionIndex: input.detectionIndex } : {}),
      ...(input.duplicateOfDetectionIndex !== undefined ? { duplicateOfDetectionIndex: input.duplicateOfDetectionIndex } : {}),
      ...(detection ? { originalDetection: detection } : {}), ...(duplicate ? { duplicateDetection: duplicate } : {}),
      ...(input.bbox ? { bbox: input.bbox } : {}), ...(input.proposedCorrection ? { proposedCorrection: input.proposedCorrection } : {}),
      ...(input.note ? { note: input.note } : {}), reviewStatus: "open", reviewHistory: [], createdAt: now, updatedAt: now
    });
    const latestSource = await repository.getSource(source.id);
    const latestEvents = latestSource ? await repository.getEvents(source.id) : [];
    if (!latestSource || !latestEvents.some((item) => item.id === event.id && item.sessionId === event.sessionId) || feedbackDrafts.get(input.draftId) !== draft) {
      if (evidencePath) await rm(evidencePath, { force: true }).catch(() => undefined);
      throw new HttpError(409, "The pinned feedback evidence changed before the report could be saved");
    }
    try { await repository.putFeedbackReport(report); }
    catch (error) { if (evidencePath) await rm(evidencePath, { force: true }); if (error instanceof FeedbackCapacityError) throw new HttpError(507, error.message); throw error; }
    feedbackDrafts.delete(input.draftId);
    if (draft.imagePath) await rm(draft.imagePath, { force: true });
    res.status(201).json({ report });
    });
  });

  app.get("/api/sources/:id/feedback", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    const { offset, limit } = parsePageQuery(req.query);
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const status = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus : undefined;
    if (status && !["open", "reviewed", "dismissed"].includes(status)) throw new HttpError(400, "Unknown feedback review status");
    const reports = (await repository.listFeedbackReports(source.id)).filter((report) => (!sessionId || report.sessionId === sessionId) && (!status || report.reviewStatus === status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const page = reports.slice(offset, offset + limit), hasMore = offset + page.length < reports.length;
    res.json(FeedbackListResponseSchema.parse({ reports: page, ...(hasMore ? { nextCursor: String(offset + page.length) } : {}), hasMore, coverage: "known" }));
  });

  app.get("/api/sources/:id/feedback/:reportId", async (req, res) => {
    await requireSource(repository, req.params.id!);
    const report = await repository.getFeedbackReport(req.params.id!, req.params.reportId!);
    if (!report) throw new HttpError(404, "Feedback report not found");
    res.json({ report });
  });

  app.patch("/api/sources/:id/feedback/:reportId", async (req, res) => {
    await withSourceMutation(req.params.id!, async () => {
    await requireSource(repository, req.params.id!);
    const parsed = DetectionFeedbackUpdateSchema.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid feedback update");
    if (parsed.data.annotationCoverage === "complete") throw new HttpError(409, "Complete annotation is unavailable until full-frame annotation review is supported");
    const existing = await repository.getFeedbackReport(req.params.id!, req.params.reportId!);
    if (!existing) throw new HttpError(404, "Feedback report not found");
    const now = new Date().toISOString();
    const reviewStatus = parsed.data.reviewStatus ?? existing.reviewStatus;
    const reviewLabel = parsed.data.reviewLabel === null ? undefined : parsed.data.reviewLabel ?? existing.reviewLabel;
    const reviewNote = parsed.data.reviewNote === null ? undefined : parsed.data.reviewNote ?? existing.reviewNote;
    const history = [...existing.reviewHistory, { at: now, reviewStatus, ...(reviewLabel ? { reviewLabel } : {}), ...(reviewNote ? { reviewNote } : {}), annotationCoverage: "partial" as const }].slice(-100);
    const updated = DetectionFeedbackSchema.parse({ ...existing, reviewStatus, ...(reviewLabel ? { reviewLabel } : {}), ...(reviewNote ? { reviewNote } : {}), reviewHistory: history, updatedAt: now, annotationCoverage: "partial" });
    if (!reviewLabel) delete (updated as Partial<DetectionFeedback>).reviewLabel;
    if (!reviewNote) delete (updated as Partial<DetectionFeedback>).reviewNote;
    await repository.putFeedbackReport(updated);
    res.json({ report: updated });
    });
  });

  app.get("/api/sources/:id/feedback/:reportId/frame", async (req, res, next) => {
    await requireSource(repository, req.params.id!);
    const report = await repository.getFeedbackReport(req.params.id!, req.params.reportId!);
    if (!report || !["analysis_source_frame", "verified_media_redecode"].includes(report.frame.provenance) || report.evidenceAvailability !== "native_frame") throw new HttpError(404, "Original analysis frame is unavailable");
    const imagePath = path.join(feedbackEvidenceDir, `${report.id}.jpg`);
    try { const info = await stat(imagePath); if (!info.size || info.size > MAX_NATIVE_FRAME_BYTES) throw new Error(); }
    catch { throw new HttpError(404, "Pinned original analysis frame is unavailable"); }
    res.type("image/jpeg").set("Cache-Control", "private, no-store");
    createReadStream(imagePath).on("error", next).pipe(res);
  });

  app.get("/api/sources/:id/frames/:frameId", async (req, res, next) => {
    const source = await requireSource(repository, req.params.id!);
    const frameId = req.params.frameId!;
    const event = (await repository.getEvents(source.id)).find((item) => item.frameId === frameId);
    if (!event) throw new HttpError(404, "Native frame is not attached to retained analysis history");
    await framePublications.get(frameId);
    const imagePath = path.join(nativeFrameDir, `${frameId}.jpg`);
    try { const info = await stat(imagePath); if (!info.size || info.size > MAX_NATIVE_FRAME_BYTES) throw new Error(); }
    catch { throw new HttpError(404, "Native analysis frame was evicted or unavailable"); }
    res.type("image/jpeg").set("Cache-Control", "private, no-store");
    createReadStream(imagePath).on("error", next).pipe(res);
  });

  app.get("/api/sources/:id/tracks/:trackId", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!sessionId) throw new HttpError(400, "sessionId is required to inspect a track");
    const { offset, limit } = parsePageQuery(req.query), trackId = req.params.trackId!;
    const [events, aggregate] = await Promise.all([repository.getEvents(source.id), repository.getAggregate(source.id)]);
    const contains = (x: number, y: number, polygon: Scene["zones"][number]["polygon"]) => {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[j]!, b = polygon[i]!;
        if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };
    const observations = events.filter((event) => event.sessionId === sessionId).flatMap((event) => event.detections.flatMap((detection, detectionIndex) => detection.trackId === trackId ? [{
      eventId: event.id, ...(event.frameId ? { frameId: event.frameId } : {}), sourceTimeMs: event.sourceTimeMs, frameWidth: event.frameWidth, frameHeight: event.frameHeight,
      detectionIndex, bbox: detection.bbox, class: detection.class, ...(detection.color ? { color: detection.color } : {}), confidence: detection.confidence,
      zoneIds: event.analysisContext?.settingsCaptured && event.analysisContext.scene
        ? event.analysisContext.scene.snapshot.zones.filter((zone) => contains(detection.bbox.x + detection.bbox.width / 2, detection.bbox.y + detection.bbox.height / 2, zone.polygon)).map((zone) => zone.id)
        : [],
      zoneAttribution: event.analysisContext?.settingsCaptured && event.analysisContext.scene ? "captured_scene" as const : "unavailable" as const,
      crossings: event.crossings.filter((crossing) => crossing.trackId === trackId).map(({ lineId, direction }) => ({ lineId, direction }))
    }] : [])).sort((a, b) => a.sourceTimeMs - b.sourceTimeMs || a.eventId.localeCompare(b.eventId) || a.detectionIndex - b.detectionIndex);
    if (!observations.length) throw new HttpError(404, "Track has no observations in retained event history for this session");
    const page = observations.slice(offset, offset + limit), hasMore = offset + page.length < observations.length;
    res.json(TrackPageResponseSchema.parse({ track: { sourceId: source.id, sessionId, trackId, observationCount: observations.length, coverage: aggregate.historyTruncated ? "truncated" : "known", firstObservedAtMs: observations[0]!.sourceTimeMs, lastObservedAtMs: observations.at(-1)!.sourceTimeMs }, observations: page, ...(hasMore ? { nextCursor: String(offset + page.length) } : {}), hasMore }));
  });

  app.get("/api/sources/:id/summary", async (req, res) => {
    await requireSource(repository, req.params.id!);
    const activeSessionId = activeSessions.get(req.params.id!);
    const [events, aggregate] = await Promise.all([repository.getEvents(req.params.id!), repository.getAggregate(req.params.id!, activeSessionId)]);
    const summary = SummaryResponseSchema.parse({ summary: buildSummary(req.params.id!, events, aggregate) });
    res.json(summary);
  });

  app.get("/api/sources/:id/video", async (req, res, next) => {
    await requireSource(repository, req.params.id!);
    const assetPath = await repository.getAssetPath(req.params.id!);
    if (!assetPath) throw new HttpError(404, "This source has no uploaded video");
    const resolvedAsset = path.resolve(assetPath);
    if (!resolvedAsset.startsWith(`${uploadDir}${path.sep}`)) throw new HttpError(403, "Stored video path is outside the upload directory");
    const fileStat = await stat(resolvedAsset);
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) { res.status(416).set("Content-Range", `bytes */${fileStat.size}`).end(); return; }
      let start = match[1] ? Number(match[1]) : Math.max(0, fileStat.size - Number(match[2]));
      let end = match[1] ? (match[2] ? Number(match[2]) : fileStat.size - 1) : fileStat.size - 1;
      if (start < 0 || end < start || start >= fileStat.size) { res.status(416).set("Content-Range", `bytes */${fileStat.size}`).end(); return; }
      end = Math.min(end, fileStat.size - 1);
      res.status(206).set({ "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${fileStat.size}`, "Content-Length": String(end - start + 1), "Content-Type": `video/${path.extname(resolvedAsset).slice(1)}` });
      createReadStream(resolvedAsset, { start, end }).on("error", next).pipe(res);
      return;
    }
    res.status(200).set({ "Accept-Ranges": "bytes", "Content-Length": String(fileStat.size), "Content-Type": `video/${path.extname(resolvedAsset).slice(1)}` });
    createReadStream(resolvedAsset).on("error", next).pipe(res);
  });

  app.get("/api/sources/:id/stream", async (req, res) => {
    const source = await requireSource(repository, req.params.id!);
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    res.write(`event: status\ndata: ${JSON.stringify({ source })}\n\n`);
    const set = streamSubscribers.get(source.id) ?? new Set<express.Response>();
    set.add(res); streamSubscribers.set(source.id, set);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
    req.on("close", () => { clearInterval(heartbeat); set.delete(res); if (!set.size) streamSubscribers.delete(source.id); });
  });

  app.delete("/api/sources/:id", async (req, res) => {
    await withSourceMutation(req.params.id!, async () => {
    const source = await requireSource(repository, req.params.id!);
    if (source.status === "running") throw new HttpError(409, "Stop the source before deleting it");
    if (startsInProgress.has(source.id) || stopsInProgress.has(source.id) || probesInProgress.has(source.id)) throw new HttpError(409, "Wait for the source operation to finish before deleting it");
    const assetPath = await repository.getAssetPath(source.id);
    if (assetPath) {
      const resolvedAsset = path.resolve(assetPath);
      if (resolvedAsset.startsWith(`${uploadDir}${path.sep}`)) await rm(resolvedAsset, { force: true });
    }
    const reports = await repository.listFeedbackReports(source.id);
    for (const report of reports) await rm(path.join(feedbackEvidenceDir, `${report.id}.jpg`), { force: true }).catch(() => undefined);
    for (const [draftId, draft] of feedbackDrafts) if (draft.data.sourceId === source.id) {
      feedbackDrafts.delete(draftId);
      if (draft.imagePath) await rm(draft.imagePath, { force: true }).catch(() => undefined);
    }
    const frameEvents = await repository.getEvents(source.id);
    for (const event of frameEvents) if (event.frameId) await rm(path.join(nativeFrameDir, `${event.frameId}.jpg`), { force: true }).catch(() => undefined);
    await repository.deleteSource(source.id);
    await forgetPreviews(source.id);
    res.status(204).end();
    });
  });

  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    const isUploadTooLarge = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE";
    const status = error instanceof HttpError ? error.status : error instanceof FeedbackCapacityError ? 507 : error instanceof multer.MulterError ? isUploadTooLarge ? 413 : 400 : 500;
    const message = isUploadTooLarge
      ? `Video exceeds the configured ${Math.floor(maxUploadBytes / (1024 * 1024))} MiB upload limit.`
      : error instanceof Error ? error.message : "Unexpected API error";
    res.status(status).json({ error: message });
  };
  app.use(errors);
  return app;
}

async function requireSource(repository: SourceRepository, id: string): Promise<Source> {
  const source = await repository.getSource(id);
  if (!source) throw new HttpError(404, "Source not found");
  return source;
}
