import io
import json
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from youtube_source import YoutubeSourceError, YoutubeVideo, canonical_youtube_url, resolve_youtube_video, youtube_video_id
from worker import LatestFrameReader, Worker

TEST_TEMP = Path(__file__).resolve().parents[1] / ".tmp"
TEST_TEMP.mkdir(exist_ok=True)


def make_synthetic_upload(test_case, source_id):
    """Create a disposable upload path for tests without requiring user media."""
    project_root = next(parent for parent in Path(__file__).resolve().parents
                        if (parent / "apps" / "vision" / "worker.py").is_file())
    uploads_root = project_root / "uploads"
    uploads_root_existed = uploads_root.is_dir()
    uploads_root.mkdir(parents=True, exist_ok=True)
    if not uploads_root_existed:
        def remove_empty_upload_root():
            if uploads_root.is_dir() and not any(uploads_root.iterdir()):
                uploads_root.rmdir()
        test_case.addCleanup(remove_empty_upload_root)
    temporary_upload_dir = tempfile.TemporaryDirectory(dir=uploads_root)
    test_case.addCleanup(temporary_upload_dir.cleanup)
    upload = Path(temporary_upload_dir.name) / f"{source_id}.mp4"
    upload.write_bytes(b"synthetic upload fixture")
    return upload


class YoutubeResolverTests(unittest.TestCase):
    def test_only_single_youtube_video_url_shapes_are_accepted(self):
        cases = {
            "https://www.youtube.com/watch?v=1EiC9bvVGnk&list=PLanything": "1EiC9bvVGnk",
            "https://youtube.com/live/1EiC9bvVGnk?si=share": "1EiC9bvVGnk",
            "https://youtu.be/1EiC9bvVGnk?t=42": "1EiC9bvVGnk",
        }
        for url, expected in cases.items():
            with self.subTest(url=url):
                self.assertEqual(youtube_video_id(url), expected)
        self.assertEqual(canonical_youtube_url("1EiC9bvVGnk"), "https://www.youtube.com/watch?v=1EiC9bvVGnk")
        for url in (
            "https://example.com/watch?v=1EiC9bvVGnk",
            "https://www.youtube.com/playlist?list=PLanything",
            "https://www.youtube.com/shorts/1EiC9bvVGnk",
            "https://user:pass@www.youtube.com/watch?v=1EiC9bvVGnk",
            "https://www.youtube.com.evil.example/watch?v=1EiC9bvVGnk",
            "https://www.youtube.com/watch?v=1EiC9bvVGnk&v=1H0iTzv2jiQ",
        ):
            with self.subTest(url=url), self.assertRaises(YoutubeSourceError):
                youtube_video_id(url)

    def test_resolver_requests_one_video_only_and_never_exposes_signed_url_in_errors(self):
        class FakeYoutubeDL:
            def __init__(self, options):
                self.options = options
                self.__class__.last_options = options

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, url, download=False):
                self.__class__.last_url = url
                return {"id": "1EiC9bvVGnk", "title": "Camera", "is_live": True,
                        "live_status": "is_live", "url": "https://rr.googlevideo.com/videoplayback?sig=secret"}

        fake_module = SimpleNamespace(YoutubeDL=FakeYoutubeDL, dependencies=SimpleNamespace(yt_dlp_ejs=object()))
        with patch("youtube_source.shutil.which", return_value="C:\\tools\\node.exe"), patch.dict(sys.modules, {"yt_dlp": fake_module}):
            resolved = resolve_youtube_video("https://youtu.be/1EiC9bvVGnk")
        self.assertEqual(FakeYoutubeDL.last_url, "https://www.youtube.com/watch?v=1EiC9bvVGnk")
        self.assertTrue(FakeYoutubeDL.last_options["noplaylist"])
        self.assertIn("height<=1080", FakeYoutubeDL.last_options["format"])
        self.assertEqual(FakeYoutubeDL.last_options["format"], "bestvideo[height<=1080]/best[height<=1080]")
        self.assertEqual(FakeYoutubeDL.last_options["js_runtimes"], {"node": {"path": "C:\\tools\\node.exe"}})
        self.assertFalse(FakeYoutubeDL.last_options["cachedir"])
        logger = FakeYoutubeDL.last_options["logger"]
        for method in ("debug", "info", "warning", "error"):
            self.assertIsNone(getattr(logger, method)("https://rr.googlevideo.com/videoplayback?sig=secret"))
        self.assertEqual(resolved.live_status, "is_live")
        self.assertTrue(resolved.is_live)
        self.assertIn("sig=secret", resolved.media_url)

        class FailingYoutubeDL(FakeYoutubeDL):
            def extract_info(self, _url, download=False):
                raise RuntimeError("403 https://rr.googlevideo.com/videoplayback?sig=private")

        with patch("youtube_source.shutil.which", return_value="node.exe"), patch.dict(sys.modules, {"yt_dlp": SimpleNamespace(YoutubeDL=FailingYoutubeDL, dependencies=SimpleNamespace(yt_dlp_ejs=object()))}):
            with self.assertRaises(YoutubeSourceError) as error:
                resolve_youtube_video("https://www.youtube.com/watch?v=1EiC9bvVGnk")
        self.assertNotIn("googlevideo", str(error.exception))
        self.assertNotIn("googlevideo.com", str(error.exception))
        self.assertIn("could not provide a playable video stream", str(error.exception))

    def test_missing_local_ejs_or_node_is_actionable_and_anonymous_bot_gate_is_distinguished(self):
        fake_module = SimpleNamespace(dependencies=SimpleNamespace(yt_dlp_ejs=object()))
        with patch("youtube_source.shutil.which", return_value=None), patch.dict(sys.modules, {"yt_dlp": fake_module}):
            with self.assertRaisesRegex(YoutubeSourceError, "Node.js 22 or newer"):
                resolve_youtube_video("https://youtu.be/1EiC9bvVGnk")

        no_ejs = SimpleNamespace(dependencies=SimpleNamespace(yt_dlp_ejs=None))
        with patch.dict(sys.modules, {"yt_dlp": no_ejs}):
            with self.assertRaisesRegex(YoutubeSourceError, "challenge scripts are missing"):
                resolve_youtube_video("https://youtu.be/1EiC9bvVGnk")

        class BotGateYoutubeDL:
            def __init__(self, options): self.options = options
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def extract_info(self, _url, download=False):
                self.options["logger"].warning("Some JavaScript challenge methods failed")
                raise RuntimeError("Sign in to confirm you're not a bot: https://googlevideo.example/watch?sig=private")

        configured = SimpleNamespace(YoutubeDL=BotGateYoutubeDL, dependencies=SimpleNamespace(yt_dlp_ejs=object()))
        with patch("youtube_source.shutil.which", return_value="node.exe"), patch.dict(sys.modules, {"yt_dlp": configured}):
            with self.assertRaises(YoutubeSourceError) as error:
                resolve_youtube_video("https://youtu.be/1EiC9bvVGnk")
        self.assertIn("refused this anonymous request", str(error.exception))
        self.assertIn("account cookies are not used", str(error.exception))
        self.assertNotIn("googlevideo", str(error.exception))


