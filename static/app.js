/**
 * HyperDeck Vibe — Browser-side JavaScript
 *
 * Responsibilities:
 *  • Maintain the WebSocket connection to the backend (server.js)
 *  • Send HyperDeck commands via { action: "command", command: "…" } messages
 *  • Parse every incoming response and update the UI state model
 *  • Drive every UI widget described in index.html
 *
 * Protocol reference: Blackmagic HyperDeck Ethernet Protocol (December 2024)
 *
 * Response code summary (see backend for full table):
 *   200 ok | 201 help | 202 slot info | 204 device info | 205 clips info
 *   206 disk list | 208 transport info | 209 notify | 210 remote info
 *   211 configuration | 212 commands | 213 deck rebooting | 214 clips count
 *   215 uptime | 216 format ready | 218 play on startup | 219 playrange
 *   220 play option | 221 cache info | 222 dynamic range | 224 nas info
 *   225 nas host info | 226 external drive info | 227 spill order
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
// Why this queue exists:
// If a user clicks Connect while the WebSocket is still opening, we do not want
// to drop their action. We temporarily queue messages and flush them once OPEN.
//
// Beginner takeaway:
// Event-driven systems are asynchronous. A "not ready yet" state is normal and
// should be handled intentionally, not treated as an error by default.
const pendingBackendMessages = [];

/** Command history for the console's ↑/↓ navigation. */
const commandHistory = [];
let historyIndex = -1;

/** Accumulated partial token from the format command (two-step flow). */
let pendingFormatToken = "";

/** Watchdog interval handle (pings the device periodically). */
let watchdogIntervalId = null;
const WATCHDOG_INTERVAL_MS = 20_000;

/** Conditional transport refresh timer and in-flight guard. */
let transportRefreshIntervalId = null;
let transportRefreshInFlight = false;
let transportRefreshTimeoutId = null;
let transportRefreshArmedByCommand = false;
const TRANSPORT_REFRESH_INTERVAL_MS = 500;
const TRANSPORT_REFRESH_TIMEOUT_MS = 1_500;
const TRANSPORT_TRANSITION_WINDOW_MS = 3_000;
const STOPPED_NOTIFY_REFRESH_DELAY_MS = 120;
let transportTransitionDeadlineMs = 0;
let stoppedNotifyRefreshTimeoutId = null;
let lastObservedClipId = "";
let lastObservedTransportSlotId = "";
let lastObservedTimelineSlotId = "";
let lastTimelineClipsKv = null;
let timelineClipNameById = new Map();
let slotMediaClipNameById = new Map();

// Slot media file-size hydration architecture (beginner view):
// 1) lastSlotMediaKv stores the most recent 206/520 disk list snapshot.
// 2) slotMediaClipInfoByName caches file sizes by clip name.
// 3) slotMediaPendingByName + queuedSlotMediaClipNames +
//    slotMediaClipInfoInFlightName implement a one-at-a-time request queue.
// This separation lets us render rows immediately, then fill file sizes as
// clip info replies arrive, without blocking the UI.
let lastSlotMediaKv = null;
const slotMediaClipInfoByName = new Map();
const slotMediaPendingByName = new Set();
const queuedSlotMediaClipNames = [];
let slotMediaClipInfoInFlightName = null;
let slotMediaClipInfoInFlightTimeoutId = null;
const SLOT_MEDIA_CLIP_INFO_RESPONSE_TIMEOUT_MS = 1_500;
let lastSlotMediaNamesKey = "";
let pendingManualClipInfoRequest = false;
let pendingSpillOrderQuery = false;
const knownSlotStates = {};
let currentSlotSwitcherRenderKey = "";
let lastRecordAttemptAtMs = 0;
let hasTransportStateHydratedForSession = false;
let pendingNoInputSourceLookup = false;
let noInputSourceLookupTimeoutId = null;
const NO_INPUT_SOURCE_LOOKUP_TIMEOUT_MS = 1_200;

/**
 * Local playback option state used to compose transport commands.
 * Synced from transport state updates and user toggle interaction.
 */
const localPlayback = {
  loop: false,
  singleClip: false,
  speed: 0,
  status: "",
};

const pendingPlaybackIntent = {
  loop: null,
  singleClip: null,
};

/** Saved connection profiles via backend JSON API. */
const CONNECTIONS_API_BASE = "/api/connections";
let savedConnectionProfiles = [];
let lastSyncedConnectionModelKey = "";
let draggedConnectionId = null;
let didConnectionDrag = false;
let lastConnectionProfilesRenderKey = "";

const MAX_CONSOLE_LINES = 500;
let suppressCurrent208RawConsoleBlock = false;
const UI_PREFERENCES_STORAGE_KEY = "hyperdeckVibe.uiPreferences";

const uiPreferences = {
  showDynamicRangeInTransportInfo: true,
  showTransportJog: true,
  showTransportShuttle: true,
  showTransportGoto: true,
  showTransportPlayRange: true,
};

const SLOT_SELECT_COMMON_VIDEO_FORMATS = [
  "720p50", "720p5994", "720p60",
  "1080p23976", "1080p24", "1080p25", "1080p2997", "1080p30", "1080p60",
  "1080i50", "1080i5994", "1080i60",
];

const SLOT_SELECT_EXTREME_HDR_VIDEO_FORMATS = [
  "NTSC", "PAL", "NTSCp", "PALp",
  "2160p23.98", "2160p24", "2160p25", "2160p29.97", "2160p30", "2160p50", "2160p59.94", "2160p60",
  "4Kp23976", "4Kp24", "4Kp25", "4Kp2997", "4Kp30", "4Kp50", "4Kp5994", "4Kp60",
];

const SLOT_SELECT_EXTREME_8K_VIDEO_FORMATS = [
  "4320p23.98", "4320p24", "4320p25", "4320p29.97", "4320p30", "4320p50", "4320p59.94", "4320p60",
  "8Kp23976", "8Kp24", "8Kp25",
];

const SLOT_SELECT_STUDIO_PRO_PLUS_4K_FORMATS = [
  "4Kp23976", "4Kp24", "4Kp25", "4Kp2997", "4Kp30",
];

const SLOT_SELECT_STUDIO_4K_PRO_EXTRA_FORMATS = [
  "4Kp50", "4Kp5994", "4Kp60",
];

let lastSlotSelectModelKey = "";

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
    flushPendingBackendMessages();
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
    stopTransportAutoRefresh();
  });

  socket.addEventListener("error", () => {
    consoleLog("[WebSocket error]", "cl--error");
  });
}

function isSocketOpen() {
  // Single source of truth for socket readiness checks.
  // This removes repeated conditions and avoids subtle inconsistencies.
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function queueBackendMessage(payload, options = {}) {
  // dedupeAction keeps only the latest intent for the same action type
  // (for example, multiple rapid connect clicks). This prevents stale queued
  // actions from running after the socket opens.
  const shouldDedupeAction = options.dedupeAction === true;
  const action = shouldDedupeAction ? String(payload?.action || "") : "";
  if (action) {
    for (let i = pendingBackendMessages.length - 1; i >= 0; i -= 1) {
      if (String(pendingBackendMessages[i]?.action || "") === action) {
        pendingBackendMessages.splice(i, 1);
      }
    }
  }
  pendingBackendMessages.push(payload);
}

function flushPendingBackendMessages() {
  // Drain queue in FIFO order so user actions occur in the same order they were
  // triggered.
  if (!isSocketOpen()) {
    return;
  }

  while (pendingBackendMessages.length > 0) {
    const payload = pendingBackendMessages.shift();
    socket.send(JSON.stringify(payload));
  }
}

/**
 * Send a JSON message to the backend over the WebSocket.
 * Optionally queues the message while the socket is CONNECTING.
 */
function sendToBackend(payload, options = {}) {
  // Returns true if sent immediately, false otherwise.
  // Returning a status makes this function explicit and easier to reason about.
  if (isSocketOpen()) {
    socket.send(JSON.stringify(payload));
    return true;
  }

  if (
    options.queueIfConnecting === true &&
    socket &&
    socket.readyState === WebSocket.CONNECTING
  ) {
    queueBackendMessage(payload, { dedupeAction: options.dedupeAction === true });
    return false;
  }

  return false;
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
      hasTransportStateHydratedForSession = false;
      updateConnectionUI(true, message.host, message.port);
      startWatchdog();
      break;

    case "disconnected":
      hasTransportStateHydratedForSession = false;
      for (const key of Object.keys(knownSlotStates)) {
        delete knownSlotStates[key];
      }
      slotMediaClipInfoByName.clear();
      slotMediaPendingByName.clear();
      queuedSlotMediaClipNames.length = 0;
      slotMediaClipInfoInFlightName = null;
      clearSlotMediaClipInfoInFlightTimeout();
      lastSlotMediaNamesKey = "";
      lastSlotMediaKv = null;
      updateCurrentSlotMediaProgressBadge();
      pendingManualClipInfoRequest = false;
      updateConnectionUI(false);
      stopWatchdog();
      stopTransportAutoRefresh();
      break;

    case "raw_line":
      handleRawConsoleLine(message.line);
      break;

    case "sent":
      {
        const sentLine = String(message.line || "").trim();
        const hide208Enabled = getChecked("consoleHide208");
        const isTransportInfoSent = /^transport\s+info\b/i.test(sentLine);
        if (hide208Enabled && isTransportInfoSent) {
          break;
        }

        // Display the command we sent in a distinct colour
        consoleLog(`→ ${message.line}`, "cl--sent");
      }
      break;

    case "response":
      handleParsedResponse(message.code, message.text, message.data || {});
      break;

    case "state":
      {
        const previousConnectionKey = `${Boolean(deviceState.is_connected)}|${String(deviceState.host || "").trim()}|${String(deviceState.port || "").trim()}`;
      deviceState = message.state || {};
        const nextConnectionKey = `${Boolean(deviceState.is_connected)}|${String(deviceState.host || "").trim()}|${String(deviceState.port || "").trim()}`;

        if (nextConnectionKey !== previousConnectionKey) {
          updateConnectionUI(
            deviceState.is_connected === true,
            deviceState.host || "",
            deviceState.port || "",
          );
        }
      }
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
    if (suppressCurrent208RawConsoleBlock) {
      suppressCurrent208RawConsoleBlock = false;
      return;
    }

    // Blank line separates multiline blocks; show as faint separator
    consoleLog("", "cl--blank");
    return;
  }

  const codeMatch = rawLine.match(/^(\d{3})\s/);
  if (!codeMatch) {
    if (suppressCurrent208RawConsoleBlock) {
      return;
    }

    // Continuation line inside a multiline block (key: value pairs)
    consoleLog(`   ${rawLine}`, "cl--data");
    return;
  }

  const code = parseInt(codeMatch[1], 10);
  const hide208Enabled = getChecked("consoleHide208");
  if (hide208Enabled && code === 208) {
    suppressCurrent208RawConsoleBlock = /:\s*$/.test(rawLine);
    return;
  }

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
  // Advance clip-info queue on error responses (e.g. 112 clip not found) while
  // a per-clip request is in-flight.  Explicit success codes are handled inside
  // their own case blocks below; the default: branch handles the clip-info reply.
  if (code >= 100 && code <= 199 && slotMediaClipInfoInFlightName !== null) {
    slotMediaPendingByName.delete(slotMediaClipInfoInFlightName);
    slotMediaClipInfoInFlightName = null;
    clearSlotMediaClipInfoInFlightTimeout();
    updateCurrentSlotMediaProgressBadge();
    pumpSlotMediaClipInfoRequests();
  }

  if (pendingSpillOrderQuery && code >= 100 && code <= 199) {
    pendingSpillOrderQuery = false;
    displayResultBoxFromPayload("spillOrderResult", kv, text);
  }

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
      updateKnownSlotStateFromResponse(kv);
      renderCurrentSlotSwitcher(deviceState);
      renderCurrentSlotInfoSummary(deviceState);
      break;

    // ── 204  device info ───────────────────────────────────────────────
    case 204:
      break; // state update handled via "state" message

    // ── 205 / 519  clips info ──────────────────────────────────────────
    case 205:
      lastTimelineClipsKv = kv;
      renderClipsTable(kv);
      break;

    case 519:
      lastTimelineClipsKv = kv;
      renderClipsTable(kv);
      // 519 snapshot responses (rebuild, remove, etc.) lack proper durations.
      // Automatically follow up with clips get to get accurate clip info.
      if (String(kv["update type"] || "").trim().toLowerCase() === "snapshot") {
        applyClipsGet();
      }
      break;

    // ── 206 / 520  disk list ───────────────────────────────────────────
    case 206:
    case 520:
      displayResultBox("diskListResult", kv);
      maybeRenderCurrentSlotMediaTable(kv);
      break;

    // ── 208 / 508  transport info ──────────────────────────────────────
    case 208:
    case 508:
      hasTransportStateHydratedForSession = true;

      const responseStatus = String(kv.status || deviceState.transport_status || "")
        .trim()
        .toUpperCase();
      const allowDeckPlaybackFlagOverride = !(responseStatus === "STOPPED" || responseStatus === "PREVIEW");

      // These keys are definitive only when present in 208/508 payloads.
      if (Object.prototype.hasOwnProperty.call(kv, "loop")) {
        const nextLoop = String(kv.loop).trim().toLowerCase() === "true";
        if (pendingPlaybackIntent.loop === null || allowDeckPlaybackFlagOverride) {
          localPlayback.loop = nextLoop;
          pendingPlaybackIntent.loop = null;
        }
      }
      if (Object.prototype.hasOwnProperty.call(kv, "single clip")) {
        const nextSingleClip = String(kv["single clip"]).trim().toLowerCase() === "true";
        if (pendingPlaybackIntent.singleClip === null || allowDeckPlaybackFlagOverride) {
          localPlayback.singleClip = nextSingleClip;
          pendingPlaybackIntent.singleClip = null;
        }
      }

      setCheckbox("playLoop", pendingPlaybackIntent.loop ?? localPlayback.loop);
      setCheckbox("playSingleClip", pendingPlaybackIntent.singleClip ?? localPlayback.singleClip);

      // In STOPPED state we do not run continuous polling. A 508 notify can be
      // followed by a single 208 query to collect a fresh snapshot.
      if (code === 508 && responseStatus === "STOPPED") {
        queueStoppedNotifyTransportRefresh();
      }

      clearTransportRefreshInFlight();
      syncTransportActionButtons(deviceState);
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
      maybeResolveNoInputSourceLookup(kv);
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
    case 214:
      updateClipCountBadge(kv["clip count"] || "");
      break;

    // ── 215  uptime ────────────────────────────────────────────────────
    case 215:
      displayResultBoxFromPayload("advUtilResult", kv, text);
      break;

    // ── 216  format ready (token returned) ─────────────────────────────
    case 216: {
      const tokenFromKv = String(kv.token || kv["format token"] || "").trim();
      // Some firmware returns only the raw token text on its own line.
      const tokenFromText = String(text || "").split(/\r?\n/)
        .map((line) => String(line || "").trim())
        .find((line) => line && line.toLowerCase() !== "format ready") || "";
      const token = tokenFromKv || tokenFromText;

      if (token) {
        pendingFormatToken = token;
        const tokenInput = document.getElementById("fmtToken");
        if (tokenInput) {
          tokenInput.value = pendingFormatToken;
        }
        const confirmBtn = document.getElementById("btnFormatConfirm");
        if (confirmBtn) {
          confirmBtn.disabled = false;
        }
        showToast(`Format token received: ${pendingFormatToken}`, "warn");
      }
      break;
    }

    // ── 218  play on startup ───────────────────────────────────────────
    case 218:
      if (Object.prototype.hasOwnProperty.call(kv, "enabled")) {
        setCheckbox("posEnable", String(kv.enabled).trim().toLowerCase() === "true");
      }
      if (Object.prototype.hasOwnProperty.call(kv, "single clip")) {
        setCheckbox("posSingleClip", String(kv["single clip"]).trim().toLowerCase() === "true");
      }
      break;

    // ── 219  playrange ─────────────────────────────────────────────────
    case 219:
      // UI playrange state is synced by backend state snapshots.
      break;

    // ── 220  play option ───────────────────────────────────────────────
    case 220:
      setSelectIfKnown("stopMode", kv["stop mode"]);
      break;

    // ── 221  cache info ────────────────────────────────────────────────
    case 221:
      displayResultBoxFromPayload("advUtilResult", kv, text);
      break;

    // ── 222  dynamic range ─────────────────────────────────────────────
    case 222:
      setSelectIfKnown("drPlaybackOverride", kv["playback override"]);
      setSelectIfKnown("drRecordOverride", kv["record override"]);
      break;

    // ── 224  nas list/selected ─────────────────────────────────────────
    case 224:
      displayResultBoxFromPayload("advUtilResult", kv, text);
      break;

    // ── 225  nas host info ─────────────────────────────────────────────
    case 225:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 226  external drive info ───────────────────────────────────────
    case 226:
      displayResultBox("advUtilResult", kv);
      break;

    // ── 227  spill order ────────────────────────────────────────────────
    case 227:
      pendingSpillOrderQuery = false;
      displayResultBoxFromPayload("spillOrderResult", kv, text);
      break;

    // ── 500  connection info (initial banner) ──────────────────────────
    case 500:
      showToast(`Connected to ${kv["model"] || "HyperDeck"}`, "ok");
      break;

    // ── Capture format token / clip info response ─────────────────────
    // The HyperDeck "clip info" command returns a response code that is not
    // in the explicit list above, so it always falls through to here.
    // 208/508 transport-info and other known codes are handled above and
    // never reach this branch, preventing false queue advancement.
    default: {
      const isClipInfoResponse = maybeHandleClipInfoResponse(kv, slotMediaClipInfoInFlightName);
      if (isClipInfoResponse) {
        slotMediaClipInfoInFlightName = null;
        clearSlotMediaClipInfoInFlightTimeout();
        pumpSlotMediaClipInfoRequests();
        if (pendingManualClipInfoRequest) {
          displayResultBox("clipInfoResult", kv);
          pendingManualClipInfoRequest = false;
        }
      }

      // Some firmware versions return a custom code for the format token.
      if (kv.token) {
        pendingFormatToken = kv.token;
        document.getElementById("fmtToken").value = pendingFormatToken;
        document.getElementById("btnFormatConfirm").disabled = false;
        showToast(`Format token received: ${pendingFormatToken}`, "warn");
      }
      break;
    }
  }

  if (pendingSpillOrderQuery && code >= 200 && code <= 299) {
    pendingSpillOrderQuery = false;
    displayResultBoxFromPayload("spillOrderResult", kv, text);
  }

  if (code === 110 && Date.now() - lastRecordAttemptAtMs < 4000) {
    triggerNoInputSourceLookup();
  }

  // Display error responses with descriptive messages
  if (code >= 100 && code <= 199 && code !== 110) {
    const description = ERROR_CODE_DESCRIPTIONS[code] || "Error";
    showToast(`${code} ${description}`, "error");
  }
}

