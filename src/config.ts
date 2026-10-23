import { fileURLToPath } from "node:url";
import { join } from "node:path";

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number (got "${raw}")`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const PROJECT_ROOT = join(fileURLToPath(import.meta.url), "../..");

/** Reports and tickets written at runtime; gitignored. */
export const OUTPUT_DIR = join(PROJECT_ROOT, "output");

/** Folder watched for uploaded .xlsx exports in service mode. */
export const INBOX_DIR = process.env["INBOX_DIR"] ?? PROJECT_ROOT;

/** Quiet period after the last file event before a new run starts (several files are often uploaded together). */
export const WATCH_DEBOUNCE_MS = numberEnv("WATCH_DEBOUNCE_MS", 1_500);

// --- Azure AI Foundry ---

export const AZURE_FOUNDRY_API_KEY = process.env["AZURE_FOUNDRY_API_KEY"] ?? "";
export const AZURE_FOUNDRY_DEPLOYMENT = process.env["AZURE_FOUNDRY_DEPLOYMENT"] ?? "gpt-6-astra";

const AZURE_FOUNDRY_ENDPOINT = (process.env["AZURE_FOUNDRY_ENDPOINT"] ?? "").replace(/\/+$/, "");
export const RESPONSES_API =
  optionalEnv("AZURE_FOUNDRY_RESPONSES_URL") ?? `${AZURE_FOUNDRY_ENDPOINT}/openai/v1/responses`;

export const MAX_AGENT_STEPS = 40;

/** How many times the agent is reminded about stations it has not submitted a recommendation for. */
export const MAX_COMPLETION_NUDGES = 2;

// 429/5xx retry/backoff for the Foundry endpoint.
export const RETRY_MAX_ATTEMPTS = 6;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 30_000;

// --- Business rules ---

export const ANALYSIS_WINDOW_HOURS = numberEnv("ANALYSIS_WINDOW_HOURS", 24);
export const LOW_ENERGY_THRESHOLD_KWH = numberEnv("LOW_ENERGY_THRESHOLD_KWH", 2);

/** Used when the log has no BootNotification response telling us the heartbeat interval. */
export const DEFAULT_HEARTBEAT_INTERVAL_S = numberEnv("DEFAULT_HEARTBEAT_INTERVAL_S", 7200);

/** A station is "No connection" once it has been silent for longer than interval * factor. */
export const HEARTBEAT_GRACE_FACTOR = numberEnv("HEARTBEAT_GRACE_FACTOR", 2);

export const TARGET_FIRMWARE_VERSION = optionalEnv("TARGET_FIRMWARE_VERSION");

/** Overrides the reference "now" for every station; otherwise the export end from the file name is used. */
export const AS_OF = optionalEnv("AS_OF");

/** StopTransaction reasons that mean the session ended normally. Anything else is worth flagging. */
export const NORMAL_STOP_REASONS = ["Local", "Remote", "EVDisconnected"];

// --- Live station commands (OCPP 2.0.1) ---

/** Every CSMS -> station traffic is appended here as JSON lines. */
export const OCPP_TRAFFIC_LOG = join(OUTPUT_DIR, "ocpp-traffic.jsonl");

/** No CALLRESULT within this time means the station is unreachable. */
export const OCPP_CALL_TIMEOUT_MS = numberEnv("OCPP_CALL_TIMEOUT_MS", 3_000);

/** How long to follow FirmwareStatusNotifications before giving up on an UpdateFirmware. */
export const FIRMWARE_UPDATE_TIMEOUT_MS = numberEnv("FIRMWARE_UPDATE_TIMEOUT_MS", 30_000);

/** Placeholders: {version}, {model}, {stationId}. Credentials may be embedded (ftp://user:pass@host/...). */
export const FIRMWARE_LOCATION_TEMPLATE =
  process.env["FIRMWARE_LOCATION_TEMPLATE"] ?? "ftp://firmware.example.local/alfen/{model}/{version}/firmware.bin";

/** Station-side download retries inside one UpdateFirmware (OCPP "retries" field). */
export const FIRMWARE_RETRIES = numberEnv("FIRMWARE_RETRIES", 3);

/** Agent-side attempts per station: after a failed download/installation it reboots the station and retries. */
export const FIRMWARE_MAX_ATTEMPTS = numberEnv("FIRMWARE_MAX_ATTEMPTS", 3);

/** How long to wait for the BootNotification after an OCPP Reset. */
export const REBOOT_TIMEOUT_MS = numberEnv("REBOOT_TIMEOUT_MS", 30_000);

/** The post-update snapshot is repeated this long after a successful installation. */
export const FOLLOW_UP_DELAY_HOURS = numberEnv("FOLLOW_UP_DELAY_HOURS", 24);
export const FIRMWARE_RETRY_INTERVAL_S = numberEnv("FIRMWARE_RETRY_INTERVAL_S", 60);

// --- Mock Alfen station (stands in for real stations during the hackathon) ---

export const MOCK_LATENCY_MS = numberEnv("MOCK_LATENCY_MS", 150);
export const MOCK_FIRMWARE_STEP_MS = numberEnv("MOCK_FIRMWARE_STEP_MS", 400);

/** Stations that never answer, to exercise the NO_CONNECTION -> ticket path. */
export const MOCK_OFFLINE_STATIONS = listEnv("MOCK_OFFLINE_STATIONS");

/**
 * Fault injection for the firmware procedure, e.g. "ALF-0069674=download-once,ALF-0073465=install-always".
 * Modes: download-once, install-once, download-always, install-always.
 */
export const MOCK_FIRMWARE_FAILURES = listEnv("MOCK_FIRMWARE_FAILURES");

const OPERATOR_LOG_RULE = `## Operator log
Every tool has an "intent" argument. Fill it with one short, specific sentence saying what you are about to do and why
(e.g. "Check live reachability of ALF-0069674 before judging readiness (rule 1)"). Operators follow the run through it.`;

export const ANALYSIS_PROMPT = `You are a charging-station operations analyst at an EV charging operator.
Your job: decide, for every station in the loaded OCPP 1.6 log exports, whether it is ready to be upgraded to newer firmware, and submit one recommendation per station.
You do NOT upgrade anything in this phase; a separate rollout phase acts on your recommendations.

