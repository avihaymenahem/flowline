import contextlib
import copy
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from vision_core import (IoUTracker, Track, attach_frame_tile_provenance, deduplicate_detections, footpoint, line_crossings,
                         bbox_iou, frame_tile_rectangles, has_large_vehicle_tile_fragments, line_roi_rectangles,
                         model_box_to_normalized, point_in_polygon, reconcile_large_vehicle_tile_fragments,
                         split_roi_rectangles,
                         remap_crop_detections, sampling_notes, suppress_recent_recrossings,
                         vehicle_color)
from worker import OnnxYolo, Worker, scene_geometry_signature


class VisionCoreTests(unittest.TestCase):
    def test_worker_scene_signature_matches_shared_contract_unicode_fixture(self):
        scene = {
            "zones": [{"id": "🚗-zone", "name": "道路", "polygon": [
                {"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}]}],
            "countingLines": [{"id": "線", "name": "North",
                               "start": {"x": 0, "y": 0.5}, "end": {"x": 1, "y": 0.5},
                               "directionLabels": ["East", "West"]}],
        }
        expected = 'g1:[[ ["🚗-zone",[[0,0],[1,0],[1,1]]] ],[["線",[0,0.5],[1,0.5]]]]'.replace(" ", "")
        self.assertEqual(expected, scene_geometry_signature(scene))
        reordered = {**scene, "zones": list(reversed(scene["zones"]))}
        self.assertEqual(scene_geometry_signature(scene), scene_geometry_signature(reordered))

    def test_tracker_keeps_id_across_small_motion_and_expires_lost_track(self):
        tracker = IoUTracker(max_missed=1)
        first = tracker.update([{"bboxXYXY": (0.1, 0.1, 0.2, 0.2), "class": "car", "confidence": 0.9}])
        second = tracker.update([{"bboxXYXY": (0.11, 0.1, 0.21, 0.2), "class": "car", "confidence": 0.7}])
        self.assertEqual(first[0]["trackId"], second[0]["trackId"])
        tracker.update([])
        tracker.update([])
        self.assertNotIn(first[0]["trackId"], tracker.tracks)

    def test_low_confidence_detection_recovers_track_but_does_not_start_one(self):
        tracker = IoUTracker()
        self.assertEqual([], tracker.update([{"bboxXYXY": (0.1, 0.1, 0.2, 0.2), "class": "car", "confidence": 0.2}]))
        track = tracker.update([{"bboxXYXY": (0.1, 0.1, 0.2, 0.2), "class": "car", "confidence": 0.8}])[0]
        recovered = tracker.update([{"bboxXYXY": (0.105, 0.1, 0.205, 0.2), "class": "car", "confidence": 0.18}])[0]
        self.assertEqual(track["trackId"], recovered["trackId"])

    def test_tracker_does_not_reassign_a_track_to_a_distant_same_class_vehicle(self):
        tracker = IoUTracker()
        first = tracker.update([{"bboxXYXY": (0.1, 0.4, 0.12, 0.42), "class": "car", "confidence": 0.8}])[0]
        second = tracker.update([{"bboxXYXY": (0.2, 0.4, 0.22, 0.42), "class": "car", "confidence": 0.8}])[0]
        self.assertNotEqual(first["trackId"], second["trackId"])

    def test_tracker_preserves_vehicle_identity_through_high_overlap_class_flicker(self):
        tracker = IoUTracker()
        box = (0.31, 0.52, 0.43, 0.66)
        first_input = {"bboxXYXY": box, "class": "car", "confidence": 0.92,
                       "color": "white", "colorMethod": "hsv_estimate"}
        second_input = {"bboxXYXY": box, "class": "truck", "confidence": 0.89,
                        "color": "white", "colorMethod": "hsv_estimate"}
        first_snapshot, second_snapshot = dict(first_input), dict(second_input)
        first = tracker.update([first_input],
                               source_time_ms=1000, max_age_ms=6000)[0]
        flicker = tracker.update([second_input],
                                 source_time_ms=1500, max_age_ms=6000)[0]
        restored = tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}],
                                  source_time_ms=2000, max_age_ms=6000)[0]
        self.assertEqual(first["trackId"], flicker["trackId"])
        self.assertEqual(first["trackId"], restored["trackId"])
        self.assertEqual("truck", flicker["class"])
        self.assertEqual("car", tracker.tracks[first["trackId"]].class_name)
        self.assertEqual(first_snapshot, first_input)
        self.assertEqual(second_snapshot, second_input)
        for key in ("bboxXYXY", "class", "confidence", "color", "colorMethod"):
            self.assertEqual(first_input[key], first[key])
            self.assertEqual(second_input[key], flicker[key])

    def test_tracker_class_flicker_recovery_rejects_nonvehicles_and_weak_confidence(self):
        box = (0.31, 0.52, 0.43, 0.66)
        nonvehicle_tracker = IoUTracker()
        person = nonvehicle_tracker.update([{"bboxXYXY": box, "class": "person", "confidence": 0.92}])[0]
        car = nonvehicle_tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}])[0]
        self.assertNotEqual(person["trackId"], car["trackId"])

        weak_tracker = IoUTracker()
        first = weak_tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.92}])[0]
        weak = weak_tracker.update([{"bboxXYXY": box, "class": "truck", "confidence": 0.49}])[0]
        self.assertNotEqual(first["trackId"], weak["trackId"])

    def test_tracker_keeps_neighboring_vehicle_ids_at_their_boxes_when_labels_swap(self):
        tracker = IoUTracker()
        left = (0.30, 0.52, 0.42, 0.66)
        right = (0.43, 0.52, 0.55, 0.66)
        first = tracker.update([
            {"bboxXYXY": left, "class": "car", "confidence": 0.9},
            {"bboxXYXY": right, "class": "truck", "confidence": 0.88},
        ], source_time_ms=1000, max_age_ms=6000)
        left_id = next(item["trackId"] for item in first if item["bboxXYXY"] == left)
        right_id = next(item["trackId"] for item in first if item["bboxXYXY"] == right)
        swapped_labels = tracker.update([
            {"bboxXYXY": left, "class": "truck", "confidence": 0.89},
            {"bboxXYXY": right, "class": "car", "confidence": 0.87},
        ], source_time_ms=1500, max_age_ms=6000)
        self.assertEqual(2, len(swapped_labels))
        self.assertEqual(left_id, next(item["trackId"] for item in swapped_labels if item["bboxXYXY"] == left))
        self.assertEqual(right_id, next(item["trackId"] for item in swapped_labels if item["bboxXYXY"] == right))
        self.assertEqual({"car", "truck"}, {item["class"] for item in swapped_labels})

    def test_tracker_expires_by_source_time_and_never_reuses_ids(self):
        tracker = IoUTracker()
        box = (0.2, 0.2, 0.3, 0.3)
        first = tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}],
                               source_time_ms=1000, max_age_ms=2000)[0]
        tracker.update([], source_time_ms=3501, max_age_ms=2000)
        self.assertNotIn(first["trackId"], tracker.tracks)
        next_track = tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}],
                                    source_time_ms=4000, max_age_ms=2000)[0]
        self.assertGreater(next_track["trackId"], first["trackId"])

    def test_tracker_clock_reset_clears_tracks_but_keeps_ids_monotonic(self):
        tracker = IoUTracker()
        box = (0.2, 0.2, 0.3, 0.3)
        first = tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}],
                               source_time_ms=4000)[0]
        second = tracker.update([{"bboxXYXY": box, "class": "car", "confidence": 0.9}],
                                source_time_ms=0)[0]
        self.assertNotEqual(first["trackId"], second["trackId"])
        self.assertNotIn(first["trackId"], tracker.tracks)

    def test_tracker_uses_bottom_center_for_stationary_motion_prediction(self):
        tracker = IoUTracker()
        vehicle = {"bboxXYXY": (0.4, 0.4, 0.6, 0.8), "class": "car", "confidence": 0.9}
        track_id = tracker.update([vehicle])[0]["trackId"]
        tracker.update([vehicle])  # A stationary observation must record zero motion.
        false_upward_match = {**vehicle, "bboxXYXY": (0.4, 0.2, 0.6, 0.6)}
        tracked = tracker.update([vehicle, false_upward_match])
        self.assertEqual(vehicle["bboxXYXY"], next(x["bboxXYXY"] for x in tracked if x["trackId"] == track_id))

    def test_tracker_predicts_motion_from_bottom_center(self):
        tracker = IoUTracker()
        first = {"bboxXYXY": (0.4, 0.3, 0.6, 0.7), "class": "car", "confidence": 0.9}
        second = {**first, "bboxXYXY": (0.4, 0.38, 0.6, 0.78)}
        third = {**first, "bboxXYXY": (0.4, 0.46, 0.6, 0.86)}
        track_id = tracker.update([first])[0]["trackId"]
        tracker.update([second])
        false_motion_match = {**first, "bboxXYXY": (0.4, 0.26, 0.6, 0.66)}
        tracked = tracker.update([third, false_motion_match])
        self.assertEqual(third["bboxXYXY"], next(x["bboxXYXY"] for x in tracked if x["trackId"] == track_id))

    def test_crossing_emits_once_per_hysteresis_transition(self):
        track = Track(4, (0.4, 0.55, 0.6, 0.75), "car", 0.9)
        tracks = {4: track}
        scene = {"countingLines": [{"id": "road", "start": {"x": 0.2, "y": 0.5}, "end": {"x": 0.8, "y": 0.5}, "directionLabels": ["north", "south"]}]}
        self.assertEqual([], line_crossings(tracks, scene))
        track.previous_center = (0.5, 0.65)
        track.bbox = (0.4, 0.25, 0.6, 0.35)
        self.assertEqual([{"lineId": "road", "direction": "south", "trackId": 4}], line_crossings(tracks, scene))
        self.assertEqual([], line_crossings(tracks, scene))

    def test_crossing_hysteresis_handles_both_directions_and_deadband_jitter(self):
        line = {"id": "road", "start": {"x": 0.2, "y": 0.5}, "end": {"x": 0.8, "y": 0.5}, "directionLabels": ["down", "up"]}
        scene = {"countingLines": [line]}
        track = Track(9, (0.45, 0.60, 0.55, 0.70), "car", 0.9)
        tracks = {9: track}
        self.assertEqual([], line_crossings(tracks, scene))  # Establish positive side.
        track.previous_center = (0.5, 0.65)
        track.bbox = (0.45, 0.495, 0.55, 0.505)  # Deadband does not flip the stable side.
        self.assertEqual([], line_crossings(tracks, scene))
        track.previous_center = (0.5, 0.5)
        track.bbox = (0.45, 0.30, 0.55, 0.40)
        self.assertEqual("up", line_crossings(tracks, scene)[0]["direction"])
        self.assertEqual([], line_crossings(tracks, scene))  # Same transition is idempotent.
        track.previous_center = (0.5, 0.35)
        track.bbox = (0.45, 0.60, 0.55, 0.70)
        self.assertEqual("down", line_crossings(tracks, scene)[0]["direction"])

    def test_crossing_ignores_intersection_outside_line_segment(self):
        track = Track(2, (0.9, 0.4, 1.0, 0.5), "car", 0.9, previous_center=(0.95, 0.6), line_sides={"short": -1})
        scene = {"countingLines": [{"id": "short", "start": {"x": 0.2, "y": 0.5}, "end": {"x": 0.8, "y": 0.5}}]}
        self.assertEqual([], line_crossings({2: track}, scene))

    def test_point_in_polygon(self):
        square = [{"x": 0.2, "y": 0.2}, {"x": 0.8, "y": 0.2}, {"x": 0.8, "y": 0.8}, {"x": 0.2, "y": 0.8}]
        self.assertTrue(point_in_polygon((0.5, 0.5), square))
        self.assertFalse(point_in_polygon((0.9, 0.5), square))

    def test_trackers_are_isolated_per_session(self):
        a, b = IoUTracker(), IoUTracker()
        det = {"bboxXYXY": (0.1, 0.1, 0.2, 0.2), "class": "car", "confidence": 0.9}
        a.update([det])
        self.assertEqual({}, b.tracks)
        self.assertEqual(1, b.update([det])[0]["trackId"])
        self.assertEqual(2, a.next_id)

    def test_resize_padding_is_removed_before_normalizing_box(self):
        box = model_box_to_normalized((160, 230, 480, 320), 1280, 720, 0.5, 0, 140)
        self.assertEqual((0.25, 0.25, 0.75, 0.5), box)

    def test_line_rois_are_clipped_bounded_and_remap_to_full_frame(self):
        scene = {"countingLines": [
            {"start": {"x": 0.2, "y": 0.4}, "end": {"x": 0.4, "y": 0.5}},
            {"start": {"x": 0.8, "y": 0.7}, "end": {"x": 0.9, "y": 0.8}},
        ]}
        regions = line_roi_rectangles(scene, 1000, 500, margin=0.12)
        self.assertEqual([(80, 140, 520, 310), (680, 290, 1000, 460)], regions)
        original = [{"bboxXYXY": (0.25, 0.2, 0.75, 0.8), "class": "car", "confidence": 0.8}]
        remapped = remap_crop_detections(original, regions[0], 1000, 500)
        self.assertEqual((0.19, 0.348, 0.41, 0.552), tuple(round(v, 3) for v in remapped[0]["bboxXYXY"]))

    def test_full_frame_tiles_cover_4k_edges_with_expected_overlap_and_bounds(self):
        tiles = frame_tile_rectangles(3840, 2160)
        self.assertEqual([
            (0, 0, 1408, 1188), (1216, 0, 2624, 1188), (2432, 0, 3840, 1188),
            (0, 972, 1408, 2160), (1216, 972, 2624, 2160), (2432, 972, 3840, 2160),
        ], tiles)
        for x in range(3840):
            self.assertTrue(any(x1 <= x < x2 for x1, _, x2, _ in tiles))
        for y in range(2160):
            self.assertTrue(any(y1 <= y < y2 for _, y1, _, y2 in tiles))

    def test_auto_4k_mode_runs_tiles_coarse_gates_and_bounded_split_fine_gates(self):
        class ImageView:
            def __init__(self, width, height):
                self.shape = (height, width, 3)

            def __getitem__(self, slices):
                y_slice, x_slice = slices
                return ImageView(x_slice.stop - x_slice.start, y_slice.stop - y_slice.start)

        class FakeDetector:
            iou_threshold = 0.45

            def __init__(self):
                self.shapes = []

            def infer(self, image):
                self.shapes.append(image.shape[:2])
                return []

        scene = {"countingLines": [
            {"id": "north", "start": {"x": 0.5226903308, "y": 0.6393074840}, "end": {"x": 0.6474872397, "y": 0.6645189808}},
            {"id": "south", "start": {"x": 0.3496764344, "y": 0.5989690892}, "end": {"x": 0.2589150462, "y": 0.5283768983}},
        ]}
        detector = FakeDetector()
        _, mode, region_count = OnnxYolo.infer_scene(detector, ImageView(3840, 2160), scene, "auto", 0.12)
        self.assertEqual("full_frame_tiled_with_line_detail", mode)
        self.assertEqual(12, region_count)
        self.assertEqual(12, len(detector.shapes))
        self.assertEqual([(1188, 1408)] * 6, detector.shapes[:6])
        self.assertEqual([(272, 640), (272, 640), (369, 640), (369, 640)], detector.shapes[-4:])

    def test_yolo26_anchor_probe_adds_one_region_only_for_suspicious_large_tile_boxes(self):
        fixture = json.loads((Path(__file__).parent / "fixtures" / "screenshot-bus-anchor.json").read_text(encoding="utf-8"))
        frame_width, frame_height = fixture["frame"]

        class ImageView:
            def __init__(self, width, height):
                self.shape = (height, width, 3)

            def __getitem__(self, slices):
                ys, xs = slices
                return ImageView(xs.stop - xs.start, ys.stop - ys.start)

        class FakeYolo26:
            backend = "yolo26"
            iou_threshold = 0.45

            def __init__(self):
                self.calls = 0

            def infer(self, image):
                call = self.calls
                self.calls += 1
                if image.shape[:2] == (frame_height, frame_width):
                    return [{key: value for key, value in fixture["fullFrameAnchor"].items()
                             if not key.startswith("_")}]
                rect = fixture["tileRects"][call]
                x1, y1, x2, y2 = rect
                result = []
                for item in fixture["tileDetections"]:
                    if item["_tileIndex"] != call:
                        continue
                    bx1, by1, bx2, by2 = item["bboxXYXY"]
                    result.append({"bboxXYXY": ((bx1 * frame_width - x1) / (x2 - x1),
                                                 (by1 * frame_height - y1) / (y2 - y1),
                                                 (bx2 * frame_width - x1) / (x2 - x1),
                                                 (by2 * frame_height - y1) / (y2 - y1)),
                                   "class": item["class"], "confidence": item["confidence"]})
                return result

        detector = FakeYolo26()
        detections, mode, region_count = OnnxYolo.infer_scene(
            detector, ImageView(frame_width, frame_height), {}, "tiled", 0.12)
        self.assertEqual("full_frame_tiled_with_large_vehicle_anchor", mode)
        self.assertEqual(5, region_count)
        self.assertEqual(5, detector.calls)
        self.assertEqual(1, len(detections))
        self.assertEqual("bus", detections[0]["class"])

        class SmallYolo26(FakeYolo26):
            def infer(self, image):
                self.calls += 1
                return [{"bboxXYXY": (0.1, 0.2, 0.2, 0.3), "class": "car", "confidence": 0.8}]

        ordinary = SmallYolo26()
        _, ordinary_mode, ordinary_regions = OnnxYolo.infer_scene(
            ordinary, ImageView(frame_width, frame_height), {}, "tiled", 0.12)
        self.assertEqual("full_frame_tiled", ordinary_mode)
        self.assertEqual(4, ordinary_regions)
        self.assertEqual(4, ordinary.calls)

    def test_split_roi_patches_overlap_preserve_each_region_and_obey_global_budget(self):
        regions = [(0, 0, 1400, 300), (100, 500, 900, 900)]
        patches = split_roi_rectangles(regions, maximum_dimension=640, overlap=0.20, maximum_patches=5)
        self.assertEqual(5, len(patches))
        self.assertTrue(all((x2 - x1) <= 640 and (y2 - y1) <= 640 for x1, y1, x2, y2 in patches))
        self.assertTrue(any(x1 == 0 and x2 == 640 for x1, _, x2, _ in patches))
        self.assertTrue(any(y1 == 500 for _, y1, _, _ in patches))
        capped = split_roi_rectangles(regions, maximum_dimension=640, maximum_patches=4)
        self.assertEqual(regions[1], capped[-1])
        eight_regions = [(index * 1000, 0, index * 1000 + (1400 if index == 0 else 300), 300)
                         for index in range(8)]
        bounded = split_roi_rectangles(eight_regions, maximum_dimension=640, maximum_patches=8)
        self.assertEqual(8, len(bounded))
        for region in eight_regions:
            self.assertTrue(any(x1 <= region[0] and x2 >= region[2] and
                                y1 <= region[1] and y2 >= region[3]
                                for x1, y1, x2, y2 in bounded))
        with self.assertRaises(ValueError):
            split_roi_rectangles(regions, maximum_patches=1)

    def test_overlapping_tile_remap_deduplicates_same_class_but_keeps_other_class(self):
        left = remap_crop_detections(
            [{"bboxXYXY": (0.8, 0.2, 1.0, 0.5), "class": "car", "confidence": 0.7}],
            (0, 0, 100, 100), 200, 100)
        right = remap_crop_detections(
            [{"bboxXYXY": (0.0, 0.2, 0.2, 0.5), "class": "car", "confidence": 0.9},
             {"bboxXYXY": (0.0, 0.2, 0.2, 0.5), "class": "truck", "confidence": 0.6}],
            (80, 0, 180, 100), 200, 100)
        result = deduplicate_detections([*left, *right])
        self.assertEqual(["car", "truck"], [item["class"] for item in result])
        self.assertAlmostEqual(0.4, result[0]["bboxXYXY"][0])

    def test_complementary_frame_tile_edge_fragments_merge_below_global_iou_without_leaking_metadata(self):
        frame_width, frame_height = 1920, 1080
        left_rect, right_rect = (0, 0, 1056, 594), (864, 0, 1920, 594)
        left = remap_crop_detections(
            [{"bboxXYXY": (393 / 1056, 421 / 594, 1.0, 552 / 594), "class": "car", "confidence": 0.80}],
            left_rect, frame_width, frame_height)
        right = remap_crop_detections(
            [{"bboxXYXY": (0.0, 421 / 594, (1171 - 864) / (1920 - 864), 552 / 594), "class": "car", "confidence": 0.76}],
            right_rect, frame_width, frame_height)
        tiled = [*attach_frame_tile_provenance(left, left_rect, frame_width, frame_height, 0),
                 *attach_frame_tile_provenance(right, right_rect, frame_width, frame_height, 1)]
        self.assertLess(bbox_iou(tuple(tiled[0]["bboxXYXY"]), tuple(tiled[1]["bboxXYXY"])), 0.45)
        result = deduplicate_detections(tiled)
        self.assertEqual(1, len(result))
        expected = (393 / frame_width, 421 / frame_height, 1171 / frame_width, 552 / frame_height)
        for actual, target in zip(result[0]["bboxXYXY"], expected):
            self.assertAlmostEqual(target, actual)
        self.assertFalse(any(key.startswith("_tile") for key in result[0]))

    def test_seam_rule_keeps_adjacent_nonedge_occluded_and_unrelated_tile_vehicles(self):
        frame_width, frame_height = 1920, 1080
        left_rect, right_rect = (0, 0, 1056, 594), (864, 0, 1920, 594)
        # Opposing crop edges alone are insufficient when the mapped boxes only touch slightly.
        adjacent = [
            {"bboxXYXY": (0.30, 0.40, 0.55, 0.52), "class": "car", "confidence": 0.9, "_tileIndex": 0, "_tileFrame": True, "_tileRect": left_rect, "_tileEdges": frozenset({"right"})},
            {"bboxXYXY": (0.50, 0.40, 0.72, 0.52), "class": "car", "confidence": 0.8, "_tileIndex": 1, "_tileFrame": True, "_tileRect": right_rect, "_tileEdges": frozenset({"left"})},
        ]
        self.assertEqual(2, len(deduplicate_detections(adjacent)))
        # Full detections from two unrelated crops must not be reconciled by crop index alone.
        nonedge = [
            {"bboxXYXY": (0.40, 0.40, 0.60, 0.56), "class": "car", "confidence": 0.9, "_tileIndex": 2, "_tileFrame": True, "_tileRect": left_rect, "_tileEdges": frozenset()},
            {"bboxXYXY": (0.41, 0.40, 0.61, 0.56), "class": "car", "confidence": 0.8, "_tileIndex": 3, "_tileFrame": True, "_tileRect": (400, 0, 1456, 594), "_tileEdges": frozenset()},
        ]
        self.assertEqual(1, len(deduplicate_detections(nonedge)))  # ordinary high-IoU behavior remains
        # Overlapping detections from one crop can represent occlusion; the seam path never applies.
        same_tile = [
            {"bboxXYXY": (0.40, 0.40, 0.64, 0.60), "class": "car", "confidence": 0.9, "_tileIndex": 4, "_tileFrame": True, "_tileRect": left_rect, "_tileEdges": frozenset({"right"})},
            {"bboxXYXY": (0.47, 0.40, 0.64, 0.60), "class": "car", "confidence": 0.7, "_tileIndex": 4, "_tileFrame": True, "_tileRect": left_rect, "_tileEdges": frozenset({"right"})},
        ]
        self.assertEqual(1, len(deduplicate_detections(same_tile)))  # unchanged global IoU rule

    def test_historical_frame_seam_fragments_merge_and_adjacent_vehicle_remains(self):
        fixture_path = Path(__file__).parent / "fixtures" / "historical-seam-event.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        frame_width, frame_height = fixture["frame"]
        tiles = frame_tile_rectangles(frame_width, frame_height)
        self.assertEqual([(0, 0, 1056, 594), (864, 0, 1920, 594),
                          (0, 486, 1056, 1080), (864, 486, 1920, 1080)], tiles)
        by_id = {item["trackId"]: item for item in fixture["detections"]}

        def mapped_with_tile(track_id, tile_index):
            item = by_id[track_id]
            box = item["bboxNormalized"]
            detection = {"bboxXYXY": (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"]),
                         "class": item["class"], "confidence": item["confidence"], "trackId": item["trackId"]}
            return attach_frame_tile_provenance([detection], tiles[tile_index], frame_width, frame_height, tile_index)[0]

        left_fragment = mapped_with_tile("128", 2)
        right_fragment = mapped_with_tile("123", 3)
        adjacent_vehicle = mapped_with_tile("129", 2)
        self.assertAlmostEqual(0.43330816997, bbox_iou(left_fragment["bboxXYXY"], right_fragment["bboxXYXY"]), places=8)
        self.assertIn("right", left_fragment["_tileEdges"])
        self.assertIn("left", right_fragment["_tileEdges"])
        result = deduplicate_detections([left_fragment, right_fragment, adjacent_vehicle])
        self.assertEqual(2, len(result))
        merged = next(item for item in result if item["trackId"] == "128")
        self.assertEqual("129", next(item for item in result if item["trackId"] != "128")["trackId"])
        self.assertAlmostEqual(by_id["128"]["bboxNormalized"]["x"], merged["bboxXYXY"][0])
        self.assertAlmostEqual(by_id["123"]["bboxNormalized"]["x"] + by_id["123"]["bboxNormalized"]["width"], merged["bboxXYXY"][2])

    def test_vertical_tile_seam_fragments_are_reconciled(self):
        frame_width = frame_height = 1000
        top_rect, bottom_rect = (0, 0, 600, 600), (0, 400, 600, 1000)
        top = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.3, 0.1, 0.5, 0.6), "class": "car", "confidence": 0.8}],
            top_rect, frame_width, frame_height, 0)
        bottom = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.3, 0.4, 0.5, 0.9), "class": "car", "confidence": 0.7}],
            bottom_rect, frame_width, frame_height, 1)
        self.assertLess(bbox_iou(top[0]["bboxXYXY"], bottom[0]["bboxXYXY"]), 0.45)
        result = deduplicate_detections([*top, *bottom])
        self.assertEqual(1, len(result))
        self.assertEqual((0.3, 0.1, 0.5, 0.9), result[0]["bboxXYXY"])

    def test_strict_crossclass_crop_edge_fragment_prefers_full_vehicle_box(self):
        frame_width, frame_height = 1920, 1080
        left_rect, right_rect = (0, 486, 1056, 1080), (864, 486, 1920, 1080)
        partial_car = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.497, 0.597, 0.55, 0.730), "class": "car", "confidence": 0.782}],
            left_rect, frame_width, frame_height, 2)
        full_truck = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.497, 0.571, 0.642, 0.733), "class": "truck", "confidence": 0.936}],
            right_rect, frame_width, frame_height, 3)
        self.assertIn("right", partial_car[0]["_tileEdges"])
        self.assertFalse(full_truck[0]["_tileEdges"])
        result = deduplicate_detections([*partial_car, *full_truck])
        self.assertEqual(1, len(result))
        self.assertEqual("truck", result[0]["class"])
        self.assertEqual((0.497, 0.571, 0.642, 0.733), result[0]["bboxXYXY"])

        # A pair that barely extends past the crop boundary is too ambiguous to merge.
        ambiguous_truck = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.495, 0.571, 0.56, 0.733), "class": "truck", "confidence": 0.936}],
            right_rect, frame_width, frame_height, 3)
        self.assertEqual(2, len(deduplicate_detections([*partial_car, *ambiguous_truck])))
        # High containment without crop-edge provenance remains under the existing conservative rule.
        unproven_car = [{key: value for key, value in partial_car[0].items() if key != "_tileEdges"}]
        unproven_car[0]["_tileEdges"] = frozenset()
        self.assertEqual(2, len(deduplicate_detections([*unproven_car, *full_truck])))

    def test_current_preview_pickup_pair_and_nonvehicle_edge_control(self):
        fixture_path = Path(__file__).parent / "fixtures" / "current-preview-pair.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        frame_width, frame_height = fixture["frame"]
        partial_car, full_truck = [] , []
        for item in fixture["detections"]:
            detection = {"bboxXYXY": tuple(item["bboxXYXY"]), "class": item["class"],
                         "confidence": item["confidence"], "trackId": item["trackId"]}
            mapped = attach_frame_tile_provenance(
                [detection], tuple(fixture["tileRects"][item["tileIndex"]]),
                frame_width, frame_height, item["tileIndex"])[0]
            if item["trackId"] == "146":
                partial_car.append(mapped)
            else:
                full_truck.append(mapped)
        self.assertIn("right", partial_car[0]["_tileEdges"])
        self.assertFalse(full_truck[0]["_tileEdges"])
        result = deduplicate_detections([*partial_car, *full_truck])
        self.assertEqual(1, len(result))
        self.assertEqual("138", result[0]["trackId"])
        self.assertEqual((0.497, 0.571, 0.642, 0.733), result[0]["bboxXYXY"])

        # The same crop-edge shape on a nonvehicle class must not suppress a vehicle detection.
        person_fragment = [{**partial_car[0], "class": "person", "trackId": "person-1"}]
        self.assertEqual(2, len(deduplicate_detections([*person_fragment, *full_truck])))

        # A barely extending ambiguous box remains separate; it is not labeled as ground truth.
        ambiguous_truck = attach_frame_tile_provenance(
            [{"bboxXYXY": (0.495, 0.571, 0.56, 0.733), "class": "truck", "confidence": 0.936}],
            tuple(fixture["tileRects"][1]), frame_width, frame_height, 1)
        self.assertEqual(2, len(deduplicate_detections([*partial_car, *ambiguous_truck])))

    def test_large_vehicle_anchor_reconciles_screenshot_bus_but_rejects_ambiguous_fragments(self):
        fixture_path = Path(__file__).parent / "fixtures" / "screenshot-bus-anchor.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        frame_width, frame_height = fixture["frame"]
        fragments = [{**item, "bboxXYXY": tuple(item["bboxXYXY"]),
                      "_tileRect": tuple(item["_tileRect"]),
                      "_tileEdges": frozenset(item["_tileEdges"])}
                     for item in fixture["tileDetections"]]
        anchor = {**fixture["fullFrameAnchor"], "bboxXYXY": tuple(fixture["fullFrameAnchor"]["bboxXYXY"])}
        self.assertTrue(has_large_vehicle_tile_fragments(fragments))
        raw_before = copy.deepcopy(fragments)
        reconciled, used = reconcile_large_vehicle_tile_fragments(
            fragments, [anchor], frame_width, frame_height)
        self.assertTrue(used)
        self.assertEqual(1, len(reconciled))
        result = deduplicate_detections(reconciled)
        self.assertEqual(1, len(result))
        self.assertEqual("bus", result[0]["class"])
        self.assertGreater(result[0]["bboxXYXY"][0], anchor["bboxXYXY"][0] - 0.06)
        self.assertGreater(result[0]["bboxXYXY"][2], anchor["bboxXYXY"][2])
        self.assertFalse(any(key.startswith("_") for key in result[0]))
        self.assertEqual(raw_before, fragments)

        # The saved screenshot event has two bus labels plus a truck label on
        # the right crop. Only the truck's complementary left edge bridges it
        # to the anchor; interior class disagreement is never enough.
        event_rects = frame_tile_rectangles(frame_width, frame_height)
        persisted_boxes = [
            ("25", "bus", (0.022418, 0.562407, 0.348839, 0.984288), 2),
            ("37", "bus", (0.236769, 0.560508, 0.543259, 0.996936), 2),
            ("23", "truck", (0.450652, 0.546089, 0.6010005, 0.9893868), 3),
        ]
        persisted_fragments = []
        for track_id, label, box, tile_index in persisted_boxes:
            persisted_fragments.extend(attach_frame_tile_provenance(
                [{"trackId": track_id, "class": label, "confidence": 0.8, "bboxXYXY": box}],
                event_rects[tile_index], frame_width, frame_height, tile_index))
        event_reconciled, event_used = reconcile_large_vehicle_tile_fragments(
            persisted_fragments, [anchor], frame_width, frame_height)
        self.assertTrue(event_used)
        self.assertEqual(1, len(event_reconciled))
        self.assertEqual("bus", event_reconciled[0]["class"])
        self.assertAlmostEqual(0.6010005, event_reconciled[0]["bboxXYXY"][2])
        tracked_event = IoUTracker().update(deduplicate_detections(event_reconciled))
        self.assertEqual(1, len(tracked_event))
        self.assertEqual(1, len({item["trackId"] for item in tracked_event}))

        def tagged(box, tile, label="bus", edges=()):
            rects = frame_tile_rectangles(frame_width, frame_height)
            return {"bboxXYXY": box, "class": label, "confidence": 0.75,
                    "_tileIndex": tile, "_tileFrame": True,
                    "_tileRect": rects[tile], "_tileEdges": frozenset(edges)}

        # One broad anchor must not collapse two distinct non-overlapping heavy vehicles,
        # even if each independently has high anchor coverage.
        broad_anchor = {"bboxXYXY": (0.08, 0.50, 0.92, 0.99), "class": "bus", "confidence": 0.9}
        separated = [tagged((0.14, 0.55, 0.42, 0.96), 2),
                     tagged((0.57, 0.55, 0.85, 0.96), 3)]
        separated_before = copy.deepcopy(separated)
        kept, used = reconcile_large_vehicle_tile_fragments(separated, [broad_anchor], frame_width, frame_height)
        self.assertFalse(used)
        self.assertEqual(2, len(kept))
        self.assertEqual(separated_before, separated)

        # Even strongly overlapping boxes are not collapsed by a broad anchor
        # when they lack any crop-seam continuation evidence.
        overlapping_distinct = [tagged((0.12, 0.55, 0.58, 0.97), 2),
                                tagged((0.42, 0.55, 0.88, 0.97), 3)]
        overlap_before = copy.deepcopy(overlapping_distinct)
        self.assertFalse(reconcile_large_vehicle_tile_fragments(
            overlapping_distinct, [broad_anchor], frame_width, frame_height)[1])
        self.assertEqual(overlap_before, overlapping_distinct)

        # A realistic adjacent/occluded pair can overlap by more than the
        # compatibility threshold; one crop edge and one broad anchor still
        # do not justify collapsing only two boxes.
        moderate_anchor = {"bboxXYXY": (0.20, 0.50, 0.80, 0.99), "class": "bus", "confidence": 0.9}
        edge_bus = tagged((0.20, 0.55, 0.55, 0.97), 2, edges=("right",))
        overlapping_bus = tagged((0.40, 0.55, 0.75, 0.97), 3)
        same_class_convoy = [edge_bus, overlapping_bus]
        self.assertGreater((0.55 - 0.40) / (0.75 - 0.40), 0.34)
        self.assertFalse(reconcile_large_vehicle_tile_fragments(
            same_class_convoy, [moderate_anchor], frame_width, frame_height)[1])

        # A cross-class box inside an anchor is not an interior match; class disagreement
        # is eligible only when the fragment proves it continues across a crop seam.
        interior_truck = tagged((0.18, 0.57, 0.46, 0.95), 2, label="truck")
        self.assertIsNone(__import__("vision_core")._large_tile_fragment_anchor_score(
            interior_truck, broad_anchor, frame_width, frame_height))

        # Two near-identical full-frame anchors make assignment ambiguous, so nothing is consumed.
        ambiguous_anchors = [anchor, {**anchor, "bboxXYXY": (anchor["bboxXYXY"][0] + 0.001,
                                                                 anchor["bboxXYXY"][1],
                                                                 anchor["bboxXYXY"][2] - 0.001,
                                                                 anchor["bboxXYXY"][3])}]
        ambiguous, used = reconcile_large_vehicle_tile_fragments(fragments, ambiguous_anchors,
                                                                  frame_width, frame_height)
        self.assertFalse(used)
        self.assertEqual(len(fragments), len(ambiguous))

        # Nearby large vehicles without positive seam evidence stay separate even when
        # their boxes overlap modestly and share an anchor candidate.
        convoy = [tagged((0.24, 0.55, 0.58, 0.97), 2),
                  tagged((0.49, 0.55, 0.82, 0.97), 3)]
        self.assertFalse(reconcile_large_vehicle_tile_fragments(convoy, [broad_anchor],
                                                                 frame_width, frame_height)[1])
        self.assertFalse(has_large_vehicle_tile_fragments([
            tagged((0.10, 0.10, 0.30, 0.40), 0),
            tagged((0.20, 0.20, 0.40, 0.49), 1)]))

    def test_tile_dedup_reconciles_identical_cross_class_overlap_only_across_tiles(self):
        duplicate = [
            {"bboxXYXY": (0.2, 0.2, 0.4, 0.5), "class": "car", "confidence": 0.8, "_tileIndex": 0},
            {"bboxXYXY": (0.2, 0.2, 0.4, 0.5), "class": "truck", "confidence": 0.7, "_tileIndex": 1},
        ]
        self.assertEqual(["car"], [item["class"] for item in deduplicate_detections(duplicate)])
        partially_overlapping = [
            {"bboxXYXY": (0.2, 0.2, 0.4, 0.5), "class": "car", "confidence": 0.8, "_tileIndex": 0},
            {"bboxXYXY": (0.225, 0.2, 0.425, 0.5), "class": "truck", "confidence": 0.7, "_tileIndex": 1},
        ]
        self.assertEqual(2, len(deduplicate_detections(partially_overlapping)))
        same_tile_occlusion = [
            {"bboxXYXY": (0.2, 0.2, 0.4, 0.5), "class": "car", "confidence": 0.8, "_tileIndex": 0},
            {"bboxXYXY": (0.2, 0.2, 0.4, 0.5), "class": "truck", "confidence": 0.7, "_tileIndex": 0},
        ]
        self.assertEqual(2, len(deduplicate_detections(same_tile_occlusion)))
        near_identical_cross_tile = [
            {"bboxXYXY": (0.22488, 0.58977, 0.24629, 0.62222), "class": "car", "confidence": 0.3262, "_tileIndex": 6},
            {"bboxXYXY": (0.22468, 0.58878, 0.24653, 0.62040), "class": "truck", "confidence": 0.2695, "_tileIndex": 3},
        ]
        self.assertEqual(1, len(deduplicate_detections(near_identical_cross_tile)))

    def test_overlapping_roi_detections_are_suppressed_once(self):
        detections = [
            {"bboxXYXY": (0.1, 0.1, 0.3, 0.3), "class": "car", "confidence": 0.7},
            {"bboxXYXY": (0.11, 0.1, 0.31, 0.3), "class": "car", "confidence": 0.9},
            {"bboxXYXY": (0.6, 0.6, 0.8, 0.8), "class": "truck", "confidence": 0.8},
        ]
        result = deduplicate_detections(detections)
        self.assertEqual(2, len(result))
        self.assertEqual(0.9, result[0]["confidence"])

    def test_vehicle_crossing_uses_bottom_edge_footpoint(self):
        self.assertEqual((0.5, 0.9), footpoint((0.4, 0.2, 0.6, 0.9)))

    def test_recent_same_vehicle_recross_is_suppressed_per_line_and_clock_reset_clears_it(self):
        last = {}
        event = {"lineId": "north", "direction": "A to B", "trackId": 7}
        self.assertEqual([event], suppress_recent_recrossings([event], last, 5000))
        reverse = {**event, "direction": "B to A"}
        self.assertEqual([], suppress_recent_recrossings([reverse], last, 6000))
        self.assertEqual([reverse], suppress_recent_recrossings([reverse], last, 0))

    def test_color_falls_back_to_unknown_without_a_usable_frame(self):
        self.assertEqual({"name": "unknown", "supportRatio": 0.0}, vehicle_color(None, (0, 0, 1, 1)))

    def test_vehicle_color_keeps_neutral_white_gray_black_and_chromatic_body_pixels(self):
        import numpy as np

        def image_with_body(color):
            image = np.full((100, 100, 3), 128, dtype=np.uint8)  # neutral road/background
            image[30:78, 20:80] = color  # vehicle roof/body inside the estimator's inner crop
            return image

        cases = [((245, 245, 245), "white"), ((120, 120, 120), "gray"),
                 ((25, 25, 25), "black"), ((0, 0, 220), "red"), ((220, 0, 0), "blue")]
        for color, expected in cases:
            with self.subTest(expected=expected):
                result = vehicle_color(image_with_body(color), (0, 0, 1, 1))
                self.assertEqual(expected, result["name"])
                self.assertGreaterEqual(result["supportRatio"], 0.55)

    def test_vehicle_color_is_stable_under_small_sensor_noise_for_neutral_and_chromatic_paint(self):
        import numpy as np

        rng = np.random.default_rng(42)
        for base, expected in [((245, 245, 245), "white"), ((120, 120, 120), "gray"),
                               ((25, 25, 25), "black"), ((0, 0, 220), "red"),
                               ((220, 0, 0), "blue")]:
            with self.subTest(expected=expected):
                image = np.full((100, 100, 3), 128, dtype=np.uint8)
                patch = np.full((48, 60, 3), base, dtype=np.int16)
                noise = rng.integers(-8, 9, size=patch.shape, dtype=np.int16)
                image[30:78, 20:80] = np.clip(patch + noise, 0, 255).astype(np.uint8)
                result = vehicle_color(image, (0, 0, 1, 1))
                self.assertEqual(expected, result["name"])
                self.assertGreaterEqual(result["supportRatio"], 0.55)

    def test_vehicle_color_returns_unknown_for_small_or_mixed_body_crop(self):
        import numpy as np

        small = np.full((8, 8, 3), 220, dtype=np.uint8)
        self.assertEqual("unknown", vehicle_color(small, (0, 0, 1, 1))["name"])

        mixed = np.full((100, 100, 3), 128, dtype=np.uint8)
        mixed[30:78, 20:50] = (0, 0, 220)
        mixed[30:78, 50:80] = (220, 0, 0)
        result = vehicle_color(mixed, (0, 0, 1, 1))
        self.assertEqual("unknown", result["name"])
        self.assertAlmostEqual(0.5, result["supportRatio"], places=2)

    def test_source_clock_reset_is_reported_without_negative_sampling_interval(self):
        self.assertEqual(["source_clock_reset"], sampling_notes(12000, 0, 1000))
        self.assertEqual(["sample_interval_ms=3200.0", "sampling_gap_detected"], sampling_notes(0, 3200, 1000))
        self.assertEqual(["sample_interval_ms=500.0"], sampling_notes(0, 500, 500))
        self.assertEqual(["sample_interval_ms=1000.0", "sampling_gap_detected"], sampling_notes(0, 1000, 500))

    def test_uploaded_video_samples_every_500ms_and_reports_no_normal_rate_gap(self):
        class Image:
            shape = (480, 640, 3)

        class Capture:
            def __init__(self):
                self.index = 0
                self.timestamps = [0, 250, 500, 750, 1000]

            def isOpened(self):
                return True

            def get(self, prop):
                if prop == FakeCv2.CAP_PROP_FPS:
                    return 4.0
                if prop == FakeCv2.CAP_PROP_POS_MSEC:
                    return float(self.timestamps[self.index - 1])
                return 0.0

            def read(self):
                if self.index >= len(self.timestamps):
                    return False, None
                self.index += 1
                return True, Image()

            def release(self):
                pass

        class FakeCv2:
            CAP_PROP_FPS = 5
            CAP_PROP_POS_MSEC = 0

            def VideoCapture(self, _path):
                return Capture()

        class FakeDetector:
            backend = "fixture"
            model_name = "fixture"
            device = "test-only"

            def infer_scene(self, _image, _scene, _mode, _margin):
                return [], "full_frame", 1

        worker = Worker()
        worker.cv2 = FakeCv2()
        worker.session("upload", "session")["config"] = {"sampleEveryMs": 500}
        emitted = []
        worker.event = emitted.append
        try:
            with patch.object(worker, "detector", return_value=FakeDetector()):
                worker.run_job({"sourceId": "upload", "sessionId": "session", "cancel": __import__("threading").Event()}, "analyze_upload", {"filePath": "fixture.mp4", "sampleEveryMs": 500})
        finally:
            worker.executor.shutdown(wait=True)

        self.assertEqual([0.0, 500.0, 1000.0], [event["sourceTimeMs"] for event in emitted])
        notes = [event["quality"]["notes"] for event in emitted]
        self.assertIn("sample_interval_ms=500.0", notes[1])
        self.assertIn("sample_interval_ms=500.0", notes[2])
        self.assertTrue(all("sampling_gap_detected" not in item for item in notes))

    def test_stop_cancels_matching_job_and_drops_only_its_session(self):
        worker = Worker()
        cancel = __import__("threading").Event()
        worker.session("camera-a", "run-1")
        worker.session("camera-b", "run-1")
        worker.jobs["job-1"] = {"sourceId": "camera-a", "sessionId": "run-1", "cancel": cancel}
        result = worker.handle({"command": "stop", "payload": {"sourceId": "camera-a", "sessionId": "run-1"}})
        self.assertEqual({"stopped": True}, result)
        self.assertTrue(cancel.is_set())
        self.assertNotIn(("camera-a", "run-1"), worker.sessions)
        self.assertIn(("camera-b", "run-1"), worker.sessions)
        worker.executor.shutdown(wait=True)

    def test_health_is_unavailable_until_a_real_model_is_loaded(self):
        worker = Worker()
        self.assertFalse(worker.health()["available"])
        worker.executor.shutdown(wait=True)

    def test_ndjson_frame_events_serialize_track_ids_as_contract_strings(self):
        class FixtureDetector:
            def __init__(self):
                self.boxes = [
                    (0.45, 0.30, 0.55, 0.65),
                    (0.45, 0.26, 0.55, 0.61),
                    (0.45, 0.22, 0.55, 0.57),
                    (0.45, 0.18, 0.55, 0.53),
                    (0.45, 0.14, 0.55, 0.49),
                ]

            def infer_scene(self, image, scene, mode, margin):
                return ([{"bboxXYXY": self.boxes.pop(0), "class": "car", "confidence": 0.9}], "full_frame", 1)

        worker = Worker()
        line = {"id": "north", "start": {"x": 0.2, "y": 0.5}, "end": {"x": 0.8, "y": 0.5}, "directionLabels": ["A to B", "B to A"]}
        state = worker.session("fixture", "session-1")
        state["scene"] = {"zones": [], "countingLines": [line]}
        state["config"] = {"modelPath": "test-fixture"}
        image = worker.np.zeros((100, 100, 3), dtype=worker.np.uint8)
        output = io.StringIO()
        worker.protocol_stdout = output
        with patch.object(worker, "detector", return_value=FixtureDetector()), contextlib.redirect_stdout(output):
            for index in range(5):
                frame_id = "55555555-5555-4555-8555-555555555555" if index == 0 else None
                event = worker.frame("fixture", "session-1", image, index * 1000, frame_id)
                if index == 0:
                    self.assertEqual(frame_id, event["frameId"])
                else:
                    self.assertNotIn("frameId", event)
                worker.event(event)
        messages = [json.loads(line) for line in output.getvalue().splitlines()]
        positive = [message["event"] for message in messages if message["event"]["detections"]]
        self.assertTrue(positive)
        self.assertTrue(all(isinstance(d["trackId"], str) for e in positive for d in e["detections"]))
        crossing_events = [message["event"] for message in messages if message["event"]["crossings"]]
        self.assertEqual(1, len(crossing_events))
        self.assertEqual("1", crossing_events[0]["crossings"][0]["trackId"])
        self.assertTrue(all(isinstance(x["trackId"], str) for e in crossing_events for x in e["crossings"]))
        worker.executor.shutdown(wait=True)

    def test_media_job_error_keeps_ndjson_compact_and_writes_traceback_to_stderr(self):
        import concurrent.futures
        import threading

        worker = Worker()
        stdout, stderr = io.StringIO(), io.StringIO()
        worker.protocol_stdout = stdout
        job = {"jobId": "failed-job", "sourceId": "fixture", "sessionId": "session",
               "cancel": threading.Event()}
        worker.jobs[job["jobId"]] = job
        future = concurrent.futures.Future()
        try:
            raise ModuleNotFoundError("No module named 'pwd'")
        except ModuleNotFoundError as exc:
            future.set_exception(exc)

        with contextlib.redirect_stderr(stderr):
            worker.finish_job(job, future)
        message = json.loads(stdout.getvalue())
        self.assertEqual("job_error", message["event"]["type"])
        self.assertEqual("No module named 'pwd'", message["event"]["message"])
        self.assertIn("ModuleNotFoundError", stderr.getvalue())
        self.assertNotIn("Traceback", stdout.getvalue())
        self.assertNotIn(job["jobId"], worker.jobs)
        worker.executor.shutdown(wait=True)

    def test_frame_emits_real_untracked_detector_observations_without_inventing_ids(self):
        class FixtureDetector:
            backend = "yolo26"
            model_name = "YOLO26 Medium"
            device = "cuda:0"
            input_size = 1280
            nms = True
            confidence = 0.25
            iou_threshold = 0.45

            def infer_scene(self, image, scene, mode, margin):
                return ([
                    {"bboxXYXY": (0.1, 0.2, 0.2, 0.3), "class": "car", "confidence": 0.8},
                    {"bboxXYXY": (0.3, 0.2, 0.4, 0.3), "class": "car", "confidence": 0.28},
                ], "full_frame_tiled_with_line_detail", 8)

        worker = Worker()
        state = worker.session("fixture", "observations")
        zone = {"id": "yard", "name": "Yard", "polygon": [
            {"x": 0.0, "y": 0.0}, {"x": 1.0, "y": 0.0}, {"x": 1.0, "y": 1.0}]}
        state["scene"] = {"zones": [zone], "countingLines": []}
        state["config"] = {"modelPath": "fixture", "detectorBackend": "yolo26",
                            "detectorSize": "medium", "inputSize": 1280, "nms": True,
                            "confidenceThreshold": 0.25, "iouThreshold": 0.45,
                            "sampleEveryMs": 500, "detectionMode": "auto"}
        image = worker.np.zeros((100, 100, 3), dtype=worker.np.uint8)
        with patch.object(worker, "detector", return_value=FixtureDetector()):
            event = worker.frame("fixture", "observations", image, 0)
        self.assertEqual(2, len(event["detections"]))
        with_track = [item for item in event["detections"] if "trackId" in item]
        without_track = [item for item in event["detections"] if "trackId" not in item]
        self.assertEqual(1, len(with_track))
        self.assertEqual("1", with_track[0]["trackId"])
        self.assertEqual(1, len(without_track))
        self.assertEqual(0.28, without_track[0]["confidence"])
        context = event["analysisContext"]
        self.assertTrue(context["settingsCaptured"])
        self.assertEqual("YOLO26 Medium", context["detector"]["modelName"])
        self.assertEqual("cuda:0", context["detector"]["device"])
        self.assertEqual(0.25, context["detector"]["confidenceThreshold"])
        self.assertEqual(0.45, context["detector"]["iouThreshold"])
        self.assertEqual("IoUTracker", context["tracker"]["backend"])
        self.assertEqual(500.0, context["sampling"]["sampleEveryMs"])
        self.assertEqual("auto", context["detectionMode"])
        self.assertEqual({"zones": [zone], "countingLines": []}, context["scene"]["snapshot"])
        self.assertEqual(scene_geometry_signature(context["scene"]["snapshot"]),
                         context["scene"]["geometrySignature"])
        worker.executor.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