function clearNoInputSourceLookupTimeout() {
  if (noInputSourceLookupTimeoutId !== null) {
    clearTimeout(noInputSourceLookupTimeoutId);
    noInputSourceLookupTimeoutId = null;
  }
}

function normalizeInputLabel(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function triggerNoInputSourceLookup() {
  pendingNoInputSourceLookup = true;
  clearNoInputSourceLookupTimeout();

  noInputSourceLookupTimeoutId = setTimeout(() => {
    if (!pendingNoInputSourceLookup) return;
    pendingNoInputSourceLookup = false;
    noInputSourceLookupTimeoutId = null;
    window.alert("No Input");
    showToast("No Input", "error");
  }, NO_INPUT_SOURCE_LOOKUP_TIMEOUT_MS);

  sendCmd("configuration", { quiet: true });
}

function maybeResolveNoInputSourceLookup(kv = {}) {
  if (!pendingNoInputSourceLookup) return;

  const selectedInput = normalizeInputLabel(kv["video input"] || deviceState.cfg_video_input);
  const message = selectedInput ? `No Input on ${selectedInput}` : "No Input";

  pendingNoInputSourceLookup = false;
  clearNoInputSourceLookupTimeout();

  window.alert(message);
  showToast(message, "error");
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
  syncLocalPlaybackFromState(state);
  refreshSlotSelectVideoFormatOptions(state);

  // ── Transport status ──────────────────────────────────────────────────
  const status = state.transport_status || "";
  const normalizedStatus = String(status).trim().toUpperCase();
  setStatusBadge("tsStatus",   status, state.transport_speed);
  setStatusBadge("dashStatus", status, state.transport_speed);
  setCheckbox("previewEnable", String(status).trim().toLowerCase() === "preview");

  const tsStatusEl = document.getElementById("tsStatus");
  tsStatusEl?.classList.toggle(
    "status-badge--stopped-alert",
    state.is_connected === true && normalizedStatus === "STOPPED",
  );

  setText("tsFormat",     state.transport_video_format    || "—");
  const tsPlayRangeRowEl = document.getElementById("tsPlayRangeRow");
  const tsPlayRangeEl = document.getElementById("tsPlayRange");
  if (tsPlayRangeEl && tsPlayRangeRowEl) {
    tsPlayRangeEl.textContent = "PLAY RANGE SET";
    tsPlayRangeEl.className = "status-badge playrange-set";
  }
  if (state.is_connected !== true) {
    resetDisconnectedTransportUI(tsPlayRangeRowEl);
  }
  syncTransportActionButtons(state);

  // Dashboard transport
  setText("dashSpeed",      formatSpeed(state.transport_speed));
  setText("dashClipId",     state.transport_clip_id         || "—");
  updateTransportClipNameIndicator(state);
  setText("dashSlotId",     formatSlot(state));
  const mediaSlotId = normalizeDisplayNone(state.transport_slot_id);
  const mediaSlotLabel = isDisplayNoneToken(mediaSlotId)
    ? "None"
    : (mediaSlotId ? `Slot ${mediaSlotId}` : "—");
  setText("currentSlotMediaSlotId", state.is_connected === true ? mediaSlotLabel : "—");
  setText("dashSlotName",   state.transport_slot_name       || "—");
  setText("dashDevName",    state.transport_device_name     || "—");
  setText("dashVidFmt",     state.transport_video_format    || "—");
  setText("dashLoop",       boolYesNo(state.transport_loop));
  setText("dashSingleClip", boolYesNo(state.transport_single_clip));
  setCheckbox("playLoop", localPlayback.loop);
  setCheckbox("playSingleClip", localPlayback.singleClip);
  setText("dashTimeline",   state.transport_timeline        || "—");
  setText("dashDynRange",   state.transport_dynamic_range   || "—");
  setText("dashRefLocked",  boolYesNo(state.transport_reference_locked));

  // Timecode displays (use display timecode when available, fall back to transport)
  const displayTC = state.transport_display_timecode || state.transport_timecode || "--:--:--:--";
  const sidebarTimecodeEl = document.getElementById("sidebarTimecode");
  if (state.is_connected === false) {
    setText("sidebarTimecode", "DISCONNECTED");
    sidebarTimecodeEl?.classList.add("timecode-display--disconnected");
    if (sidebarTimecodeEl) sidebarTimecodeEl.title = "";
  } else {
    setText("sidebarTimecode", displayTC);
    sidebarTimecodeEl?.classList.remove("timecode-display--disconnected");
    if (sidebarTimecodeEl) sidebarTimecodeEl.title = "Display Timecode";
  }

  // ── Device info ───────────────────────────────────────────────────────
  syncSidebarDeviceIdentity(
    state.is_connected === true,
    state.host || deviceState.host || "",
    state.port || deviceState.port || "",
  );
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
  updateDashboardRemoteToggle(state.remote_enabled);
  updateDashboardOverrideToggle(state.remote_override);
  if (state.is_connected === true) {
    setBoolDot("sidebarDotRemote",  state.remote_enabled);
    setBoolDot("sidebarDotRefLock", state.transport_reference_locked);
  } else {
    const sidebarDotRemote = document.getElementById("sidebarDotRemote");
    const sidebarDotRefLock = document.getElementById("sidebarDotRefLock");
    if (sidebarDotRemote) sidebarDotRemote.className = "dot dot--off";
    if (sidebarDotRefLock) sidebarDotRefLock.className = "dot dot--off";
  }

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

  maybeSyncConnectedModel(state);
  maybeRefreshAfterClipIdChange(state);
  maybeRefreshTimelineClipsAfterSlotChange(state);
  maybeRefreshCurrentSlotMediaAfterSlotChange(state);
  renderCurrentSlotSwitcher(state);
  renderCurrentSlotInfoSummary(state);
  syncTransportAutoRefresh(state);

  // ── Play Range status ─────────────────────────────────────────────────
  {
    const statusEl = document.getElementById("playrangeStatus");
    const pillEl   = document.getElementById("playrangeStatusPill");
    const detailEl = document.getElementById("playrangeStatusDetail");
    if (statusEl && pillEl && detailEl) {
      const pr = state.playrange_active;
      statusEl.className = "playrange-status " + (
        pr === true  ? "playrange-status--set"   :
        pr === false ? "playrange-status--clear" :
                       "playrange-status--unknown"
      );
      if (pr === true) {
        pillEl.textContent = "Range Active";
        const parts = [];
        if (state.playrange_clip_id) {
          parts.push(`Clip ${state.playrange_clip_id}${state.playrange_count ? " × " + state.playrange_count : ""}`);
        }
        if (state.playrange_in)           parts.push(`In: ${state.playrange_in}`);
        if (state.playrange_out)          parts.push(`Out: ${state.playrange_out}`);
        if (state.playrange_timeline_in)  parts.push(`TL In: ${state.playrange_timeline_in}`);
        if (state.playrange_timeline_out) parts.push(`TL Out: ${state.playrange_timeline_out}`);
        detailEl.textContent = parts.join("  ·  ");
      } else if (pr === false) {
        pillEl.textContent = "No Range Set";
        detailEl.textContent = "";
      } else {
        pillEl.textContent = "—";
        detailEl.textContent = "";
      }

      // Keep dashboard sidebar badge in lock-step with this transport card indicator.
      const tsPlayRangeRowEl = document.getElementById("tsPlayRangeRow");
      const tsPlayRangeEl = document.getElementById("tsPlayRange");
      const playbackPlayRangeBadgeEl = document.getElementById("playbackPlayRangeSetBadge");
      if (tsPlayRangeRowEl && tsPlayRangeEl) {
        const transportShowsRangeActive = statusEl.classList.contains("playrange-status--set");
        tsPlayRangeEl.textContent = "PLAY RANGE SET";
        tsPlayRangeEl.className = "status-badge playrange-set";
        tsPlayRangeRowEl.hidden = !transportShowsRangeActive;

        if (playbackPlayRangeBadgeEl) {
          playbackPlayRangeBadgeEl.textContent = "PLAY RANGE SET";
          playbackPlayRangeBadgeEl.className = "status-badge playrange-set playback-playrange-indicator";
          playbackPlayRangeBadgeEl.hidden = !transportShowsRangeActive;
        }
      }
    }
  }
}

function maybeRefreshAfterClipIdChange(state) {
  const currentClipId = String(state.transport_clip_id || "").trim();
  if (currentClipId === lastObservedClipId) {
    return;
  }

  lastObservedClipId = currentClipId;

  const clipsTab = document.getElementById("tab-clips");
  const clipsTabIsActive = Boolean(clipsTab?.classList.contains("active"));
  if (clipsTabIsActive && lastTimelineClipsKv) {
    renderClipsTable(lastTimelineClipsKv);
  }

  if (!currentClipId) {
    return;
  }

  // Clip changes can precede timecode stabilization by a few frames.
  requestTransportRefresh();
  setTimeout(() => requestTransportRefresh(), 250);
}

function maybeRefreshCurrentSlotMediaAfterSlotChange(state) {
  const currentSlotId = normalizeDisplayNone(state.transport_slot_id);
  if (!currentSlotId || isDisplayNoneToken(currentSlotId)) {
    lastObservedTransportSlotId = "";
    renderCurrentSlotMediaTable({});
    return;
  }

  if (currentSlotId === lastObservedTransportSlotId) {
    return;
  }

  lastObservedTransportSlotId = currentSlotId;

  const slotsTab = document.getElementById("tab-slots");
  const slotsTabIsActive = Boolean(slotsTab?.classList.contains("active"));
  if (!slotsTabIsActive || state.is_connected !== true) {
    return;
  }

  loadCurrentSlotMedia();
}

function maybeRefreshTimelineClipsAfterSlotChange(state) {
  const currentSlotId = normalizeDisplayNone(state.transport_slot_id);
  if (!currentSlotId || isDisplayNoneToken(currentSlotId)) {
    lastObservedTimelineSlotId = "";
    return;
  }

  if (currentSlotId === lastObservedTimelineSlotId) {
    return;
  }

  lastObservedTimelineSlotId = currentSlotId;

  const clipsTab = document.getElementById("tab-clips");
  const clipsTabIsActive = Boolean(clipsTab?.classList.contains("active"));
  if (!clipsTabIsActive || state.is_connected !== true) {
    return;
  }

  applyClipsGet();
}

function formatSlotInfoBlocked(value) {
  if (value === undefined || value === null) {
    return "—";
  }

  const raw = String(value).trim();
  if (!raw) {
    return "—";
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "1") {
    return "Yes";
  }
  if (lower === "false" || lower === "no" || lower === "0") {
    return "No";
  }

  return raw;
}

function renderCurrentSlotInfoSummary(state = deviceState) {
  const activeSlot = normalizeDisplayNone(state?.transport_slot_id);
  const slotKey = (!activeSlot || isDisplayNoneToken(activeSlot)) ? "" : String(activeSlot).trim();
  const slotInfo = slotKey ? (knownSlotStates[slotKey] || {}) : {};

  const statusText = String(slotInfo.status || "").trim();
  const normalizedStatus = statusText ? statusText.toUpperCase() : "";

  setText("currentSlotInfoStatus", normalizedStatus || "—");
  setText("currentSlotInfoName", slotInfo.slotName || "—");
  setText("currentSlotInfoDevice", slotInfo.device || "—");
  setText("currentSlotInfoVideoFormat", slotInfo.videoFormat || "—");
  setText("currentSlotInfoRecordingTime", slotInfo.recordingTime || "—");

  const blockedText = formatSlotInfoBlocked(slotInfo.blocked);
  setText("currentSlotInfoBlocked", blockedText);

  const blockedEl = document.getElementById("currentSlotInfoBlocked");
  if (!blockedEl) {
    return;
  }

  blockedEl.classList.remove("current-slot-info__blocked--yes", "current-slot-info__blocked--clickable");
  blockedEl.removeAttribute("role");
  blockedEl.removeAttribute("tabindex");
  blockedEl.removeAttribute("title");
  blockedEl.onclick = null;
  blockedEl.onkeydown = null;

  if (blockedText !== "Yes" || !slotKey) {
    return;
  }

  const triggerUnblock = () => {
    sendCmd(`slot unblock: slot id: ${slotKey}`);
    showToast(`Unblocking slot ${slotKey}…`, "ok");
  };

  blockedEl.classList.add("current-slot-info__blocked--yes", "current-slot-info__blocked--clickable");
  blockedEl.setAttribute("role", "button");
  blockedEl.setAttribute("tabindex", "0");
  blockedEl.title = `Click to unblock slot ${slotKey}`;
  blockedEl.onclick = triggerUnblock;
  blockedEl.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      triggerUnblock();
    }
  };
}

