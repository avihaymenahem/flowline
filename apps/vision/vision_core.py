"""Deterministic tracking, geometry, and color helpers for the vision worker."""
from __future__ import annotations

from dataclasses import dataclass, field
import math
from typing import Any, Iterable


def bbox_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    left, top = max(a[0], b[0]), max(a[1], b[1])
    right, bottom = min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - intersection
    return intersection / union if union > 0 else 0.0


def box_center(box: tuple[float, float, float, float]) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)


def model_box_to_normalized(box: tuple[float, float, float, float], frame_width: int, frame_height: int,
                            scale: float, offset_x: float = 0.0, offset_y: float = 0.0) -> tuple[float, float, float, float]:
    """Undo resize/padding and return a clamped normalized XYXY box."""
    if scale <= 0 or frame_width <= 0 or frame_height <= 0:
        raise ValueError("frame dimensions and resize scale must be positive")
    x1, y1, x2, y2 = box
    return (
        max(0.0, min(1.0, (x1 - offset_x) / scale / frame_width)),
        max(0.0, min(1.0, (y1 - offset_y) / scale / frame_height)),
        max(0.0, min(1.0, (x2 - offset_x) / scale / frame_width)),
        max(0.0, min(1.0, (y2 - offset_y) / scale / frame_height)),
    )


def line_roi_rectangles(scene: dict[str, Any], frame_width: int, frame_height: int,
                        margin: float = 0.12, maximum: int = 8) -> list[tuple[int, int, int, int]]:
    """Build bounded full-resolution crops around configured normalized count lines."""
    if frame_width <= 0 or frame_height <= 0:
        raise ValueError("frame dimensions must be positive")
    margin = min(0.25, max(0.05, float(margin)))
    rectangles: list[tuple[int, int, int, int]] = []
    for line in scene.get("countingLines", [])[:maximum]:
        try:
            xs = [float(line["start"]["x"]), float(line["end"]["x"])]
            ys = [float(line["start"]["y"]), float(line["end"]["y"])]
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(value) for value in (*xs, *ys)):
            continue
        x1 = max(0, min(frame_width - 1, math.floor((min(xs) - margin) * frame_width)))
        y1 = max(0, min(frame_height - 1, math.floor((min(ys) - margin) * frame_height)))
        x2 = max(x1 + 1, min(frame_width, math.ceil((max(xs) + margin) * frame_width)))
        y2 = max(y1 + 1, min(frame_height, math.ceil((max(ys) + margin) * frame_height)))
        rect = (x1, y1, x2, y2)
        if rect not in rectangles:
            rectangles.append(rect)
    return rectangles


def frame_tile_rectangles(frame_width: int, frame_height: int, maximum_tile_width: int = 1408,
                          maximum_tile_height: int = 1188, maximum_tiles: int = 16) -> list[tuple[int, int, int, int]]:
    """Cover a frame with overlapping, edge-aligned crops for higher-resolution inference.

    At 3840x2160 this yields six 1408x1188 tiles. The crop dimensions preserve
    nearly the same detector scale as the saved gate ROIs while covering every
    sampled frame. Smaller frames use 55% crops; larger frames add rows/columns.
    """
    if frame_width <= 0 or frame_height <= 0:
        raise ValueError("frame dimensions must be positive")

    tile_width = min(frame_width, maximum_tile_width, max(1, math.ceil(frame_width * 0.55)))
    tile_height = min(frame_height, maximum_tile_height, max(1, math.ceil(frame_height * 0.55)))

    def starts(length: int, tile_size: int) -> list[int]:
        count = max(1, math.ceil(length / tile_size))
        if count == 1:
            return [0]
        return [round(index * (length - tile_size) / (count - 1)) for index in range(count)]

    xs, ys = starts(frame_width, tile_width), starts(frame_height, tile_height)
    if len(xs) * len(ys) > maximum_tiles:
        raise ValueError(f"frame requires {len(xs) * len(ys)} inference tiles; maximum is {maximum_tiles}")
    return [(x, y, min(frame_width, x + tile_width), min(frame_height, y + tile_height))
            for y in ys for x in xs]


def split_roi_rectangles(rectangles: list[tuple[int, int, int, int]], maximum_dimension: int = 640,
                         overlap: float = 0.20, maximum_patches: int = 8) -> list[tuple[int, int, int, int]]:
    """Split large focus ROIs into overlapping detector-sized crops, within a global patch budget.

    Each original ROI remains represented. If splitting a region would exceed the budget,
    that ROI is retained as one crop rather than omitted.
    """
    if maximum_dimension <= 0 or maximum_patches < len(rectangles):
        raise ValueError("patch budget must cover each ROI and dimensions must be positive")
    if not 0 <= overlap < 1:
        raise ValueError("overlap must be in [0, 1)")

    def positions(length: int, tile: int) -> list[int]:
        if length <= tile:
            return [0]
        stride = max(1, int(tile * (1 - overlap)))
        starts = list(range(0, length - tile + 1, stride))
        if starts[-1] + tile < length:
            starts.append(length - tile)
        return sorted(set(starts))

    patches: list[tuple[int, int, int, int]] = []
    for index, rect in enumerate(rectangles):
        x1, y1, x2, y2 = rect
        width, height = x2 - x1, y2 - y1
        tile_width, tile_height = min(width, maximum_dimension), min(height, maximum_dimension)
        candidate = [(x1 + x, y1 + y, x1 + x + tile_width, y1 + y + tile_height)
                     for y in positions(height, tile_height) for x in positions(width, tile_width)]
        # Reserve one crop for every line ROI still to be represented.
        remaining_regions = len(rectangles) - index - 1
        if len(patches) + len(candidate) + remaining_regions > maximum_patches:
            candidate = [rect]
        patches.extend(candidate)
    return patches


