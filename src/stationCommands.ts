import {
  FIRMWARE_RETRIES,
  FIRMWARE_RETRY_INTERVAL_S,
  FIRMWARE_UPDATE_TIMEOUT_MS,
  OCPP_CALL_TIMEOUT_MS,
  REBOOT_TIMEOUT_MS,
} from "./config.js";
import {
  CALL,
  FIRMWARE_FAILURE_STATUSES,
  FIRMWARE_FINAL_STATUSES,
  maskCredentials,
  type FirmwareStatus,
  type ResetRequest,
  type TriggerMessageRequest,
  type UpdateFirmwareRequest,
} from "./ocpp201.js";
import { simulation } from "./simulation.js";
import { OcppCallError, OcppTimeoutError, type StationGateway, type TrafficEntry } from "./stationGateway.js";
import type { FirmwareUpdateOutcome, FirmwareUpdateResult, LiveConnectionResult, RebootResult } from "./types.js";

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function traceStation(gateway: StationGateway, stationId: string): { frames: TrafficEntry[]; stop: () => void } {
  const frames: TrafficEntry[] = [];
  const stop = gateway.onTraffic((entry) => {
    if (entry.stationId === stationId) frames.push(entry);
  });
  return { frames, stop };
}

const exchange = (frames: TrafficEntry[]): LiveConnectionResult["ocppExchange"] =>
  frames.map(({ at, direction, frame }) => ({ at, direction, frame }));

/** Asks the station for a Heartbeat and a StatusNotification per EVSE via TriggerMessage. */
export async function checkLiveConnection(
  gateway: StationGateway,
  stationId: string,
  evseIds: number[],
): Promise<LiveConnectionResult> {
  const trace = traceStation(gateway, stationId);
  const problems: string[] = [];
  const evses: LiveConnectionResult["evses"] = [];
  const startedAt = Date.now();
  let connected = false;
  let heartbeatTriggered = false;
  let roundTripMs: number | null = null;

  const heartbeat = gateway.waitForStationCall(stationId, "Heartbeat", () => true, OCPP_CALL_TIMEOUT_MS);
  try {
    const trigger: TriggerMessageRequest = { requestedMessage: "Heartbeat" };
    const response = await gateway.call(stationId, "TriggerMessage", trigger, OCPP_CALL_TIMEOUT_MS);
    connected = true;
    if (response["status"] === "Accepted") {
      await heartbeat.promise;
      heartbeatTriggered = true;
      roundTripMs = Date.now() - startedAt;
    } else {
      heartbeat.cancel();
      problems.push(`TriggerMessage(Heartbeat) answered ${String(response["status"])}`);
    }
  } catch (err) {
    heartbeat.cancel();
    if (err instanceof OcppCallError) connected = true;
    problems.push(errorText(err));
  }

  if (connected) {
    for (const evseId of evseIds) {
      const status = gateway.waitForStationCall(
        stationId,
        "StatusNotification",
        (p) => p["evseId"] === evseId,
        OCPP_CALL_TIMEOUT_MS,
      );
      try {
        const trigger: TriggerMessageRequest = { requestedMessage: "StatusNotification", evse: { id: evseId, connectorId: 1 } };
        const response = await gateway.call(stationId, "TriggerMessage", trigger, OCPP_CALL_TIMEOUT_MS);
        if (response["status"] !== "Accepted") {
          status.cancel();
          problems.push(`TriggerMessage(StatusNotification, evse ${evseId}) answered ${String(response["status"])}`);
          continue;
        }
        const p = await status.promise;
        evses.push({
          evseId,
          connectorId: Number(p["connectorId"]),
          connectorStatus: String(p["connectorStatus"]),
          timestamp: String(p["timestamp"]),
        });
      } catch (err) {
        status.cancel();
        problems.push(`EVSE ${evseId}: ${errorText(err)}`);
      }
    }
  }
  trace.stop();

  return {
    stationId,
    protocol: "OCPP 2.0.1",
    checkedAt: new Date(startedAt).toISOString(),
    status: connected ? "CONNECTED" : "NO_CONNECTION",
    roundTripMs,
    heartbeatTriggered,
    evses,
    faultedEvses: evses.filter((e) => e.connectorStatus === "Faulted").length,
    occupiedEvses: evses.filter((e) => e.connectorStatus === "Occupied").length,
    problems,
    ocppExchange: exchange(trace.frames),
  };
}

let nextRequestId = Math.floor(Date.now() / 1000) % 1_000_000_000;

export interface FirmwareUpdateCommand {
  stationId: string;
  previousVersion: string;
  targetVersion: string;
  location: string;
  attempt?: number;
  maxAttempts?: number;
}

