"""Matched-frame, offline detector comparison for the saved 4K road-view probe.

This script is read-only with respect to app data. It decodes the three fixed
frames, runs the same production scene inference pipeline, and writes candidate
measurements and annotated frames under apps/vision/.tmp.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import cv2

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "apps" / "vision"))

from worker import COCO_NAMES, Worker


SOURCE_ID = "7473a6f0-1070-41f5-82ae-d6680abe7164"
VIDEO = ROOT / "uploads" / f"{SOURCE_ID}.mp4"
POINT_PROBE = ROOT / "apps" / "vision" / ".tmp" / "split-gate-probe.json"
HISTORICAL_REPOSITORY = ROOT / "data" / "repository.json.1432.tmp"
CURRENT_REPOSITORY = ROOT / "data" / "repository.json"
SAVED_CENTER_SHEET = ROOT / "apps" / "vision" / ".tmp" / "selected-centers-source-only.jpg"
FIXED_POINTS_PATH = ROOT / "docs" / "evidence" / "detector-fixed-points.json"
OUTPUT_DIR = ROOT / "apps" / "vision" / ".tmp"
FOCUS_REGIONS = {"North": (0.49, 0.58, 0.68, 0.73),
                 "South": (0.22, 0.49, 0.37, 0.64)}
LOWER_ROAD_POINTS = [
    ("LowerRoad", 1, (0.502, 0.856)), ("LowerRoad", 2, (0.531, 0.855)),
    ("LowerRoad", 3, (0.502, 0.893)), ("LowerRoad", 4, (0.475, 0.925)),
    ("LowerRoad", 5, (0.532, 0.944)),
]


def match_fixed_centers(points: list[tuple[str, int, tuple[float, float]]], detections: list[dict], padding: float = 0.002) -> list[dict]:
    """Maximum-cardinality one-to-one match using only the saved center rule."""
    detection_to_point: dict[int, int] = {}

    def assign(point_index: int, visited: set[int]) -> bool:
        _, _, (x, y) = points[point_index]
        candidates = []
        for detection_index, detection in enumerate(detections):
            x1, y1, x2, y2 = detection["bboxXYXY"]
            if x1 - padding <= x <= x2 + padding and y1 - padding <= y <= y2 + padding:
                candidates.append(detection_index)
        candidates.sort(key=lambda index: (-float(detections[index]["confidence"]), index))
        for detection_index in candidates:
            if detection_index in visited:
                continue
            visited.add(detection_index)
            previous_point = detection_to_point.get(detection_index)
            if previous_point is None or assign(previous_point, visited):
                detection_to_point[detection_index] = point_index
                return True
        return False

    for point_index in range(len(points)):
        assign(point_index, set())
    matches = []
    for detection_index, point_index in sorted(detection_to_point.items(), key=lambda item: item[1]):
        region, point_number, xy = points[point_index]
        matches.append({"region": region, "point": point_number, "xy": list(xy),
                        "detectionIndex": detection_index,
                        "bboxXYXY": [round(float(v), 6) for v in detections[detection_index]["bboxXYXY"]],
                        "class": detections[detection_index]["class"],
                        "confidence": round(float(detections[detection_index]["confidence"]), 4)})
    return matches


def benchmark_scene(profile: str) -> dict:
    """Load frozen historical gates or read-only current source zones."""
    path = HISTORICAL_REPOSITORY if profile == "historical" else CURRENT_REPOSITORY
    data = json.loads(path.read_text(encoding="utf-8"))
    scene = data["scenes"][SOURCE_ID]
    if profile == "historical" and len(scene.get("countingLines", [])) != 2:
        raise RuntimeError("frozen benchmark geometry does not contain both saved gate lines")
    if profile == "current-zones" and (len(scene.get("zones", [])) != 2 or scene.get("countingLines")):
        raise RuntimeError("current source geometry changed; expected the saved two-zone/no-line scene")
    return scene


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=("onnx", "rfdetr", "yolo26"), required=True)
    parser.add_argument("--model", required=True, help="absolute or repository-relative local model/checkpoint path")
    parser.add_argument("--size", choices=("medium", "large"), default="medium")
    parser.add_argument("--confidence", type=float, default=0.25)
    parser.add_argument("--scene-profile", choices=("historical", "current-zones"), default="historical")
    parser.add_argument("--input-size", type=int, choices=(640, 960, 1280), default=640)
    parser.add_argument("--nms", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--run-tag", default="", help="optional output-name suffix to preserve prior evidence")
    args = parser.parse_args()
    rfdetr_coco_names = {}
    if args.backend == "rfdetr":
        # RF-DETR uses sparse official COCO category IDs. Do not infer these
        # names from YOLO's contiguous 0-based class list.
        try:
            from rfdetr.assets.coco_classes import COCO_CLASSES
        except Exception as exc:
            raise RuntimeError(f"RF-DETR COCO name map unavailable in this runtime: {exc}") from exc
        rfdetr_coco_names = COCO_CLASSES

    model_path = Path(args.model)
    if not model_path.is_absolute():
        model_path = ROOT / model_path
    scene = benchmark_scene(args.scene_profile)
    worker = Worker()
    configured = worker.configure({
        "sourceId": "offline-detector-benchmark",
        "sessionId": f"{args.backend}-{args.size}",
        "scene": scene,
        "config": {"modelPath": str(model_path), "detectorBackend": args.backend,
                   "detectorSize": args.size, "confidenceThreshold": args.confidence,
                   "iouThreshold": 0.45, "inputSize": args.input_size, "nms": args.nms,
                   "detectionMode": "auto", "lineRoiMargin": 0.12},
    })
    detector = worker.detector(worker.session("offline-detector-benchmark", f"{args.backend}-{args.size}")["config"])
    fixed = json.loads(POINT_PROBE.read_text(encoding="utf-8"))
    fixed_points = json.loads(FIXED_POINTS_PATH.read_text(encoding="utf-8"))
    if fixed_points.get("source", {}).get("sourceId") != SOURCE_ID:
        raise RuntimeError("fixed-center truth file belongs to a different source")
    gate_points_by_time: dict[float, list[tuple[str, int, tuple[float, float]]]] = {}
    for point in fixed_points["points"]:
        gate_points_by_time.setdefault(float(point["sourceTimeMs"]), []).append(
            (str(point["id"]), int(point["point"]), (float(point["xy"][0]), float(point["xy"][1]))))
    capture = cv2.VideoCapture(str(VIDEO))
    if not capture.isOpened():
        worker.executor.shutdown(wait=True)
        raise RuntimeError(f"could not open benchmark source video: {VIDEO}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    profile_suffix = "" if args.scene_profile == "historical" else "-current-zones"
    model_suffix = f"-imgsz{args.input_size}-nms{int(args.nms)}" if args.backend == "yolo26" else ""
    run_suffix = f"-{args.run_tag}" if args.run_tag else ""
    result = {"sourceId": SOURCE_ID, "sceneProfile": args.scene_profile, "backend": args.backend, "model": configured["model"],
              "confidenceThreshold": args.confidence, "iouThreshold": 0.45,
              "effectiveInputSize": args.input_size if args.backend == "yolo26" else None,
              "yolo26Nms": args.nms if args.backend == "yolo26" else None,
              "fixedCenterProbe": {"source": str(FIXED_POINTS_PATH.relative_to(ROOT)),
                                   "originalMarkedSheet": str(SAVED_CENTER_SHEET.relative_to(ROOT)),
                                   "gatePointCountsByTime": [5, 6, 6],
                                   "criterion": "one detection may match at most one preselected center; 0.002 normalized padding; visual reviewer confirms same-car matches",
                                   "gatePointCoordinates": "loaded from the canonical fixed-point file; one-to-one box containment is an automatic candidate only until same-car visual review",
                                   "northPoint4At59957Ms": "must remain a miss unless the box covers that partial car",
                                   "lowerRoad115850MsPoints": [{"region": region, "point": number, "xy": list(xy)}
                                                               for region, number, xy in LOWER_ROAD_POINTS]},
              "frames": []}
    try:
        for reference in fixed:
            frame_index = int(reference["decodedFrameIndex"])
            capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError(f"could not decode fixed frame index {frame_index}")
            started = time.perf_counter()
            if hasattr(detector, "raw_class_counts"):
                detector.raw_class_counts.clear()
            detections, mode, regions = detector.infer_scene(frame, scene, "auto", 0.12)
            duplicate_suppressed = getattr(detector, "cross_class_duplicate_suppressed", 0)
            elapsed_ms = (time.perf_counter() - started) * 1000
            actual_device = detector.device
            raw_model_class_counts = {}
            for class_id, count in getattr(detector, "raw_class_counts", {}).items():
                if args.backend == "rfdetr":
                    class_name = rfdetr_coco_names.get(class_id, f"unknown_coco_category_{class_id}")
                else:
                    class_name = COCO_NAMES[class_id] if args.backend == "yolo26" and 0 <= class_id < len(COCO_NAMES) else "unknown"
                raw_model_class_counts[f"{class_id}:{class_name}"] = count
            points = gate_points_by_time.get(float(reference["targetMs"]), [])
            matched = match_fixed_centers(points, detections)
            lower_points = LOWER_ROAD_POINTS if abs(float(reference["targetMs"]) - 115850.61111111112) < 0.01 else []
            lower_matches = match_fixed_centers(lower_points, detections)
            frame_path = OUTPUT_DIR / f"detector-{args.backend}-{args.size}{model_suffix}{profile_suffix}{run_suffix}-{int(reference['targetMs'])}.jpg"
            rendered = frame.copy()
            height, width = rendered.shape[:2]
            for detection in detections:
                x1, y1, x2, y2 = detection["bboxXYXY"]
                p1, p2 = (round(x1 * width), round(y1 * height)), (round(x2 * width), round(y2 * height))
                cv2.rectangle(rendered, p1, p2, (0, 255, 0), 3)
                cv2.putText(rendered, f"{detection['class']} {detection['confidence']:.2f}", p1,
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.imwrite(str(frame_path), cv2.resize(rendered, (1920, 1080)))
            focus_paths = {}
            for region_name, (rx1, ry1, rx2, ry2) in FOCUS_REGIONS.items():
                x1, y1 = round(rx1 * width), round(ry1 * height)
                x2, y2 = round(rx2 * width), round(ry2 * height)
                crop = frame[y1:y2, x1:x2].copy()
                for detection in detections:
                    bx1, by1, bx2, by2 = detection["bboxXYXY"]
                    if bx2 < rx1 or bx1 > rx2 or by2 < ry1 or by1 > ry2:
                        continue
                    p1 = (round(bx1 * width) - x1, round(by1 * height) - y1)
                    p2 = (round(bx2 * width) - x1, round(by2 * height) - y1)
                    cv2.rectangle(crop, p1, p2, (0, 255, 0), 3)
                    cv2.putText(crop, f"{detection['class']} {detection['confidence']:.2f}", p1,
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                crop_path = OUTPUT_DIR / f"detector-{args.backend}-{args.size}{model_suffix}{profile_suffix}{run_suffix}-{int(reference['targetMs'])}-{region_name}.jpg"
                cv2.imwrite(str(crop_path), crop)
                focus_paths[region_name] = str(crop_path.relative_to(ROOT))
            result["frames"].append({"sourceTimeMs": reference["targetMs"], "decodedFrameIndex": frame_index,
                                     "mode": mode, "inferenceRegions": regions,
                                     "device": actual_device,
                                     "processingMs": round(elapsed_ms, 1), "rawDetections": len(detections),
                                     "nearIdenticalCrossClassSuppressed": duplicate_suppressed,
                                     "fixedGateCenterContainmentCandidates": len(matched),
                                     "fixedGateCentersTotal": len(points), "fixedGateCenterMatches": matched,
                                     "lowerRoadMatches": len(lower_matches), "lowerRoadTotal": len(lower_points),
                                     "lowerRoadMatchDetails": lower_matches,
                                     "rawModelClassCountsByTile": raw_model_class_counts,
                                     "classCounts": {name: sum(d["class"] == name for d in detections)
                                                     for name in sorted({d["class"] for d in detections})},
                                     "detections": [{"bboxXYXY": [round(float(v), 6) for v in d["bboxXYXY"]],
                                                     "class": d["class"], "confidence": round(float(d["confidence"]), 4)}
                                                    for d in detections],
                                     "annotatedFrame": str(frame_path.relative_to(ROOT)),
                                     "annotatedFocusFrames": focus_paths})
            print(json.dumps({"sourceTimeMs": reference["targetMs"], "processingMs": round(elapsed_ms, 1),
                              "regions": regions, "detections": len(detections)}), flush=True)
    finally:
        capture.release()
        worker.executor.shutdown(wait=True)

    lower_matches = sum(item["lowerRoadMatches"] for item in result["frames"])
    result["model"] = {"backend": detector.backend, "name": detector.model_name,
                       "device": detector.device, "targetDevice": detector.target_device}
    gate_matches = sum(item["fixedGateCenterContainmentCandidates"] for item in result["frames"])
    gate_total = sum(item["fixedGateCentersTotal"] for item in result["frames"])
    result["fixedCenterSummary"] = {"gatePointContainmentCandidates": gate_matches,
                                    "gatePointsTotal": gate_total,
                                    "gateSameCarVisualReviewRequired": True,
                                    "lowerRoadPointsMatched": lower_matches, "lowerRoadPointsTotal": 5,
                                    "paddingNormalized": 0.002, "oneToOne": True}
    result_path = OUTPUT_DIR / f"detector-{args.backend}-{args.size}{model_suffix}{profile_suffix}{run_suffix}-benchmark.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"result": str(result_path.relative_to(ROOT)), "model": result["model"]}, indent=2))


if __name__ == "__main__":
    main()