function updateKnownSlotStateFromResponse(kv) {
  const rawSlotId = normalizeDisplayNone(kv["slot id"]);
  if (!rawSlotId || isDisplayNoneToken(rawSlotId)) {
    return;
  }

  const slotId = String(rawSlotId).trim();
  if (!knownSlotStates[slotId]) {
    knownSlotStates[slotId] = {
      status: "",
      slotName: "",
      device: "",
      videoFormat: "",
      recordingTime: "",
      blocked: "",
    };
  }

  if (kv["status"] !== undefined) {
    knownSlotStates[slotId].status = String(kv["status"] || "").trim().toLowerCase();
  }
  if (kv["slot name"] !== undefined) {
    knownSlotStates[slotId].slotName = normalizeDisplayNone(kv["slot name"]);
  }
  if (kv["device name"] !== undefined || kv["device"] !== undefined) {
    const nextDevice = kv["device name"] !== undefined ? kv["device name"] : kv["device"];
    knownSlotStates[slotId].device = normalizeDisplayNone(nextDevice);
  }
  if (kv["video format"] !== undefined) {
    knownSlotStates[slotId].videoFormat = normalizeDisplayNone(kv["video format"]);
  }
  if (kv["recording time"] !== undefined) {
    knownSlotStates[slotId].recordingTime = normalizeDisplayNone(kv["recording time"]);
  }
  if (kv["blocked"] !== undefined) {
    knownSlotStates[slotId].blocked = String(kv["blocked"] || "").trim();
  }
}

function loadAllSlotStates() {
  const slotCount = Number.parseInt(String(deviceState.slot_count || 0), 10);
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    return;
  }

  for (let i = 1; i <= slotCount; i += 1) {
    sendCmd(`slot info: slot id: ${i}`, { quiet: true });
  }
}

function buildSlotSelectVideoFormatOptions(modelText) {
  const model = String(modelText || "").trim().toLowerCase();
  const formats = new Set();

  const isExtreme = model.includes("hyperdeck extreme");
  const isStudio = model.includes("hyperdeck studio");
  const isShuttle = model.includes("hyperdeck shuttle");
  const isExtremeHdr = isExtreme && model.includes("hdr");
  const isExtreme8k = isExtreme && model.includes("8k");
  const isStudioProOrPlus = isStudio && (model.includes("pro") || model.includes("plus"));
  const isStudio4kPro = model.includes("hyperdeck studio 4k pro");

  // Default to common formats when model is unknown so control stays usable.
  if (!model || isExtreme || isStudio || isShuttle) {
    SLOT_SELECT_COMMON_VIDEO_FORMATS.forEach((fmt) => formats.add(fmt));
  }

  if (isExtremeHdr) {
    SLOT_SELECT_EXTREME_HDR_VIDEO_FORMATS.forEach((fmt) => formats.add(fmt));
  }

  if (isExtreme8k) {
    SLOT_SELECT_EXTREME_8K_VIDEO_FORMATS.forEach((fmt) => formats.add(fmt));
  }

  if (isStudioProOrPlus) {
    SLOT_SELECT_STUDIO_PRO_PLUS_4K_FORMATS.forEach((fmt) => formats.add(fmt));
  }

  if (isStudio4kPro) {
    SLOT_SELECT_STUDIO_4K_PRO_EXTRA_FORMATS.forEach((fmt) => formats.add(fmt));
  }

  return Array.from(formats);
}

function refreshSlotSelectVideoFormatOptions(state = deviceState) {
  const selectEl = document.getElementById("slotSelectVidFmt");
  if (!selectEl) return;

  const modelKey = String(state?.model || "").trim().toLowerCase();
  if (modelKey === lastSlotSelectModelKey && selectEl.options.length > 0) {
    return;
  }

  const previousValue = String(selectEl.value || "").trim();
  const options = buildSlotSelectVideoFormatOptions(state?.model || "").sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })
  );

  selectEl.innerHTML = `<option value="">— No Video Format Filter —</option>${options
    .map((fmt) => `<option value="${escapeHtml(fmt)}">${escapeHtml(fmt)}</option>`)
    .join("")}`;

  if (previousValue && options.some((fmt) => fmt.toLowerCase() === previousValue.toLowerCase())) {
    setSelectIfKnown("slotSelectVidFmt", previousValue);
  } else {
    selectEl.value = "";
  }

  lastSlotSelectModelKey = modelKey;
}

function renderCurrentSlotSwitcher(state) {
  const hostEl = document.getElementById("currentSlotSwitcher");
  if (!hostEl) return;

  const slotCount = Number.parseInt(String(state.slot_count || 0), 10);
  if (!Number.isInteger(slotCount) || slotCount < 1) {
    hostEl.innerHTML = "";
    currentSlotSwitcherRenderKey = "";
    return;
  }

  const activeSlot = normalizeDisplayNone(state.transport_slot_id);
  const renderKeyParts = [String(activeSlot || "")];
  for (let i = 1; i <= slotCount; i += 1) {
    const slotId = String(i);
    const slotState = knownSlotStates[slotId] || {};
    const status = String(slotState.status || "").toLowerCase();
    const slotName = String(slotState.slotName || "");
    renderKeyParts.push(`${slotId}:${status}:${slotName}`);
  }
  const nextRenderKey = `${slotCount}|${renderKeyParts.join("|")}`;
  if (nextRenderKey === currentSlotSwitcherRenderKey) {
    renderCurrentSlotInfoSummary(state);
    return;
  }
  currentSlotSwitcherRenderKey = nextRenderKey;

  hostEl.innerHTML = Array.from({ length: slotCount }, (_, idx) => {
    const slotId = String(idx + 1);
    const slotState = knownSlotStates[slotId] || {};
    const status = String(slotState.status || "").toLowerCase();
    const isEmpty = status === "empty";
    const isActive = activeSlot === slotId;
    const label = slotState.slotName ? `Slot ${slotId} (${slotState.slotName})` : `Slot ${slotId}`;

    const classes = ["slot-switcher__btn"];
    if (isActive) classes.push("slot-switcher__btn--active");
    if (isEmpty) classes.push("slot-switcher__btn--disabled");

    return `<button
      class="${classes.join(" ")}"
      data-slot-id="${slotId}"
      ${isEmpty ? "disabled" : ""}
      title="${isEmpty ? "Slot empty" : "Make active slot"}">
      ${escapeHtml(label)}
    </button>`;
  }).join("");

  for (const btn of hostEl.querySelectorAll("button[data-slot-id]")) {
    btn.addEventListener("click", () => {
      const slotId = String(btn.getAttribute("data-slot-id") || "").trim();
      if (!slotId || btn.disabled) return;
      sendCmd(`slot select: slot id: ${slotId}`);
      showToast(`Selecting slot ${slotId}…`, "ok");
    });
  }

  renderCurrentSlotInfoSummary(state);
}