def remap_crop_detections(detections: list[dict[str, Any]], crop: tuple[int, int, int, int],
                          frame_width: int, frame_height: int) -> list[dict[str, Any]]:
    """Convert crop-relative normalized detector boxes to full-frame normalized boxes."""
    x1, y1, x2, y2 = crop
    crop_width, crop_height = x2 - x1, y2 - y1
    mapped = []
    for detection in detections:
        box = detection["bboxXYXY"]
        mapped.append({**detection, "bboxXYXY": (
            (x1 + float(box[0]) * crop_width) / frame_width,
            (y1 + float(box[1]) * crop_height) / frame_height,
            (x1 + float(box[2]) * crop_width) / frame_width,
            (y1 + float(box[3]) * crop_height) / frame_height,
        )})
    return mapped


def attach_frame_tile_provenance(detections: list[dict[str, Any]], crop: tuple[int, int, int, int],
                                 frame_width: int, frame_height: int, tile_index: int) -> list[dict[str, Any]]:
    """Retain crop-edge evidence long enough to reconcile same-object tile fragments."""
    x1, y1, x2, y2 = crop
    tolerance_x = max(2.0, (x2 - x1) * 0.015)
    tolerance_y = max(2.0, (y2 - y1) * 0.015)
    annotated = []
    for detection in detections:
        box = tuple(float(value) for value in detection["bboxXYXY"])
        edges = set()
        if abs(box[0] * frame_width - x1) <= tolerance_x:
            edges.add("left")
        if abs(box[2] * frame_width - x2) <= tolerance_x:
            edges.add("right")
        if abs(box[1] * frame_height - y1) <= tolerance_y:
            edges.add("top")
        if abs(box[3] * frame_height - y2) <= tolerance_y:
            edges.add("bottom")
        annotated.append({**detection, "_tileIndex": tile_index, "_tileFrame": True,
                          "_tileRect": crop, "_tileEdges": frozenset(edges)})
    return annotated


