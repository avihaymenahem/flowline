# Traffic Tracker Product and Technical Plan

Traffic Tracker is a local traffic monitoring platform for Israel. It turns fixed-camera footage into reviewable vehicle observations, directional crossing counts, and historical road statistics. Video uploads and live webcams are supported from the first release. Results must show their observation coverage and uncertainty.

## Confirmed scope

| Decision | Requirement |
| --- | --- |
| Purpose | Traffic monitoring |
| Deployment | This Windows PC; local processing/storage and requested Tailscale dashboard access |
| Initial concurrency | One to four fixed webcams, plus queued uploaded videos |
| Footage | High resolution, with configurable analysis downscaling |
| Frontend | TypeScript, React, Tailwind |
| Backend | Node.js, TypeScript, Express |
| Computer vision | Python workers, GPU acceleration where available |
| Workspace | Turborepo with separate apps and shared packages |
| Location | Israel; Asia/Jerusalem display time, km/h and metres |
| License plates | Deferred; not part of the initial release |
| Agent responsibilities | Parent acts as PM; lower-cost implementation agents do development |

Road planning, scenario planning, and road-layout design are excluded from the project scope. The dashboard focuses on monitoring, analyzing, and reviewing observed traffic.

The current PC reports an NVIDIA RTX 3080 Laptop GPU with 16 GB of video memory. CPU, system memory, camera throughput, and sustained thermal performance still need evaluation. Four simultaneous feeds are a target, not a verified capacity claim.

## User workflow

1. Add a webcam, a supported direct stream endpoint, or an uploaded video.
2. Define the roads, lanes, zones, and counting lines visible in the frame.
3. Configure directions, turning movements, and optional real-world calibration.
4. Start processing and watch video, overlays, observations, and statistics.
5. Review events and historical results, correct mistakes, and export reports.

A source can show multiple roads. Road statistics must remain separate from the camera that observes them. The initial scene editor supports named zones and counting lines; the complete road, lane, and movement hierarchy follows as an explicit milestone.

The implemented monitor supports 1×–8× zoom, pan/pinch navigation, Fit, an expanded player, overlay visibility switches, and regular/large vehicle labels. Navigate moves the view; Line or Zone arms annotation placement on the paused image. Video and overlays share their transform, while annotation points remain normalized to the original image. Uploaded detection boxes still appear only on matching paused analysis samples.

Browser webcams require a user action to request access. A public webcam webpage is not necessarily a directly readable video stream; individual source adapters may be needed. File formats, stream codecs, and source modes must be reported from actual capabilities rather than assumed to work universally.

## Feature catalog

| Capability | Planned output | Dependencies and limits |
| --- | --- | --- |
| Directional crossing counts | Counts per road, lane, line, direction, class, and interval | Stable tracks and configured crossing gates |
| Current occupancy | Vehicles currently visible, moving, or stopped in zones | Separate metric from cumulative counts |
| Broad vehicle classes | Cars, trucks, buses, motorcycles, bicycles; optional pedestrians | Validate against representative camera footage |
| Vehicle colors | Broad color, confidence, representative crop | Shadows, reflections, infrared, and night footage can make color unknown |
| Trajectories | Paths, zone entries/exits, lane changes, turns, U-turns | Scene geometry and stable tracking |
| Speed estimates | Individual speed, mean, median, distributions, 85th percentile | Calibrated road geometry and accurate source timestamps |
| Congestion | Queue count, stopping duration, congestion duration, occupancy | Physical queue length and density require calibration |
| Intersection statistics | Turning matrix, approach queues, observed waiting time | Defined approaches/exits and adequate observation coverage |
| Road trends | Peak periods, vehicle mix, weekday comparisons, before/after comparisons | Comparable observation windows and explicit missing coverage |
| Video calendar time | Calendar date/time from a video start reference plus its frame offset | Use explicit embedded metadata or a manual correction; distinguish container creation from verified capture time |
| Incident candidates | Wrong-way travel, prolonged stops, blocked lanes, queue growth | Configurable rules, supporting evidence, and human review |
| Fine vehicle classes | Vans, pickups, SUVs and other useful subclasses | Additional model or training data; validation before rollout |
| Vehicle make and model | Best-effort make/model with uncertainty | Specialized model and suitable viewpoints; no assumed model year or owner identity |
| Israeli plate recognition | Text, confidence, evidence crop | Later dedicated detector and recognition module |
| Cross-camera matching | Candidate links, observed travel time, route counts | Time alignment, topology, calibration or appearance matching; uncertain links remain uncertain |
| Visible signal analysis | Phase observations and relationship to queues | Signals must be visible; timing and occlusion need evaluation |
| Forecasting | Traffic and congestion forecasts with evaluation results | Sufficient historical data and comparisons against simple baselines |
| Near-miss indicators | Trajectory-based candidate events | High-quality geometry and timing; separate experimental module |

Every inferred attribute supports unknown. Raw model confidence is not automatically a calibrated probability. Attributes should combine useful observations across a track where appropriate and retain the evidence needed for review.

