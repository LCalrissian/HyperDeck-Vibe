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
const CONFIG_JSON_PATH = path.join(__dirname, "connections.json");

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

const DEFAULT_APP_CONFIG = {
  server: {
    bind_host: APP_DEFAULT_BIND_HOST,
    port: APP_DEFAULT_PORT,
  },
  connections: [],
};

function normalizePort(value) {
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
  const parsed = Number(value);
  const port = Number.isInteger(parsed) ? parsed : APP_DEFAULT_PORT;
  if (port < 1 || port > 65535) {
    return APP_DEFAULT_PORT;
  }
  return port;
}

function normalizeBindHost(value) {
  const candidate = String(value || "").trim();
  return candidate || APP_DEFAULT_BIND_HOST;
}

function normalizeConnectionEntry(raw) {
  const entry = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(entry.id || randomUUID()),
    name: String(entry.name || "").trim(),
    host: String(entry.host || "").trim(),
    port: normalizePort(entry.port),
    model: String(entry.model || "").trim(),
  };
}

function normalizeConfigShape(parsed) {
  if (Array.isArray(parsed)) {
    return {
      server: { ...DEFAULT_APP_CONFIG.server },
      connections: parsed.map(normalizeConnectionEntry),
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      server: { ...DEFAULT_APP_CONFIG.server },
      connections: [],
    };
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
  try {
    const raw = await fsp.readFile(CONFIG_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeConfigShape(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        server: { ...DEFAULT_APP_CONFIG.server },
        connections: [],
      };
    }
    console.warn("Failed to read config JSON:", error.message);
    return {
      server: { ...DEFAULT_APP_CONFIG.server },
      connections: [],
    };
  }
}

async function writeAppConfig(config) {
  const normalized = normalizeConfigShape(config);
  await fsp.writeFile(CONFIG_JSON_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

async function ensureAppConfig() {
  const config = await readAppConfig();
  await writeAppConfig(config);
  return config;
}

class DeviceState {
  constructor() {
    this.reset();
  }

  reset() {
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
  }

  toJSON() {
    return { ...this };
  }
}

class HyperDeckTCPClient {
  constructor() {
    this.host = "";
    this.port = HYPERDECK_DEFAULT_PORT;
    this.connected = false;
    this.socket = null;
    this.lineBuffer = "";

    this.onLine = null;
    this.onDisconnect = null;
  }

  async connect(host, port = HYPERDECK_DEFAULT_PORT) {
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
    this.clients = new Set();
  }

  addClient(client) {
    this.clients.add(client);
    console.info(`Browser client connected (${this.clients.size} total)`);
  }

  removeClient(client) {
    if (this.clients.delete(client)) {
      console.info(`Browser client disconnected (${this.clients.size} remaining)`);
    }
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(payload);
      }
    }
  }

  sendTo(client, message) {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  }
}

const device = new HyperDeckTCPClient();
const state = new DeviceState();
const broadcaster = new WebSocketBroadcaster();

let responseAccumulator = [];
let inMultilineResponse = false;

function buildInlineCommand(command, params) {
  const keys = Object.keys(params || {});
  if (keys.length === 0) {
    return command;
  }
  const joined = keys.map((key) => `${key}: ${params[key]}`).join(" ");
  return `${command}: ${joined}`;
}

function parseResponseCode(firstLine) {
  const token = String(firstLine || "").split(" ", 1)[0];
  const code = Number(token);
  return Number.isInteger(code) ? code : -1;
}

function parseKeyValueBlock(lines) {
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

function normalizeTransportStatus(rawStatus, speed, fallbackStatus = "") {
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

  // Some decks report shuttle/transport motion state with speed 0 at timeline edges.
  // Normalize those impossible combinations back to stopped for UI consistency.
  if (
    normalizedSpeed === 0 &&
    ["play", "forward", "rewind", "jog", "shuttle"].includes(candidate)
  ) {
    return "stopped";
  }

  return candidate;
}

function isNotifyEnabled(kv, key) {
  return String(kv[key] || "").trim().toLowerCase() === "true";
}

async function enforceRequiredNotifySettings(kv) {
  if (!device.connected) {
    return;
  }

  const needsReenable = REQUIRED_NOTIFY_KEYS.some((key) => !isNotifyEnabled(kv, key));
  if (!needsReenable) {
    return;
  }

  try {
    await device.send(buildInlineCommand("notify", AUTO_NOTIFY_OPTIONS));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await device.send("notify");
    console.info("Re-enabled required notify subscriptions");
  } catch (error) {
    console.warn("Failed to re-enable notify subscriptions:", error.message);
  }
}

async function handleCompleteResponse(code, text, kv) {
  let stateChanged = false;

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
  } else if (code === 208 || code === 508) {
    state.transport_slot_id = kv["slot id"] || state.transport_slot_id;
    state.transport_slot_name = kv["slot name"] || state.transport_slot_name;
    state.transport_device_name = kv["device name"] || kv["device"] || state.transport_device_name;
    state.transport_clip_id = kv["clip id"] || state.transport_clip_id;
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
    const nextTransportSpeed = Number.isInteger(maybeSpeed) ? maybeSpeed : state.transport_speed;
    if (Number.isInteger(maybeSpeed)) {
      state.transport_speed = maybeSpeed;
    }
    if (kv["status"] !== undefined || Number.isInteger(maybeSpeed)) {
      state.transport_status = normalizeTransportStatus(
        kv["status"],
        nextTransportSpeed,
        state.transport_status,
      );
    }
    stateChanged = true;
  } else if (code === 210 || code === 510) {
    state.remote_enabled = String(kv["enabled"] || "").toLowerCase() === "true";
    state.remote_override = String(kv["override"] || "").toLowerCase() === "true";
    stateChanged = true;
  } else if (code === 209) {
    await enforceRequiredNotifySettings(kv);
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
  state.reset();
  broadcaster.broadcast({ type: "disconnected" });
  broadcaster.broadcast({ type: "state", state: state.toJSON() });
  console.info("HyperDeck disconnected and state reset");
}

async function primeDeviceState() {
  const initCommands = [
    buildInlineCommand("notify", AUTO_NOTIFY_OPTIONS),
    "notify",
    "device info",
    "transport info",
    "remote",
    "configuration",
  ];

  for (const command of initCommands) {
    try {
      await device.send(command);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      console.warn(`Initial command failed (${command}):`, error.message);
    }
  }
}

const app = express();
const staticDir = path.join(__dirname, "static");

app.use(express.json({ limit: "1mb" }));
app.use("/static", express.static(staticDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.get("/api/connections", async (_req, res, next) => {
  try {
    const config = await readAppConfig();
    res.json({ connections: config.connections });
  } catch (error) {
    next(error);
  }
});

app.get("/api/settings", async (_req, res, next) => {
  try {
    const config = await readAppConfig();
    res.json({ settings: { server: config.server } });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/settings/server", async (req, res, next) => {
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
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const detail = error?.message || "Internal server error";
  res.status(statusCode).json({ detail });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

device.onLine = onHyperDeckLine;
device.onDisconnect = onHyperDeckDisconnect;

wss.on("connection", (ws) => {
  broadcaster.addClient(ws);

  broadcaster.sendTo(ws, { type: "state", state: state.toJSON() });
  if (state.is_connected) {
    broadcaster.sendTo(ws, {
      type: "connected",
      host: state.host,
      port: state.port,
    });
  }

  ws.on("message", async (payload) => {
    let message;
    try {
      message = JSON.parse(String(payload));
    } catch {
      broadcaster.sendTo(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    const action = String(message.action || "");

    if (action === "connect") {
      const host = String(message.host || "").trim();
      const port = normalizePort(message.port ?? HYPERDECK_DEFAULT_PORT);

      if (!host) {
        broadcaster.sendTo(ws, { type: "error", message: "Host / IP address is required" });
        return;
      }

      try {
        await device.connect(host, port);
        state.is_connected = true;
        state.host = host;
        state.port = port;

        broadcaster.broadcast({ type: "connected", host, port });
        broadcaster.broadcast({ type: "state", state: state.toJSON() });

        await primeDeviceState();
      } catch (error) {
        broadcaster.sendTo(ws, { type: "error", message: `Connection failed: ${error.message}` });
      }
      return;
    }

    if (action === "disconnect") {
      await device.disconnect();
      state.reset();
      broadcaster.broadcast({ type: "disconnected" });
      broadcaster.broadcast({ type: "state", state: state.toJSON() });
      return;
    }

    if (action === "command") {
      const command = String(message.command || "").trim();
      const quiet = Boolean(message.quiet);

      if (!command) {
        return;
      }
      if (!device.connected) {
        broadcaster.sendTo(ws, { type: "error", message: "Not connected to a HyperDeck" });
        return;
      }

      try {
        await device.send(command);
        broadcaster.broadcast({ type: "sent", line: command });
      } catch (error) {
        broadcaster.sendTo(ws, { type: "error", message: `Send failed: ${error.message}` });
      }
      return;
    }

    broadcaster.sendTo(ws, { type: "error", message: `Unknown action: ${JSON.stringify(action)}` });
  });

  ws.on("close", () => {
    broadcaster.removeClient(ws);
  });

  ws.on("error", () => {
    broadcaster.removeClient(ws);
  });
});

async function bootstrap() {
  const config = await ensureAppConfig();
  const bindHost = normalizeBindHost(config.server.bind_host);
  const bindPort = normalizeServerPort(config.server.port);

  server.listen(bindPort, bindHost, () => {
    console.info(`HyperDeck Vibe Node server listening on http://${bindHost}:${bindPort}`);
  });
}

bootstrap().catch((error) => {
  console.error("Failed to initialize server configuration:", error);
  process.exit(1);
});
