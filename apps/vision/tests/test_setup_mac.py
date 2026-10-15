import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import setup_mac


class MacSetupConfigurationTests(unittest.TestCase):
    def test_architecture_selects_supported_local_profile(self):
        self.assertEqual("yolo26", setup_mac.detector_profile_for_arch("arm64"))
        self.assertEqual("yolo26", setup_mac.detector_profile_for_arch("aarch64"))
        self.assertEqual("onnx", setup_mac.detector_profile_for_arch("x86_64"))
        self.assertEqual("onnx", setup_mac.detector_profile_for_arch("AMD64"))
        with self.assertRaises(ValueError):
            setup_mac.detector_profile_for_arch("riscv64")

    def test_fresh_environment_gets_repo_relative_worker_and_model_paths(self):
        with tempfile.TemporaryDirectory(dir=setup_mac.ROOT) as temporary:
            root = Path(temporary)
            (root / ".env.example").write_text("API_PORT=4100\nVISION_PYTHON=\nVISION_MODEL_PATH=\n", encoding="utf-8")
            with patch.object(setup_mac, "REPO", root):
                setup_mac.initialize_env("yolo26")
            contents = (root / ".env").read_text(encoding="utf-8")
            self.assertIn("API_PORT=4100", contents)
            self.assertIn("VISION_PYTHON=apps/vision/.venv-worker/bin/python", contents)
            self.assertIn("VISION_MODEL_PATH=apps/vision/models/yolo26/yolo26m.pt", contents)
            self.assertIn("VISION_DETECTOR_BACKEND=yolo26", contents)
            self.assertIn("VISION_DEVICE=auto", contents)

    def test_existing_environment_is_never_overwritten(self):
        with tempfile.TemporaryDirectory(dir=setup_mac.ROOT) as temporary:
            root = Path(temporary)
            env_file = root / ".env"
            env_file.write_text("USER_SETTING=preserve\n", encoding="utf-8")
            with patch.object(setup_mac, "REPO", root):
                setup_mac.initialize_env("onnx")
            self.assertEqual("USER_SETTING=preserve\n", env_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
