// --- LLM / agent plumbing (OpenAI Responses API shapes, as served by Azure AI Foundry) ---

export interface ResponseOutput {
  type: string;
  content?: Array<{ type: string; text?: string }>;
  name?: string;
  call_id?: string;
  arguments?: string;
}

export interface LLMResponse {
  output: ResponseOutput[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { code?: string; message: string };
}

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

// --- OCPP log exports ---

export type MessageType = "STATION_REQUEST" | "STATION_RESPONSE" | "SYSTEM_REQUEST" | "SYSTEM_RESPONSE" | string;

export interface OcppMessage {
  /** Row number in the source spreadsheet, so findings can be traced back to the xlsx. */
  row: number;
  time: Date;
  messageId: string;
  messageType: MessageType;
  action: string;
  payload: Record<string, unknown>;
  rawPayload: string;
  errorCode: string;
  errorDescription: string;
}

export interface StationLog {
  stationId: string;
  sourceFile: string;
  exportFrom: Date | undefined;
  exportTo: Date | undefined;
  /** Reference "now" for every time-window rule. */
  asOf: Date;
  /** Sorted oldest first. */
  messages: OcppMessage[];
}

export type Verdict = "READY_FOR_UPGRADE" | "NEEDS_INVESTIGATION" | "NOT_READY" | "ALREADY_ON_TARGET";

export interface Ticket {
  id: string;
  createdAt: string;
  stationId: string;
  title: string;
  severity: string;
  reason: string;
  details: string;
}

// --- live station commands (OCPP 2.0.1) ---

export interface LiveConnectionResult {
  stationId: string;
  protocol: "OCPP 2.0.1";
  checkedAt: string;
  status: "CONNECTED" | "NO_CONNECTION";
  roundTripMs: number | null;
  heartbeatTriggered: boolean;
  evses: Array<{ evseId: number; connectorId: number; connectorStatus: string; timestamp: string }>;
  faultedEvses: number;
  occupiedEvses: number;
  problems: string[];
  ocppExchange: Array<{ at: string; direction: string; frame: unknown }>;
}

export type FirmwareUpdateOutcome = "INSTALLED" | "INSTALL_SCHEDULED" | "FAILED" | "REJECTED" | "NO_RESPONSE" | "TIMEOUT";

export interface FirmwareUpdateResult {
  stationId: string;
  protocol: "OCPP 2.0.1";
  /** 1-based; the agent may reboot the station and retry after a failed download/installation. */
  attempt: number;
  maxAttempts: number;
  /** The FirmwareStatusNotification that ended a FAILED attempt (DownloadFailed, InstallationFailed, …). */
  failedStatus: string | null;
  requestId: number;
  location: string;
  previousVersion: string;
  targetVersion: string;
  startedAt: string;
  outcome: FirmwareUpdateOutcome;
  updateFirmwareStatus: string | null;
  statusInfo: unknown;
  firmwareStatuses: Array<{ at: string; status: string }>;
  reportedFirmwareVersion: string | null;
  problems: string[];
  ocppExchange: Array<{ at: string; direction: string; frame: unknown }>;
}

export interface RebootResult {
  stationId: string;
  protocol: "OCPP 2.0.1";
  reason: string;
  requestedAt: string;
  resetStatus: string | null;
  outcome: "REBOOTED" | "REJECTED" | "NO_RESPONSE" | "NO_BOOT";
  wentOffline: boolean;
  bootedAt: string | null;
  downtimeMs: number | null;
  firmwareVersion: string | null;
  problems: string[];
  ocppExchange: Array<{ at: string; direction: string; frame: unknown }>;
}

/** "Immediately after" snapshot: installation complete, connection status, connector availability. */
export interface PostUpdateCheckResult {
  stationId: string;
  checkedAt: string;
  passed: boolean;
  installationComplete: { passed: boolean; detail: string };
  connection: { passed: boolean; detail: string };
  connectorAvailability: { passed: boolean; detail: string; evses: Array<{ evseId: number; connectorStatus: string }> };
  followUp: FollowUp;
}

export interface FollowUp {
  stationId: string;
  createdAt: string;
  dueAt: string;
  firmwareVersion: string;
  checks: string[];
}

export interface Recommendation {
  stationId: string;
  verdict: Verdict;
  firmwareVersion: string;
  connectionStatus: string;
  completeSessions: number;
  energyDeliveredKWh: number;
  errorCodes: string[];
  ticketId: string | undefined;
  reasons: string[];
  nextActions: string[];
  summary: string;
}
