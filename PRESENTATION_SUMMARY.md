# Firmware Upgrade Readiness Agent — Technical Summary

---

## Slide 1 — What it does

**An AI agent that decides which EV charging stations are safe to upgrade, upgrades them, and reports the outcome.**

- Input: OCPP log exports (`.xlsx`), one file per station
- Checks every station against 5 business rules
- Rolls out new firmware to the stations that pass
- Recovers from failures, raises tickets, writes a report

---

## Slide 2 — Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22, TypeScript |
| AI model | Azure AI Foundry, Responses API (function calling) |
| Station protocol | OCPP 1.6 (log exports), OCPP 2.0.1 (live commands) |
| UI | Plain HTML/CSS/JS dashboard, live updates over Server-Sent Events |
| Hosting | Docker image on Azure Container Apps, built in Azure Container Registry |
| Storage | Azure Files share for reports, tickets, run logs |

Only one runtime dependency (`fflate` to unzip `.xlsx` files). No agent framework: we wrote the agent loop ourselves.

---

## Slide 3 — Architecture

```
  Upload .xlsx  ──►  Ingest & parse  ──►  AI Agent loop  ◄──►  Azure AI Foundry (LLM)
  (dashboard or          (OCPP 1.6            │
   watched folder)        messages)           ▼
                                         Tool layer (13 tools)
                                   ┌──────────┼───────────┐
                                   ▼          ▼           ▼
                             Log queries   OCPP 2.0.1   Tickets, reports,
                             (sessions,    gateway ──►  follow-ups
                              errors…)     stations     (output/)
                                              │
                    Dashboard (SSE) ◄─────────┴── live firmware status & logs
```

- **The LLM decides**, **the tools compute**: the model never sees raw logs, only verified tool results
- Each phase gets only the tools it needs, so the analysis agent cannot trigger an upgrade

---

## Slide 4 — How a run works (4 phases)

1. **Ingest:** parse the OCPP exports into messages for each station
2. **Analysis (agent):** apply the rules and give each station one verdict
   - `READY_FOR_UPGRADE` · `NEEDS_INVESTIGATION` · `NOT_READY` · `ALREADY_ON_TARGET`
3. **Upgrade (agent):** send `UpdateFirmware` to the stations marked ready, one at a time
4. **Report (agent):** write a summary for operations (HTML / Markdown / JSON)

If the report agent fails, a fallback builds the same report from the run data.

---

## Slide 5 — Business rules (analysis phase)

| # | Check | Source |
|---|---|---|
| 1 | Live connection (no connection → ticket) | OCPP 2.0.1 live check |
| 2 | Complete sessions in the last 24 h | Log export |
| 3 | Energy delivered ≥ 2 kWh | Log export |
| 4 | No error codes in the last 24 h | Log export |
| 5 | Known firmware version | Latest `BootNotification` |

Most severe verdict wins. All thresholds can be changed through environment variables.

---

## Slide 6 — Firmware rollout & self-healing

- Re-checks the connection right before each upgrade
- Follows the firmware status: `Downloading → Downloaded → Installing → Reboot → Installed`
- Download or install failed: **reboot the station and retry** (up to 3 attempts)
- Station rejects the command or doesn't respond: **create a ticket** with the evidence
- After install, a post-update check (installation, connection, connectors) runs and a **24 h follow-up** is scheduled

---

## Slide 7 — Agent tools

| Phase | Tools |
|---|---|
| Analysis | `list_stations`, `get_connection_status`, `get_sessions`, `get_errors`, `get_firmware_info`, `get_connection_history`, `get_messages`, `create_ticket`, `submit_recommendation` |
| Upgrade | `get_connection_status`, `upgrade_firmware`, `reboot_station`, `post_update_check`, `create_ticket` |
| Report | `generate_report` |

- Every tool call includes an **"intent"** sentence, so operators can see why the agent did each step
- The agent is reminded if it tries to finish before covering every station

---

## Slide 8 — Dashboard & demo setup

- **Firmware Rollout Control Room:** upload files, start an analysis-only run or a full rollout, see live station cards
- Live console shows the same output as the server terminal, with optional raw OCPP frames
- Click any rule result to see the `.xlsx` rows behind it
- **Mock OCPP 2.0.1 stations** stand in for real chargers, with fault injection (offline, download/install failures) controlled from the UI
- Deployed with one command: `npm run deploy:azure`

---

## Slide 9 — Production readiness

- Swap the mock gateway for real OCPP WebSocket connections (same `StationGateway` interface)
- Connect tickets and follow-ups to a real ticketing system and scheduler
- Full audit trail: JSON-lines run log + OCPP traffic log for every run
