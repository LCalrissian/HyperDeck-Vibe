/**
 * HyperDeck Vibe — Browser-side JavaScript
 *
 * Responsibilities:
 *  • Maintain the WebSocket connection to the backend (app.py)
 *  • Send HyperDeck commands via { action: "command", command: "…" } messages
 *  • Parse every incoming response and update the UI state model
 *  • Drive every UI widget described in index.html
 *
 * Protocol reference: Blackmagic HyperDeck Ethernet Protocol (December 2024)
 *
 * Response code summary (see app.py for full table):
 *   200 ok | 201 help | 202 slot info | 204 device info | 205 clips info
 *   206 disk list | 208 transport info | 209 notify | 210 remote info
 *   211 configuration | 212 commands | 213 deck rebooting | 214 clips count
 *   225 nas host info | 226 external drive info
 *   Async: 500 connection info | 502 slot | 508 transport | 510 remote
 *          511 configuration | 519 clips | 520 disk list
 *   Errors: 100–112, 120–122, 150–151, 160–163
 */

"use strict";

// ============================================================
// SECTION: Application state
// ============================================================

/**
 * Live mirror of the last-known device state, received from the backend as
 * { type: "state", state: { … } } messages.
 */
let deviceState = {};

/** Current WebSocket instance (null when disconnected). */
let socket = null;

/** Command history for the console's ↑/↓ navigation. */
const commandHistory = [];
let historyIndex = -1;

/** Accumulated partial token from the format command (two-step flow). */
let pendingFormatToken = "";

/** Watchdog interval handle (pings the device periodically). */
let watchdogIntervalId = null;
const WATCHDOG_INTERVAL_MS = 20_000;

// ============================================================
// SECTION: WebSocket management
// ============================================================

/**
 * Open a WebSocket connection to the backend and register all message handlers.
 * Called by the Connect button after user input validation.
 */
