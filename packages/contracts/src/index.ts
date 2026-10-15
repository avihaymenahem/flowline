import { z } from "zod";

export const SourceKindSchema = z.enum(["webcam", "stream", "upload", "youtube"]);
export const SourceStatusSchema = z.enum(["idle", "running", "stopped", "completed", "error"]);
export const SourceLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  label: z.string().trim().min(1).max(120).optional()
}).strict();
export const SourceFolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  createdAt: z.string().datetime()
}).strict();
export const PointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const PolygonSchema = z.array(PointSchema).min(3).max(128);
export const ZoneSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(120), polygon: PolygonSchema });
export const CountingLineSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().min(1).max(120), start: PointSchema, end: PointSchema,
  directionLabels: z.tuple([z.string().min(1).max(40), z.string().min(1).max(40)]).default(["A to B", "B to A"])
}).refine((line) => line.start.x !== line.end.x || line.start.y !== line.end.y, "Line endpoints must differ");
export const SceneSchema = z.object({ zones: z.array(ZoneSchema).max(100), countingLines: z.array(CountingLineSchema).max(100) });

/** Geometry identity shared by backend counts and clients that decide whether those counts are current. */
export function sceneGeometryParts(scene: Scene): { zones: string; lines: string } {
  const lexical = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const zones = scene.zones.map((zone) => [zone.id, zone.polygon.map((point) => [point.x, point.y])] as const)
    .sort((left, right) => lexical(left[0], right[0]) || lexical(JSON.stringify(left), JSON.stringify(right)));
  const lines = scene.countingLines.map((line) => [line.id, [line.start.x, line.start.y], [line.end.x, line.end.y]] as const)
    .sort((left, right) => lexical(left[0], right[0]) || lexical(JSON.stringify(left), JSON.stringify(right)));
  return { zones: `z1:${JSON.stringify(zones)}`, lines: `l1:${JSON.stringify(lines)}` };
}

export function sceneGeometrySignature(scene: Scene): string {
  const parts = sceneGeometryParts(scene);
  return `g1:${JSON.stringify([JSON.parse(parts.zones.slice(3)), JSON.parse(parts.lines.slice(3))])}`;
}

export const RecordingTimeSchema = z.object({
  effectiveStartAt: z.string().datetime({ offset: true }),
  provenance: z.enum(["embedded_metadata", "manual_override"]),
  embeddedStartAt: z.string().datetime({ offset: true }).optional(),
  embeddedField: z.literal("mvhd_creation_time").optional()
}).refine((value) => value.provenance !== "embedded_metadata" || value.embeddedStartAt === value.effectiveStartAt, "Embedded recording time must identify its effective timestamp");

export const SourceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), kind: SourceKindSchema,
  status: SourceStatusSchema, createdAt: z.string().datetime(), url: z.string().url().optional(),
  folderId: z.string().uuid().optional(),
  location: SourceLocationSchema.optional(),
  youtube: z.object({ videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), title: z.string().max(200).optional(), isLive: z.boolean().optional(), liveStatus: z.enum(["is_live", "not_live", "was_live", "post_live", "is_upcoming", "unknown"]).optional() }).optional(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  durationMs: z.number().nonnegative().optional(), recordingTime: RecordingTimeSchema.optional(), error: z.string().max(1000).optional()
});

export const DetectionSchema = z.object({
  bbox: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) }),
  class: z.string().min(1).max(80), color: z.string().max(40).optional(), colorMethod: z.enum(["hsv_estimate", "classifier"]).optional(),
  colorSupportRatio: z.number().min(0).max(1).optional(), confidence: z.number().min(0).max(1), trackId: z.string().min(1).max(100).optional()
}).refine((d) => d.bbox.x + d.bbox.width <= 1 && d.bbox.y + d.bbox.height <= 1, "Bounding box must fit inside normalized frame");
export const NormalizedBBoxSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().min(0).max(1), height: z.number().min(0).max(1) })
  .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, "Bounding box must fit inside normalized frame");
