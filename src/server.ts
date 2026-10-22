import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import { AZURE_FOUNDRY_DEPLOYMENT, INBOX_DIR, PROJECT_ROOT, TARGET_FIRMWARE_VERSION } from "./config.js";
import * as dashboard from "./dashboard.js";
import { resolveInputFiles } from "./inputs.js";
import { assertLlmConfigured } from "./llm.js";
import { addLogSink, log, type LogEntry } from "./logger.js";
import { loadStationLog } from "./ocpp.js";
import { runPipeline } from "./pipeline.js";
import { FAILURE_MODES, type FailureMode } from "./simulation.js";

/** Browser dashboard: static UI + Server-Sent Events carrying the same log lines the console prints. */

const PORT = Number(process.env["UI_PORT"] ?? 3000);
const WEB_DIR = join(PROJECT_ROOT, "web");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEMO_FIRMWARE_STEP_MS = Number(process.env["UI_FIRMWARE_STEP_MS"] ?? 1800);

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const clients = new Set<ServerResponse>();
let running = false;

function broadcast(payload: unknown): void {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(frame);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`Upload larger than ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = (await readBody(req, 64 * 1024)).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function loadInbox(): Promise<number> {
  const files = await resolveInputFiles([INBOX_DIR]);
  const logs = [];
  for (const file of files) {
    try {
      logs.push(await loadStationLog(file));
    } catch (err) {
      log.warn(`could not parse ${basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  dashboard.loadStations(logs);
  return logs.length;
}

async function startRun(upgrade: boolean): Promise<void> {
  running = true;
  try {
    const files = await resolveInputFiles([INBOX_DIR]);
    await runPipeline(files, { upgrade, trigger: "dashboard" });
  } catch (err) {
    log.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
    broadcast({ type: "idle" });
  }
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const relative = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = resolve(WEB_DIR, `.${relative}`);
  if (!file.startsWith(WEB_DIR)) return sendJson(res, 403, { error: "forbidden" });
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

function openEventStream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(
    `data: ${JSON.stringify({
      type: "hello",
      stations: dashboard.getSnapshots(),
      state: dashboard.getState(),
      logs: dashboard.getLogs(),
      running,
      meta: { deployment: AZURE_FOUNDRY_DEPLOYMENT, targetFirmwareVersion: TARGET_FIRMWARE_VERSION ?? null, inbox: INBOX_DIR },
    })}\n\n`,
  );
  clients.add(res);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/events":
      return openEventStream(req, res);
    case "POST /api/run": {
      if (running) return sendJson(res, 409, { error: "A run is already in progress" });
      try {
        assertLlmConfigured();
      } catch (err) {
        return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      const body = await readJson(req);
      void startRun(body["upgrade"] !== false);
      return sendJson(res, 202, { started: true });
    }
    case "POST /api/reset": {
      if (running) return sendJson(res, 409, { error: "Wait for the current run to finish" });
      log.info("Dashboard reset: reloading station exports from the inbox");
      return sendJson(res, 200, { stations: await loadInbox() });
    }
    case "POST /api/settings": {
      const body = await readJson(req);
      const stepMs = Number(body["firmwareStepMs"]);
      if (!Number.isFinite(stepMs) || stepMs < 50 || stepMs > 10_000) return sendJson(res, 400, { error: "firmwareStepMs must be 50-10000" });
      dashboard.setFirmwareStepMs(stepMs);
      log.info(`Simulation speed: ${stepMs} ms per firmware step`);
      return sendJson(res, 200, { firmwareStepMs: stepMs });
    }
    case "POST /api/scenario": {
      const body = await readJson(req);
      const stationId = String(body["stationId"] ?? "");
      const mode = String(body["mode"] ?? "") as FailureMode;
      if (!dashboard.getSnapshots().some((x) => x.stationId === stationId)) return sendJson(res, 400, { error: `Unknown station ${stationId}` });
      if (!FAILURE_MODES.includes(mode)) return sendJson(res, 400, { error: `mode must be one of ${FAILURE_MODES.join(", ")}` });
      dashboard.setFailureMode(stationId, mode);
      log.info(`Fault injection: ${mode === "none" ? "none" : mode.replace("-", " fails ")}`, stationId);
      return sendJson(res, 200, { stationId, mode });
    }
    case "POST /api/upload": {
      if (running) return sendJson(res, 409, { error: "Wait for the current run to finish" });
      const name = basename(url.searchParams.get("name") ?? "");
      if (!name.toLowerCase().endsWith(".xlsx")) return sendJson(res, 400, { error: "Only .xlsx exports are accepted" });
      const body = await readBody(req, MAX_UPLOAD_BYTES);
      await writeFile(join(INBOX_DIR, name), body);
      log.ok(`uploaded ${name} (${Math.round(body.length / 1024)} KB) via dashboard`);
      return sendJson(res, 200, { saved: name, stations: await loadInbox() });
    }
    default:
      if (req.method === "GET") return serveStatic(res, url.pathname);
      return sendJson(res, 404, { error: "not found" });
  }
}

async function main(): Promise<void> {
  dashboard.setFirmwareStepMs(DEMO_FIRMWARE_STEP_MS);
  addLogSink((entry: LogEntry) => {
    dashboard.addLog(entry);
    broadcast({ type: "log", entry });
  });
  dashboard.onDashboardChange((change) => {
    if (change === "stations") broadcast({ type: "stations", stations: dashboard.getSnapshots() });
    else broadcast({ type: "state", state: dashboard.getState() });
  });

  log.banner("Firmware Rollout Control Room", `model ${AZURE_FOUNDRY_DEPLOYMENT} · OCPP 2.0.1 gateway (mock)`);
  const count = await loadInbox();
  log.ok(`${count} station export(s) loaded from ${INBOX_DIR}`);

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log.error(`HTTP ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
  });
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    log.ok(`Dashboard running at ${url} — press "Run" in the browser to start the agent`);
    if (process.argv.includes("--open") && process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`Received ${signal}, shutting down`);
      process.exit(0);
    });
  }
}

main().catch((err: unknown) => {
  log.error(`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