function openWebSocket() {
  const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${location.host}/ws`;

  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    consoleLog("— WebSocket connected to server —", "cl--connect");
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      consoleLog(`[JSON parse error] ${event.data}`, "cl--error");
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    consoleLog("— WebSocket closed —", "cl--disconnect");
    updateConnectionUI(false);
    socket = null;
    stopWatchdog();
  });

  socket.addEventListener("error", () => {
    consoleLog("[WebSocket error]", "cl--error");
  });
}

/**
 * Send a JSON message to the backend over the WebSocket.
 * Silently drops the message if the socket is not OPEN.
 */
function sendToBackend(payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

// ============================================================
// SECTION: Incoming message router
// ============================================================

/**
 * Route a decoded JSON message from the backend to the appropriate handler.
 *
 * Message types:
 *   connected    – HyperDeck TCP handshake complete
 *   disconnected – TCP connection was closed
 *   raw_line     – verbatim line from HyperDeck (for console display)
 *   sent         – command we sent (echo-back for console)
 *   response     – parsed protocol response (code + kv data)
 *   state        – full device state snapshot from backend
 *   error        – server-side error
 */
function handleServerMessage(message) {
  switch (message.type) {
    case "connected":
      updateConnectionUI(true, message.host, message.port);
      startWatchdog();
      break;

    case "disconnected":
      updateConnectionUI(false);
      stopWatchdog();
      break;

    case "raw_line":
      handleRawConsoleLine(message.line);
      break;

    case "sent":
      // Display the command we sent in a distinct colour
      consoleLog(`→ ${message.line}`, "cl--sent");
      break;

    case "response":
      handleParsedResponse(message.code, message.text, message.data || {});
      break;

    case "state":
      deviceState = message.state || {};
      applyStateToUI(deviceState);
      break;

    case "error":
      showToast(message.message, "error");
      consoleLog(`[Error] ${message.message}`, "cl--error");
      break;

    default:
      consoleLog(`[Unknown message type: ${message.type}]`, "cl--error");
  }
}

// ============================================================
// SECTION: Raw console line display
// ============================================================

/**
 * Classify a raw protocol line and append it to the console with colour coding.
 * Line classification is based on the numeric response code in the first token.
 */
function handleRawConsoleLine(rawLine) {
  if (rawLine === "") {
    // Blank line separates multiline blocks; show as faint separator
    consoleLog("", "cl--blank");
    return;
  }

  const codeMatch = rawLine.match(/^(\d{3})\s/);
  if (!codeMatch) {
    // Continuation line inside a multiline block (key: value pairs)
    consoleLog(`   ${rawLine}`, "cl--data");
    return;
  }

  const code = parseInt(codeMatch[1], 10);

  if (code === 200) {
    consoleLog(rawLine, "cl--200");
  } else if (code >= 201 && code <= 299) {
    consoleLog(rawLine, "cl--info");
  } else if (code >= 500 && code <= 599) {
    consoleLog(rawLine, "cl--async");
  } else if (code >= 100 && code <= 199) {
    consoleLog(rawLine, "cl--error");
  } else {
    consoleLog(rawLine, "cl");
  }
}

// ============================================================
// SECTION: Parsed response handler
// ============================================================

/**
 * Handle a fully parsed protocol response block.
 * Updates UI elements that are specific to individual response codes.
 *
 * Note: transport, device, remote, and configuration state is handled by
 * applyStateToUI() which is triggered by the companion "state" message that
 * the backend emits alongside every "response" message that modifies state.
 */
function handleParsedResponse(code, text, kv) {
  switch (code) {
    // ── 200 ok ─────────────────────────────────────────────────────────
    case 200:
      showToast("OK", "ok");
      break;

    // ── 201 help ───────────────────────────────────────────────────────
    case 201:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 202 / 502  slot info ───────────────────────────────────────────
    case 202:
    case 502:
      displayResultBox("slotInfoResult", kv);
      break;

    // ── 204  device info ───────────────────────────────────────────────
    case 204:
      break; // state update handled via "state" message

    // ── 205 / 519  clips info ──────────────────────────────────────────
    case 205:
    case 519:
      renderClipsTable(kv);
      break;

    // ── 206 / 520  disk list ───────────────────────────────────────────
    case 206:
    case 520:
      displayResultBox("diskListResult", kv);
      break;

    // ── 208 / 508  transport info ──────────────────────────────────────
    case 208:
    case 508:
      break; // state update handled via "state" message

    // ── 209  notify ────────────────────────────────────────────────────
    case 209:
      applyNotifyStateToUI(kv);
      break;

    // ── 210 / 510  remote info ─────────────────────────────────────────
    case 210:
    case 510:
      break; // state update handled via "state" message

    // ── 211 / 511  configuration ───────────────────────────────────────
    case 211:
    case 511:
      applyConfigurationToFormFields(kv);
      break;

    // ── 212  commands (XML) ────────────────────────────────────────────
    case 212:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 213  deck rebooting ────────────────────────────────────────────
    case 213:
      showToast("Deck is rebooting…", "warn");
      consoleLog("⚠ Deck rebooting (file format change)", "cl--async");
      break;

    // ── 214  clips count ───────────────────────────────────────────────
    case 214: {
      const count = kv["clips count"] || kv["count"] || "?";
      showToast(`Clips count: ${count}`, "ok");
      updateClipCountBadge(count);
      break;
    }

    // ── 225  nas host info ─────────────────────────────────────────────
    case 225:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 226  external drive info ───────────────────────────────────────
    case 226:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 500  connection info (initial banner) ──────────────────────────
    case 500:
      showToast(`Connected to ${kv["model"] || "HyperDeck"}`, "ok");
      break;

    // ── Capture format token from format: prepare response ─────────────
    default:
      // Some firmware versions return a custom code for the format token.
      // The token is a key like "token: <value>" in the kv pairs.
      if (kv.token) {
        pendingFormatToken = kv.token;
        document.getElementById("fmtToken").value = pendingFormatToken;
        document.getElementById("btnFormatConfirm").disabled = false;
        showToast(`Format token received: ${pendingFormatToken}`, "warn");
      }
      break;
  }

  // Display error responses with descriptive messages
  if (code >= 100 && code <= 199) {
    const description = ERROR_CODE_DESCRIPTIONS[code] || "Error";
    showToast(`${code} ${description}`, "error");
  }
}

// ============================================================
// SECTION: Error code descriptions
// ============================================================

/**
 * Human-readable descriptions for every protocol error code (1xx range).
 * Source: §"Error codes" in the HyperDeck Ethernet Protocol spec.
 */
const ERROR_CODE_DESCRIPTIONS = {
  100: "syntax error",
  101: "unsupported parameter",
  102: "invalid value",
  103: "unsupported",
  104: "disk full",
  105: "no disk",
  106: "disk error",
  107: "timeline empty",
  108: "internal error",
  109: "out of range",
  110: "no input",
  111: "remote control disabled",
  112: "clip not found",
  120: "connection failed",
  121: "authentication failed",
  122: "authentication required",
  150: "invalid state",
  151: "invalid codec",
  160: "invalid format",
  161: "invalid token",
  162: "format not prepared",
  163: "parameterized single line command not supported",
};

// ============================================================
// SECTION: State → UI binding
// ============================================================

/**
 * Apply the full device state snapshot to every relevant UI element.
 * Called whenever a { type: "state" } message arrives.
 */
function applyStateToUI(state) {
  // ── Transport status ──────────────────────────────────────────────────
  const status = state.transport_status || "";
  setStatusBadge("tsStatus",   status);
  setStatusBadge("dashStatus", status);

  setText("tsTimecode",   state.transport_timecode        || "—");
  setText("tsSpeed",      formatSpeed(state.transport_speed));
  setText("tsClipId",     state.transport_clip_id         || "—");
  setText("tsSlot",       formatSlot(state));
  setText("tsFormat",     state.transport_video_format    || "—");
  setText("tsLoop",       boolYesNo(state.transport_loop));
  setText("tsTimeline",   state.transport_timeline        || "—");
  setText("tsDynRange",   state.transport_dynamic_range   || "—");
  setText("tsRefLocked",  boolYesNo(state.transport_reference_locked));

  // Dashboard transport
  setText("dashSpeed",      formatSpeed(state.transport_speed));
  setText("dashClipId",     state.transport_clip_id         || "—");
  setText("dashSlotId",     state.transport_slot_id         || "—");
  setText("dashSlotName",   state.transport_slot_name       || "—");
  setText("dashDevName",    state.transport_device_name     || "—");
  setText("dashVidFmt",     state.transport_video_format    || "—");
  setText("dashLoop",       boolYesNo(state.transport_loop));
  setText("dashSingleClip", boolYesNo(state.transport_single_clip));
  setText("dashTimeline",   state.transport_timeline        || "—");
  setText("dashDynRange",   state.transport_dynamic_range   || "—");
  setText("dashRefLocked",  boolYesNo(state.transport_reference_locked));
  setText("dashInputFmt",   state.transport_input_video_format || "—");

  // Timecode displays (use display timecode when available, fall back to transport)
  const displayTC = state.transport_display_timecode || state.transport_timecode || "--:--:--:--";
  setText("sidebarTimecode", displayTC);
  setText("dashTimecode",    displayTC);
  setText("dashTlTimecode",  state.transport_timecode || "—");

  // ── Device info ───────────────────────────────────────────────────────
  setText("devModel",   state.model            || "—");
  setText("devSwVer",   state.software_version || "—");
  setText("devProto",   state.protocol_version || "—");
  setText("devSlots",   state.slot_count != null ? String(state.slot_count) : "—");
  setText("devId",      state.unique_id        || "—");

  setText("dashModel",    state.model            || "—");
  setText("dashSwVer",    state.software_version || "—");
  setText("dashProto",    state.protocol_version || "—");
  setText("dashSlotCount",state.slot_count != null ? String(state.slot_count) : "—");
  setText("dashUniqueId", state.unique_id        || "—");

  // ── Remote info ───────────────────────────────────────────────────────
  setText("remEnabled",  boolYesNo(state.remote_enabled));
  setText("remOverride", boolYesNo(state.remote_override));
  setText("dashRemEnabled",  boolEnabledDisabled(state.remote_enabled));
  setText("dashRemOverride", boolYesNo(state.remote_override));

  // ── Configuration summary (dashboard) ─────────────────────────────────
  setText("dashCfgVidIn",    state.cfg_video_input          || "—");
  setText("dashCfgAudIn",    state.cfg_audio_input          || "—");
  setText("dashCfgFileFmt",  state.cfg_file_format          || "—");
  setText("dashCfgAudCodec", state.cfg_audio_codec          || "—");
  setText("dashCfgTcIn",     state.cfg_timecode_input       || "—");
  setText("dashCfgTcOut",    state.cfg_timecode_output      || "—");
  setText("dashCfgRecTrig",  state.cfg_record_trigger       || "—");
  setText("dashCfgRecPrefix",state.cfg_record_prefix        || "—");
  setText("dashCfgRefSrc",   state.cfg_reference_source     || "—");
  setText("dashCfgUsbSpill", boolYesNo(state.cfg_usb_spill));
}

/**
 * Set the visual class (colour) of a status badge element based on transport status.
 * The class name matches the CSS .status-badge.{status} rules in style.css.
 */
function setStatusBadge(elementId, status) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = status || "—";
  // Strip all previous status classes then apply the new one
  el.className = "status-badge";
  if (status) el.classList.add(status.toLowerCase());
}

/**
 * Apply a 211 configuration response kv block to the Configuration tab form fields.
 * Also mirrors values into the dashboard configuration summary.
 */
function applyConfigurationToFormFields(kv) {
  setSelectIfKnown("cfgVideoInput",      kv["video input"]);
  setSelectIfKnown("cfgAudioInput",      kv["audio input"]);
  setSelectIfKnown("cfgAudioCodec",      kv["audio codec"]);
  setSelectIfKnown("cfgFileFormat",      kv["file format"]);
  setSelectIfKnown("cfgTcInput",         kv["timecode input"]);
  setSelectIfKnown("cfgTcOutput",        kv["timecode output"]);
  setSelectIfKnown("cfgTcPreference",    kv["timecode preference"]);
  setSelectIfKnown("cfgRecordTrigger",   kv["record trigger"]);
  setSelectIfKnown("cfgRefSource",       kv["reference source"]);

  setValue("cfgTcPreset",       kv["timecode preset"]      || "");
  setValue("cfgRecordPrefix",   kv["record prefix"]        || "");
  setValue("cfgAudioChannels",  kv["audio input channels"] || "");
  setValue("cfgDefaultStandard",kv["default standard"]     || "");
  setValue("cfgXlrMapping",     kv["xlr mapping"]          || "");
  setValue("cfgRcaMapping",     kv["rca mapping"]          || "");

  setCheckbox("cfgRecordCache",     kv["record cache"]         === "true");
  setCheckbox("cfgAppendTimestamp", kv["append timestamp"]     === "true");
  setCheckbox("cfgUsbSpill",        kv["usb spill"]            === "true");
  setCheckbox("cfgGenlockResync",   kv["genlock input resync"] === "true");

  // Also mirror remote fields (from 210 response if bundled)
  if (kv["enabled"]  !== undefined) setCheckbox("cfgRemoteEnabled",  kv["enabled"]  === "true");
  if (kv["override"] !== undefined) setCheckbox("cfgRemoteOverride", kv["override"] === "true");
}

/**
 * Apply a 209 notify response to the Notifications tab toggles.
 */
function applyNotifyStateToUI(kv) {
  const mapping = {
    transport:        "notTransport",
    slot:             "notSlot",
    remote:           "notRemote",
    configuration:    "notConfiguration",
    "dropped frames": "notDroppedFrames",
    "display timecode":"notDisplayTimecode",
    "timeline position":"notTimelinePosition",
    playrange:        "notPlayrange",
    cache:            "notCache",
    "dynamic range":  "notDynamicRange",
    slate:            "notSlate",
    clips:            "notClips",
    disk:             "notDisk",
    "device info":    "notDeviceInfo",
    nas:              "notNas",
  };
  for (const [key, elId] of Object.entries(mapping)) {
    if (kv[key] !== undefined) {
      setCheckbox(elId, kv[key] === "true");
    }
  }
}

// ============================================================
// SECTION: Connection UI
// ============================================================

/** Called on the Connect button click. */
function uiConnect() {
  const host = document.getElementById("inputHost").value.trim();
  const port = parseInt(document.getElementById("inputPort").value, 10) || 9993;
  if (!host) { showToast("Enter a host IP address", "error"); return; }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    openWebSocket();
  }

  // Small delay to let the WebSocket open before sending the connect action
  setTimeout(() => {
    sendToBackend({ action: "connect", host, port });
  }, 150);
}

/** Called on the Disconnect button click. */
function uiDisconnect() {
  sendToBackend({ action: "disconnect" });
}

/**
 * Update connection state widgets: dot colour, status text, button states.
 */
function updateConnectionUI(isConnected, host = "", port = "") {
  const dot        = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const btnConn    = document.getElementById("btnConnect");
  const btnDisc    = document.getElementById("btnDisconnect");

  if (isConnected) {
    dot.className = "dot dot--on";
    statusText.textContent = `${host}:${port}`;
    btnConn.disabled = true;
    btnDisc.disabled = false;
  } else {
    dot.className = "dot dot--off";
    statusText.textContent = "Disconnected";
    btnConn.disabled = false;
    btnDisc.disabled = true;
    // Reset live displays
    setText("sidebarTimecode", "--:--:--:--");
    setText("dashTimecode",    "--:--:--:--");
  }
}

// ============================================================
// SECTION: Command sender
// ============================================================

/**
 * Send a HyperDeck command string to the backend.
 * This is the single entry point for all command dispatch.
 */
function sendCmd(command) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Not connected to the server", "error");
    return;
  }
  sendToBackend({ action: "command", command });
}

// ============================================================
// SECTION: Transport commands
// ============================================================

/**
 * Build and send the "play" command from form fields on the Transport tab.
 * Any combination of: speed, loop, single clip, clip id, timecode offset.
 * The spec allows all parameters inline on a single line, e.g.:
 *   play: speed: 200 loop: true clip id: 3
 */
function applyPlay() {
  const opts = {};
  const speedVal = document.getElementById("playSpeed").value.trim();
  if (speedVal && speedVal !== "100") opts.speed = speedVal;
  if (document.getElementById("playLoop").checked) opts.loop = "true";
  if (document.getElementById("playSingleClip").checked) opts["single clip"] = "true";
  const clipId = document.getElementById("playClipId").value.trim();
  const tcOff  = document.getElementById("playTimecodeOffset").value.trim();
  if (clipId) opts["clip id"] = clipId;
  if (tcOff && clipId) opts.timecode = tcOff;
  sendCmd(buildInlineCommand("play", opts));
}

/** Quick play shortcut (no extra params) used by dashboard/sidebar buttons. */
function quickPlay() { sendCmd("play"); }

/** Quick record shortcut used by dashboard/sidebar buttons. */
function quickRecord() { sendCmd("record"); }

/** Build and send the "jog" command. */
function applyJog() {
  const tc = document.getElementById("jogTimecode").value.trim();
  if (!tc) { showToast("Enter a timecode", "error"); return; }
  sendCmd(`jog: timecode: ${tc}`);
}

/** Build and send the "shuttle" command. */
function applyShuttle() {
  const speed = document.getElementById("shuttleSpeed").value.trim();
  sendCmd(`shuttle: speed: ${speed}`);
}

/** Apply a shuttle speed preset (from the quick-access buttons). */
function applyShuttlePreset(speedValue) {
  document.getElementById("shuttleSpeed").value = speedValue;
  sendCmd(`shuttle: speed: ${speedValue}`);
}

/**
 * Build and send a "goto" command.
 * The spec requires exactly one param/value pair per goto command.
 */
function applyGoto() {
  const param = document.getElementById("gotoParam").value;
  const value = document.getElementById("gotoValue").value.trim();
  if (!value) { showToast("Enter a goto value", "error"); return; }
  sendCmd(`goto: ${param}: ${value}`);
}

/** Update the hint text below the goto form based on selected parameter. */
function updateGotoHint() {
  const hints = {
    "clip id":  "Clip ID: absolute ID, +n or -n for relative, or 'start'/'end'.",
    "clip":     "Clip position (frame offset within clip). Relative ±n supported.",
    "timeline": "Timeline frame offset. Relative ±n supported, or 'start'/'end'.",
    "timecode": "Absolute or relative (±) timecode: HH:MM:SS:FF.",
    "slot id":  "Slot ID number to jump to.",
  };
  const param = document.getElementById("gotoParam").value;
  setText("gotoHint", hints[param] || "");
}

/**
 * Build and send a "playrange set" command.
 * Determines which variant to use based on which fields are populated.
 * Variants (mutually exclusive per spec):
 *   clip id [count]       – range by clip ID
 *   in: <tc> out: <tc>    – range by timecode in/out
 *   timeline in: timeline out: – range by frame number
 */
function applyPlayrangeSet() {
  const clipId = document.getElementById("prClipId").value.trim();
  const count  = document.getElementById("prCount").value.trim();
  const inTc   = document.getElementById("prIn").value.trim();
  const outTc  = document.getElementById("prOut").value.trim();
  const tlIn   = document.getElementById("prTlIn").value.trim();
  const tlOut  = document.getElementById("prTlOut").value.trim();

  if (clipId) {
    const countPart = count ? ` count: ${count}` : "";
    sendCmd(`playrange set: clip id: ${clipId}${countPart}`);
  } else if (inTc && outTc) {
    sendCmd(`playrange set: in: ${inTc} out: ${outTc}`);
  } else if (tlIn && tlOut) {
    sendCmd(`playrange set: timeline in: ${tlIn} timeline out: ${tlOut}`);
  } else {
    showToast("Fill in either Clip ID, In/Out TC, or Timeline In/Out", "error");
  }
}

/** Build and send the "play on startup" settings. */
function applyPlayOnStartup() {
  const enable     = document.getElementById("posEnable").checked;
  const singleClip = document.getElementById("posSingleClip").checked;
  sendCmd(`play on startup: enable: ${enable} single clip: ${singleClip}`);
}

/** Build and send the "play option" stop mode. */
function applyPlayOption() {
  const mode = document.getElementById("stopMode").value;
  sendCmd(`play option: stop mode: ${mode}`);
}

/** Build and send the "preview" command. */
function applyPreview() {
  const enable = document.getElementById("previewEnable").checked;
  sendCmd(`preview: enable: ${enable}`);
}

// ============================================================
// SECTION: Clip commands
// ============================================================

/** Build and send a "clips get" command with optional version, clip id, count. */
function applyClipsGet() {
  const opts = {};
  const version = document.getElementById("clipsGetVersion").value;
  const clipId  = document.getElementById("clipsGetClipId").value.trim();
  const count   = document.getElementById("clipsGetCount").value.trim();
  if (version) opts.version = version;
  if (clipId)  opts["clip id"] = clipId;
  if (count)   opts.count = count;
  sendCmd(buildInlineCommand("clips get", opts));
}

/** Build and send a "clip info" command. */
function applyClipInfo() {
  const clipId = document.getElementById("clipInfoId").value.trim();
  const name   = document.getElementById("clipInfoName").value.trim();
  if (clipId) {
    sendCmd(`clip info: clip id: ${clipId}`);
  } else if (name) {
    sendCmd(`clip info: name: ${name}`);
  } else {
    sendCmd("clip info"); // current clip
  }
}

/**
 * Build and send a "clips add" command.
 * Trim points are optional; if both timecode and frame numbers are provided,
 * timecode takes precedence (per user expectation).
 */
function applyClipAdd() {
  const name      = document.getElementById("clipAddName").value.trim();
  const beforeId  = document.getElementById("clipAddBeforeId").value.trim();
  const inTc      = document.getElementById("clipAddInTc").value.trim();
  const outTc     = document.getElementById("clipAddOutTc").value.trim();
  const frameIn   = document.getElementById("clipAddFrameIn").value.trim();
  const frameOut  = document.getElementById("clipAddFrameOut").value.trim();

  if (!name) { showToast("Clip name is required", "error"); return; }

  const opts = { name };
  if (beforeId)        opts["clip id"] = beforeId;
  if (inTc && outTc)   { opts.in = inTc; opts.out = outTc; }
  else if (frameIn && frameOut) { opts["frame in"] = frameIn; opts["frame out"] = frameOut; }

  sendCmd(buildInlineCommand("clips add", opts));
}

/** Build and send a "clips remove" command. */
function applyClipRemove() {
  const clipId = document.getElementById("clipRemoveId").value.trim();
  if (!clipId) { showToast("Enter a Clip ID to remove", "error"); return; }
  sendCmd(`clips remove: clip id: ${clipId}`);
}

/** Ask for confirmation then send "clips clear". */
function confirmClipsClear() {
  if (confirm("Clear the entire timeline? This cannot be undone.")) {
    sendCmd("clips clear");
  }
}

/** Build and send a "record" command with optional clip name. */
function applyRecord() {
  const name = document.getElementById("recordName").value.trim();
  sendCmd(name ? `record: name: ${name}` : "record");
}

/** Build and send a "record spill" command with optional slot id. */
function applyRecordSpill() {
  const slotId = document.getElementById("spillSlotId").value.trim();
  sendCmd(slotId ? `record: spill: slot id: ${slotId}` : "record spill");
}

/**
 * Render the clips table from a 205 / 519 clips info response.
 * kv keys are clip IDs (integers); values are space-separated fields.
 *
 * Protocol version 1 (default): "id: {name} {startTC} {duration}"
 * Protocol version 2: "id: {name} {clipStartTC} {duration} {inTC} {outTC} {path}"
 *
 * The spec returns indexed entries like:
 *   205 clips info:\n
 *   clip count: 4\n
 *   0: name start_tc duration\n
 *   1: name start_tc duration\n
 */
function renderClipsTable(kv) {
  const tbody = document.getElementById("clipsTableBody");
  if (!tbody) return;

  // Filter only numeric clip entries (clip index keys are integers as strings)
  const clipEntries = Object.entries(kv)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10));

  const count = kv["clip count"] || clipEntries.length;
  updateClipCountBadge(count);

  if (clipEntries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:10px">
      Timeline is empty (107).</td></tr>`;
    return;
  }

  const activeClipId = deviceState.transport_clip_id
    ? parseInt(deviceState.transport_clip_id, 10)
    : -1;

  tbody.innerHTML = clipEntries.map(([idx, data]) => {
    // Fields are space-separated; clip name may contain spaces so we split carefully
    const fields = data.trim().split(/\s+/);
    // idx is 0-based in the response, clip id is 1-based for commands
    const clipId = parseInt(idx, 10) + 1;
    const name       = fields[0] || "—";
    const startTc    = fields[1] || "—";
    const duration   = fields[2] || "—";
    const inTc       = fields[3] || "";
    const outTc      = fields[4] || "";

    const isActive = (clipId === activeClipId);
    const rowClass = isActive ? "clip--active" : "";

    return `<tr class="${rowClass}">
      <td>${clipId}</td>
      <td class="clip-name" title="${escHtml(name)}">${escHtml(name)}</td>
      <td>${escHtml(startTc)}</td>
      <td>${escHtml(duration)}</td>
      <td>${escHtml(inTc)}</td>
      <td>${escHtml(outTc)}</td>
      <td class="clip-actions">
        <button class="btn btn--xs" onclick="gotoClip(${clipId})" title="Go to clip">Go</button>
        <button class="btn btn--xs btn--danger" onclick="removeClip(${clipId})" title="Remove from timeline">✕</button>
      </td>
    </tr>`;
  }).join("");
}

