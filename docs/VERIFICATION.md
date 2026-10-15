# Verification and portability

The project includes contract, API, frontend and Python vision tests. Runtime data, camera frames, local evaluation output, model weights and machine-specific configuration are intentionally excluded from Git. A fresh clone starts with no sources or uploaded recordings.

## Checks

After installing dependencies and provisioning the vision environment:

```sh
npm test
npm run typecheck
npm run build
```

`npm run dev` builds the shared contracts before starting the API and web app. The API starts and supervises the Python worker; no separate worker terminal is required. Without a configured vision environment, source management remains available and analysis is explicitly unavailable.

### Publication check — 2026-10-15

A clean export of the Git source passed `npm ci`, the development startup smoke check, typecheck and build on Windows. The smoke check verified the dashboard and API proxy with an empty source list and analysis explicitly unavailable before vision provisioning.

All 257 project tests passed: 11 contracts, 70 API, 96 frontend and 80 Python vision tests, with no skipped tests. The vision command runner's four additional interpreter-path tests also passed. Python checks used the existing installed interpreter through `VISION_PYTHON`; model weights, recordings and local application settings were not copied into the clean export. The legacy media re-decode unit tests use disposable synthetic upload fixtures and mocked decoding, so they do not require private footage.

## Mac setup

Follow the root README: macOS 14 or newer, Node.js 22 or newer, and Python 3.12 or 3.13 are required for the pinned setup. `npm run setup:mac` provisions a local virtual environment and verifies model checksums. Apple Silicon selects YOLO26 with MPS when available; Intel uses the ONNX CPU model. Set `VISION_DEVICE=cpu` to choose CPU inference explicitly.

Mac platform paths, setup configuration and CUDA/MPS/CPU selection have automated tests that can run on Windows. Actual Mac hardware execution and Mac performance have not been verified on this PC.

## Accuracy limits

Detection and tracking tests include geometry, duplicate reconciliation, tracking continuity, timestamp gaps, colors and counting lines. Selected footage checks and synthetic regressions do not establish full-video count accuracy or sustained multi-camera capacity. Vehicle colors are estimates, live model classes remain broad, and plate recognition and speed estimates are unavailable.

Accuracy reports preserve individual corrections and available image evidence. They are partial annotations and do not automatically train the model or change historical results. Full-frame annotation and representative evaluation remain separate work.
