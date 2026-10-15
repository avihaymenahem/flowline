import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
    import cv2
except ImportError:
    np = None
    cv2 = None

from worker import OnnxYolo, RfDetrAdapter, Worker, Yolo26Adapter, select_yolo_device


class YoloDeviceSelectionTests(unittest.TestCase):
    def test_prefers_cuda_when_available(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        self.assertEqual(0, select_yolo_device(torch))

    def test_uses_mps_only_when_built_and_available(self):
        torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: False),
            backends=SimpleNamespace(mps=SimpleNamespace(is_built=lambda: True, is_available=lambda: True)),
        )
        self.assertEqual("mps", select_yolo_device(torch))

    def test_falls_back_to_cpu_when_mps_is_unavailable_or_absent(self):
        for mps in (
            SimpleNamespace(is_built=lambda: True, is_available=lambda: False),
            SimpleNamespace(is_built=lambda: False, is_available=lambda: True),
        ):
            torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), backends=SimpleNamespace(mps=mps))
            self.assertEqual("cpu", select_yolo_device(torch))
        self.assertEqual("cpu", select_yolo_device(SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))))

    def test_cpu_environment_override_bypasses_available_accelerators(self):
        torch = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True),
            backends=SimpleNamespace(mps=SimpleNamespace(is_built=lambda: True, is_available=lambda: True)),
        )
        with patch.dict("os.environ", {"VISION_DEVICE": "cpu"}):
            self.assertEqual("cpu", select_yolo_device(torch))
        self.assertEqual("cpu", select_yolo_device(torch, "CPU"))

    def test_device_environment_values_are_validated(self):
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with patch.dict("os.environ", {"VISION_DEVICE": "gpu"}):
            with self.assertRaisesRegex(ValueError, "VISION_DEVICE must be 'auto' or 'cpu'"):
                select_yolo_device(torch)