class YoutubePreviewWorkerTests(unittest.TestCase):
    def test_upload_frame_notification_is_paired_to_event_and_written_before_notice(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("OpenCV/NumPy unavailable")

        class FakeCapture:
            def __init__(self, image):
                self.image = image
                self.calls = 0
                self.released = False

            def isOpened(self):
                return True

            def read(self):
                self.calls += 1
                return (True, self.image) if self.calls == 1 else (False, None)

            def get(self, key):
                if key == cv2.CAP_PROP_FPS:
                    return 25.0
                if key == cv2.CAP_PROP_POS_MSEC:
                    return 1250.0
                return 0.0

            def release(self):
                self.released = True

        source_id = "11111111-1111-4111-8111-111111111111"
        session_id = "22222222-2222-4222-8222-222222222222"
        image = np.zeros((1080, 1920, 3), dtype=np.uint8)
        capture = FakeCapture(image)
        worker = Worker()
        events = []

        def fake_frame(source, session, frame, source_time_ms, frame_id):
            return {"sourceId": source, "sessionId": session, "sourceTimeMs": source_time_ms,
                    "frameId": frame_id, "frameWidth": int(frame.shape[1]),
                    "frameHeight": int(frame.shape[0]), "detections": [], "crossings": [],
                    "quality": {"coverage": "known", "notes": []}}

        worker.frame = fake_frame
        worker.event = lambda event: events.append(event)
        job = {"jobId": "job-native-frame", "sourceId": source_id, "sessionId": session_id,
               "cancel": threading.Event()}
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir, \
             patch.object(cv2, "VideoCapture", return_value=capture):
            worker.run_job(job, "analyze_upload", {
                "filePath": "unused.mp4", "sampleEveryMs": 500, "frameArtifactDir": temp_dir,
            })
            self.assertEqual(2, len(events))
            analysis, artifact = events
            self.assertEqual("analysis_frame", artifact["type"])
            self.assertEqual(analysis["frameId"], artifact["frameId"])
            self.assertEqual(analysis["sourceId"], artifact["sourceId"])
            self.assertEqual(analysis["sessionId"], artifact["sessionId"])
            self.assertEqual(analysis["sourceTimeMs"], artifact["sourceTimeMs"])
            self.assertEqual((1920, 1080), (artifact["frameWidth"], artifact["frameHeight"]))
            staged = Path(temp_dir) / source_id / session_id / artifact["artifactName"]
            self.assertTrue(staged.is_file())
            decoded = cv2.imread(str(staged))
            self.assertEqual((1080, 1920), decoded.shape[:2])
        self.assertTrue(capture.released)
        worker.executor.shutdown(wait=True)

    def test_analysis_frame_artifact_is_native_sized_bounded_and_has_no_public_url(self):
        class FakeImage:
            shape = (1080, 1920, 3)

        image = FakeImage()
        calls = []

        class Encoded:
            def tobytes(self):
                return b"\xff\xd8\xff\xd9"

        fake_cv2 = SimpleNamespace(
            IMWRITE_JPEG_QUALITY=1,
            imencode=lambda ext, received, params: calls.append((ext, received, params)) or (True, Encoded()),
        )
        worker = Worker()
        worker.cv2 = fake_cv2
        source_id = "11111111-1111-4111-8111-111111111111"
        session_id = "22222222-2222-4222-8222-222222222222"
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
            results = []
            for _ in range(6):
                frame_id = str(uuid.uuid4())
                results.append(worker._write_analysis_frame(image, temp_dir, source_id, session_id, 1250, frame_id))
            session_dir = Path(temp_dir) / source_id / session_id
            self.assertEqual(4, len(list(session_dir.glob("*.jpg"))))
            self.assertEqual((".jpg", image, [1, 88]), calls[0])
            latest = results[-1]
            self.assertEqual(1920, latest["frameWidth"])
            self.assertEqual(1080, latest["frameHeight"])
            self.assertEqual("image/jpeg", latest["mimeType"])
            self.assertEqual(f"{latest['frameId']}.jpg", latest["artifactName"])
            self.assertEqual(b"\xff\xd8\xff\xd9", (session_dir / latest["artifactName"]).read_bytes())
            self.assertEqual("analysis_frame", latest["type"])
            self.assertNotIn("url", latest)
        worker.executor.shutdown(wait=True)

    def test_analysis_frame_path_parts_must_be_uuids(self):
        worker = Worker()
        worker.cv2 = SimpleNamespace()
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
            with self.assertRaisesRegex(RuntimeError, "original analyzed frame"):
                worker._write_analysis_frame(SimpleNamespace(shape=(10, 10, 3)), temp_dir,
                                             "../escape", "session", 0,
                                             "33333333-3333-4333-8333-333333333333")
        worker.executor.shutdown(wait=True)

    def test_legacy_upload_frame_redecode_is_local_bounded_and_does_not_run_inference(self):
        import numpy as np

        source_id = "7473a6f0-1070-41f5-82ae-d6680abe7164"
        session_id = "3392b95c-559f-4ac3-899b-8264e7243eb9"
        event_id = "4963a1ba1a9b26b8a8c28ffbfe44051213396231d2026535edf7e165b5817bed"
        artifact_id = "22222222-2222-4222-8222-222222222222"
        upload = make_synthetic_upload(self, source_id)

        class FakeCapture:
            def __init__(self):
                self.released = False
                self.requested = None

            def isOpened(self):
                return True

            def get(self, prop):
                return {1: 30.0, 2: 181 * 30}.get(prop, 500.0)

            def set(self, prop, value):
                self.requested = (prop, value)
                return True

            def read(self):
                return True, np.zeros((4, 8, 3), dtype=np.uint8)

            def release(self):
                self.released = True

        encoded_calls = []
        fake_capture = FakeCapture()
        class Encoded:
            def __len__(self):
                return 4

            def tobytes(self):
                return b"\xff\xd8\xff\xd9"

        cv2 = SimpleNamespace(
            CAP_PROP_FPS=1, CAP_PROP_FRAME_COUNT=2, CAP_PROP_POS_MSEC=3,
            IMWRITE_JPEG_QUALITY=4,
            VideoCapture=lambda path: self.assertEqual(str(upload.resolve()), path) or fake_capture,
            imencode=lambda ext, image, params: encoded_calls.append((ext, image.shape, params)) or (True, Encoded()),
        )
        worker = Worker()
        worker.cv2 = cv2
        worker.frame = lambda *_args, **_kwargs: self.fail("legacy re-decode must not run inference")
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
            result = worker.handle({"command": "extract_media_frame", "payload": {
                "sourceId": source_id, "sessionId": session_id, "eventId": event_id,
                "artifactId": artifact_id, "sourceTimeMs": 500,
                "expectedWidth": 8, "expectedHeight": 4,
                "filePath": str(upload), "artifactDir": str(Path(temp_dir).resolve()),
            }})
            self.assertEqual("verified_media_redecode", result["provenance"])
            self.assertEqual(500, result["decodedTimeMs"])
            self.assertEqual((8, 4), (result["frameWidth"], result["frameHeight"]))
            self.assertEqual(b"\xff\xd8\xff\xd9", (Path(temp_dir) / f"{artifact_id}.jpg").read_bytes())
            self.assertEqual((".jpg", (4, 8, 3), [4, 90]), encoded_calls[0])
        self.assertTrue(fake_capture.released)
        worker.executor.shutdown(wait=True)

    def test_legacy_frame_redecode_rejects_asset_escape_dimension_mismatch_and_time_mismatch(self):
        import numpy as np

        class FakeCapture:
            def __init__(self, decoded_ms=500):
                self.decoded_ms = decoded_ms
                self.released = False

            def isOpened(self):
                return True

            def get(self, prop):
                return {1: 30.0, 2: 181 * 30, 3: self.decoded_ms}.get(prop, 0)

            def set(self, _prop, _value):
                return True

            def read(self):
                return True, np.zeros((4, 8, 3), dtype=np.uint8)

            def release(self):
                self.released = True

        source_id = "7473a6f0-1070-41f5-82ae-d6680abe7164"
        session_id = "3392b95c-559f-4ac3-899b-8264e7243eb9"
        common = {"sourceId": source_id, "sessionId": session_id,
                  "eventId": "11111111-1111-4111-8111-111111111111",
                  "artifactId": "22222222-2222-4222-8222-222222222222",
                  "sourceTimeMs": 500, "expectedWidth": 8, "expectedHeight": 4}
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as project_temp:
            project_root = Path(project_temp)
            fake_worker = project_root / "apps" / "vision" / "worker.py"
            fake_worker.parent.mkdir(parents=True)
            fake_worker.touch()
            uploads_root = project_root / "uploads"
            uploads_root.mkdir()
            upload = uploads_root / f"{source_id}.mp4"
            upload.write_bytes(b"synthetic upload fixture")
            with patch("worker.__file__", str(fake_worker)):
                worker = Worker()
                current_capture = FakeCapture(decoded_ms=700)
                worker.cv2 = SimpleNamespace(
                    CAP_PROP_FPS=1, CAP_PROP_FRAME_COUNT=2, CAP_PROP_POS_MSEC=3,
                    IMWRITE_JPEG_QUALITY=4,
                    VideoCapture=lambda _path: current_capture,
                    imencode=lambda *_args: (True, SimpleNamespace(tobytes=lambda: b"\xff\xd8\xff\xd9")),
                )
                with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
                    payload = {**common, "filePath": str(Path(__file__).resolve()),
                               "artifactDir": str(Path(temp_dir).resolve())}
                    with self.assertRaisesRegex(RuntimeError, "inside the local uploads"):
                        worker.extract_media_frame(payload)
                    payload["filePath"] = str(upload)
                    payload["expectedWidth"] = 9
                    with self.assertRaisesRegex(RuntimeError, "dimensions do not match"):
                        worker.extract_media_frame(payload)
                    payload["expectedWidth"] = 8
                    with self.assertRaisesRegex(RuntimeError, "timestamp does not closely match"):
                        worker.extract_media_frame(payload)
                    self.assertFalse((Path(temp_dir) / f"{common['artifactId']}.jpg").exists())
        worker.executor.shutdown(wait=True)

    def test_legacy_frame_redecode_removes_partial_temporary_artifact_after_write_failure(self):
        import numpy as np

        class Encoded:
            def __len__(self):
                return 4

            def tobytes(self):
                return b"\xff\xd8\xff\xd9"

        class FakeCapture:
            def isOpened(self):
                return True

            def get(self, prop):
                return {1: 30.0, 2: 181 * 30, 3: 500.0}.get(prop, 0)

            def set(self, _prop, _value):
                return True

            def read(self):
                return True, np.zeros((4, 8, 3), dtype=np.uint8)

            def release(self):
                pass

        source_id = "7473a6f0-1070-41f5-82ae-d6680abe7164"
        session_id = "3392b95c-559f-4ac3-899b-8264e7243eb9"
        artifact_id = "22222222-2222-4222-8222-222222222222"
        upload = make_synthetic_upload(self, source_id)
        worker = Worker()
        worker.cv2 = SimpleNamespace(
            CAP_PROP_FPS=1, CAP_PROP_FRAME_COUNT=2, CAP_PROP_POS_MSEC=3, IMWRITE_JPEG_QUALITY=4,
            VideoCapture=lambda _path: FakeCapture(),
            imencode=lambda *_args: (True, Encoded()),
        )
        original_write_bytes = Path.write_bytes

        def failing_temp_write(path, data):
            if path.name.endswith(".tmp.jpg"):
                raise OSError("simulated disk write failure")
            return original_write_bytes(path, data)

        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
            payload = {"sourceId": source_id, "sessionId": session_id,
                       "eventId": "1111111111111111111111111111111111111111111111111111111111111111",
                       "artifactId": artifact_id, "sourceTimeMs": 500,
                       "expectedWidth": 8, "expectedHeight": 4,
                       "filePath": str(upload), "artifactDir": str(Path(temp_dir).resolve())}
            with patch.object(Path, "write_bytes", failing_temp_write):
                with self.assertRaisesRegex(OSError, "simulated disk write failure"):
                    worker.extract_media_frame(payload)
            self.assertFalse((Path(temp_dir) / f"{artifact_id}.tmp.jpg").exists())
            self.assertFalse((Path(temp_dir) / f"{artifact_id}.jpg").exists())
        worker.executor.shutdown(wait=True)

    def test_remote_capture_requires_explicit_open_and_read_timeouts(self):
        calls = []

        class FakeCapture:
            def isOpened(self):
                return True

            def release(self):
                calls.append(("release",))

        cv2 = SimpleNamespace(CAP_PROP_OPEN_TIMEOUT_MSEC=1, CAP_PROP_READ_TIMEOUT_MSEC=2,
                              CAP_FFMPEG=3, VideoCapture=lambda *args: calls.append(args) or FakeCapture())
        worker = Worker()
        worker.cv2 = cv2
        self.assertIsInstance(worker._open_remote_capture("https://example.test/media"), FakeCapture)
        self.assertEqual(calls[0], ("https://example.test/media", 3, [1, 10_000, 2, 8_000]))

        worker.cv2 = SimpleNamespace(VideoCapture=lambda *_args: self.fail("unsafe unbounded fallback was used"))
        with self.assertRaisesRegex(RuntimeError, "bounded YouTube stream timeouts"):
            worker._open_remote_capture("https://example.test/media")

    def test_probe_writes_decoded_jpeg_with_ephemeral_session_metadata_only(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest("OpenCV/NumPy unavailable")

        class FakeCapture:
            def __init__(self):
                self.released = False

            def read(self):
                return True, np.zeros((1080, 1920, 3), dtype=np.uint8)

            def release(self):
                self.released = True

        capture = FakeCapture()
        worker = Worker()
        video = YoutubeVideo("1EiC9bvVGnk", "Camera", True, "is_live", "https://rr.googlevideo.com/video?sig=secret")
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir, \
             patch("worker.resolve_youtube_video", return_value=video), \
             patch.object(worker, "_open_remote_capture", return_value=capture):
            result = worker.probe_youtube({"sourceId": "00000000-0000-4000-8000-000000000001",
                                           "sessionId": "00000000-0000-4000-8000-000000000002",
                                           "url": "https://www.youtube.com/watch?v=1EiC9bvVGnk",
                                           "previewDir": temp_dir})
            self.assertEqual(result["width"], 1280)
            self.assertEqual(result["height"], 720)
            self.assertEqual(result["sourceWidth"], 1920)
            self.assertEqual(result["sourceHeight"], 1080)
            self.assertTrue(result["isLive"])
            self.assertNotIn("media_url", result)
            image_path = Path(temp_dir) / result["sourceId"] / result["sessionId"] / f"{result['frameId']}.jpg"
            decoded = cv2.imread(str(image_path))
            self.assertEqual(decoded.shape[:2], (720, 1280))
            self.assertTrue(capture.released)

    def test_preview_cache_keeps_only_a_small_latest_frame_window_and_removes_old_sessions(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy unavailable")
        worker = Worker()
        image = np.zeros((32, 48, 3), dtype=np.uint8)
        source_id = "00000000-0000-4000-8000-000000000001"
        with tempfile.TemporaryDirectory(dir=TEST_TEMP) as temp_dir:
            for index in range(8):
                worker._write_preview(image, temp_dir, source_id,
                                      "00000000-0000-4000-8000-000000000002", index * 500,
                                      notify=False)
            session_dir = Path(temp_dir) / source_id / "00000000-0000-4000-8000-000000000002"
            self.assertEqual(len(list(session_dir.glob("*.jpg"))), 4)
            worker._write_preview(image, temp_dir, source_id,
                                  "00000000-0000-4000-8000-000000000003", 0, notify=False)
            self.assertFalse((Path(temp_dir) / source_id / "00000000-0000-4000-8000-000000000002").exists())
            self.assertEqual(len(list((Path(temp_dir) / source_id).glob("*/*.jpg"))), 1)

    def test_vod_uses_media_timestamps_and_pairs_preview_with_the_analyzed_frame(self):
        import cv2
        import numpy as np

        class FakeCapture:
            def __init__(self):
                self.calls = 0
                self.released = False

            def read(self):
                self.calls += 1
                return (True, np.zeros((24, 32, 3), dtype=np.uint8)) if self.calls == 1 else (False, None)

            def get(self, key):
                return 25.0 if key == cv2.CAP_PROP_FPS else 1250.0

            def release(self):
                self.released = True

        capture = FakeCapture()
        worker = Worker()
        video = YoutubeVideo("1EiC9bvVGnk", "Camera", False, "not_live", "https://rr.googlevideo.com/video?sig=secret")
        pairings = []
        worker.frame = lambda source, session, image, timestamp: {"sourceId": source, "sessionId": session, "sourceTimeMs": timestamp}
        worker.event = lambda event: pairings.append(("analysis", event["sourceTimeMs"]))
        worker._write_preview = lambda image, directory, source, session, timestamp, *, notify: pairings.append(("preview", timestamp)) or {"sourceTimeMs": timestamp}
        job = {"jobId": "job-vod", "sourceId": "source", "sessionId": "session", "cancel": threading.Event()}
        with patch("worker.resolve_youtube_video", return_value=video), patch.object(worker, "_open_remote_capture", return_value=capture):
            worker.run_job(job, "analyze_youtube", {"url": "https://www.youtube.com/watch?v=1EiC9bvVGnk", "sampleEveryMs": 500, "previewDir": "unused"})
        self.assertEqual(pairings, [("analysis", 1250.0), ("preview", 1250.0)])
        self.assertTrue(capture.released)
        worker.protocol_stdout = io.StringIO()
        worker.finish_job(job, SimpleNamespace(exception=lambda: None))
        completion = json.loads(worker.protocol_stdout.getvalue())
        self.assertEqual(completion["event"]["type"], "job_complete")

    def test_live_reader_drains_native_rate_but_analysis_samples_latest_exact_frame(self):
        import numpy as np

        class FastLiveCapture:
            def __init__(self):
                self.read_count = 0
                self.released = False

            def read(self):
                time.sleep(0.002)
                self.read_count += 1
                return True, np.full((12, 16, 3), self.read_count % 255, dtype=np.uint8)

            def get(self, _key):
                return 30.0

            def release(self):
                self.released = True

        capture = FastLiveCapture()
        worker = Worker()
        video = YoutubeVideo("1EiC9bvVGnk", "Camera", True, "is_live", "https://rr.googlevideo.com/video?sig=secret")
        preview_pairs = []
        analysis_pairs = []

        def fake_frame(_source, _session, image, source_time_ms):
            analysis_pairs.append((int(image[0, 0, 0]), source_time_ms))
            return {"sourceId": "source", "sessionId": "session", "sourceTimeMs": source_time_ms}

        worker.frame = fake_frame
        worker.event = lambda _event: None
        worker._write_preview = lambda image, _directory, _source, _session, source_time_ms, *, notify: \
            preview_pairs.append((int(image[0, 0, 0]), source_time_ms)) or {"sourceTimeMs": source_time_ms}
        job = {"jobId": "job-live-rate", "sourceId": "source", "sessionId": "session", "cancel": threading.Event()}
        with patch("worker.resolve_youtube_video", return_value=video), \
             patch.object(worker, "_open_remote_capture", return_value=capture):
            thread = threading.Thread(target=worker.run_job, args=(job, "analyze_youtube", {
                "url": "https://www.youtube.com/watch?v=1EiC9bvVGnk", "sampleEveryMs": 500, "previewDir": "unused"
            }))
            thread.start()
            time.sleep(1.2)
            job["cancel"].set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(capture.released)
        self.assertGreaterEqual(capture.read_count, 25)
        self.assertLessEqual(capture.read_count, 40)
        self.assertGreaterEqual(len(analysis_pairs), 2)
        self.assertLessEqual(len(analysis_pairs), 4)
        self.assertEqual(preview_pairs, analysis_pairs)
        self.assertEqual(sorted(timestamp for _, timestamp in analysis_pairs),
                         [timestamp for _, timestamp in analysis_pairs])

    def test_burst_capture_is_paced_at_native_fps_without_backlog_or_catchup(self):
        class BufferedBurstCapture:
            """Models OpenCV draining already-buffered HLS frames immediately."""
            def __init__(self):
                self.read_count = 0

            def read(self):
                self.read_count += 1
                return True, self.read_count

        capture = BufferedBurstCapture()
        reader = LatestFrameReader(capture, capture_fps=30.0)
        try:
            time.sleep(0.37)
            latest = reader.latest
            self.assertIsNotNone(latest)
            self.assertGreaterEqual(capture.read_count, 9)
            self.assertLessEqual(capture.read_count, 13)
            self.assertGreaterEqual(latest[2], 250)
            self.assertLessEqual(latest[2], 450)
            # A single latest slot is retained, rather than a backlog of frames.
            self.assertEqual(reader.sequence, capture.read_count)
            self.assertEqual(latest[0], capture.read_count)
        finally:
            reader.stop()
        self.assertFalse(reader.thread.is_alive())

    def test_unknown_live_fps_uses_bounded_analysis_rate_pacing(self):
        class UnknownRateBurstCapture:
            def __init__(self):
                self.read_count = 0

            def read(self):
                self.read_count += 1
                return True, self.read_count

        capture = UnknownRateBurstCapture()
        reader = LatestFrameReader(capture, unknown_fps_interval=0.5)
        try:
            time.sleep(0.62)
            self.assertTrue(reader.unknown_fps)
            self.assertEqual(capture.read_count, 2)
        finally:
            reader.stop()

    def test_blocking_read_consumes_native_frame_interval_without_double_wait(self):
        class BlockingBurstCapture:
            def __init__(self):
                self.read_count = 0

            def read(self):
                time.sleep(0.05)
                self.read_count += 1
                return True, self.read_count

        capture = BlockingBurstCapture()
        reader = LatestFrameReader(capture, capture_fps=30.0)
        try:
            time.sleep(0.42)
            # The backend itself takes 50ms per frame, so we cannot reach
            # 30fps; we should nevertheless avoid adding another 33ms wait.
            self.assertGreaterEqual(capture.read_count, 7)
            self.assertLessEqual(capture.read_count, 10)
        finally:
            reader.stop()

    def test_small_timer_oversleep_does_not_accumulate_into_live_capture_drift(self):
        class OversleepEvent:
            def __init__(self):
                self.inner = threading.Event()

            def wait(self, timeout=None):
                return self.inner.wait(None if timeout is None else timeout + 0.01)

            def set(self):
                self.inner.set()

            def is_set(self):
                return self.inner.is_set()

        class FastCapture:
            def __init__(self):
                self.read_count = 0

            def read(self):
                self.read_count += 1
                return True, self.read_count

        capture = FastCapture()
        reader = LatestFrameReader(capture, capture_fps=30.0, stop_event=OversleepEvent())
        try:
            time.sleep(0.55)
            # A 10ms wake-up oversleep shifts phase but must not be added to
            # every frame interval. A reset-from-now loop would land near 13.
            self.assertGreaterEqual(capture.read_count, 14)
            self.assertLessEqual(capture.read_count, 19)
        finally:
            reader.stop()

    def test_vod_decodes_sequentially_and_samples_by_video_clock_without_wall_delay(self):
        import cv2
        import numpy as np

        class FastVodCapture:
            def __init__(self):
                self.calls = 0

            def read(self):
                if self.calls >= 90:
                    return False, None
                self.calls += 1
                return True, np.full((8, 12, 3), self.calls, dtype=np.uint8)

            def get(self, key):
                if key == cv2.CAP_PROP_FPS:
                    return 30.0
                if key == cv2.CAP_PROP_POS_MSEC:
                    return (self.calls - 1) * 1000 / 30
                return 0

            def release(self):
                return None

        capture = FastVodCapture()
        worker = Worker()
        video = YoutubeVideo("1EiC9bvVGnk", "Recording", False, "not_live", "https://rr.googlevideo.com/video?sig=secret")
        timestamps = []
        worker.frame = lambda _source, _session, _image, source_time_ms: timestamps.append(source_time_ms) or {"sourceTimeMs": source_time_ms}
        worker.event = lambda _event: None
        job = {"jobId": "job-vod-rate", "sourceId": "source", "sessionId": "session", "cancel": threading.Event()}
        with patch("worker.resolve_youtube_video", return_value=video), \
             patch.object(worker, "_open_remote_capture", return_value=capture):
            started = time.monotonic()
            worker.run_job(job, "analyze_youtube", {"url": "https://www.youtube.com/watch?v=1EiC9bvVGnk", "sampleEveryMs": 500})
            elapsed = time.monotonic() - started
        self.assertEqual(capture.calls, 90)
        self.assertEqual(timestamps, [0.0, 500.0, 1000.0, 1500.0, 2000.0, 2500.0])
        self.assertLess(elapsed, 1.0)

    def test_stop_waits_until_the_matching_job_future_finishes(self):
        from concurrent.futures import Future

        worker = Worker()
        cancel = threading.Event()
        future = Future()
        job = {"jobId": "job-stop", "sourceId": "source", "sessionId": "session", "cancel": cancel, "future": future}
        worker.jobs[job["jobId"]] = job
        releaser = threading.Thread(target=lambda: (time.sleep(0.05), future.set_result(None)))
        releaser.start()
        started = time.monotonic()
        result = worker.handle({"command": "stop", "payload": {"sourceId": "source", "sessionId": "session"}})
        elapsed = time.monotonic() - started
        releaser.join()
        self.assertTrue(cancel.is_set())
        self.assertTrue(future.done())
        self.assertNotIn(job["jobId"], worker.jobs)
        self.assertGreaterEqual(elapsed, 0.04)
        self.assertEqual(result, {"stopped": True})

    def test_live_eof_retries_are_bounded_and_fail_instead_of_reporting_completed(self):
        class FakeCapture:
            def read(self):
                return False, None

            def get(self, _key):
                return 0

            def release(self):
                return None

        class FastCancel(threading.Event):
            def wait(self, _timeout=None):
                return False

        worker = Worker()
        video = YoutubeVideo("1EiC9bvVGnk", "Camera", True, "is_live", "https://rr.googlevideo.com/video?sig=secret")
        job = {"jobId": "job-live", "sourceId": "source", "sessionId": "session", "cancel": FastCancel()}
        with patch("worker.resolve_youtube_video", return_value=video) as resolver, \
             patch.object(worker, "_open_remote_capture", side_effect=lambda _url: FakeCapture()):
            with self.assertRaisesRegex(RuntimeError, "disconnected after repeated reconnect attempts"):
                worker.run_job(job, "analyze_youtube", {"url": "https://www.youtube.com/watch?v=1EiC9bvVGnk", "sampleEveryMs": 500})
        self.assertEqual(resolver.call_count, 4)
        worker.protocol_stdout = io.StringIO()
        worker.finish_job(job, SimpleNamespace(exception=lambda: RuntimeError("YouTube live video disconnected after repeated reconnect attempts.")))
        completion = json.loads(worker.protocol_stdout.getvalue())
        self.assertEqual(completion["event"]["type"], "job_error")
        self.assertNotIn("sig=secret", worker.protocol_stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
