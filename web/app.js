// Firmware Rollout Control Room — renders the server's dashboard state (SSE) without a framework.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const fmtDay = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const fmtClock = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : "–");

const STATION_COLORS = ["#37c3e6", "#ffda00", "#a78bfa", "#2fd07f", "#ff8a5b", "#f472b6"];
const CATEGORY = {
  Available: "avail",
  Preparing: "occ",
  Charging: "occ",
  SuspendedEV: "occ",
  SuspendedEVSE: "occ",
  Finishing: "occ",
  Occupied: "occ",
  Reserved: "occ",
  Faulted: "fault",
  Unavailable: "unavail",
};
const category = (status) => CATEGORY[status] ?? "unknown";

const RULES = [
  { id: "connection", label: "Connection status", hint: "live OCPP 2.0.1 TriggerMessage" },
  { id: "sessions", label: "Complete sessions 24h", hint: "StartTransaction + StopTransaction" },
  { id: "energy", label: "Energy delivered", hint: "≥ 2 kWh over the sessions" },
  { id: "errors", label: "Error codes 24h", hint: "StatusNotification errorCode ≠ NoError" },
  { id: "firmware", label: "Firmware version", hint: "latest BootNotification" },
];
const VERDICT_LABEL = {
  READY_FOR_UPGRADE: "READY FOR UPGRADE",
  NOT_READY: "NOT READY",
  NEEDS_INVESTIGATION: "NEEDS INVESTIGATION",
  ALREADY_ON_TARGET: "ALREADY ON TARGET",
};
/** Firmware procedure as drawn in the ops runbook: happy path on top, failures below, reboot & retry loop. */
const FLOW_NODES = {
  downloading: { x: 24, y: 10, label: "Downloading" },
  downloaded: { x: 140, y: 10, label: "Downloaded" },
  installing: { x: 256, y: 10, label: "Installing" },
  boot: { x: 372, y: 10, label: "Boot · new FW" },
  installed: { x: 488, y: 10, label: "Installed" },
  downloadfailed: { x: 24, y: 70, label: "Download failed", kind: "fail" },
  scheduled: { x: 140, y: 70, label: "Install scheduled", kind: "wait" },
  installfailed: { x: 256, y: 70, label: "Install failed", kind: "fail" },
  reboot: { x: 140, y: 124, label: "Reboot & retry", kind: "recover" },
};
const FLOW_EDGES = {
  "downloading>downloaded": "M116 23 H138",
  "downloaded>installing": "M232 23 H254",
  "installing>boot": "M348 23 H370",
  "boot>installed": "M464 23 H486",
  "downloading>downloadfailed": "M70 36 V68",
  "downloaded>scheduled": "M186 36 V68",
  "scheduled>installing": "M232 83 C 262 83, 296 66, 302 38",
  "installing>installfailed": "M302 36 V68",
  "downloadfailed>reboot": "M70 96 V126 Q70 137 82 137 H138",
  "installfailed>reboot": "M302 96 V126 Q302 137 290 137 H234",
  "reboot>downloading": "M186 150 V160 H14 Q6 160 6 152 V31 Q6 23 14 23 H22",
};
const STATUS_NODE = {
  Downloading: "downloading",
  DownloadScheduled: "downloading",
  DownloadPaused: "downloading",
  Downloaded: "downloaded",
  SignatureVerified: "downloaded",
  DownloadFailed: "downloadfailed",
  InvalidSignature: "downloadfailed",
  InstallScheduled: "scheduled",
  Installing: "installing",
  InstallRebooting: "boot",
  InstallationFailed: "installfailed",
  InstallVerificationFailed: "installfailed",
  Installed: "installed",
};
const FAULTS = [
  ["none", "No fault"],
  ["download-once", "Download fails once"],
  ["install-once", "Install fails once"],
  ["download-always", "Download always fails"],
  ["install-always", "Install always fails"],
];
const TAGS = { plan: "PLAN", do: "DO", ok: "OK", issue: "ISSUE", fail: "FAIL", agent: "AGENT", ocpp: "OCPP", info: "INFO", warn: "WARN", error: "ERROR", debug: "DEBUG" };

let snapshots = [];
let state = null;
let meta = {};
const cards = new Map();
const colors = new Map();
let termFilter = "all";
let drawer = { stationId: null, filter: "all", focusRow: null, rule: null };

// ---------- helpers ----------

function setHTML(el, html) {
  if (el && el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
    return true;
  }
  return false;
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 3500);
}