## Dashboard

| Area | Features |
| --- | --- |
| Overview | Selected-source totals, busy roads, congestion, trends, health, configurable widgets |
| Live monitoring | Camera grid, expanded view, source/road/lane filters, boxes, paths, counts, overlay controls |
| Road and intersection detail | Directional flow, lane comparison, vehicle mix, queues, turning diagrams |
| Historical analytics | Time filters, comparison periods, charts, heatmaps, distributions, saved views |
| Vehicle observations | Filterable observations, class/color/confidence, timestamps, paths, representative images |
| Playback and review | Synchronized video and metadata, seeking, event markers, corrections |
| Scene editor | Named roads, lanes, zones, gates, directions, ignored areas, calibration points |
| Processing | Upload batches, job progress, cancellation, priorities, retries, analysis reruns |
| Alerts | Rule thresholds, minimum duration, severity, acknowledgement, evidence clips |
| Reports | CSV/JSON exports, printable reports, chart exports, saved report definitions |
| Quality and health | Processing rate, delay, dropped frames, missing coverage, GPU and storage status |
| Settings | Sources, model settings, retention, backups, access permissions, units, language |

Common filters are source, road, lane, direction, class, date range, and analysis version. Empty and unavailable states explain what data is missing. Planned modules must be labeled as planned, without fabricated charts or operational claims. English is the initial interface; Hebrew and right-to-left support remain explicit backlog items.

## Turborepo layout

```text
apps/
  web/                 React dashboard and browser camera capture
  api/                 Express control API, persistence, worker supervision
  vision/              Python inference and geometry; package adapter for Turbo
packages/
  contracts/           Runtime schemas, TypeScript types, API and event contracts
  config/              Shared TypeScript and tooling configuration
  ui/                  Reusable visual components when reuse justifies a split
infra/                 Optional local infrastructure configuration
docs/                  Product plan, backlog, protocols, operating instructions
```

Use npm workspaces and Turborepo to coordinate development, build, type checking, and tests. Shared packages should have real consumers and clear ownership. Do not create empty abstraction packages simply to increase the package count. Python remains a Python project; its package adapter exposes appropriate checks to Turborepo.

The API supervises Python. The standard development command must not launch a duplicate worker that competes for stdin or the GPU. Longer-term scheduling separates live-session work from queued file processing.

## Service responsibilities

React owns the dashboard, scene editing, browser-camera capture, charts, playback, and overlays. Express owns configuration, validation, queries, exports, job management, event delivery, and persistence. Python owns detection, tracking, geometry, attribute extraction, and generation of traffic events.

Node and Python exchange versioned, validated metadata. The initial bridge is a long-lived subprocess using newline-delimited JSON, with logs on stderr. Commands use explicit arguments and managed file paths, never interpolated shell commands. Large media is passed through files or a video transport, rather than embedded in routine event JSON.

The planned durable service architecture uses PostgreSQL for configuration, observations, events, aggregates, and corrections; Redis for jobs and inter-process events; local files for video and evidence. To make the first slice runnable without provisioning those services, a replaceable local disk repository and subprocess bridge are permitted. This is a documented interim implementation, not completion of the PostgreSQL/Redis milestone.

FFmpeg and MediaMTX are candidates for robust capture, decoding, recording, and browser video transport. Uploaded playback can initially use a seekable HTTP file endpoint. The chosen initial stream adapter must state its actual supported protocols and codecs. Browser-sampled JPEGs are a bounded prototype capture mode, not equivalent to processing every frame of the original stream.

## Analysis pipeline

1. Capture or decode with the source timeline intact.
2. Prepare full frames, overlapping tiles and high-resolution line regions for analysis while preserving aspect ratio and coordinate transforms.
3. Detect broad vehicle classes.
4. Associate detections into independent per-source tracks.
5. Estimate supported attributes with unknown states.
6. Apply configured zones and crossing gates.
7. Emit timestamped observations, crossing events, and quality information.
8. Persist results and update the dashboard.

Keep detector and tracking implementations replaceable. The current configured local GPU profile is YOLO26 Medium with 1280-pixel input and conventional NMS, selected from fixed-frame comparisons with YOLOX-S and RF-DETR and verified in a completed, durably saved upload analysis. Preserve the CPU ONNX fallback and optional RF-DETR adapters. ByteTrack remains a separate tracking benchmark candidate. Explicit setup may fetch pinned, verified model weights; normal application startup must use existing local files. Model choices depend on measured road performance, speed, licensing and local runtime compatibility; generic benchmark rankings do not establish this camera's accuracy.

The capture resolution, analysis resolution, and display resolution are independent settings. Store scene geometry in normalized coordinates and associate it with a scene version. Use high-resolution crops selectively when distant vehicles or supported attributes need more detail. The current high-resolution prototype tiles each sampled image and adds bounded detail passes around saved counting lines, remaps boxes into the original frame, and reconciles overlapping detections before tracking. Explicit line-region detection must identify its limited spatial scope. Every real detector observation remains visible, even when the tracker has not assigned an ID; only active tracks generate crossings. Spatial coverage of a sampled image does not establish detection accuracy or continuous video coverage. Reuse loaded models where safe, isolate tracking state, bound queues, and prioritize live work over bulk uploads.