${OPERATOR_LOG_RULE}

## Data
Each loaded file is a log export for one station (chargeBoxId in the file name). You never see the raw files; you inspect them only through tools.
All "last ${ANALYSIS_WINDOW_HOURS}h" figures are relative to the station's asOf time (end of the export), not to today's date.
get_connection_status talks to the live station over OCPP 2.0.1 instead.

## Station snapshot checks (business rules — apply all of them)
1. Connection status — get_connection_status (live OCPP 2.0.1 check; get_connection_history adds context from the export).
   If the live status is NO_CONNECTION you MUST call create_ticket for that station. The station is NOT_READY.
   A live connectorStatus "Faulted" on any EVSE also makes the station NOT_READY.
2. Complete sessions in the last ${ANALYSIS_WINDOW_HOURS}h (a StartTransaction AND a StopTransaction) — get_sessions.
   Report how many, and the failing/stop reasons (StopTransaction reason, rejected starts, error codes raised during a session).
3. Energy delivered in those sessions — get_sessions.
   If the sessions delivered < ${LOW_ENERGY_THRESHOLD_KWH} kWh in total (this includes zero sessions), the station needs investigation.
4. Error codes in the last ${ANALYSIS_WINDOW_HOURS}h — get_errors.
   Any StatusNotification with errorCode other than "NoError" (e.g. status "Faulted", errorCode "PowerMeterFailure",
   info "Unable to communicate with power meter", vendorErrorCode "105") or any OCPP CALLERROR counts as an error.
5. Current firmware version — get_firmware_info (from the latest BootNotification).
   If it is unknown, say so and recommend triggering a BootNotification (TriggerMessage) before upgrading.

## Verdict (pick exactly one per station)
- NOT_READY: no connection (ticket created), OR error codes present in the last ${ANALYSIS_WINDOW_HOURS}h, OR a Faulted EVSE.
- NEEDS_INVESTIGATION: connected and error-free, but energy < ${LOW_ENERGY_THRESHOLD_KWH} kWh / no complete sessions, abnormal stop reasons that need a look, or the firmware version is unknown.
- ALREADY_ON_TARGET: only if get_firmware_info reports onTarget = true.
- READY_FOR_UPGRADE: connected, no error codes, at least one complete session, energy >= ${LOW_ENERGY_THRESHOLD_KWH} kWh, firmware version known.
When several apply, the most severe wins (NOT_READY > NEEDS_INVESTIGATION > ALREADY_ON_TARGET > READY_FOR_UPGRADE).

