/** OCPP 2.0.1 (OCPP-J) message frames and the payloads used by the live station tools. */

export const CALL = 2;
export const CALL_RESULT = 3;
export const CALL_ERROR = 4;

export type OcppCall = [typeof CALL, string, string, object];
export type OcppCallResult = [typeof CALL_RESULT, string, object];
export type OcppCallError = [typeof CALL_ERROR, string, string, string, object];
export type OcppFrame = OcppCall | OcppCallResult | OcppCallError;

export type RpcErrorCode =
  | "FormatViolation"
  | "GenericError"
  | "InternalError"
  | "MessageTypeNotSupported"
  | "NotImplemented"
  | "NotSupported"
  | "OccurrenceConstraintViolation"
  | "PropertyConstraintViolation"
  | "ProtocolError"
  | "RpcFrameworkError"
  | "SecurityError"
  | "TypeConstraintViolation";

export interface StatusInfo {
  reasonCode: string;
  additionalInfo?: string;
}

export interface EVSE {
  id: number;
  connectorId?: number;
}

// --- TriggerMessage / StatusNotification / Heartbeat ---

export type MessageTrigger =
  | "BootNotification"
  | "LogStatusNotification"
  | "FirmwareStatusNotification"
  | "Heartbeat"
  | "MeterValues"
  | "SignChargingStationCertificate"
  | "SignV2GCertificate"
  | "StatusNotification"
  | "TransactionEvent"
  | "SignCombinedCertificate"
  | "PublishFirmwareStatusNotification";

export interface TriggerMessageRequest {
  requestedMessage: MessageTrigger;
  evse?: EVSE;
}

export interface TriggerMessageResponse {
  status: "Accepted" | "Rejected" | "NotImplemented";
  statusInfo?: StatusInfo;
}

export type ConnectorStatus = "Available" | "Occupied" | "Reserved" | "Unavailable" | "Faulted";

export interface StatusNotificationRequest {
  timestamp: string;
  connectorStatus: ConnectorStatus;
  evseId: number;
  connectorId: number;
}

export interface HeartbeatResponse {
  currentTime: string;
}

// --- Firmware management (use case L01) ---

export interface Firmware {
  location: string;
  retrieveDateTime: string;
  installDateTime?: string;
  signingCertificate?: string;
  signature?: string;
}

export interface UpdateFirmwareRequest {
  retries?: number;
  retryInterval?: number;
  requestId: number;
  firmware: Firmware;
}

export interface UpdateFirmwareResponse {
  status: "Accepted" | "Rejected" | "AcceptedCanceled" | "InvalidCertificate" | "RevokedCertificate";
  statusInfo?: StatusInfo;
}

export type FirmwareStatus =
  | "Downloaded"
  | "DownloadFailed"
  | "Downloading"
  | "DownloadScheduled"
  | "DownloadPaused"
  | "Idle"
  | "InstallationFailed"
  | "Installing"
  | "Installed"
  | "InstallRebooting"
  | "InstallScheduled"
  | "InstallVerificationFailed"
  | "InvalidSignature"
  | "SignatureVerified";

export interface FirmwareStatusNotificationRequest {
  status: FirmwareStatus;
  requestId?: number;
}

export const FIRMWARE_FAILURE_STATUSES: FirmwareStatus[] = [
  "DownloadFailed",
  "InstallationFailed",
  "InstallVerificationFailed",
  "InvalidSignature",
];

/** Statuses after which the CSMS stops waiting: done, failed, or parked until the station is idle. */
export const FIRMWARE_FINAL_STATUSES: FirmwareStatus[] = [...FIRMWARE_FAILURE_STATUSES, "Installed", "InstallScheduled"];

// --- Reset (use case B11/B12) ---

export interface ResetRequest {
  type: "Immediate" | "OnIdle";
  evseId?: number;
}

export interface ResetResponse {
  status: "Accepted" | "Rejected" | "Scheduled";
  statusInfo?: StatusInfo;
}

// --- BootNotification ---

export type BootReason =
  | "ApplicationReset"
  | "FirmwareUpdate"
  | "LocalReset"
  | "PowerUp"
  | "RemoteReset"
  | "ScheduledReset"
  | "Triggered"
  | "Unknown"
  | "Watchdog";

export interface BootNotificationRequest {
  reason: BootReason;
  chargingStation: {
    model: string;
    vendorName: string;
    serialNumber?: string;
    firmwareVersion?: string;
    modem?: { iccid?: string; imsi?: string };
  };
}

// --- helpers ---

export function isFrame(value: unknown): value is OcppFrame {
  return Array.isArray(value) && [CALL, CALL_RESULT, CALL_ERROR].includes(value[0] as number) && typeof value[1] === "string";
}

/** The exports are OCPP 1.6; 2.0.1 folds the transaction states into "Occupied". */
export function connectorStatusFromOcpp16(status: string | undefined): ConnectorStatus {
  switch (status) {
    case "Available":
      return "Available";
    case "Reserved":
      return "Reserved";
    case "Unavailable":
      return "Unavailable";
    case "Faulted":
      return "Faulted";
    case "Preparing":
    case "Charging":
    case "SuspendedEV":
    case "SuspendedEVSE":
    case "Finishing":
      return "Occupied";
    default:
      return "Available";
  }
}

/** Hides FTP/HTTP credentials embedded in a firmware location before it is logged or shown to the model. */
export function maskCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s"]+@/gi, "$1***@");
}