export const CrossingSchema = z.object({ lineId: z.string().min(1), direction: z.string().min(1).max(80), trackId: z.string().min(1).max(100) });
export const AnalysisContextSchema = z.object({
  settingsCaptured: z.boolean(),
  detector: z.object({ backend: z.string().min(1).max(80), modelName: z.string().max(160).optional(), device: z.string().max(80).optional(), detectorSize: z.string().max(40).optional(),
    inputSize: z.number().int().positive().max(4096).optional(), nms: z.boolean().optional(), confidenceThreshold: z.number().min(0).max(1).optional(), iouThreshold: z.number().min(0).max(1).optional() }).optional(),
  sampling: z.object({ sampleEveryMs: z.number().nonnegative().max(3_600_000).optional() }).optional(),
  detectionMode: z.enum(["auto", "full", "line_roi", "tiled"]).optional(), tracker: z.object({ backend: z.string().min(1).max(80) }).optional(),
  scene: z.object({ geometrySignature: z.string().min(1).max(10_000), snapshot: SceneSchema }).optional(),
  qualityCoverage: z.enum(["known", "unknown"]).optional(), qualityNotes: z.array(z.string()).optional()
}).superRefine((context, issue) => {
  if (!context.settingsCaptured) return;
  if (!context.detector) issue.addIssue({ code: "custom", path: ["detector"], message: "Captured settings require detector identity" });
  if (!context.tracker) issue.addIssue({ code: "custom", path: ["tracker"], message: "Captured settings require tracker identity" });
  if (!context.scene) issue.addIssue({ code: "custom", path: ["scene"], message: "Captured settings require an inference scene snapshot" });
  else if (context.scene.geometrySignature !== sceneGeometrySignature(context.scene.snapshot)) {
    issue.addIssue({ code: "custom", path: ["scene", "geometrySignature"], message: "Scene geometry signature does not match its snapshot" });
  }
});
export const AnalysisEventSchema = z.object({
  id: z.string().min(1).max(200), sourceId: z.string().uuid(), sessionId: z.string().min(1).max(200),
  sourceTimeMs: z.number().nonnegative(), frameWidth: z.number().int().positive(), frameHeight: z.number().int().positive(),
  frameId: z.string().uuid().optional(), type: z.enum(["analysis", "crossing"]), detections: z.array(DetectionSchema).default([]),
  crossings: z.array(CrossingSchema).default([]), quality: z.object({ coverage: z.enum(["known", "unknown"]), notes: z.array(z.string()).default([]) }), analysisContext: AnalysisContextSchema.optional()
});