/** Update the clip count badge in the Clips tab header. */
function updateClipCountBadge(count) {
  const badge = document.getElementById("clipCountBadge");
  if (!badge) return;
  if (count !== undefined && count !== null) {
    badge.textContent = count;
    badge.style.display = "inline-block";
  }
}

/** Shortcut used by clip table "Go" buttons. */
function gotoClip(clipId) { sendCmd(`goto: clip id: ${clipId}`); }

/** Shortcut used by clip table "✕" buttons. */
function removeClip(clipId) { sendCmd(`clips remove: clip id: ${clipId}`); }

// ============================================================
// SECTION: Slot / Disk commands
// ============================================================

/** Build and send a "slot info" query. */
function applySlotInfo() {
  const slotId = document.getElementById("slotInfoId").value.trim();
  const device = document.getElementById("slotInfoDevice").value.trim();
  if (slotId)  sendCmd(`slot info: slot id: ${slotId}`);
  else if (device) sendCmd(`slot info: device: ${device}`);
  else sendCmd("slot info");
}

/**
 * Build and send a "slot select" command.
 * Parameters may be combined (slot id + video format, or device + video format).
 */
function applySlotSelect() {
  const slotId    = document.getElementById("slotSelectId").value.trim();
  const device    = document.getElementById("slotSelectDevice").value.trim();
  const vidFormat = document.getElementById("slotSelectVidFmt").value.trim();

  const opts = {};
  if (slotId)    opts["slot id"]      = slotId;
  if (device)    opts.device          = device;
  if (vidFormat) opts["video format"] = vidFormat;

  if (!slotId && !device) {
    showToast("Enter a slot ID or device name", "error"); return;
  }
  sendCmd(buildInlineCommand("slot select", opts));
}

