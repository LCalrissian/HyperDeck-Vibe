"""
HyperDeck Vibe — Cross-platform web controller for Blackmagic HyperDeck recorders.

Architecture
------------
  Browser  ←WebSocket→  FastAPI (this file)  ←TCP 9993→  HyperDeck

All HyperDeck protocol knowledge in this file is taken directly from:
  "Blackmagic HyperDeck Ethernet Protocol" (December 2024)

Response-code reference (spec §"Successful response codes" and §"Asynchronous response codes"):
  200   ok                      – simple acknowledgement
  201   help:                   – help text (multi-line)
  202   slot info:              – slot info (multi-line)
  204   device info:            – device information (multi-line)
  205   clips info:             – timeline clips (multi-line)
  206   disk list:              – disk clip list (multi-line)
  208   transport info:         – transport state (multi-line)
  209   notify:                 – notification subscription states (multi-line)
  210   remote info:            – remote control state (multi-line)
  211   configuration:          – deck configuration (multi-line)
  212   commands:               – supported commands in XML (multi-line)
  213   deck rebooting          – file-format change caused a reboot (single-line)
  214   clips count:            – number of timeline clips (multi-line)
  225   nas host info:          – discovered NAS hosts (multi-line)
  226   external drive info:    – connected external drives (multi-line)

  Asynchronous (server-initiated) notifications (5xx):
  500   connection info:        – sent on connect
  502   slot info:              – slot state changed
  508   transport info:         – transport state changed
  510   remote info:            – remote state changed
  511   configuration:          – configuration changed
  519   clips info:             – timeline clips changed
  520   disk list info:         – disk clip list changed

  Failure codes (1xx):
  100  syntax error          101  unsupported parameter    102  invalid value
  103  unsupported           104  disk full                105  no disk
  106  disk error            107  timeline empty           108  internal error
  109  out of range          110  no input                 111  remote control disabled
  112  clip not found        120  connection failed        121  authentication failed
  122  authentication required  150  invalid state         151  invalid codec
  160  invalid format        161  invalid token            162  format not prepared
  163  parameterized single line command not supported
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Callable, Optional

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
log = logging.getLogger("hyperdeck-vibe")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

HYPERDECK_DEFAULT_PORT: int = 9993
TCP_READ_TIMEOUT_SECS: float = 0.05   # short poll so cancellation is responsive


# ---------------------------------------------------------------------------
# HyperDeck TCP connection
# ---------------------------------------------------------------------------

class HyperDeckTCPClient:
    """
    Maintains a persistent TCP connection to a HyperDeck device.

    Exposes:
      connect(host, port) – open connection
      disconnect()        – close connection
      send(command)       – write a line (or multiline block) to the device

    Callers register async callbacks:
      on_line(line: str)  – called for every CR/LF-terminated line received
      on_disconnect()     – called when the TCP stream closes unexpectedly
    """

    def __init__(self) -> None:
        self.host: str = ""
        self.port: int = HYPERDECK_DEFAULT_PORT
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._connected: bool = False
        self._recv_task: Optional[asyncio.Task] = None
        self._line_buffer: str = ""

        # Async callbacks – set by the application layer
        self.on_line: Optional[Callable] = None
        self.on_disconnect: Optional[Callable] = None

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self, host: str, port: int = HYPERDECK_DEFAULT_PORT) -> None:
        """Open a TCP connection to the HyperDeck at *host*:*port*."""
        if self._connected:
            await self.disconnect()

        log.info("Connecting to HyperDeck at %s:%d …", host, port)
        self._reader, self._writer = await asyncio.open_connection(host, port)
        self.host = host
        self.port = port
        self._connected = True
        self._line_buffer = ""

        # Start the receive loop as a background task
        self._recv_task = asyncio.create_task(self._recv_loop(), name="hd-recv")
        log.info("Connected to HyperDeck at %s:%d", host, port)

    async def disconnect(self) -> None:
        """Close the TCP connection cleanly."""
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
                pass  # ignore errors during cleanup

        self._reader = None
        self._writer = None
        log.info("Disconnected from HyperDeck")

    async def send(self, command: str) -> None:
        """
        Send *command* to the HyperDeck.

        Single-line commands are sent as-is with a trailing CRLF.
        Commands that contain embedded newlines ('\\n') are treated as
        multiline blocks per the protocol spec and terminated with an
        extra blank CRLF line.
        """
        if not self._connected or self._writer is None:
            raise RuntimeError("Not connected to a HyperDeck")

        if "\n" in command:
            # Multiline block (e.g. nas add:, slate clips:, authenticate:)
            lines = command.split("\n")
            payload = "".join(line.rstrip("\r") + "\r\n" for line in lines)
            payload += "\r\n"  # blank line terminates the block
        else:
            payload = command.strip() + "\r\n"

        self._writer.write(payload.encode())
        await self._writer.drain()
        log.debug("→ HyperDeck: %r", payload.strip())

    # ------------------------------------------------------------------
    # Internal receive loop
    # ------------------------------------------------------------------

    async def _recv_loop(self) -> None:
        """Background task: read bytes from TCP, split into lines, invoke on_line."""
        assert self._reader is not None
        try:
            while self._connected:
                try:
                    chunk = await asyncio.wait_for(
                        self._reader.read(4096),
                        timeout=TCP_READ_TIMEOUT_SECS,
                    )
                except asyncio.TimeoutError:
                    continue

                if not chunk:
                    log.info("HyperDeck closed the TCP connection")
                    break

                self._line_buffer += chunk.decode(errors="replace")
                await self._drain_line_buffer()

        except asyncio.CancelledError:
            pass  # normal shutdown
        except Exception as exc:
            log.warning("HyperDeck receive error: %s", exc)
        finally:
            self._connected = False
            if self.on_disconnect:
                try:
                    await self.on_disconnect()
                except Exception as exc:
                    log.warning("on_disconnect callback raised: %s", exc)

    async def _drain_line_buffer(self) -> None:
        """Flush complete CRLF-terminated lines from the buffer to on_line."""
        while "\n" in self._line_buffer:
            raw_line, self._line_buffer = self._line_buffer.split("\n", 1)
            line = raw_line.rstrip("\r")
            log.debug("← HyperDeck: %r", line)
            if self.on_line:
                try:
                    await self.on_line(line)
                except Exception as exc:
                    log.warning("on_line callback raised: %s", exc)


# ---------------------------------------------------------------------------
# WebSocket connection manager
# ---------------------------------------------------------------------------

class WebSocketBroadcaster:
    """
    Tracks all connected browser WebSocket clients and provides
    broadcast / unicast helpers.
    """

    def __init__(self) -> None:
        self._clients: list[WebSocket] = []

    async def accept(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._clients.append(websocket)
        log.info("Browser client connected (%d total)", len(self._clients))

    def remove(self, websocket: WebSocket) -> None:
        if websocket in self._clients:
            self._clients.remove(websocket)
        log.info("Browser client disconnected (%d remaining)", len(self._clients))

    async def broadcast(self, message: dict) -> None:
        """Send *message* to every connected browser client."""
        payload = json.dumps(message)
        stale: list[WebSocket] = []
        for ws in list(self._clients):
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)
        for ws in stale:
            self.remove(ws)

    async def send_to(self, websocket: WebSocket, message: dict) -> None:
        """Send *message* to a single browser client."""
        await websocket.send_text(json.dumps(message))


# ---------------------------------------------------------------------------
# HyperDeck device state model
# ---------------------------------------------------------------------------

class DeviceState:
    """
    Mirrors every piece of information the protocol can return.
    Populated incrementally as responses arrive from the device.
    """

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        """Clear all state (call on disconnect)."""
        # ── Connection ───────────────────────────────────────────────────
        self.is_connected: bool = False
        self.host: str = ""
        self.port: int = HYPERDECK_DEFAULT_PORT

        # ── From 500 connection info / 204 device info ────────────────────
        self.protocol_version: str = ""
        self.model: str = ""
        self.unique_id: str = ""
        self.slot_count: int = 0
        self.software_version: str = ""
        self.device_name: str = ""

        # ── From 208 / 508 transport info ─────────────────────────────────
        # status: preview | stopped | play | forward | rewind | jog | shuttle | record
        self.transport_status: str = ""
        self.transport_speed: int = 0
        self.transport_slot_id: str = ""
        self.transport_slot_name: str = ""
        self.transport_device_name: str = ""
        self.transport_clip_id: str = ""
        self.transport_single_clip: bool = False
        self.transport_display_timecode: str = ""
        self.transport_timecode: str = ""
        self.transport_video_format: str = ""
        self.transport_input_video_format: str = ""
        self.transport_loop: bool = False
        self.transport_timeline: str = ""
        self.transport_dynamic_range: str = ""
        self.transport_reference_locked: bool = False

        # ── From 210 / 510 remote info ────────────────────────────────────
        self.remote_enabled: bool = False
        self.remote_override: bool = False

        # ── From 211 / 511 configuration ──────────────────────────────────
        self.cfg_audio_input: str = ""
        self.cfg_audio_mapping: str = ""
        self.cfg_video_input: str = ""
        self.cfg_file_format: str = ""
        self.cfg_audio_codec: str = ""
        self.cfg_timecode_input: str = ""
        self.cfg_timecode_output: str = ""
        self.cfg_timecode_preference: str = ""
        self.cfg_timecode_preset: str = ""
        self.cfg_audio_input_channels: str = ""
        self.cfg_record_trigger: str = ""
        self.cfg_record_prefix: str = ""
        self.cfg_record_cache: bool = False
        self.cfg_append_timestamp: bool = False
        self.cfg_reference_source: str = ""
        self.cfg_genlock_input_resync: bool = False
        self.cfg_usb_spill: bool = False
        self.cfg_default_standard: str = ""
        self.cfg_xlr_mapping: str = ""
        self.cfg_rca_mapping: str = ""

    def to_dict(self) -> dict:
        """Serialise the full state for JSON transport to the browser."""
        return {k: v for k, v in self.__dict__.items()}


# ---------------------------------------------------------------------------
# Protocol response parser (server-side)
# ---------------------------------------------------------------------------

# Global instances shared across the whole application
_device: HyperDeckTCPClient = HyperDeckTCPClient()
_state: DeviceState = DeviceState()
_broadcaster: WebSocketBroadcaster = WebSocketBroadcaster()

# Accumulator for multi-line protocol responses
_response_accumulator: list[str] = []
_in_multiline_response: bool = False


async def _on_hyperdeck_line(line: str) -> None:
    """
    Callback invoked for every line received from the HyperDeck.

    Responsibilities:
    1. Forward every raw line verbatim to all browser clients (for the console).
    2. Accumulate multi-line blocks until the terminal blank line arrives.
    3. Parse complete responses and update _state.
    """
    global _response_accumulator, _in_multiline_response

    # Always forward raw protocol lines so the browser console stays live
    await _broadcaster.broadcast({"type": "raw_line", "line": line})

    if not _in_multiline_response:
        parts = line.split(" ", 1)
        try:
            code = int(parts[0])
        except (ValueError, IndexError):
            return  # not a response line

        rest = parts[1] if len(parts) > 1 else ""

        if rest.endswith(":"):
            # Start of a multi-line block
            _in_multiline_response = True
            _response_accumulator = [line]
        else:
            # Complete single-line response (e.g. "200 ok", "213 deck rebooting")
            await _handle_complete_response(code, rest, {})
    else:
        if line == "":
            # Blank line terminates a multi-line block
            code = _parse_response_code(_response_accumulator[0])
            key_values = _parse_key_value_block(_response_accumulator[1:])
            _response_accumulator = []
            _in_multiline_response = False
            await _handle_complete_response(code, "", key_values)
        else:
            _response_accumulator.append(line)


def _parse_response_code(first_line: str) -> int:
    """Extract the numeric response code from the first line of a block."""
    try:
        return int(first_line.split(" ", 1)[0])
    except (ValueError, IndexError):
        return -1


def _parse_key_value_block(lines: list[str]) -> dict[str, str]:
    """
    Convert lines of the form "key: value" into a dict.
    Handles leading whitespace (multiline block continuation lines).
    """
    result: dict[str, str] = {}
    for raw in lines:
        stripped = raw.strip()
        idx = stripped.find(": ")
        if idx != -1:
            result[stripped[:idx]] = stripped[idx + 2:]
    return result


async def _handle_complete_response(
    code: int, text: str, kv: dict[str, str]
) -> None:
    """
    Apply a parsed protocol response to _state and notify browsers.

    Only state-bearing response codes (201-299, 5xx) trigger state updates;
    simple 200 ok and error 1xx codes are forwarded as events only.
    """
    state_changed = False

    # ── Initial connection banner (async) ─────────────────────────────────
    if code == 500:
        _state.protocol_version = kv.get("protocol version", _state.protocol_version)
        _state.model            = kv.get("model",            _state.model)
        state_changed = True

    # ── 204 device info ───────────────────────────────────────────────────
    elif code == 204:
        _state.protocol_version = kv.get("protocol version", _state.protocol_version)
        _state.model            = kv.get("model",            _state.model)
        _state.unique_id        = kv.get("unique id",        _state.unique_id)
        _state.software_version = kv.get("software version", _state.software_version)
        _state.device_name      = kv.get("name",             _state.device_name)
        try:
            _state.slot_count = int(kv.get("slot count", _state.slot_count))
        except (ValueError, TypeError):
            pass
        state_changed = True

    # ── 208 / 508  transport info (query + async notification) ───────────
    elif code in (208, 508):
        _state.transport_status              = kv.get("status",             _state.transport_status)
        # transport_speed is parsed as int below; no separate raw field needed
        _state.transport_slot_id             = kv.get("slot id",            _state.transport_slot_id)
        _state.transport_slot_name           = kv.get("slot name",          _state.transport_slot_name)
        _state.transport_device_name         = kv.get("device name",        _state.transport_device_name)
        _state.transport_clip_id             = kv.get("clip id",            _state.transport_clip_id)
        _state.transport_display_timecode    = kv.get("display timecode",   _state.transport_display_timecode)
        _state.transport_timecode            = kv.get("timecode",           _state.transport_timecode)
        _state.transport_video_format        = kv.get("video format",       _state.transport_video_format)
        _state.transport_input_video_format  = kv.get("input video format", _state.transport_input_video_format)
        _state.transport_timeline            = kv.get("timeline",           _state.transport_timeline)
        _state.transport_dynamic_range       = kv.get("dynamic range",      _state.transport_dynamic_range)
        _state.transport_loop                = kv.get("loop",         "").lower() == "true"
        _state.transport_single_clip         = kv.get("single clip",  "").lower() == "true"
        _state.transport_reference_locked    = kv.get("reference locked", "").lower() == "true"
        try:
            _state.transport_speed = int(kv.get("speed", _state.transport_speed))
        except (ValueError, TypeError):
            pass
        state_changed = True

    # ── 210 / 510  remote info ────────────────────────────────────────────
    elif code in (210, 510):
        _state.remote_enabled  = kv.get("enabled",  "").lower() == "true"
        _state.remote_override = kv.get("override", "").lower() == "true"
        state_changed = True

    # ── 211 / 511  configuration ──────────────────────────────────────────
    elif code in (211, 511):
        _state.cfg_audio_input          = kv.get("audio input",          _state.cfg_audio_input)
        _state.cfg_audio_mapping        = kv.get("audio mapping",        _state.cfg_audio_mapping)
        _state.cfg_video_input          = kv.get("video input",          _state.cfg_video_input)
        _state.cfg_file_format          = kv.get("file format",          _state.cfg_file_format)
        _state.cfg_audio_codec          = kv.get("audio codec",          _state.cfg_audio_codec)
        _state.cfg_timecode_input       = kv.get("timecode input",       _state.cfg_timecode_input)
        _state.cfg_timecode_output      = kv.get("timecode output",      _state.cfg_timecode_output)
        _state.cfg_timecode_preference  = kv.get("timecode preference",  _state.cfg_timecode_preference)
        _state.cfg_timecode_preset      = kv.get("timecode preset",      _state.cfg_timecode_preset)
        _state.cfg_audio_input_channels = kv.get("audio input channels", _state.cfg_audio_input_channels)
        _state.cfg_record_trigger       = kv.get("record trigger",       _state.cfg_record_trigger)
        _state.cfg_record_prefix        = kv.get("record prefix",        _state.cfg_record_prefix)
        _state.cfg_record_cache         = kv.get("record cache",    "").lower() == "true"
        _state.cfg_append_timestamp     = kv.get("append timestamp","").lower() == "true"
        _state.cfg_reference_source     = kv.get("reference source",     _state.cfg_reference_source)
        _state.cfg_genlock_input_resync = kv.get("genlock input resync","").lower() == "true"
        _state.cfg_usb_spill            = kv.get("usb spill",       "").lower() == "true"
        _state.cfg_default_standard     = kv.get("default standard",     _state.cfg_default_standard)
        _state.cfg_xlr_mapping          = kv.get("xlr mapping",          _state.cfg_xlr_mapping)
        _state.cfg_rca_mapping          = kv.get("rca mapping",          _state.cfg_rca_mapping)
        state_changed = True

    # Broadcast the parsed response as a structured event for the browser
    await _broadcaster.broadcast({
        "type":  "response",
        "code":  code,
        "text":  text,
        "data":  kv,
    })

    if state_changed:
        await _broadcaster.broadcast({
            "type":  "state",
            "state": _state.to_dict(),
        })


async def _on_hyperdeck_disconnect() -> None:
    """Called when the HyperDeck TCP stream closes unexpectedly."""
    _state.reset()
    await _broadcaster.broadcast({"type": "disconnected"})
    await _broadcaster.broadcast({"type": "state", "state": _state.to_dict()})
    log.info("HyperDeck disconnected — device state reset")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="HyperDeck Vibe", description="Web controller for Blackmagic HyperDeck")

_STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"))


@app.websocket("/ws")
async def websocket_handler(websocket: WebSocket) -> None:
    """
    WebSocket endpoint for browser clients.

    Message types received from the browser:
      { "action": "connect",    "host": "...", "port": 9993 }
      { "action": "disconnect" }
      { "action": "command",    "command": "..." }

    Message types sent to the browser:
      { "type": "connected",    "host": "...", "port": 9993 }
      { "type": "disconnected" }
      { "type": "raw_line",    "line": "..." }   – every line from HyperDeck
      { "type": "sent",        "line": "..." }   – command we sent
      { "type": "response",    "code": n, "text": "...", "data": {...} }
      { "type": "state",       "state": {...} }  – full device state snapshot
      { "type": "error",       "message": "..." }
    """
    await _broadcaster.accept(websocket)

    # Send current state immediately so the new client is in sync
    await _broadcaster.send_to(websocket, {"type": "state", "state": _state.to_dict()})
    if _state.is_connected:
        await _broadcaster.send_to(
            websocket,
            {"type": "connected", "host": _state.host, "port": _state.port},
        )

    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                message = json.loads(raw_text)
            except json.JSONDecodeError:
                await _broadcaster.send_to(
                    websocket, {"type": "error", "message": "Invalid JSON"}
                )
                continue

            action = message.get("action", "")

            # ── Connect action ────────────────────────────────────────────
            if action == "connect":
                host = message.get("host", "").strip()
                port = int(message.get("port", HYPERDECK_DEFAULT_PORT))
                if not host:
                    await _broadcaster.send_to(
                        websocket,
                        {"type": "error", "message": "Host / IP address is required"},
                    )
                    continue
                try:
                    _device.on_line       = _on_hyperdeck_line
                    _device.on_disconnect = _on_hyperdeck_disconnect
                    await _device.connect(host, port)
                    _state.is_connected = True
                    _state.host = host
                    _state.port = port
                    await _broadcaster.broadcast(
                        {"type": "connected", "host": host, "port": port}
                    )
                    await _broadcaster.broadcast({"type": "state", "state": _state.to_dict()})
                    # Immediately query key device state so the UI populates
                    for init_cmd in ("device info", "transport info", "remote", "configuration"):
                        try:
                            await _device.send(init_cmd)
                            await asyncio.sleep(0.05)
                        except Exception:
                            pass
                except Exception as exc:
                    await _broadcaster.send_to(
                        websocket,
                        {"type": "error", "message": f"Connection failed: {exc}"},
                    )

            # ── Disconnect action ─────────────────────────────────────────
            elif action == "disconnect":
                await _device.disconnect()
                _state.reset()
                await _broadcaster.broadcast({"type": "disconnected"})
                await _broadcaster.broadcast({"type": "state", "state": _state.to_dict()})

            # ── Send a HyperDeck command ──────────────────────────────────
            elif action == "command":
                command = message.get("command", "").strip()
                if not command:
                    continue
                if not _device.connected:
                    await _broadcaster.send_to(
                        websocket,
                        {"type": "error", "message": "Not connected to a HyperDeck"},
                    )
                    continue
                try:
                    await _device.send(command)
                    # Echo back so the console shows what was sent
                    await _broadcaster.broadcast({"type": "sent", "line": command})
                except Exception as exc:
                    await _broadcaster.send_to(
                        websocket,
                        {"type": "error", "message": f"Send failed: {exc}"},
                    )

            else:
                await _broadcaster.send_to(
                    websocket,
                    {"type": "error", "message": f"Unknown action: {action!r}"},
                )

    except WebSocketDisconnect:
        _broadcaster.remove(websocket)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=8080,
        reload=False,
        log_level="info",
    )
