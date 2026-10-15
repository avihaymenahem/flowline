param([switch]$IncludeLarge)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$visionDir = $PSScriptRoot
$runtimeDir = Join-Path $visionDir ".venv-rfdetr"
$runtimePython = Join-Path $runtimeDir "Scripts/python.exe"
$localPython = Join-Path $visionDir ".venv-worker/Scripts/python.exe"
$tempDir = Join-Path $visionDir ".tmp/python-temp"
$pipCache = Join-Path $visionDir ".tmp/pip-cache"
$cacheDir = Join-Path $visionDir ".cache"
$modelDir = Join-Path $visionDir "models/rfdetr"
$modelPath = Join-Path $modelDir "rf-detr-medium.pth"
$partialPath = "$modelPath.part"
$modelUrl = "https://storage.googleapis.com/rfdetr/medium_coco/checkpoint_best_regular.pth"
$expectedMd5 = "7223f764a87b863f02eb8d52bf0ce2ee"
$largeModelPath = Join-Path $modelDir "rf-detr-large-2026.pth"
$largePartialPath = "$largeModelPath.part"
$largeModelUrl = "https://storage.googleapis.com/rfdetr/rf-detr-large-2026.pth"
$largeExpectedMd5 = "5cb72153541cbcb9aa6efa26222acc75"

New-Item -ItemType Directory -Force $tempDir, $pipCache, $cacheDir, $modelDir | Out-Null
$env:TEMP = (Resolve-Path $tempDir).Path
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = (Resolve-Path $pipCache).Path
$env:HF_HOME = Join-Path (Resolve-Path $cacheDir).Path "huggingface"
$env:TORCH_HOME = Join-Path (Resolve-Path $cacheDir).Path "torch"

if (-not (Test-Path $runtimePython)) {
  if (Test-Path $localPython) {
    & $localPython -m venv $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the RF-DETR virtual environment." }
  } else {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if (-not $launcher) { throw "Python 3.12 or the workspace .venv-worker Python is required." }
    & $launcher.Source -3.12 -m venv $runtimeDir
    if ($LASTEXITCODE -ne 0) { throw "Could not create the RF-DETR virtual environment." }
  }
}
if (-not (Test-Path $runtimePython)) { throw "Could not create the local RF-DETR runtime at $runtimeDir" }

Push-Location $visionDir
try {
  & $runtimePython -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw "Could not prepare pip in the RF-DETR environment." }
  & $runtimePython -m pip install torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cu128
  if ($LASTEXITCODE -ne 0) { throw "Could not install the official PyTorch CUDA 12.8 wheels." }
  & $runtimePython -m pip install rfdetr==1.11.2
  if ($LASTEXITCODE -ne 0) { throw "Could not install RF-DETR 1.11.2." }
  & $runtimePython -m pip install -e .
  if ($LASTEXITCODE -ne 0) { throw "Could not install the local worker runtime dependencies." }
} finally {
  Pop-Location
}

if (Test-Path $modelPath) {
  $existingMd5 = (Get-FileHash -LiteralPath $modelPath -Algorithm MD5).Hash.ToLowerInvariant()
  if ($existingMd5 -ne $expectedMd5) {
    throw "An existing RF-DETR checkpoint at $modelPath failed the official checksum; it was left untouched."
  }
} else {
  Invoke-WebRequest -Uri $modelUrl -OutFile $partialPath -UseBasicParsing
  $downloadMd5 = (Get-FileHash -LiteralPath $partialPath -Algorithm MD5).Hash.ToLowerInvariant()
  if ($downloadMd5 -ne $expectedMd5) {
    throw "Downloaded RF-DETR checkpoint checksum mismatch; the partial file is retained at $partialPath for inspection."
  }
  Move-Item -LiteralPath $partialPath -Destination $modelPath
}

if ($IncludeLarge) {
  if (Test-Path $largeModelPath) {
    $largeExistingMd5 = (Get-FileHash -LiteralPath $largeModelPath -Algorithm MD5).Hash.ToLowerInvariant()
    if ($largeExistingMd5 -ne $largeExpectedMd5) {
      throw "An existing RF-DETR Large checkpoint at $largeModelPath failed the official checksum; it was left untouched."
    }
  } else {
    Invoke-WebRequest -Uri $largeModelUrl -OutFile $largePartialPath -UseBasicParsing
    $largeDownloadMd5 = (Get-FileHash -LiteralPath $largePartialPath -Algorithm MD5).Hash.ToLowerInvariant()
    if ($largeDownloadMd5 -ne $largeExpectedMd5) {
      throw "Downloaded RF-DETR Large checkpoint checksum mismatch; the partial file is retained at $largePartialPath for inspection."
    }
    Move-Item -LiteralPath $largePartialPath -Destination $largeModelPath
  }
}

$sha256 = (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant()
$cudaCheck = @'
import json, torch
print(json.dumps({"torch": torch.__version__, "cudaRuntime": torch.version.cuda,
                  "cudaAvailable": torch.cuda.is_available(),
                  "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))
'@
$runtimeStatus = & $runtimePython -c $cudaCheck | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw "Could not import PyTorch in the RF-DETR environment." }
if (-not $runtimeStatus.cudaAvailable) { throw "PyTorch CUDA is installed but no usable GPU was detected." }

Write-Host "RF-DETR Medium runtime installed in $runtimeDir"
Write-Host "Model checkpoint: $modelPath"
Write-Host "Model SHA-256: $sha256"
if ($IncludeLarge) {
  Write-Host "RF-DETR Large 2026 checkpoint: $largeModelPath"
  Write-Host "RF-DETR Large 2026 SHA-256: $((Get-FileHash -LiteralPath $largeModelPath -Algorithm SHA256).Hash.ToLowerInvariant())"
}
Write-Host "PyTorch $($runtimeStatus.torch), CUDA $($runtimeStatus.cudaRuntime), GPU: $($runtimeStatus.gpu)"