/** Build and send a "slot unblock" command. */
function applySlotUnblock() {
  const slotId = document.getElementById("slotUnblockId").value.trim();
  const device = document.getElementById("slotUnblockDevice").value.trim();
  if (slotId)  sendCmd(`slot unblock: slot id: ${slotId}`);
  else if (device) sendCmd(`slot unblock: device: ${device}`);
  else sendCmd("slot unblock");
}

/** Build and send a "disk list" query. */
function applyDiskList() {
  const slotId = document.getElementById("diskListSlotId").value.trim();
  const device = document.getElementById("diskListDevice").value.trim();
  if (slotId)  sendCmd(`disk list: slot id: ${slotId}`);
  else if (device) sendCmd(`disk list: device: ${device}`);
  else sendCmd("disk list");
}

/** Send an "external drive select" command. */
function applyExtDriveSelect() {
  const dev = document.getElementById("extDriveDevice").value.trim();
  if (!dev) { showToast("Enter a device name", "error"); return; }
  sendCmd(`external drive select: device: ${dev}`);
}

/**
 * Send the first step of the two-step format flow: "format: prepare".
 * The device responds with a token that must be echoed back to confirm.
 */
function applyFormatPrepare() {
  const slotId    = document.getElementById("fmtSlotId").value.trim();
  const device    = document.getElementById("fmtDevice").value.trim();
  const fs        = document.getElementById("fmtFilesystem").value;
  const volName   = document.getElementById("fmtVolumeName").value.trim();

  const opts = { prepare: fs };
  if (slotId)  opts["slot id"] = slotId;
  if (device)  opts.device     = device;
  if (volName) opts.name       = volName;

  // Reset previous token
  pendingFormatToken = "";
  document.getElementById("fmtToken").value = "";
  document.getElementById("btnFormatConfirm").disabled = true;

  sendCmd(buildInlineCommand("format", opts));
}