/** Sends UpdateFirmware (L01) and follows FirmwareStatusNotifications until a final status or timeout. */
export async function updateFirmware(gateway: StationGateway, command: FirmwareUpdateCommand): Promise<FirmwareUpdateResult> {
  const { stationId, location } = command;
  const requestId = nextRequestId++;
  const trace = traceStation(gateway, stationId);
  const statuses: FirmwareUpdateResult["firmwareStatuses"] = [];
  const problems: string[] = [];
  let reportedFirmwareVersion: string | null = null;
  let updateFirmwareStatus: string | null = null;
  let statusInfo: unknown = null;
  let failedStatus: string | null = null;
  let outcome: FirmwareUpdateOutcome;

  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const unsubscribe = gateway.onTraffic((entry) => {
    if (entry.stationId !== stationId || entry.direction !== "CS->CSMS" || entry.frame[0] !== CALL) return;
    const [, , action, raw] = entry.frame;
    const payload = raw as Record<string, unknown>;
    if (action === "BootNotification") {
      const station = payload["chargingStation"] as Record<string, unknown> | undefined;
      if (typeof station?.["firmwareVersion"] === "string") reportedFirmwareVersion = station["firmwareVersion"];
    }
    if (action === "FirmwareStatusNotification" && (payload["requestId"] ?? requestId) === requestId) {
      const status = String(payload["status"]) as FirmwareStatus;
      statuses.push({ at: entry.at, status });
      if (FIRMWARE_FINAL_STATUSES.includes(status)) finish();
    }
  });

  const startedAt = new Date();
  const request: UpdateFirmwareRequest = {
    requestId,
    retries: FIRMWARE_RETRIES,
    retryInterval: FIRMWARE_RETRY_INTERVAL_S,
    firmware: { location, retrieveDateTime: startedAt.toISOString() },
  };

  try {
    const response = await gateway.call(stationId, "UpdateFirmware", request, OCPP_CALL_TIMEOUT_MS);
    updateFirmwareStatus = String(response["status"]);
    statusInfo = response["statusInfo"] ?? null;

    if (updateFirmwareStatus !== "Accepted" && updateFirmwareStatus !== "AcceptedCanceled") {
      outcome = "REJECTED";
    } else {
      // A slowed-down demo simulation must not trip the timeout meant for real stations.
      const timeoutMs = Math.max(FIRMWARE_UPDATE_TIMEOUT_MS, simulation.firmwareStepMs * 20);
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        finished.then(() => false),
        new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), timeoutMs))),
      ]);
      clearTimeout(timer);

      const last = statuses.at(-1)?.status as FirmwareStatus | undefined;
      if (timedOut) {
        outcome = "TIMEOUT";
        problems.push(`No final FirmwareStatusNotification within ${timeoutMs} ms (last: ${last ?? "none"})`);
      } else if (last === "Installed") {
        outcome = "INSTALLED";
        if (reportedFirmwareVersion !== command.targetVersion) {
          problems.push(`Station rebooted with firmware ${reportedFirmwareVersion ?? "unknown"}, expected ${command.targetVersion}`);
        }
      } else if (last === "InstallScheduled") {
        outcome = "INSTALL_SCHEDULED";
        problems.push("Firmware downloaded; installation is postponed until the running transaction ends.");
      } else {
        outcome = "FAILED";
        if (last && FIRMWARE_FAILURE_STATUSES.includes(last)) {
          failedStatus = last;
          problems.push(`Station reported ${last}`);
        }
      }
    }
  } catch (err) {
    outcome = err instanceof OcppTimeoutError ? "NO_RESPONSE" : "REJECTED";
    problems.push(errorText(err));
  } finally {
    unsubscribe();
    trace.stop();
  }

  return {
    stationId,
    protocol: "OCPP 2.0.1",
    attempt: command.attempt ?? 1,
    maxAttempts: command.maxAttempts ?? 1,
    failedStatus,
    requestId,
    location: maskCredentials(location),
    previousVersion: command.previousVersion,
    targetVersion: command.targetVersion,
    startedAt: startedAt.toISOString(),
    outcome,
    updateFirmwareStatus,
    statusInfo,
    firmwareStatuses: statuses,
    reportedFirmwareVersion,
    problems,
    ocppExchange: exchange(trace.frames),
  };
}

/** OCPP Reset(Immediate): the station drops its connection, reboots and must come back with a BootNotification. */
export async function rebootStation(gateway: StationGateway, stationId: string, reason: string): Promise<RebootResult> {
  const trace = traceStation(gateway, stationId);
  const problems: string[] = [];
  const requestedAt = new Date();
  let wentOffline = false;
  const stopWatching = gateway.onConnection((id, online) => {
    if (id === stationId && !online) wentOffline = true;
  });
  const boot = gateway.waitForStationCall(stationId, "BootNotification", () => true, REBOOT_TIMEOUT_MS);

  let resetStatus: string | null = null;
  let outcome: RebootResult["outcome"];
  let bootedAt: Date | null = null;
  let firmwareVersion: string | null = null;
  try {
    const request: ResetRequest = { type: "Immediate" };
    const response = await gateway.call(stationId, "Reset", request, OCPP_CALL_TIMEOUT_MS);
    resetStatus = String(response["status"]);
    if (resetStatus !== "Accepted") {
      boot.cancel();
      outcome = "REJECTED";
      problems.push(`Reset answered ${resetStatus}`);
    } else {
      try {
        const payload = await boot.promise;
        bootedAt = new Date();
        const station = (payload["chargingStation"] ?? {}) as Record<string, unknown>;
        firmwareVersion = typeof station["firmwareVersion"] === "string" ? station["firmwareVersion"] : null;
        outcome = "REBOOTED";
      } catch (err) {
        outcome = "NO_BOOT";
        problems.push(errorText(err));
      }
    }
  } catch (err) {
    boot.cancel();
    outcome = err instanceof OcppTimeoutError ? "NO_RESPONSE" : "REJECTED";
    problems.push(errorText(err));
  } finally {
    stopWatching();
    trace.stop();
  }

  return {
    stationId,
    protocol: "OCPP 2.0.1",
    reason,
    requestedAt: requestedAt.toISOString(),
    resetStatus,
    outcome,
    wentOffline,
    bootedAt: bootedAt?.toISOString() ?? null,
    downtimeMs: bootedAt ? bootedAt.getTime() - requestedAt.getTime() : null,
    firmwareVersion,
    problems,
    ocppExchange: exchange(trace.frames),
  };
}

export function firmwareLocation(template: string, values: { version: string; model: string; stationId: string }): string {
  return template
    .replaceAll("{version}", encodeURIComponent(values.version))
    .replaceAll("{model}", encodeURIComponent(values.model))
    .replaceAll("{stationId}", encodeURIComponent(values.stationId));
}
