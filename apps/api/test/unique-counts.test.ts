import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisEvent, Scene } from "@traffic/contracts";
import { buildSummary, DiskSourceRepository } from "../src/repository.js";

const sourceId = "00000000-0000-4000-8000-000000000041";
const square = (min: number, max: number) => [{ x: min, y: min }, { x: max, y: min }, { x: max, y: max }, { x: min, y: max }];
const scene: Scene = {
  zones: [{ id: "zone-a", name: "A", polygon: square(0, 0.5) }, { id: "zone-b", name: "B", polygon: square(0.25, 0.75) }],
  countingLines: [{ id: "__proto__", name: "Line", start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 }, directionLabels: ["A to B", "B to A"] }]
};
function event(id: string, sessionId: string, time: number, detections: AnalysisEvent["detections"] = [], crossings: AnalysisEvent["crossings"] = [], coverage: "known" | "unknown" = "known", notes: string[] = []): AnalysisEvent {
  return { id, sourceId, sessionId, sourceTimeMs: time, frameWidth: 100, frameHeight: 100, type: "analysis", detections, crossings, quality: { coverage, notes } };
}
const detection = (trackId?: string, centerX = 0.5, centerY = 0.5): AnalysisEvent["detections"][number] => ({
  bbox: { x: centerX - 0.05, y: centerY - 0.05, width: 0.1, height: 0.1 }, class: "car", confidence: 0.9,
  ...(trackId === undefined ? {} : { trackId })
});
async function temp(t: { after(fn: () => Promise<void>): void }) {
  const base = path.resolve(process.cwd(), ".tmp", "unique-count-feature", "test-data");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, "unique-counts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("durable unique tracked-ID summaries", () => {
  it("deduplicates per session/scope, includes boundaries, overlapping-zone union, and both crossing directions", async (t) => {
    const dir = await temp(t), repo = new DiskSourceRepository(dir);
    await repo.putScene(sourceId, scene);
    await repo.appendEvent(sourceId, event("e1", "session-one", 1,
      [detection("__proto__", 0.5, 0.5), detection("outside", 0.9, 0.9), detection("inside-b", 0.35, 0.35), detection(undefined, 0.4, 0.4), { ...detection("nonvehicle"), class: "person" }],
      [{ lineId: "__proto__", direction: "A to B", trackId: "__proto__" }]));
    await repo.appendEvent(sourceId, event("e2", "session-one", 2,
      [detection("__proto__", 0.4, 0.4)], [{ lineId: "__proto__", direction: "B to A", trackId: "__proto__" }]));
    await repo.appendEvent(sourceId, event("e3", "session-one", 3, [detection(" ", 0.4, 0.4)]));
    await repo.appendEvent(sourceId, event("e3", "session-one", 3, [detection("duplicate-event-id", 0.4, 0.4)]));
    const aggregate = await repo.getAggregate(sourceId, "session-one");
    const summary = buildSummary(sourceId, await repo.getEvents(sourceId), aggregate).uniqueVehicles!;
    assert.equal(summary.all.count, 2);
    assert.equal(summary.all.completeness, "known");
    assert.deepEqual(summary.zones.map((item) => [item.zoneId, item.count]), [["zone-a", 2], ["zone-b", 2]]);
    assert.deepEqual(summary.lines.map((item) => [item.lineId, item.count]), [["__proto__", 1]]);
    await repo.appendEvent(sourceId, event("e4", "session-two", 1, [detection("__proto__", 0.4, 0.4)]));
    assert.equal((await repo.getAggregate(sourceId, "session-two")).uniqueVehicles?.all.count, 1);
    const otherSource = "00000000-0000-4000-8000-000000000042";
    await repo.appendEvent(otherSource, { ...event("same-track-other-source", "session-one", 1, [detection("__proto__", 0.4, 0.4)]), sourceId: otherSource });
    assert.equal((await repo.getAggregate(otherSource, "session-one")).uniqueVehicles?.all.count, 1);
  });

  it("keeps counts across restart and legacy-history backfill without changing existing aggregates", async (t) => {
    const dir = await temp(t), repo = new DiskSourceRepository(dir);
    await repo.putScene(sourceId, scene);
    await repo.appendEvent(sourceId, event("legacy-1", "legacy-session", 1, [detection("track-a")], [{ lineId: "__proto__", direction: "A to B", trackId: "track-a" }]));
    await repo.appendEvent(sourceId, event("legacy-2", "legacy-session", 2, [detection("track-a"), detection("track-b", 0.35, 0.35)]));
    const before = await repo.getAggregate(sourceId, "legacy-session");
    const filename = path.join(dir, "repository.json"), parsed = JSON.parse(await readFile(filename, "utf8"));
    delete parsed.uniqueVehicles;
    await writeFile(filename, JSON.stringify(parsed));
    const reopened = new DiskSourceRepository(dir);
    const after = await reopened.getAggregate(sourceId, "legacy-session");
    assert.deepEqual(after.latestSession, before.latestSession);
    assert.deepEqual(after.uniqueVehicles?.all, { count: 2, completeness: "known" });
    assert.equal(after.uniqueVehicles?.lines[0]?.count, 1);
    assert.equal((await reopened.getEvents(sourceId)).length, 2);
  });

  it("keeps uniqueness durable through trimming and reports lower-bound completeness", async (t) => {
    const dir = await temp(t), rows = Array.from({ length: 20_000 }, (_unused, i) => event(`old-${i}`, "trimmed-session", i, [detection(`track-${i}`)]));
    const key = "__proto__\u0000A to B";
    const seed = { sources: [], scenes: { [sourceId]: { zones: [], countingLines: [] } }, events: { [sourceId]: rows }, assets: {}, uploadRequests: {},
      eventIds: { [sourceId]: rows.map((row) => row.id) }, aggregates: { [sourceId]: { "trimmed-session": { sessionId: "trimmed-session", crossings: { [key]: 20_000 }, minTimeMs: 0, maxTimeMs: 20_000, lastTimeMs: 20_000, latestDetections: rows.at(-1)!.detections, qualityKnown: true, clockReset: false } } },
      historyTruncated: { [sourceId]: true }, discardedEventCount: { [sourceId]: 4_200 } };
    await writeFile(path.join(dir, "repository.json"), JSON.stringify(seed));
    const repo = new DiskSourceRepository(dir);
    await repo.appendEvent(sourceId, event("new-row", "trimmed-session", 20_001, [detection("new-track")]));
    const summary = (await repo.getAggregate(sourceId, "trimmed-session")).uniqueVehicles!;
    assert.equal(summary.all.count, 20_001);
    assert.equal(summary.all.completeness, "partial");
    assert.equal((await repo.getEvents(sourceId)).length, 20_000);
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual((await reopened.getAggregate(sourceId, "trimmed-session")).uniqueVehicles?.all, { count: 20_001, completeness: "partial" });
  });

  it("keeps a new session complete when the source has older legacy-truncated history", async (t) => {
    const dir = await temp(t), prior = event("legacy-old", "legacy-old-session", 1, [detection("old-id")]);
    const seed = { sources: [], scenes: { [sourceId]: { zones: [], countingLines: [] } }, events: { [sourceId]: [prior] }, assets: {}, uploadRequests: {},
      eventIds: { [sourceId]: [prior.id] }, aggregates: { [sourceId]: { "legacy-old-session": { sessionId: "legacy-old-session", crossings: {}, minTimeMs: 1, maxTimeMs: 1, lastTimeMs: 1, latestDetections: prior.detections, qualityKnown: true, clockReset: false } } },
      historyTruncated: { [sourceId]: true }, discardedEventCount: { [sourceId]: 5 } };
    await writeFile(path.join(dir, "repository.json"), JSON.stringify(seed));
    const repo = new DiskSourceRepository(dir);
    assert.equal((await repo.getAggregate(sourceId, "legacy-old-session")).uniqueVehicles?.all.completeness, "partial");
    assert.equal((await repo.getAggregate(sourceId, "new-session")).uniqueVehicles?.all.count, null);
    await repo.appendEvent(sourceId, event("new-known", "new-session", 1, [detection("new-id")]));
    assert.deepEqual((await repo.getAggregate(sourceId, "new-session")).uniqueVehicles?.all, { count: 1, completeness: "known" });
    const reopened = new DiskSourceRepository(dir);
    assert.equal((await reopened.getAggregate(sourceId, "legacy-old-session")).uniqueVehicles?.all.completeness, "partial");
    assert.deepEqual((await reopened.getAggregate(sourceId, "new-session")).uniqueVehicles?.all, { count: 1, completeness: "known" });
  });

  it("keeps a fully indexed session known after retention trims its event window", async (t) => {
    const dir = await temp(t), rows = Array.from({ length: 20_000 }, (_unused, i) => event(`complete-${i}`, "complete-session", i, [detection(`complete-track-${i}`)]));
    const seed = { sources: [], scenes: { [sourceId]: { zones: [], countingLines: [] } }, events: { [sourceId]: rows }, assets: {}, uploadRequests: {},
      eventIds: { [sourceId]: rows.map((row) => row.id) }, aggregates: { [sourceId]: { "complete-session": { sessionId: "complete-session", crossings: {}, minTimeMs: 0, maxTimeMs: 19_999, lastTimeMs: 19_999, latestDetections: rows.at(-1)!.detections, qualityKnown: true, clockReset: false } } },
      historyTruncated: {}, discardedEventCount: {} };
    await writeFile(path.join(dir, "repository.json"), JSON.stringify(seed));
    const repo = new DiskSourceRepository(dir);
    await repo.appendEvent(sourceId, event("complete-new", "complete-session", 20_000, [detection("complete-track-new")]));
    assert.deepEqual((await repo.getAggregate(sourceId, "complete-session")).uniqueVehicles?.all, { count: 20_001, completeness: "known" });
    const reopened = new DiskSourceRepository(dir);
    assert.deepEqual((await reopened.getAggregate(sourceId, "complete-session")).uniqueVehicles?.all, { count: 20_001, completeness: "known" });
  });

  it("rebuilds only changed scene scopes from retained events and reports unknown coverage as partial", async (t) => {
    const dir = await temp(t), repo = new DiskSourceRepository(dir);
    await repo.putScene(sourceId, scene);
    await repo.appendEvent(sourceId, event("known", "scene-session", 1, [detection("tracked")], [{ lineId: "__proto__", direction: "A to B", trackId: "line-track" }]));
    const relabeled: Scene = { zones: scene.zones.map((z) => ({ ...z, name: `${z.name}!` })), countingLines: scene.countingLines.map((line) => ({ ...line, name: "Renamed", directionLabels: ["In", "Out"] })) };
    const oldSignature = (await repo.getAggregate(sourceId, "scene-session")).uniqueVehicles?.geometrySignature;
    await repo.putScene(sourceId, relabeled);
    assert.equal((await repo.getAggregate(sourceId, "scene-session")).uniqueVehicles?.geometrySignature, oldSignature);
    const changed: Scene = { zones: [{ ...scene.zones[0]!, polygon: square(0, 0.2) }, { ...scene.zones[1]!, polygon: square(0.7, 0.9) }], countingLines: relabeled.countingLines };
    await repo.putScene(sourceId, changed);
    let result = (await repo.getAggregate(sourceId, "scene-session")).uniqueVehicles!;
    assert.equal(result.all.count, 0);
    assert.equal(result.lines[0]?.count, 1);
    await repo.appendEvent(sourceId, event("unknown", "scene-session", 2, [detection("hidden")], [], "unknown"));
    result = (await repo.getAggregate(sourceId, "scene-session")).uniqueVehicles!;
    assert.equal(result.all.count, 0);
    assert.equal(result.all.completeness, "partial");
    assert.equal(result.lines[0]?.completeness, "partial");
  });

  it("keeps unseen scopes unknown, then makes later known observations partial after an unknown frame", async (t) => {
    const dir = await temp(t), repo = new DiskSourceRepository(dir);
    await repo.putScene(sourceId, { zones: [], countingLines: [] });
    await repo.appendEvent(sourceId, event("only-unknown", "coverage-session", 1, [detection("covered-later")], [], "unknown"));
    let result = (await repo.getAggregate(sourceId, "coverage-session")).uniqueVehicles!;
    assert.equal(result.all.count, null);
    assert.equal(result.completeness, "unknown");
    await repo.appendEvent(sourceId, event("known-later", "coverage-session", 2, [detection("covered-later"), { ...detection("person-id"), class: "person" }]));
    result = (await repo.getAggregate(sourceId, "coverage-session")).uniqueVehicles!;
    assert.deepEqual(result.all, { count: 1, completeness: "partial" });
    assert.equal(result.note.includes("IDs may fragment or be reused"), true);
  });

  it("marks reduced spatial sampling as partial even when the current frame is known", async (t) => {
    const dir = await temp(t), repo = new DiskSourceRepository(dir);
    await repo.putScene(sourceId, scene);
    await repo.appendEvent(sourceId, event("reduced-scope", "partial-session", 1, [detection("tracked")],
      [{ lineId: "__proto__", direction: "A to B", trackId: "line-tracked" }], "known", ["counting_line_regions_only"]));
    const result = (await repo.getAggregate(sourceId, "partial-session")).uniqueVehicles!;
    assert.equal(result.all.count, 1);
    assert.equal(result.all.completeness, "partial");
    assert.equal(result.zones[0]?.completeness, "partial");
    assert.equal(result.lines[0]?.completeness, "partial");
  });

  it("retries failed persistence on a duplicate event without double counting", async (t) => {
    const dir = await temp(t); let fail = true;
    const repo = new DiskSourceRepository(dir, { renameFile: async (from, to) => {
      if (fail) { fail = false; const error = new Error("temporary save fault") as NodeJS.ErrnoException; error.code = "EIO"; throw error; }
      const { rename } = await import("node:fs/promises"); await rename(from, to);
    }, onPersistenceError: () => undefined });
    const row = event("retry", "retry-session", 1, [detection("stable-id")]);
    await assert.rejects(repo.appendEvent(sourceId, row));
    await repo.appendEvent(sourceId, row);
    const reopened = new DiskSourceRepository(dir);
    assert.equal((await reopened.getAggregate(sourceId, "retry-session")).uniqueVehicles?.all.count, 1);
    assert.equal((await reopened.getEvents(sourceId)).length, 1);
  });
});
