import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { OCPP_TRAFFIC_LOG } from "./config.js";
import { CALL, CALL_ERROR, CALL_RESULT, maskCredentials, type OcppCall, type OcppFrame } from "./ocpp201.js";

/** One station's OCPP-J connection (a WebSocket in production, a simulator in the hackathon). */
export interface StationLink {
  /** CSMS -> station. */
  deliver(frame: OcppFrame): void;
  /** Station -> CSMS. */
  onFrame(handler: (frame: OcppFrame) => void): void;
  /** WebSocket dropped (false) or re-established (true), e.g. around a reboot. */
  onConnectionChange?(handler: (online: boolean) => void): void;
}

export type Direction = "CSMS->CS" | "CS->CSMS";

export interface TrafficEntry {
  at: string;
  stationId: string;
  direction: Direction;
  frame: OcppFrame;
}

export class OcppCallError extends Error {
  constructor(
    readonly errorCode: string,
    readonly errorDescription: string,
  ) {
    super(`CALLERROR ${errorCode}: ${errorDescription}`);
  }
}

export class OcppTimeoutError extends Error {}

interface PendingCall {
  stationId: string;
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/** CSMS side: correlates CALL/CALLRESULT, answers station-initiated CALLs and records all traffic. */
export class StationGateway {
  private readonly links = new Map<string, StationLink>();
  private readonly pending = new Map<string, PendingCall>();
  private readonly trafficListeners = new Set<(entry: TrafficEntry) => void>();
  private readonly connectionListeners = new Set<(stationId: string, online: boolean) => void>();
  private logDirReady = false;

  register(stationId: string, link: StationLink): void {
    this.links.set(stationId, link);
    link.onFrame((frame) => this.receive(stationId, frame));
    link.onConnectionChange?.((online) => {
      for (const listener of this.connectionListeners) listener(stationId, online);
    });
  }

  /** Subscribe to station connection drops / reconnects. Returns an unsubscribe function. */
  onConnection(listener: (stationId: string, online: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  has(stationId: string): boolean {
    return this.links.has(stationId);
  }

  /** Sends a CALL and resolves with the CALLRESULT payload; rejects on CALLERROR or timeout. */
  call(stationId: string, action: string, payload: object, timeoutMs: number): Promise<Record<string, unknown>> {
    const link = this.links.get(stationId);
    if (!link) return Promise.reject(new Error(`No OCPP connection registered for ${stationId}`));

    const messageId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new OcppTimeoutError(`${action} to ${stationId}: no response within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(messageId, { stationId, resolve, reject, timer });
      this.send(stationId, link, [CALL, messageId, action, payload]);
    });
  }

  /** Subscribe to every frame in both directions. Returns an unsubscribe function. */
  onTraffic(listener: (entry: TrafficEntry) => void): () => void {
    this.trafficListeners.add(listener);
    return () => this.trafficListeners.delete(listener);
  }

  /**
   * Resolves with the first station-initiated CALL matching action + predicate. Create it before sending
   * the command that triggers the CALL; always await or cancel it.
   */
  waitForStationCall(
    stationId: string,
    action: string,
    predicate: (payload: Record<string, unknown>) => boolean,
    timeoutMs: number,
  ): { promise: Promise<Record<string, unknown>>; cancel: () => void } {
    let unsubscribe: () => void = () => {};
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      unsubscribe = this.onTraffic((entry) => {
        if (entry.stationId !== stationId || entry.direction !== "CS->CSMS" || entry.frame[0] !== CALL) return;
        const [, , frameAction, payload] = entry.frame;
        if (frameAction !== action) return;
        if (!predicate(payload as Record<string, unknown>)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(payload as Record<string, unknown>);
      });
      timer = setTimeout(() => {
        unsubscribe();
        reject(new OcppTimeoutError(`${stationId} did not send ${action} within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    // The waiter may time out before the caller awaits it (e.g. while the triggering CALL is still pending).
    promise.catch(() => {});
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        unsubscribe();
      },
    };
  }

  private receive(stationId: string, frame: OcppFrame): void {
    this.record(stationId, "CS->CSMS", frame);
    const link = this.links.get(stationId);

    if (frame[0] === CALL) {
      if (link) this.send(stationId, link, [CALL_RESULT, frame[1], this.answerStationCall(frame)]);
      return;
    }

    const pending = this.pending.get(frame[1]);
    if (!pending || pending.stationId !== stationId) return;
    this.pending.delete(frame[1]);
    clearTimeout(pending.timer);
    if (frame[0] === CALL_RESULT) pending.resolve(frame[2] as Record<string, unknown>);
    else pending.reject(new OcppCallError(frame[2], frame[3]));
  }

  private answerStationCall([, , action]: OcppCall): object {
    const currentTime = new Date().toISOString();
    switch (action) {
      case "BootNotification":
        return { currentTime, interval: 7200, status: "Accepted" };
      case "Heartbeat":
        return { currentTime };
      default:
        return {};
    }
  }

  private send(stationId: string, link: StationLink, frame: OcppFrame): void {
    this.record(stationId, "CSMS->CS", frame);
    link.deliver(frame);
  }

  private record(stationId: string, direction: Direction, frame: OcppFrame): void {
    const masked = JSON.parse(maskCredentials(JSON.stringify(frame))) as OcppFrame;
    const entry: TrafficEntry = { at: new Date().toISOString(), stationId, direction, frame: masked };
    for (const listener of this.trafficListeners) listener(entry);
    void this.appendLog(entry);
  }

  private async appendLog(entry: TrafficEntry): Promise<void> {
    try {
      if (!this.logDirReady) {
        await mkdir(dirname(OCPP_TRAFFIC_LOG), { recursive: true });
        this.logDirReady = true;
      }
      await appendFile(OCPP_TRAFFIC_LOG, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      console.error(`[ocpp] Failed to write traffic log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
