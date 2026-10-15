# Traffic Tracker

Local traffic monitoring for fixed webcams, uploaded videos, direct streams and public YouTube cameras. The project targets one to four live cameras on a local computer, with configurable analysis downscaling and local Python inference. Actual multi-camera capacity still requires footage benchmarks.

## Project documents

- [Product and technical plan](docs/PROJECT_PLAN.md)
- [Implementation backlog](docs/IMPLEMENTATION_BACKLOG.md)
- [Verification notes](docs/VERIFICATION.md)
- [Vision runtime and model setup](apps/vision/README.md)

## Workspace

This is a Turborepo using npm workspaces.

| Location | Responsibility |
| --- | --- |
| apps/web | React, TypeScript, Tailwind dashboard and user-initiated webcam capture |
| apps/api | Node.js, TypeScript, Express API, source management and worker supervision |
| apps/vision | Python detection, tracking, colors and scene geometry |
| packages/contracts | Shared runtime schemas and TypeScript contracts |
| packages/config | Shared tooling configuration |
| infra | Optional local infrastructure configuration |

The first slice uses local metadata files behind a repository interface and a supervised Python subprocess bridge. PostgreSQL persistence and Redis scheduling are tracked follow-up work.

## Development

Node.js 20 or newer and npm are required for the web and API apps. Python 3.12 and a local detector model are required for analysis. The dashboard remains usable for configuration when analysis is unavailable and shows that state explicitly.

### Run on a Mac

The supported Mac setup uses macOS 14 or newer, Node.js 22 or newer, npm, and Python 3.12 or 3.13. Install those prerequisites yourself before continuing; setup does not install Homebrew or other system software. Apple Silicon uses pinned PyTorch/Ultralytics YOLO26 and selects MPS only when PyTorch reports it built and available, otherwise inference uses CPU. Intel Macs use the pinned OpenCV Zoo YOLOX model with ONNX Runtime on CPU. CPU inference can be slow at high input resolutions, so the Mac profile starts at 640 pixels.

On Apple Silicon, use native ARM64 Python. A Python interpreter running under Rosetta selects the Intel CPU profile.

```sh
git clone https://github.com/avihaymenahem/flowline.git
cd flowline
npm ci
npm run setup:mac
npm run dev
```

The setup downloads model files only after the explicit setup command and checks each file against a pinned SHA-256 value before use. It creates a fresh `.env` with a local detector profile only when `.env` does not already exist. Set `VISION_DEVICE=cpu` in `.env` to force CPU inference on Apple Silicon; `auto` is the default and falls back to CPU when MPS is unavailable. The Mac runtime was not exercised on physical Mac hardware during this change; see [vision setup details](apps/vision/README.md).

From the repository root:

```powershell
npm install
npm run dev
```

The development dashboard is available at http://127.0.0.1:5173. The API listens on port 4100 and the dashboard proxies `/api` requests to it. The API owns the Python worker lifecycle; the standard dev command starts only the web and API apps.

Video uploads stream to disk with a 4 GiB default limit (`API_MAX_UPLOAD_MB`, configurable from 1 to 16384 MiB). The effective byte limit is returned by `/api/health`. `API_UPLOAD_TIMEOUT_MS` bounds request-body receipt time (default four hours; 60 seconds to 24 hours), and the frontend proxy uses the same timeout. Ensure the upload directory has enough free space before sending large files.

The Windows GPU profile uses YOLO26 Medium at 1280-pixel input; it has been exercised on an RTX 3080 Laptop GPU. Provision that isolated runtime with:

```powershell
pwsh -File apps/vision/setup-yolo26.ps1
```

Use the YOLO26 recipe in [.env.example](.env.example) for a new checkout. Setup pins the Python packages, downloads the official checkpoint, verifies its SHA-256, and keeps settings and caches inside the workspace. Normal startup uses the existing local files. Optional RF-DETR environments are described in the [vision README](apps/vision/README.md).

The CPU runtime and model remain available as a configurable fallback. To use a particular Python installation on Windows, run:

```powershell
pwsh -File apps/vision/setup.ps1 -PythonExe "C:\Path\To\Python312\python.exe"
```

On another Windows machine with Python 3.12 available through the Python launcher, use `pwsh -File apps/vision/setup.ps1`. Setup creates `apps/vision/.venv-worker`, installs the pinned CPU dependencies, and verifies the model download against its SHA-256. Normal app startup does not download weights. See the [vision README](apps/vision/README.md) for model provenance and the protocol.

Without explicit configuration, the API discovers the project-local CPU runtime and model. A local `.env` selects the GPU runtime, backend and model; see `.env.example` for the Windows GPU settings. The API validates initialization at startup and reports the actual inference device after a prediction. `VISION_PYTHON` and `VISION_MODEL_PATH` override automatic discovery. `API_HOST` defaults to `0.0.0.0` for trusted Tailscale access; set it to `127.0.0.1` to restrict API access to the local computer.

