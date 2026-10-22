import { randomUUID } from "node:crypto";
import { ANALYSIS_WINDOW_HOURS, MOCK_OFFLINE_STATIONS } from "./config.js";
import { connectionStatus, firmwareInfo, latestConnectorStatuses } from "./ocpp.js";
import {
  CALL,
  CALL_ERROR,
  CALL_RESULT,
  connectorStatusFromOcpp16,
  type BootNotificationRequest,
  type ConnectorStatus,
  type FirmwareStatus,
  type FirmwareStatusNotificationRequest,
  type OcppCall,
  type OcppFrame,
  type ResetRequest,
  type ResetResponse,
  type RpcErrorCode,
  type StatusNotificationRequest,
  type TriggerMessageRequest,
  type TriggerMessageResponse,
  type UpdateFirmwareRequest,
  type UpdateFirmwareResponse,
} from "./ocpp201.js";
import { simulation } from "./simulation.js";
import { StationGateway, type StationLink } from "./stationGateway.js";
import type { StationLog } from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const SUPPORTED_FIRMWARE_SCHEMES = ["ftp:", "ftps:", "sftp:", "http:", "https:"];

export interface MockStationProfile {
  stationId: string;
  vendorName: string;
  model: string;
  serialNumber: string | undefined;
  firmwareVersion: string;
  iccid: string | undefined;
  imsi: string | undefined;
  /** Alfen dual-socket stations expose each socket as an EVSE with a single connector. */
  evses: Array<{ evseId: number; connectorId: number; status: ConnectorStatus }>;
  reachable: boolean;
}

/** Seeds the simulator from the log export so live answers agree with the historical data. */
export function profileFromLog(log: StationLog): MockStationProfile {
  const firmware = firmwareInfo(log);
  const boot = log.messages.findLast((m) => m.action === "BootNotification" && m.messageType === "STATION_REQUEST");
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const statuses = latestConnectorStatuses(log);

  return {
    stationId: log.stationId,
    vendorName: text(firmware["chargePointVendor"]) ?? "Alfen BV",
    model: text(firmware["chargePointModel"]) ?? "unknown",
    serialNumber: text(firmware["chargePointSerialNumber"]),
    firmwareVersion: text(firmware["firmwareVersion"]) ?? "unknown",
    iccid: text(boot?.payload["iccid"]),
    imsi: text(boot?.payload["imsi"]),
    evses:
      statuses.size > 0
        ? [...statuses.entries()].map(([evseId, status]) => ({ evseId, connectorId: 1, status: connectorStatusFromOcpp16(status) }))
        : [{ evseId: 1, connectorId: 1, status: "Available" }],
    reachable:
      !MOCK_OFFLINE_STATIONS.includes(log.stationId) &&
      connectionStatus(log, ANALYSIS_WINDOW_HOURS)["status"] === "CONNECTED",
  };
}

const IDLE_FIRMWARE_STATUSES: FirmwareStatus[] = ["Idle", "Installed", "DownloadFailed", "InstallationFailed"];

/** Simulated Alfen charging station speaking OCPP 2.0.1 (TriggerMessage, UpdateFirmware and Reset subset). */
export class MockAlfenStation implements StationLink {
  private handler: (frame: OcppFrame) => void = () => {};
  private connectionHandler: (online: boolean) => void = () => {};
  private firmwareJob: number | undefined;
  private firmwareStatus: FirmwareStatus = "Idle";
  private online = true;
  private updateAttempts = 0;

  constructor(private readonly profile: MockStationProfile) {}

  onFrame(handler: (frame: OcppFrame) => void): void {
    this.handler = handler;
  }

  onConnectionChange(handler: (online: boolean) => void): void {
    this.connectionHandler = handler;
  }

  deliver(frame: OcppFrame): void {
    // An unreachable or rebooting station simply never answers; the CSMS detects that via its call timeout.
    if (!this.profile.reachable || !this.online || frame[0] !== CALL) return;
    void this.handleCall(frame);
  }

  private async handleCall([, messageId, action, payload]: OcppCall): Promise<void> {
    await sleep(simulation.latencyMs);
    switch (action) {
      case "TriggerMessage":
        return this.onTriggerMessage(messageId, payload as TriggerMessageRequest);
      case "UpdateFirmware":
        return this.onUpdateFirmware(messageId, payload as UpdateFirmwareRequest);
      case "Reset":
        return this.onReset(messageId, payload as ResetRequest);
      default:
        return this.error(messageId, "NotImplemented", `${action} is not implemented by the mock station`);
    }
  }

  private onTriggerMessage(messageId: string, request: TriggerMessageRequest): void {
    const evses = request.evse
      ? this.profile.evses.filter((e) => e.evseId === request.evse?.id && (request.evse.connectorId ?? e.connectorId) === e.connectorId)
      : this.profile.evses;

    const reply = (status: TriggerMessageResponse["status"], reasonCode?: string): void =>
      this.result(messageId, reasonCode ? { status, statusInfo: { reasonCode } } : { status });

    switch (request.requestedMessage) {
      case "Heartbeat":
        reply("Accepted");
        void this.later(() => this.send("Heartbeat", {}));
        return;
      case "StatusNotification":
        if (evses.length === 0) return reply("Rejected", "UnknownEvse");
        reply("Accepted");
        void this.later(() => evses.forEach((e) => this.sendStatus(e.evseId, e.connectorId, e.status)));
        return;
      case "BootNotification":
        reply("Accepted");
        void this.later(() => this.sendBoot("Triggered"));
        return;
      case "FirmwareStatusNotification": {
        reply("Accepted");
        const notification: FirmwareStatusNotificationRequest =
          this.firmwareJob !== undefined ? { status: this.firmwareStatus, requestId: this.firmwareJob } : { status: "Idle" };
        void this.later(() => this.send("FirmwareStatusNotification", notification));
        return;
      }
      default:
        return reply("NotImplemented");
    }
  }