/** Send the second step of the format flow: "format: confirm: <token>". */
function applyFormatConfirm() {
  const token = document.getElementById("fmtToken").value.trim() || pendingFormatToken;
  if (!token) { showToast("No token available — run Prepare Format first", "error"); return; }
  if (!confirm("⚠ This will permanently erase the disk. Proceed?")) return;
  sendCmd(`format: confirm: ${token}`);
  document.getElementById("btnFormatConfirm").disabled = true;
}

// ============================================================
// SECTION: Configuration commands
// ============================================================

/**
 * Build and send a "configuration" command from the Configuration tab form.
 * Only fields that have been changed from "— unchanged —" are included.
 */
function applyConfiguration() {
  const opts = {};

  const fields = {
    "video input":          "cfgVideoInput",
    "audio input":          "cfgAudioInput",
    "audio codec":          "cfgAudioCodec",
    "file format":          "cfgFileFormat",
    "timecode input":       "cfgTcInput",
    "timecode output":      "cfgTcOutput",
    "timecode preference":  "cfgTcPreference",
    "record trigger":       "cfgRecordTrigger",
    "reference source":     "cfgRefSource",
    "xlr type":             "cfgXlrType",
  };

  for (const [cmdKey, elId] of Object.entries(fields)) {
    const val = getValue(elId);
    if (val) opts[cmdKey] = val;
  }

  const textFields = {
    "timecode preset":      "cfgTcPreset",
    "record prefix":        "cfgRecordPrefix",
    "audio input channels": "cfgAudioChannels",
    "default standard":     "cfgDefaultStandard",
    "xlr mapping":          "cfgXlrMapping",
    "rca mapping":          "cfgRcaMapping",
  };
  for (const [cmdKey, elId] of Object.entries(textFields)) {
    const val = getValue(elId);
    if (val) opts[cmdKey] = val;
  }

  // Boolean toggles — only include if checked (avoids sending unintended false)
  // For booleans we always send the current state so the user sees the effect
  opts["record cache"]         = getChecked("cfgRecordCache")     ? "true" : "false";
  opts["append timestamp"]     = getChecked("cfgAppendTimestamp") ? "true" : "false";
  opts["usb spill"]            = getChecked("cfgUsbSpill")        ? "true" : "false";
  opts["genlock input resync"] = getChecked("cfgGenlockResync")   ? "true" : "false";

  if (Object.keys(opts).length === 0) {
    showToast("No configuration changes to apply", "warn"); return;
  }

  // XLR input combination (xlr input id + xlr type must appear together)
  const xlrId   = getValue("cfgXlrInputId");
  const xlrType = getValue("cfgXlrType");
  if (xlrId && xlrType) {
    opts["xlr input id"] = xlrId;
    opts["xlr type"]     = xlrType;
  }

  sendCmd(buildInlineCommand("configuration", opts));
}

