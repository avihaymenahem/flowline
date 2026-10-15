"""Long-lived NDJSON bridge for local traffic inference."""
from __future__ import annotations

import concurrent.futures
import contextlib
import copy
import json
import logging
import math
import os
import shutil
import sys
import threading
import time
import traceback
import uuid
from decimal import Decimal
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from vision_core import (IoUTracker, attach_frame_tile_provenance, deduplicate_detections, frame_tile_rectangles, has_large_vehicle_tile_fragments, line_crossings, line_roi_rectangles,
                         reconcile_large_vehicle_tile_fragments,
                         split_roi_rectangles,
                         model_box_to_normalized, remap_crop_detections, sampling_notes,
                         suppress_recent_recrossings, vehicle_color)
from youtube_source import YoutubeSourceError, resolve_youtube_video

VEHICLE_CLASSES = {1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
# RF-DETR preserves the sparse COCO category IDs (including the person slot at 1).
RFDETR_VEHICLE_CLASSES = {2: "bicycle", 3: "car", 4: "motorcycle", 6: "bus", 8: "truck"}
COCO_NAMES = ["person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"]


def _is_uuid_path_part(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def _javascript_json(value: Any) -> str:
    """Serialize scene-signature primitives like JSON.stringify in Node."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("scene coordinates must be finite")
        if number == 0 or number.is_integer():
            return str(int(number))
        token = repr(number).lower()
        if "e" not in token:
            return token
        magnitude = abs(number)
        decimal = Decimal(token)
        if 1e-6 <= magnitude < 1e21:
            fixed = format(decimal, "f")
            return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
        mantissa, exponent = token.split("e", 1)
        exponent_number = int(exponent)
        return f"{mantissa}e{'+' if exponent_number >= 0 else ''}{exponent_number}"
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_javascript_json(item) for item in value) + "]"
    raise TypeError("unsupported value for scene signature")


def scene_geometry_signature(scene: dict[str, Any]) -> str:
    """Mirror packages/contracts sceneGeometrySignature for event provenance."""
    def id_key(item: tuple[Any, ...]) -> tuple[bytes, bytes]:
        serialized = _javascript_json(item)
        return str(item[0]).encode("utf-16-be"), serialized.encode("utf-16-be")

    zones = []
    for zone in scene.get("zones", []):
        polygon = zone.get("polygon", [])
        zones.append([str(zone["id"]), [[point["x"], point["y"]] for point in polygon]])
    zones.sort(key=id_key)
    lines = []
    for line in scene.get("countingLines", []):
        start, end = line["start"], line["end"]
        lines.append([str(line["id"]), [start["x"], start["y"]], [end["x"], end["y"]]])
    lines.sort(key=id_key)
    return "g1:" + _javascript_json([zones, lines])


class LatestFrameReader:
    """Drain a live capture continuously while retaining only its newest frame."""

    def __init__(self, capture: Any, clock_origin: float | None = None,
                 capture_fps: float | None = None, unknown_fps_interval: float = 0.5,
                 stop_event: threading.Event | None = None):
        self.capture = capture
        self.started_at = clock_origin if clock_origin is not None else time.monotonic()
        valid_fps = capture_fps if capture_fps is not None and math.isfinite(capture_fps) and 0.1 <= capture_fps <= 120 else None
        self.capture_fps = valid_fps
        self.frame_interval = 1 / valid_fps if valid_fps is not None else min(2.0, max(0.1, unknown_fps_interval))
        self.unknown_fps = valid_fps is None
        self.condition = threading.Condition()
        self.stop_event = stop_event or threading.Event()
        self.sequence = 0
        self.latest: tuple[int, Any, float] | None = None
        self.done = False
        self.error: Exception | None = None
        self.thread = threading.Thread(target=self._read, name="youtube-live-reader", daemon=True)
        self.thread.start()

    def _read(self) -> None:
        try:
            next_read_at = time.monotonic()
            while not self.stop_event.is_set():
                delay = next_read_at - time.monotonic()
                if delay > 0 and self.stop_event.wait(delay):
                    break
                ok, image = self.capture.read()
                read_finished = time.monotonic()
                if not ok or image is None:
                    break
                source_time_ms = max(0.0, (read_finished - self.started_at) * 1000)
                with self.condition:
                    self.sequence += 1
                    self.latest = (self.sequence, image, source_time_ms)
                    self.condition.notify_all()
                # Keep a periodic deadline so small timer oversleeps do not
                # accumulate into a growing live delay. A blocking native read
                # consumes the interval; only reset after falling over one
                # frame behind, which prevents multi-frame catch-up bursts.
                next_read_at += self.frame_interval
                if read_finished - next_read_at > self.frame_interval:
                    next_read_at = read_finished
        except Exception as exc:
            self.error = exc
        finally:
            with self.condition:
                self.done = True
                self.condition.notify_all()

    def next_after(self, sequence: int, timeout: float) -> tuple[int, Any, float] | None:
        with self.condition:
            self.condition.wait_for(lambda: self.sequence > sequence or self.done or self.stop_event.is_set(), timeout)
            if self.latest is not None and self.latest[0] > sequence:
                return self.latest
            return None

    def stop(self, timeout: float = 9.5) -> None:
        self.stop_event.set()
        with self.condition:
            self.condition.notify_all()
        self.thread.join(timeout)
        if self.thread.is_alive():
            raise RuntimeError("YouTube live capture is still stopping; retry shortly.")


class Worker:
    def __init__(self) -> None:
        # Keep the NDJSON channel stable even while optional model libraries
        # initialize or predict under a temporary stdout-to-stderr redirect.
        self.protocol_stdout = sys.stdout
        self.cv2 = None
        self.np = None
        self.ort = None
        self.import_error = None
        try:
            import cv2
            import numpy as np
            self.cv2, self.np = cv2, np
            # FFmpeg/OpenCV diagnostics can include the fully signed media URL.
            # Keep native video I/O silent; the NDJSON worker reports safe errors.
            os.environ.setdefault("OPENCV_LOG_LEVEL", "SILENT")
            if hasattr(cv2, "setLogLevel"):
                cv2.setLogLevel(0)
        except Exception as exc:
            self.import_error = f"OpenCV/NumPy unavailable: {exc}"
        try:
            import onnxruntime as ort
            self.ort = ort
        except Exception as exc:
            if self.import_error:
                self.import_error += f"; ONNX Runtime unavailable: {exc}"
            else:
                self.import_error = f"ONNX Runtime unavailable: {exc}"
        self.sessions: dict[tuple[str, str], dict[str, Any]] = {}
        self.detectors: dict[str, Any] = {}
        self.inference_lock = threading.Lock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.jobs_lock = threading.Lock()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="media-analysis")

    def write(self, message: dict[str, Any]) -> None:
        self.protocol_stdout.write(json.dumps(message, separators=(",", ":"), ensure_ascii=False) + "\n")
        self.protocol_stdout.flush()

    def event(self, payload: dict[str, Any]) -> None:
        self.write({"type": "event", "event": payload})

    def session(self, source_id: str, session_id: str) -> dict[str, Any]:
        key = (source_id, session_id)
        if key not in self.sessions:
            self.sessions[key] = {"tracker": IoUTracker(), "scene": {"zones": [], "countingLines": []}, "config": {}, "last_source_time": None, "last_line_crossings": {}, "frame_count": 0}
        return self.sessions[key]

    def detector(self, config: dict[str, Any]) -> Any:
        if self.cv2 is None or self.np is None:
            raise RuntimeError(self.import_error or "OpenCV and NumPy are required")
        backend = str(config.get("detectorBackend", os.getenv("VISION_DETECTOR_BACKEND", "onnx"))).lower()
        model_path = str(config.get("modelPath", ""))
        if not model_path:
            raise RuntimeError("model unavailable: configure an absolute modelPath for the selected local detector")
        model_path = os.path.abspath(model_path)
        if not os.path.isfile(model_path):
            raise RuntimeError(f"model unavailable: file does not exist: {model_path}")
        detector_size = str(config.get("detectorSize", os.getenv("VISION_DETECTOR_SIZE", "medium"))).lower()
        detector_input_size = config.get("inputSize", os.getenv("VISION_INPUT_SIZE", "640"))
        detector_nms = config.get("nms", os.getenv("VISION_YOLO_NMS", "true"))
        cache_key = (model_path if backend == "onnx" else
                     f"{backend}:{model_path}:{detector_size}" +
                     (f":{detector_input_size}:{detector_nms}" if backend == "yolo26" else ""))
        if cache_key in self.detectors:
            return self.detectors[cache_key]
        if backend == "rfdetr":
            try:
                detector = RfDetrAdapter(self, model_path, config)
            except Exception as exc:
                raise RuntimeError(f"model unavailable: failed to load RF-DETR: {exc}") from exc
            self.detectors[cache_key] = detector
            print(f"Loaded {detector.model_name} from {model_path} using {detector.provider}", file=sys.stderr, flush=True)
            return detector
        if backend == "yolo26":
            try:
                detector = Yolo26Adapter(self, model_path, config)
            except Exception as exc:
                raise RuntimeError(f"model unavailable: failed to load YOLO26: {exc}") from exc
            self.detectors[cache_key] = detector
            print(f"Loaded {detector.model_name} from {model_path} using {detector.device}", file=sys.stderr, flush=True)
            return detector
        if backend != "onnx":
            raise RuntimeError(f"unsupported detectorBackend: {backend}; expected onnx, rfdetr, or yolo26")
        if self.ort is None:
            raise RuntimeError(self.import_error or "ONNX Runtime is required")
        providers = self.ort.get_available_providers()
        selected = ["CUDAExecutionProvider", "CPUExecutionProvider"] if "CUDAExecutionProvider" in providers else ["CPUExecutionProvider"]
        try:
            if "CUDAExecutionProvider" in providers and hasattr(self.ort, "preload_dlls"):
                try:
                    self.ort.preload_dlls(directory="")
                except Exception as exc:
                    print(f"CUDA DLL preload unavailable; using CPU: {exc}", file=sys.stderr, flush=True)
                    selected = ["CPUExecutionProvider"]
            session = self.ort.InferenceSession(model_path, providers=selected)
            detector = OnnxYolo(self, session, config)
            detector.providers = session.get_providers()
            detector.backend = "onnx"
            detector.model_name = Path(model_path).name
            detector.provider = ",".join(session.get_providers())
            detector.device = detector.provider
            self.detectors[cache_key] = detector
            print(f"Loaded ONNX model {model_path} using {session.get_providers()}", file=sys.stderr, flush=True)
            return detector
        except Exception as exc:
            raise RuntimeError(f"model unavailable: failed to load ONNX model: {exc}") from exc

    def configure(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_id, session_id = str(payload["sourceId"]), str(payload["sessionId"])
        state = self.session(source_id, session_id)
        state["scene"] = payload.get("scene") or {"zones": [], "countingLines": []}
        state["config"] = payload.get("config") or payload
        state["config"].update({k: payload[k] for k in ("modelPath", "detectorBackend", "detectorSize", "confidenceThreshold", "iouThreshold", "inputSize", "nms", "sampleEveryMs", "detectionMode", "lineRoiMargin", "crossingCooldownMs") if k in payload})
        state["config"].setdefault("modelPath", os.getenv("VISION_MODEL_PATH", ""))
        state["config"].setdefault("detectorBackend", os.getenv("VISION_DETECTOR_BACKEND", "onnx"))
        state["config"].setdefault("detectorSize", os.getenv("VISION_DETECTOR_SIZE", "medium"))
        if str(state["config"].get("detectorBackend", "")).lower() == "yolo26":
            state["config"].setdefault("inputSize", os.getenv("VISION_INPUT_SIZE", "640"))
            state["config"].setdefault("nms", os.getenv("VISION_YOLO_NMS", "true"))
        # Validate the runtime and model eagerly so the API gets a precise status.
        detector = self.detector(state["config"])
        model_identity = {"backend": detector.backend, "name": detector.model_name,
                          "device": detector.device, "targetDevice": detector.target_device}
        if hasattr(detector, "input_size"):
            model_identity["inputSize"] = detector.input_size
            model_identity["nms"] = detector.nms
        return {"sourceId": source_id, "sessionId": session_id, "configured": True,
                "model": model_identity}

    def health(self) -> dict[str, Any]:
        detector_runtime_loaded = any(detector.backend in ("rfdetr", "yolo26") for detector in self.detectors.values())
        return {"runtimeAvailable": self.cv2 is not None and self.np is not None and (self.ort is not None or detector_runtime_loaded),
                "available": bool(self.detectors),
                "opencv": getattr(self.cv2, "__version__", None), "numpy": getattr(self.np, "__version__", None),
                "onnxruntime": getattr(self.ort, "__version__", None),
                "cudaProviderAvailable": any(
                    "CUDAExecutionProvider" in getattr(detector, "providers", []) or
                    str(getattr(detector, "device", "")).lower().startswith("cuda")
                    for detector in self.detectors.values()),
                "configuredSessions": len(self.sessions), "activeJobs": len(self.jobs),
                "modelPaths": sorted(self.detectors),
                "detectors": [{"backend": detector.backend, "model": detector.model_name,
                               "device": detector.device, "targetDevice": detector.target_device,
                               **({"inputSize": detector.input_size, "nms": detector.nms}
                                  if hasattr(detector, "input_size") else {})}
                              for detector in self.detectors.values()]}

    def frame(self, source_id: str, session_id: str, image: Any, source_time_ms: float,
              frame_id: str | None = None) -> dict[str, Any]:
        processing_started = time.perf_counter()
        state = self.session(source_id, session_id)
        detector = self.detector(state["config"])
        mode = str(state["config"].get("detectionMode", os.getenv("VISION_DETECTION_MODE", "auto"))).lower()
        if mode not in ("auto", "full", "line_roi", "tiled"):
            raise RuntimeError("VISION_DETECTION_MODE must be auto, full, line_roi, or tiled")
        try:
            roi_margin = float(state["config"].get("lineRoiMargin", os.getenv("VISION_LINE_ROI_MARGIN", "0.12")))
        except (TypeError, ValueError):
            roi_margin = 0.12
        roi_margin = min(0.25, max(0.05, roi_margin))
        with self.inference_lock:
            raw_detections, detector_mode, roi_count = detector.infer_scene(image, state["scene"], mode, roi_margin)
        configured_sample_ms = state["config"].get("sampleEveryMs", 1000)
        try:
            configured_sample_ms = float(configured_sample_ms)
        except (TypeError, ValueError):
            configured_sample_ms = 1000.0
        tracker_max_age_ms = max(1000.0, configured_sample_ms * (state["tracker"].max_missed + 1))
        tracked = state["tracker"].update(raw_detections, source_time_ms=source_time_ms,
                                           max_age_ms=tracker_max_age_ms)
        tracked_ids: dict[tuple[Any, ...], deque[int]] = defaultdict(deque)
        for tracked_detection in tracked:
            key = (tracked_detection["class"], tuple(tracked_detection["bboxXYXY"]),
                   float(tracked_detection["confidence"]))
            tracked_ids[key].append(int(tracked_detection["trackId"]))
        h, w = image.shape[:2]
        crossings = suppress_recent_recrossings(
            line_crossings(state["tracker"].tracks, state["scene"]), state["last_line_crossings"], source_time_ms,
            float(state["config"].get("crossingCooldownMs", 2500)),
        )
        detections = []
        for det in raw_detections:
            x1, y1, x2, y2 = det["bboxXYXY"]
            norm = (max(0.0, x1), max(0.0, y1), min(1.0, x2), min(1.0, y2))
            color = vehicle_color(image, norm)
            item = {"bbox": {"x": norm[0], "y": norm[1], "width": max(0.0, norm[2] - norm[0]), "height": max(0.0, norm[3] - norm[1])},
                    "class": det["class"], "color": color["name"], "colorMethod": "hsv_estimate",
                    "colorSupportRatio": float(color["supportRatio"]),
                    "confidence": round(float(det["confidence"]), 4)}
            key = (det["class"], tuple(det["bboxXYXY"]), float(det["confidence"]))
            if tracked_ids[key]:
                item["trackId"] = str(tracked_ids[key].popleft())
            detections.append(item)
        notes = ["sampled frames only; this event does not claim full video coverage",
                 "temporal_scope=sampled_frames_only"]
        notes.extend(sampling_notes(state["last_source_time"], source_time_ms, float(state["config"].get("sampleEveryMs", 1000))))
        state["last_source_time"] = source_time_ms
        state["frame_count"] += 1
        notes.append(f"processing_ms={(time.perf_counter() - processing_started) * 1000:.1f}")
        notes.append(f"detector_mode={detector_mode};detector_regions={roi_count}")
        notes.append(f"detector_backend={getattr(detector, 'backend', 'fixture')};detector_model={getattr(detector, 'model_name', 'fixture')};detector_device={getattr(detector, 'device', 'test-only')}")
        if hasattr(detector, "input_size"):
            notes.append(f"detector_input_size={detector.input_size};detector_nms={detector.nms}")
        if hasattr(detector, "cross_class_duplicate_suppressed"):
            notes.append(f"detector_near_identical_cross_class_suppressed={detector.cross_class_duplicate_suppressed};iou_threshold={detector.cross_class_duplicate_iou_threshold}")
        notes.append("observations_include_untracked=true;crossings_require_active_tracks")
        if detector_mode == "line_roi":
            notes.append("spatial_scope=counting_line_regions_only;visible_detections_are_not_full_frame_occupancy")
        elif detector_mode.startswith("full_frame_tiled"):
            notes.append("spatial_scope=full_frame_tiled;each_sampled_frame_is_tiled_across_entire_frame")
            if detector_mode.startswith("full_frame_tiled_with_line_detail"):
                notes.append("line_regions_additional_detail;fine_gate_margin=0.05;visible_detections_are_not_full_video_occupancy")
                broad_rectangles = line_roi_rectangles(state["scene"], w, h, margin=roi_margin, maximum=8)
                fine_rectangles = line_roi_rectangles(state["scene"], w, h, margin=0.05, maximum=8)
                split_fine_rectangles = split_roi_rectangles(fine_rectangles, maximum_dimension=640,
                                                             overlap=0.20, maximum_patches=8)
                notes.append(f"inference_passes={roi_count};full_frame_tiles={len(frame_tile_rectangles(w, h))};coarse_gate_regions={len(broad_rectangles)};fine_gate_source_regions={len(fine_rectangles)};fine_gate_patches={len(split_fine_rectangles)};fine_patch_target_max_dimension=640;fine_patch_overlap=0.20;patch_budget=8;oversize_regions_remain_whole_when_budget_is_tight")
            if detector_mode.endswith("_with_large_vehicle_anchor"):
                notes.append("large_vehicle_anchor_pass=applied;full_frame_prediction_confirmed_a_coherent_tall_bus_truck_seam_cluster")
            elif detector_mode.endswith("_with_large_vehicle_anchor_probe"):
                notes.append("large_vehicle_anchor_pass=attempted;no_coherent_seam_cluster_was_confirmed;tile_detections_retained")
        else:
            notes.append("spatial_scope=full_frame")
        crossings = [{**crossing, "trackId": str(crossing["trackId"])} for crossing in crossings]
        config = state["config"]
        detector_context: dict[str, Any] = {"backend": str(getattr(detector, "backend", "unknown"))}
        model_name = getattr(detector, "model_name", None)
        if isinstance(model_name, str) and model_name:
            detector_context["modelName"] = Path(model_name).name[:160]
        device = getattr(detector, "device", None)
        if isinstance(device, str) and device:
            detector_context["device"] = device[:80]
        detector_size = config.get("detectorSize")
        if isinstance(detector_size, str) and detector_size:
            detector_context["detectorSize"] = detector_size[:40]
        input_size = getattr(detector, "input_size", config.get("inputSize"))
        if isinstance(input_size, int) and input_size > 0:
            detector_context["inputSize"] = input_size
        nms = getattr(detector, "nms", config.get("nms"))
        if isinstance(nms, bool):
            detector_context["nms"] = nms
        confidence = getattr(detector, "confidence", config.get("confidenceThreshold"))
        if confidence is not None:
            detector_context["confidenceThreshold"] = float(confidence)
        iou_threshold = getattr(detector, "iou_threshold", config.get("iouThreshold"))
        if iou_threshold is not None:
            detector_context["iouThreshold"] = float(iou_threshold)
        scene_snapshot = {"zones": copy.deepcopy(state["scene"].get("zones", [])),
                          "countingLines": copy.deepcopy(state["scene"].get("countingLines", []))}
        analysis_context: dict[str, Any] = {
            "settingsCaptured": True,
            "detector": detector_context,
            "tracker": {"backend": type(state["tracker"]).__name__},
            "scene": {"geometrySignature": scene_geometry_signature(scene_snapshot),
                      "snapshot": scene_snapshot},
        }
        sample_every_ms = config.get("sampleEveryMs")
        if sample_every_ms is not None:
            analysis_context["sampling"] = {"sampleEveryMs": float(sample_every_ms)}
        configured_mode = config.get("detectionMode")
        if configured_mode in ("auto", "full", "line_roi", "tiled"):
            analysis_context["detectionMode"] = configured_mode
        return {"sourceId": source_id, "sessionId": session_id, "sourceTimeMs": source_time_ms,
                **({"frameId": frame_id} if frame_id else {}),
                "frameWidth": int(w), "frameHeight": int(h), "detections": detections,
                "crossings": crossings, "quality": {"coverage": "known", "notes": notes},
                "analysisContext": analysis_context}

    def process_frame(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_id, session_id = str(payload["sourceId"]), str(payload["sessionId"])
        path = Path(payload["framePath"])
        image = self.cv2.imread(str(path)) if self.cv2 is not None else None
        if image is None:
            raise RuntimeError(f"frame unavailable: could not read {path}")
        timestamp = float(payload["sourceTimeMs"])
        frame_id = payload.get("frameId")
        if frame_id is not None and (not isinstance(frame_id, str) or not _is_uuid_path_part(frame_id)):
            raise RuntimeError("frameId must be a UUID")
        return (self.frame(source_id, session_id, image, timestamp, frame_id)
                if frame_id else self.frame(source_id, session_id, image, timestamp))

    def extract_media_frame(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Re-decode a bounded frame from a trusted local upload; never run inference."""
        source_id = str(payload.get("sourceId", ""))
        session_id = str(payload.get("sessionId", ""))
        event_id = str(payload.get("eventId", ""))
        artifact_id = str(payload.get("artifactId", ""))
        if (not all(_is_uuid_path_part(value) for value in (source_id, session_id, artifact_id)) or
                not (1 <= len(event_id) <= 128 and event_id.isascii() and
                     all(character.isalnum() or character in "-_" for character in event_id))):
            raise RuntimeError("sourceId, sessionId, and artifactId must be UUIDs; eventId must be a safe identifier")
        if self.cv2 is None:
            raise RuntimeError("OpenCV is required to decode a stored upload frame")
        try:
            source_time_ms = float(payload.get("sourceTimeMs"))
            expected_width = int(payload.get("expectedWidth"))
            expected_height = int(payload.get("expectedHeight"))
        except (TypeError, ValueError, OverflowError):
            raise RuntimeError("sourceTimeMs and expected dimensions are required") from None
        if not math.isfinite(source_time_ms) or source_time_ms < 0:
            raise RuntimeError("sourceTimeMs must be a finite nonnegative number")
        if not (1 <= expected_width <= 16384 and 1 <= expected_height <= 16384):
            raise RuntimeError("expected frame dimensions are outside the supported range")

        upload_path = Path(str(payload.get("filePath", ""))).resolve()
        project_root = next((parent for parent in Path(__file__).resolve().parents
                             if (parent / "uploads").is_dir()), None)
        if project_root is None:
            raise RuntimeError("trusted upload directory is unavailable")
        upload_root = (project_root / "uploads").resolve()
        try:
            upload_path.relative_to(upload_root)
        except ValueError:
            raise RuntimeError("stored media must be inside the local uploads directory") from None
        if (upload_path.name != f"{source_id}{upload_path.suffix.lower()}" or
                not upload_path.is_file() or upload_path.suffix.lower() not in (".mp4", ".mov", ".mkv", ".avi", ".webm")):
            raise RuntimeError("stored upload is unavailable or has an unsupported video type")

        artifact_dir_value = payload.get("artifactDir")
        if not isinstance(artifact_dir_value, str) or not Path(artifact_dir_value).is_absolute():
            raise RuntimeError("private artifact directory must be an absolute path")
        artifact_root = Path(artifact_dir_value).resolve()
        if not artifact_root.is_dir():
            raise RuntimeError("private artifact directory must already exist")
        artifact_name = f"{artifact_id}.jpg"
        output_path = (artifact_root / artifact_name).resolve()
        try:
            output_path.relative_to(artifact_root)
        except ValueError:
            raise RuntimeError("invalid private artifact path") from None

        temporary_path = output_path.with_suffix(".tmp.jpg")
        capture = self.cv2.VideoCapture(str(upload_path))
        try:
            if not capture.isOpened():
                raise RuntimeError("stored upload could not be opened")
            duration_ms = float(capture.get(self.cv2.CAP_PROP_FRAME_COUNT) or 0) * 1000 / max(
                float(capture.get(self.cv2.CAP_PROP_FPS) or 0), 0.001)
            if duration_ms > 0 and source_time_ms > duration_ms + 1000:
                raise RuntimeError("requested frame is outside the stored upload duration")
            if not capture.set(self.cv2.CAP_PROP_POS_MSEC, source_time_ms):
                raise RuntimeError("stored upload does not support seeking to this event time")
            ok, image = capture.read()
            if not ok or image is None:
                raise RuntimeError("stored upload frame could not be decoded")
            height, width = image.shape[:2]
            if width != expected_width or height != expected_height:
                raise RuntimeError("decoded frame dimensions do not match the recorded analysis event")
            decoded_time_ms = float(capture.get(self.cv2.CAP_PROP_POS_MSEC) or 0)
            if not math.isfinite(decoded_time_ms) or abs(decoded_time_ms - source_time_ms) > 1:
                raise RuntimeError("decoded frame timestamp does not closely match the recorded analysis event")
            encoded = None
            for quality in (90, 84, 78, 72):
                success, candidate = self.cv2.imencode(".jpg", image, [int(self.cv2.IMWRITE_JPEG_QUALITY), quality])
                if success and len(candidate) <= 4 * 1024 * 1024:
                    encoded = candidate
                    break
            if encoded is None:
                raise RuntimeError("decoded frame exceeds the bounded evidence size")
            temporary_path.write_bytes(encoded.tobytes())
            os.replace(temporary_path, output_path)
            return {"sourceId": source_id, "sessionId": session_id, "eventId": event_id,
                    "sourceTimeMs": source_time_ms, "decodedTimeMs": decoded_time_ms,
                    "frameWidth": width, "frameHeight": height, "mimeType": "image/jpeg",
                    "artifactName": artifact_name, "provenance": "verified_media_redecode"}
        finally:
            capture.release()
            temporary_path.unlink(missing_ok=True)

    def _open_remote_capture(self, media_url: str) -> Any:
        if self.cv2 is None:
            raise RuntimeError("OpenCV is required to read this video source.")
        if not all(hasattr(self.cv2, name) for name in ("CAP_PROP_OPEN_TIMEOUT_MSEC", "CAP_PROP_READ_TIMEOUT_MSEC", "CAP_FFMPEG")):
            raise RuntimeError("This OpenCV build cannot enforce bounded YouTube stream timeouts.")
        try:
            params = [self.cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 10_000,
                      self.cv2.CAP_PROP_READ_TIMEOUT_MSEC, 8_000]
            capture = self.cv2.VideoCapture(media_url, self.cv2.CAP_FFMPEG, params)
        except (TypeError, AttributeError, ValueError):
            raise RuntimeError("This OpenCV build cannot enforce bounded YouTube stream timeouts.") from None
        if not capture.isOpened():
            capture.release()
            raise RuntimeError("YouTube did not open a playable video stream.")
        return capture

    def _capture_fps(self, capture: Any) -> float | None:
        """Return a plausible native rate; OpenCV often reports 0 or NaN for live HLS."""
        try:
            value = float(capture.get(self.cv2.CAP_PROP_FPS))
        except (AttributeError, TypeError, ValueError, OverflowError):
            return None
        return value if math.isfinite(value) and 0.1 <= value <= 120 else None

    @staticmethod
    def _safe_youtube_error(error: Exception) -> str:
        message = str(error)
        lower = message.lower()
        if ("http://" in lower or "https://" in lower or "googlevideo" in lower or
                "videoplayback" in lower or "signature=" in lower or "sig=" in lower or
                "token=" in lower or "expire=" in lower):
            return "YouTube video stream failed. Check the link and try again."
        return message[:500] or "YouTube video stream failed. Check the link and try again."

    def _write_preview(self, image: Any, preview_dir: str, source_id: str,
                       session_id: str, source_time_ms: float, *, notify: bool) -> dict[str, Any]:
        if self.cv2 is None:
            raise RuntimeError("OpenCV is required to create the video preview.")
        try:
            root = Path(preview_dir).resolve()
            frame_id = str(uuid.uuid4())
            target_dir = root / source_id / session_id
            target_dir.mkdir(parents=True, exist_ok=True)
            source_dir = root / source_id
            for old_session in source_dir.iterdir():
                if old_session.is_dir() and old_session != target_dir:
                    shutil.rmtree(old_session, ignore_errors=True)
            source_height, source_width = image.shape[:2]
            scale = min(1.0, 1280 / max(source_width, source_height))
            preview_image = image if scale == 1 else self.cv2.resize(
                image, (max(1, round(source_width * scale)), max(1, round(source_height * scale))))
            preview_height, preview_width = preview_image.shape[:2]
            ok, encoded = self.cv2.imencode(".jpg", preview_image,
                                             [int(self.cv2.IMWRITE_JPEG_QUALITY), 78])
            if not ok:
                raise RuntimeError
            target = target_dir / f"{frame_id}.jpg"
            target.write_bytes(encoded.tobytes())
            prior_frames = sorted(target_dir.glob("*.jpg"), key=lambda item: item.stat().st_mtime_ns, reverse=True)
            for old_frame in prior_frames[4:]:
                old_frame.unlink(missing_ok=True)
        except Exception:
            raise RuntimeError("The decoded video frame could not be cached for preview.") from None
        metadata = {"sourceId": source_id, "sessionId": session_id,
                    "sourceTimeMs": max(0.0, float(source_time_ms)), "frameId": frame_id,
                    "width": int(preview_width), "height": int(preview_height)}
        if notify:
            self.event({"type": "preview_frame", **metadata})
        return metadata

    def _write_analysis_frame(self, image: Any, artifact_dir: str, source_id: str,
                              session_id: str, source_time_ms: float,
                              frame_id: str) -> dict[str, Any]:
        """Stage the exact unannotated decoded image used by inference for API pickup.

        This is intentionally separate from `_write_preview`, which may resize
        video frames. The API owns the bounded published cache and removes this
        volatile staging file after it has copied and validated the bytes.
        """
        if self.cv2 is None:
            raise RuntimeError("OpenCV is required to create the analysis frame artifact.")
        try:
            requested_root = Path(artifact_dir)
            if not requested_root.is_absolute():
                raise RuntimeError
            root = requested_root.resolve()
            if not all(_is_uuid_path_part(value) for value in (source_id, session_id, frame_id)):
                raise RuntimeError
            target_dir = (root / source_id / session_id).resolve()
            if not target_dir.is_relative_to(root):
                raise RuntimeError
            target_dir.mkdir(parents=True, exist_ok=True)
            height, width = image.shape[:2]
            ok, encoded = self.cv2.imencode(
                ".jpg", image,
                [int(self.cv2.IMWRITE_JPEG_QUALITY), 88],
            )
            if not ok:
                raise RuntimeError
            data = encoded.tobytes()
            if len(data) < 4 or len(data) > 4 * 1024 * 1024:
                raise RuntimeError
            target = target_dir / f"{frame_id}.jpg"
            target.write_bytes(data)
            prior = sorted(target_dir.glob("*.jpg"), key=lambda item: item.stat().st_mtime_ns, reverse=True)
            for old in prior[4:]:
                old.unlink(missing_ok=True)
        except Exception:
            raise RuntimeError("The original analyzed frame could not be staged for reporting.") from None
        metadata = {"type": "analysis_frame", "sourceId": source_id, "sessionId": session_id,
                    "sourceTimeMs": max(0.0, float(source_time_ms)), "frameId": frame_id,
                    "frameWidth": int(width), "frameHeight": int(height),
                    "mimeType": "image/jpeg", "artifactName": f"{frame_id}.jpg"}
        return metadata

    def probe_youtube(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Resolve and decode one frame without configuring or starting analysis."""
        source_id, session_id = str(payload["sourceId"]), str(payload["sessionId"])
        raw_url = str(payload.get("url", ""))
        preview_dir = str(payload.get("previewDir", ""))
        if not preview_dir:
            raise RuntimeError("A temporary preview cache is required.")
        try:
            video = resolve_youtube_video(raw_url)
            capture = self._open_remote_capture(video.media_url)
            try:
                ok, image = capture.read()
                if not ok or image is None:
                    raise RuntimeError("YouTube opened, but no video frame could be decoded.")
                metadata = self._write_preview(image, preview_dir, source_id, session_id, 0,
                                               notify=False)
            finally:
                capture.release()
            return {**metadata, "sourceWidth": int(image.shape[1]), "sourceHeight": int(image.shape[0]),
                    "videoId": video.video_id, "title": video.title,
                    **({"isLive": video.is_live} if video.is_live is not None else {}),
                    **({"liveStatus": video.live_status} if video.live_status is not None else {})}
        except Exception as exc:
            raise RuntimeError(self._safe_youtube_error(exc)) from None

    def start_job(self, request_id: str, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        job_id = str(payload.get("jobId") or request_id)
        source_id, session_id = str(payload["sourceId"]), str(payload["sessionId"])
        state = self.session(source_id, session_id)
        if "scene" in payload:
            state["scene"] = payload.get("scene") or {"zones": [], "countingLines": []}
        config = payload.get("config") or {}
        state["config"] = {**state.get("config", {}), **config}
        state["config"].update({k: payload[k] for k in ("modelPath", "detectorBackend", "detectorSize", "confidenceThreshold", "iouThreshold", "inputSize", "nms", "sampleEveryMs", "detectionMode", "lineRoiMargin", "crossingCooldownMs") if k in payload})
        state["config"].setdefault("modelPath", os.getenv("VISION_MODEL_PATH", ""))
        state["config"].setdefault("detectorBackend", os.getenv("VISION_DETECTOR_BACKEND", "onnx"))
        state["config"].setdefault("detectorSize", os.getenv("VISION_DETECTOR_SIZE", "medium"))
        if str(state["config"].get("detectorBackend", "")).lower() == "yolo26":
            state["config"].setdefault("inputSize", os.getenv("VISION_INPUT_SIZE", "640"))
            state["config"].setdefault("nms", os.getenv("VISION_YOLO_NMS", "true"))
        with self.jobs_lock:
            if any(j["sourceId"] == source_id and j["sessionId"] == session_id for j in self.jobs.values()):
                raise RuntimeError("an analysis job is already active for this source session")
            if len(self.jobs) >= 1:
                raise RuntimeError("media analysis capacity is busy; one video/stream job is supported at a time")
            job = {"jobId": job_id, "sourceId": source_id, "sessionId": session_id, "cancel": threading.Event()}
            self.jobs[job_id] = job
        job["future"] = self.executor.submit(self.run_job, job, command, payload)
        job["future"].add_done_callback(lambda future: self.finish_job(job, future))
        return {"jobId": job_id, "accepted": True}

    def run_job(self, job: dict[str, Any], command: str, payload: dict[str, Any]) -> None:
        started = time.monotonic()
        frame_count = 0
        youtube = command == "analyze_youtube"
        try:
            if self.cv2 is None:
                raise RuntimeError(self.import_error or "OpenCV is required")
            path_or_url = str(payload.get("filePath") if command == "analyze_upload" else payload.get("url", ""))
            if not path_or_url:
                raise RuntimeError("A media source is required.")
            media = resolve_youtube_video(path_or_url) if youtube else None
            expected_live = youtube and (media.is_live is True or payload.get("youtubeIsLive") is True)
            if media:
                capture = self._open_remote_capture(media.media_url)
            else:
                capture = self.cv2.VideoCapture(path_or_url)
                if not capture.isOpened():
                    capture.release()
                    raise RuntimeError("Video source is unavailable or could not be opened.")
            fps = self._capture_fps(capture) or 0.0
            sample_every = max(100, float(payload.get("sampleEveryMs", 1000)))
            next_sample = 0.0
            frame_index = 0
            live_retries = 0
            live_clock_origin = time.monotonic()
            live_reader: LatestFrameReader | None = LatestFrameReader(
                capture, live_clock_origin, fps if fps > 0 else None, sample_every / 1000
            ) if youtube and expected_live else None
            live_sequence = 0
            next_live_sample_at = time.monotonic()
            vod_started_at = time.monotonic()
            try:
                while not job["cancel"].is_set():
                    if youtube and expected_live:
                        remaining = next_live_sample_at - time.monotonic()
                        if remaining > 0 and job["cancel"].wait(remaining):
                            break
                        sampled = live_reader.next_after(live_sequence, timeout=0.25) if live_reader else None
                        if sampled is None:
                            if live_reader and live_reader.done:
                                if live_reader.error:
                                    raise RuntimeError(self._safe_youtube_error(live_reader.error)) from None
                                if live_retries >= 3 or job["cancel"].is_set():
                                    raise RuntimeError("YouTube live video disconnected after repeated reconnect attempts.")
                                live_retries += 1
                                live_reader.stop()
                                live_reader = None
                                capture.release()
                                if job["cancel"].wait(min(0.5 * live_retries, 1.5)):
                                    break
                                media = resolve_youtube_video(path_or_url)
                                capture = self._open_remote_capture(media.media_url)
                                live_sequence = 0
                                fps = self._capture_fps(capture) or 0.0
                                live_reader = LatestFrameReader(
                                    capture, live_clock_origin, fps if fps > 0 else None, sample_every / 1000
                                )
                                continue
                            continue
                        live_sequence, image, pos_ms = sampled
                        next_live_sample_at = max(next_live_sample_at + sample_every / 1000,
                                                  time.monotonic() + sample_every / 1000)
                    else:
                        ok, image = capture.read()
                        if not ok or image is None:
                            break
                        pos_ms = float(capture.get(self.cv2.CAP_PROP_POS_MSEC) or 0)
                        if not math.isfinite(pos_ms) or pos_ms <= 0:
                            if youtube and fps > 0:
                                pos_ms = frame_index * 1000 / fps
                            elif youtube:
                                pos_ms = frame_index * sample_every
                            elif command == "analyze_stream":
                                pos_ms = (time.monotonic() - vod_started_at) * 1000
                            elif fps > 0:
                                pos_ms = frame_index * 1000 / fps
                            else:
                                pos_ms = frame_index * sample_every
                        frame_index += 1
                        if pos_ms + 1e-3 < next_sample:
                            continue
                        next_sample = pos_ms + sample_every
                    frame_id = str(uuid.uuid4()) if isinstance(payload.get("frameArtifactDir"), str) and payload["frameArtifactDir"] else None
                    result = (self.frame(job["sourceId"], job["sessionId"], image, pos_ms, frame_id)
                              if frame_id else self.frame(job["sourceId"], job["sessionId"], image, pos_ms))
                    if youtube and live_reader is not None and live_reader.unknown_fps:
                        quality = result.setdefault("quality", {})
                        notes = quality.setdefault("notes", [])
                        notes.append("youtube_capture_fps_unknown;reader_paced_at_analysis_rate")
                    artifact_metadata = None
                    if frame_id:
                        try:
                            artifact_metadata = self._write_analysis_frame(
                                image, str(payload["frameArtifactDir"]), job["sourceId"],
                                job["sessionId"], pos_ms, frame_id,
                            )
                        except RuntimeError:
                            # Frame capture is optional evidence. A staging
                            # failure must not discard an otherwise valid frame.
                            result.pop("frameId", None)
                    self.event(result)
                    if artifact_metadata:
                        self.event(artifact_metadata)
                    if youtube:
                        self._write_preview(image, str(payload.get("previewDir", "")),
                                            job["sourceId"], job["sessionId"], pos_ms,
                                            notify=True)
                    frame_count += 1
            finally:
                if live_reader is not None:
                    live_reader.stop()
                capture.release()
        except Exception as exc:
            if youtube:
                raise RuntimeError(self._safe_youtube_error(exc)) from None
            raise
        finally:
            job["completedFrames"] = frame_count
            job["elapsedMs"] = (time.monotonic() - started) * 1000

    def finish_job(self, job: dict[str, Any], future: concurrent.futures.Future) -> None:
        try:
            error = future.exception()
            if error:
                # Keep detailed media-job failures in the private diagnostic
                # stream while preserving the compact NDJSON error contract.
                traceback.print_exception(error, file=sys.stderr)
                self.write({"type": "event", "event": {"type": "job_error", "jobId": job["jobId"], "sourceId": job["sourceId"], "sessionId": job["sessionId"], "message": str(error)}})
            else:
                self.write({"type": "event", "event": {"type": "job_complete", "jobId": job["jobId"], "sourceId": job["sourceId"], "sessionId": job["sessionId"], "framesAnalyzed": job.get("completedFrames", 0), "elapsedMs": round(job.get("elapsedMs", 0), 1), "cancelled": job["cancel"].is_set()}})
        except Exception as exc:
            print(f"job completion reporting failed: {exc}", file=sys.stderr, flush=True)
        finally:
            with self.jobs_lock:
                self.jobs.pop(job["jobId"], None)

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        command = str(request.get("command", ""))
        payload = request.get("payload") or {}
        if command == "health":
            return self.health()
        if command in ("configure", "start"):
            if command == "start" and payload.get("scene") is None:
                existing = self.session(str(payload["sourceId"]), str(payload["sessionId"]))
                payload = {**payload, "scene": existing["scene"]}
            return self.configure(payload)
        if command == "process_frame":
            result = self.process_frame(payload)
            self.event(result)
            return {"accepted": True, "sourceId": result["sourceId"], "sessionId": result["sessionId"]}
        if command == "extract_media_frame":
            return self.extract_media_frame(payload)
        if command in ("analyze_upload", "analyze_stream", "analyze_youtube"):
            return self.start_job(str(request.get("requestId", "")), command, payload)
        if command == "probe_youtube":
            return self.probe_youtube(payload)
        if command == "stop":
            source_id, session_id = str(payload["sourceId"]), str(payload["sessionId"])
            with self.jobs_lock:
                matching = [job for job in self.jobs.values()
                            if job["sourceId"] == source_id and job["sessionId"] == session_id]
                for job in matching:
                    job["cancel"].set()
            for job in matching:
                future = job.get("future")
                if future is None:
                    continue
                try:
                    future.result(timeout=12.0)
                except concurrent.futures.TimeoutError:
                    raise RuntimeError("Vision worker is still stopping this source; retry shortly.") from None
                except Exception:
                    # The job's error event is reported by its completion callback;
                    # the stop acknowledgement still means its capture is closed.
                    pass
                with self.jobs_lock:
                    if future.done():
                        self.jobs.pop(job["jobId"], None)
            self.sessions.pop((source_id, session_id), None)
            return {"stopped": True}
        if command == "shutdown":
            for job in list(self.jobs.values()):
                job["cancel"].set()
            return {"shutdown": True}
        raise ValueError(f"unknown command: {command}")

    def run(self) -> None:
        self.write({"type": "ready", "available": False,
                    "detail": self.import_error or "No local ONNX model is loaded; configure modelPath to enable detections"})
        for line in sys.stdin:
            try:
                request = json.loads(line)
                request_id = request.get("requestId")
                try:
                    result = self.handle(request)
                    self.write({"requestId": request_id, "type": "response", "ok": True, "result": result})
                    if request.get("command") == "shutdown":
                        break
                except Exception as exc:
                    self.write({"requestId": request_id, "type": "response", "ok": False, "error": str(exc)})
            except Exception as exc:
                print(f"invalid protocol line: {exc}", file=sys.stderr, flush=True)
        for job in list(self.jobs.values()):
            job["cancel"].set()
        self.executor.shutdown(wait=True, cancel_futures=True)


class OnnxYolo:
    def __init__(self, worker: Worker, session: Any, config: dict[str, Any]):
        self.worker, self.session = worker, session
        self.np, self.cv2 = worker.np, worker.cv2
        self.input = session.get_inputs()[0]
        shape = self.input.shape
        configured = int(config.get("inputSize", 640))
        self.height = int(shape[2]) if isinstance(shape[2], int) else configured
        self.width = int(shape[3]) if isinstance(shape[3], int) else configured
        self.confidence = float(config.get("confidenceThreshold", 0.25))
        self.iou_threshold = float(config.get("iouThreshold", 0.45))
        self.backend = "onnx"
        self.model_name = Path(str(config.get("modelPath", ""))).name
        self.provider = ",".join(session.get_providers()) if hasattr(session, "get_providers") else "unknown"
        self.device = self.provider
        self.target_device = self.device
        self.yolox = "object_detection_yolox" in os.path.basename(session.get_modelmeta().graph_name).lower()
        # Graph names are not guaranteed to identify exports; caller may select
        # this adapter explicitly via a filename containing `yolox`.
        self.yolox = self.yolox or "yolox" in str(config.get("modelPath", "")).lower()

    def infer(self, frame: Any) -> list[dict[str, Any]]:
        h, w = frame.shape[:2]
        scale = min(self.width / w, self.height / h)
        rw, rh = int(round(w * scale)), int(round(h * scale))
        resized = self.cv2.resize(frame, (rw, rh), interpolation=self.cv2.INTER_LINEAR)
        canvas = self.np.full((self.height, self.width, 3), 114, dtype=self.np.uint8)
        left, top = (0, 0) if self.yolox else ((self.width - rw) // 2, (self.height - rh) // 2)
        canvas[top:top + rh, left:left + rw] = resized
        values = canvas[:, :, ::-1].astype(self.np.float32)
        if not self.yolox:
            values /= 255.0
        tensor = self.np.transpose(values, (2, 0, 1))[None]
        output = self.session.run(None, {self.input.name: tensor})[0]
        rows = self.np.asarray(output)
        if rows.ndim == 3:
            rows = rows[0]
        if rows.ndim != 2:
            raise RuntimeError(f"unsupported ONNX output shape {rows.shape}")
        if self.yolox:
            rows = self._decode_yolox(rows)
        # YOLOv8 commonly gives [84,N], while many exporters transpose to [N,84].
        if rows.shape[0] < rows.shape[1] and rows.shape[0] in (84, 85, 6, 7):
            rows = rows.T
        boxes, scores, classes = [], [], []
        for row in rows:
            values = row.tolist()
            if len(values) == 6:
                x1, y1, x2, y2, score, class_id = values
                class_id = int(class_id)
            elif len(values) > 5:
                x, y, bw, bh = values[:4]
                scores_raw = values[4:]
                objectness = 1.0
                if len(scores_raw) == 81:  # YOLOv5 COCO: objectness + 80 classes
                    objectness, scores_raw = scores_raw[0], scores_raw[1:]
                class_id = int(max(range(len(scores_raw)), key=scores_raw.__getitem__))
                score = float(scores_raw[class_id]) * float(objectness)
                x1, y1, x2, y2 = x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2
            else:
                continue
            if class_id not in VEHICLE_CLASSES or score < self.confidence:
                continue
            # Some ONNX postprocessors return normalized coordinates.
            if max(abs(x1), abs(y1), abs(x2), abs(y2)) <= 1.5:
                x1, x2, y1, y2 = x1 * self.width, x2 * self.width, y1 * self.height, y2 * self.height
            x1, y1, x2, y2 = model_box_to_normalized((x1, y1, x2, y2), w, h, scale, left, top)
            if x2 <= x1 or y2 <= y1:
                continue
            boxes.append((x1, y1, x2, y2))
            scores.append(float(score))
            classes.append(class_id)
        keep = []
        remaining = sorted(range(len(boxes)), key=lambda i: scores[i], reverse=True)
        while remaining:
            best = remaining.pop(0)
            keep.append(best)
            remaining = [i for i in remaining if _iou(boxes[best], boxes[i]) <= self.iou_threshold]
        return [{"bboxXYXY": boxes[i], "class": VEHICLE_CLASSES[classes[i]], "confidence": scores[i]} for i in keep]

    def infer_scene(self, frame: Any, scene: dict[str, Any], mode: str = "auto", margin: float = 0.12) -> tuple[list[dict[str, Any]], str, int]:
        """Run full-frame, line-region, or overlapping full-frame tile inference."""
        if mode == "auto":
            if max(frame.shape[:2]) <= 1280:
                mode = "full"
            else:
                mode = "coverage"
        if mode == "full":
            return self.infer(frame), "full_frame", 1
        if mode in ("tiled", "coverage"):
            height, width = frame.shape[:2]
            rectangles = frame_tile_rectangles(width, height)
            detections: list[dict[str, Any]] = []
            for tile_index, rectangle in enumerate(rectangles):
                x1, y1, x2, y2 = rectangle
                tile_detections = self.infer(frame[y1:y2, x1:x2])
                mapped = remap_crop_detections(tile_detections, rectangle, width, height)
                detections.extend(attach_frame_tile_provenance(mapped, rectangle, width, height, tile_index))
            region_count = len(rectangles)
            if mode == "coverage":
                line_rectangles = line_roi_rectangles(scene, width, height, margin=margin, maximum=8)
                for line_index, rectangle in enumerate(line_rectangles, start=len(rectangles)):
                    x1, y1, x2, y2 = rectangle
                    line_detections = self.infer(frame[y1:y2, x1:x2])
                    mapped = remap_crop_detections(line_detections, rectangle, width, height)
                    detections.extend({**detection, "_tileIndex": line_index} for detection in mapped)
                region_count += len(line_rectangles)
                fine_line_rectangles = split_roi_rectangles(
                    [rect for rect in line_roi_rectangles(scene, width, height, margin=0.05, maximum=8)
                     if rect not in line_rectangles],
                    maximum_dimension=640, overlap=0.20, maximum_patches=8)
                for line_index, rectangle in enumerate(fine_line_rectangles, start=region_count):
                    x1, y1, x2, y2 = rectangle
                    line_detections = self.infer(frame[y1:y2, x1:x2])
                    mapped = remap_crop_detections(line_detections, rectangle, width, height)
                    detections.extend({**detection, "_tileIndex": line_index} for detection in mapped)
                region_count += len(fine_line_rectangles)
            result_mode = "full_frame_tiled_with_line_detail" if mode == "coverage" and region_count > len(rectangles) else "full_frame_tiled"
            if getattr(self, "backend", None) == "yolo26" and has_large_vehicle_tile_fragments(detections):
                anchors = self.infer(frame)
                region_count += 1
                detections, anchor_used = reconcile_large_vehicle_tile_fragments(detections, anchors, width, height)
                if anchor_used:
                    result_mode += "_with_large_vehicle_anchor"
                else:
                    result_mode += "_with_large_vehicle_anchor_probe"
            return deduplicate_detections(detections, self.iou_threshold), result_mode, region_count
        height, width = frame.shape[:2]
        rectangles = line_roi_rectangles(scene, width, height, margin=margin, maximum=8)
        if not rectangles:
            return self.infer(frame), "full_frame", 1
        detections: list[dict[str, Any]] = []
        for rectangle in rectangles:
            x1, y1, x2, y2 = rectangle
            crop_detections = self.infer(frame[y1:y2, x1:x2])
            detections.extend(remap_crop_detections(crop_detections, rectangle, width, height))
        return deduplicate_detections(detections, self.iou_threshold), "line_roi", len(rectangles)

    def _decode_yolox(self, output: Any) -> Any:
        rows = self.np.asarray(output, dtype=self.np.float32)
        if rows.shape[0] == 85 and rows.shape[1] != 85:
            rows = rows.T
        expected = (self.width // 8) ** 2 + (self.width // 16) ** 2 + (self.width // 32) ** 2
        if rows.shape != (expected, 85):
            raise RuntimeError(f"YOLOX COCO export expected [{expected},85] output, received {rows.shape}")
        grid_parts, stride_parts = [], []
        for stride in (8, 16, 32):
            grid_x, grid_y = self.np.meshgrid(self.np.arange(self.width // stride), self.np.arange(self.height // stride))
            grid_parts.append(self.np.stack((grid_x, grid_y), axis=-1).reshape(-1, 2))
            stride_parts.append(self.np.full((grid_parts[-1].shape[0], 1), stride))
        grids = self.np.concatenate(grid_parts).astype(self.np.float32)
        strides = self.np.concatenate(stride_parts).astype(self.np.float32)
        decoded = rows.copy()
        decoded[:, :2] = (decoded[:, :2] + grids) * strides
        decoded[:, 2:4] = self.np.exp(self.np.clip(decoded[:, 2:4], -10, 10)) * strides
        return decoded


def select_yolo_device(torch: Any, mode: str | None = None) -> int | str:
    """Pick an available accelerator unless CPU is explicitly requested."""
    selected_mode = (mode if mode is not None else os.getenv("VISION_DEVICE", "auto")).strip().lower()
    if selected_mode not in ("auto", "cpu"):
        raise ValueError("VISION_DEVICE must be 'auto' or 'cpu'")
    if selected_mode == "cpu":
        return "cpu"
    try:
        if torch.cuda.is_available():
            return 0
    except (AttributeError, RuntimeError):
        pass
    try:
        mps = torch.backends.mps
        if mps.is_built() and mps.is_available():
            return "mps"
    except (AttributeError, RuntimeError):
        pass
    return "cpu"


class Yolo26Adapter:
    """Ultralytics YOLO26 COCO adapter with the worker's normalized output contract."""

    SUPPORTED_INPUT_SIZES = (640, 960, 1280)

    def __init__(self, worker: Worker, model_path: str, config: dict[str, Any]):
        self.worker = worker
        self.np, self.cv2 = worker.np, worker.cv2
        try:
            with contextlib.redirect_stdout(sys.stderr):
                from ultralytics import YOLO
                import torch
        except Exception as exc:
            raise RuntimeError(f"Ultralytics/Torch runtime unavailable: {exc}") from exc
        try:
            self.input_size = int(config.get("inputSize", os.getenv("VISION_INPUT_SIZE", "640")))
        except (TypeError, ValueError) as exc:
            raise ValueError("inputSize must be one of 640, 960, or 1280") from exc
        if self.input_size not in self.SUPPORTED_INPUT_SIZES:
            raise ValueError("inputSize must be one of 640, 960, or 1280")
        self.torch = torch
        # Ultralytics binds its logger's stream at import time. If another
        # library imported it earlier, redirect those existing handlers too.
        for handler in logging.getLogger("ultralytics").handlers:
            if isinstance(handler, logging.StreamHandler):
                handler.setStream(sys.stderr)
        with contextlib.redirect_stdout(sys.stderr):
            self.model = YOLO(model_path)
        self.backend = "yolo26"
        self.confidence = float(config.get("confidenceThreshold", 0.25))
        self.iou_threshold = float(config.get("iouThreshold", 0.45))
        nms_value = config.get("nms", os.getenv("VISION_YOLO_NMS", "true"))
        self.nms = nms_value if isinstance(nms_value, bool) else str(nms_value).strip().lower() in ("1", "true", "yes", "on")
        self.predict_device = select_yolo_device(torch)
        self.target_device = "cuda:0" if self.predict_device == 0 else str(self.predict_device)
        self.device = self._device_name()
        self.provider = self.device
        self.model_name = f"YOLO26 Medium (COCO, imgsz={self.input_size}, nms={self.nms})"
        self.raw_class_counts: dict[int, int] = defaultdict(int)
        self.cross_class_duplicate_iou_threshold = 0.985
        self.cross_class_duplicate_suppressed = 0

    def _device_name(self) -> str:
        try:
            return str(next(self.model.model.parameters()).device)
        except (AttributeError, StopIteration, TypeError):
            return "unresolved"

    def infer(self, frame: Any) -> list[dict[str, Any]]:
        with contextlib.redirect_stdout(sys.stderr):
            results = self.model.predict(source=frame, imgsz=self.input_size, conf=self.confidence,
                                         iou=self.iou_threshold, nms=self.nms,
                                         device=self.predict_device, verbose=False)
        self.device = self._device_name()
        self.provider = self.device
        if not results:
            return []
        result = results[0]
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            raise RuntimeError("unsupported YOLO26 result: expected boxes.xyxy, boxes.conf, and boxes.cls")
        xyxy = getattr(boxes, "xyxy", None)
        scores = getattr(boxes, "conf", None)
        classes = getattr(boxes, "cls", None)
        if xyxy is None or scores is None or classes is None:
            raise RuntimeError("unsupported YOLO26 result: expected boxes.xyxy, boxes.conf, and boxes.cls")
        try:
            self.device = str(xyxy.device)
        except AttributeError:
            pass
        self.provider = self.device
        self.provider = self.device

        def as_numpy(values: Any) -> Any:
            if hasattr(values, "detach"):
                return values.detach().cpu().numpy()
            return self.np.asarray(values)

        xyxy_values, score_values, class_values = as_numpy(xyxy), as_numpy(scores), as_numpy(classes)
        names = getattr(result, "names", getattr(self.model, "names", {}))
        height, width = frame.shape[:2]
        output: list[dict[str, Any]] = []
        for box, score, class_value in zip(xyxy_values, score_values, class_values):
            class_id = int(class_value)
            self.raw_class_counts[class_id] += 1
            if class_id < 0:
                continue
            name = names.get(class_id) if isinstance(names, dict) else names[class_id] if class_id < len(names) else None
            if name not in VEHICLE_CLASSES.values():
                continue
            confidence = float(score)
            if confidence < self.confidence:
                continue
            x1, y1, x2, y2 = (float(value) for value in box)
            x1, x2 = max(0.0, min(width, x1)), max(0.0, min(width, x2))
            y1, y2 = max(0.0, min(height, y1)), max(0.0, min(height, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            output.append({"bboxXYXY": (x1 / width, y1 / height, x2 / width, y2 / height),
                           "class": str(name), "confidence": confidence})
        return output

    def infer_scene(self, frame: Any, scene: dict[str, Any], mode: str = "auto", margin: float = 0.12) -> tuple[list[dict[str, Any]], str, int]:
        detections, result_mode, region_count = OnnxYolo.infer_scene(self, frame, scene, mode, margin)
        # Some model heads can assign two vehicle labels to the exact same
        # physical object. Suppress only effectively identical cross-class
        # boxes; ordinary overlap between distinct/occluded vehicles remains.
        kept: list[dict[str, Any]] = []
        self.cross_class_duplicate_suppressed = 0
        for detection in sorted(detections, key=lambda item: float(item.get("confidence", 0)), reverse=True):
            box = tuple(float(value) for value in detection["bboxXYXY"])
            duplicate = any(
                existing.get("class") != detection.get("class") and
                _iou(box, tuple(float(value) for value in existing["bboxXYXY"])) >= self.cross_class_duplicate_iou_threshold
                for existing in kept
            )
            if duplicate:
                self.cross_class_duplicate_suppressed += 1
            else:
                kept.append(detection)
        return kept, result_mode, region_count


class RfDetrAdapter:
    """RF-DETR COCO adapter exposing the same normalized vehicle detections as ONNX YOLO."""

    def __init__(self, worker: Worker, model_path: str, config: dict[str, Any]):
        self.worker = worker
        self.np, self.cv2 = worker.np, worker.cv2
        self.iou_threshold = float(config.get("iouThreshold", 0.45))
        self.confidence = float(config.get("confidenceThreshold", 0.25))
        self.backend = "rfdetr"
        size = str(config.get("detectorSize", os.getenv("VISION_DETECTOR_SIZE", "medium"))).lower()
        model_classes = {"medium": "RFDETRMedium", "large": "RFDETRLarge"}
        if size not in model_classes:
            raise ValueError("detectorSize must be medium or large")
        try:
            import rfdetr
            import torch
        except Exception as exc:
            raise RuntimeError(f"RF-DETR runtime unavailable: {exc}") from exc
        model_class = getattr(rfdetr, model_classes[size])
        self.model = model_class(pretrain_weights=model_path)
        # RF-DETR's predict API owns preprocessing and device selection. Report the
        # configured PyTorch execution device as runtime metadata for every event.
        self.torch = torch
        self.device = self._device_name()
        self.target_device = self._target_device_name()
        self.provider = self.device
        self.model_name = f"RF-DETR {size.title()} (COCO)"
        self.raw_class_counts: dict[int, int] = defaultdict(int)

    def _device_name(self) -> str:
        context = getattr(self.model, "model", None)
        module = getattr(context, "model", None)
        try:
            device = next(module.parameters()).device
        except (AttributeError, StopIteration, TypeError):
            # Small injected test models expose only the selected context device.
            device = getattr(context, "device", None)
        if device is None:
            return "unresolved"
        return str(device)

    def _target_device_name(self) -> str:
        context = getattr(self.model, "model", None)
        return str(getattr(context, "device", "unresolved"))

    def infer(self, frame: Any) -> list[dict[str, Any]]:
        rgb = self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        result = self.model.predict(rgb, threshold=self.confidence)
        # predict() moves RF-DETR's deferred model context to its configured device.
        self.device = self._device_name()
        self.target_device = self._target_device_name()
        self.provider = self.device
        boxes = getattr(result, "xyxy", None)
        scores = getattr(result, "confidence", None)
        classes = getattr(result, "class_id", None)
        if boxes is None or scores is None or classes is None:
            raise RuntimeError("unsupported RF-DETR result: expected xyxy, confidence, and class_id")
        for class_id in classes:
            self.raw_class_counts[int(class_id)] += 1
        output: list[dict[str, Any]] = []
        height, width = frame.shape[:2]
        for box, score, class_id in zip(boxes, scores, classes):
            name = RFDETR_VEHICLE_CLASSES.get(int(class_id))
            confidence = float(score)
            if name is None or confidence < self.confidence:
                continue
            x1, y1, x2, y2 = (float(value) for value in box)
            x1, x2 = max(0.0, min(width, x1)), max(0.0, min(width, x2))
            y1, y2 = max(0.0, min(height, y1)), max(0.0, min(height, y2))
            if x2 <= x1 or y2 <= y1:
                continue
            output.append({"bboxXYXY": (x1 / width, y1 / height, x2 / width, y2 / height),
                           "class": name, "confidence": confidence})
        return output

    def infer_scene(self, frame: Any, scene: dict[str, Any], mode: str = "auto", margin: float = 0.12) -> tuple[list[dict[str, Any]], str, int]:
        # The scene pipeline is backend-neutral; reuse the production crop mapping,
        # region budget, and global deduplication rules verbatim.
        return OnnxYolo.infer_scene(self, frame, scene, mode, margin)


def _iou(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


if __name__ == "__main__":
    Worker().run()