## First slice

The implemented slice includes source management, uploaded-video playback, explicit webcam preview and sampled capture, supported direct-stream analysis, processing controls, normalized zones and counting lines, broad vehicle classes and colors, directional crossings, observations, and actual-data CSV/JSON exports.

All dashboard video previews play muted. Webcam capture requests video without microphone audio; sampled YouTube previews contain images only.

The header's Color theme selector offers Light, Dark and System on every page. Your choice is remembered in this browser after refresh; System follows the device's color preference. Dark mode covers dashboard panels, controls, tables, menus and editors while preserving video and map imagery.

Open the ⋯ menu inside a Video sources card for Move to folder, Rename, Video date/time (uploads), or Delete source. Rename is also available beside the selected Live source. Names can contain 1–120 characters. Renaming works during analysis and keeps the source ID, links, video, annotations and results.

Video sources supports flat folders. Choose New folder, then drag a card by its grip onto a folder tab to move it. Open a folder or Ungrouped and drag a card before another card to reorder them. The card's ⋯ → Move to folder menu also works on phones and with a keyboard. All sources shows each card's folder; name search applies to the selected view. Folder membership, card order and the selected folder URL persist after refresh. Rename changes only the folder name. Remove folder asks for confirmation and moves its sources to Ungrouped, keeping their videos, scenes and analysis results.

Use the Type and Status filters above the cards to narrow the selected folder or All sources. Search combines with both filters. Sort supports Saved order, Name A–Z / Z–A, Newest first, Oldest first and Status. Status puts Running, Idle, Stopped, Completed and Error sources in that order. The controls persist in the URL through refresh and browser history. Clear filters resets search, filters and sorting while keeping the selected folder. Sorting changes only the displayed order; drag reordering within a folder requires Saved order with no active search or filters. Moving a source to another folder remains available.

Delete source opens a confirmation popup naming the source and explaining that its saved zones, analysis results and uploaded video, when present, will be permanently removed. Cancel leaves the source intact. Stop analysis before deleting a running source.

Live monitor has a compact Camera location map for the selected source. Choose Set location, click or tap the map to place the camera pin, then Save location. Drag to pan, use the zoom controls for precision, and choose World view to find cameras farther away. Editing starts at the saved pin. Show selected pin brings it back into view; Enter coordinates instead provides an optional alternative, and the label is optional. Cancel discards the draft. Edit and Clear saved location are available afterward. Locations persist through refresh and can be changed while analysis is running. No location is assigned automatically.

Overview has a larger Camera locations map containing every source with a saved location, regardless of which source is selected. It fits all pins and supports zoom and pan. Select a pin to see its source and open Live monitor. Sources without coordinates have a Set location action; when none are saved, the panel explains how to add the first pin. Map tiles use OpenStreetMap with visible attribution.

The worker supports YOLO26 through Ultralytics and PyTorch, with the OpenCV Zoo YOLOX-S model through ONNX Runtime as a CPU option. Detector selection is configured explicitly; model support does not imply full-video accuracy or multi-camera capacity.

Tracking uses a local IoU/motion implementation with conservative vehicle type-flicker continuity, source-time expiry and monotonic IDs after clock resets. ByteTrack and OC-SORT tied it on 55 manually matched observations across two short clips, so the existing tracker was retained. These checks do not establish full-video identity accuracy. GPU inference has been exercised on this PC; sustained multi-camera capacity and traffic-count accuracy remain unverified. YOLO26 uses AGPL-3.0 with an Enterprise alternative; RF-DETR core models and the OpenCV Zoo fallback use Apache-2.0.

Use Report frame in Live monitor or Report beside an observation to record duplicate boxes, missed vehicles, false vehicles, incorrect types or colors. Missed vehicles require a box and label; an optional corrected box supports pointer drawing or normalized coordinate entry. Feedback labels include Van, Pickup truck and SUV without changing the detector's broad live classes. Click an observation's track ID to inspect its sampled path, type/color changes, captured-zone membership and recorded crossings within that source and session.

Accuracy reports in Observations retain their own image, prediction snapshot, correction and available analysis settings. Reports are partial issue records and do not automatically retrain the model or rewrite original counts. See [the feature plan](docs/ACCURACY_REVIEW_PLAN.md) and [verification notes](docs/VERIFICATION.md).

Direct-stream analysis depends on OpenCV codec/protocol support. The browser can preview only browser-decodable video URLs; a full RTSP-to-browser media gateway remains follow-up work. Browser webcam capture is sampled at a configurable low rate and is currently tied to the selected monitoring view.

