/**
 * HyperDeck Vibe — Frontend JavaScript
 *
 * Manages:
 *  - WebSocket connection to the Python backend
 *  - UI state (transport, clips, configuration, etc.)
 *  - Command builders for every HyperDeck protocol command
 *  - Console logging of raw protocol traffic
 */

"use strict";

// ============================================================
// WebSocket connection
// ============================================================

let ws = null;
let wsReconnectTimer = null;
const WS_URL = `ws://${location.host}/ws`;

function connectWS() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  clearTimeout(wsReconnectTimer);

  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    consoleLog("info", "WebSocket connected to server");
  });

  ws.addEventListener("message", (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error("WS parse error", e);
    }
  });

  ws.addEventListener("close", () => {
    consoleLog("info", "WebSocket disconnected – reconnecting in 3 s…");
    wsReconnectTimer = setTimeout(connectWS, 3000);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

function sendWS(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast("Not connected to server", "error");
    return;
  }
  ws.send(JSON.stringify(msg));
}

// ============================================================
// Message handlers
// ============================================================

let _hd_connected = false;

function handleServerMessage(msg) {
  switch (msg.type) {

    case "connected":
      _hd_connected = true;
      setConnectionUI(true, msg.host, msg.port);
      consoleLog("info", `Connected to HyperDeck at ${msg.host}:${msg.port}`);
      // Subscribe to default notifications after connect
      setTimeout(applyNotify, 500);
      break;

    case "disconnected":
      _hd_connected = false;
      setConnectionUI(false);
      consoleLog("info", "HyperDeck disconnected");
      break;

    case "state":
      updateStateUI(msg.state);
      break;

    case "hyperdeck":
      // Raw line received from HyperDeck
      onHyperDeckLine(msg.line);
      break;

    case "sent":
      // Echo of a command we sent
      consoleLog("sent", `→ ${msg.line}`);
      break;

    case "error":
      consoleLog("error", msg.message);
      showToast(msg.message, "error");
      break;
  }
}

// ============================================================
// Protocol line parser (for console + UI population)
// ============================================================

// Multi-line accumulator for console
let _mlLines = [];
let _inML = false;

function onHyperDeckLine(line) {
  if (!_inML) {
    const code = parseInt(line.split(" ")[0], 10);
    if (line.includes(":") && !isNaN(code)) {
      _inML = true;
      _mlLines = [line];
      consoleLog("recv", `← ${line}`, code);
      return;
    }
    consoleLog("recv", `← ${line}`, code);
    handleSingleResponse(code, {});
  } else {
    if (line === "") {
      _inML = false;
      const kv = parseKV(_mlLines.slice(1));
      const code = parseInt(_mlLines[0].split(" ")[0], 10);
      handleMultiResponse(code, kv);
      _mlLines = [];
    } else {
      _mlLines.push(line);
      consoleLog("recv", `   ${line}`);
    }
  }
}

function parseKV(lines) {
  const result = {};
  for (const l of lines) {
    const idx = l.indexOf(": ");
    if (idx !== -1) {
      result[l.slice(0, idx).trim()] = l.slice(idx + 2).trim();
    }
  }
  return result;
}

function handleSingleResponse(code, kv) {
  // e.g. "100 ok"
}

function handleMultiResponse(code, kv) {
  if (code === 101 || code === 200) {
    // device info
    const model = kv["model"] || kv["unique id"] || "";
    if (model) {
      el("devModel").textContent = model;
      el("devProtocol").textContent = kv["protocol version"] || "—";
      el("deviceInfo").hidden = false;
    }
    populateResult("deviceInfoResult", kv);
  } else if (code === 202) {
    // transport info – update sidebar widgets
    updateTransportSidebar(kv);
  } else if (code === 203) {
    // remote info
    const enabled = (kv["enabled"] || "").toLowerCase() === "true";
    el("remoteEnabled").checked = enabled;
    el("remoteStatus").textContent = `Remote control is ${enabled ? "enabled" : "disabled"}`;
  } else if (code === 204) {
    // configuration
    safeSetSelect("cfgVideoInput",         kv["video input"]);
    safeSetSelect("cfgAudioInput",         kv["audio input"]);
    safeSetSelect("cfgFileFormat",         kv["file format"]);
    safeSetSelect("cfgAudioCodec",         kv["audio codec"]);
    safeSetSelect("cfgTimecodeInput",      kv["timecode input"]);
    safeSetSelect("cfgTimecodeOutput",     kv["timecode output"]);
    safeSetSelect("cfgTimecodePreference", kv["timecode preference"]);
    safeSetValue("cfgTimecodePreset",      kv["timecode preset"]);
    safeSetValue("cfgAudioChannels",       kv["audio input channels"]);
    safeSetSelect("cfgRecordTrigger",      kv["record trigger"]);
    safeSetValue("cfgRecordPrefix",        kv["record prefix"]);
    if (kv["append timestamp"] !== undefined)
      el("cfgAppendTimestamp").checked = kv["append timestamp"].toLowerCase() === "true";
  } else if (code === 205) {
    // clips info
    renderClipList(kv);
  } else if (code === 201) {
    // slot info
    populateResult("slotInfoResult", kv);
    el("slotInfoResult").hidden = false;
  } else if (code === 206) {
    // disk list
    populateResult("diskListResult", kv);
    el("diskListResult").hidden = false;
  } else if (code === 207) {
    // uptime
    populateResult("uptimeResult", kv);
    el("uptimeResult").hidden = false;
  } else if (code === 211) {
    // cache info
    populateResult("cacheInfoResult", kv);
    el("cacheInfoResult").hidden = false;
  } else if (code === 210) {
    // notify / playrange
    updateNotifyUI(kv);
  } else if (code === 500) {
    // connection info – model / protocol
    const model = kv["model"] || "";
    if (model) {
      el("devModel").textContent = model;
      el("devProtocol").textContent = kv["protocol version"] || "—";
      el("deviceInfo").hidden = false;
    }
  }
}

function updateTransportSidebar(kv) {
  const status = (kv["status"] || "").toLowerCase();
  const badge = el("tsStatus");
  badge.textContent = kv["status"] || "—";
  badge.dataset.status = status;
  badge.className = "status-badge";

  el("tsTimecode").textContent = kv["timecode"] || kv["display timecode"] || "—";
  el("tsClip").textContent     = kv["clip id"]  || "—";
  el("tsSlot").textContent     = kv["slot id"]  || "—";
  el("tsSpeed").textContent    = kv["speed"]    !== undefined ? kv["speed"] + "%" : "—";
  el("tsLoop").textContent     = kv["loop"]     || "—";
  el("tsFormat").textContent   = kv["video format"] || "—";

  // Update dot colour
  const dot = el("statusBadge").querySelector(".dot");
  dot.className = "dot " + (status === "record" ? "dot--danger" :
                             status === "play"   ? "dot--ok" : "dot--ok");
}

function updateNotifyUI(kv) {
  const map = {
    "remote":           "notRemote",
    "transport":        "notTransport",
    "slot":             "notSlot",
    "configuration":    "notConfiguration",
    "dropped frames":   "notDroppedFrames",
    "display timecode": "notDisplayTimecode",
    "timeline position":"notTimelinePosition",
    "playrange":        "notPlayrange",
    "cache":            "notCache",
  };
  for (const [key, id] of Object.entries(map)) {
    if (kv[key] !== undefined) el(id).checked = kv[key].toLowerCase() === "true";
  }
}

function renderClipList(kv) {
  // kv contains: clip count, then entries like "0: {id} {name} {timecode_in} {timecode_out}"
  const count = parseInt(kv["clip count"] || "0", 10);
  el("clipCount").textContent = count;
  const container = el("clipTable");

  if (count === 0) {
    container.innerHTML = "<p class='hint'>No clips on disk.</p>";
    return;
  }

  const rows = [];
  for (let i = 0; i < count; i++) {
    const entry = kv[String(i)];
    if (entry !== undefined) {
      // entry format: "clipId: name startTimecode durationTimecode"
      // or may be indexed by clip id
      rows.push({ id: i, raw: entry });
    }
  }

  // Also look for "clip id: X" style
  // Attempt structured parse
  let html = `<table><thead><tr>
    <th>#</th><th>Name</th><th>In</th><th>Out</th><th>Duration</th><th>Actions</th>
  </tr></thead><tbody>`;

  for (const row of rows) {
    const parts = row.raw.split(/\s+/);
    const name  = parts[0] || "—";
    const tcIn  = parts[1] || "—";
    const tcOut = parts[2] || "—";
    const dur   = parts[3] || "—";
    html += `<tr>
      <td>${row.id + 1}</td>
      <td>${escHtml(name)}</td>
      <td class="mono">${escHtml(tcIn)}</td>
      <td class="mono">${escHtml(tcOut)}</td>
      <td class="mono">${escHtml(dur)}</td>
      <td class="clip-actions">
        <button class="btn btn--sm btn--secondary"
          onclick="sendCmd('goto clip id: ${row.id + 1}')">▶ Play</button>
        <button class="btn btn--sm btn--secondary"
          onclick="sendCmd('clips remove clip id: ${row.id + 1}')">✕</button>
      </td>
    </tr>`;
  }
  html += "</tbody></table>";
  container.innerHTML = html;
}

// ============================================================
// State update from server-side tracker
// ============================================================

function updateStateUI(state) {
  if (!state) return;

  // Connection dot
  const dot = document.querySelector(".topbar__status .dot");
  const statusText = el("statusText");

  if (state.connected) {
    dot.className = "dot dot--ok";
    statusText.textContent = `${state.model || "HyperDeck"} @ ${state.host}`;
  } else {
    dot.className = "dot dot--off";
    statusText.textContent = "Disconnected";
  }

  if (state.model) {
    el("devModel").textContent    = state.model;
    el("devProtocol").textContent = state.protocol_version || "—";
    el("deviceInfo").hidden = false;
  }

  if (state.transport_status) {
    updateTransportSidebar({
      status:          state.transport_status,
      timecode:        state.timecode || state.display_timecode,
      "clip id":       String(state.clip_id || ""),
      "slot id":       String(state.slot_id || ""),
      speed:           String(state.speed || 0),
      loop:            String(state.loop || false),
      "video format":  state.video_format,
    });
  }

  if (typeof state.remote_enabled === "boolean") {
    el("remoteEnabled").checked = state.remote_enabled;
    el("remoteStatus").textContent = `Remote control is ${state.remote_enabled ? "enabled" : "disabled"}`;
  }

  if (state.video_input)  safeSetSelect("cfgVideoInput", state.video_input);
  if (state.audio_input)  safeSetSelect("cfgAudioInput", state.audio_input);
  if (state.file_format)  safeSetSelect("cfgFileFormat",  state.file_format);
}

// ============================================================
// UI helpers
// ============================================================

function el(id) { return document.getElementById(id); }

function setConnectionUI(connected, host, port) {
  el("btnConnect").disabled    = connected;
  el("btnDisconnect").disabled = !connected;
  el("inputHost").disabled     = connected;
  el("inputPort").disabled     = connected;

  const dot = document.querySelector(".topbar__status .dot");
  const txt = el("statusText");
  if (connected) {
    dot.className = "dot dot--ok";
    txt.textContent = `Connected to ${host}:${port}`;
  } else {
    dot.className = "dot dot--off";
    txt.textContent = "Disconnected";
    el("deviceInfo").hidden = true;
  }
}

function safeSetSelect(id, value) {
  const sel = el(id);
  if (!sel || !value) return;
  for (const opt of sel.options) {
    if (opt.value === value || opt.text === value) { sel.value = opt.value; return; }
  }
}

function safeSetValue(id, value) {
  const inp = el(id);
  if (inp && value !== undefined) inp.value = value;
}

function populateResult(id, kv) {
  const box = el(id);
  if (!box) return;
  box.textContent = Object.entries(kv).map(([k, v]) => `${k}: ${v}`).join("\n");
  box.hidden = false;
}

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let _toastTimer = null;
function showToast(msg, type) {
  const t = el("toast");
  t.textContent = msg;
  t.className = "toast " + (type || "");
  t.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ============================================================
// Console
// ============================================================

function consoleLog(type, text, code) {
  const div = el("console");
  const line = document.createElement("div");
  line.className = "console-line console-line--" + type;
  if (type === "recv" && code >= 500) line.classList.add("code-5xx");
  if (type === "recv" && code < 200)  line.classList.add("code-1xx");
  line.textContent = text;
  div.appendChild(line);

  const scroll = el("consoleScroll");
  if (!scroll || scroll.checked) div.scrollTop = div.scrollHeight;
}

function clearConsole() {
  el("console").innerHTML = "";
}

// ============================================================
// Tab navigation
// ============================================================

document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    el("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ============================================================
// Connection actions
// ============================================================

el("btnConnect").addEventListener("click", () => {
  const host = el("inputHost").value.trim();
  const port = parseInt(el("inputPort").value, 10) || 9993;
  if (!host) { showToast("Please enter a host/IP address", "error"); return; }
  sendWS({ action: "connect", host, port });
});

el("btnDisconnect").addEventListener("click", () => {
  sendWS({ action: "disconnect" });
});

// ============================================================
// Command helpers
// ============================================================

/** Send a raw command string via the server. */
function sendCmd(command) {
  sendWS({ action: "command", command });
}

// ============================================================
// Transport tab
// ============================================================

function applyPlay() {
  const speed     = el("playSpeed").value;
  const loop      = el("playLoop").checked;
  const single    = el("playSingleClip").checked;
  let cmd = "play";
  if (speed !== "100") cmd += ` speed: ${speed}`;
  if (loop)            cmd += " loop: true";
  if (single)          cmd += " single clip: true";
  sendCmd(cmd);
}

function applyRecord() {
  const name = (el("recordName")?.value || "").trim();
  let cmd = "record";
  if (name) cmd += ` name: ${name}`;
  sendCmd(cmd);
}

function gotoClipEnd() {
  sendCmd("goto clip: end");
}

function applyJog() {
  const tc = el("jogTimecode").value.trim();
  if (!tc) { showToast("Enter a timecode for jog", "error"); return; }
  sendCmd(`jog timecode: ${tc}`);
}

function applyShuttle() {
  const speed = el("shuttleSpeed").value;
  sendCmd(`shuttle speed: ${speed}`);
}

function shuttle(speed) {
  el("shuttleSpeed").value = speed;
  sendCmd(`shuttle speed: ${speed}`);
}

function applyGoto() {
  const parts = [];
  const clipId   = el("gotoClipId").value.trim();
  const clipPos  = el("gotoClipPos").value;
  const timeline = el("gotoTimeline").value.trim();
  const slotId   = el("gotoSlot").value.trim();
  const timecode = el("gotoTimecode").value.trim();

  if (clipId)   parts.push(`clip id: ${clipId}`);
  if (clipPos)  parts.push(`clip: ${clipPos}`);
  if (timeline) parts.push(`timeline: ${timeline}`);
  if (slotId)   parts.push(`slot id: ${slotId}`);
  if (timecode) parts.push(`timecode: ${timecode}`);

  if (parts.length === 0) { showToast("Specify at least one goto parameter", "error"); return; }
  sendCmd("goto " + parts.join(" "));
}

function applyPlayrange() {
  const clipId = el("prClipId").value.trim();
  const tcIn   = el("prIn").value.trim();
  const tcOut  = el("prOut").value.trim();
  const parts  = [];
  if (clipId) parts.push(`clip id: ${clipId}`);
  if (tcIn)   parts.push(`in: ${tcIn}`);
  if (tcOut)  parts.push(`out: ${tcOut}`);
  if (parts.length === 0) { showToast("Specify at least one playrange parameter", "error"); return; }
  sendCmd("playrange set " + parts.join(" "));
}

function applyPreview() {
  const enabled = el("previewEnable").checked;
  sendCmd(`preview enable: ${enabled}`);
}

// ============================================================
// Clips tab
// ============================================================

function applyClipsGet() {
  const clipId = el("clipsGetId").value.trim();
  const count  = el("clipsGetCount").value.trim();
  let cmd = "clips get";
  if (clipId) cmd += ` clip id: ${clipId}`;
  if (count)  cmd += ` count: ${count}`;
  sendCmd(cmd);
}

function applyClipAdd() {
  const name = el("clipAddName").value.trim();
  if (!name) { showToast("Enter a clip name", "error"); return; }
  sendCmd(`clips add name: ${name}`);
}

function applyClipRemove() {
  const id = el("clipRemoveId").value.trim();
  if (!id) { showToast("Enter a clip ID to remove", "error"); return; }
  sendCmd(`clips remove clip id: ${id}`);
}

function applyRecordSpill() {
  const slot = el("recordSpillSlot").value.trim();
  let cmd = "record spill";
  if (slot) cmd += ` slot id: ${slot}`;
  sendCmd(cmd);
}

// ============================================================
// Slots / Disk tab
// ============================================================

function applySlotInfo() {
  const id = el("slotInfoId").value.trim();
  let cmd = "slot info";
  if (id) cmd += ` slot id: ${id}`;
  el("slotInfoResult").hidden = true;
  sendCmd(cmd);
}

function applySlotSelect() {
  const id = el("slotSelectId").value.trim();
  if (!id) { showToast("Enter a slot ID", "error"); return; }
  sendCmd(`slot select slot id: ${id}`);
}

function applySlotEject() {
  const id = el("slotEjectId").value.trim();
  if (!id) { showToast("Enter a slot ID", "error"); return; }
  sendCmd(`slot eject slot id: ${id}`);
}

function applyDiskList() {
  const slot = el("diskListSlot").value.trim();
  let cmd = "disk list";
  if (slot) cmd += ` slot id: ${slot}`;
  el("diskListResult").hidden = true;
  sendCmd(cmd);
}

let _formatToken = null;

function applyFormatPrepare() {
  const fs   = el("formatPrepare").value;
  const slot = el("formatSlotId").value.trim();
  let cmd = `format prepare: ${fs}`;
  if (slot) cmd += ` slot id: ${slot}`;
  sendCmd(cmd);
  // After prepare, a token will come back in the response — wait for it
  el("formatHint").textContent = "Waiting for format token from device…";
  el("btnFormatConfirm").disabled = false;
  // The token should appear in the console; user will need to confirm
  _formatToken = "confirm";  // placeholder – actual token arrives in response
}

function applyFormatConfirm() {
  if (!_formatToken) { showToast("Run Prepare Format first", "error"); return; }
  sendCmd(`format confirm: ${_formatToken}`);
  el("btnFormatConfirm").disabled = true;
  el("formatHint").textContent = "Format command sent.";
}

function applyExpand() {
  const enabled = el("expandEnable").checked;
  sendCmd(`expand enable: ${enabled}`);
}

// ============================================================
// Configuration tab
// ============================================================

function applyConfig() {
  const params = [];
  const add = (key, id, type = "value") => {
    const e = el(id);
    if (!e) return;
    const val = type === "checkbox" ? String(e.checked) : e.value.trim();
    if (val && val !== "") params.push(`${key}: ${val}`);
  };

  add("video input",          "cfgVideoInput");
  add("audio input",          "cfgAudioInput");
  add("file format",          "cfgFileFormat");
  add("audio codec",          "cfgAudioCodec");
  add("timecode input",       "cfgTimecodeInput");
  add("timecode output",      "cfgTimecodeOutput");
  add("timecode preference",  "cfgTimecodePreference");
  add("timecode preset",      "cfgTimecodePreset");
  add("audio input channels", "cfgAudioChannels");
  add("record trigger",       "cfgRecordTrigger");
  add("record prefix",        "cfgRecordPrefix");
  add("append timestamp",     "cfgAppendTimestamp", "checkbox");

  if (params.length === 0) { showToast("No configuration changes", "error"); return; }
  sendCmd("configuration " + params.join(" "));
}

// ============================================================
// Notifications tab
// ============================================================

function applyNotify() {
  const map = {
    remote:            "notRemote",
    transport:         "notTransport",
    slot:              "notSlot",
    configuration:     "notConfiguration",
    "dropped frames":  "notDroppedFrames",
    "display timecode":"notDisplayTimecode",
    "timeline position":"notTimelinePosition",
    playrange:         "notPlayrange",
    cache:             "notCache",
  };
  const parts = Object.entries(map)
    .map(([key, id]) => `${key}: ${el(id).checked}`);
  sendCmd("notify " + parts.join(" "));
}

// ============================================================
// Remote control
// ============================================================

function applyRemote() {
  const enabled = el("remoteEnabled").checked;
  sendCmd(`remote enable: ${enabled}`);
}

// ============================================================
// Advanced tab
// ============================================================

function applyIdentify() {
  const enabled = el("identifyEnable").checked;
  sendCmd(`identify enable: ${enabled}`);
}

function applyWatchdog() {
  const period = el("watchdogPeriod").value;
  sendCmd(`watchdog period: ${period}`);
}

// ============================================================
// Console raw command
// ============================================================

function sendRawCommand() {
  const cmd = el("rawCommand").value.trim();
  if (!cmd) return;
  sendCmd(cmd);
  el("rawCommand").value = "";
}

el("rawCommand").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendRawCommand();
});

function sendConsoleCommand() {
  const cmd = el("consoleInput").value.trim();
  if (!cmd) return;
  sendCmd(cmd);
  el("consoleInput").value = "";
}

el("consoleInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendConsoleCommand();
});

// ============================================================
// Format confirm token extraction
// Watch console output for the token returned after format prepare
// ============================================================

const _origOnHDLine = onHyperDeckLine;
// Patch to also capture format token
(function() {
  const orig = onHyperDeckLine;
  // We detect "format token: <value>" in incoming lines
  window.addEventListener("hyperdeck-format-token", (e) => {
    _formatToken = e.detail;
    el("formatHint").textContent = `Token received: ${_formatToken}. Click Confirm Format to proceed.`;
  });
})();

// ============================================================
// Boot
// ============================================================

connectWS();