export const FeedbackKindSchema = z.enum(["duplicate", "missed_vehicle", "false_positive", "wrong_type", "wrong_color"]);
export const FeedbackReviewStatusSchema = z.enum(["open", "reviewed", "dismissed"]);
export const FeedbackFrameSchema = z.object({
  frameId: z.string().uuid().optional(), provenance: z.enum(["analysis_source_frame", "verified_media_redecode", "unavailable"]), url: z.string().optional(),
  mimeType: z.literal("image/jpeg").optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional()
});
export const AnnotationCoverageSchema = z.enum(["partial", "complete"]);
export const FeedbackDraftSchema = z.object({
  draftId: z.string().uuid(), sourceId: z.string().uuid(), sessionId: z.string().min(1).max(200), eventId: z.string().min(1).max(200),
  frameId: z.string().uuid().optional(), frame: FeedbackFrameSchema, expiresAt: z.string().datetime()
});
export const FeedbackCorrectionSchema = z.object({
  /** Optional model taxonomy label; separate from the immutable detector class. */
  correctedClassLabel: z.enum(["car", "van", "pickup_truck", "suv", "motorcycle", "bus", "truck", "bicycle", "other_vehicle"]).optional(),
  class: z.string().trim().min(1).max(80).optional(), color: z.string().trim().min(1).max(40).optional(), bbox: NormalizedBBoxSchema.optional()
}).refine((correction) => correction.correctedClassLabel !== undefined || correction.class !== undefined || correction.color !== undefined || correction.bbox !== undefined, "A correction must include a class, color, or bounding box");
export const DetectionFeedbackRequestSchema = z.object({
  draftId: z.string().uuid(), eventId: z.string().min(1).max(200), frameId: z.string().uuid().optional(), kind: FeedbackKindSchema,
  detectionIndex: z.number().int().nonnegative().optional(), bbox: NormalizedBBoxSchema.optional(),
  duplicateOfDetectionIndex: z.number().int().nonnegative().optional(), proposedCorrection: FeedbackCorrectionSchema.optional(), note: z.string().trim().max(1000).optional()
}).superRefine((value, context) => {
  if (value.kind === "missed_vehicle") {
    if (!value.bbox) context.addIssue({ code: "custom", path: ["bbox"], message: "A missed vehicle report needs a normalized box" });
    if (value.detectionIndex !== undefined) context.addIssue({ code: "custom", path: ["detectionIndex"], message: "A missed vehicle cannot reference an existing detection" });
    if (!value.proposedCorrection?.class && !value.proposedCorrection?.correctedClassLabel) context.addIssue({ code: "custom", path: ["proposedCorrection", "correctedClassLabel"], message: "A missed vehicle report needs a vehicle class" });
  } else if (value.detectionIndex === undefined) {
    context.addIssue({ code: "custom", path: ["detectionIndex"], message: "Select the detection being reported" });
  }
  if (value.kind === "duplicate" && value.duplicateOfDetectionIndex === undefined) context.addIssue({ code: "custom", path: ["duplicateOfDetectionIndex"], message: "Select the other detection in the duplicate pair" });
  if (value.kind !== "duplicate" && value.duplicateOfDetectionIndex !== undefined) context.addIssue({ code: "custom", path: ["duplicateOfDetectionIndex"], message: "Only duplicate reports can reference a second detection" });
  if (value.kind === "duplicate" && value.detectionIndex !== undefined && value.duplicateOfDetectionIndex === value.detectionIndex) context.addIssue({ code: "custom", path: ["duplicateOfDetectionIndex"], message: "Duplicate detections must be different" });
  if (value.kind === "wrong_type" && !value.proposedCorrection?.class && !value.proposedCorrection?.correctedClassLabel) context.addIssue({ code: "custom", path: ["proposedCorrection", "correctedClassLabel"], message: "Provide the corrected class" });
  if (value.kind === "wrong_color" && !value.proposedCorrection?.color) context.addIssue({ code: "custom", path: ["proposedCorrection", "color"], message: "Provide the corrected color" });
});
export const DetectionFeedbackSchema = z.object({
  id: z.string().uuid(), sourceId: z.string().uuid(), sessionId: z.string().min(1).max(200), eventId: z.string().min(1).max(200),
  sourceTimeMs: z.number().nonnegative(), frameWidth: z.number().int().positive(), frameHeight: z.number().int().positive(),
  analysisFrameId: z.string().uuid().optional(), analysisContext: AnalysisContextSchema,
  frame: FeedbackFrameSchema, evidenceAvailability: z.enum(["native_frame", "unavailable"]), annotationCoverage: AnnotationCoverageSchema,
  kind: FeedbackKindSchema, detectionIndex: z.number().int().nonnegative().optional(), duplicateOfDetectionIndex: z.number().int().nonnegative().optional(),
  originalDetection: DetectionSchema.optional(), duplicateDetection: DetectionSchema.optional(), bbox: NormalizedBBoxSchema.optional(), proposedCorrection: FeedbackCorrectionSchema.optional(), note: z.string().max(1000).optional(),
  reviewStatus: FeedbackReviewStatusSchema, reviewLabel: z.string().trim().min(1).max(80).optional(), reviewNote: z.string().max(1000).optional(),
  reviewHistory: z.array(z.object({ at: z.string().datetime(), reviewStatus: FeedbackReviewStatusSchema, reviewLabel: z.string().max(80).optional(), reviewNote: z.string().max(1000).optional(), annotationCoverage: AnnotationCoverageSchema })).max(100),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
});
export const DetectionFeedbackUpdateSchema = z.object({
  reviewStatus: FeedbackReviewStatusSchema.optional(), reviewLabel: z.string().trim().min(1).max(80).nullable().optional(),
  reviewNote: z.string().trim().max(1000).nullable().optional(), annotationCoverage: AnnotationCoverageSchema.optional()
}).refine((value) => Object.keys(value).length > 0, "Provide at least one review field to update");
export const FeedbackListResponseSchema = z.object({ reports: z.array(DetectionFeedbackSchema), nextCursor: z.string().optional(), hasMore: z.boolean(), coverage: z.enum(["known", "truncated"]) });
export const FeedbackDraftResponseSchema = z.object({ draft: FeedbackDraftSchema });
export const DetectionFeedbackResponseSchema = z.object({ report: DetectionFeedbackSchema });
export const TrackObservationSchema = z.object({
  eventId: z.string().min(1).max(200), frameId: z.string().uuid().optional(), sourceTimeMs: z.number().nonnegative(),
  frameWidth: z.number().int().positive(), frameHeight: z.number().int().positive(), detectionIndex: z.number().int().nonnegative(),
  bbox: NormalizedBBoxSchema, class: z.string().min(1).max(80), color: z.string().max(40).optional(), confidence: z.number().min(0).max(1),
  zoneIds: z.array(z.string().min(1).max(80)), zoneAttribution: z.enum(["captured_scene", "unavailable"]),
  crossings: z.array(z.object({ lineId: z.string().min(1).max(80), direction: z.string().min(1).max(80) }))
});
export const TrackPageResponseSchema = z.object({
  track: z.object({ sourceId: z.string().uuid(), sessionId: z.string().min(1).max(200), trackId: z.string().min(1).max(100), observationCount: z.number().int().nonnegative(), coverage: z.enum(["known", "truncated"]), firstObservedAtMs: z.number().nonnegative().nullable(), lastObservedAtMs: z.number().nonnegative().nullable() }),
  observations: z.array(TrackObservationSchema), nextCursor: z.string().optional(), hasMore: z.boolean()
});

