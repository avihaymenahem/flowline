import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ type: "ready", available: true, detail: "Fixture worker ready" });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "process_frame") {
    const payload = request.payload;
    write({
      type: "event",
      event: {
        sourceId: payload.sourceId,
        sessionId: payload.sessionId,
        sourceTimeMs: payload.sourceTimeMs,
        frameWidth: 3840,
        frameHeight: 2160,
        detections: [{
          bbox: { x: 0.52, y: 0.62, width: 0.08, height: 0.06 },
          class: "car",
          color: "white",
          confidence: 0.9418,
          trackId: "track-17"
        }],
        crossings: [{ lineId: "north-line", direction: "A to B", trackId: "track-17" }],
        quality: { coverage: "known", notes: ["fixture positive event", "detector_backend=rfdetr;detector_model=RF-DETR Medium (COCO);detector_device=cuda:0"] }
      }
    });
  }
  if (request.command === "shutdown") {
    lines.close();
    process.stdin.pause();
    process.stdout.write(`${JSON.stringify({ type: "response", requestId: request.requestId, ok: true, result: { shutdown: true } })}\n`, () => process.exit(0));
    return;
  }
  write({ type: "response", requestId: request.requestId, ok: true, result: request.command === "configure"
    ? { accepted: true, model: { backend: "rfdetr", name: "RF-DETR Medium (COCO)", device: "cpu", targetDevice: "cuda:0" } }
    : { accepted: true } });
});