/** Build and send a "remote" command from the Configuration tab. */
function applyRemote() {
  const enabled  = getChecked("cfgRemoteEnabled");
  const override = getChecked("cfgRemoteOverride");
  sendCmd(`remote: enable: ${enabled} override: ${override}`);
}

/** Send a "connection protocol: response version" command. */
function applyConnectionProtocol() {
  const version = getValue("connProtoVersion");
  sendCmd(`connection protocol: response version: ${version}`);
}

/**
 * Build and send the multiline "authenticate" command.
 * The spec marks this as multiline-only (parameter block, not inline).
 */
function applyAuthenticate() {
  const username = getValue("authUsername");
  const password = getValue("authPassword");
  if (!username) { showToast("Enter a username", "error"); return; }
  const lines = [
    "authenticate:",
    ` username: ${username}`,
    ` password: ${password}`,
  ];
  sendCmd(lines.join("\n"));
}

// ============================================================
// SECTION: Notification commands
// ============================================================

/**
 * Build and send a "notify" command reflecting all toggle states.
 * Each toggle maps to a "notify: <key>: true|false" parameter.
 */
function applyNotifications() {
  const mapping = {
    "transport":        "notTransport",
    "slot":             "notSlot",
    "remote":           "notRemote",
    "configuration":    "notConfiguration",
    "dropped frames":   "notDroppedFrames",
    "display timecode": "notDisplayTimecode",
    "timeline position":"notTimelinePosition",
    "playrange":        "notPlayrange",
    "cache":            "notCache",
    "dynamic range":    "notDynamicRange",
    "slate":            "notSlate",
    "clips":            "notClips",
    "disk":             "notDisk",
    "device info":      "notDeviceInfo",
    "nas":              "notNas",
  };

  const opts = {};
  for (const [cmdKey, elId] of Object.entries(mapping)) {
    opts[cmdKey] = getChecked(elId) ? "true" : "false";
  }
  sendCmd(buildInlineCommand("notify", opts));
}