function updateDashboardRemoteToggle(isEnabled) {
  const btn = document.getElementById("dashRemoteToggleBtn");
  if (!btn) return;
  const enabled = isEnabled === true || isEnabled === "true";

  if (enabled) {
    btn.textContent = "Remote Enabled";
    btn.classList.remove("state-disabled");
    btn.classList.add("state-enabled");
  } else {
    btn.textContent = "Remote Disabled";
    btn.classList.remove("state-enabled");
    btn.classList.add("state-disabled");
  }
}

function toggleDashboardRemote() {
  const enabled = stateFlagEnabled(deviceState.remote_enabled);
  sendCmd(`remote: enable: ${enabled ? "false" : "true"}`);
  requestRemoteStateRefresh();
}

function updateDashboardOverrideToggle(isEnabled) {
  const btn = document.getElementById("dashOverrideToggleBtn");
  if (!btn) return;
  const enabled = isEnabled === true || isEnabled === "true";

  if (enabled) {
    btn.textContent = "Override Enabled";
    btn.classList.remove("state-disabled");
    btn.classList.add("state-enabled");
  } else {
    btn.textContent = "Override Disabled";
    btn.classList.remove("state-enabled");
    btn.classList.add("state-disabled");
  }
}

function toggleDashboardOverride() {
  const enabled = stateFlagEnabled(deviceState.remote_override);
  sendCmd(`remote: override: ${enabled ? "false" : "true"}`);
  requestRemoteStateRefresh();
}

function requestRemoteStateRefresh() {
  // Keep UI authoritative even if 510 notify arrives late or is dropped.
  setTimeout(() => sendCmd("remote", { quiet: true }), 100);
  setTimeout(() => sendCmd("remote", { quiet: true }), 400);
}

function stateFlagEnabled(value) {
  return value === true || String(value).trim().toLowerCase() === "true";
}

/**
 * Set the visual class (colour) of a status badge element based on transport status.
 * The class name matches the CSS .status-badge.{status} rules in style.css.
 */
function setStatusBadge(elementId, status, speed = null) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const normalizedStatus = String(status || "").trim().toUpperCase();
  let labelText = status || "—";
  if (normalizedStatus === "SHUTTLE") {
    const parsedSpeed = Number.parseInt(speed ?? 0, 10);
    if (Number.isFinite(parsedSpeed)) {
      labelText = `SHUTTLE ${parsedSpeed}%`;
    }
  }

  el.textContent = labelText;
  // Strip all previous status classes then apply the new one
  el.className = "status-badge";
  if (status) el.classList.add(status.toLowerCase());
}

function hasNoInputCondition(state = deviceState) {
  if (!state || state.is_connected !== true) return false;
  const statusText = String(state.transport_status || "").toUpperCase();
  const videoFmt = String(state.transport_video_format || "").toUpperCase();
  const inputFmt = String(state.transport_input_video_format || "").toUpperCase();
  return (
    /\b(NO INPUT|NONE)\b/.test(statusText) ||
    /\b(NO INPUT|NONE)\b/.test(videoFmt) ||
    /\b(NO INPUT|NONE)\b/.test(inputFmt)
  );
}

function syncTransportActionButtons(state = deviceState) {
  const stopBtn = document.getElementById("transportStopBtn");
  const playBtn = document.getElementById("transportPlayBtn");
  const recordBtn = document.getElementById("transportRecordBtn");
  const rewindBtn = document.getElementById("transportRewindBtn");
  const forwardBtn = document.getElementById("transportForwardBtn");
  if (!stopBtn && !playBtn && !recordBtn && !rewindBtn && !forwardBtn) return;

  stopBtn?.classList.remove("tbtn--active-stop");
  playBtn?.classList.remove("tbtn--active-play", "tbtn--active-record");
  recordBtn?.classList.remove("tbtn--active-play", "tbtn--active-record", "tbtn--record-no-input");
  rewindBtn?.classList.remove("tbtn--active-rewind", "tbtn--active-shuttle");
  forwardBtn?.classList.remove("tbtn--active-forward", "tbtn--active-shuttle");
  stopBtn?.setAttribute("aria-pressed", "false");
  playBtn?.setAttribute("aria-pressed", "false");
  recordBtn?.setAttribute("aria-pressed", "false");
  recordBtn?.setAttribute("aria-disabled", "false");
  rewindBtn?.setAttribute("aria-pressed", "false");
  forwardBtn?.setAttribute("aria-pressed", "false");

  if (!state || state.is_connected !== true) {
    return;
  }

  const hasNoInput = hasNoInputCondition(state);
  if (hasNoInput) {
    recordBtn?.classList.add("tbtn--record-no-input");
    recordBtn?.setAttribute("aria-disabled", "true");
  }

  const status = String(state.transport_status || "").trim().toUpperCase();
  const speed = Number.parseInt(state.transport_speed ?? 0, 10);
  if (status === "STOPPED" || status === "PREVIEW") {
    stopBtn?.classList.add("tbtn--active-stop");
    stopBtn?.setAttribute("aria-pressed", "true");
  } else if (status === "PLAY") {
    playBtn?.classList.add("tbtn--active-play");
    playBtn?.setAttribute("aria-pressed", "true");
  } else if (status === "RECORD" && !hasNoInput) {
    recordBtn?.classList.add("tbtn--active-record");
    recordBtn?.setAttribute("aria-pressed", "true");
  } else if (status === "REWIND") {
    rewindBtn?.classList.add("tbtn--active-rewind");
    rewindBtn?.setAttribute("aria-pressed", "true");
  } else if (status === "FORWARD") {
    forwardBtn?.classList.add("tbtn--active-forward");
    forwardBtn?.setAttribute("aria-pressed", "true");
  } else if (status === "SHUTTLE") {
    if (Number.isFinite(speed) && speed < 0) {
      rewindBtn?.classList.add("tbtn--active-shuttle");
      rewindBtn?.setAttribute("aria-pressed", "true");
    } else if (Number.isFinite(speed) && speed > 0) {
      forwardBtn?.classList.add("tbtn--active-shuttle");
      forwardBtn?.setAttribute("aria-pressed", "true");
    }
  }
}

function setBoolDot(elementId, value) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const isTrue = value === true || String(value).trim().toLowerCase() === "true";
  el.className = `dot ${isTrue ? "dot--on" : "dot--no"}`;
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
  const host = String(document.getElementById("connProfileHost")?.value || "").trim();
  const port = parseInt(String(document.getElementById("connProfilePort")?.value || "9993"), 10) || 9993;
  if (!host) { showToast("Enter a host IP address", "error"); return; }

  if (!socket || socket.readyState === WebSocket.CLOSED) {
    openWebSocket();
  }

  sendToBackend(
    { action: "connect", host, port },
    { queueIfConnecting: true, dedupeAction: true },
  );
}

/** Called on the Disconnect button click. */
function uiDisconnect() {
  sendToBackend({ action: "disconnect" });
}

function onTopbarStatusClick(event) {
  event?.stopPropagation();
  if (!deviceState.is_connected) {
    activateTab("connections");
    showToast("Use Connections tab to connect", "warn");
    return;
  }

  const shouldDisconnect = window.confirm("Disconnect from the current HyperDeck?");
  if (shouldDisconnect) {
    uiDisconnect();
  }
}

function onSidebarTimecodeClick(event) {
  event?.stopPropagation();
  if (deviceState.is_connected) {
    return;
  }

  activateTab("connections");
  showToast("Use Connections tab to connect", "warn");
}

function onSidebarRemoteIndicatorClick(event) {
  event?.stopPropagation();
  if (!deviceState.is_connected) {
    activateTab("connections");
    showToast("Use Connections tab to connect", "warn");
    return;
  }

  toggleDashboardRemote();
}

function jumpToPlayRangeSection(event) {
  event?.stopPropagation();

  // Ensure the section is visible and keep the Config toggle mirrored.
  uiPreferences.showTransportPlayRange = true;
  saveUiPreferences();
  applyUiPreferencesToUI();

  activateTab("transport");

  const playRangeCard = document.getElementById("transportPlayRangeCard");
  if (playRangeCard) {
    playRangeCard.hidden = false;
    playRangeCard.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function findSavedConnectionName(host, port) {
  const normalizedHost = String(host || "").trim();
  const normalizedPort = parseInt(String(port || ""), 10);

  if (!normalizedHost || !Number.isFinite(normalizedPort)) {
    return "";
  }

  const match = savedConnectionProfiles.find((entry) => {
    const entryHost = String(entry.host || "").trim();
    const entryPort = parseInt(String(entry.port || ""), 10);
    return entryHost === normalizedHost && entryPort === normalizedPort;
  });

  return String(match?.name || "").trim();
}

function syncTopbarConnectionIndicator(isConnected, host = "", port = "") {
  const statusText = document.getElementById("statusText");
  const topbarStatus = document.getElementById("topbarStatus");
  if (!statusText) return;

  if (isConnected) {
    const endpointText = `${host}:${port}`;
    const savedName = findSavedConnectionName(host, port);
    statusText.textContent = savedName || endpointText;
    topbarStatus?.setAttribute("title", `${endpointText}\nClick to Disconnect`);
    return;
  }

  statusText.textContent = "Disconnected";
  topbarStatus?.removeAttribute("title");
}

function syncSidebarDeviceIdentity(isConnected, host = "", port = "") {
  const labelEl = document.getElementById("devNameLabel");
  const valueEl = document.getElementById("devNameValue");
  if (!labelEl || !valueEl) return;

  if (!isConnected) {
    labelEl.textContent = "Name";
    valueEl.textContent = "—";
    return;
  }

  const savedName = findSavedConnectionName(host, port);
  if (savedName) {
    labelEl.textContent = "Name";
    valueEl.textContent = savedName;
    return;
  }

  const endpointHost = String(host || "").trim();
  const endpointPort = String(port || "").trim();
  labelEl.textContent = "IP";
  valueEl.textContent = endpointHost
    ? (endpointPort ? `${endpointHost}:${endpointPort}` : endpointHost)
    : "—";
}

/**
 * Update connection state widgets: dot colour, status text, button states.
 */
function updateConnectionUI(isConnected, host = "", port = "") {
  const dot        = document.getElementById("statusDot");
  const connectionsTabBtn = document.getElementById("connectionsTabBtn");
  const sidebarTimecode = document.getElementById("sidebarTimecode");
  const sidebarDeviceSection = document.getElementById("sidebarDeviceSection");
  syncTopbarConnectionIndicator(isConnected, host, port);
  syncSidebarDeviceIdentity(isConnected, host, port);
  if (sidebarDeviceSection) {
    sidebarDeviceSection.style.display = isConnected ? "" : "none";
  }

  if (isConnected) {
    dot.className = "dot dot--on";
    connectionsTabBtn?.classList.remove("tab--needs-connection");
    sidebarTimecode?.classList.remove("timecode-display--disconnected");
  } else {
    dot.className = "dot dot--off";
    connectionsTabBtn?.classList.add("tab--needs-connection");
    lastSyncedConnectionModelKey = "";
    // Reset live displays
    setText("sidebarTimecode", "DISCONNECTED");
    sidebarTimecode?.classList.add("timecode-display--disconnected");
    resetDisconnectedTransportUI();
  }

  // Re-render the saved connections list only when the connection marker changes.
  // This avoids rebuilding list DOM on every transport state update.
  const connectionMarkerKey = `${Boolean(isConnected)}|${String(host || "").trim()}|${String(port || "").trim()}`;
  if (connectionMarkerKey !== lastConnectionProfilesRenderKey) {
    lastConnectionProfilesRenderKey = connectionMarkerKey;
    renderConnectionProfiles();
  }
}

async function loadConnectionProfiles() {
  try {
    const res = await fetch(CONNECTIONS_API_BASE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    savedConnectionProfiles = Array.isArray(payload.connections) ? payload.connections : [];
    renderConnectionProfiles();
  } catch (err) {
    consoleLog(`[Connections] failed to load profiles: ${err}`, "cl--error");
  }
}

function renderConnectionProfiles() {
  const list = document.getElementById("savedConnectionsList");
  if (!list) return;

  if (!savedConnectionProfiles.length) {
    list.innerHTML = `<div class="hint">No saved connections yet.</div>`;
    return;
  }

  // Clear old children properly to avoid listener leaks
  while (list.firstChild) {
    list.removeChild(list.firstChild);
  }
  savedConnectionProfiles.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "saved-connection-item";
    item.draggable = true;
    item.dataset.connectionId = String(entry.id || "");
    item.addEventListener("click", () => onSavedConnectionClick(entry.id));
    item.addEventListener("dragstart", (event) => onConnectionDragStart(event, entry.id));
    item.addEventListener("dragover", onConnectionDragOver);
    item.addEventListener("drop", (event) => onConnectionDrop(event, entry.id));
    item.addEventListener("dragend", onConnectionDragEnd);

    const modelText = entry.model && String(entry.model).trim() ? entry.model : "Model unknown";
    const isEntryConnected =
      deviceState.is_connected === true &&
      String(deviceState.host || "").trim() === String(entry.host || "").trim() &&
      parseInt(String(deviceState.port || ""), 10) === parseInt(String(entry.port || ""), 10);

    const connectedBadge = isEntryConnected
      ? `<div class="saved-connection-live"><span class="dot dot--on"></span><span>Connected</span></div>`
      : "";

    item.innerHTML = `
      <div class="saved-connection-main">
        <div class="saved-connection-name">${escapeHtml(entry.name || "Unnamed")}</div>
        <div class="saved-connection-address mono">${escapeHtml(entry.host || "")} : ${escapeHtml(String(entry.port || ""))}</div>
        <div class="saved-connection-model">${escapeHtml(modelText)}</div>
        ${connectedBadge}
      </div>
      <button class="btn btn--sm btn--danger" data-id="${escapeHtml(String(entry.id || ""))}">Delete</button>
    `;

    const deleteBtn = item.querySelector("button[data-id]");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        await deleteConnectionProfile(entry.id);
      });
    }

    list.appendChild(item);
  });

  // Keep top-right status label synced with profile name edits/reorders.
  if (deviceState.is_connected === true) {
    syncTopbarConnectionIndicator(true, deviceState.host || "", deviceState.port || "");
    syncSidebarDeviceIdentity(true, deviceState.host || "", deviceState.port || "");
  }
}

