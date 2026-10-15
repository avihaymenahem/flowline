param(
  [string]$PythonExe = "py",
  [string[]]$PythonArgs
)

$ErrorActionPreference = "Stop"
$pythonArgsWereProvided = $PSBoundParameters.ContainsKey("PythonArgs")
$pythonExeWasProvided = $PSBoundParameters.ContainsKey("PythonExe")
if (-not $pythonArgsWereProvided) {
  # The py launcher needs a version selector; an explicit executable path is
  # already fully selected and must be invoked as one quoted command path.
  $PythonArgs = if ($pythonExeWasProvided) { @() } else { @("-3.12") }
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvPython = Join-Path $root ".venv-worker\Scripts\python.exe"
$modelDir = Join-Path $root "models"
$modelPath = Join-Path $modelDir "object_detection_yolox_2022nov.onnx"
$modelUrl = "https://huggingface.co/opencv/object_detection_yolox/resolve/c5c37f2482d90a975d2dc6a2d491f307cf41bd2d/object_detection_yolox_2022nov.onnx"
$expectedSha256 = "c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063"

if (-not (Test-Path $venvPython)) {
  & $PythonExe @PythonArgs -m venv (Join-Path $root ".venv-worker")
  if ($LASTEXITCODE -ne 0) { throw "Could not create .venv-worker with '$PythonExe'. Python 3.12 is recommended on Windows." }
}

Push-Location $root
try {
  & $venvPython -m pip install --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
  & $venvPython -m pip install -e .
  if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed" }
  New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
  if (Test-Path $modelPath) {
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $modelPath).Hash.ToLowerInvariant()
    if ($actualSha256 -ne $expectedSha256) { throw "Existing model checksum mismatch; expected $expectedSha256, got $actualSha256" }
  } else {
    $temporaryPath = "$modelPath.download"
    try {
      Invoke-WebRequest -Uri $modelUrl -OutFile $temporaryPath
      $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryPath).Hash.ToLowerInvariant()
      if ($actualSha256 -ne $expectedSha256) { throw "Downloaded model checksum mismatch; expected $expectedSha256, got $actualSha256" }
      Move-Item -LiteralPath $temporaryPath -Destination $modelPath
    } finally {
      if (Test-Path $temporaryPath) { Remove-Item -LiteralPath $temporaryPath }
    }
  }

  Write-Host "Vision runtime ready. Model path: $modelPath"
  Write-Host "Set VISION_MODEL_PATH to this absolute path before starting the API."
  & $venvPython -c "import cv2, numpy, onnxruntime; print('OpenCV', cv2.__version__, '| NumPy', numpy.__version__, '| ONNX Runtime', onnxruntime.__version__, '| Providers', onnxruntime.get_available_providers())"
} finally {
  Pop-Location
}