export const UniqueVehicleCompletenessSchema = z.enum(["known", "partial", "unknown"]);
export const UniqueVehicleCountSchema = z.object({
  count: z.number().int().nonnegative().nullable(), completeness: UniqueVehicleCompletenessSchema
});
export const UniqueVehiclesSummarySchema = z.object({
  sessionId: z.string().min(1), geometrySignature: z.string().min(1),
  completeness: UniqueVehicleCompletenessSchema,
  all: UniqueVehicleCountSchema,
  zones: z.array(z.object({ zoneId: z.string(), count: z.number().int().nonnegative().nullable(), completeness: UniqueVehicleCompletenessSchema })),
  lines: z.array(z.object({ lineId: z.string(), count: z.number().int().nonnegative().nullable(), completeness: UniqueVehicleCompletenessSchema })),
  note: z.string()
});

export const SummarySchema = z.object({
  sourceId: z.string().uuid(), sessionId: z.string().optional(), visibleVehicleCount: z.number().int().nonnegative().nullable(),
  crossings: z.array(z.object({ lineId: z.string(), direction: z.string(), count: z.number().int().nonnegative() })),
  coverage: z.enum(["known", "unknown"]), analyzedDurationMs: z.number().nonnegative().nullable(),
  historyTruncated: z.boolean().default(false), discardedEventCount: z.number().int().nonnegative().nullable().default(0), note: z.string().optional(),
  uniqueVehicles: UniqueVehiclesSummarySchema.optional()
});
export const HealthSchema = z.object({
  status: z.enum(["ok", "degraded"]), worker: z.object({ available: z.boolean(), detail: z.string() }),
  upload: z.object({ maxBytes: z.number().int().positive() })
});

export const SourcesResponseSchema = z.object({ sources: z.array(SourceSchema), folders: z.array(SourceFolderSchema).default([]) });
export const SourceFoldersResponseSchema = z.object({ sources: z.array(SourceSchema), folders: z.array(SourceFolderSchema) });
export const SourceFolderResponseSchema = z.object({ folder: SourceFolderSchema });
export const SourceResponseSchema = z.object({ source: SourceSchema });
export const SceneResponseSchema = z.object({ scene: SceneSchema });
export const EventsResponseSchema = z.object({ events: z.array(AnalysisEventSchema), truncated: z.boolean().default(false), discardedCount: z.number().int().nonnegative().nullable().default(0) });
export const SummaryResponseSchema = z.object({ summary: SummarySchema });
export const HealthResponseSchema = HealthSchema;

export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type SourceLocation = z.infer<typeof SourceLocationSchema>;
export type SourceFolder = z.infer<typeof SourceFolderSchema>;
export type RecordingTime = z.infer<typeof RecordingTimeSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type AnalysisEvent = z.infer<typeof AnalysisEventSchema>;
export type AnalysisContext = z.infer<typeof AnalysisContextSchema>;
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;
export type FeedbackReviewStatus = z.infer<typeof FeedbackReviewStatusSchema>;
export type DetectionFeedback = z.infer<typeof DetectionFeedbackSchema>;
export type FeedbackListResponse = z.infer<typeof FeedbackListResponseSchema>;
export type DetectionFeedbackRequest = z.infer<typeof DetectionFeedbackRequestSchema>;
export type DetectionFeedbackUpdate = z.infer<typeof DetectionFeedbackUpdateSchema>;
export type FeedbackDraft = z.infer<typeof FeedbackDraftSchema>;
export type TrackObservation = z.infer<typeof TrackObservationSchema>;
export type TrackPageResponse = z.infer<typeof TrackPageResponseSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type UniqueVehicleCompleteness = z.infer<typeof UniqueVehicleCompletenessSchema>;
export type UniqueVehiclesSummary = z.infer<typeof UniqueVehiclesSummarySchema>;
