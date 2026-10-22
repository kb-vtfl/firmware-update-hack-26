import { FIRMWARE_LOCATION_TEMPLATE, TARGET_FIRMWARE_VERSION } from "./config.js";
import { resolveInputFiles } from "./inputs.js";
import { createMockGateway } from "./mockStation.js";
import { firmwareInfo, latestConnectorStatuses, loadStationLog } from "./ocpp.js";
import { checkLiveConnection, firmwareLocation, updateFirmware } from "./stationCommands.js";

const USAGE = `Usage:
  npm run station -- status <stationId|all>
  npm run station -- upgrade <stationId> [targetVersion]

Talks to the (mock) stations directly over OCPP 2.0.1, without the agent or its readiness checks.`;

async function main(): Promise<void> {
  const [command, stationArg, versionArg] = process.argv.slice(2);
  if (!command || !stationArg || !["status", "upgrade"].includes(command)) {
    console.log(USAGE);
    process.exit(1);
  }

  const logs = await Promise.all((await resolveInputFiles([])).map(loadStationLog));
  const gateway = createMockGateway(logs);
  const selected = stationArg === "all" ? logs : logs.filter((l) => l.stationId.toLowerCase() === stationArg.toLowerCase());
  if (selected.length === 0) throw new Error(`Unknown station ${stationArg}. Known: ${logs.map((l) => l.stationId).join(", ")}`);

  for (const log of selected) {
    if (command === "status") {
      const evseIds = [...latestConnectorStatuses(log).keys()];
      console.log(JSON.stringify(await checkLiveConnection(gateway, log.stationId, evseIds.length ? evseIds : [1]), null, 2));
      continue;
    }

    const targetVersion = versionArg ?? TARGET_FIRMWARE_VERSION;
    if (!targetVersion) throw new Error("Pass a targetVersion or set TARGET_FIRMWARE_VERSION");
    const fw = firmwareInfo(log);
    const model = typeof fw["chargePointModel"] === "string" ? fw["chargePointModel"] : "unknown";
    const result = await updateFirmware(gateway, {
      stationId: log.stationId,
      previousVersion: typeof fw["firmwareVersion"] === "string" ? fw["firmwareVersion"] : "unknown",
      targetVersion,
      location: firmwareLocation(FIRMWARE_LOCATION_TEMPLATE, { version: targetVersion, model, stationId: log.stationId }),
    });
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
