import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const signed = "https://rr.googlevideo.com/videoplayback?signature=private&expire=999";
process.stderr.write(`FFmpeg failed to open ${signed}\n`);
write({ type: "ready", available: true, detail: "Fixture worker ready" });

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "start") {
    write({ type: "event", event: { type: "job_error", sourceId: "source", sessionId: "session", message: `Could not open ${signed}` } });
  }
  if (request.command === "probe_youtube") {
    write({ type: "response", requestId: request.requestId, ok: false, error: `Extractor error: ${signed}` });
    return;
  }
  if (request.command === "shutdown") {
    lines.close();
    process.stdin.pause();
    process.stdout.write(`${JSON.stringify({ type: "response", requestId: request.requestId, ok: true, result: { shutdown: true } })}\n`, () => process.exit(0));
    return;
  }
  write({ type: "response", requestId: request.requestId, ok: true, result: { accepted: true } });
});
