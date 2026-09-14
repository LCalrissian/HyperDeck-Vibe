"use strict";

const fsp = require("fs/promises");
const http = require("http");
const net = require("net");
const path = require("path");
const { randomUUID } = require("crypto");

const express = require("express");
const { WebSocketServer } = require("ws");

const HYPERDECK_DEFAULT_PORT = 9993;
const APP_DEFAULT_BIND_HOST = "0.0.0.0";
const APP_DEFAULT_PORT = 8080;
// Reads the config path from the HYPERDECK_CONFIG_PATH environment variable,
// allowing tests and other environments to use a separate config file.
// Defaults to ./connections.json when the variable is not set.
const CONFIG_JSON_PATH = path.resolve(
  process.env.HYPERDECK_CONFIG_PATH || path.join(__dirname, "connections.json"),
);

const AUTO_NOTIFY_OPTIONS = {
  "transport": "true",
  "slot": "true",
  "remote": "true",
  "configuration": "true",
  "dropped frames": "true",
  "display timecode": "false",
  "timeline position": "false",
  "playrange": "true",
  "cache": "true",
  "dynamic range": "true",
  "slate": "true",
  "clips": "true",
  "disk": "true",
  "device info": "true",
  "nas": "true",
};

const REQUIRED_NOTIFY_KEYS = [
  "transport",
  "remote",
];

let pendingCurrentClipInfo = false;
let awaitingClipIdAfterClipInfo = false;

const DEFAULT_APP_CONFIG = {
  server: {
    bind_host: APP_DEFAULT_BIND_HOST,
    port: APP_DEFAULT_PORT,
  },
  connections: [],
};

function makeDefaultConfig() {
  // Returns a fresh default config so callers never share the same mutable object.
  return {
    server: { ...DEFAULT_APP_CONFIG.server },
    connections: [],
  };
}

function normalizePort(value) {
  // Parses a HyperDeck port number, defaulting non-integers to 9993 and throwing for out-of-range values.
  const parsed = Number(value);
  const port = Number.isInteger(parsed) ? parsed : HYPERDECK_DEFAULT_PORT;
  if (port < 1 || port > 65535) {
    const err = new Error("Port must be between 1 and 65535");
    err.statusCode = 400;
    throw err;
  }
  return port;
}

function normalizeServerPort(value) {
  // Parses the app's HTTP port, defaulting invalid values to 8080 instead of throwing.
  const parsed = Number(value);
  const port = Number.isInteger(parsed) ? parsed : APP_DEFAULT_PORT;
  if (port < 1 || port > 65535) {
    return APP_DEFAULT_PORT;
  }
  return port;
}

function normalizeBindHost(value) {
  // Trims the bind host and falls back to 0.0.0.0 when empty.
  const candidate = String(value || "").trim();
  return candidate || APP_DEFAULT_BIND_HOST;
}

function normalizeStoredConnectionPort(value) {
// Wraps normalizePort with a fallback so corrupted saved configs degrade to the
// default port instead of crashing the app on startup.
  try {
    return normalizePort(value);
  } catch {
    return HYPERDECK_DEFAULT_PORT;
  }
}

function normalizeConnectionEntry(raw) {
  // Coerces a raw saved connection into a stable shape, generating an id when missing.
  const entry = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(entry.id || randomUUID()),
    name: String(entry.name || "").trim(),
    host: String(entry.host || "").trim(),
    port: normalizeStoredConnectionPort(entry.port),
    model: String(entry.model || "").trim(),
  };
}

function normalizeConfigShape(parsed) {
  // Normalizes a parsed config into {server, connections}, tolerating legacy layouts such as a top-level array.
  if (Array.isArray(parsed)) {
    const config = makeDefaultConfig();
    config.connections = parsed.map(normalizeConnectionEntry);
    return config;
  }

  if (!parsed || typeof parsed !== "object") {
    return makeDefaultConfig();
  }

  const serverSource = parsed.server && typeof parsed.server === "object"
    ? parsed.server
    : {};

  const connectionsSource = Array.isArray(parsed.connections)
    ? parsed.connections
    : [];

  return {
    server: {
      bind_host: normalizeBindHost(
        serverSource.bind_host
        ?? serverSource.bindHost
        ?? serverSource.host,
      ),
      port: normalizeServerPort(serverSource.port),
    },
    connections: connectionsSource.map(normalizeConnectionEntry),
  };
}