function onSavedConnectionClick(profileId) {
  // Browsers can fire click after drag-drop; suppress connect dialog in that case.
  if (didConnectionDrag) {
    didConnectionDrag = false;
    return;
  }

  selectConnectionProfile(profileId);

  const entry = savedConnectionProfiles.find((p) => String(p.id) === String(profileId));
  if (!entry) return;

  const label = entry.name ? `${entry.name} (${entry.host}:${entry.port})` : `${entry.host}:${entry.port}`;
  const isEntryConnected =
    deviceState.is_connected === true &&
    String(deviceState.host || "").trim() === String(entry.host || "").trim() &&
    parseInt(String(deviceState.port || ""), 10) === parseInt(String(entry.port || ""), 10);

  if (isEntryConnected) {
    const shouldDisconnect = window.confirm(`Disconnect from ${label}?`);
    if (shouldDisconnect) {
      uiDisconnect();
    }
    return;
  }

  const shouldConnect = window.confirm(`Connect to ${label}?`);
  if (shouldConnect) {
    uiConnect();
  }
}

function selectConnectionProfile(profileId) {
  const entry = savedConnectionProfiles.find((p) => String(p.id) === String(profileId));
  if (!entry) return;

  const profileNameInput = document.getElementById("connProfileName");
  const profileHostInput = document.getElementById("connProfileHost");
  const profilePortInput = document.getElementById("connProfilePort");

  if (profileNameInput) profileNameInput.value = entry.name || "";
  if (profileHostInput) profileHostInput.value = entry.host || "";
  if (profilePortInput) profilePortInput.value = String(entry.port || 9993);

  showToast("Connection fields populated", "ok");
}

async function addConnectionProfileFromForm() {
  const name = String(document.getElementById("connProfileName")?.value || "").trim();
  const host = String(document.getElementById("connProfileHost")?.value || "").trim();
  const port = parseInt(String(document.getElementById("connProfilePort")?.value || "9993"), 10) || 9993;

  if (!host) {
    showToast("Enter a Host / IP", "error");
    return;
  }

  try {
    const res = await fetch(CONNECTIONS_API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, host, port }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.detail || `HTTP ${res.status}`);
    }

    showToast("Saved connection", "ok");
    await loadConnectionProfiles();
  } catch (err) {
    showToast(`Failed to save: ${err}`, "error");
  }
}