// ============================================================
// SECTION: Dynamic Range commands
// ============================================================

/** Build and send a "dynamic range" command with optional overrides. */
function applyDynamicRange() {
  const playback = getValue("drPlaybackOverride");
  const record   = getValue("drRecordOverride");
  const opts = {};
  if (playback) opts["playback override"] = playback;
  if (record)   opts["record override"]   = record;
  if (!playback && !record) { sendCmd("dynamic range"); return; }
  sendCmd(buildInlineCommand("dynamic range", opts));
}

// ============================================================
// SECTION: Slate commands  (all multiline-only per spec)
// ============================================================

/**
 * Build and send the multiline "slate clips" command.
 * Only non-empty fields are included.
 */
function applySlateClips() {
  const fieldMap = {
    "reel":           "slateReel",
    "scene id":       "slateSceneId",
    "shot type":      "slateShotType",
    "take":           "slateTake",
    "take scenario":  "slateTakeScenario",
    "take auto inc":  "slateTakeAutoInc",
    "good take":      "slateGoodTake",
    "environment":    "slateEnvironment",
    "day night":      "slateDayNight",
  };
  const lines = buildMultilineLines("slate clips", fieldMap);
  if (lines.length <= 1) { showToast("Fill in at least one slate field", "error"); return; }
  sendCmd(lines.join("\n"));
}

/** Build and send the multiline "slate project" command. */
function applySlateProject() {
  const fieldMap = {
    "project name":    "slateProjName",
    "camera":          "slateCamera",
    "director":        "slateDirector",
    "camera operator": "slateCamOp",
  };
  const lines = buildMultilineLines("slate project", fieldMap);
  if (lines.length <= 1) { showToast("Fill in at least one project field", "error"); return; }
  sendCmd(lines.join("\n"));
}

/** Build and send the multiline "slate lens" command. */
function applySlateLens() {
  const fieldMap = {
    "lens type":     "slateLensType",
    "iris":          "slateIris",
    "focal length":  "slateFocalLength",
    "distance":      "slateDistance",
    "filter":        "slateFilter",
  };
  const lines = buildMultilineLines("slate lens", fieldMap);
  if (lines.length <= 1) { showToast("Fill in at least one lens field", "error"); return; }
  sendCmd(lines.join("\n"));
}

// ============================================================
// SECTION: NAS commands  (multiline-only per spec)
// ============================================================

/** Build and send the multiline "nas add" command. */
function applyNasAdd() {
  const url      = getValue("nasAddUrl");
  const username = getValue("nasAddUsername");
  const password = getValue("nasAddPassword");
  if (!url) { showToast("Enter a NAS URL", "error"); return; }

  const lines = ["nas add:", ` url: ${url}`];
  if (username) lines.push(` username: ${username}`);
  if (password) lines.push(` password: ${password}`);
  sendCmd(lines.join("\n"));
}

/** Build and send the multiline "nas remove" command. */
function applyNasRemove() {
  const url = getValue("nasRemoveUrl");
  if (!url) { showToast("Enter the NAS URL to remove", "error"); return; }
  sendCmd(`nas remove:\n url: ${url}`);
}

/** Build and send the multiline "nas select" command. */
function applyNasSelect() {
  const url = getValue("nasSelectUrl");
  if (!url) { showToast("Enter the NAS URL to mount", "error"); return; }
  sendCmd(`nas select:\n url: ${url}`);
}

// ============================================================
// SECTION: Advanced commands
// ============================================================

/** Build and send the "identify" command. */
function applyIdentify() {
  const enable = getChecked("identifyEnable");
  sendCmd(`identify: enable: ${enable}`);
}

/** Build and send the "watchdog" command. */
function applyWatchdog() {
  const period = document.getElementById("watchdogPeriod").value;
  sendCmd(`watchdog: period: ${period}`);
}

/** Ask for confirmation then send "reboot". */
function confirmReboot() {
  if (confirm("Reboot the HyperDeck? The connection will be closed.")) {
    sendCmd("reboot");
  }
}

/** Send a raw command from the Advanced tab input. */
function sendRawCommand() {
  const el  = document.getElementById("rawCmd");
  const cmd = el.value.trim().replace(/\\n/g, "\n");
  if (!cmd) return;
  sendCmd(cmd);
  el.value = "";
}

// ============================================================
// SECTION: Console
// ============================================================

/** Send a command typed in the console input. */
function sendConsoleCommand() {
  const el  = document.getElementById("consoleInput");
  const cmd = el.value.trim().replace(/\\n/g, "\n");
  if (!cmd) return;
  commandHistory.unshift(cmd);
  historyIndex = -1;
  sendCmd(cmd);
  el.value = "";
}

/** Clear the console output panel. */
function clearConsole() {
  const out = document.getElementById("consoleOutput");
  if (out) out.innerHTML = "";
}

/**
 * Append a styled line to the console output.
 * @param {string} text     – line content
 * @param {string} cssClass – one of the .cl--* classes from style.css
 */
function consoleLog(text, cssClass = "cl") {
  const out = document.getElementById("consoleOutput");
  if (!out) return;

  const line = document.createElement("div");
  line.className = cssClass;
  // Show blank lines as a visible placeholder to preserve block separation
  line.textContent = text === "" ? "​" : text;  // zero-width space for truly empty
  out.appendChild(line);

  // Keep the console from growing unbounded
  while (out.childElementCount > 2000) {
    out.removeChild(out.firstChild);
  }

  // Auto-scroll to the latest line
  if (document.getElementById("consoleAutoScroll")?.checked !== false) {
    out.scrollTop = out.scrollHeight;
  }
}

