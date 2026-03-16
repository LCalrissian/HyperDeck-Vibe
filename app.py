"""
HyperDeck Vibe — Cross-platform web controller for Blackmagic HyperDeck.

Architecture:
  Browser ←→ WebSocket ←→ FastAPI server ←→ TCP ←→ HyperDeck (port 9993)

Response-code reference (from official Blackmagic protocol spec, Dec 2024):
  200        ok
  201        help:
  202        slot info:
  204        device info:
  205        clips info:
  206        disk list:
  208        transport info:
  209        notify:
  210        remote info:
  211        configuration:
  212        commands:          (XML)
  213        deck rebooting
  214        clips count:
  225        nas host info:
  226        external drive info:
  500        connection info:   (async, on connect)
  502        slot info:         (async notification)
  508        transport info:    (async notification)
  510        remote info:       (async notification)
  511        configuration:     (async notification)
  519        clips info:        (async notification)
  520        disk list info:    (async notification)

  Failure codes (1xx):
  100 syntax error   101 unsupported parameter  102 invalid value
  103 unsupported    104 disk full              105 no disk
  106 disk error     107 timeline empty         108 internal error
  109 out of range   110 no input               111 remote control disabled
  112 clip not found 120 connection failed       121 authentication failed
  122 authentication required                    150 invalid state
  151 invalid codec  160 invalid format          161 invalid token
  162 format not prepared  163 parameterized single line command not supported
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

HYPERDECK_PORT = 9993
READ_TIMEOUT = 0.05


# ---------------------------------------------------------------------------
# HyperDeck TCP client
# ---------------------------------------------------------------------------

class HyperDeckConnection:
    def __init__(self) -> None:
        self.host: Optional[str] = None
        self.port: int = HYPERDECK_PORT
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected: bool = False
        self._recv_task: Optional[asyncio.Task] = None
        self._buffer: str = ""
        self.on_line: Optional[object] = None       # async callable(line: str)
        self.on_disconnect: Optional[object] = None  # async callable()

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self, host: str, port: int = HYPERDECK_PORT) -> None:
        if self._connected:
            await self.disconnect()
        self.host = host
        self.port = port
        log.info("Connecting to HyperDeck at %s:%s", host, port)
        self._reader, self._writer = await asyncio.open_connection(host, port)
        self._connected = True
        self._buffer = ""
        self._recv_task = asyncio.create_task(self._recv_loop(), name="hd-recv")
        log.info("Connected to HyperDeck at %s:%s", host, port)

    async def disconnect(self) -> None:
        self._connected = False
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._reader = None
        self._writer = None
        log.info("Disconnected from HyperDeck")

    async def send(self, command: str) -> None:
        if not self._connected or self._writer is None:
            raise RuntimeError("Not connected to HyperDeck")
        line = command.strip() + "\r\n"
        self._writer.write(line.encode())
        await self._writer.drain()
        log.debug("→ HyperDeck: %r", line.strip())

    async def _recv_loop(self) -> None:
        assert self._reader is not None
        try:
            while self._connected:
                try:
                    data = await asyncio.wait_for(self._reader.read(4096), timeout=READ_TIMEOUT)
                except asyncio.TimeoutError:
                    continue
                if not data:
                    log.info("HyperDeck closed the connection")
                    break
                self._buffer += data.decode(errors="replace")
                await self._process_buffer()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.warning("HyperDeck recv error: %s", exc)
        finally:
            self._connected = False
            if self.on_disconnect:
                try:
                    await self.on_disconnect()
                except Exception:
                    pass

    async def _process_buffer(self) -> None:
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.rstrip("\r")
            log.debug("← HyperDeck: %r", line)
            if self.on_line:
                try:
                    await self.on_line(line)
                except Exception as exc:
                    log.warning("on_line callback error: %s", exc)


# ---------------------------------------------------------------------------
# WebSocket manager
# ---------------------------------------------------------------------------

class ConnectionManager:
    def __init__(self) -> None:
        self._clients: list[WebSocket] = []

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.append(ws)

    def disconnect(self, ws: WebSocket) -> None:
        if ws in self._clients:
            self._clients.remove(ws)

    async def broadcast(self, msg: dict) -> None:
        dead: list[WebSocket] = []
        text = json.dumps(msg)
        for ws in list(self._clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    async def send_to(self, ws: WebSocket, msg: dict) -> None:
        await ws.send_text(json.dumps(msg))


# ---------------------------------------------------------------------------
# Device state
# ---------------------------------------------------------------------------

class HyperDeckState:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.connected = False
        self.host = ""
        self.port = HYPERDECK_PORT
        # From 500 connection info / 204 device info
        self.protocol_version = ""
        self.model = ""
        self.unique_id = ""
        self.slot_count = 0
        self.software_version = ""
        self.device_name = ""
        # From 208 transport info
        self.transport_status = ""
        self.speed = 0
        self.slot_id = ""
        self.slot_name = ""
        self.device_name_transport = ""
        self.clip_id = ""
        self.single_clip = False
        self.display_timecode = ""
        self.timecode = ""
        self.video_format = ""
        self.loop = False
        self.timeline = ""
        self.input_video_format = ""
        self.dynamic_range = ""
        self.reference_locked = False
        # From 210 remote info
        self.remote_enabled = False
        self.remote_override = False
        # From 211 configuration
        self.audio_input = ""
        self.video_input = ""
        self.file_format = ""
        self.audio_codec = ""
        self.timecode_input = ""
        self.timecode_output = ""
        self.timecode_preference = ""
        self.timecode_preset = ""
        self.audio_input_channels = ""
        self.record_trigger = ""
        self.record_prefix = ""
        self.record_cache = False
        self.append_timestamp = False
        self.reference_source = ""
        self.genlock_input_resync = False
        self.usb_spill = False
        self.default_standard = ""
        self.xlr_mapping = ""
        self.rca_mapping = ""

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


# ---------------------------------------------------------------------------
# Application state
# ---------------------------------------------------------------------------

hd = HyperDeckConnection()
state = HyperDeckState()
manager = ConnectionManager()

_response_lines: list[str] = []
_in_multiline: bool = False


async def _on_hyperdeck_line(line: str) -> None:
    global _response_lines, _in_multiline

    # Forward every raw line to browser clients
    await manager.broadcast({"type": "hyperdeck", "line": line})

    if not _in_multiline:
        # Check if this starts a multi-line block (code + text ending in ":")
        parts = line.split(" ", 1)
        try:
            code = int(parts[0])
        except (ValueError, IndexError):
            # Not a response line — ignore
            return

        rest = parts[1] if len(parts) > 1 else ""
        if rest.endswith(":"):
            _in_multiline = True
            _response_lines = [line]
        else:
            # Single-line response
            await _update_state_from_response(code, {})
    else:
        if line == "":
            # End of multi-line block
            code = _extract_code(_response_lines[0])
            kv = _parse_kv(_response_lines[1:])
            _response_lines = []
            _in_multiline = False
            await _update_state_from_response(code, kv)
        else:
            _response_lines.append(line)


def _extract_code(first_line: str) -> int:
    try:
        return int(first_line.split(" ", 1)[0])
    except (ValueError, IndexError):
        return -1


def _parse_kv(lines: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in lines:
        idx = line.find(": ")
        if idx != -1:
            result[line[:idx].strip()] = line[idx + 2:].strip()
    return result


async def _update_state_from_response(code: int, kv: dict[str, str]) -> None:
    changed = False

    if code == 500:
        # Initial connection info (async)
        state.protocol_version = kv.get("protocol version", state.protocol_version)
        state.model            = kv.get("model",            state.model)
        changed = True

    elif code == 204:
        # device info
        state.protocol_version  = kv.get("protocol version",  state.protocol_version)
        state.model             = kv.get("model",             state.model)
        state.unique_id         = kv.get("unique id",         state.unique_id)
        state.software_version  = kv.get("software version",  state.software_version)
        state.device_name       = kv.get("name",              state.device_name)
        try:
            state.slot_count = int(kv.get("slot count", state.slot_count))
        except (ValueError, TypeError):
            pass
        changed = True

    elif code in (208, 508):
        # transport info (208 = response, 508 = async notification)
        state.transport_status        = kv.get("status",           state.transport_status)
        state.display_timecode        = kv.get("display timecode", state.display_timecode)
        state.timecode                = kv.get("timecode",         state.timecode)
        state.video_format            = kv.get("video format",     state.video_format)
        state.input_video_format      = kv.get("input video format", state.input_video_format)
        state.slot_id                 = kv.get("slot id",          state.slot_id)
        state.slot_name               = kv.get("slot name",        state.slot_name)
        state.device_name_transport   = kv.get("device name",      state.device_name_transport)
        state.clip_id                 = kv.get("clip id",          state.clip_id)
        state.timeline                = kv.get("timeline",         state.timeline)
        state.dynamic_range           = kv.get("dynamic range",    state.dynamic_range)
        try:
            state.speed = int(kv.get("speed", state.speed))
        except (ValueError, TypeError):
            pass
        state.loop         = kv.get("loop",         "").lower() == "true"
        state.single_clip  = kv.get("single clip",  "").lower() == "true"
        state.reference_locked = kv.get("reference locked", "").lower() == "true"
        changed = True

    elif code in (210, 510):
        # remote info
        state.remote_enabled  = kv.get("enabled",  "").lower() == "true"
        state.remote_override = kv.get("override",  "").lower() == "true"
        changed = True

    elif code in (211, 511):
        # configuration
        state.audio_input          = kv.get("audio input",          state.audio_input)
        state.video_input          = kv.get("video input",          state.video_input)
        state.file_format          = kv.get("file format",          state.file_format)
        state.audio_codec          = kv.get("audio codec",          state.audio_codec)
        state.timecode_input       = kv.get("timecode input",       state.timecode_input)
        state.timecode_output      = kv.get("timecode output",      state.timecode_output)
        state.timecode_preference  = kv.get("timecode preference",  state.timecode_preference)
        state.timecode_preset      = kv.get("timecode preset",      state.timecode_preset)
        state.audio_input_channels = kv.get("audio input channels", state.audio_input_channels)
        state.record_trigger       = kv.get("record trigger",       state.record_trigger)
        state.record_prefix        = kv.get("record prefix",        state.record_prefix)
        state.record_cache         = kv.get("record cache",  "").lower() == "true"
        state.append_timestamp     = kv.get("append timestamp", "").lower() == "true"
        state.reference_source     = kv.get("reference source",     state.reference_source)
        state.genlock_input_resync = kv.get("genlock input resync", "").lower() == "true"
        state.usb_spill            = kv.get("usb spill", "").lower() == "true"
        state.default_standard     = kv.get("default standard",     state.default_standard)
        state.xlr_mapping          = kv.get("xlr mapping",          state.xlr_mapping)
        state.rca_mapping          = kv.get("rca mapping",          state.rca_mapping)
        changed = True

    if changed:
        await manager.broadcast({"type": "state", "state": state.to_dict()})


async def _on_hyperdeck_disconnect() -> None:
    state.connected = False
    await manager.broadcast({"type": "disconnected"})
    await manager.broadcast({"type": "state", "state": state.to_dict()})


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="HyperDeck Vibe")

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    await manager.connect(ws)
    log.info("Browser WebSocket connected")

    await manager.send_to(ws, {"type": "state", "state": state.to_dict()})
    if state.connected:
        await manager.send_to(ws, {
            "type": "connected", "host": state.host, "port": state.port
        })

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await manager.send_to(ws, {"type": "error", "message": "Invalid JSON"})
                continue

            action = msg.get("action", "")

            if action == "connect":
                host = msg.get("host", "").strip()
                port = int(msg.get("port", HYPERDECK_PORT))
                if not host:
                    await manager.send_to(ws, {"type": "error", "message": "Host is required"})
                    continue
                try:
                    hd.on_line       = _on_hyperdeck_line
                    hd.on_disconnect = _on_hyperdeck_disconnect
                    await hd.connect(host, port)
                    state.connected = True
                    state.host = host
                    state.port = port
                    await manager.broadcast({"type": "connected", "host": host, "port": port})
                    await manager.broadcast({"type": "state", "state": state.to_dict()})
                    # Request initial state from device
                    for cmd in ("device info", "transport info", "remote", "configuration"):
                        try:
                            await hd.send(cmd)
                            await asyncio.sleep(0.05)
                        except Exception:
                            pass
                except Exception as exc:
                    await manager.send_to(ws, {"type": "error", "message": str(exc)})

            elif action == "disconnect":
                await hd.disconnect()
                state.reset()
                await manager.broadcast({"type": "disconnected"})
                await manager.broadcast({"type": "state", "state": state.to_dict()})

            elif action == "command":
                command = msg.get("command", "").strip()
                if not command:
                    continue
                if not hd.connected:
                    await manager.send_to(ws, {
                        "type": "error", "message": "Not connected to HyperDeck"
                    })
                    continue
                try:
                    await hd.send(command)
                    await manager.broadcast({"type": "sent", "line": command})
                except Exception as exc:
                    await manager.send_to(ws, {"type": "error", "message": str(exc)})

            else:
                await manager.send_to(ws, {
                    "type": "error", "message": f"Unknown action: {action}"
                })

    except WebSocketDisconnect:
        manager.disconnect(ws)
        log.info("Browser WebSocket disconnected")


if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8080, reload=False, log_level="info")