async function deleteConnectionProfile(profileId) {
  const ok = window.confirm("Delete this saved connection?");
  if (!ok) return;

  try {
    const res = await fetch(`${CONNECTIONS_API_BASE}/${encodeURIComponent(String(profileId))}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.detail || `HTTP ${res.status}`);
    }

    showToast("Connection deleted", "ok");
    await loadConnectionProfiles();
  } catch (err) {
    showToast(`Delete failed: ${err}`, "error");
  }
}

function onConnectionDragStart(event, profileId) {
  didConnectionDrag = true;
  draggedConnectionId = String(profileId);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedConnectionId);
  event.currentTarget.classList.add("is-dragging");
}

function onConnectionDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

async function onConnectionDrop(event, targetProfileId) {
  event.preventDefault();
  const sourceId = draggedConnectionId || event.dataTransfer.getData("text/plain");
  const targetId = String(targetProfileId);
  if (!sourceId || !targetId || sourceId === targetId) {
    return;
  }

  const sourceIndex = savedConnectionProfiles.findIndex((p) => String(p.id) === String(sourceId));
  const targetIndex = savedConnectionProfiles.findIndex((p) => String(p.id) === targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return;
  }

  const next = [...savedConnectionProfiles];
  const [moved] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, moved);
  savedConnectionProfiles = next;
  renderConnectionProfiles();

  try {
    const ids = savedConnectionProfiles.map((entry) => entry.id);
    const res = await fetch(`${CONNECTIONS_API_BASE}/reorder`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.detail || `HTTP ${res.status}`);
    }
  } catch (err) {
    showToast(`Reorder failed: ${err}`, "error");
    await loadConnectionProfiles();
  }
}

function onConnectionDragEnd(event) {
  draggedConnectionId = null;
  event.currentTarget.classList.remove("is-dragging");
  // Delay reset so any synthetic click fired after drag is still suppressed.
  setTimeout(() => {
    didConnectionDrag = false;
  }, 0);
}

async function maybeSyncConnectedModel(state) {
  if (!state || !state.is_connected) return;

  const host = String(state.host || "").trim();
  const model = String(state.model || "").trim();
  const port = parseInt(String(state.port || ""), 10);
  if (!host || !model || !Number.isFinite(port)) return;

  const syncKey = `${host}:${port}:${model}`;
  if (syncKey === lastSyncedConnectionModelKey) return;
  lastSyncedConnectionModelKey = syncKey;

  try {
    await fetch(`${CONNECTIONS_API_BASE}/model`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port, model }),
    });

    const hasMatchingProfile = savedConnectionProfiles.some(
      (p) => String(p.host || "").trim() === host && parseInt(String(p.port || ""), 10) === port,
    );
    if (hasMatchingProfile) {
      await loadConnectionProfiles();
    }
  } catch (err) {
    consoleLog(`[Connections] model sync failed: ${err}`, "cl--error");
  }
}

// ============================================================
// SECTION: Command sender
// ============================================================

/**
 * Send a HyperDeck command string to the backend.
 * This is the single entry point for all command dispatch.
 */
function sendCmd(command, options = {}) {
  if (!isSocketOpen()) {
    showToast("Not connected to the server", "error");
    return;
  }

  const commandToSend = appendPlaybackOptionsToTransportCommand(command);
  rememberLocalTransportFromCommand(commandToSend);

  if (!options.quiet) {
    armTransportRefreshWindow(commandToSend);
  }

  sendToBackend({ action: "command", command: commandToSend, quiet: options.quiet === true });
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
  sendCmd("play");
}

function applyPlaybackToggle(optionKey, enabled) {
  if (optionKey === "loop") {
    localPlayback.loop = enabled;
  } else if (optionKey === "single clip") {
    localPlayback.singleClip = enabled;
  }

  setCheckbox("playLoop", localPlayback.loop);
  setCheckbox("playSingleClip", localPlayback.singleClip);

  const status = getEffectiveTransportStatus();
  const boolText = enabled ? "true" : "false";
  if (status === "RECORD") {
    return;
  }

  if (status === "STOPPED" || status === "PREVIEW") {
    if (optionKey === "loop") {
      pendingPlaybackIntent.loop = enabled;
    } else if (optionKey === "single clip") {
      pendingPlaybackIntent.singleClip = enabled;
    }
    return;
  }

  if (optionKey === "loop") {
    pendingPlaybackIntent.loop = null;
  } else if (optionKey === "single clip") {
    pendingPlaybackIntent.singleClip = null;
  }

  const currentSpeed = getEffectiveTransportSpeed();
  if (status === "PLAY") {
    sendCmd(`play: ${optionKey}: ${boolText}`, { quiet: true });
  } else if (["SHUTTLE", "FORWARD", "REWIND"].includes(status)) {
    sendCmd(`play: ${optionKey}: ${boolText} speed: ${currentSpeed}`, { quiet: true });
  } else if (["STOPPED", "PREVIEW"].includes(status)) {
    sendCmd(`play: ${optionKey}: ${boolText} speed: 0`, { quiet: true });
  } else {
    sendCmd(`play: ${optionKey}: ${boolText}`, { quiet: true });
  }

  setTimeout(() => sendCmd("transport info", { quiet: true }), 180);
  setTimeout(() => sendCmd("transport info", { quiet: true }), 650);
}

function onPlayLoopToggleChange() {
  const enabled = getChecked("playLoop");
  applyPlaybackToggle("loop", enabled);
}

function onPlaySingleClipToggleChange() {
  const enabled = getChecked("playSingleClip");
  applyPlaybackToggle("single clip", enabled);
}

function syncLocalPlaybackFromState(state) {
  if (!state || state.is_connected !== true) {
    return;
  }

  // Preserve runtime toggle choices until the first transport info block arrives
  // for the current connection. This avoids resetting toggles to defaults during
  // initial connect/disconnect state transitions.
  if (!hasTransportStateHydratedForSession) {
    return;
  }

  const speed = Number.parseInt(state.transport_speed ?? 0, 10);
  if (Number.isFinite(speed)) {
    localPlayback.speed = speed;
  }
  localPlayback.status = String(state.transport_status || "").trim().toUpperCase();
}

function getEffectiveTransportStatus() {
  if (localPlayback.status) return localPlayback.status;
  return String(deviceState.transport_status || "").trim().toUpperCase();
}

function getEffectiveTransportSpeed() {
  if (Number.isFinite(localPlayback.speed)) return localPlayback.speed;
  const speed = Number.parseInt(deviceState.transport_speed ?? 0, 10);
  return Number.isFinite(speed) ? speed : 0;
}

function appendPlaybackOptionsToTransportCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return cmd;

  const normalized = cmd.toLowerCase();
  const isPlayCmd = normalized === "play" || normalized.startsWith("play:");
  const isShuttleCmd = normalized.startsWith("shuttle:");
  if (!isPlayCmd && !isShuttleCmd) {
    return cmd;
  }

  let out = cmd;
  const isBarePlay = isPlayCmd && /^play$/i.test(out);
  const desiredLoop = pendingPlaybackIntent.loop ?? localPlayback.loop;
  const desiredSingleClip = pendingPlaybackIntent.singleClip ?? localPlayback.singleClip;

  if (desiredLoop && !/\bloop\s*:/i.test(out)) {
    out = isBarePlay ? "play: loop: true" : `${out} loop: true`;
  }
  if (desiredSingleClip && !/\bsingle\s+clip\s*:/i.test(out)) {
    if (isBarePlay && out.toLowerCase() === "play") {
      out = "play: single clip: true";
    } else {
      out += " single clip: true";
    }
  }
  return out;
}

function rememberLocalTransportFromCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return;

  const loopMatch = cmd.match(/\bloop\s*:\s*(true|false)\b/i);
  if (loopMatch) {
    localPlayback.loop = loopMatch[1].toLowerCase() === "true";
    pendingPlaybackIntent.loop = null;
  }

  const singleClipMatch = cmd.match(/\bsingle\s+clip\s*:\s*(true|false)\b/i);
  if (singleClipMatch) {
    localPlayback.singleClip = singleClipMatch[1].toLowerCase() === "true";
    pendingPlaybackIntent.singleClip = null;
  }

  const speedMatch = cmd.match(/\bspeed\s*:\s*(-?\d+)\b/i);
  if (speedMatch) {
    const parsed = Number.parseInt(speedMatch[1], 10);
    if (Number.isFinite(parsed)) {
      localPlayback.speed = parsed;
    }
  }
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

/** Build and send a "clips get" command with optional response version. */
function applyClipsGet() {
  const opts = {};
  const version = document.getElementById("clipsGetVersion")?.value || "";
  if (version) opts.version = version;
  sendCmd(buildInlineCommand("clips get", opts));
}

/** Send "clips rebuild". The 519 snapshot response will automatically trigger a clips get. */
function applyClipsRebuild() {
  sendCmd("clips rebuild");
}

/** Build and send a "clip info" command. */
function applyClipInfo() {
  const clipId = document.getElementById("clipInfoId").value.trim();
  const name   = document.getElementById("clipInfoName").value.trim();
  pendingManualClipInfoRequest = true;
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
function applyClipAddFromIds(ids) {
  const name = document.getElementById(ids.name)?.value.trim() || "";
  const beforeId = document.getElementById(ids.beforeId)?.value.trim() || "";
  const inTc = document.getElementById(ids.inTc)?.value.trim() || "";
  const outTc = document.getElementById(ids.outTc)?.value.trim() || "";
  const frameIn = document.getElementById(ids.frameIn)?.value.trim() || "";
  const frameOut = document.getElementById(ids.frameOut)?.value.trim() || "";

  if (!name) { showToast("Clip name is required", "error"); return; }

  const opts = { name };
  if (beforeId)        opts["clip id"] = beforeId;
  if (inTc && outTc)   { opts.in = inTc; opts.out = outTc; }
  else if (frameIn && frameOut) { opts["frame in"] = frameIn; opts["frame out"] = frameOut; }

  sendCmd(buildInlineCommand("clips add", opts));
}

function applyClipAdd() {
  applyClipAddFromIds({
    name: "clipAddName",
    beforeId: "clipAddBeforeId",
    inTc: "clipAddInTc",
    outTc: "clipAddOutTc",
    frameIn: "clipAddFrameIn",
    frameOut: "clipAddFrameOut",
  });
}

function applyClipAddSlots() {
  applyClipAddFromIds({
    name: "slotClipAddName",
    beforeId: "slotClipAddBeforeId",
    inTc: "slotClipAddInTc",
    outTc: "slotClipAddOutTc",
    frameIn: "slotClipAddFrameIn",
    frameOut: "slotClipAddFrameOut",
  });
}

/** Ask for confirmation then send "clips clear". */
function confirmClipsClear() {
  if (confirm("Clear the entire timeline? This cannot be undone.")) {
    sendCmd("clips clear");
  }
}

/** Build and send a "record" command with optional clip name. */
function applyRecord() {
  if (hasNoInputCondition(deviceState)) {
    triggerNoInputSourceLookup();
    return;
  }

  lastRecordAttemptAtMs = Date.now();
  const name = document.getElementById("recordName").value.trim();
  sendCmd(name ? `record: name: ${name}` : "record");
}

/** Build and send a "record spill" command with optional slot id. */
function applyRecordSpill() {
  const slotId = document.getElementById("spillSlotId").value.trim();
  sendCmd(slotId ? `record spill: slot id: ${slotId}` : "record spill");
}

function applySpillOrderQuery() {
  pendingSpillOrderQuery = true;
  const el = document.getElementById("spillOrderResult");
  if (el) {
    el.hidden = false;
    el.textContent = "Querying spill order...";
  }
  sendCmd("spill order", { quiet: true });
}

function looksLikeV2ClipEntry(data) {
  const fields = String(data || "").trim().split(/\s+/);
  const looksLikeTimecode = (value) => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(String(value || "").trim());

  return fields.length >= 5
    && looksLikeTimecode(fields[0])
    && looksLikeTimecode(fields[1])
    && looksLikeTimecode(fields[2])
    && looksLikeTimecode(fields[3]);
}

function parseTimelineClipEntry(data, isV2) {
  const fields = String(data || "").trim().split(/\s+/).filter(Boolean);
  const looksLikeTimecode = (value) => /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(String(value || "").trim());

  if (isV2) {
    return {
      name: fields.slice(4).join(" ") || "—",
      startTc: fields[0] || "",
      duration: fields[1] || "—",
      inTc: fields[2] || "",
      outTc: fields[3] || "",
    };
  }

  // v1: {name} {startTC} {durationTC}. Name may contain spaces, so parse fixed
  // timecode fields from the right edge of the row.
  if (
    fields.length >= 3
    && looksLikeTimecode(fields[fields.length - 2])
    && looksLikeTimecode(fields[fields.length - 1])
  ) {
    return {
      name: fields.slice(0, -2).join(" ") || "—",
      startTc: fields[fields.length - 2],
      duration: fields[fields.length - 1],
      inTc: "",
      outTc: "",
    };
  }

  return {
    name: fields[0] || "—",
    startTc: fields[1] || "—",
    duration: fields[2] || "—",
    inTc: "",
    outTc: "",
  };
}

function parseClipId(value) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function updateTransportClipNameIndicator(state = deviceState) {
  const clipNameEl = document.getElementById("dashClipName");
  if (!clipNameEl) return;

  if (!state || state.is_connected !== true) {
    setText("dashClipName", "—");
    return;
  }

  const clipId = parseClipId(state.transport_clip_id);
  if (clipId === null) {
    setText("dashClipName", "—");
    return;
  }

  const clipName = timelineClipNameById.get(clipId) || slotMediaClipNameById.get(clipId) || "";
  setText("dashClipName", clipName || "—");
}

function normalizeTimelineClipInfoValue(value) {
  const text = String(value || "").trim();
  return text || "";
}

// There should be at most one active timeout for the in-flight clip-info
// request. Clearing first avoids orphaned timers that could corrupt queue state.
function clearSlotMediaClipInfoInFlightTimeout() {
  if (slotMediaClipInfoInFlightTimeoutId !== null) {
    clearTimeout(slotMediaClipInfoInFlightTimeoutId);
    slotMediaClipInfoInFlightTimeoutId = null;
  }
}

// HyperDeck field names vary by firmware, so we probe several keys and return
// the first non-empty value.
function getFirstClipInfoValue(kv, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(kv, key)) {
      continue;
    }
    const value = normalizeTimelineClipInfoValue(kv[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

// Build the list of visible clip names from the latest disk list snapshot.
// We reuse this in multiple places so progress math is always based on the
// same source of truth as the table rows.
function getCurrentSlotMediaNamesFromLastKv() {
  if (!lastSlotMediaKv || typeof lastSlotMediaKv !== "object") {
    return [];
  }
  return Object.entries(lastSlotMediaKv)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10))
    .map(([, data]) => parseDiskListEntry(data).name)
    .filter((name) => name && name !== "—");
}

// Update the small badge next to "Current Slot Media".
// Yellow means "still loading some sizes" and green means "all loaded".
function updateCurrentSlotMediaProgressBadge() {
  const badge = document.getElementById("currentSlotMediaProgressBadge");
  if (!badge) {
    return;
  }

  const names = getCurrentSlotMediaNamesFromLastKv();
  const total = names.length;
  if (total === 0) {
    badge.style.display = "none";
    return;
  }

  let loaded = 0;
  for (const name of names) {
    const fileSize = String(slotMediaClipInfoByName.get(name)?.fileSize || "").trim();
    if (fileSize) {
      loaded += 1;
    }
  }

  const pending = total - loaded;
  badge.textContent = `Sizes ${loaded}/${total}`;
  badge.style.display = "inline-block";
  badge.style.background = pending > 0 ? "var(--accent-yellow)" : "var(--accent-green)";
  badge.style.color = pending > 0 ? "#111" : "#fff";
}

// Consume one clip info response and fold it into cache.
// Called only from handleParsedResponse(default), which isolates us from
// explicit response codes like 208 transport info.
function maybeHandleClipInfoResponse(kv, fallbackName = null) {
  // Only called from the default: branch — not reached by any explicitly-handled
  // response code (208, 206, etc.), so this is safely scoped to clip info replies.
  if (!kv || typeof kv !== "object") {
    return false;
  }

  // Match by the name field the deck echoes back, or fall back to what we sent.
  const clipName = String(kv.name || kv["clip name"] || fallbackName || "").trim();
  if (!clipName) {
    return false;
  }

  const fileSize = getFirstClipInfoValue(kv, ["file size", "clip size", "size", "size bytes"]);

  const previous = slotMediaClipInfoByName.get(clipName) || { fileSize: "" };
  const next = {
    fileSize: fileSize || previous.fileSize,
  };

  slotMediaClipInfoByName.set(clipName, next);
  slotMediaPendingByName.delete(clipName);
  updateCurrentSlotMediaProgressBadge();

  const changed = previous.fileSize !== next.fileSize;
  if (changed && lastSlotMediaKv) {
    renderCurrentSlotMediaTable(lastSlotMediaKv);
  }

  return true;
}

// Keep cache/queue state aligned with the currently visible disk list rows.
// If the slot changes or rows disappear, stale queue items are removed so we
// do not keep requesting file sizes for clips that are no longer on screen.
function syncSlotMediaClipInfoCache(names) {
  const normalizedNames = Array.from(new Set((names || [])
    .map((n) => String(n || "").trim())
    .filter(Boolean)));
  const nextKey = normalizedNames.join("\x00");
  if (nextKey === lastSlotMediaNamesKey) {
    return;
  }

  lastSlotMediaNamesKey = nextKey;
  const nameSet = new Set(normalizedNames);

  for (const name of slotMediaClipInfoByName.keys()) {
    if (!nameSet.has(name)) {
      slotMediaClipInfoByName.delete(name);
    }
  }
  for (const name of slotMediaPendingByName) {
    if (!nameSet.has(name)) {
      slotMediaPendingByName.delete(name);
    }
  }

  for (let i = queuedSlotMediaClipNames.length - 1; i >= 0; i -= 1) {
    if (!nameSet.has(queuedSlotMediaClipNames[i])) {
      queuedSlotMediaClipNames.splice(i, 1);
    }
  }

  if (slotMediaClipInfoInFlightName !== null && !nameSet.has(slotMediaClipInfoInFlightName)) {
    slotMediaClipInfoInFlightName = null;
    clearSlotMediaClipInfoInFlightTimeout();
  }

  updateCurrentSlotMediaProgressBadge();
}

// Queue runner: sends exactly one clip-info command at a time.
// We only send the next request after success, timeout, or error clears the
// in-flight slot. This prevents overrunning the deck with parallel requests.
function pumpSlotMediaClipInfoRequests() {
  if (!isSocketOpen() || slotMediaClipInfoInFlightName !== null) {
    return;
  }

  const nextName = queuedSlotMediaClipNames.shift();
  if (typeof nextName !== "string" || !nextName) {
    return;
  }

  slotMediaClipInfoInFlightName = nextName;
  updateCurrentSlotMediaProgressBadge();
  clearSlotMediaClipInfoInFlightTimeout();
  slotMediaClipInfoInFlightTimeoutId = setTimeout(() => {
    if (slotMediaClipInfoInFlightName === null) {
      return;
    }
    slotMediaPendingByName.delete(slotMediaClipInfoInFlightName);
    slotMediaClipInfoInFlightName = null;
    slotMediaClipInfoInFlightTimeoutId = null;
    updateCurrentSlotMediaProgressBadge();
    pumpSlotMediaClipInfoRequests();
  }, SLOT_MEDIA_CLIP_INFO_RESPONSE_TIMEOUT_MS);

  sendCmd(`clip info: name: ${nextName}`, { quiet: true });
}

// Public enqueue function used by renderCurrentSlotMediaTable.
// It deduplicates names against both cache and pending set, then starts the
// queue runner if idle.
function requestSlotMediaClipInfo(names) {
  if (!isSocketOpen()) {
    return;
  }

  for (const name of names || []) {
    const n = String(name || "").trim();
    if (!n) {
      continue;
    }
    if (slotMediaClipInfoByName.has(n) || slotMediaPendingByName.has(n)) {
      continue;
    }

    slotMediaPendingByName.add(n);
    queuedSlotMediaClipNames.push(n);
  }

  updateCurrentSlotMediaProgressBadge();
  pumpSlotMediaClipInfoRequests();
}

/**
 * Render the clips table from a 205 / 519 clips info response.
 * kv keys are clip IDs (integers); values are space-separated fields.
 *
 * Protocol version 1 (default): "id: {name} {startTC} {duration}"
 * Protocol version 2: "id: {clipStartTC} {clipDuration} {inTC} {outTC} {path}"
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

  // Some decks return 519 rebuild snapshots in v2-style regardless of the selected dropdown.
  // Trust the payload shape first; only fall back to the dropdown when there are no rows to inspect.
  const selectedVersion = document.getElementById("clipsGetVersion")?.value || "";
  const requestedV2 = selectedVersion === "2" || selectedVersion === "3";
  const payloadLooksV2 = clipEntries.some(([, data]) => looksLikeV2ClipEntry(data));
  const isV2 = payloadLooksV2 || (clipEntries.length === 0 && requestedV2);
  const table = document.getElementById("clipsTable");
  if (table) {
    table.classList.toggle("clip-table--v1", !isV2);
    table.classList.toggle("clip-table--v2", isV2);
  }
  const colSpan = isV2 ? 7 : 8; // includes left Play + right Remove columns

  if (clipEntries.length === 0) {
    timelineClipNameById = new Map();
    updateTransportClipNameIndicator();
    tbody.innerHTML = `<tr><td colspan="${colSpan}" style="color:var(--text-muted);text-align:center;padding:10px">
      Timeline is empty (107).</td></tr>`;
    return;
  }

  const activeClipId = deviceState.transport_clip_id
    ? parseInt(deviceState.transport_clip_id, 10)
    : -1;
  const clipIdOffset = clipEntries.some(([idx]) => String(idx).trim() === "0") ? 1 : 0;
  const timelineClipIds = clipEntries
    .map(([idx]) => parseInt(idx, 10) + clipIdOffset)
    .filter((clipId) => Number.isInteger(clipId));

  const nextTimelineClipNameById = new Map();
  for (const [idx, data] of clipEntries) {
    const clipId = parseInt(idx, 10) + clipIdOffset;
    if (!Number.isInteger(clipId)) continue;
    const { name } = parseTimelineClipEntry(data, isV2);
    if (name && name !== "—") {
      nextTimelineClipNameById.set(clipId, name);
    }
  }
  timelineClipNameById = nextTimelineClipNameById;

  tbody.innerHTML = clipEntries.map(([idx, data]) => {
    const clipId = parseInt(idx, 10) + clipIdOffset;
    const { name, startTc, duration, inTc, outTc } = parseTimelineClipEntry(data, isV2);

    const isActive = (clipId === activeClipId);
    const rowClass = isActive ? "clip--active" : "";

    return `<tr class="${rowClass}">
      <td class="clip-actions">
        <button class="btn btn--xs btn--play-icon" data-action="playTimelineClip(${clipId})" title="Play this clip"> </button>
      </td>
      <td>${clipId}</td>
      <td class="clip-name" title="${escapeHtml(name)}">${escapeHtml(name)}</td>
      <td>${escapeHtml(startTc)}</td>
      <td>${escapeHtml(duration)}</td>
      <td>${escapeHtml(inTc)}</td>
      <td>${escapeHtml(outTc)}</td>
      <td class="clip-actions">
        <button class="btn btn--xs btn--danger" data-action="removeClip(${clipId})" title="Remove from timeline">✕</button>
      </td>
    </tr>`;
  }).join("");

  // Single-click a timeline row to cue that clip.
  for (const row of tbody.querySelectorAll("tr")) {
    const idCell = row.querySelector("td:nth-child(2)");
    if (!idCell) continue;
    const clipId = parseInt(String(idCell.textContent || "").trim(), 10);
    if (!Number.isInteger(clipId)) continue;
    row.title = "Click to cue this clip";
    row.addEventListener("click", (event) => {
      if (event.target && event.target.closest("button")) return;
      gotoClip(clipId);
    });
  }
}

function parseDiskListEntry(data) {
  const raw = String(data || "").trim();
  const fields = raw.split(/\s+/).filter(Boolean);
  const looksLikeDuration = (value) => /^(\d+|\d{2}:\d{2}:\d{2}:\d{2})$/.test(String(value || ""));

  if (fields.length < 4) {
    return {
      name: raw || "—",
      fileFormat: "—",
      format: "—",
      duration: "—",
    };
  }

  // Version 2 style: file format, video format, duration, then name
  if (looksLikeDuration(fields[2])) {
    return {
      name: fields.slice(3).join(" ") || "—",
      fileFormat: fields[0] || "—",
      format: fields[1] || "—",
      duration: fields[2] || "—",
    };
  }

  // Version 1 style: name, file format, video format, duration
  // Name may include spaces, so parse fixed fields from the right.
  return {
    name: fields.slice(0, -3).join(" ") || "—",
    fileFormat: fields[fields.length - 3] || "—",
    format: fields[fields.length - 2] || "—",
    duration: fields[fields.length - 1] || "—",
  };
}

/**
 * Render current slot media rows from a 206/520 disk list payload.
 * Architecture summary for students:
 * - First pass: render table immediately from disk list so UI feels instant.
 * - Second pass: enqueue per-row clip info requests by clip name.
 * - As responses arrive, maybeHandleClipInfoResponse updates cache and re-renders
 *   only to fill in file size values.
 */
function renderCurrentSlotMediaTable(kv) {
  const tbody = document.getElementById("currentSlotMediaTableBody");
  if (!tbody) return;

  lastSlotMediaKv = kv;

  const mediaEntries = Object.entries(kv)
    .filter(([key]) => /^\d+$/.test(key))
    .sort(([a], [b]) => parseInt(a, 10) - parseInt(b, 10));

  if (mediaEntries.length === 0) {
    slotMediaClipNameById = new Map();
    updateTransportClipNameIndicator();
    syncSlotMediaClipInfoCache([]);
    tbody.innerHTML = `<tr><td colspan="6" class="table-cell-empty">
      No media entries returned for current slot.</td></tr>`;
    return;
  }

  const mediaNames = mediaEntries.map(([, data]) => parseDiskListEntry(data).name).filter((n) => n && n !== "—");
  syncSlotMediaClipInfoCache(mediaNames);

  const nextSlotMediaClipNameById = new Map();
  for (const [idx, data] of mediaEntries) {
    const clipId = parseInt(idx, 10);
    if (!Number.isInteger(clipId)) continue;
    const parsed = parseDiskListEntry(data);
    if (parsed.name && parsed.name !== "—") {
      nextSlotMediaClipNameById.set(clipId, parsed.name);
    }
  }
  slotMediaClipNameById = nextSlotMediaClipNameById;

  tbody.innerHTML = mediaEntries.map(([idx, data]) => {
    const parsed = parseDiskListEntry(data);
    const clipInfo = slotMediaClipInfoByName.get(parsed.name) || {};
    const fileSize = clipInfo.fileSize || (slotMediaPendingByName.has(parsed.name) ? "..." : "—");
    return `<tr>
      <td>${escapeHtml(idx)}</td>
      <td class="clip-name" title="${escapeHtml(parsed.name)}">${escapeHtml(parsed.name)}</td>
      <td>${escapeHtml(parsed.fileFormat)}</td>
      <td>${escapeHtml(parsed.format)}</td>
      <td>${escapeHtml(parsed.duration)}</td>
      <td>${escapeHtml(fileSize)}</td>
    </tr>`;
  }).join("");

  // Double-click any media row to append that clip to the timeline.
  for (const row of tbody.querySelectorAll("tr")) {
    const nameCell = row.querySelector("td:nth-child(2)");
    if (!nameCell) continue;
    const clipName = String(nameCell.textContent || "").trim();
    if (!clipName || clipName === "—") continue;
    row.title = "Double-click to append this clip to timeline";
    row.addEventListener("dblclick", () => appendCurrentSlotMediaClipToTimeline(clipName));
  }

  updateTransportClipNameIndicator();
  requestSlotMediaClipInfo(mediaNames);
}

function maybeRenderCurrentSlotMediaTable(kv) {
  const responseSlotId = normalizeDisplayNone(kv["slot id"]);
  const activeSlotId = normalizeDisplayNone(deviceState.transport_slot_id);

  if (activeSlotId) {
    // Keep Current Slot Media bound to active slot only; ignore background
    // disk notifications for non-active slots.
    if (!responseSlotId || responseSlotId === activeSlotId) {
      renderCurrentSlotMediaTable(kv);
    }
    return;
  }

  if (isDisplayNoneToken(deviceState.transport_slot_id)) {
    if (!responseSlotId || isDisplayNoneToken(responseSlotId)) {
      renderCurrentSlotMediaTable(kv);
    }
  }
}

function loadCurrentSlotMedia() {
  sendCmd("disk list");
}

function appendCurrentSlotMediaClipToTimeline(clipName) {
  const name = String(clipName || "").trim();
  if (!name || name === "—") return;
  sendCmd(buildInlineCommand("clips add", { name }));
  showToast(`Appended ${name} to timeline`, "ok");
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

/** Play a specific timeline clip in single-clip mode. */
function playTimelineClip(clipId) {
  if (!Number.isInteger(clipId)) return;
  sendCmd(`play: clip id: ${clipId} single clip: true`);
}

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
 * Always targets the current active slot and optionally applies video format.
 */
function applySlotSelect() {
  const activeSlotId = normalizeDisplayNone(deviceState.transport_slot_id);
  const vidFormat = document.getElementById("slotSelectVidFmt").value.trim();

  if (!activeSlotId || isDisplayNoneToken(activeSlotId)) {
    showToast("No active slot is available", "error");
    return;
  }

  const opts = {};
  opts["slot id"] = String(activeSlotId).trim();
  if (vidFormat) opts["video format"] = vidFormat;

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
  // Prevent unbounded growth of command history over long sessions
  if (commandHistory.length > 100) {
    commandHistory.pop();
  }
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
  while (out.childElementCount > MAX_CONSOLE_LINES) {
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
    if (isSocketOpen()) {
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

function syncTransportAutoRefresh(state = deviceState) {
  if (shouldAutoRefreshTransport(state)) {
    startTransportAutoRefresh();
    requestTransportRefresh();
    return;
  }

  stopTransportAutoRefresh();
}

function shouldAutoRefreshTransport(state = deviceState) {
  const status = String(state.transport_status || "").toUpperCase();
  const speed = Number.parseInt(state.transport_speed ?? 0, 10);

  // Requirement: never poll transport info continuously while STOPPED.
  if (status === "STOPPED") {
    transportRefreshArmedByCommand = false;
    transportTransitionDeadlineMs = 0;
    return false;
  }

  const inTransitionWindow =
    transportRefreshArmedByCommand && Date.now() < transportTransitionDeadlineMs;

  if (status === "RECORD") {
    return true;
  }

  if (Number.isFinite(speed) && speed !== 0) {
    return true;
  }

  return inTransitionWindow;
}

function startTransportAutoRefresh() {
  if (transportRefreshIntervalId !== null) {
    return;
  }

  transportRefreshIntervalId = setInterval(() => {
    if (shouldAutoRefreshTransport()) {
      requestTransportRefresh();
      return;
    }

    stopTransportAutoRefresh();
  }, TRANSPORT_REFRESH_INTERVAL_MS);
}

function stopTransportAutoRefresh() {
  if (transportRefreshIntervalId !== null) {
    clearInterval(transportRefreshIntervalId);
    transportRefreshIntervalId = null;
  }

  if (stoppedNotifyRefreshTimeoutId !== null) {
    clearTimeout(stoppedNotifyRefreshTimeoutId);
    stoppedNotifyRefreshTimeoutId = null;
  }

  transportRefreshArmedByCommand = false;
  transportTransitionDeadlineMs = 0;
  clearTransportRefreshInFlight();
}

function queueStoppedNotifyTransportRefresh() {
  if (!isSocketOpen()) {
    return;
  }

  if (stoppedNotifyRefreshTimeoutId !== null) {
    clearTimeout(stoppedNotifyRefreshTimeoutId);
  }

  stoppedNotifyRefreshTimeoutId = setTimeout(() => {
    stoppedNotifyRefreshTimeoutId = null;
    requestTransportRefresh();
  }, STOPPED_NOTIFY_REFRESH_DELAY_MS);
}

function requestTransportRefresh() {
  if (!isSocketOpen() || transportRefreshInFlight) {
    return;
  }

  transportRefreshInFlight = true;
  clearTimeout(transportRefreshTimeoutId);
  transportRefreshTimeoutId = setTimeout(() => {
    transportRefreshInFlight = false;
    transportRefreshTimeoutId = null;
  }, TRANSPORT_REFRESH_TIMEOUT_MS);

  sendCmd("transport info", { quiet: true });
}

function clearTransportRefreshInFlight() {
  transportRefreshInFlight = false;
  if (transportRefreshTimeoutId !== null) {
    clearTimeout(transportRefreshTimeoutId);
    transportRefreshTimeoutId = null;
  }
}

function armTransportRefreshWindow(command) {
  if (!shouldArmTransportRefreshFromCommand(command)) {
    return;
  }

  transportRefreshArmedByCommand = true;
  transportTransitionDeadlineMs = Date.now() + TRANSPORT_TRANSITION_WINDOW_MS;
  startTransportAutoRefresh();
  requestTransportRefresh();
}

function shouldArmTransportRefreshFromCommand(command) {
  const normalized = String(command || "").trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  const nonTransportCommands = [
    "ping",
    "help",
    "notify",
    "device info",
    "remote",
    "configuration",
    "commands",
    "uptime",
    "identify",
    "watchdog",
    "quit",
    "reboot",
  ];

  return !nonTransportCommands.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix}:`)
  );
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

  if (tabName === "clips" && deviceState.is_connected === true) {
    if (lastTimelineClipsKv) {
      renderClipsTable(lastTimelineClipsKv);
    }
    applyClipsGet();
  }

  if (tabName === "slots" && deviceState.is_connected === true) {
    loadAllSlotStates();
    loadCurrentSlotMedia();
  }
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
    .map(([k, v]) => `<span class="rk">${escapeHtml(k)}:</span> <span class="rv">${escapeHtml(v)}</span>`)
    .join("\n");
}

