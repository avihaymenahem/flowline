import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import type { AnalysisEvent, Source } from "@traffic/contracts";
import { createApp } from "../src/app.js";
import { DiskSourceRepository } from "../src/repository.js";
import { DisabledWorker } from "../src/worker.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "traffic-source-folders-"));
  temporaryDirectories.push(directory);
  return directory;
}

function source(id = randomUUID()): Source {
  return { id, name: "Camera", kind: "stream", status: "completed", createdAt: "2026-10-13T12:00:00.000Z", url: "rtsp://127.0.0.1:8554/live", location: { latitude: 32.08, longitude: 34.79, label: "Site" } };
}

function event(sourceId: string): AnalysisEvent {
  return { id: "event-1", sourceId, sessionId: "session-1", sourceTimeMs: 1000, frameWidth: 640, frameHeight: 480, type: "analysis", detections: [{ bbox: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 }, class: "car", confidence: 0.95, trackId: "car-1" }], crossings: [], quality: { coverage: "known", notes: [] } };
}

describe("source folders", () => {
  it("migrates a legacy repository to an empty folder list and persists it", async () => {
    const directory = await tempDirectory();
    const camera = source();
    await writeFile(path.join(directory, "repository.json"), JSON.stringify({ sources: [camera], scenes: {}, events: {}, assets: {}, uploadRequests: {}, eventIds: {}, aggregates: {}, historyTruncated: {}, discardedEventCount: {} }));

    const repository = new DiskSourceRepository(directory);
    assert.deepEqual(await repository.getLibrarySnapshot(), { sources: [camera], folders: [] });
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "repository.json"), "utf8")).sourceFolders, []);
  });

  it("creates, renames, moves, orders and deletes folders without changing source data", async () => {
    const directory = await tempDirectory();
    const repository = new DiskSourceRepository(directory);
    const app = createApp({ repository, worker: new DisabledWorker(), dataDir: directory, uploadDir: path.join(directory, "uploads") });
    try {
      const first = source();
      const second = source();
      await repository.putSource(first);
      await repository.putSource(second);
      const scene = { zones: [{ id: "zone-1", name: "North", polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] }], countingLines: [] };
      await repository.putScene(first.id, scene);
      await repository.appendEvent(first.id, event(first.id));
      await repository.setAssetPath(first.id, path.join(directory, "camera.mp4"));

      const created = await request(app).post("/api/source-folders").send({ name: "  City Cameras  " }).expect(201);
      const folderId = created.body.folders[0].id as string;
      assert.equal(created.body.folders[0].name, "City Cameras");
      await request(app).post("/api/source-folders").send({ name: "city cameras" }).expect(409);
      await request(app).patch(`/api/source-folders/${folderId}`).send({ name: "  Downtown  " }).expect(200);
      await request(app).put(`/api/sources/${first.id}/organization`).send({ folderId }).expect(200);
      const moved = await request(app).put(`/api/sources/${second.id}/organization`).send({ folderId, beforeSourceId: first.id }).expect(200);
      assert.deepEqual(moved.body.sources.map((item: Source) => item.id), [second.id, first.id]);

      const afterMove = new DiskSourceRepository(directory);
      assert.equal((await afterMove.getSource(first.id))?.folderId, folderId);
      assert.equal((await afterMove.getSource(second.id))?.folderId, folderId);
      await repository.putSource({ ...first, status: "running" });
      assert.equal((await repository.getSource(first.id))?.folderId, folderId, "a stale lifecycle snapshot must not clear folder membership");
      await request(app).put(`/api/sources/${first.id}/organization`).send({ folderId, beforeSourceId: randomUUID() }).expect(404);
      await request(app).put(`/api/sources/${first.id}/organization`).send({ folderId: randomUUID() }).expect(404);
      await request(app).put(`/api/sources/${first.id}/organization`).send({ folderId, beforeSourceId: first.id }).expect(400);
      await request(app).put(`/api/sources/${first.id}/organization`).send({ folderId, extra: true }).expect(400);

      const deleted = await request(app).delete(`/api/source-folders/${folderId}`).expect(200);
      assert.deepEqual(deleted.body.folders, []);
      assert.deepEqual(deleted.body.sources.map((item: Source) => item.id), [second.id, first.id]);
      const reopened = new DiskSourceRepository(directory);
      const restored = await reopened.getSource(first.id);
      assert.equal(restored?.folderId, undefined);
      assert.deepEqual(restored, { ...first, status: "running" });
      assert.deepEqual(await reopened.getScene(first.id), scene);
      assert.deepEqual(await reopened.getEvents(first.id), [event(first.id)]);
      assert.equal(await reopened.getAssetPath(first.id), path.join(directory, "camera.mp4"));
    } finally { await app.closeResources(); }
  });

  it("rejects malformed names and unknown folder/source IDs", async () => {
    const directory = await tempDirectory();
    const app = createApp({ repository: new DiskSourceRepository(directory), worker: new DisabledWorker(), dataDir: directory, uploadDir: path.join(directory, "uploads") });
    try {
      for (const body of [{}, { name: "   " }, { name: "x".repeat(121) }, { name: "valid", extra: true }, { name: 42 }]) {
        await request(app).post("/api/source-folders").send(body).expect(400);
      }
      await request(app).patch(`/api/source-folders/${randomUUID()}`).send({ name: "Missing" }).expect(404);
      await request(app).delete(`/api/source-folders/${randomUUID()}`).expect(404);
      await request(app).put(`/api/sources/${randomUUID()}/organization`).send({ folderId: null }).expect(404);
      await request(app).put(`/api/sources/${randomUUID()}/organization`).send({ folderId: "not-a-uuid" }).expect(400);
      await request(app).get("/api/sources").expect(200).expect(({ body }) => assert.deepEqual(body, { sources: [], folders: [] }));
    } finally { await app.closeResources(); }
  });

  it("hides an uncommitted organization change from readers and rolls back only organization state on save failure", async () => {
    const directory = await tempDirectory();
    let shouldFail = false;
    let enteredRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => { enteredRename = resolve; });
    let unblockRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { unblockRename = resolve; });
    const repository = new DiskSourceRepository(directory, {
      onPersistenceError: () => undefined,
      renameFile: async (from, to) => {
        if (shouldFail) {
          shouldFail = false;
          enteredRename();
          await renameGate;
          throw Object.assign(new Error("injected save failure"), { code: "EIO" });
        }
        await rename(from, to);
      }
    });
    const camera = source();
    await repository.putSource(camera);
    const folderId = randomUUID();
    await repository.createSourceFolder({ id: folderId, name: "Original", createdAt: "2026-10-13T12:00:00.000Z" });
    await repository.organizeSource(camera.id, folderId);

    shouldFail = true;
    const failedMove = repository.organizeSource(camera.id, null);
    await renameEntered;
    let readFinished = false;
    const pendingRead = repository.getLibrarySnapshot().then((snapshot) => { readFinished = true; return snapshot; });
    assert.equal(readFinished, false, "library reads must wait for the pending organization transaction");
    const staleLifecycle = repository.putSource({ ...camera, status: "running" });
    const concurrentEvent = repository.appendEvent(camera.id, event(camera.id));
    unblockRename();
    await assert.rejects(failedMove, /injected save failure/);
    const snapshot = await pendingRead;
    assert.equal(snapshot.sources[0]?.folderId, folderId);
    assert.equal(snapshot.folders[0]?.name, "Original");
    await Promise.all([staleLifecycle, concurrentEvent]);
    const reopened = new DiskSourceRepository(directory);
    const restored = await reopened.getSource(camera.id);
    assert.equal(restored?.status, "running");
    assert.equal(restored?.folderId, folderId);
    assert.deepEqual(await reopened.getEvents(camera.id), [event(camera.id)]);
    assert.equal((await reopened.getLibrarySnapshot()).folders[0]?.name, "Original");

    const retriedMove = await repository.organizeSource(camera.id, null);
    assert.equal(retriedMove.sources[0]?.folderId, undefined);
    assert.equal((await new DiskSourceRepository(directory).getSource(camera.id))?.folderId, undefined);
  });

  it("serializes source deletion behind an in-flight organization save without resurrecting the source", async () => {
    const directory = await tempDirectory();
    let blockNextRename = false;
    let enteredRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => { enteredRename = resolve; });
    let unblockRename!: () => void;
    const renameGate = new Promise<void>((resolve) => { unblockRename = resolve; });
    const repository = new DiskSourceRepository(directory, {
      renameFile: async (from, to) => {
        if (blockNextRename) {
          blockNextRename = false;
          enteredRename();
          await renameGate;
        }
        await rename(from, to);
      }
    });
    const camera = source();
    await repository.putSource(camera);
    const folderId = randomUUID();
    await repository.createSourceFolder({ id: folderId, name: "Cameras", createdAt: "2026-10-13T12:00:00.000Z" });
    await repository.organizeSource(camera.id, folderId);

    blockNextRename = true;
    const pendingMove = repository.organizeSource(camera.id, null);
    await renameEntered;
    let deleteFinished = false;
    const pendingDelete = repository.deleteSource(camera.id).then(() => { deleteFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(deleteFinished, false, "deletion must wait for the organization transaction to commit");
    unblockRename();
    await Promise.all([pendingMove, pendingDelete]);
    assert.equal(await new DiskSourceRepository(directory).getSource(camera.id), undefined);
  });
});