@unittest.skipIf(np is None or cv2 is None, "requires the configured local vision runtime")
class YoloXDecoderTests(unittest.TestCase):
    def test_official_yolox_s_output_uses_stride_grid_decode(self):
        class Input:
            name = "images"
            shape = [1, 3, 640, 640]

        class Model:
            def get_inputs(self):
                return [Input()]

            def get_modelmeta(self):
                return SimpleNamespace(graph_name="")

        adapter = OnnxYolo(SimpleNamespace(np=np, cv2=cv2), Model(), {"modelPath": "object_detection_yolox_2022nov.onnx"})
        raw = np.zeros((8400, 85), dtype=np.float32)
        decoded = adapter._decode_yolox(raw)
        self.assertEqual((8400, 85), decoded.shape)
        np.testing.assert_allclose(decoded[0, :4], [0, 0, 8, 8])
        np.testing.assert_allclose(decoded[6400, :4], [0, 0, 16, 16])
        np.testing.assert_allclose(decoded[8000, :4], [0, 0, 32, 32])

    def test_rfdetr_adapter_maps_coco_vehicles_to_worker_detection_contract(self):
        import sys
        from unittest.mock import patch

        class FakeModel:
            def __init__(self, pretrain_weights):
                self.pretrain_weights = pretrain_weights
                self.model = SimpleNamespace(device="cuda:0")

            def predict(self, image, threshold):
                self.image = image.copy()
                self.threshold = threshold
                return SimpleNamespace(
                    xyxy=np.asarray([[5, 5, 8, 8], [-2, 10, 30, 40], [30, 20, 55, 55],
                                     [40, 20, 60, 60], [50, 20, 70, 70], [60, 20, 80, 80],
                                     [70, 20, 90, 90], [80, 20, 100, 100], [90, 20, 110, 110]], dtype=np.float32),
                    confidence=np.asarray([0.9] * 9, dtype=np.float32),
                    class_id=np.asarray([1, 2, 3, 4, 5, 6, 7, 8, 9], dtype=np.int32),
                )

        class FakeCV:
            COLOR_BGR2RGB = 1

            @staticmethod
            def cvtColor(frame, code):
                assert code == FakeCV.COLOR_BGR2RGB
                return frame[:, :, ::-1].copy()

        module = SimpleNamespace(RFDETRMedium=FakeModel, RFDETRLarge=FakeModel)
        torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        frame = np.zeros((100, 200, 3), dtype=np.uint8)
        frame[:, :, 0] = 10
        with patch.dict(sys.modules, {"rfdetr": module, "torch": torch}):
            adapter = RfDetrAdapter(SimpleNamespace(np=np, cv2=FakeCV), "weights.pth", {
                "confidenceThreshold": 0.25, "iouThreshold": 0.45, "detectorSize": "medium"})
            detections = adapter.infer(frame)

        self.assertEqual("cuda:0", adapter.device)
        self.assertEqual("RF-DETR Medium (COCO)", adapter.model_name)
        self.assertEqual(5, len(detections))
        self.assertEqual("bicycle", detections[0]["class"])
        self.assertEqual((0.0, 0.1, 0.15, 0.4), detections[0]["bboxXYXY"])
        self.assertEqual(["bicycle", "car", "motorcycle", "bus", "truck"],
                         [detection["class"] for detection in detections])
        self.assertEqual({1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1},
                         dict(adapter.raw_class_counts))
        self.assertEqual((0.15, 0.2, 0.275, 0.55), detections[1]["bboxXYXY"])
        self.assertEqual((0.2, 0.2, 0.3, 0.6), detections[2]["bboxXYXY"])
        self.assertEqual((0.3, 0.2, 0.4, 0.8), detections[3]["bboxXYXY"])
        self.assertEqual((0.4, 0.2, 0.5, 1.0), detections[4]["bboxXYXY"])
        np.testing.assert_array_equal(adapter.model.image[0, 0], [0, 0, 10])
        self.assertEqual(0.25, adapter.model.threshold)

    def test_configure_uses_detector_and_yolo_settings_from_environment_only_as_fallback(self):
        import os
        from unittest.mock import patch

        class Detector:
            backend = "rfdetr"
            model_name = "RF-DETR test"
            device = "cpu"
            target_device = "cuda:0"

        cases = (({"modelPath": "weights.pth", "detectorBackend": "rfdetr"}, "large", None, None),
                 ({"modelPath": "weights.pth", "detectorBackend": "rfdetr", "detectorSize": "medium"}, "medium", None, None),
                 ({"modelPath": "weights.pt", "detectorBackend": "yolo26"}, "large", "960", "false"),
                 ({"modelPath": "weights.pt", "detectorBackend": "yolo26", "detectorSize": "medium",
                   "inputSize": 640, "nms": True}, "medium", 640, True))
        for config, expected_detector_size, expected_input_size, expected_nms in cases:
            worker = Worker()
            seen = {}

            def fake_detector(actual_config):
                seen.update(actual_config)
                return Detector()

            worker.detector = fake_detector
            try:
                with patch.dict(os.environ, {"VISION_DETECTOR_SIZE": "large"}):
                    with patch.dict(os.environ, {"VISION_INPUT_SIZE": "960", "VISION_YOLO_NMS": "false"}):
                        response = worker.configure({"sourceId": "source", "sessionId": str(expected_detector_size),
                                                     "config": config})
                self.assertEqual(expected_detector_size, seen["detectorSize"])
                if expected_input_size is not None:
                    self.assertEqual(expected_input_size, seen["inputSize"])
                if expected_nms is not None:
                    self.assertEqual(expected_nms, seen["nms"])
                self.assertEqual("rfdetr", response["model"]["backend"])
            finally:
                worker.executor.shutdown(wait=True)

    def test_yolo26_adapter_maps_result_names_and_honors_input_size(self):
        import os
        import sys
        from unittest.mock import patch

        class FakeModel:
            def __init__(self, model_path):
                self.model_path = model_path
                self.names = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle",
                              4: "airplane", 5: "bus", 6: "train", 7: "truck", 8: "boat"}
                self.model = SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device="cpu")]))

            def predict(self, source, imgsz, conf, iou, nms, device, verbose):
                self.args = (source, imgsz, conf, iou, nms, device, verbose)
                return [SimpleNamespace(names=self.names, boxes=SimpleNamespace(
                    xyxy=np.asarray([[5, 5, 8, 8], [20, 20, 50, 50], [30, 20, 55, 55],
                                     [40, 20, 60, 60], [50, 20, 70, 70], [60, 20, 80, 80],
                                     [70, 20, 90, 90], [80, 20, 100, 100], [90, 20, 110, 110]], dtype=np.float32),
                    conf=np.asarray([0.9] * 9, dtype=np.float32),
                    cls=np.asarray([0, 1, 2, 3, 4, 5, 6, 7, 8], dtype=np.float32)))]

        class FakeTorch:
            cuda = SimpleNamespace(is_available=lambda: True)

        yolo_module = SimpleNamespace(YOLO=FakeModel)
        frame = np.zeros((100, 200, 3), dtype=np.uint8)
        with patch.dict(sys.modules, {"ultralytics": yolo_module, "torch": FakeTorch}), \
                patch.dict(os.environ, {"VISION_INPUT_SIZE": "960"}):
            adapter = Yolo26Adapter(SimpleNamespace(np=np, cv2=cv2), "weights.pt", {
                "confidenceThreshold": 0.25, "iouThreshold": 0.45})
            detections = adapter.infer(frame)

        self.assertEqual(960, adapter.input_size)
        self.assertEqual("YOLO26 Medium (COCO, imgsz=960, nms=True)", adapter.model_name)
        self.assertEqual(5, len(detections))
        self.assertEqual(["bicycle", "car", "motorcycle", "bus", "truck"],
                         [detection["class"] for detection in detections])
        self.assertEqual((0.1, 0.2, 0.25, 0.5), detections[0]["bboxXYXY"])
        self.assertEqual(960, adapter.model.args[1])
        self.assertTrue(adapter.model.args[4])
        self.assertEqual(0, adapter.model.args[5])
        self.assertIs(frame, adapter.model.args[0])
        self.assertEqual({0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1},
                         dict(adapter.raw_class_counts))

    def test_yolo26_explicit_input_size_overrides_environment_and_rejects_unbounded_sizes(self):
        import os
        import sys
        from unittest.mock import patch

        class FakeModel:
            def __init__(self, model_path):
                self.model = SimpleNamespace(parameters=lambda: iter([SimpleNamespace(device="cpu")]))

        modules = {"ultralytics": SimpleNamespace(YOLO=FakeModel),
                   "torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"VISION_INPUT_SIZE": "960", "VISION_YOLO_NMS": "false"}):
            adapter = Yolo26Adapter(SimpleNamespace(np=np, cv2=cv2), "weights.pt", {"inputSize": 640, "nms": True})
            self.assertEqual(640, adapter.input_size)
            self.assertTrue(adapter.nms)
            with self.assertRaisesRegex(ValueError, "640, 960, or 1280"):
                Yolo26Adapter(SimpleNamespace(np=np, cv2=cv2), "weights.pt", {"inputSize": 1536})

    def test_yolo26_scene_suppresses_only_near_identical_cross_class_boxes(self):
        from unittest.mock import patch

        exact_duplicate = [
            {"bboxXYXY": (0.751854, 0.746259, 0.777663, 0.777329), "class": "truck", "confidence": 0.91},
            {"bboxXYXY": (0.751821, 0.746232, 0.777622, 0.777463), "class": "car", "confidence": 0.84},
        ]
        overlapping_vehicles = [
            {"bboxXYXY": (0.200, 0.300, 0.310, 0.410), "class": "car", "confidence": 0.82},
            {"bboxXYXY": (0.225, 0.305, 0.335, 0.415), "class": "truck", "confidence": 0.79},
        ]
        adapter = Yolo26Adapter.__new__(Yolo26Adapter)
        adapter.cross_class_duplicate_iou_threshold = 0.985
        adapter.cross_class_duplicate_suppressed = 0
        with patch.object(OnnxYolo, "infer_scene", return_value=(exact_duplicate + overlapping_vehicles, "full_frame_tiled", 6)):
            detections, mode, regions = adapter.infer_scene(np.zeros((10, 10, 3)), {}, "auto")

        self.assertEqual("full_frame_tiled", mode)
        self.assertEqual(6, regions)
        self.assertEqual(1, adapter.cross_class_duplicate_suppressed)
        self.assertEqual(["truck", "car", "truck"], [item["class"] for item in detections])
        self.assertEqual(3, len(detections))


if __name__ == "__main__":
    unittest.main()