function displayResultBoxFromPayload(elementId, kv, rawText = "") {
  if (kv && Object.keys(kv).length > 0) {
    displayResultBox(elementId, kv);
    return;
  }

  const el = document.getElementById(elementId);
  if (!el) return;
  const text = String(rawText || "").trim();
  if (!text) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  el.innerHTML = `<span class="rv">${escapeHtml(text).replace(/\n/g, "<br>")}</span>`;
}

/** Set the textContent of an element by ID. */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function resetDisconnectedTransportUI(tsPlayRangeRowEl = null) {
  // Why centralized reset matters:
  // The disconnected visual state is used in multiple flows. Keeping this logic
  // in one helper prevents drift where one path updates more elements than
  // another.
  setText("tsStatus", "—");
  const tsStatusEl = document.getElementById("tsStatus");
  if (tsStatusEl) tsStatusEl.className = "status-badge stopped";

  setText("tsFormat", "—");
  const tsFormatEl = document.getElementById("tsFormat");
  if (tsFormatEl) tsFormatEl.className = "status-badge stopped";

  const rowEl = tsPlayRangeRowEl || document.getElementById("tsPlayRangeRow");
  if (rowEl) {
    rowEl.hidden = true;
  }

  syncTransportActionButtons({ is_connected: false });
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

function normalizeDisplayNone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "null" || lower === "n/a") return "";
  return raw;
}