  private onUpdateFirmware(messageId: string, request: UpdateFirmwareRequest): void {
    let scheme: string | undefined;
    try {
      scheme = new URL(request.firmware?.location ?? "").protocol;
    } catch {
      scheme = undefined;
    }
    if (!scheme || !SUPPORTED_FIRMWARE_SCHEMES.includes(scheme)) {
      const response: UpdateFirmwareResponse = {
        status: "Rejected",
        statusInfo: { reasonCode: "InvalidURL", additionalInfo: `Unsupported firmware location: ${request.firmware?.location}` },
      };
      return this.result(messageId, response);
    }

    const busy = this.firmwareJob !== undefined && !IDLE_FIRMWARE_STATUSES.includes(this.firmwareStatus);
    this.firmwareJob = request.requestId;
    this.updateAttempts++;
    this.result(messageId, { status: busy ? "AcceptedCanceled" : "Accepted" } satisfies UpdateFirmwareResponse);
    void this.runFirmwareUpdate(request);
  }

  private onReset(messageId: string, request: ResetRequest): void {
    if (request.type !== "Immediate" && request.type !== "OnIdle") {
      return this.error(messageId, "PropertyConstraintViolation", `Unknown reset type ${String(request.type)}`);
    }
    this.result(messageId, { status: "Accepted" } satisfies ResetResponse);
    this.firmwareJob = undefined;
    this.firmwareStatus = "Idle";
    void this.later(() => void this.reboot("RemoteReset"));
  }

  /** Drops the connection, comes back after a while and announces itself like a real station does. */
  private async reboot(reason: BootNotificationRequest["reason"]): Promise<void> {
    this.online = false;
    this.connectionHandler(false);
    await sleep(simulation.firmwareStepMs * 2);
    this.online = true;
    this.connectionHandler(true);
    await sleep(simulation.latencyMs);
    this.sendBoot(reason);
    for (const e of this.profile.evses) this.sendStatus(e.evseId, e.connectorId, e.status);
  }

  /** Fault injection: "once" fails only the first UpdateFirmware the station receives, "always" fails every one. */
  private shouldFail(stage: "download" | "install"): boolean {
    const mode = simulation.failures[this.profile.stationId] ?? "none";
    if (!mode.startsWith(stage)) return false;
    return mode.endsWith("always") || this.updateAttempts === 1;
  }

  private async runFirmwareUpdate(request: UpdateFirmwareRequest): Promise<void> {
    const { requestId } = request;
    const step = async (status: FirmwareStatus): Promise<boolean> => {
      await sleep(simulation.firmwareStepMs);
      if (this.firmwareJob !== requestId) return false;
      this.firmwareStatus = status;
      this.send("FirmwareStatusNotification", { status, requestId } satisfies FirmwareStatusNotificationRequest);
      return true;
    };

    if (!(await step("Downloading"))) return;
    if (this.shouldFail("download")) {
      await step("DownloadFailed");
      return;
    }
    if (!(await step("Downloaded"))) return;
    if (request.firmware.signature && !(await step("SignatureVerified"))) return;

    // Per L01, a station does not install while a transaction is running; it parks the update instead.
    if (this.profile.evses.some((e) => e.status === "Occupied")) {
      await step("InstallScheduled");
      return;
    }

    if (!(await step("Installing"))) return;
    if (this.shouldFail("install")) {
      await step("InstallationFailed");
      return;
    }
    await sleep(simulation.firmwareStepMs);
    if (this.firmwareJob !== requestId) return;
    this.profile.firmwareVersion = versionFromLocation(request.firmware.location) ?? `${this.profile.firmwareVersion}-new`;
    await this.reboot("FirmwareUpdate");
    await step("Installed");
  }

  private sendStatus(evseId: number, connectorId: number, connectorStatus: ConnectorStatus): void {
    const notification: StatusNotificationRequest = { timestamp: new Date().toISOString(), connectorStatus, evseId, connectorId };
    this.send("StatusNotification", notification);
  }

  private sendBoot(reason: BootNotificationRequest["reason"]): void {
    const { model, vendorName, serialNumber, firmwareVersion, iccid, imsi } = this.profile;
    const boot: BootNotificationRequest = {
      reason,
      chargingStation: {
        model,
        vendorName,
        firmwareVersion,
        ...(serialNumber ? { serialNumber } : {}),
        ...(iccid || imsi ? { modem: { ...(iccid ? { iccid } : {}), ...(imsi ? { imsi } : {}) } } : {}),
      },
    };
    this.send("BootNotification", boot);
  }

  private async later(fn: () => void): Promise<void> {
    await sleep(simulation.latencyMs);
    fn();
  }

  private send(action: string, payload: object): void {
    this.handler([CALL, randomUUID(), action, payload]);
  }

  private result(messageId: string, payload: object): void {
    this.handler([CALL_RESULT, messageId, payload]);
  }

  private error(messageId: string, code: RpcErrorCode, description: string): void {
    this.handler([CALL_ERROR, messageId, code, description, {}]);
  }
}

/** The new image reports the version it was built as; the mock reads it from the file path instead. */
function versionFromLocation(location: string): string | undefined {
  return [...location.matchAll(/\d+\.\d+\.\d+(?:-[0-9A-Za-z]+)*/g)].at(-1)?.[0];
}

export function createMockGateway(logs: StationLog[]): StationGateway {
  const gateway = new StationGateway();
  for (const log of logs) gateway.register(log.stationId, new MockAlfenStation(profileFromLog(log)));
  return gateway;
}