def _seam_fragments_match(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Require complementary clipped crop edges and aligned vehicle geometry."""
    if not a.get("_tileFrame") or not b.get("_tileFrame") or a.get("_tileIndex") == b.get("_tileIndex"):
        return False
    try:
        ar = tuple(int(value) for value in a["_tileRect"])
        br = tuple(int(value) for value in b["_tileRect"])
        ab = tuple(float(value) for value in a["bboxXYXY"])
        bb = tuple(float(value) for value in b["bboxXYXY"])
        ae, be = a["_tileEdges"], b["_tileEdges"]
    except (KeyError, TypeError, ValueError):
        return False

    def overlap_ratio(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
        return max(0.0, min(end_a, end_b) - max(start_a, start_b)) / max(1e-9, min(end_a - start_a, end_b - start_b))

    ax1, ay1, ax2, ay2 = ab
    bx1, by1, bx2, by2 = bb
    aw, ah, bw, bh = ax2 - ax1, ay2 - ay1, bx2 - bx1, by2 - by1
    if min(aw, ah, bw, bh) <= 0:
        return False
    horizontal = (
        ar[0] < br[0] and ar[2] < br[2] and
        overlap_ratio(ar[1], ar[3], br[1], br[3]) >= 0.75 and
        "right" in ae and "left" in be and
        overlap_ratio(ax1, ax2, bx1, bx2) >= 0.35 and
        overlap_ratio(ay1, ay2, by1, by2) >= 0.70 and
        min(aw, bw) / max(aw, bw) >= 0.40 and min(ah, bh) / max(ah, bh) >= 0.70 and
        abs((ay1 + ay2 - by1 - by2) / 2) <= 0.20 * max(ah, bh) + 1e-9 and
        abs((ax1 + ax2 - bx1 - bx2) / 2) <= 0.60 * max(aw, bw) + 1e-9
    )
    vertical = (
        ar[1] < br[1] and ar[3] < br[3] and
        overlap_ratio(ar[0], ar[2], br[0], br[2]) >= 0.75 and
        "bottom" in ae and "top" in be and
        overlap_ratio(ay1, ay2, by1, by2) >= 0.35 and
        overlap_ratio(ax1, ax2, bx1, bx2) >= 0.70 and
        min(ah, bh) / max(ah, bh) >= 0.40 and min(aw, bw) / max(aw, bw) >= 0.70 and
        abs((ax1 + ax2 - bx1 - bx2) / 2) <= 0.20 * max(aw, bw) + 1e-9 and
        abs((ay1 + ay2 - by1 - by2) / 2) <= 0.60 * max(ah, bh) + 1e-9
    )
    return horizontal or vertical


def _contained_seam_fragment_pair(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Suppress a crop-edge class fragment contained in a fuller adjacent-tile box."""
    vehicle_classes = {"car", "truck", "bus", "motorcycle", "bicycle"}
    if str(a.get("class", "")).strip().lower() not in vehicle_classes or \
            str(b.get("class", "")).strip().lower() not in vehicle_classes:
        return False
    if not a.get("_tileFrame") or not b.get("_tileFrame") or a.get("_tileIndex") == b.get("_tileIndex"):
        return False
    for small, large in ((a, b), (b, a)):
        try:
            small_rect = tuple(int(value) for value in small["_tileRect"])
            large_rect = tuple(int(value) for value in large["_tileRect"])
            small_box = tuple(float(value) for value in small["bboxXYXY"])
            large_box = tuple(float(value) for value in large["bboxXYXY"])
            edges = small["_tileEdges"]
        except (KeyError, TypeError, ValueError):
            continue
        sx1, sy1, sx2, sy2 = small_box
        lx1, ly1, lx2, ly2 = large_box
        frame_width = max(small_rect[2], large_rect[2])
        frame_height = max(small_rect[3], large_rect[3])
        small_area = max(0.0, sx2 - sx1) * max(0.0, sy2 - sy1)
        large_area = max(0.0, lx2 - lx1) * max(0.0, ly2 - ly1)
        intersection = max(0.0, min(sx2, lx2) - max(sx1, lx1)) * max(0.0, min(sy2, ly2) - max(sy1, ly1))
        if small_area <= 0 or large_area <= small_area or intersection / small_area < 0.90 or small_area / large_area < 0.25:
            continue
        horizontal = (
            "right" in edges and small_rect[0] < large_rect[0] and small_rect[2] < large_rect[2] and
            overlap_ratio(small_rect[1], small_rect[3], large_rect[1], large_rect[3]) >= 0.75 and
            lx2 - small_rect[2] / frame_width >= 0.02 and
            min(sy2 - sy1, ly2 - ly1) / max(sy2 - sy1, ly2 - ly1) >= 0.70 and
            abs((sy1 + sy2 - ly1 - ly2) / 2) <= 0.20 * max(sy2 - sy1, ly2 - ly1)
        ) or (
            "left" in edges and small_rect[0] > large_rect[0] and small_rect[2] > large_rect[2] and
            overlap_ratio(small_rect[1], small_rect[3], large_rect[1], large_rect[3]) >= 0.75 and
            small_rect[0] / frame_width - lx1 >= 0.02 and
            min(sy2 - sy1, ly2 - ly1) / max(sy2 - sy1, ly2 - ly1) >= 0.70 and
            abs((sy1 + sy2 - ly1 - ly2) / 2) <= 0.20 * max(sy2 - sy1, ly2 - ly1)
        )
        vertical = (
            "bottom" in edges and small_rect[1] < large_rect[1] and small_rect[3] < large_rect[3] and
            overlap_ratio(small_rect[0], small_rect[2], large_rect[0], large_rect[2]) >= 0.75 and
            ly2 - small_rect[3] / frame_height >= 0.02 and
            min(sx2 - sx1, lx2 - lx1) / max(sx2 - sx1, lx2 - lx1) >= 0.70 and
            abs((sx1 + sx2 - lx1 - lx2) / 2) <= 0.20 * max(sx2 - sx1, lx2 - lx1)
        ) or (
            "top" in edges and small_rect[1] > large_rect[1] and small_rect[3] > large_rect[3] and
            overlap_ratio(small_rect[0], small_rect[2], large_rect[0], large_rect[2]) >= 0.75 and
            small_rect[1] / frame_height - ly1 >= 0.02 and
            min(sx2 - sx1, lx2 - lx1) / max(sx2 - sx1, lx2 - lx1) >= 0.70 and
            abs((sx1 + sx2 - lx1 - lx2) / 2) <= 0.20 * max(sx2 - sx1, lx2 - lx1)
        )
        if horizontal or vertical:
            return True
    return False


def overlap_ratio(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
    return max(0.0, min(end_a, end_b) - max(start_a, start_b)) / max(1e-9, min(end_a - start_a, end_b - start_b))


def _large_vehicle_box(detection: dict[str, Any]) -> tuple[float, float, float, float] | None:
    if str(detection.get("class", "")).strip().lower() not in {"bus", "truck"}:
        return None
    try:
        box = tuple(float(value) for value in detection["bboxXYXY"])
    except (KeyError, TypeError, ValueError):
        return None
    if len(box) != 4 or box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box


def has_large_vehicle_tile_fragments(detections: list[dict[str, Any]]) -> bool:
    """Gate the extra full-frame anchor inference to frames with suspicious crop boxes."""
    candidates = []
    for detection in detections:
        box = _large_vehicle_box(detection)
        if box is None or not detection.get("_tileFrame"):
            continue
        x1, y1, x2, y2 = box
        if x2 - x1 >= 0.12 and y2 - y1 >= 0.38:
            candidates.append((detection, box))
    for index, (a, abox) in enumerate(candidates):
        for b, bbox in candidates[index + 1:]:
            ax1, ay1, ax2, ay2 = abox
            bx1, by1, bx2, by2 = bbox
            ah, bh = ay2 - ay1, by2 - by1
            if (overlap_ratio(ay1, ay2, by1, by2) >= 0.90 and
                    min(ah, bh) / max(ah, bh) >= 0.82 and
                    overlap_ratio(ax1, ax2, bx1, bx2) >= 0.25):
                return True
    return False


def _large_tile_fragment_anchor_score(fragment: dict[str, Any], anchor: dict[str, Any],
                                      frame_width: int, frame_height: int) -> float | None:
    fragment_box, anchor_box = _large_vehicle_box(fragment), _large_vehicle_box(anchor)
    if fragment_box is None or anchor_box is None or not fragment.get("_tileFrame"):
        return None
    fx1, fy1, fx2, fy2 = fragment_box
    ax1, ay1, ax2, ay2 = anchor_box
    fw, fh, aw, ah = fx2 - fx1, fy2 - fy1, ax2 - ax1, ay2 - ay1
    if min(fw, fh, aw, ah) <= 0 or min(fh, ah) < 0.32:
        return None
    vertical = overlap_ratio(fy1, fy2, ay1, ay2)
    height_ratio = min(fh, ah) / max(fh, ah)
    if vertical < 0.88 or height_ratio < 0.70:
        return None
    same_class = str(fragment.get("class", "")).strip().lower() == str(anchor.get("class", "")).strip().lower()
    intersection_width = max(0.0, min(fx2, ax2) - max(fx1, ax1))
    intersection_height = max(0.0, min(fy2, ay2) - max(fy1, ay1))
    fragment_coverage = intersection_width * intersection_height / (fw * fh)
    anchor_coverage = intersection_width * intersection_height / (aw * ah)
    if same_class and fragment_coverage >= 0.55 and anchor_coverage >= 0.35:
        return fragment_coverage

    # The full-frame box can end just across a tile seam while the tile crop
    # supplies the remaining portion. Accept only direct seam continuation.
    if _large_fragment_seam_continues_anchor(fragment, anchor, frame_width, frame_height):
        return 0.55 + vertical * 0.25
    return None


def _large_fragment_seam_continues_anchor(fragment: dict[str, Any], anchor: dict[str, Any],
                                           frame_width: int, frame_height: int) -> bool:
    """True only when a crop-clipped large box continues across an anchor seam."""
    try:
        fragment_box = _large_vehicle_box(fragment)
        anchor_box = _large_vehicle_box(anchor)
        if fragment_box is None or anchor_box is None:
            return False
        fx1, fy1, fx2, fy2 = fragment_box
        ax1, ay1, ax2, ay2 = anchor_box
        tx1, ty1, tx2, ty2 = (int(value) for value in fragment["_tileRect"])
        edges = fragment["_tileEdges"]
    except (KeyError, TypeError, ValueError):
        return False
    if not isinstance(edges, (set, frozenset)):
        return False
    seam_tolerance_x = max(2.0, (tx2 - tx1) * 0.015) / max(1, frame_width)
    seam_tolerance_y = max(2.0, (ty2 - ty1) * 0.015) / max(1, frame_height)
    if "left" in edges and tx1 > 0:
        seam = tx1 / frame_width
        if (ax1 < seam <= ax2 and fx1 <= seam + seam_tolerance_x and fx2 > seam and
                max(0.0, min(fx2, ax2) - max(fx1, ax1)) > 0 and overlap_ratio(fy1, fy2, ay1, ay2) >= 0.90):
            return True
    if "right" in edges and tx2 < frame_width:
        seam = tx2 / frame_width
        if (ax1 <= seam < ax2 and fx2 >= seam - seam_tolerance_x and fx1 < seam and
                max(0.0, min(fx2, ax2) - max(fx1, ax1)) > 0 and overlap_ratio(fy1, fy2, ay1, ay2) >= 0.90):
            return True
    if "top" in edges and ty1 > 0:
        seam = ty1 / frame_height
        if (ay1 < seam <= ay2 and fy1 <= seam + seam_tolerance_y and fy2 > seam and
                max(0.0, min(fy2, ay2) - max(fy1, ay1)) > 0 and overlap_ratio(fx1, fx2, ax1, ax2) >= 0.90):
            return True
    if "bottom" in edges and ty2 < frame_height:
        seam = ty2 / frame_height
        if (ay1 <= seam < ay2 and fy2 >= seam - seam_tolerance_y and fy1 < seam and
                max(0.0, min(fy2, ay2) - max(fy1, ay1)) > 0 and overlap_ratio(fx1, fx2, ax1, ax2) >= 0.90):
            return True
    return False


def reconcile_large_vehicle_tile_fragments(detections: list[dict[str, Any]],
                                           anchors: list[dict[str, Any]],
                                           frame_width: int, frame_height: int) -> tuple[list[dict[str, Any]], bool]:
    """Replace coherent, uniquely anchored crop fragments with an extent-preserving anchor."""
    fragments = [(index, item) for index, item in enumerate(detections)
                 if _large_vehicle_box(item) is not None and item.get("_tileFrame")]
    assignments: dict[int, list[tuple[int, dict[str, Any]]]] = {}
    for index, fragment in fragments:
        matches = [(score, anchor_index) for anchor_index, anchor in enumerate(anchors)
                   if (score := _large_tile_fragment_anchor_score(fragment, anchor, frame_width, frame_height)) is not None]
        matches.sort(reverse=True)
        if len(matches) == 1 or (len(matches) > 1 and matches[0][0] - matches[1][0] >= 0.15):
            score, anchor_index = matches[0]
            assignments.setdefault(anchor_index, []).append((index, fragment))

    def compatible(first: dict[str, Any], second: dict[str, Any]) -> bool:
        a = _large_vehicle_box(first)
        b = _large_vehicle_box(second)
        if a is None or b is None:
            return False
        same_class = str(first.get("class", "")).strip().lower() == str(second.get("class", "")).strip().lower()
        if not same_class:
            return _seam_fragments_match(first, second)
        ax1, ay1, ax2, ay2 = a
        bx1, by1, bx2, by2 = b
        aw, ah, bw, bh = ax2 - ax1, ay2 - ay1, bx2 - bx1, by2 - by1
        if overlap_ratio(ay1, ay2, by1, by2) < 0.88 or min(ah, bh) / max(ah, bh) < 0.78:
            return False
        horizontal_overlap = overlap_ratio(ax1, ax2, bx1, bx2)
        centers = abs((ax1 + ax2 - bx1 - bx2) / 2)
        return horizontal_overlap >= 0.34 and centers <= 0.72 * max(aw, bw)

    consumed: set[int] = set()
    fused: list[dict[str, Any]] = []
    for anchor_index, members in assignments.items():
        if len(members) < 2:
            continue
        member_detections = [item for _, item in members]
        # Require a connected crop-fragment cluster, plus actual seam evidence
        # linking one member to this anchor or another member. Anchor overlap
        # alone can otherwise collapse two separate heavy vehicles.
        reached = {0}
        pending = [0]
        while pending:
            current = pending.pop()
            for candidate in range(len(member_detections)):
                if candidate in reached:
                    continue
                if compatible(member_detections[current], member_detections[candidate]) or \
                        _seam_fragments_match(member_detections[current], member_detections[candidate]):
                    reached.add(candidate)
                    pending.append(candidate)
        if len(reached) != len(member_detections):
            continue
        anchor = anchors[anchor_index]
        has_anchor_seam_match = any(_large_fragment_seam_continues_anchor(item, anchor, frame_width, frame_height)
                                    for item in member_detections)
        has_member_seam_match = any(_seam_fragments_match(member_detections[i], member_detections[j])
                                    for i in range(len(member_detections))
                                    for j in range(i + 1, len(member_detections)))
        if not (has_anchor_seam_match or has_member_seam_match):
            # At least one complementary seam relationship must support the
            # fusion; an interior high-coverage box pair alone is ambiguous.
            continue
        if len(member_detections) < 3 and not has_member_seam_match:
            # One anchor plus two merely overlapping boxes cannot distinguish
            # a duplicate from an occluded/convoy pair. Two fragments may still
            # fuse when they directly prove complementary crop continuity.
            continue
        boxes = [tuple(float(value) for value in anchor["bboxXYXY"])]
        boxes.extend(tuple(float(value) for value in item["bboxXYXY"]) for item in member_detections)
        union = (min(box[0] for box in boxes), min(box[1] for box in boxes),
                 max(box[2] for box in boxes), max(box[3] for box in boxes))
        anchor_box = tuple(float(value) for value in anchor["bboxXYXY"])
        if (union[2] - union[0] > 1.35 * (anchor_box[2] - anchor_box[0]) or
                union[3] - union[1] > 1.20 * (anchor_box[3] - anchor_box[1])):
            continue
        fused.append({**anchor, "bboxXYXY": (min(box[0] for box in boxes), min(box[1] for box in boxes),
                                               max(box[2] for box in boxes), max(box[3] for box in boxes))})
        consumed.update(index for index, _ in members)
    if not fused:
        return [dict(item) for item in detections], False
    return ([dict(item) for index, item in enumerate(detections) if index not in consumed] + fused, True)


def deduplicate_detections(detections: list[dict[str, Any]], threshold: float = 0.45,
                           cross_class_threshold: float = 0.85) -> list[dict[str, Any]]:
    """Reconcile repeated detections from overlapping high-resolution ROIs."""
    kept: list[dict[str, Any]] = []
    for detection in sorted(detections, key=lambda item: float(item.get("confidence", 0)), reverse=True):
        box = tuple(float(value) for value in detection["bboxXYXY"])
        duplicate = False
        for existing in kept:
            overlap = bbox_iou(box, tuple(float(value) for value in existing["bboxXYXY"]))
            same_class = existing.get("class") == detection.get("class")
            from_different_tiles = (detection.get("_tileIndex") is not None and
                                    existing.get("_tileIndex") is not None and
                                    detection.get("_tileIndex") != existing.get("_tileIndex"))
            if not same_class and from_different_tiles and overlap >= cross_class_threshold:
                a, b = tuple(float(value) for value in existing["bboxXYXY"]), box
                aw, ah = a[2] - a[0], a[3] - a[1]
                bw, bh = b[2] - b[0], b[3] - b[1]
                center_gap = math.hypot((a[0] + a[2] - b[0] - b[2]) / 2,
                                        (a[1] + a[3] - b[1] - b[3]) / 2)
                similar_size = (min(aw, bw) > 0 and min(ah, bh) > 0 and
                                abs(aw - bw) / max(aw, bw) <= 0.20 and
                                abs(ah - bh) / max(ah, bh) <= 0.20)
                near_identical = center_gap <= 0.12 * math.hypot(min(aw, bw), min(ah, bh))
            else:
                similar_size = near_identical = False
            if (same_class and overlap > threshold) or (
                    from_different_tiles and not same_class and overlap >= cross_class_threshold and
                    similar_size and near_identical):
                duplicate = True
                break
            if same_class and from_different_tiles and _seam_fragments_match(existing, detection):
                # Complementary crop-edge boxes are partial views of one object. Their union
                # reconstructs the vehicle extent while preserving the stronger detection's metadata.
                existing_box = tuple(float(value) for value in existing["bboxXYXY"])
                existing["bboxXYXY"] = (min(existing_box[0], box[0]), min(existing_box[1], box[1]),
                                        max(existing_box[2], box[2]), max(existing_box[3], box[3]))
                duplicate = True
                break
            if not same_class and from_different_tiles and _contained_seam_fragment_pair(existing, detection):
                # Prefer the larger, fuller cross-class view even if it was lower confidence.
                existing_box = tuple(float(value) for value in existing["bboxXYXY"])
                detection_box = tuple(float(value) for value in detection["bboxXYXY"])
                existing_area = (existing_box[2] - existing_box[0]) * (existing_box[3] - existing_box[1])
                detection_area = (detection_box[2] - detection_box[0]) * (detection_box[3] - detection_box[1])
                if detection_area > existing_area:
                    existing.clear()
                    existing.update(detection)
                duplicate = True
                break
        if duplicate:
            continue
        kept.append(detection)
    return [{key: value for key, value in detection.items() if not key.startswith("_tile")} for detection in kept]


def sampling_notes(previous_ms: float | None, current_ms: float, sample_every_ms: float) -> list[str]:
    if previous_ms is None:
        return []
    if current_ms < previous_ms:
        return ["source_clock_reset"]
    interval = current_ms - previous_ms
    notes = [f"sample_interval_ms={interval:.1f}"]
    if interval > sample_every_ms * 1.5:
        notes.append("sampling_gap_detected")
    return notes


@dataclass
class Track:
    track_id: int
    bbox: tuple[float, float, float, float]
    class_name: str
    confidence: float
    missed: int = 0
    previous_center: tuple[float, float] | None = None
    line_sides: dict[str, int] = field(default_factory=dict)
    last_source_time_ms: float | None = None


class IoUTracker:
    """Local IoU/motion tracker with cautious class-flicker recovery."""

    VEHICLE_CLASSES = frozenset({"bicycle", "car", "motorcycle", "bus", "truck"})

    def __init__(self, max_missed: int = 12, new_track_threshold: float = 0.35):
        self.max_missed = max_missed
        self.new_track_threshold = new_track_threshold
        self.next_id = 1
        self.tracks: dict[int, Track] = {}
        self._last_update_source_time_ms: float | None = None

    def update(self, detections: list[dict[str, Any]], *, source_time_ms: float | None = None,
               max_age_ms: float | None = None) -> list[dict[str, Any]]:
        now = None
        if isinstance(source_time_ms, (int, float)) and math.isfinite(float(source_time_ms)):
            now = float(source_time_ms)
        if now is not None:
            if self._last_update_source_time_ms is not None and now < self._last_update_source_time_ms:
                # A decoder/source clock reset starts a new tracking epoch, but
                # IDs remain monotonic within the session so old IDs are never reused.
                self.tracks.clear()
            elif max_age_ms is not None and max_age_ms > 0:
                expired = [tid for tid, track in self.tracks.items()
                           if track.last_source_time_ms is not None and
                           now - track.last_source_time_ms > max_age_ms]
                for tid in expired:
                    del self.tracks[tid]
            self._last_update_source_time_ms = now

        ordered = sorted(detections, key=lambda item: float(item.get("confidence", 0)), reverse=True)
        unmatched_tracks = set(self.tracks)
        matched_detection: dict[int, int] = {}
        matched_iou_by_track: dict[int, float] = {}

        # Greedy two-pass association: confident detections first, then weaker
        # detections can recover an existing track but cannot create one.
        for min_score in (0.25, 0.0):
            candidates: list[tuple[float, int, int]] = []
            for di, det in enumerate(ordered):
                score = float(det.get("confidence", 0))
                if (min_score == 0.25 and score < 0.25) or (min_score == 0.0 and score >= 0.25):
                    continue
                box = tuple(det["bboxXYXY"])
                center = box_center(box)
                for tid in unmatched_tracks:
                    track = self.tracks[tid]
                    if track.class_name != det["class"]:
                        continue
                    predicted = track.bbox
                    if track.previous_center is not None:
                        current_footpoint = footpoint(track.bbox)
                        dx = current_footpoint[0] - track.previous_center[0]
                        dy = current_footpoint[1] - track.previous_center[1]
                        predicted = (predicted[0] + dx, predicted[1] + dy, predicted[2] + dx, predicted[3] + dy)
                    overlap = bbox_iou(predicted, box)
                    pc = box_center(predicted)
                    distance = math.hypot(center[0] - pc[0], center[1] - pc[1])
                    max_distance = max(0.025, 2.5 * max(predicted[2] - predicted[0], predicted[3] - predicted[1]))
                    if overlap >= 0.05 or distance <= max_distance:
                        candidates.append((overlap + max(0.0, max_distance - distance), overlap, tid, di))
            for _, overlap, tid, di in sorted(candidates, reverse=True):
                if tid in unmatched_tracks and di not in matched_detection:
                    unmatched_tracks.remove(tid)
                    matched_detection[di] = tid
                    matched_iou_by_track[tid] = overlap

        # Detector class flicker can otherwise split one physical vehicle into
        # multiple IDs. Reconcile only highly-overlapping vehicle observations
        # with a mutual one-to-one spatial match. If a pair of neighboring
        # vehicles causes an exact-class spatial swap, replace that weak match
        # only when the cross-class same-position overlap is unambiguous.
        class_flicker_candidates: list[tuple[float, int, int]] = []
        per_track_candidates: dict[int, list[int]] = {}
        per_detection_candidates: dict[int, list[int]] = {}
        for tid, track in self.tracks.items():
            if track.class_name not in self.VEHICLE_CLASSES:
                continue
            if matched_iou_by_track.get(tid, 0.0) > 0.5:
                continue
            predicted = track.bbox
            if track.previous_center is not None:
                old_footpoint = footpoint(track.bbox)
                dx = old_footpoint[0] - track.previous_center[0]
                dy = old_footpoint[1] - track.previous_center[1]
                predicted = (predicted[0] + dx, predicted[1] + dy,
                             predicted[2] + dx, predicted[3] + dy)
            for di, det in enumerate(ordered):
                if det.get("class") not in self.VEHICLE_CLASSES or det.get("class") == track.class_name:
                    continue
                assigned_tid = matched_detection.get(di)
                if assigned_tid is not None and matched_iou_by_track.get(assigned_tid, 0.0) > 0.5:
                    continue
                if float(det.get("confidence", 0)) < 0.5:
                    continue
                box = tuple(float(v) for v in det["bboxXYXY"])
                overlap = bbox_iou(predicted, box)
                center = box_center(box)
                predicted_center = box_center(predicted)
                max_dimension = max(predicted[2] - predicted[0], predicted[3] - predicted[1])
                if overlap < 0.85 or math.hypot(center[0] - predicted_center[0],
                                                center[1] - predicted_center[1]) > max(0.003, 0.08 * max_dimension):
                    continue
                class_flicker_candidates.append((overlap, tid, di))
                per_track_candidates.setdefault(tid, []).append(di)
                per_detection_candidates.setdefault(di, []).append(tid)

        for overlap, tid, di in sorted(class_flicker_candidates, reverse=True):
            if len(per_track_candidates.get(tid, [])) != 1 or len(per_detection_candidates.get(di, [])) != 1:
                continue
            old_di = next((candidate_di for candidate_di, candidate_tid in matched_detection.items()
                           if candidate_tid == tid), None)
            old_tid = matched_detection.get(di)
            if old_di is not None and matched_iou_by_track.get(tid, 0.0) > 0.5:
                continue
            if old_tid is not None and matched_iou_by_track.get(old_tid, 0.0) > 0.5:
                continue
            if old_di is not None:
                del matched_detection[old_di]
                matched_iou_by_track.pop(tid, None)
                unmatched_tracks.add(tid)
            if old_tid is not None:
                old_tidi = next((candidate_di for candidate_di, candidate_tid in matched_detection.items()
                                 if candidate_tid == old_tid), None)
                if old_tidi is not None:
                    del matched_detection[old_tidi]
                matched_iou_by_track.pop(old_tid, None)
                unmatched_tracks.add(old_tid)
            if tid in unmatched_tracks and di not in matched_detection:
                unmatched_tracks.remove(tid)
                matched_detection[di] = tid
                matched_iou_by_track[tid] = overlap

        outputs: list[dict[str, Any]] = []
        for di, det in enumerate(ordered):
            box = tuple(float(v) for v in det["bboxXYXY"])
            tid = matched_detection.get(di)
            if tid is None:
                if float(det.get("confidence", 0)) < self.new_track_threshold:
                    continue
                tid = self.next_id
                self.next_id += 1
                self.tracks[tid] = Track(tid, box, det["class"], float(det["confidence"]),
                                         last_source_time_ms=now)
            else:
                track = self.tracks[tid]
                track.previous_center = footpoint(track.bbox)
                track.bbox = box
                track.class_name = det["class"]
                track.confidence = float(det["confidence"])
                track.missed = 0
                if now is not None:
                    track.last_source_time_ms = now
            outputs.append({**det, "bboxXYXY": box, "trackId": tid})

        for tid in list(unmatched_tracks):
            self.tracks[tid].missed += 1
            if self.tracks[tid].missed > self.max_missed:
                del self.tracks[tid]
        return outputs


def point_in_polygon(point: tuple[float, float], polygon: list[dict[str, float]]) -> bool:
    x, y = point
    inside = False
    if len(polygon) < 3:
        return False
    previous = polygon[-1]
    for current in polygon:
        x1, y1 = float(previous["x"]), float(previous["y"])
        x2, y2 = float(current["x"]), float(current["y"])
        if (y1 > y) != (y2 > y):
            at_x = (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1
            if x < at_x:
                inside = not inside
        previous = current
    return inside


def footpoint(box: tuple[float, float, float, float]) -> tuple[float, float]:
    """Vehicle ground-contact proxy: the midpoint along the bottom edge."""
    return ((box[0] + box[2]) / 2.0, box[3])


def line_crossings(tracks: dict[int, Track], scene: dict[str, Any], hysteresis: float = 0.008) -> list[dict[str, Any]]:
    crossings = []
    for track in tracks.values():
        if track.missed:
            continue
        current = footpoint(track.bbox)
        previous = track.previous_center or current
        for line in scene.get("countingLines", []):
            start, end = line["start"], line["end"]
            ax, ay = float(start["x"]), float(start["y"])
            bx, by = float(end["x"]), float(end["y"])
            dx, dy = bx - ax, by - ay
            length = math.hypot(dx, dy)
            if length == 0:
                continue
            def side(point: tuple[float, float]) -> float:
                return (dx * (point[1] - ay) - dy * (point[0] - ax)) / length
            value = side(current)
            stable = 1 if value > hysteresis else (-1 if value < -hysteresis else 0)
            old_side = track.line_sides.get(str(line["id"]), 0)
            if stable and old_side and stable != old_side:
                old_value = side(previous)
                denom = old_value - value
                ratio = max(0.0, min(1.0, old_value / denom)) if denom else 0.5
                ix = previous[0] + (current[0] - previous[0]) * ratio
                iy = previous[1] + (current[1] - previous[1]) * ratio
                projection = ((ix - ax) * dx + (iy - ay) * dy) / (length * length)
                if 0 <= projection <= 1:
                    labels = line.get("directionLabels") or ["negative_to_positive", "positive_to_negative"]
                    direction = labels[0] if stable > old_side else labels[1]
                    crossings.append({"lineId": str(line["id"]), "direction": str(direction), "trackId": track.track_id})
            if stable:
                track.line_sides[str(line["id"])] = stable
    return crossings


def suppress_recent_recrossings(crossings: list[dict[str, Any]], last_crossed_at: dict[tuple[str, int], float],
                                source_time_ms: float, cooldown_ms: float = 2500.0) -> list[dict[str, Any]]:
    """Debounce detector jitter that flips one tracked vehicle across a gate repeatedly."""
    if any(source_time_ms < previous for previous in last_crossed_at.values()):
        last_crossed_at.clear()
    accepted = []
    for crossing in crossings:
        key = (str(crossing["lineId"]), int(crossing["trackId"]))
        previous = last_crossed_at.get(key)
        if previous is not None and source_time_ms - previous < max(0.0, cooldown_ms):
            continue
        accepted.append(crossing)
        last_crossed_at[key] = source_time_ms
    return accepted


def vehicle_color(frame: Any, bbox: tuple[float, float, float, float]) -> dict[str, Any]:
    """Estimate a coarse vehicle-body color from dominant HSV pixels.

    supportRatio is the winning color's share of usable crop pixels, not a calibrated
    probability. Ambiguous crops remain explicitly unknown.
    """
    unknown = {"name": "unknown", "supportRatio": 0.0}
    try:
        import cv2
        import numpy as np
        height, width = frame.shape[:2]
        x1, y1, x2, y2 = bbox
        # Sample the center of the vehicle body rather than road/background edges.
        left, right = int(max(0, (x1 + 0.2 * (x2 - x1)) * width)), int(min(width, (x1 + 0.8 * (x2 - x1)) * width))
        top, bottom = int(max(0, (y1 + 0.30 * (y2 - y1)) * height)), int(min(height, (y1 + 0.78 * (y2 - y1)) * height))
        crop = frame[top:bottom, left:right]
        if crop.size == 0 or crop.shape[0] * crop.shape[1] < 36:
            return unknown
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        pixels = hsv.reshape(-1, 3)
        # Keep neutral pixels: they carry the evidence needed to estimate white, gray,
        # and black paint. Only near-black shadow/noise is excluded from the vote.
        usable = pixels[pixels[:, 2] > 10]
        if len(usable) < 36:
            return unknown

        hue, saturation, value = usable[:, 0], usable[:, 1], usable[:, 2]
        labels = np.full(len(usable), "unknown", dtype=object)
        labels[value < 48] = "black"
        mid_dark = (value >= 48) & (saturation < 40)
        labels[mid_dark] = "gray"
        neutral = saturation < 40
        labels[neutral & (value >= 185)] = "white"
        labels[neutral & (value >= 48) & (value < 185)] = "gray"
        # Near-black pixels are paint/shadow-dark regardless of their unstable HSV hue.
        chromatic = (saturation >= 40) & (value >= 48)
        labels[chromatic & ((hue < 10) | (hue >= 170))] = "red"
        labels[chromatic & (hue >= 10) & (hue < 23)] = "orange"
        labels[chromatic & (hue >= 23) & (hue < 35)] = "yellow"
        labels[chromatic & (hue >= 35) & (hue < 85)] = "green"
        labels[chromatic & (hue >= 85) & (hue < 130)] = "blue"
        labels[chromatic & (hue >= 130) & (hue < 150)] = "purple"
        labels[chromatic & (hue >= 150) & (hue < 170)] = "pink"

        names, counts = np.unique(labels[labels != "unknown"], return_counts=True)
        if len(counts) == 0:
            return unknown
        winner = int(np.argmax(counts))
        support = float(counts[winner]) / len(usable)
        name = str(names[winner]) if support >= 0.55 else "unknown"
        return {"name": name, "supportRatio": round(support, 3)}
    except Exception:
        return unknown


def vehicle_zones(bbox: tuple[float, float, float, float], scene: dict[str, Any]) -> list[str]:
    center = box_center(bbox)
    return [str(zone["id"]) for zone in scene.get("zones", []) if point_in_polygon(center, zone.get("polygon", []))]
