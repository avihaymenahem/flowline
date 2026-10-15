Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$visionDir = $PSScriptRoot
$runtimeDir = Join-Path $visionDir ".venv-yolo26"
$runtimePython = Join-Path $runtimeDir "Scripts/python.exe"
$localPython = Join-Path $visionDir ".venv-worker/Scripts/python.exe"
$tempDir = Join-Path $visionDir ".tmp/python-temp"
$pipCache = Join-Path $visionDir ".tmp/pip-cache"
$configDir = Join-Path $visionDir ".tmp/yolo-config"
$modelDir = Join-Path $visionDir "models/yolo26"
$modelPath = Join-Path $modelDir "yolo26m.pt"
$partialPath = "$modelPath.part"
$modelUrl = "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26m.pt"
$expectedSha256 = "401cea9ab23ad19246ff7744859816bc599f350e93c9dd30367b6f0a0745d0b7"

New-Item -ItemType Directory -Force $tempDir, $pipCache, $configDir, $modelDir | Out-Null
$env:TEMP = (Resolve-Path $tempDir).Path
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = (Resolve-Path $pipCache).Path
$env:YOLO_CONFIG_DIR = (Resolve-Path $configDir).Path

if (-not (Test-Path $runtimePython)) {
  if (Test-Path $localPython) {
    & $localPython -m venv $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the YOLO26 virtual environment." }
  } else {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if (-not $launcher) { throw "Python 3.12 or the workspace .venv-worker Python is required." }
    & $launcher.Source -3.12 -m venv $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the YOLO26 virtual environment." }
  }
}
if (-not (Test-Path $runtimePython)) { throw "Could not create the local YOLO26 runtime at $runtimeDir" }

Push-Location $visionDir
try {
  & $runtimePython -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned PyTorch CUDA 12.8 wheels." }
  & $runtimePython -m pip install ultralytics==8.4.175 numpy==2.5.4 opencv-python-headless==5.0.0.93 onnxruntime==1.31.0 yt-dlp==2026.10.10.233141.dev0 yt-dlp-ejs==0.8.0
  if ($LASTEXITCODE -ne 0) { throw "Could not install the pinned Ultralytics and worker dependencies." }
} finally {
  Pop-Location
}

if (Test-Path $modelPath) {
  $existingSha256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($existingSha256 -ne $expectedSha256) {
    throw "An existing YOLO26 Medium checkpoint at $modelPath failed the staged SHA-256 check; it was left untouched."
  }
} else {
  if (Test-Path $partialPath) { throw "A prior partial download exists at $partialPath; inspect or remove it before retrying." }
  Invoke-WebRequest -Uri $modelUrl -OutFile $partialPath -UseBasicParsing
  $downloadSha256 = (Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($downloadSha256 -ne $expectedSha256) {
    throw "Downloaded YOLO26 checkpoint SHA-256 mismatch; the partial file is retained at $partialPath for inspection."
  }
  Move-Item -LiteralPath $partialPath -Destination $modelPath
}

# Keep configuration and usage telemetry local and disabled for this offline candidate.
$offlineSettings = @'
from ultralytics.utils import SETTINGS
SETTINGS.update({"sync": False, "clearml": False, "comet": False, "dvc": False,
                 "mlflow": False, "raytune": False, "wandb": False})
print(SETTINGS.file)
'@
$settingsPath = & $runtimePython -c $offlineSettings
if ($LASTEXITCODE -ne 0) { throw "Could not write local offline Ultralytics settings." }

$runtimeCheck = @'
import json, torch, ultralytics
print(json.dumps({"torch": torch.__version__, "torchvision": __import__("torchvision").__version__,
                  "ultralytics": ultralytics.__version__, "cudaRuntime": torch.version.cuda,
                  "cudaAvailable": torch.cuda.is_available(),
                  "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))
'@
$runtimeStatus = & $runtimePython -c $runtimeCheck | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not import the YOLO26 runtime." }
if (-not $runtimeStatus.cudaAvailable) { throw "PyTorch CUDA is installed but no usable GPU was detected." }

Write-Host "YOLO26 Medium candidate staged in $runtimeDir"
Write-Host "Official Ultralytics assets release: $modelUrl"
Write-Host "Checkpoint: $modelPath"
Write-Host "Checkpoint SHA-256: $((Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant())"
Write-Host "Ultralytics settings (sync and integrations disabled): $settingsPath"
Write-Host "PyTorch $($runtimeStatus.torch), torchvision $($runtimeStatus.torchvision), Ultralytics $($runtimeStatus.ultralytics)"
Write-Host "CUDA runtime $($runtimeStatus.cudaRuntime), GPU: $($runtimeStatus.gpu)"
