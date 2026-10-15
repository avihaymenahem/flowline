#!/usr/bin/env python3
"""Provision the local Mac vision runtime without modifying existing .env files."""

from __future__ import annotations

import hashlib
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
VENV = ROOT / ".venv-worker"
MODEL_DIR = ROOT / "models"
YOLO_MODEL = MODEL_DIR / "yolo26" / "yolo26m.pt"
ONNX_MODEL = MODEL_DIR / "object_detection_yolox_2022nov.onnx"
YOLO_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26m.pt"
YOLO_SHA256 = "401cea9ab23ad19246ff7744859816bc599f350e93c9dd30367b6f0a0745d0b7"
ONNX_URL = "https://huggingface.co/opencv/object_detection_yolox/resolve/c5c37f2482d90a975d2dc6a2d491f307cf41bd2d/object_detection_yolox_2022nov.onnx"
ONNX_SHA256 = "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"
PYTORCH = "2.10.0"
TORCHVISION = "0.25.0"
ULTRALYTICS = "8.4.175"


def run(*args: str) -> None:
    subprocess.run(args, cwd=REPO, check=True)


def detector_profile_for_arch(arch: str) -> str:
    normalized = arch.lower()
    if normalized in ("arm64", "aarch64"):
        return "yolo26"
    if normalized in ("x86_64", "amd64"):
        return "onnx"
    raise ValueError(f"Unsupported Mac architecture: {arch}")


def install_checkpoint(path: Path, url: str, expected_sha256: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        digest = hashlib.sha256()
        with path.open("rb") as checkpoint:
            for chunk in iter(lambda: checkpoint.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != expected_sha256:
            raise RuntimeError(f"Existing checkpoint checksum mismatch; left untouched: {path}")
        return
    partial = path.with_suffix(path.suffix + ".part")
    if partial.exists():
        raise RuntimeError(f"An earlier partial download exists; inspect it before retrying: {partial}")
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "traffic-dash-local-setup/1"})
        with urllib.request.urlopen(request, timeout=60) as response, partial.open("wb") as output:
            shutil.copyfileobj(response, output)
        digest = hashlib.sha256()
        with partial.open("rb") as checkpoint:
            for chunk in iter(lambda: checkpoint.read(1024 * 1024), b""):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != expected_sha256:
            raise RuntimeError(f"Downloaded checkpoint SHA-256 mismatch; partial retained at {partial}")
        partial.replace(path)
    except Exception:
        # Keep a completed or suspect partial download for inspection/recovery.
        raise


def initialize_env(profile: str) -> None:
    env_file = REPO / ".env"
    if env_file.exists():
        print("Existing .env found; it was left unchanged. Check its VISION_* settings if needed.")
        return
    example = REPO / ".env.example"
    lines = example.read_text(encoding="utf-8").splitlines() if example.exists() else []
    generated_keys = {
        "VISION_PYTHON", "VISION_WORKER_SCRIPT", "VISION_MODEL_PATH",
        "VISION_DETECTOR_BACKEND", "VISION_DETECTOR_SIZE", "VISION_INPUT_SIZE",
        "VISION_YOLO_NMS", "VISION_DEVICE", "YOLO_CONFIG_DIR",
    }
    kept = [line for line in lines if line.partition("=")[0].strip() not in generated_keys]
    model = "apps/vision/models/yolo26/yolo26m.pt" if profile == "yolo26" else "apps/vision/models/object_detection_yolox_2022nov.onnx"
    settings = [
        "", "# Added by npm run setup:mac.",
        "VISION_PYTHON=apps/vision/.venv-worker/bin/python",
        "VISION_WORKER_SCRIPT=apps/vision/worker.py",
        f"VISION_MODEL_PATH={model}",
        f"VISION_DETECTOR_BACKEND={profile}",
        f"VISION_DEVICE={'auto' if profile == 'yolo26' else 'cpu'}",
    ]
    if profile == "yolo26":
        settings += [
            "VISION_DETECTOR_SIZE=medium",
            "VISION_INPUT_SIZE=640",
            "VISION_YOLO_NMS=true",
            "YOLO_CONFIG_DIR=apps/vision/.tmp/yolo-config",
        ]
    env_file.write_text("\n".join(kept + settings).rstrip() + "\n", encoding="utf-8")
    print(f"Created .env with the {profile} local detector profile.")


def main() -> int:
    if sys.platform != "darwin":
        print("This setup entry is for macOS only. On Windows, use npm run setup:vision.", file=sys.stderr)
        return 2
    if sys.version_info[:2] not in ((3, 12), (3, 13)):
        print("Python 3.12 or 3.13 is required. Install it from python.org or your preferred package manager, then retry.", file=sys.stderr)
        return 2
    try:
        macos_version = tuple(int(part) for part in platform.mac_ver()[0].split(".")[:2])
    except ValueError:
        macos_version = ()
    if macos_version and macos_version < (14, 0):
        print("macOS 14 (Sonoma) or newer is required by the pinned vision wheels.", file=sys.stderr)
        return 2
    arch = platform.machine().lower()
    try:
        profile = detector_profile_for_arch(arch)
    except ValueError:
        print(f"Unsupported Mac architecture: {arch}", file=sys.stderr)
        return 2
    apple_silicon = profile == "yolo26"

    if not (VENV / "bin" / "python").exists():
        run(sys.executable, "-m", "venv", str(VENV))
    python = str(VENV / "bin" / "python")
    run(python, "-m", "pip", "install", "-e", str(ROOT))
    install_checkpoint(ONNX_MODEL, ONNX_URL, ONNX_SHA256)
    if apple_silicon:
        # These are the official macOS arm64 wheel pins paired in PyTorch's
        # installation matrix. No CUDA index or Windows-only extra is used.
        run(python, "-m", "pip", "install", f"torch=={PYTORCH}", f"torchvision=={TORCHVISION}")
        run(python, "-m", "pip", "install", f"ultralytics=={ULTRALYTICS}")
        install_checkpoint(YOLO_MODEL, YOLO_URL, YOLO_SHA256)
    else:
        # Current official PyTorch release wheels target macOS arm64. Intel
        # Macs use the project's OpenCV Zoo ONNX Runtime CPU path instead.
        pass
    initialize_env(profile)
    verify = (
        "import cv2,numpy,onnxruntime; "
        "print('OpenCV',cv2.__version__,'NumPy',numpy.__version__,'ONNX Runtime',onnxruntime.__version__)"
    )
    if apple_silicon:
        verify += "; import torch,torchvision,ultralytics; print('PyTorch',torch.__version__,'torchvision',torchvision.__version__,'Ultralytics',ultralytics.__version__,'MPS built/available',torch.backends.mps.is_built(),torch.backends.mps.is_available())"
    run(python, "-c", verify)
    print(f"Mac vision runtime ready ({'Apple Silicon' if apple_silicon else 'Intel CPU'}). Start the app with npm run dev.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Setup command failed with exit code {exc.returncode}: {exc.cmd}", file=sys.stderr)
        raise SystemExit(exc.returncode or 1)