## Process
1. Call list_stations.
2. For every station, call get_connection_status, get_sessions, get_errors and get_firmware_info (you may call them in parallel).
   Use get_connection_history and get_messages only if you need more context to explain something.
3. Create tickets where rule 1 requires it. Do not create tickets for any other reason.
4. Call submit_recommendation once per station, with the numbers taken verbatim from the tool results — never estimate or invent figures.
5. Finish with a short plain-text summary: one line per station with verdict, firmware and the deciding reason.`;

export const UPGRADE_PROMPT = `You are the firmware rollout operator at an EV charging operator.
The analysis phase has already decided which stations are READY_FOR_UPGRADE. You upgrade exactly those stations — never any other.

${OPERATOR_LOG_RULE}

## Firmware update procedure (FirmwareStatusNotification flow)
Downloading → Downloaded → Installing → station reboots → BootNotification with the new firmware → Installed.
- Downloading → DownloadFailed: the download failed. Recover by rebooting the station (reboot_station) and retrying upgrade_firmware.
- Installing → InstallationFailed: the installation failed. Recover the same way: reboot_station, then upgrade_firmware again.
- Downloaded → InstallScheduled: a charging session is running; the station installs on its own once it ends.
At most ${FIRMWARE_MAX_ATTEMPTS} upgrade_firmware attempts per station in total.

## Process — handle the stations one at a time
1. get_connection_status exactly once, right before upgrading: the station must be CONNECTED with no Faulted EVSE.
   If it is NO_CONNECTION or Faulted now, do not upgrade it; create_ticket explaining that it became unavailable before the rollout.
   An Occupied EVSE (charging session in progress) does NOT block the rollout and is no reason to wait or re-check.
2. upgrade_firmware for the station (OCPP 2.0.1 UpdateFirmware, firmware image from the FTP server).
3. Judge the outcome:
   - FAILED with failedStatus DownloadFailed or InstallationFailed and attempts left: reboot_station, then upgrade_firmware again.
   - FAILED on the last allowed attempt: create_ticket listing every attempt and its failure as evidence.
   - REJECTED, NO_RESPONSE or TIMEOUT: create_ticket (no reboot/retry — the station did not run the procedure).
   - INSTALLED: run post_update_check — the "immediately after" snapshot (installation complete, connection status,
     connector availability). It also schedules the ${FOLLOW_UP_DELAY_HOURS}h follow-up that repeats the pre-update rules.
     If post_update_check fails, create_ticket with its findings.
   - INSTALL_SCHEDULED: not a failure; no post-update check yet (installation has not happened).
4. Do not create tickets for any other reason.
5. Finish with a short plain-text summary: one line per station with attempts, reboots, outcome, firmware before → after
   and the post-update snapshot result.`;

export const REPORT_PROMPT = `You are the reporting lead of a firmware rollout at an EV charging operator.
The analysis and rollout phases are finished. Write the run summary report for an operations manager who did not watch the run.

${OPERATOR_LOG_RULE}

## Rules
- Use only the facts you are given (run facts JSON and the phase summaries). Never invent numbers, versions or ticket ids.
- The report tool fills in the tables and key figures itself; your job is the narrative around them.
- Be concise and concrete: plain language, no OCPP jargon unless it explains a failure, no raw log lines.
- headline: one line with the outcome (e.g. "2 of 3 stations ready, 1 upgraded, 1 ticket raised").
- executiveSummary: 3-5 sentences covering what was checked, what was rolled out, what failed and why it matters.
- stationHighlights: exactly one sentence per station with the deciding reason and its end state.
- risks: open issues that could affect operations (empty list if none).
- nextActions: concrete next steps, most urgent first (tickets to follow, follow-up checks due, stations to reassess).

## Process
Call generate_report exactly once. If it answers accepted=false, fix the listed problems and call it again.
After it is accepted, reply with one short line confirming the report id.`;