To add a YouTube camera, open Video sources → Add source → YouTube and paste a public watch, live or youtu.be link. A decoded preview is required before the source is saved. Open the source in Live monitor, draw any zones or counting lines on its idle preview, then start analysis. A live camera continues processing on the local server until Stop or a stream error, including while the dashboard tab is closed. The preview updates with analyzed images at a 2 FPS target; boxes, labels and displayed totals use the event for that exact image. Zoom, pan and overlay controls work on these images. Refresh preview obtains a new idle image after stopping. A recorded YouTube video instead finishes at the end of its footage.

YouTube resolution uses the tested, pinned `yt-dlp==2026.10.10.233141.dev0` nightly and matching local `yt-dlp-ejs==0.8.0` in the configured Python runtime, provisioned by the CPU and YOLO26 setup scripts. This build restored anonymous decoding for both supplied live cameras after the stable build failed; the [official update guidance](https://github.com/yt-dlp/yt-dlp#update) recommends testing nightly for site changes. YouTube support also requires Node.js 22 or newer on PATH; the resolver enables that local runtime explicitly without downloading remote challenge components. See the [official challenge setup guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Processing is local and uses one video at a time; playlist query parameters are discarded. Public watch-page playback does not guarantee that this PC can read the media stream. Unavailable, restricted or expired streams produce an error; live disconnections have bounded reconnect attempts. Anonymous sign-in/bot challenges, missing local components and resolver timeouts have separate safe messages. Live displays the current preview error and offers Refresh preview and Open YouTube; older saved failures remain visible when no preview is available. Cookies and account authentication are unsupported. Only the canonical video URL and public metadata are saved, with short-lived frame previews kept in a bounded temporary cache. YouTube upload dates are not used as recording times.

Event detail retention is bounded. Session totals must remain stable across retention trimming, while observation exports identify their retained-window scope. PostgreSQL/Redis, calibrated speed, full road/lane hierarchy, robust native capture, evidence clips, and access roles remain on the [backlog](docs/IMPLEMENTATION_BACKLOG.md).

## Checks

```powershell
npm run build
npm run typecheck
npm test
```

Build and typecheck include TypeScript checks and the Python package's syntax checks. API tests and deterministic vision tests cover behavior without treating fixture detections as production inference. Runtime/model checks and real-camera performance evaluation are separate requirements.

Run the checks above after changing the project. General verification notes are in [docs/VERIFICATION.md](docs/VERIFICATION.md). `npm run dev` starts the local application.

## Measurement boundaries

Visible occupancy is separate from directional gate crossings. Tracks are scoped to source and session. Browser-sampled frames are reduced-coverage input and must report that limitation. Physical speed and distance are unavailable until road calibration is implemented. Plate recognition is deferred.

For high-resolution footage, the default worker covers each sampled image with overlapping tiles and adds higher-detail crops around saved counting lines. Detections map back to the original video, including observations without an assigned track ID. The visible detection total counts boxes in one sampled image, not distinct vehicles or complete traffic coverage. See the [vision configuration](apps/vision/README.md).

Overlapping frame tiles can see separate cropped portions of one vehicle. The worker reconciles strongly supported crop-boundary fragments before tracking, retaining a complete vehicle box and filtering a clipped vehicle fragment contained in a fuller detection. For YOLO26, suspected tall bus/truck duplicates also trigger one full-frame confirmation pass. Fusion requires a uniquely matched anchor, coherent geometry and crop-seam evidence; uncertain fragments are retained. This fixes the reported bus's three boxes and three tracking IDs in the regression case. The general overlap threshold remains unchanged. Nearby vehicles and ambiguous detections remain possible, and heavily occluded vehicles can produce indistinguishable predictions. New analysis uses the correction; older saved totals are not rewritten.

The scene editor supports phone-width layouts and touch input, including Android Chrome. Pause an uploaded video, choose Line, and tap two points inside the video image; the point counter explains when Add line is available. Play and seek controls sit below the image. Saved lines have individual counts for the latest analysis session.

New uploaded-video analyses sample at 2 FPS, requesting one frame every 500 ms of video; existing sessions retain their original sampling. During uploaded-video playback, boxes and optional labels stay visible between samples. Smooth movement defaults On: it estimates positions between nearby analyzed frames for uniquely matched vehicle tracks of the same class. Untracked or uncertain matches hold their sampled positions. Turn Smooth movement Off to hold all boxes until the next sample. The caption marks movement as estimated; zone totals, type/color counts, crossings and stored observations still use actual analyzed data. Visual boxes are filtered against the zones after interpolation, so their visible count can differ from the actual sample count near a zone boundary. Seeking, buffering and positions before the first available sample clear the overlay. Paused detections still require a matching analyzed frame: use Previous / Next below the video for precise review. Boxes use the actual contained video image area and retain their normalized size on phones. Webcam overlays remain recent sampled results and can trail the live preview; their Sample selector supports 0.5, 1 and 2 FPS. Direct streams retain the worker's 1 FPS default.

The live monitor includes 1×–8× zoom, drag-to-pan, touch pinch controls, and Fit to restore the full image. Expand opens a larger player with the same playback position. Boxes, labels, counting lines, and zones can be toggled; labels include a larger text option. Navigate moves the view, while Line or Zone enables point placement on the paused image. Zoomed clicks still map to the original video coordinates. Reset draft clears unsaved points.

Draft points are numbered and appear above vehicle labels. Re-selecting the same drawing tool keeps its points; switching between Line and Zone starts a new draft. Seeking and play/pause keep the draft, with placement available on a decoded paused upload frame even when no analysis sample matches. A line accepts two points; use Add line or Reset draft afterward. A zone needs at least three points.

Dashboard pages have direct URLs: `/overview`, `/live`, `/sources`, `/observations`, and `/processing`. Selecting a source adds its ID, for example `/live/<sourceId>` or `/observations/<sourceId>`. TanStack Router preserves both page and source through refresh, links and browser Back/Forward. Base paths choose the default source after the list loads; `/` opens Overview. Unknown paths and missing sources show recovery options.

The Live monitor source picker supports name search and shows each source's type, status and current selection. Typing only filters the list; click a result or use Up/Down and Enter to switch. Escape closes the picker, and a clear control restores the full list. The selected source remains in the URL after refresh.

Vehicle labels include broad detected type and estimated color. Supported types are car, motorcycle, bus, truck, and bicycle; the current model does not distinguish vans from cars. Color estimates include an explicit unknown result for small or mixed crops. The displayed-sample type/color breakdown counts boxes in one image, not unique vehicles.

The live monitor's totals panel has a Scope picker with grouped saved zones/lines. When zones exist, All zones includes detections whose box centers fall inside any saved polygon, including boundaries, and counts overlapping-zone detections once. Without zones, All covers the full sampled image. Selecting a zone uses just its polygon. The same bounds filter tracked/untracked boxes, labels, sample totals, type/color breakdowns and the Latest observations preview counts. Uploaded sample totals follow the matched paused frame or held playback overlay sample, rather than the last frame of the recording; seeking, buffering and unmatched paused times show unavailable sample counts with pause/step guidance. Zoom and pan do not change monitoring bounds. A line shows its cumulative session crossings and directions; zone crossing counts are unavailable and line occupancy is not inferred. Missing data stays unknown, while a measured empty result shows zero. The selection resets when changing sources or removing the selected geometry. Stored observations and exports retain their original analysis data.

Unique tracked vehicles counts distinct vehicle tracking IDs across the latest analysis session, separately from the displayed-frame detection count. A zone includes IDs observed inside its polygon; All zones uses their deduplicated union. A line counts each ID in its crossing events once across both directions. Untracked detections are excluded, and a lost or reassigned tracking ID can count the same physical car again. Counters persist through refresh and retained-event trimming. Existing results are backfilled without reanalysis; incomplete history or limited monitoring coverage shows an explicit At least lower bound, and missing counts remain unavailable. Changing zone geometry recalculates membership from the available history.

Observations uses TanStack Table with TanStack Virtual, numeric sorting, and combined session/type/color filters. It defaults to the latest analysis session; All sessions includes a session column because track IDs repeat between runs. The browser retains the newest 500 event records and discloses omitted older records separately from server retention. Filters affect the displayed view; CSV/JSON exports contain the full loaded browser window, including color provenance and omission metadata.

Uploaded videos can provide a calendar-time reference. New uploads inspect supported ISO MP4 movie headers for container creation time, dimensions and duration without decoding the full file. For an existing upload, use Video sources → card ⋯ menu → Video date/time → Refresh embedded metadata. Calendar times appear in observations, recent events, sampled-frame captions and overview history; the original elapsed video position stays available for playback alignment.

In Video date/time, enter the video's actual start date/time in Israel or UTC, or revert a correction to the extracted metadata. Seconds are preserved, nonexistent daylight-saving times are rejected, and repeated times require choosing the intended offset. Stop analysis before changing its time reference. No reanalysis is needed to update dates on existing observations.

Embedded time is explicitly labeled as container creation metadata: it can be an export date rather than the recording start. Unsupported, absent, implausible or timezone-ambiguous metadata remains unknown; upload dates and filesystem timestamps are never substituted. Legacy QuickTime timestamps are not assumed to be UTC. Webcam/live-stream calendar-time anchoring remains follow-up work. CSV exports add UTC/local timestamps, timezone and provenance alongside `source_time_ms`; JSON adds per-event `videoTime` and `metadata.videoTimeOrigin` while retaining `sourceTimeMs`.

Uploaded files, generated results, runtime dependencies, and model weights are local working data rather than source artifacts. Camera access starts only after a user action.
