import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ type: "ready", available: true, detail: "Fixture worker ready" });
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "shutdown") {
    lines.close();
    process.stdin.pause();
    process.stdout.write(`${JSON.stringify({ type: "response", requestId: request.requestId, ok: true, result: { shutdown: true } })}\n`, () => process.exit(0));
    return;
  }
  const delay = request.command === "probe_youtube" || request.command === "process_frame" ? 40 : 0;
  setTimeout(() => write({ type: "response", requestId: request.requestId, ok: true, result: { accepted: true } }), delay);
});
