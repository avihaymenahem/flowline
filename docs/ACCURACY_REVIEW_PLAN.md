# Accuracy reports and track inspection

User approved these two features on 2026-10-13. The parent agent owns product decisions and QA; lower-cost agents implement vision, API/contracts, and web changes.

## Detection feedback

- Open Report frame or select a vehicle from an exact analyzed image. Uploaded playback must pause on an actual sample before collecting corrections; estimated overlay motion is not annotation evidence.
- Reserve the source/session/event identity and its matching native-resolution decoded JPEG before opening the editor. Bounded drafts expire after 15 minutes; submitted reports retain their evidence independently of the rolling frame cache.
- Support duplicate vehicle, missed vehicle, false vehicle, incorrect type and incorrect color. A duplicate links two distinct detections in the same event; a missed vehicle has a new normalized box and explicit class.
- Preserve original events and totals. Save the prediction snapshot, source/session/time, available model/settings and scene provenance, proposed correction, note, evidence availability and review history separately.
- Reports are partial annotations. Reviewed means the issue was verified; it does not mean every vehicle in the image was labelled. No automatic training or unchecked predictions exported as ground truth.
- Capture the native dimensions of the image used for inference without painted overlays. JPEG compression and availability are explicit. An unavailable legacy image remains unavailable; a resized screenshot is not substituted as native evidence. On-demand recovery from an upload is allowed only when its source timestamp and dimensions can be verified.
- Saved reports are accessible after refresh in Observations, with source/session/status filters and review detail/status changes. UI handles stale source navigation, async ownership, expiry, storage limits and retries.

## Tracking and inspector

- Clicking a tracked vehicle opens its actual sampled path, observation timestamps, predicted types/colors/confidence and contributing zones/crossings. IDs are scoped to source and session; no cross-camera identity inference.
- Untracked detections, missing frames and truncated history have explicit states. Paths use real sample positions; estimated movement is not new evidence.
- Compare maintained association alternatives with the existing motion/IoU tracker using the same detections and actual sample interval. Include manual identities on separate development and held-out clips, plus gap/reset/class-flicker/occlusion and concurrent-session controls.
- Switch only with supported improvement and compatibility at the current 2 FPS target. Keep detector weights, GPU configuration and tested YouTube dependencies unchanged. Evidence must distinguish full-scene accuracy from small manually reviewed subsets.

## Delivery checks

- Shared Zod schemas and migration-safe repository persistence; atomic report/evidence commit and cleanup on failure.
- Immutable source/event/frame identity, bounded artifact ownership and draft pinning. No arbitrary paths or user-supplied image substituted for worker evidence.
- Normalized correction geometry; same-event duplicate references; review updates cannot alter prediction snapshots.
- Exact event/image alignment, desktop and Android-sized interactions, URL-backed source/report access, dark theme and keyboard controls.
- Source metadata, folders, scenes, existing observations/aggregates and unique indexes preserved. Deploy only while analysis is idle; no unrequested start/stop or historical reprocessing.
- Appropriate contract/API/vision/web checks, independent review after implementation slots become available, and browser acceptance with disposable isolated QA records.

## Delivered on 2026-10-13

- Report actions in Live and the virtualized observations table, pointer/numeric annotation, same-event duplicate pairs and feedback-only finer type labels.
- Saved report images and details, review filters/status changes, another issue on the same frame with a fresh reservation, and parent-list refresh after closing review.
- Source/session track inspector with paginated real sampled positions, labels/colors/confidence, captured-scene zone attribution, recorded crossings and explicit legacy/truncated states.
- Retained native JPEGs with 15-minute draft pinning; verified legacy upload re-decode limited to 1 ms timestamp difference and identical native dimensions. Reports preserve actual captured context when available; legacy settings remain uncaptured.
- Current tracker retained after ByteTrack/OC-SORT tied on the small manual subset. Added narrowly gated class-flicker continuation, 6.5-second source-time expiry at the current 2 FPS target, and monotonic IDs after backward clock resets. Synthetic controls demonstrate the targeted behavior; wider road accuracy remains unverified.

See [VERIFICATION.md](VERIFICATION.md) for verification scope and limits. Local footage evidence is excluded from the public repository. Training and full-frame ground-truth annotation remain future work.
