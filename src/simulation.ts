import { MOCK_FIRMWARE_FAILURES, MOCK_FIRMWARE_STEP_MS, MOCK_LATENCY_MS } from "./config.js";

export const FAILURE_MODES = ["none", "download-once", "install-once", "download-always", "install-always"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

function parseFailures(entries: string[]): Record<string, FailureMode> {
  const failures: Record<string, FailureMode> = {};
  for (const entry of entries) {
    const [stationId, mode] = entry.split("=").map((s) => s.trim());
    if (stationId && FAILURE_MODES.includes(mode as FailureMode)) failures[stationId] = mode as FailureMode;
  }
  return failures;
}

/** Mock station behaviour; mutable so the dashboard can change speed and inject faults during a live demo. */
export const simulation = {
  latencyMs: MOCK_LATENCY_MS,
  firmwareStepMs: MOCK_FIRMWARE_STEP_MS,
  failures: parseFailures(MOCK_FIRMWARE_FAILURES),
};