function isDisplayNoneToken(value) {
  return String(value || "").trim().toLowerCase() === "none";
}

function formatSlotIdDisplay(value) {
  const normalized = normalizeDisplayNone(value);
  if (!normalized) return "—";
  if (isDisplayNoneToken(normalized)) return "None";
  return normalized;
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
  const id = normalizeDisplayNone(state.transport_slot_id);
  const slotName = normalizeDisplayNone(state.transport_slot_name);
  const deviceName = normalizeDisplayNone(state.transport_device_name);

  const normalizedSlotName = slotName.toLowerCase();
  const normalizedDeviceName = deviceName.toLowerCase();
  const shouldAppendDevice =
    deviceName && normalizedDeviceName !== normalizedSlotName;

  let label = formatSlotIdDisplay(id);
  if (label === "—") {
    label = "";
  }
  if (slotName) {
    label = label ? `${label} - ${slotName}` : slotName;
  }
  if (shouldAppendDevice) {
    label = label ? `${label} - ${deviceName}` : deviceName;
  }

  return label || "—";
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

function loadUiPreferences() {
  try {
    const raw = localStorage.getItem(UI_PREFERENCES_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.showDynamicRangeInTransportInfo === "boolean") {
      uiPreferences.showDynamicRangeInTransportInfo = parsed.showDynamicRangeInTransportInfo;
    }
    if (typeof parsed.showTransportJog === "boolean") {
      uiPreferences.showTransportJog = parsed.showTransportJog;
    }
    if (typeof parsed.showTransportShuttle === "boolean") {
      uiPreferences.showTransportShuttle = parsed.showTransportShuttle;
    }
    if (typeof parsed.showTransportGoto === "boolean") {
      uiPreferences.showTransportGoto = parsed.showTransportGoto;
    }
    if (typeof parsed.showTransportPlayRange === "boolean") {
      uiPreferences.showTransportPlayRange = parsed.showTransportPlayRange;
    }
  } catch {
    // Ignore malformed local storage content and use defaults.
  }
}

function saveUiPreferences() {
  try {
    localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify(uiPreferences));
  } catch {
    // Ignore local storage write failures.
  }
}

function applyUiPreferencesToUI() {
  const showDynamicRange = uiPreferences.showDynamicRangeInTransportInfo !== false;
  const showTransportJog = uiPreferences.showTransportJog !== false;
  const showTransportShuttle = uiPreferences.showTransportShuttle !== false;
  const showTransportGoto = uiPreferences.showTransportGoto !== false;
  const showTransportPlayRange = uiPreferences.showTransportPlayRange !== false;

  const dynRangeCell = document.getElementById("dashDynRangeCell");
  const jogCard = document.getElementById("transportJogCard");
  const shuttleCard = document.getElementById("transportShuttleCard");
  const gotoCard = document.getElementById("transportGotoCard");
  const playRangeCard = document.getElementById("transportPlayRangeCard");

  if (dynRangeCell) {
    dynRangeCell.hidden = !showDynamicRange;
  }
  if (jogCard) {
    jogCard.hidden = !showTransportJog;
  }
  if (shuttleCard) {
    shuttleCard.hidden = !showTransportShuttle;
  }
  if (gotoCard) {
    gotoCard.hidden = !showTransportGoto;
  }
  if (playRangeCard) {
    playRangeCard.hidden = !showTransportPlayRange;
  }

  setCheckbox("cfgShowDynRange", showDynamicRange);
  setCheckbox("cfgShowTransportJog", showTransportJog);
  setCheckbox("cfgShowTransportShuttle", showTransportShuttle);
  setCheckbox("cfgShowTransportGoto", showTransportGoto);
  setCheckbox("cfgShowTransportPlayRange", showTransportPlayRange);
}

function onCfgShowDynRangeToggleChange() {
  uiPreferences.showDynamicRangeInTransportInfo = getChecked("cfgShowDynRange");
  saveUiPreferences();
  applyUiPreferencesToUI();
}

function onCfgShowTransportSectionsToggleChange() {
  uiPreferences.showTransportJog = getChecked("cfgShowTransportJog");
  uiPreferences.showTransportShuttle = getChecked("cfgShowTransportShuttle");
  uiPreferences.showTransportGoto = getChecked("cfgShowTransportGoto");
  uiPreferences.showTransportPlayRange = getChecked("cfgShowTransportPlayRange");
  saveUiPreferences();
  applyUiPreferencesToUI();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initResizableTable(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;

  const headCells = Array.from(table.querySelectorAll("thead th"));
  if (headCells.length === 0) return;

  headCells.forEach((th) => {
    if (th.querySelector(".col-resize-handle")) return;

    const handle = document.createElement("span");
    handle.className = "col-resize-handle";
    handle.title = "Drag to resize column";
    th.appendChild(handle);

    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = th.getBoundingClientRect().width;
      const minWidth = 72;

      const onMouseMove = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        const nextWidth = Math.max(minWidth, startWidth + delta);
        th.style.width = `${Math.round(nextWidth)}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
      };

      document.body.style.cursor = "col-resize";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

const DECLARATIVE_ACTION_FUNCTIONS = new Set([
  // Security and predictability note:
  // We intentionally allow only known functions from HTML data-action strings.
  // This avoids using eval and prevents arbitrary code execution from markup.
  "addConnectionProfileFromForm",
  "applyAuthenticate",
  "applyClipAdd",
  "applyClipAddSlots",
  "applyClipInfo",
  "applyClipsGet",
  "applyClipsRebuild",
  "applyConfiguration",
  "applyConnectionProtocol",
  "applyDiskList",
  "applyDynamicRange",
  "applyExtDriveSelect",
  "applyFormatConfirm",
  "applyFormatPrepare",
  "applyGoto",
  "applyIdentify",
  "applyJog",
  "applyNasAdd",
  "applyNasRemove",
  "applyNasSelect",
  "applyPlay",
  "applyPlayOnStartup",
  "applyPlayOption",
  "applyPlayrangeSet",
  "applyPreview",
  "applyRecord",
  "applyRecordSpill",
  "applySpillOrderQuery",
  "applyRemote",
  "applyShuttle",
  "applyShuttlePreset",
  "applySlateClips",
  "applySlateLens",
  "applySlateProject",
  "applySlotInfo",
  "applySlotSelect",
  "applySlotUnblock",
  "applyWatchdog",
  "clearConsole",
  "confirmClipsClear",
  "confirmReboot",
  "onSidebarRemoteIndicatorClick",
  "onSidebarTimecodeClick",
  "onTopbarStatusClick",
  "playTimelineClip",
  "removeClip",
  "sendCmd",
  "sendConsoleCommand",
  "sendRawCommand",
  "toggleDashboardOverride",
  "toggleDashboardRemote",
  "uiConnect",
  "updateGotoHint",
]);

function splitActionArguments(argsText) {
  // Tiny parser for comma-separated function arguments while respecting quoted
  // strings. This lets us support expressions like:
  //   sendCmd('goto: clip id: +1')
  // without needing a full JavaScript parser.
  const args = [];
  let current = "";
  let quote = "";

  for (let i = 0; i < argsText.length; i += 1) {
    const ch = argsText[i];

    if (quote) {
      current += ch;
      if (ch === quote && argsText[i - 1] !== "\\") {
        quote = "";
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === ",") {
      args.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim() !== "") {
    args.push(current.trim());
  }

  return args;
}

function parseActionArgument(token, event) {
  // Convert textual tokens from HTML attributes into runtime values.
  // Example: "true" -> true, "42" -> 42, "event" -> click event object.
  if (token === "event") {
    return event;
  }

  if (token === "true") {
    return true;
  }
  if (token === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(token)) {
    return Number(token);
  }

  if (
    (token.startsWith("\"") && token.endsWith("\"")) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    const unquoted = token.slice(1, -1);
    return unquoted
      .replace(/\\'/g, "'")
      .replace(/\\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  return token;
}

function runDeclarativeAction(expression, event) {
  // Parses "functionName(arg1, arg2)" from data-action/data-change and calls the
  // real function if it is allowlisted.
  //
  // Beginner takeaway:
  // Centralized dispatch gives a clear place to validate and instrument UI
  // actions, which is easier to maintain than many scattered inline handlers.
  const text = String(expression || "").trim();
  if (!text) {
    return;
  }

  const match = text.match(/^([A-Za-z_$][\w$]*)\((.*)\)$/);
  if (!match) {
    consoleLog(`[Action] Invalid expression: ${text}`, "cl--error");
    return;
  }

  const functionName = match[1];
  if (!DECLARATIVE_ACTION_FUNCTIONS.has(functionName)) {
    consoleLog(`[Action] Unsupported function: ${functionName}`, "cl--error");
    return;
  }

  const fn = globalThis[functionName];
  if (typeof fn !== "function") {
    consoleLog(`[Action] Missing function: ${functionName}`, "cl--error");
    return;
  }

  const argsSource = match[2].trim();
  const args = argsSource
    ? splitActionArguments(argsSource).map((token) => parseActionArgument(token, event))
    : [];

  fn(...args);
}

function attachDeclarativeEventHandlers() {
  // Event delegation:
  // We listen once at document level and react to matching elements via
  // closest(). This scales better than wiring hundreds of individual listeners,
  // including elements that are rendered later.
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("[data-action]")
      : null;
    if (!target) {
      return;
    }

    runDeclarativeAction(target.getAttribute("data-action"), event);
  });

  document.addEventListener("change", (event) => {
    const target = event.target instanceof Element
      ? event.target.closest("[data-change]")
      : null;
    if (!target) {
      return;
    }

    runDeclarativeAction(target.getAttribute("data-change"), event);
  });
}

// ============================================================
// SECTION: Initialisation
// ============================================================

/** Wire up all tabs, attach Enter key to connection form, and auto-open WebSocket. */
function initUI() {
  loadUiPreferences();
  // Register delegated handler system before user interactions begin.
  attachDeclarativeEventHandlers();

  // Tab navigation
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });

  // Goto hint initialisation
  updateGotoHint();

  document.getElementById("connProfileName")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addConnectionProfileFromForm();
  });

  document.getElementById("connProfileHost")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addConnectionProfileFromForm();
  });

  document.getElementById("playLoop")?.addEventListener("change", onPlayLoopToggleChange);
  document.getElementById("playSingleClip")?.addEventListener("change", onPlaySingleClipToggleChange);
  document.getElementById("cfgShowDynRange")?.addEventListener("change", onCfgShowDynRangeToggleChange);
  document.getElementById("cfgShowTransportJog")?.addEventListener("change", onCfgShowTransportSectionsToggleChange);
  document.getElementById("cfgShowTransportShuttle")?.addEventListener("change", onCfgShowTransportSectionsToggleChange);
  document.getElementById("cfgShowTransportGoto")?.addEventListener("change", onCfgShowTransportSectionsToggleChange);
  document.getElementById("cfgShowTransportPlayRange")?.addEventListener("change", onCfgShowTransportSectionsToggleChange);
  document.getElementById("tsPlayRange")?.addEventListener("click", jumpToPlayRangeSection);
  document.getElementById("playbackPlayRangeSetBadge")?.addEventListener("click", jumpToPlayRangeSection);

  initResizableTable("clipsTable");
  initResizableTable("currentSlotMediaTable");

  applyUiPreferencesToUI();

  document.getElementById("connProfilePort")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addConnectionProfileFromForm();
  });

  // Enter key in raw command field on Advanced tab
  document.getElementById("rawCmd")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendRawCommand();
  });

  // Open the WebSocket to the backend immediately on page load.
  // The actual HyperDeck TCP connection is initiated by the user via Connect.
  openWebSocket();
  loadConnectionProfiles();

  consoleLog("HyperDeck Vibe ready. Enter the device IP address and click Connect.", "cl--connect");
}

// Bootstrap when DOM is ready
document.addEventListener("DOMContentLoaded", initUI);