/** Console ↑/↓ history navigation. */
document.addEventListener("keydown", (e) => {
  const input = document.getElementById("consoleInput");
  if (document.activeElement !== input) return;
  if (e.key === "ArrowUp") {
    historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    input.value = commandHistory[historyIndex] || "";
    e.preventDefault();
  } else if (e.key === "ArrowDown") {
    historyIndex = Math.max(historyIndex - 1, -1);
    input.value = historyIndex >= 0 ? commandHistory[historyIndex] : "";
    e.preventDefault();
  } else if (e.key === "Enter") {
    sendConsoleCommand();
  }
});

// ============================================================
// SECTION: Watchdog keep-alive
// ============================================================

/** Start sending periodic pings to keep the TCP connection alive. */
function startWatchdog() {
  stopWatchdog();
  watchdogIntervalId = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      sendCmd("ping");
    }
  }, WATCHDOG_INTERVAL_MS);
}

/** Stop the periodic ping timer. */
function stopWatchdog() {
  if (watchdogIntervalId !== null) {
    clearInterval(watchdogIntervalId);
    watchdogIntervalId = null;
  }
}

// ============================================================
// SECTION: Tabs
// ============================================================

/**
 * Activate a tab by name, deactivating all others.
 * Attaches click handlers to all .tab buttons at init time.
 */
function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
}

// ============================================================
// SECTION: Toast notifications
// ============================================================

let _toastTimeout = null;

/**
 * Display a transient toast notification.
 * @param {string} message  – message to show
 * @param {"ok"|"error"|"warn"} kind  – visual variant
 */
function showToast(message, kind = "ok") {
  const toast = document.getElementById("toast");
  if (!toast) return;

  toast.textContent = message;
  toast.className = `toast toast--${kind}`;
  toast.hidden = false;

  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => { toast.hidden = true; }, 3500);
}

// ============================================================
// SECTION: Utility helpers
// ============================================================

/**
 * Build a single-line inline HyperDeck command from a base verb and
 * an ordered set of key/value parameters.
 *
 * Example:
 *   buildInlineCommand("play", { speed: "200", loop: "true" })
 *   → "play: speed: 200 loop: true"
 */
function buildInlineCommand(verb, params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" ");
  return parts ? `${verb}: ${parts}` : verb;
}

/**
 * Build the lines array for a multiline protocol command block.
 * Returns ["command name:", " key: value", " key: value", ...]
 * Only includes fields with non-empty values.
 *
 * @param {string} commandName – first line of the multiline block (e.g. "slate clips")
 * @param {Object} fieldMap    – { "protocol key": "elementId", … }
 */
function buildMultilineLines(commandName, fieldMap) {
  const lines = [`${commandName}:`];
  for (const [cmdKey, elId] of Object.entries(fieldMap)) {
    const val = getValueRaw(elId);
    if (val !== "" && val !== null && val !== undefined) {
      lines.push(` ${cmdKey}: ${val}`);
    }
  }
  return lines;
}

/**
 * Display a key/value response block in a result-box element.
 * @param {string} elementId   – ID of the .result-box element
 * @param {Object} kv          – parsed key/value object from the protocol
 */
function displayResultBox(elementId, kv) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!kv || Object.keys(kv).length === 0) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = Object.entries(kv)
    .map(([k, v]) => `<span class="rk">${escHtml(k)}:</span> <span class="rv">${escHtml(v)}</span>`)
    .join("\n");
}

/** Escape HTML special characters to prevent XSS in dynamically generated markup. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Set the textContent of an element by ID. */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/** Get the .value of a form element. */
function getValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : "";
}

/**
 * Get the raw value of a form element without trimming.
 * Used in multiline builders where leading whitespace may be meaningful.
 */
function getValueRaw(id) {
  return getValue(id).trim();
}

/** Set the .value of a form element. */
function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

/** Get whether a checkbox is checked. */
function getChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

/** Programmatically check or uncheck a checkbox. */
function setCheckbox(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = checked;
}

/**
 * Set a <select> element's value if the option exists in the dropdown.
 * Falls back to the empty "— unchanged —" option if the value is not found.
 */
function setSelectIfKnown(id, value) {
  if (!value) return;
  const el = document.getElementById(id);
  if (!el) return;
  const opt = Array.from(el.options).find(
    (o) => o.value.toLowerCase() === value.toLowerCase()
  );
  if (opt) el.value = opt.value;
}

/** Format transport speed as a human-readable percentage string. */
function formatSpeed(speed) {
  if (speed === undefined || speed === null || speed === "") return "—";
  const n = parseInt(speed, 10);
  if (isNaN(n)) return String(speed);
  return `${n}%`;
}

/** Format slot id + slot name into a combined display string. */
function formatSlot(state) {
  const id   = state.transport_slot_id   || "";
  const name = state.transport_slot_name || state.transport_device_name || "";
  if (id && name) return `${id} (${name})`;
  return id || name || "—";
}

/** Return "Yes" / "No" for boolean state values. */
function boolYesNo(value) {
  if (value === true  || value === "true")  return "Yes";
  if (value === false || value === "false") return "No";
  return "—";
}

/** Return "Enabled" / "Disabled" for boolean state values. */
function boolEnabledDisabled(value) {
  if (value === true  || value === "true")  return "✓ Enabled";
  if (value === false || value === "false") return "✗ Disabled";
  return "—";
}

// ============================================================
// SECTION: Initialisation
// ============================================================

/** Wire up all tabs, attach Enter key to connection form, and auto-open WebSocket. */
function initUI() {
  // Tab navigation
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // Goto hint initialisation
  updateGotoHint();

  // Enter key in host field triggers connect
  document.getElementById("inputHost")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") uiConnect();
  });

  // Enter key in raw command field on Advanced tab
  document.getElementById("rawCmd")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendRawCommand();
  });

  // Open the WebSocket to the backend immediately on page load.
  // The actual HyperDeck TCP connection is initiated by the user via Connect.
  openWebSocket();

  consoleLog("HyperDeck Vibe ready. Enter the device IP address and click Connect.", "cl--connect");
}

// Bootstrap when DOM is ready
document.addEventListener("DOMContentLoaded", initUI);