async function readAppConfig() {
  // Reads and normalizes the config file, returning the default shape when missing or unreadable.
  try {
    const raw = await fsp.readFile(CONFIG_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfigShape(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return makeDefaultConfig();
    }
    console.warn("Failed to read config JSON:", error.message);
    return makeDefaultConfig();
  }
}

async function writeAppConfig(config) {
  // Normalizes and writes the config to disk as indented JSON.
  const normalized = normalizeConfigShape(config);
  await fsp.writeFile(CONFIG_JSON_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function readBootstrapConfig() {
// Reads the config file at startup with safe-fail semantics: if missing, signals
// that defaults should be written; if present but malformed, keeps in-memory
// defaults without overwriting the existing file.
  let raw;
  try {
    raw = await fsp.readFile(CONFIG_JSON_PATH, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        config: makeDefaultConfig(),
        shouldWriteDefaultConfig: true,
      };
    }

    console.warn("Failed to read config JSON:", error.message);
    return {
      config: makeDefaultConfig(),
      shouldWriteDefaultConfig: false,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      config: normalizeConfigShape(parsed),
      shouldWriteDefaultConfig: false,
    };
  } catch (error) {
    console.warn("Failed to parse config JSON:", error.message);
    return {
      config: makeDefaultConfig(),
      shouldWriteDefaultConfig: false,
    };
  }
}

class DeviceState {
  constructor() {
    // Creates device state with every field at its disconnected default.
    this.reset();
  }

  reset() {
    // Resets all device state fields to their disconnected defaults.
    this.is_connected = false;
    this.host = "";
    this.port = HYPERDECK_DEFAULT_PORT;

    this.protocol_version = "";
    this.model = "";
    this.unique_id = "";
    this.slot_count = 0;
    this.software_version = "";
    this.device_name = "";

    this.transport_status = "";
    this.transport_speed = 0;
    this.transport_slot_id = "";
    this.transport_slot_name = "";
    this.transport_device_name = "";
    this.transport_clip_id = "";
    this.transport_clip_name = "";
    this.transport_clip_id_predicted = false;
    this.last_known_clip_id = "";
    this.transport_single_clip = null;
    this.transport_display_timecode = "";
    this.transport_timecode = "";
    this.transport_video_format = "";
    this.transport_input_video_format = "";
    this.transport_loop = null;
    this.transport_timeline = "";
    this.transport_dynamic_range = "";
    this.transport_reference_locked = false;

    this.remote_enabled = false;
    this.remote_override = false;

    this.cfg_audio_input = "";
    this.cfg_audio_mapping = "";
    this.cfg_video_input = "";
    this.cfg_file_format = "";
    this.cfg_audio_codec = "";
    this.cfg_timecode_input = "";
    this.cfg_timecode_output = "";
    this.cfg_timecode_preference = "";
    this.cfg_timecode_preset = "";
    this.cfg_audio_input_channels = "";
    this.cfg_record_trigger = "";
    this.cfg_record_prefix = "";
    this.cfg_record_cache = false;
    this.cfg_append_timestamp = false;
    this.cfg_reference_source = "";
    this.cfg_genlock_input_resync = false;
    this.cfg_usb_spill = false;
    this.cfg_default_standard = "";
    this.cfg_xlr_mapping = "";
    this.cfg_rca_mapping = "";

    this.playrange_active = null;  // null = unknown, false = none set, true = set
    this.playrange_clip_id = "";
    this.playrange_count = "";
    this.playrange_in = "";
    this.playrange_out = "";
    this.playrange_timeline_in = "";
    this.playrange_timeline_out = "";
  }

  toJSON() {
    // Returns a shallow copy so broadcasts do not expose mutable internals.
    return { ...this };
  }
}

class HyperDeckTCPClient {
  constructor() {
    // Creates a TCP client with no connection; the caller assigns onLine/onDisconnect.
    this.host = "";
    this.port = HYPERDECK_DEFAULT_PORT;
    this.connected = false;
    this.socket = null;
    this.lineBuffer = "";

    this.onLine = null;
    this.onDisconnect = null;
  }

  async connect(host, port = HYPERDECK_DEFAULT_PORT) {
    // Opens a TCP connection to a HyperDeck, disconnecting any prior socket first.
    if (this.connected) {
      await this.disconnect();
    }

    this.host = host;
    this.port = port;

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.socket = socket;
        this.connected = true;
        this.lineBuffer = "";
        console.info(`Connected to HyperDeck at ${host}:${port}`);
        resolve();
      });

      socket.setNoDelay(true);

      socket.on("data", async (chunk) => {
        this.lineBuffer += chunk.toString("utf8");
        await this.drainLineBuffer();
      });

      socket.on("error", (error) => {
        if (!this.connected) {
          reject(error);
          return;
        }
        console.warn("HyperDeck socket error:", error.message);
      });

      socket.on("close", async () => {
        if (!this.connected) {
          return;
        }
        this.connected = false;
        this.socket = null;
        console.info("HyperDeck socket closed");
        if (this.onDisconnect) {
          try {
            await this.onDisconnect();
          } catch (error) {
            console.warn("onDisconnect callback failed:", error.message);
          }
        }
      });
    });
  }

  async disconnect() {
    // Closes the active socket gracefully, destroying it after a short timeout.
    if (!this.socket) {
      this.connected = false;
      return;
    }

    const socket = this.socket;
    this.socket = null;
    this.connected = false;

    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 200);
    });

    console.info("Disconnected from HyperDeck");
  }

  async send(command) {
    // Writes a command terminated by CRLF, supporting multi-line command payloads.
    if (!this.connected || !this.socket) {
      throw new Error("Not connected to a HyperDeck");
    }

    let payload;
    if (command.includes("\n")) {
      const lines = command.split("\n");
      payload = `${lines.map((line) => `${line.replace(/\r/g, "")}\r\n`).join("")}\r\n`;
    } else {
      payload = `${command.trim()}\r\n`;
    }

    await new Promise((resolve, reject) => {
      this.socket.write(payload, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async drainLineBuffer() {
    // Splits buffered data on newlines and forwards each complete line to onLine.
    while (this.lineBuffer.includes("\n")) {
      const idx = this.lineBuffer.indexOf("\n");
      const rawLine = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      const line = rawLine.replace(/\r$/, "");
      if (this.onLine) {
        try {
          await this.onLine(line);
        } catch (error) {
          console.warn("onLine callback failed:", error.message);
        }
      }
    }
  }
}

class WebSocketBroadcaster {
  constructor() {
    // Holds the set of connected browser WebSocket clients.
    this.clients = new Set();
  }

  addClient(client) {
    // Registers a browser client and logs the new total.
    this.clients.add(client);
    console.info(`Browser client connected (${this.clients.size} total)`);
  }

  removeClient(client) {
    // Unregisters a browser client and logs the remaining count.
    if (this.clients.delete(client)) {
      console.info(`Browser client disconnected (${this.clients.size} remaining)`);
    }
  }

  broadcast(message) {
    // Sends a JSON message to every connected client, skipping non-OPEN sockets.
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  sendTo(client, message) {
    // Sends a JSON message to a single client if its socket is OPEN.
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  }
}

const device = new HyperDeckTCPClient();
const state = new DeviceState();
const broadcaster = new WebSocketBroadcaster();

class HyperDeckController {
  constructor({ deviceClient, deviceState, wsBroadcaster }) {
    // Architectural reason:
    // This class creates a boundary between transport protocol logic and WebSocket
    // endpoint plumbing. Today we still use one controller instance, but this
    // shape makes a future multi-deck design straightforward (one controller per
    // deck/session) without rewriting every handler again.
    this.device = deviceClient;
    this.state = deviceState;
    this.broadcaster = wsBroadcaster;
  }

  addBrowserClient(ws) {
    // New clients get the current snapshot immediately so UI can render without
    // waiting for the next protocol event.
    this.broadcaster.addClient(ws);
    this.broadcaster.sendTo(ws, { type: "state", state: this.state.toJSON() });
    if (this.state.is_connected) {
      this.broadcaster.sendTo(ws, {
        type: "connected",
        host: this.state.host,
        port: this.state.port,
      });
    }
  }

  removeBrowserClient(ws) {
    // Unregisters a browser client from the broadcast set.
    this.broadcaster.removeClient(ws);
  }

  async handleBrowserMessage(ws, payload) {
    // One message router keeps action handling consistent and easier to test.
    let message;
    try {
      message = JSON.parse(String(payload));
    } catch {
      this.broadcaster.sendTo(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const action = String(message.action || "");

    if (action === "connect") {
      await this.handleConnectAction(ws, message);
      return;
    }

    if (action === "disconnect") {
      await this.handleDisconnectAction();
      return;
    }

    if (action === "command") {
      await this.handleCommandAction(ws, message);
      return;
    }

    this.broadcaster.sendTo(ws, { type: "error", message: `Unknown action: ${JSON.stringify(action)}` });
  }

  async handleConnectAction(ws, message) {
    // Connect action is isolated so validation, side-effects, and broadcast
    // sequence are defined in one place.
    const host = String(message.host || "").trim();
    const port = normalizePort(message.port ?? HYPERDECK_DEFAULT_PORT);

    if (!host) {
      this.broadcaster.sendTo(ws, { type: "error", message: "Host / IP address is required" });
      return;
    }

    try {
      await this.device.connect(host, port);
      this.state.is_connected = true;
      this.state.host = host;
      this.state.port = port;

      this.broadcaster.broadcast({ type: "connected", host, port });
      this.broadcaster.broadcast({ type: "state", state: this.state.toJSON() });

      await primeDeviceState();
    } catch (error) {
      this.broadcaster.sendTo(ws, { type: "error", message: `Connection failed: ${error.message}` });
    }
  }

  async handleDisconnectAction() {
    // Disconnect is intentionally symmetric with connect:
    // close TCP, then run the standard disconnect teardown.
    await this.device.disconnect();
    resetDeviceAfterDisconnect();
  }

  async handleCommandAction(ws, message) {
    // Command sending includes playrange bookkeeping because that feature uses
    // multi-step asynchronous responses and requires temporary in-memory flags.
    const command = String(message.command || "").trim();

    if (!command) {
      return;
    }
    if (!this.device.connected) {
      this.broadcaster.sendTo(ws, { type: "error", message: "Not connected to a HyperDeck" });
      return;
    }

    try {
      if (command === "playrange") {
        markPlayrangeQueryPending();
      } else if (isPlayrangeClearCommand(command)) {
        pendingPlayrangeClearCommand = true;
        pendingPlayrangeQuery = false;
        cancelPendingPlayrangeClear();
      }
      if (/^clip info$/i.test(command)) {
        pendingCurrentClipInfo = true;
      }
      await this.device.send(command);
      this.broadcaster.broadcast({ type: "sent", line: command });
    } catch (error) {
      if (command === "playrange" || isPlayrangeClearCommand(command)) {
        clearPendingPlayrangeFlags();
      }
      this.broadcaster.sendTo(ws, { type: "error", message: `Send failed: ${error.message}` });
    }
  }
}

const controller = new HyperDeckController({
  deviceClient: device,
  deviceState: state,
  wsBroadcaster: broadcaster,
});

let pendingPlayrangeQuery = false;
let pendingPlayrangeClearTimer = null;
let pendingPlayrangeClearCommand = false;
let recordingClipInfoPollTimer = null;
let recordingClipInfoPollActive = false;
let recordingClipInfoPollAttempts = 0;

let responseAccumulator = [];
let inMultilineResponse = false;

function buildInlineCommand(command, params) {
  // Joins key: value params into a "command: k v k v" payload.
  const keys = Object.keys(params || {});
  if (keys.length === 0) {
    return command;
  }
  const joined = keys.map((key) => `${key}: ${params[key]}`).join(" ");
  return `${command}: ${joined}`;
}

function parseResponseCode(firstLine) {
  // Extracts the numeric HyperDeck response code from the first line.
  const token = String(firstLine || "").split(" ", 1)[0];
  const code = Number(token);
  return Number.isInteger(code) ? code : -1;
}

function parseKeyValueBlock(lines) {
  // Parses multiline response bodies into a lowercase key/value map.
  const result = {};
  for (const rawLine of lines) {
    const stripped = String(rawLine || "").trim();
    // Some firmware responses use nested key tokens like
    // "device: name: HyperDeck...". Split on the LAST ": " so the
    // full key is preserved and normalize internal ": " to spaces.
    const idx = stripped.lastIndexOf(": ");
    if (idx !== -1) {
      const rawKey = stripped.slice(0, idx);
      const normalizedKey = rawKey.replace(/:\s+/g, " ").trim().toLowerCase();
      result[normalizedKey] = stripped.slice(idx + 2);
    }
  }
  return result;
}

function normalizeProtocolNone(value) {
  // Maps "none"/"null"/"n/a" protocol values to "" and preserves real values.
  if (value === undefined || value === null) {
    return "";
  }
  const raw = String(value).trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower === "none" || lower === "null" || lower === "n/a") {
    return "";
  }
  return raw;
}

function normalizeProtocolSlotId(value) {
  // Normalizes slot id values: "none" stays literal while "null"/"n/a" become empty.
  if (value === undefined || value === null) {
    return "";
  }
  const raw = String(value).trim();
  if (!raw) {
    return "";
  }
  const lower = raw.toLowerCase();
  if (lower === "null" || lower === "n/a") {
    return "";
  }
  if (lower === "none") {
    return "none";
  }
  return raw;
}

function parsePlayrangePayload(text, kv) {
  // Parses a playrange response into structured fields, returning null when nothing matches.
  const parsed = {
    clip_id: "",
    count: "",
    in: "",
    out: "",
    timeline_in: "",
    timeline_out: "",
  };

  let found = false;

  if (kv["clip id"] !== undefined) {
    parsed.clip_id = normalizeProtocolNone(kv["clip id"]);
    found = found || Boolean(parsed.clip_id);
  }
  if (kv["count"] !== undefined) {
    parsed.count = normalizeProtocolNone(kv["count"]);
    found = found || Boolean(parsed.count);
  }
  if (kv["in"] !== undefined) {
    parsed.in = normalizeProtocolNone(kv["in"]);
    found = found || Boolean(parsed.in);
  }
  if (kv["out"] !== undefined) {
    parsed.out = normalizeProtocolNone(kv["out"]);
    found = found || Boolean(parsed.out);
  }
  if (kv["timeline in"] !== undefined) {
    parsed.timeline_in = normalizeProtocolNone(kv["timeline in"]);
    found = found || Boolean(parsed.timeline_in);
  }
  if (kv["timeline out"] !== undefined) {
    parsed.timeline_out = normalizeProtocolNone(kv["timeline out"]);
    found = found || Boolean(parsed.timeline_out);
  }

  const normalizedText = String(text || "").replace(/\s+/g, " ").trim();
  if (normalizedText) {
    const clipMatch = normalizedText.match(/clip\s+id:\s*([^\s]+)/i);
    const countMatch = normalizedText.match(/count:\s*([^\s]+)/i);
    const inMatch = normalizedText.match(/\bin:\s*(.+?)(?=\s+out:|\s+timeline\s+in:|\s+timeline\s+out:|$)/i);
    const outMatch = normalizedText.match(/\bout:\s*(.+?)(?=\s+timeline\s+in:|\s+timeline\s+out:|$)/i);
    const timelineInMatch = normalizedText.match(/timeline\s+in:\s*([^\s]+)/i);
    const timelineOutMatch = normalizedText.match(/timeline\s+out:\s*([^\s]+)/i);

    if (clipMatch && !parsed.clip_id) parsed.clip_id = normalizeProtocolNone(clipMatch[1]);
    if (countMatch && !parsed.count) parsed.count = normalizeProtocolNone(countMatch[1]);
    if (inMatch && !parsed.in) parsed.in = normalizeProtocolNone(inMatch[1]);
    if (outMatch && !parsed.out) parsed.out = normalizeProtocolNone(outMatch[1]);
    if (timelineInMatch && !parsed.timeline_in) parsed.timeline_in = normalizeProtocolNone(timelineInMatch[1]);
    if (timelineOutMatch && !parsed.timeline_out) parsed.timeline_out = normalizeProtocolNone(timelineOutMatch[1]);
  }

  found = found || Boolean(
    parsed.clip_id ||
    parsed.count ||
    parsed.in ||
    parsed.out ||
    parsed.timeline_in ||
    parsed.timeline_out
  );

  return found ? parsed : null;
}

function setPlayrangeStateFromParsed(parsed) {
  // Marks playrange active and writes the parsed fields into shared state.
  state.playrange_active = true;
  state.playrange_clip_id = parsed.clip_id;
  state.playrange_count = parsed.count;
  state.playrange_in = parsed.in;
  state.playrange_out = parsed.out;
  state.playrange_timeline_in = parsed.timeline_in;
  state.playrange_timeline_out = parsed.timeline_out;
}

function clearPlayrangeState() {
  // Marks playrange inactive and clears all its fields.
  state.playrange_active = false;
  state.playrange_clip_id = "";
  state.playrange_count = "";
  state.playrange_in = "";
  state.playrange_out = "";
  state.playrange_timeline_in = "";
  state.playrange_timeline_out = "";
}

function cancelPendingPlayrangeClear() {
  // Cancels a scheduled playrange clear, if one is pending.
  if (pendingPlayrangeClearTimer !== null) {
    clearTimeout(pendingPlayrangeClearTimer);
    pendingPlayrangeClearTimer = null;
  }
}

function isPlayrangeClearCommand(command) {
  // True when a command asks to clear the play range.
  return /^playrange\s+clear\b/i.test(String(command || ""));
}

function markPlayrangeQueryPending() {
  // Marks a playrange query as in flight so a following 200 response does not clear it.
  pendingPlayrangeQuery = true;
  pendingPlayrangeClearCommand = false;
  cancelPendingPlayrangeClear();
}

function clearPendingPlayrangeFlags() {
  // Resets playrange query/clear flags and cancels any pending clear timer.
  pendingPlayrangeQuery = false;
  pendingPlayrangeClearCommand = false;
  cancelPendingPlayrangeClear();
}

function stopRecordingClipInfoPoll() {
  // Stops the periodic clip-info polling used to track a recording clip name.
  recordingClipInfoPollActive = false;
  recordingClipInfoPollAttempts = 0;
  if (recordingClipInfoPollTimer !== null) {
    clearTimeout(recordingClipInfoPollTimer);
    recordingClipInfoPollTimer = null;
  }
}

function scheduleRecordingClipInfoPoll(delayMs = 350) {
  // Schedules a clip info poll (up to 12 attempts) while a recording is active.
  if (!recordingClipInfoPollActive || recordingClipInfoPollAttempts >= 12) {
    return;
  }
  if (recordingClipInfoPollTimer !== null) {
    clearTimeout(recordingClipInfoPollTimer);
  }
  recordingClipInfoPollTimer = setTimeout(async () => {
    recordingClipInfoPollTimer = null;
    if (!recordingClipInfoPollActive || !device.connected) {
      return;
    }
    recordingClipInfoPollAttempts += 1;
    pendingCurrentClipInfo = true;
    try {
      await device.send("clip info");
    } catch (error) {
      console.warn("Recording clip info query failed:", error.message);
    }
  }, delayMs);
}

function schedulePendingPlayrangeClear() {
  // Clears playrange state shortly after a 200 unless a query is still in flight.
  cancelPendingPlayrangeClear();
  pendingPlayrangeClearTimer = setTimeout(() => {
    pendingPlayrangeClearTimer = null;
    if (!pendingPlayrangeQuery) {
      return;
    }
    pendingPlayrangeQuery = false;
    clearPlayrangeState();
    broadcaster.broadcast({
      type: "state",
      state: state.toJSON(),
    });
  }, 250);
}

/** Runs the standard post-disconnect teardown for both manual and dropped connections. */
function resetDeviceAfterDisconnect() {
  clearPendingPlayrangeFlags();
  stopRecordingClipInfoPoll();
  pendingCurrentClipInfo = false;
  awaitingClipIdAfterClipInfo = false;
  state.reset();
  broadcaster.broadcast({ type: "disconnected" });
  broadcaster.broadcast({ type: "state", state: state.toJSON() });
}

function normalizeTransportStatus(rawStatus, speed, fallbackStatus = "") {
  // Maps raw transport status to a stable UI state, resolving deck quirks for
  // shuttle/forward/rewind at max speed and impossible stop-at-edge states.
  const candidate = String(rawStatus || fallbackStatus || "").trim().toLowerCase();
  const normalizedSpeed = Number.isInteger(speed) ? speed : null;

  if (!candidate) {
    return "";
  }

  // Protocol defines preview as a distinct transport state.
  if (candidate === "preview") {
    return "preview";
  }

  // Expose deck-style directional transport states when max-speed shuttle is used.
  if (["shuttle", "forward", "rewind"].includes(candidate) && normalizedSpeed === 5000) {
    return "forward";
  }
  if (["shuttle", "forward", "rewind"].includes(candidate) && normalizedSpeed === -5000) {
    return "rewind";
  }

  // Some decks continue reporting shuttle when normal-speed playback is requested.
  if (candidate === "shuttle" && normalizedSpeed === 100) {
    return "play";
  }

  // A shuttle at speed 0 holds the transport at its current position. Present
  // that as paused rather than as a motion or stopped state.
  if (candidate === "shuttle" && normalizedSpeed === 0) {
    return "paused";
  }

  // Some decks report shuttle/transport motion state with speed 0 at timeline edges.
  // Normalize those impossible combinations back to stopped for UI consistency.
  if (
    normalizedSpeed === 0 &&
    ["play", "forward", "rewind", "jog"].includes(candidate)
  ) {
    return "stopped";
  }

  return candidate;
}

function isNotifyEnabled(kv, key) {
  // True when a notify key is present with the value "true".
  return String(kv[key] || "").trim().toLowerCase() === "true";
}

function updateLastKnownClipId(kv) {
  // Tracks the highest numeric clip id seen so the next record clip can be predicted.
  const ids = Object.keys(kv || {})
    .filter((key) => /^\d+$/.test(key))
    .map((key) => Number(key))
    .filter((id) => Number.isInteger(id));
  for (const id of ids) {
    noteLastKnownClipId(id);
  }
}

function noteLastKnownClipId(observedClipId) {
  // Bumps last_known_clip_id when the observed clip id exceeds the current known value.
  const knownId = Number(state.last_known_clip_id);
  if (!Number.isInteger(knownId) || observedClipId > knownId) {
    state.last_known_clip_id = String(observedClipId);
  }
}

async function sendNotifySubscription() {
  // Sends the full notify subscription block used to (re)enable required notify keys.
  await device.send(buildInlineCommand("notify", AUTO_NOTIFY_OPTIONS));
  await new Promise((resolve) => setTimeout(resolve, 50));
  await device.send("notify");
}

async function enforceRequiredNotifySettings(kv) {
  // Re-sends the full notify command if a required subscription was turned off.
  if (!device.connected) {
    return;
  }

  const needsReenable = REQUIRED_NOTIFY_KEYS.some((key) => !isNotifyEnabled(kv, key));
  if (!needsReenable) {
    return;
  }

  try {
    await sendNotifySubscription();
    console.info("Re-enabled required notify subscriptions");
  } catch (error) {
    console.warn("Failed to re-enable notify subscriptions:", error.message);
  }
}

async function handleCompleteResponse(code, text, kv) {
  // Applies a parsed HyperDeck response to device state and broadcasts it.
  let stateChanged = false;

  if (code === 107 && recordingClipInfoPollActive) {
    pendingCurrentClipInfo = false;
    scheduleRecordingClipInfoPoll(750);
  }

  if (code === 500) {
    state.protocol_version = kv["protocol version"] || state.protocol_version;
    state.model = kv["model"] || state.model;
    stateChanged = true;
  } else if (code === 204) {
    state.protocol_version = kv["protocol version"] || state.protocol_version;
    state.model = kv["model"] || state.model;
    state.unique_id = kv["unique id"] || state.unique_id;
    state.software_version = kv["software version"] || state.software_version;
    state.device_name = kv["name"] || state.device_name;
    const maybeSlotCount = Number(kv["slot count"]);
    if (Number.isInteger(maybeSlotCount)) {
      state.slot_count = maybeSlotCount;
    }
    stateChanged = true;
  } else if (code === 228 && pendingCurrentClipInfo) {
    const filePath = normalizeProtocolNone(kv["file path"] || kv.name);
    if (filePath) {
      state.transport_clip_name = filePath;
      stateChanged = true;
      stopRecordingClipInfoPoll();
    }
    pendingCurrentClipInfo = false;
    awaitingClipIdAfterClipInfo = true;
  } else if (code === 205 || code === 202 || code === 502 || code === 206 || code === 519 || code === 520) {
    updateLastKnownClipId(kv);
    // Active slot ownership is transport-driven (208/508). For slot/disk responses,
    // only apply slot metadata when payload slot id matches current active slot.
    const payloadSlotRaw = kv["slot id"] !== undefined ? kv["slot id"] : kv["active slot"];
    const payloadSlotId = normalizeProtocolSlotId(payloadSlotRaw);
    const activeSlotId = normalizeProtocolSlotId(state.transport_slot_id);
    const isPayloadForActiveSlot =
      payloadSlotId && payloadSlotId !== "none" && activeSlotId && payloadSlotId === activeSlotId;

    if (isPayloadForActiveSlot && kv["slot name"] !== undefined) {
      state.transport_slot_name = normalizeProtocolNone(kv["slot name"]);
      stateChanged = true;
    }
    if (isPayloadForActiveSlot && (kv["device name"] !== undefined || kv["device"] !== undefined)) {
      const nextDevice = kv["device name"] !== undefined ? kv["device name"] : kv["device"];
      state.transport_device_name = normalizeProtocolNone(nextDevice);
      stateChanged = true;
    }
  } else if (code === 208 || code === 508) {
    const previousClipId = state.transport_clip_id;
    const previousStatus = state.transport_status;
    const activeSlotRaw = kv["active slot"] !== undefined ? kv["active slot"] : kv["slot id"];
    if (activeSlotRaw !== undefined) {
      const normalizedSlot = normalizeProtocolSlotId(activeSlotRaw);
      state.transport_slot_id = normalizedSlot;
      if (!normalizedSlot || normalizedSlot === "none") {
        state.transport_slot_name = "";
        state.transport_device_name = "";
      }
    }
    if (kv["slot name"] !== undefined) {
      state.transport_slot_name = normalizeProtocolNone(kv["slot name"]);
    }
    if (kv["device name"] !== undefined || kv["device"] !== undefined) {
      const nextDevice = kv["device name"] !== undefined ? kv["device name"] : kv["device"];
      state.transport_device_name = normalizeProtocolNone(nextDevice);
    }
    const isRecording = String(kv.status || state.transport_status).trim().toLowerCase() === "record";
    if (kv["clip id"] !== undefined && !(isRecording && state.transport_clip_id_predicted)) {
      state.transport_clip_id = kv["clip id"];
      state.transport_clip_id_predicted = false;
      const observedClipId = Number(kv["clip id"]);
      if (Number.isInteger(observedClipId)) {
        noteLastKnownClipId(observedClipId);
      }
    }
    if (code === 208 && awaitingClipIdAfterClipInfo && kv["clip id"] !== undefined) {
      awaitingClipIdAfterClipInfo = false;
    }
    state.transport_display_timecode = kv["display timecode"] || state.transport_display_timecode;
    state.transport_timecode = kv["timecode"] || state.transport_timecode;
    state.transport_video_format = kv["video format"] || state.transport_video_format;
    state.transport_input_video_format = kv["input video format"] || state.transport_input_video_format;
    state.transport_timeline = kv["timeline"] || state.transport_timeline;
    state.transport_dynamic_range = kv["dynamic range"] || state.transport_dynamic_range;
    if (kv["loop"] !== undefined) {
      state.transport_loop = String(kv["loop"]).toLowerCase() === "true";
    }
    if (kv["single clip"] !== undefined) {
      state.transport_single_clip = String(kv["single clip"]).toLowerCase() === "true";
    }
    if (kv["reference locked"] !== undefined) {
      state.transport_reference_locked = String(kv["reference locked"]).toLowerCase() === "true";
    }
    const maybeSpeed = Number(kv["speed"]);
    if (Number.isInteger(maybeSpeed)) {
      state.transport_speed = maybeSpeed;
    }
    if (kv["status"] !== undefined || Number.isInteger(maybeSpeed)) {
      state.transport_status = normalizeTransportStatus(
        kv["status"],
        state.transport_speed,
        state.transport_status,
      );
    }
    stateChanged = true;
    const nextTransportStatus = state.transport_status;
    if (nextTransportStatus === "record" && previousStatus !== "record") {
      const lastKnownId = Number(state.last_known_clip_id);
      if (Number.isInteger(lastKnownId)) {
        state.transport_clip_id = String(lastKnownId + 1);
        state.transport_clip_id_predicted = true;
        stateChanged = true;
      }
    }
    const clipSelectionChanged = kv["clip id"] !== undefined && kv["clip id"] !== previousClipId;
    const transportStartedPlaying = nextTransportStatus === "play" && previousStatus !== "play";
    if (code === 508 && nextTransportStatus === "record" && device.connected) {
      recordingClipInfoPollActive = true;
      recordingClipInfoPollAttempts = 0;
      scheduleRecordingClipInfoPoll();
    }
    if (code === 508 && (clipSelectionChanged || transportStartedPlaying) && device.connected) {
      pendingCurrentClipInfo = true;
      try {
        await device.send("clip info");
      } catch (error) {
        console.warn("Failed to query current clip info after transport change:", error.message);
      }
    }
  } else if (code === 210 || code === 510) {
    state.remote_enabled = String(kv["enabled"] || "").toLowerCase() === "true";
    state.remote_override = String(kv["override"] || "").toLowerCase() === "true";
    stateChanged = true;
  } else if (code === 209) {
    await enforceRequiredNotifySettings(kv);
  } else if (code === 215 || code === 219 || code === 515 || code === 516) {
    pendingPlayrangeQuery = false;
    pendingPlayrangeClearCommand = false;
    cancelPendingPlayrangeClear();
    const parsedPlayrange = parsePlayrangePayload(text, kv);
    if (parsedPlayrange) {
      setPlayrangeStateFromParsed(parsedPlayrange);
    } else {
      clearPlayrangeState();
    }
    stateChanged = true;
  } else if (code === 211 || code === 511) {
    state.cfg_audio_input = kv["audio input"] || state.cfg_audio_input;
    state.cfg_audio_mapping = kv["audio mapping"] || state.cfg_audio_mapping;
    state.cfg_video_input = kv["video input"] || state.cfg_video_input;
    state.cfg_file_format = kv["file format"] || state.cfg_file_format;
    state.cfg_audio_codec = kv["audio codec"] || state.cfg_audio_codec;
    state.cfg_timecode_input = kv["timecode input"] || state.cfg_timecode_input;
    state.cfg_timecode_output = kv["timecode output"] || state.cfg_timecode_output;
    state.cfg_timecode_preference = kv["timecode preference"] || state.cfg_timecode_preference;
    state.cfg_timecode_preset = kv["timecode preset"] || state.cfg_timecode_preset;
    state.cfg_audio_input_channels = kv["audio input channels"] || state.cfg_audio_input_channels;
    state.cfg_record_trigger = kv["record trigger"] || state.cfg_record_trigger;
    state.cfg_record_prefix = kv["record prefix"] || state.cfg_record_prefix;
    state.cfg_record_cache = String(kv["record cache"] || "").toLowerCase() === "true";
    state.cfg_append_timestamp = String(kv["append timestamp"] || "").toLowerCase() === "true";
    state.cfg_reference_source = kv["reference source"] || state.cfg_reference_source;
    state.cfg_genlock_input_resync = String(kv["genlock input resync"] || "").toLowerCase() === "true";
    state.cfg_usb_spill = String(kv["usb spill"] || "").toLowerCase() === "true";
    state.cfg_default_standard = kv["default standard"] || state.cfg_default_standard;
    state.cfg_xlr_mapping = kv["xlr mapping"] || state.cfg_xlr_mapping;
    state.cfg_rca_mapping = kv["rca mapping"] || state.cfg_rca_mapping;
    stateChanged = true;
  }

  if (code === 200 && pendingPlayrangeQuery) {
    // Some firmware answers "playrange" with 200 first and follow-up data lines.
    // Defer "no playrange" fallback briefly to avoid transient false negatives.
    schedulePendingPlayrangeClear();
  }

  if (code === 200 && pendingPlayrangeClearCommand) {
    pendingPlayrangeClearCommand = false;
    clearPlayrangeState();
    stateChanged = true;
  }

  broadcaster.broadcast({
    type: "response",
    code,
    text,
    data: kv,
  });

  if (stateChanged) {
    broadcaster.broadcast({
      type: "state",
      state: state.toJSON(),
    });
  }
}

async function onHyperDeckLine(line) {
  // Feeds raw TCP lines into the multiline accumulator and dispatches complete responses.
  if (!inMultilineResponse) {
    const firstSpace = line.indexOf(" ");
    const codeToken = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const code = Number(codeToken);
    if (!Number.isInteger(code)) {
      return;
    }

    const rest = firstSpace === -1 ? "" : line.slice(firstSpace + 1);
    broadcaster.broadcast({ type: "raw_line", line });

    if (rest.endsWith(":")) {
      inMultilineResponse = true;
      responseAccumulator = [line];
    } else {
      await handleCompleteResponse(code, rest, {});
    }
    return;
  }

  broadcaster.broadcast({ type: "raw_line", line });

  if (line === "") {
    const code = parseResponseCode(responseAccumulator[0]);
    const bodyLines = responseAccumulator.slice(1);
    const responseText = bodyLines.join("\n");
    const kv = parseKeyValueBlock(bodyLines);
    responseAccumulator = [];
    inMultilineResponse = false;
    await handleCompleteResponse(code, responseText, kv);
    return;
  }

  responseAccumulator.push(line);
}

async function onHyperDeckDisconnect() {
  // Runs the standard disconnect teardown when the TCP socket drops.
  resetDeviceAfterDisconnect();
  console.info("HyperDeck disconnected and state reset");
}

async function primeDeviceState() {
  // Sends the initial notify/device/transport/remote/configuration/playrange commands on connect.
  const initCommands = [
    "device info",
    "transport info",
    "remote",
    "configuration",
    "playrange",
  ];

  try {
    await sendNotifySubscription();
  } catch (error) {
    console.warn("Initial command failed (notify subscription):", error.message);
  }

  for (const command of initCommands) {
    try {
      if (command === "playrange") {
        markPlayrangeQueryPending();
      }
      await device.send(command);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (command === "playrange") {
        clearPendingPlayrangeFlags();
      }
      console.warn(`Initial command failed (${command}):`, error.message);
    }
  }
}

const app = express();
const staticDir = path.join(__dirname, "static");

app.use(express.json({ limit: "1mb" }));
app.use("/static", express.static(staticDir));

app.get("/", (_req, res) => {
  // Serves the single-page app at the root.
  res.sendFile(path.join(staticDir, "index.html"));
});

app.get("/api/connections", async (_req, res, next) => {
  // Returns the saved deck connections from the config file.
  try {
    const config = await readAppConfig();
    res.json({ connections: config.connections });
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", async (_req, res, next) => {
  // Returns the app server settings from the config file.
  try {
    const config = await readAppConfig();
    res.json({ settings: { server: config.server } });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings/server", async (req, res, next) => {
  // Updates the bind host/port, noting that a restart is required to take effect.
  try {
    const config = await readAppConfig();
    const nextHost = req.body?.bind_host ?? req.body?.bindHost ?? req.body?.host;
    const nextPort = req.body?.port;

    if (nextHost !== undefined) {
      config.server.bind_host = normalizeBindHost(nextHost);
    }
    if (nextPort !== undefined) {
      config.server.port = normalizeServerPort(nextPort);
    }

    await writeAppConfig(config);

    res.json({
      ok: true,
      settings: { server: config.server },
      restart_required: true,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections", async (req, res, next) => {
  // Adds a new saved deck connection after validating name and host.
  try {
    const name = String(req.body?.name || "").trim();
    const host = String(req.body?.host || "").trim();
    const model = String(req.body?.model || "").trim();
    const port = normalizePort(req.body?.port ?? HYPERDECK_DEFAULT_PORT);

    if (!name) {
      const err = new Error("Name is required");
      err.statusCode = 400;
      throw err;
    }
    if (!host) {
      const err = new Error("Host is required");
      err.statusCode = 400;
      throw err;
    }

    const entry = {
      id: randomUUID(),
      name,
      host,
      port,
      model,
    };

    const config = await readAppConfig();
    config.connections.push(entry);
    await writeAppConfig(config);

    res.json({ ok: true, connection: entry });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/:connectionId", async (req, res, next) => {
  // Removes a saved deck connection by id, returning 404 when it does not exist.
  try {
    const connectionId = String(req.params.connectionId || "");
    const config = await readAppConfig();
    const existing = config.connections;
    const updated = existing.filter((item) => String(item.id || "") !== connectionId);

    if (updated.length === existing.length) {
      const err = new Error("Connection not found");
      err.statusCode = 404;
      throw err;
    }

    config.connections = updated;
    await writeAppConfig(config);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.put("/api/connections/reorder", async (req, res, next) => {
  // Reorders existing connections to match the supplied id list, rejecting mismatches.
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      const err = new Error("ids must be a non-empty list");
      err.statusCode = 400;
      throw err;
    }

    const normalizedIds = ids.map((id) => String(id));
    const config = await readAppConfig();
    const existing = config.connections;
    const byId = new Map(existing.map((entry) => [String(entry.id || ""), entry]));

    if (normalizedIds.length !== byId.size || normalizedIds.some((id) => !byId.has(id))) {
      const err = new Error("ids must match current saved entries");
      err.statusCode = 400;
      throw err;
    }

    const reordered = normalizedIds.map((id) => byId.get(id));
    config.connections = reordered;
    await writeAppConfig(config);

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/connections/model", async (req, res, next) => {
  // Updates the model on every connection matching the given host/port pair.
  try {
    const host = String(req.body?.host || "").trim();
    const model = String(req.body?.model || "").trim();
    const port = normalizePort(req.body?.port ?? HYPERDECK_DEFAULT_PORT);

    if (!host || !model) {
      const err = new Error("Host and model are required");
      err.statusCode = 400;
      throw err;
    }

    let updatedCount = 0;
    const config = await readAppConfig();
    const existing = config.connections;

    for (const entry of existing) {
      const entryHost = String(entry.host || "").trim();
      const entryPort = normalizePort(entry.port ?? HYPERDECK_DEFAULT_PORT);
      if (entryHost === host && entryPort === port) {
        if (String(entry.model || "").trim() !== model) {
          entry.model = model;
        }
        updatedCount += 1;
      }
    }

    if (updatedCount > 0) {
      config.connections = existing;
      await writeAppConfig(config);
    }

    res.json({ ok: true, updated: updatedCount });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  // Central error handler that returns {detail} with the response status.
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const detail = error?.message || "Internal server error";
  res.status(statusCode).json({ detail });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

device.onLine = onHyperDeckLine;
device.onDisconnect = onHyperDeckDisconnect;

wss.on("connection", (ws) => {
  // WebSocket layer now delegates behavior to the controller boundary.
  // This keeps the transport entry point tiny and easier to reason about.
  controller.addBrowserClient(ws);

  ws.on("message", async (payload) => {
    await controller.handleBrowserMessage(ws, payload);
  });

  ws.on("close", () => {
    controller.removeBrowserClient(ws);
  });

  ws.on("error", () => {
    controller.removeBrowserClient(ws);
  });
});

async function startServer() {
  // Startup policy:
  // - Missing config file: create defaults
  // - Existing but malformed/unreadable config: run with in-memory defaults,
  //   but do not overwrite the on-disk file automatically.
  const { config, shouldWriteDefaultConfig } = await readBootstrapConfig();
  if (shouldWriteDefaultConfig) {
    await writeAppConfig(config);
  }

  const bindHost = normalizeBindHost(config.server.bind_host);
  const bindPort = normalizeServerPort(config.server.port);

  await new Promise((resolve, reject) => {
    // Wrapping server.listen in a Promise gives us await-able startup, which is
    // critical for integration tests and future orchestration code.
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };

    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(bindPort, bindHost);
  });

  const address = server.address();
  if (address && typeof address === "object") {
    console.info(`HyperDeck Vibe Node server listening on http://${address.address}:${address.port}`);
  }

  return { bindHost, bindPort };
}

async function stopServer() {
  // Graceful shutdown helper for tests and future lifecycle controls.
  // Without this, tests can leak open servers and make ports appear "in use".
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

module.exports = {
  HYPERDECK_DEFAULT_PORT,
  APP_DEFAULT_BIND_HOST,
  APP_DEFAULT_PORT,
  CONFIG_JSON_PATH,
  HyperDeckController,
  controller,
  normalizePort,
  normalizeServerPort,
  normalizeBindHost,
  normalizeStoredConnectionPort,
  normalizeConnectionEntry,
  normalizeConfigShape,
  normalizeTransportStatus,
  readAppConfig,
  writeAppConfig,
  readBootstrapConfig,
  app,
  server,
  startServer,
  stopServer,
};

if (require.main === module) {
// Only start the server when this file is run directly (node server.js), not
// when it is require()-d from test files.
  startServer().catch((error) => {
    console.error("Failed to initialize server configuration:", error);
    process.exit(1);
  });
}