## Measurement rules

- Repeated frame detections of one track are not repeated vehicles.
- Crossing counts, current occupancy, and distinct tracked observations remain separate metrics.
- A track can cross several gates; each reported total identifies the gate and counting semantics.
- Directional crossing rules include transition validation and noise tolerance.
- Track IDs are scoped to source and processing session; identity does not persist automatically across cameras or restarts.
- A rerun creates a new analysis session. Repeated delivery must not duplicate persisted crossing events.
- Unknown or missing coverage is not zero traffic. Pauses, dropped frames, reconnects, and sampling must be visible in quality data.
- Uploaded footage uses source timestamps, regardless of processing speed.
- Preserve original clip-relative timestamps for playback, synchronization and counting. Calendar display is a separate derived value: the effective video start instant plus the event's source offset.
- Keep recording-time provenance visible. Embedded container creation time may reflect an export date; manual corrections retain the original metadata. Missing or timezone-ambiguous metadata remains unknown, with elapsed video position as the fallback. Upload date and filesystem timestamps are not recording dates.
- Display calendar times in Asia/Jerusalem using the rules for that date. Manual local times require an explicit timezone; reject nonexistent daylight-saving times and resolve repeated times with an explicit choice.
- Pixel motion alone does not establish speed in km/h. Calibrate each road surface; invalidate calibration after camera movement or zoom changes.
- Corrections preserve original observations and audit history.
- Scene changes have versions. Historical results retain the configuration that generated them.

Core records include sources, sessions, scene versions, roads, lanes, zones, gates, calibrations, tracks, observations, movement events, aggregates, alerts, corrections, and evidence references. The first implementation may implement a subset, which the backlog must state precisely.

## Local operation and storage

Bind the dashboard and API to 0.0.0.0 as requested for Tailscale access. Keep processing and source media on this PC. The dashboard uses relative /api requests through its development proxy, and host/origin access includes the verified Tailscale IP and MagicDNS name. Use managed filenames, upload size limits, validated media inputs, bounded frame requests, and explicit source capability errors. Never activate a webcam automatically.

Display times in Asia/Jerusalem and store timestamps consistently. Use metres and kilometres per hour when physical measurements are supported. Protect access to raw recordings and future plate data with configurable permissions and retention. Offer analytics-only, event-clip, and continuous-recording modes as their supporting features are implemented.

At an average stream bitrate of 4 Mb/s, continuous recording uses approximately 43 GB per day per camera. Retention policies for source media, images, clips, observations, and aggregates must be configured separately.

## Delivery sequence

### Milestone one

Create the Turborepo foundation and a runnable local vertical slice: source creation, uploads, explicit browser-camera capture, scene editing, processing control, real worker events, broad classes, basic colors, crossing counts, current occupancy, observations, playback, and actual-data exports. If the runtime or model is not configured, expose that condition clearly. No fabricated detections or statistics.

### Milestone two

Validate actual footage and sustained one-to-four-camera throughput. Improve capture beyond browser frame sampling, add robust stream handling, formalize road/lane/movement entities, and complete PostgreSQL/Redis integration and recording retention.

### Milestone three

Add calibrated speed, lane statistics, turning matrices, queues, headways, peak-period reports, and historical comparisons with coverage information.

### Milestone four

Add configurable alert rules, evidence clips, corrections, batch reprocessing, customizable dashboards, access roles, backups, printable reporting, and Hebrew support.

### Milestone five

Evaluate plate recognition, finer attributes, cross-camera matching, forecasts, visible signal analysis, and other specialized modules independently before enabling them.

## Acceptance and evaluation

Review representative day, night, dense-traffic, distant-vehicle, shadow, and occlusion footage manually. Measure counting errors, missed crossings, duplicate counts, class/color accuracy, tracking continuity, source coverage, and processing delay. Evaluate calibrated speed against an independent reference when implemented.

The first release requires working setup instructions, meaningful API and geometry checks, a dashboard connected to actual API state, explicit capability limits, and no placeholder telemetry presented as real. Four-camera capacity and model accuracy require actual footage benchmarks before acceptance.

## Technical sources

- [Ultralytics tracking documentation](https://docs.ultralytics.com/modes/track/) describes tracker behavior and ByteTrack as a lightweight static-camera baseline.
- [Ultralytics speed estimation documentation](https://docs.ultralytics.com/guides/speed-estimation/) requires a real-world scale and describes speed as an estimate.
- [Ultralytics licensing](https://www.ultralytics.com/license) describes AGPL-3.0 and Enterprise options; deployment suitability must be assessed before final model adoption.
- [MediaMTX protocol documentation](https://mediamtx.org/docs/features/read) lists supported reading transports including RTSP, WebRTC, and HLS.