async function api(path, body, raw) {
  const res = await fetch(path, {
    method: "POST",
    headers: raw ? { "Content-Type": "application/octet-stream" } : { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const stationState = (id) => state?.stations?.[id];
const isRunning = () => state?.run?.status === "running";

// ---------- charger illustration ----------

function chargerSVG(s) {
  const ids = s.connectors.length ? s.connectors.map((c) => c.connectorId) : [1];
  const xs = ids.length === 1 ? [70] : ids.map((_, i) => 48 + (i * 44) / (ids.length - 1));
  const sockets = ids
    .map((cid, i) => {
      const side = xs[i] < 70 ? -1 : 1;
      return `<g class="socket cat-unknown" data-connector="${cid}" transform="translate(${xs[i]},134)">
        <path class="cable" d="M0 12 C 0 52, ${side * 36} 46, ${side * 44} 92" />
        <circle class="ring" r="12" /><circle class="face" r="8.5" />
        <circle class="pin" cx="-3.2" cy="-2" r="1.7" /><circle class="pin" cx="3.2" cy="-2" r="1.7" /><circle class="pin" cx="0" cy="3.4" r="1.7" />
        <text class="sock-label" y="25" text-anchor="middle">${cid}</text>
      </g>`;
    })
    .join("");
  return `<svg class="charger" viewBox="0 0 140 236" data-led="ok" aria-label="charging station">
    <rect class="halo" x="22" y="3" width="96" height="214" rx="20" />
    <rect class="body" x="30" y="10" width="80" height="200" rx="14" />
    <rect class="led" x="44" y="19" width="52" height="5" rx="2.5" />
    <rect class="screen" x="39" y="32" width="62" height="48" rx="5" />
    <text class="scr1" x="70" y="50" text-anchor="middle">FW</text>
    <text class="scr2" x="70" y="62" text-anchor="middle"></text>
    <rect class="scr-track" x="46" y="69" width="48" height="4" rx="2" />
    <rect class="scr-fill" x="46" y="69" width="0" height="4" rx="2" />
    <text class="brand" x="70" y="98" text-anchor="middle">ALFEN</text>
    ${sockets}
    <rect class="base" x="22" y="208" width="96" height="10" rx="4" />
  </svg>`;
}

function connectorView(s, d) {
  return s.connectors.map((c) => {
    const live = d?.liveConnectors?.[String(c.connectorId)];
    return { ...c, live: live?.connectorStatus ?? null, liveAt: live?.at ?? null, current: live?.connectorStatus ?? c.status };
  });
}

function updateCharger(svg, s, d) {
  const fw = d?.firmware;
  const connectors = connectorView(s, d);
  const cats = connectors.map((c) => category(c.current));
  const offline = d?.live ? d.live.status !== "CONNECTED" : s.connection.status !== "CONNECTED";

  let led = "ok";
  if (offline) led = "offline";
  else if (fw?.rebooting) led = "rebooting";
  else if (fw?.state === "running" || fw?.state === "recovering") led = "updating";
  else if (fw?.state === "failed" && fw.attempts.length) led = "fault";
  else if (cats.includes("fault")) led = "fault";
  else if (fw?.state === "installed") led = "done";
  else if (cats.includes("occ")) led = "busy";
  svg.dataset.led = led;

  const attempt = fw?.attempts?.at(-1);
  const last = attempt?.statuses?.at(-1)?.status;
  const PROGRESS = { Downloading: 20, Downloaded: 45, Installing: 70, Installed: 100, InstallScheduled: 50 };
  const pct = PROGRESS[last] ?? 0;
  let line1 = `FW ${fw?.currentVersion ?? s.firmwareVersion ?? "?"}`;
  let line2 = cats.includes("fault") ? "fault" : cats.includes("occ") ? "charging" : "available";
  let fill = 0;
  if (offline) [line1, line2] = ["— — —", "no connection"];
  else if (fw?.rebooting) [line1, line2, fill] = ["REBOOT", fw.state === "recovering" ? "recovery reset" : "installing…", pct];
  else if (fw?.state === "recovering") [line1, line2] = ["RECOVER", `retry ${fw.attempts.length + 1}/${fw.maxAttempts}`];
  else if (fw?.state === "running") [line1, line2, fill] = [`⇣ ${fw.targetVersion ?? ""}`, `${last ?? "starting"} #${attempt?.attempt ?? 1}`, pct];
  else if (fw?.state === "installed") [line2, fill] = ["updated ✓", 100];
  else if (fw?.state === "scheduled") [line2, fill] = ["install pending", 50];
  else if (fw?.state === "failed" && fw.attempts.length) line2 = "update failed";
  $(".scr1", svg).textContent = line1;
  $(".scr2", svg).textContent = line2;
  $(".scr-fill", svg).setAttribute("width", String((48 * fill) / 100));

  for (const c of connectors) {
    const g = $(`.socket[data-connector="${c.connectorId}"]`, svg);
    if (!g) continue;
    g.setAttribute("class", `socket cat-${fw?.rebooting || offline ? "unavail" : category(c.current)}`);
  }
}

// ---------- timeline (from the xlsx export) ----------

function timelineSVG(s) {
  const W = 600;
  const L = 64;
  const R = 590;
  const from = Date.parse(s.exportFrom);
  const to = Date.parse(s.exportTo);
  const span = Math.max(to - from, 1);
  const x = (iso) => L + ((Math.min(Math.max(Date.parse(iso), from), to) - from) / span) * (R - L);
  const connectorIds = s.connectors.length ? s.connectors.map((c) => c.connectorId) : [1];
  const top = 22;
  const laneH = 12;
  const laneGap = 26;
  const H = top + connectorIds.length * laneGap + 16;
  const parts = [];

  for (let t = Math.ceil(from / 86_400_000) * 86_400_000; t < to; t += 86_400_000) {
    const tx = x(new Date(t).toISOString());
    const d = new Date(t);
    parts.push(`<line class="tl-tick" x1="${tx}" x2="${tx}" y1="10" y2="${H - 12}" />`);
    parts.push(`<text class="tl-axis" x="${tx + 3}" y="${H - 3}">${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}</text>`);
  }
  const wx = x(s.windowFrom);
  parts.push(`<rect class="tl-window" x="${wx}" y="8" width="${R - wx}" height="${H - 20}" rx="3" />`);
  parts.push(`<text class="tl-window-label" x="${R - 4}" y="17" text-anchor="end">last 24h · analysis window</text>`);

  connectorIds.forEach((cid, i) => {
    const y = top + i * laneGap;
    parts.push(`<text class="tl-label" x="4" y="${y + 10}">Socket ${cid}</text>`);
    parts.push(`<rect class="tl-lane-bg" x="${L}" y="${y}" width="${R - L}" height="${laneH}" rx="2" />`);
    for (const seg of s.timeline.status.filter((g) => g.connectorId === cid)) {
      const x1 = x(seg.from);
      const w = Math.max(x(seg.to) - x1, 1.2);
      parts.push(
        `<rect class="seg cat-${category(seg.status)}" data-row="${seg.row}" x="${x1}" y="${y}" width="${w}" height="${laneH}">` +
          `<title>row ${seg.row} · ${fmtDay(seg.from)} · ${esc(seg.status)}${seg.errorCode && seg.errorCode !== "NoError" ? ` · ${esc(seg.errorCode)}` : ""}</title></rect>`,
      );
    }
    for (const ses of s.timeline.sessions.filter((t) => t.connectorId === cid && t.from && t.to)) {
      const x1 = x(ses.from);
      const w = Math.max(x(ses.to) - x1, 2);
      parts.push(
        `<rect class="sess" data-rows="${ses.rows.join(" ")}" x="${x1}" y="${y + laneH + 2}" width="${w}" height="4" rx="2">` +
          `<title>tx ${ses.transactionId} · ${fmtDay(ses.from)} → ${fmtDay(ses.to)} · ${ses.energyKWh ?? "?"} kWh · rows ${ses.rows.join(", ")}</title></rect>`,
      );
    }
  });

  for (const e of s.timeline.errors) {
    const ex = x(e.at);
    parts.push(`<path class="mk-err" data-row="${e.row}" d="M${ex - 4} 4 L${ex + 4} 4 L${ex} 11 Z"><title>row ${e.row} · ${fmtDay(e.at)} · ${esc(e.errorCode)} (connector ${e.connectorId})</title></path>`);
  }
  for (const b of s.timeline.boots) {
    const bx = x(b.at);
    parts.push(`<path class="mk-boot" data-row="${b.row}" d="M${bx} 2 L${bx + 4} 7 L${bx} 12 L${bx - 4} 7 Z"><title>row ${b.row} · ${fmtDay(b.at)} · BootNotification · firmware ${esc(b.firmwareVersion)}</title></path>`);
  }
  for (const o of s.timeline.operator) {
    const ox = x(o.at);
    parts.push(`<rect class="mk-op" data-row="${o.row}" x="${ox - 2}" y="3" width="4" height="9" rx="1"><title>row ${o.row} · ${fmtDay(o.at)} · ${esc(o.action)} ${esc(o.detail)}</title></rect>`);
  }
  parts.push(`<line class="tl-asof" x1="${R}" x2="${R}" y1="6" y2="${H - 12}" />`);

  return `<div class="tl-title"><span title="Click any mark to open its xlsx row"><b>OCPP history</b> · xlsx export</span><span>${fmtDay(s.exportFrom)} → ${fmtDay(s.exportTo)} UTC</span></div>
    <svg viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>
    <div class="tl-legend"><span><i class="cat-avail"></i>available</span><span><i class="cat-occ"></i>occupied</span><span><i class="cat-fault"></i>faulted</span><span><i class="cat-unavail"></i>unavailable</span><span><i style="background:var(--yellow)"></i>session</span><span><i style="background:var(--red)"></i>error</span><span><i style="background:var(--cyan)"></i>boot</span><span><i style="background:var(--purple)"></i>operator cmd</span></div>`;
}

// ---------- cards ----------

function createCard(s, index) {
  const color = STATION_COLORS[index % STATION_COLORS.length];
  colors.set(s.stationId, color);
  const root = document.createElement("article");
  root.className = "card";
  root.dataset.station = s.stationId;
  root.style.setProperty("--accent", color);
  const device = [s.vendor, s.model, s.serialNumber && `SN ${s.serialNumber}`].filter(Boolean).join(" · ");
  root.innerHTML = `
    <div class="ribbon" data-el="ribbon"></div>
    <header class="card-head">
      <h2>${esc(s.stationId)}</h2>
      <p class="sub">${esc(device || "device details unknown — no BootNotification in export")}</p>
      <div class="head-links">
        <button class="link" data-action="drawer">${esc(s.sourceFile)} · ${s.messageCount} msgs ↗</button>
        <button class="link" data-action="logs">filter console ⌕</button>
        <label class="fault" title="Fault injection on this mock station's firmware procedure">⚠
          <select data-action="fault">${FAULTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        </label>
      </div>
    </header>
    <div class="card-main">
      <div class="charger-wrap">${chargerSVG(s)}</div>
      <div class="facts"><div class="chips" data-el="chips"></div><ul class="connectors" data-el="connectors"></ul></div>
    </div>
    <section class="fw" data-el="fw" data-state="idle">
      <div class="fw-head">
        <span class="fw-title" title="OCPP UpdateFirmware, followed through FirmwareStatusNotification and BootNotification">Firmware update</span>
        <span class="fw-attempt" data-el="fwAttempt"></span>
        <span class="fw-versions" data-el="fwVersions"></span>
      </div>
      <div class="fw-flow">${flowSVG()}</div>
      <div class="fw-note" data-el="fwNote"></div>
      <ol class="fw-history" data-el="fwHistory"></ol>
    </section>
    <section class="post" data-el="post" hidden></section>
    <div class="timeline" data-el="timeline">${timelineSVG(s)}</div>
    <div class="activity" data-el="activity"></div>
    <ol class="checks" data-el="checks"></ol>
    <div class="verdict" data-el="verdict"></div>`;
  const els = Object.fromEntries($$("[data-el]", root).map((el) => [el.dataset.el, el]));
  return { root, els, svg: $(".charger", root), prevChecks: {} };
}

function chipsHTML(s, d) {
  const chips = [];
  if (d?.live) {
    const ok = d.live.status === "CONNECTED";
    chips.push(`<span class="chip ${ok ? "ok" : "bad"}"><span class="src">LIVE</span><b>${esc(d.live.status)}</b>${d.live.roundTripMs != null ? ` ${d.live.roundTripMs} ms` : ""}</span>`);
  } else {
    const ok = s.connection.status === "CONNECTED";
    chips.push(`<span class="chip ${ok ? "ok" : "bad"}" title="From the xlsx: last station message ${s.connection.minutesSince} min before export end (row ${s.connection.row})"><span class="src">XLSX</span><b>${esc(s.connection.status)}</b> · last msg ${s.connection.minutesSince ?? "?"} min</span>`);
  }
  const fw = d?.firmware;
  const version = fw?.currentVersion ?? s.firmwareVersion;
  const upgraded = fw?.state === "installed";
  chips.push(`<span class="chip ${version ? (upgraded ? "ok glow" : "info") : "warn"}"><span class="src">FW</span><b>${esc(version ?? "unknown")}</b>${upgraded ? " ✓" : ""}</span>`);
  chips.push(`<span class="chip ${s.last24h.energyKWh < 2 ? "warn" : ""}"><span class="src">24H</span>${s.last24h.completeSessions} sessions · ${s.last24h.energyKWh} kWh</span>`);
  chips.push(
    s.last24h.errorCodes.length
      ? `<span class="chip bad"><span class="src">ERR</span>${esc(s.last24h.errorCodes.join(", "))} ×${s.last24h.errorCount}</span>`
      : `<span class="chip ok"><span class="src">ERR</span>none in 24h</span>`,
  );
  if (d?.ticket) chips.push(`<span class="chip bad" title="${esc(d.ticket.title)}"><span class="src">TICKET</span>${esc(d.ticket.id)}</span>`);
  return chips.join("");
}

function connectorsHTML(s, d) {
  const list = connectorView(s, d);
  if (!list.length) return `<li><span class="sdot cat-unknown"></span><span class="line1">No StatusNotification in export</span></li>`;
  return list
    .map((c) => {
      const err = c.errorCode && c.errorCode !== "NoError" ? ` <span class="err">· ${esc(c.errorCode)}</span>` : "";
      const live = c.live ? ` <span class="live-tag">LIVE</span> <b>${esc(c.live)}</b>` : "";
      return `<li>
        <span class="sdot cat-${category(c.current)}"></span>
        <span class="line1"><b>Socket ${c.connectorId}</b>${live}</span>
        <span class="line2"><span>xlsx: ${esc(c.status)}${err}</span><span class="row-link" data-row="${c.row}">row ${c.row} · ${fmtDay(c.since)}</span>${c.info ? `<span class="err">"${esc(c.info)}"</span>` : ""}</span>
      </li>`;
    })
    .join("");
}

function checksHTML(d) {
  return RULES.map((r) => {
    const c = d?.checks?.[r.id];
    const st = c?.status ?? "pending";
    const rows = c?.rows ?? [];
    const ev = rows.length
      ? `<button class="ev" data-rule="${r.id}" title="Open the xlsx rows behind this check">rows ${rows.slice(0, 3).map((x) => x.row).join(", ")}${rows.length > 3 ? ` +${rows.length - 3}` : ""} ↗</button>`
      : "<span></span>";
    return `<li class="chk st-${st}" data-rule="${r.id}"><span class="ic"></span><span class="lbl">${r.label}</span><span class="val" title="${esc(c?.value ?? r.hint)}">${esc(c?.value ?? r.hint)}</span>${ev}</li>`;
  }).join("");
}

function verdictHTML(s, d) {
  const rec = d?.recommendation;
  if (!rec) {
    const analysing = isRunning() && Object.values(d?.checks ?? {}).length > 0;
    return analysing
      ? `<span class="pill" style="background:var(--panel-3);color:var(--muted)">ANALYSING…</span> the agent is collecting evidence`
      : `Awaiting agent analysis — this card shows the <b>initial state</b> reconstructed from <span class="mono">${esc(s.sourceFile)}</span>.`;
  }
  const reasons = rec.reasons.map((r) => `<li>${esc(r)}</li>`).join("");
  const actions = rec.nextActions.map((a) => `<li>${esc(a)}</li>`).join("");
  return `<span class="pill v-${rec.verdict}">${VERDICT_LABEL[rec.verdict] ?? rec.verdict}</span><span class="mono">FW ${esc(rec.firmwareVersion)}</span>
    <p>${esc(rec.summary)}</p>
    <details><summary>Rule-by-rule reasoning & next actions</summary><ul>${reasons}</ul>${actions ? `<ul>${actions}</ul>` : ""}</details>
    ${rec.ticketId ? `<div class="ticket">ticket ${esc(rec.ticketId)}</div>` : ""}`;
}

function flowSVG() {
  const edges = Object.entries(FLOW_EDGES)
    .map(([id, d]) => `<path class="edge${id.includes("scheduled") ? " optional" : ""}${id.startsWith("reboot") ? " retry" : ""}" data-edge="${id}" d="${d}" marker-end="url(#flow-arrow)" />`)
    .join("");
  const nodes = Object.entries(FLOW_NODES)
    .map(
      ([id, n]) =>
        `<g class="node ${n.kind ?? "step"}" data-node="${id}" transform="translate(${n.x},${n.y})">` +
        `<rect width="92" height="26" rx="13" /><text x="46" y="17" text-anchor="middle">${n.label}</text></g>`,
    )
    .join("");
  return `<svg class="flow" viewBox="0 0 600 168" aria-label="firmware update state diagram">
    <defs><marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="#4b5f86" /></marker></defs>
    ${edges}${nodes}
    <text class="flow-label" x="12" y="114" transform="rotate(-90 12 114)">retry</text>
    <text class="flow-label" x="240" y="152">OCPP Reset(Immediate) → BootNotification → UpdateFirmware again</text>
  </svg>`;
}

/** Which nodes/edges of the diagram the station has passed through, across all attempts. */
function flowState(fw) {
  const nodes = {};
  const edges = {};
  const take = (from, to, cls = "taken") => {
    const id = `${from}>${to}`;
    if (FLOW_EDGES[id]) edges[id] = cls;
  };
  fw.attempts.forEach((a, index) => {
    const path = a.statuses.map((x) => STATUS_NODE[x.status]).filter(Boolean);
    const sawBoot = Boolean(a.reportedVersion) || path.includes("installed");
    const route = [];
    for (const node of path) {
      if (node === "installed" && sawBoot && route.at(-1) !== "boot") route.push("boot");
      if (route.at(-1) !== node) route.push(node);
    }
    if (sawBoot && route.at(-1) === "installing") route.push("boot");
    route.forEach((node, i) => {
      const kind = FLOW_NODES[node]?.kind;
      nodes[node] = kind === "fail" ? "failed" : kind === "wait" ? "waiting" : node === "installed" ? "done" : "visited";
      if (i > 0) take(route[i - 1], node);
    });
    const inProgress = index === fw.attempts.length - 1 && a.outcome === null;
    if (inProgress) {
      const current = fw.rebooting && route.at(-1) === "installing" ? "boot" : (route.at(-1) ?? "downloading");
      if (current === "boot") take("installing", "boot", "taking");
      nodes[current] = "current";
    }
    const reboot = fw.reboots.find((r) => r.afterAttempt === a.attempt);
    if (reboot) {
      const failedNode = route.at(-1);
      if (failedNode === "downloadfailed" || failedNode === "installfailed") take(failedNode, "reboot", reboot.state === "booted" ? "taken" : "taking");
      nodes.reboot = reboot.state === "booted" ? "recovered" : reboot.state === "failed" ? "failed" : "recovering";
      if (fw.attempts[index + 1]) take("reboot", "downloading", "taken");
    }
  });
  return { nodes, edges };
}

function updateFirmware(card, s, d) {
  const fw = d?.firmware ?? { state: "idle", attempts: [], reboots: [], maxAttempts: 3 };
  const section = card.els.fw;
  section.dataset.state = fw.state;

  const { nodes, edges } = flowState(fw);
  $$(".flow .node", section).forEach((g) => {
    const cls = nodes[g.dataset.node];
    g.setAttribute("class", `node ${FLOW_NODES[g.dataset.node].kind ?? "step"}${cls ? ` ${cls}` : ""}`);
  });
  $$(".flow .edge", section).forEach((p) => {
    const base = `edge${p.dataset.edge.includes("scheduled") ? " optional" : ""}${p.dataset.edge.startsWith("reboot") ? " retry" : ""}`;
    p.setAttribute("class", `${base}${edges[p.dataset.edge] ? ` ${edges[p.dataset.edge]}` : ""}`);
  });

  const target = fw.targetVersion ?? state?.settings?.targetFirmwareVersion ?? "target";
  setHTML(card.els.fwVersions, `${esc(fw.previousVersion ?? s.firmwareVersion ?? "?")} → <span class="to">${esc(fw.state === "installed" ? fw.currentVersion : target)}</span>`);
  setHTML(
    card.els.fwAttempt,
    fw.attempts.length
      ? `attempt ${fw.attempts.length}/${fw.maxAttempts}${fw.reboots.length ? ` · ${fw.reboots.length} reboot${fw.reboots.length > 1 ? "s" : ""}` : ""}`
      : "",
  );

  const last = fw.attempts.at(-1)?.statuses.at(-1)?.status;
  const notes = {
    idle: "Not started — the rollout phase acts on the agent's recommendation.",
    queued: `Queued — the agent re-checks the live connection, then sends UpdateFirmware (${esc(target)}).`,
    skipped: esc(fw.note ?? "Not upgraded"),
    running: fw.rebooting
      ? "Station is rebooting to activate the new image — waiting for its BootNotification…"
      : last
        ? `Station reports <b>${esc(last)}</b> · following FirmwareStatusNotification…`
        : "UpdateFirmware sent — waiting for the station…",
    recovering: fw.rebooting ? "Recovery reboot in progress — station offline, waiting for its BootNotification…" : esc(fw.note ?? "Recovering"),
    installed: esc(fw.note ?? "Installed"),
    scheduled: "Image downloaded — installation is scheduled for when the running charging session ends.",
    failed: esc(fw.note ?? "Firmware update failed"),
  };
  setHTML(card.els.fwNote, `${notes[fw.state] ?? ""}${fw.location ? `<br><span class="mono loc">${esc(fw.location)}</span>` : ""}`);

  const history = [];
  for (const a of fw.attempts) {
    const steps = a.statuses.map((x) => `<span class="${STATUS_NODE[x.status]?.includes("failed") ? "bad" : ""}"><em>${fmtClock(x.at)}</em>${esc(x.status)}</span>`);
    if (a.reportedVersion && a.statuses.some((x) => x.status === "Installed")) {
      steps.splice(steps.length - 1, 0, `<span class="boot"><em>boot</em>FW ${esc(a.reportedVersion)}</span>`);
    }
    const outcome = a.outcome ? `<b class="out out-${esc(a.outcome)}">${esc(a.outcome)}</b>` : `<b class="out out-RUNNING">RUNNING</b>`;
    history.push(`<li><span class="no">#${a.attempt}</span>${steps.join("") || "<span>UpdateFirmware sent</span>"}${outcome}</li>`);
    const reboot = fw.reboots.find((r) => r.afterAttempt === a.attempt);
    if (reboot) {
      const text = {
        requested: "Reset(Immediate) sent",
        offline: "station offline — rebooting",
        booted: `back online after ${((reboot.downtimeMs ?? 0) / 1000).toFixed(1)} s · BootNotification FW ${esc(reboot.firmwareVersion ?? "?")}`,
        failed: "station did not come back",
      }[reboot.state];
      history.push(`<li class="reboot ${reboot.state}"><span class="no">↻</span><span>agent reboot: ${text}</span></li>`);
    }
  }
  setHTML(card.els.fwHistory, history.join(""));
  updatePostCheck(card, d);
}

function updatePostCheck(card, d) {
  const fw = d?.firmware;
  const post = d?.postCheck;
  const visible = Boolean(post) || fw?.state === "installed";
  card.els.post.hidden = !visible;
  if (!visible) return setHTML(card.els.post, "");
  const r = post?.result;
  const item = (label, check) => {
    const st = check ? (check.passed ? "pass" : "fail") : post?.status === "running" ? "running" : "pending";
    return `<li class="chk st-${st}"><span class="ic"></span><span class="lbl">${label}</span><span class="val" title="${esc(check?.detail ?? "")}">${esc(check?.detail ?? (st === "running" ? "checking…" : "waiting for post_update_check"))}</span><span></span></li>`;
  };
  const badge = post?.status === "pass" ? `<span class="pill v-READY_FOR_UPGRADE">PASSED</span>` : post?.status === "fail" ? `<span class="pill v-NOT_READY">FAILED</span>` : `<span class="pill pending">${post ? "CHECKING" : "PENDING"}</span>`;
  const followUp = r?.followUp
    ? `<div class="followup"><span class="clock">⏱</span><div><b>${FOLLOW_UP_LABEL} follow-up scheduled</b> · due ${fmtDay(r.followUp.dueAt)} UTC<br><span>same conditions as before the update: ${r.followUp.checks.map(esc).join(" · ")}</span></div></div>`
    : `<div class="followup muted"><span class="clock">⏱</span><div>${FOLLOW_UP_LABEL} follow-up is scheduled once the immediate snapshot ran.</div></div>`;
  setHTML(
    card.els.post,
    `<div class="post-head"><span><b>After update</b> · immediate snapshot</span>${badge}</div>
     <ol class="checks">${item("Installation complete", r?.installationComplete)}${item("Connection status", r?.connection)}${item("Connector availability", r?.connectorAvailability)}</ol>
     ${followUp}`,
  );
}
const FOLLOW_UP_LABEL = "24h";

function highlightEvidence(card, d) {
  const rows = new Set(Object.values(d?.checks ?? {}).flatMap((c) => c.rows.map((r) => r.row)));
  $$("[data-row]", card.els.timeline).forEach((el) => el.classList.toggle("hl", rows.has(Number(el.dataset.row))));
  $$("[data-rows]", card.els.timeline).forEach((el) =>
    el.classList.toggle("hl", el.dataset.rows.split(" ").some((r) => rows.has(Number(r)))),
  );
}

function updateCard(s) {
  const card = cards.get(s.stationId);
  if (!card) return;
  const d = stationState(s.stationId);
  const rec = d?.recommendation;

  card.root.dataset.verdict = rec?.verdict ?? "";
  card.root.classList.toggle("busy", Boolean(d?.activity) || ["running", "recovering"].includes(d?.firmware?.state));
  const ribbon = card.els.ribbon;
  ribbon.className = `ribbon ${rec ? `v-${rec.verdict}` : ""}`;
  ribbon.textContent = rec ? (VERDICT_LABEL[rec.verdict] ?? rec.verdict) : d && Object.keys(d.checks).length ? "ANALYSING" : "INITIAL STATE · FROM XLSX";

  const fault = $('select[data-action="fault"]', card.root);
  if (fault && document.activeElement !== fault) fault.value = state?.settings?.failures?.[s.stationId] ?? "none";
  setHTML(card.els.chips, chipsHTML(s, d));
  setHTML(card.els.connectors, connectorsHTML(s, d));

  const activity = d?.activity;
  card.els.activity.classList.toggle("on", Boolean(activity));
  setHTML(
    card.els.activity,
    activity
      ? `<span class="spinner"></span><span class="tool">${esc(activity.tool)}</span><span class="intent">${esc(activity.intent)}</span>`
      : `<span class="intent">${rec ? "Agent finished with this station." : isRunning() ? "Waiting for the agent to pick this station up…" : "Agent idle — press Run to start."}</span>`,
  );

  if (setHTML(card.els.checks, checksHTML(d))) {
    for (const r of RULES) {
      const st = d?.checks?.[r.id]?.status;
      if (st && st !== "running" && card.prevChecks[r.id] !== st) $(`.chk[data-rule="${r.id}"]`, card.els.checks)?.classList.add("flash");
      card.prevChecks[r.id] = st;
    }
  }
  setHTML(card.els.verdict, verdictHTML(s, d));
  card.els.verdict.classList.toggle("pending", !rec);
  updateFirmware(card, s, d);
  updateCharger(card.svg, s, d);
  highlightEvidence(card, d);
}

function renderStations() {
  const main = $("#stations");
  main.innerHTML = "";
  cards.clear();
  if (!snapshots.length) {
    main.innerHTML = `<div class="empty">No station exports found in <span class="mono">${esc(meta.inbox ?? "the inbox")}</span>. Drop OCPP <b>.xlsx</b> files here to upload them.</div>`;
  }
  snapshots.forEach((s, i) => {
    const card = createCard(s, i);
    cards.set(s.stationId, card);
    main.appendChild(card.root);
    updateCard(s);
  });
  renderTermFilters();
}

// ---------- top bar / run bar ----------

function renderChrome() {
  const phases = state?.phases ?? [];
  setHTML(
    $("#phases"),
    phases.map((p, i) => `<li class="${p.status}"><span class="n">${p.status === "done" ? "✓" : i + 1}</span>${p.name}</li>`).join(""),
  );

  const run = state?.run;
  const running = isRunning();
  $("#run-btn").disabled = running;
  $("#analyse-btn").disabled = running;
  $("#reset-btn").disabled = running;
  $("#upload-btn").disabled = running;
  $("#speed").value = String(state?.settings?.firmwareStepMs ?? 1800);
  if (![...$("#speed").options].some((o) => o.selected)) $("#speed").value = "1800";

  let html;
  if (!run) {
    html = `<span class="state idle">INITIAL STATE</span><span>Station cards show what the <b>xlsx exports</b> say. Press <b>Run</b> to let the agent analyse them and roll out firmware ${esc(meta.targetFirmwareVersion ?? "")}.</span>`;
  } else {
    const active = state.phases.find((p) => p.status === "active")?.name;
    const elapsed = Math.round(((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) / 1000);
    const thinking = state.agent.thinking ? `<span class="thinking"><span class="spinner"></span>agent reasoning (LLM step ${state.agent.step})</span>` : "";
    html =
      `<span class="state ${run.status}">${run.status.toUpperCase()}</span>` +
      `<span>run <span class="mono">${esc(run.id)}</span> · ${run.upgrade ? "analysis + rollout" : "analysis only"}${active && running ? ` · phase <b>${active}</b>` : ""} · ${elapsed}s</span>` +
      thinking +
      `<span class="spacer"></span>` +
      (state.tickets.length ? `<span class="chip bad">${state.tickets.length} ticket(s)</span>` : "") +
      (run.report ? `<span class="report">report: ${esc(run.report)}</span>` : "") +
      (run.error ? `<span class="chip bad">${esc(run.error)}</span>` : "");
  }
  setHTML($("#runbar"), html);
}

// ---------- terminal ----------

function renderTermFilters() {
  const options = [{ id: "all", label: "all" }, ...snapshots.map((s) => ({ id: s.stationId, label: s.stationId }))];
  $("#term-filters").innerHTML = options
    .map((o) => `<button data-filter="${esc(o.id)}" class="${termFilter === o.id ? "on" : ""}" style="--c:${colors.get(o.id) ?? "var(--yellow)"}">${esc(o.label)}</button>`)
    .join("");
}

function applyTermFilter() {
  for (const ln of $$("#term-body .ln")) {
    const st = ln.dataset.station;
    ln.classList.toggle("hidden", termFilter !== "all" && st !== "" && st !== termFilter);
  }
  renderTermFilters();
}

function logLine(e) {
  const div = document.createElement("div");
  div.dataset.station = e.station ?? "";
  if (e.kind === "banner") {
    div.className = "ln banner";
    div.textContent = `═══ ${e.message} ═══`;
  } else if (e.kind === "phase") {
    div.className = "ln phase";
    div.textContent = `━━ PHASE ${e.message} ━━`;
  } else if (e.kind === "block") {
    div.className = "ln block";
    div.innerHTML = `<pre>${esc(e.message)}</pre>`;
  } else {
    div.className = `ln k-${e.kind} lv-${e.level}${e.station ? "" : " nost"}`;
    div.innerHTML =
      `<span class="t">${esc(e.ts.slice(11, 23))}</span><span class="tag">${TAGS[e.kind] ?? ""}</span>` +
      (e.station ? `<span class="st" data-filter="${esc(e.station)}" style="--c:${colors.get(e.station) ?? "#9fb3d1"}">[${esc(e.station)}]</span>` : "") +
      `<span class="msg">${esc(e.message)}</span>`;
  }
  if (termFilter !== "all" && e.station && e.station !== termFilter) div.classList.add("hidden");
  return div;
}

function appendLogs(entries) {
  const body = $("#term-body");
  const fragment = document.createDocumentFragment();
  for (const e of entries) fragment.appendChild(logLine(e));
  body.appendChild(fragment);
  while (body.childElementCount > 4000) body.firstElementChild.remove();
  if ($("#autoscroll").checked) body.scrollTop = body.scrollHeight;
}

// ---------- xlsx drawer ----------

function evidenceIndex(stationId) {
  const index = new Map();
  for (const [rule, check] of Object.entries(stationState(stationId)?.checks ?? {})) {
    for (const r of check.rows) index.set(r.row, [...(index.get(r.row) ?? []), rule]);
  }
  return index;
}

function renderDrawer() {
  const s = snapshots.find((x) => x.stationId === drawer.stationId);
  if (!s) return;
  const evidence = evidenceIndex(s.stationId);
  const extra = Object.values(stationState(s.stationId)?.checks ?? {}).flatMap((c) => c.rows);
  const known = new Set(s.rows.map((r) => r.row));
  const rows = [...s.rows, ...extra.filter((r) => !known.has(r.row))].sort((a, b) => b.row - a.row);
  const filters = {
    all: () => true,
    evidence: (r) => evidence.has(r.row) && (!drawer.rule || evidence.get(r.row).includes(drawer.rule)),
    status: (r) => r.action === "StatusNotification",
    sessions: (r) => ["StartTransaction", "StopTransaction", "Authorize", "RemoteStartTransaction", "RemoteStopTransaction"].includes(r.action),
    errors: (r) => r.severity === "error" || r.severity === "warn",
    boot: (r) => ["BootNotification", "Reset", "UnlockConnector", "TriggerMessage", "ChangeAvailability"].includes(r.action),
  };
  const labels = { all: "All key rows", evidence: drawer.rule ? `Evidence · ${drawer.rule}` : "Agent evidence", status: "Status", sessions: "Sessions", errors: "Errors & warnings", boot: "Boot & operator" };
  $("#drawer-title").textContent = `${s.stationId} · ${s.sourceFile}`;
  $("#drawer-sub").textContent = `${s.messageCount} messages · ${fmtDay(s.exportFrom)} → ${fmtDay(s.exportTo)} UTC · heartbeats & meter samples hidden · yellow = rows the agent's checks are based on`;
  $("#drawer-filters").innerHTML = Object.keys(filters)
    .map((f) => `<button data-dfilter="${f}" class="${drawer.filter === f ? "on" : ""}">${labels[f]}</button>`)
    .join("");
  const visible = rows.filter(filters[drawer.filter] ?? filters.all);
  $("#drawer-rows").innerHTML =
    visible
      .map((r) => {
        const tags = (evidence.get(r.row) ?? []).map((rule) => `<span class="rule-tag">${rule}</span>`).join("");
        return `<tr class="sev-${r.severity}${evidence.has(r.row) ? " evidence" : ""}" data-r="${r.row}"><td>${r.row}</td><td>${fmtDay(r.at)}:${pad(new Date(r.at).getUTCSeconds())}</td><td>${esc(r.messageType)}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}${tags}</td></tr>`;
      })
      .join("") || `<tr><td colspan="5">No rows for this filter.</td></tr>`;
  if (drawer.focusRow) {
    const tr = $(`#drawer-rows tr[data-r="${drawer.focusRow}"]`);
    if (tr) {
      tr.classList.add("focus");
      tr.scrollIntoView({ block: "center" });
    }
    drawer.focusRow = null;
  }
}

function openDrawer(stationId, options = {}) {
  drawer = { stationId, filter: options.rule ? "evidence" : options.row ? "all" : drawer.stationId === stationId ? drawer.filter : "all", focusRow: options.row ?? null, rule: options.rule ?? null };
  $("#drawer").classList.add("open");
  renderDrawer();
}

/** Deep link: #station=ALF-0011673&row=5 or #station=ALF-0011673&rule=errors opens the xlsx drawer. */
function openFromHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("station");
  if (!id || !snapshots.some((s) => s.stationId === id)) return;
  const row = Number(params.get("row")) || undefined;
  const rule = params.get("rule") ?? undefined;
  const el = $("#drawer");
  el.style.transition = "none";
  openDrawer(id, { ...(row ? { row } : {}), ...(rule ? { rule } : {}) });
  void el.offsetWidth;
  el.style.transition = "";
}

// ---------- events from the server ----------

function connect() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "hello":
        snapshots = msg.stations;
        state = msg.state;
        meta = msg.meta;
        $("#meta").textContent = `model ${meta.deployment} · target firmware ${meta.targetFirmwareVersion ?? "not set"} · OCPP 2.0.1 gateway (mock) · inbox …/${String(meta.inbox).split("/").pop()}`;
        renderStations();
        renderChrome();
        $("#term-body").innerHTML = "";
        appendLogs(msg.logs);
        openFromHash();
        break;
      case "stations":
        snapshots = msg.stations;
        renderStations();
        break;
      case "state":
        state = msg.state;
        snapshots.forEach(updateCard);
        renderChrome();
        if ($("#drawer").classList.contains("open")) renderDrawer();
        break;
      case "log":
        appendLogs([msg.entry]);
        break;
      default:
        break;
    }
  };
  source.onerror = () => {
    $("#meta").textContent = "connection lost — retrying…";
  };
}

// ---------- user actions ----------

async function uploadFiles(files) {
  const xlsx = [...files].filter((f) => f.name.toLowerCase().endsWith(".xlsx"));
  if (!xlsx.length) return toast("Only .xlsx exports can be uploaded", true);
  for (const file of xlsx) {
    try {
      await api(`/api/upload?name=${encodeURIComponent(file.name)}`, null, await file.arrayBuffer());
      toast(`Uploaded ${file.name}`);
    } catch (err) {
      toast(`${file.name}: ${err.message}`, true);
    }
  }
}

function wireUi() {
  $("#run-btn").onclick = () => api("/api/run", { upgrade: true }).catch((e) => toast(e.message, true));
  $("#analyse-btn").onclick = () => api("/api/run", { upgrade: false }).catch((e) => toast(e.message, true));
  $("#reset-btn").onclick = () => api("/api/reset").then(() => toast("Back to the initial state from the xlsx exports")).catch((e) => toast(e.message, true));
  $("#speed").onchange = (e) => api("/api/settings", { firmwareStepMs: Number(e.target.value) }).catch((err) => toast(err.message, true));
  $("#upload-btn").onclick = () => $("#file-input").click();
  $("#file-input").onchange = (e) => uploadFiles(e.target.files).finally(() => (e.target.value = ""));

  $("#stations").addEventListener("change", (e) => {
    const select = e.target.closest('select[data-action="fault"]');
    if (!select) return;
    const stationId = select.closest(".card").dataset.station;
    api("/api/scenario", { stationId, mode: select.value })
      .then(() => toast(select.value === "none" ? `${stationId}: fault injection off` : `${stationId}: ${select.selectedOptions[0].text.toLowerCase()}`))
      .catch((err) => toast(err.message, true));
  });

  $("#stations").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const id = card.dataset.station;
    const action = e.target.closest("[data-action]")?.dataset.action;
    const rule = e.target.closest("[data-rule].ev")?.dataset.rule;
    const row = e.target.closest("[data-row]")?.dataset.row ?? e.target.closest("[data-rows]")?.dataset.rows.split(" ")[0];
    if (action === "drawer") openDrawer(id);
    else if (action === "logs") {
      termFilter = termFilter === id ? "all" : id;
      applyTermFilter();
    } else if (rule) openDrawer(id, { rule });
    else if (row) openDrawer(id, { row: Number(row) });
  });

  $("#drawer-close").onclick = () => $("#drawer").classList.remove("open");
  $("#drawer-filters").onclick = (e) => {
    const f = e.target.closest("[data-dfilter]")?.dataset.dfilter;
    if (f) {
      drawer.filter = f;
      if (f !== "evidence") drawer.rule = null;
      renderDrawer();
    }
  };
  document.addEventListener("keydown", (e) => e.key === "Escape" && $("#drawer").classList.remove("open"));
  window.addEventListener("hashchange", openFromHash);

  $("#term-filters").onclick = (e) => {
    const f = e.target.closest("[data-filter]")?.dataset.filter;
    if (f) {
      termFilter = f;
      applyTermFilter();
    }
  };
  $("#term-body").onclick = (e) => {
    const f = e.target.closest(".st")?.dataset.filter;
    if (f) {
      termFilter = termFilter === f ? "all" : f;
      applyTermFilter();
    }
  };
  $("#show-frames").onchange = (e) => $("#term-body").classList.toggle("hide-debug", !e.target.checked);
  $("#term-clear").onclick = () => ($("#term-body").innerHTML = "");
  $("#term-collapse").onclick = () => {
    document.body.classList.toggle("term-collapsed");
    $("#term-collapse").textContent = document.body.classList.contains("term-collapsed") ? "▴" : "▾";
  };

  let dragStart = null;
  $("#term-resize").onmousedown = (e) => {
    dragStart = { y: e.clientY, h: $("#terminal").getBoundingClientRect().height };
    e.preventDefault();
  };
  window.addEventListener("mousemove", (e) => {
    if (!dragStart) return;
    const h = Math.min(Math.max(dragStart.h + dragStart.y - e.clientY, 120), window.innerHeight * 0.8);
    document.documentElement.style.setProperty("--term-h", `${h}px`);
  });
  window.addEventListener("mouseup", () => (dragStart = null));

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    $("#drop-overlay").classList.add("show");
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) $("#drop-overlay").classList.remove("show");
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("#drop-overlay").classList.remove("show");
    if (isRunning()) return toast("Wait for the current run to finish", true);
    uploadFiles(e.dataTransfer.files);
  });

  setInterval(() => isRunning() && renderChrome(), 1000);
}

wireUi();
connect();
