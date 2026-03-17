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

import argparse
import asyncio
import json
import logging
import os
import socket
import sys
import webbrowser
import uuid
from typing import Callable, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
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
CONNECTIONS_JSON_PATH = os.path.join(os.path.dirname(__file__), "connections.json")

AUTO_NOTIFY_OPTIONS: dict[str, str] = {
    "transport": "true",
    "slot": "true",
    "remote": "true",
    "configuration": "true",
    "dropped frames": "true",
    "display timecode": "true",
    "timeline position": "true",
    "playrange": "true",
    "cache": "true",
    "dynamic range": "true",
    "slate": "true",
    "clips": "true",
    "disk": "true",
    "device info": "true",
    "nas": "true",
}

REQUIRED_NOTIFY_KEYS: tuple[str, ...] = (
    "transport",
    "remote",
    "display timecode",
    "timeline position",
)

_connections_file_lock = asyncio.Lock()


def _read_connections_file() -> list[dict]:
    """Read saved connection profiles from disk, returning an empty list on first run."""
    if not os.path.exists(CONNECTIONS_JSON_PATH):
        return []

    try:
        with open(CONNECTIONS_JSON_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            return data
    except Exception as exc:
        log.warning("Failed to read connections JSON: %s", exc)
    return []


def _write_connections_file(entries: list[dict]) -> None:
    """Persist saved connection profiles to disk."""
    with open(CONNECTIONS_JSON_PATH, "w", encoding="utf-8") as fh:
        json.dump(entries, fh, indent=2)


def _normalize_port(value: object) -> int:
    try:
        port = int(value)
    except (ValueError, TypeError):
        port = HYPERDECK_DEFAULT_PORT
    if port < 1 or port > 65535:
        raise HTTPException(status_code=400, detail="Port must be between 1 and 65535")
    return port


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
_pending_quiet_transport_blocks: int = 0
_suppress_current_response_event: bool = False


def _build_inline_command(command: str, params: dict[str, str]) -> str:
    """Build a single-line HyperDeck command with ordered key/value pairs."""
    if not params:
        return command

    parts = [f"{key}: {value}" for key, value in params.items()]
    return f"{command}: {' '.join(parts)}"


def _is_notify_enabled(kv: dict[str, str], key: str) -> bool:
    """Return True when a notify key is explicitly enabled."""
    return kv.get(key, "").strip().lower() == "true"


async def _enforce_required_notify_settings(kv: dict[str, str]) -> None:
    """Re-enable critical notify streams if the deck reports them disabled."""
    if not _device.connected:
        return

    needs_reenable = any(not _is_notify_enabled(kv, key) for key in REQUIRED_NOTIFY_KEYS)
    if not needs_reenable:
        return

    try:
        await _device.send(_build_inline_command("notify", AUTO_NOTIFY_OPTIONS))
        await asyncio.sleep(0.05)
        await _device.send("notify")
        log.info("Re-enabled required notify subscriptions")
    except Exception as exc:
        log.warning("Failed to re-enable notify subscriptions: %s", exc)


async def _on_hyperdeck_line(line: str) -> None:
    """
    Callback invoked for every line received from the HyperDeck.

    Responsibilities:
    1. Forward every raw line verbatim to all browser clients (for the console).
    2. Accumulate multi-line blocks until the terminal blank line arrives.
    3. Parse complete responses and update _state.
    """
    global _response_accumulator, _in_multiline_response
    global _pending_quiet_transport_blocks, _suppress_current_response_event

    if not _in_multiline_response:
        parts = line.split(" ", 1)
        try:
            code = int(parts[0])
        except (ValueError, IndexError):
            return  # not a response line

        rest = parts[1] if len(parts) > 1 else ""
        suppress_response_event = code == 208 and _pending_quiet_transport_blocks > 0

        if suppress_response_event:
            _pending_quiet_transport_blocks -= 1

        if not suppress_response_event:
            await _broadcaster.broadcast({"type": "raw_line", "line": line})

        if rest.endswith(":"):
            # Start of a multi-line block
            _in_multiline_response = True
            _response_accumulator = [line]
            _suppress_current_response_event = suppress_response_event
        else:
            # Complete single-line response (e.g. "200 ok", "213 deck rebooting")
            await _handle_complete_response(
                code,
                rest,
                {},
                suppress_response_event=suppress_response_event,
            )
    else:
        if not _suppress_current_response_event:
            await _broadcaster.broadcast({"type": "raw_line", "line": line})

        if line == "":
            # Blank line terminates a multi-line block
            code = _parse_response_code(_response_accumulator[0])
            response_text = "\n".join(_response_accumulator[1:])
            key_values = _parse_key_value_block(_response_accumulator[1:])
            _response_accumulator = []
            _in_multiline_response = False
            await _handle_complete_response(
                code,
                response_text,
                key_values,
                suppress_response_event=_suppress_current_response_event,
            )
            _suppress_current_response_event = False
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
    code: int,
    text: str,
    kv: dict[str, str],
    suppress_response_event: bool = False,
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

    # ── 209 notify settings ───────────────────────────────────────────────
    elif code == 209:
        await _enforce_required_notify_settings(kv)

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

    # Broadcast the parsed response as a structured event for the browser.
    # Quiet refreshes suppress raw console lines, but the UI still needs the
    # parsed response signal to clear in-flight state promptly.
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


async def _prime_device_state() -> None:
    """Enable notifications and populate the initial device state for the UI."""
    init_commands = (
        _build_inline_command("notify", AUTO_NOTIFY_OPTIONS),
        "notify",
        "device info",
        "transport info",
        "remote",
        "configuration",
    )

    for init_cmd in init_commands:
        try:
            await _device.send(init_cmd)
            await asyncio.sleep(0.05)
        except Exception as exc:
            log.warning("Initial command failed (%s): %s", init_cmd, exc)


# ---------------------------------------------------------------------------
# Portable config & startup helpers
# ---------------------------------------------------------------------------

_CONFIG_FILENAME = "hyperdeck-vibe.config.json"
_DEFAULT_PORT = 8080
_DEFAULT_CONFIG: dict = {
    "bind_mode": "local",
    "port": _DEFAULT_PORT,
    "auto_open_browser": True,
}


def _get_static_dir() -> str:
    """Return the static/ directory, working in both source and PyInstaller builds."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        base = sys._MEIPASS  # type: ignore[attr-defined]
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "static")


def _is_macos_app_bundle() -> bool:
    """Return True when running inside a macOS .app bundle (frozen build)."""
    if sys.platform != "darwin" or not getattr(sys, "frozen", False):
        return False
    exe = os.path.abspath(sys.executable)
    return any(part.endswith(".app") for part in exe.split(os.sep))


def _macos_app_container_dir() -> str:
    """
    For macOS .app bundles, return the directory *containing* the .app.
    e.g. if exe is /Users/foo/Desktop/HyperDeck Vibe.app/Contents/MacOS/HyperDeckVibe
    this returns /Users/foo/Desktop.
    """
    path = os.path.abspath(sys.executable)
    while path and path != os.sep:
        path = os.path.dirname(path)
        if path.endswith(".app"):
            return os.path.dirname(path)
    return os.path.dirname(os.path.abspath(sys.executable))


def _get_portable_dir() -> str:
    """
    Return the preferred 'portable' directory for config storage.

    - macOS .app bundle  →  directory containing the .app (not inside the bundle)
    - Frozen Windows/Linux  →  directory of sys.executable
    - Source run  →  directory of this file
    """
    if getattr(sys, "frozen", False):
        if _is_macos_app_bundle():
            return _macos_app_container_dir()
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _get_os_user_config_dir() -> str:
    """Return the OS-appropriate user config directory as a fallback."""
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "HyperDeckVibe")
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(appdata, "HyperDeckVibe")
    xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(xdg, "HyperDeckVibe")


def _is_dir_writable(directory: str) -> bool:
    """Return True if *directory* is writable (creating it first if needed)."""
    try:
        os.makedirs(directory, exist_ok=True)
        test = os.path.join(directory, ".write_test_hdv")
        with open(test, "w") as fh:
            fh.write("")
        os.remove(test)
        return True
    except OSError:
        return False


def _resolve_config_path() -> str:
    """
    Determine the config file path, preferring the portable location.
    Falls back to the OS user config dir if the portable location is not writable,
    printing a clear message to the console.
    """
    portable_dir = _get_portable_dir()
    portable_path = os.path.join(portable_dir, _CONFIG_FILENAME)

    # If config already exists there, use it regardless of write permission
    if os.path.isfile(portable_path):
        return portable_path

    # Prefer portable location if writable
    if _is_dir_writable(portable_dir):
        return portable_path

    # Fall back to OS user config directory
    user_dir = _get_os_user_config_dir()
    user_path = os.path.join(user_dir, _CONFIG_FILENAME)
    print()
    print("  NOTE: The app folder is not writable. Config will be saved to:")
    print(f"        {user_path}")
    print("  To enable portable mode (config travels with the app), move the app")
    print("  to a writable folder such as your Desktop or a USB drive.")
    print()
    return user_path


def _load_config(config_path: str) -> dict:
    """Load config JSON, filling in defaults for any missing keys."""
    config = dict(_DEFAULT_CONFIG)
    if os.path.isfile(config_path):
        try:
            with open(config_path) as fh:
                data = json.load(fh)
            config.update(data)
        except (json.JSONDecodeError, OSError) as exc:
            print(f"  WARNING: Could not read config ({exc}). Using defaults.")
    return config


def _save_config(config_path: str, config: dict) -> None:
    """Write the config dict to disk as JSON."""
    try:
        parent = os.path.dirname(config_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(config_path, "w") as fh:
            json.dump(config, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        print(f"  WARNING: Could not save config ({exc}).")


def _run_first_time_setup(config_path: str) -> dict:
    """Interactive console first-run setup. Returns the saved config dict."""
    print()
    print("=" * 60)
    print("  HyperDeck Vibe — First-run setup")
    print("=" * 60)
    print()
    print("Who should be able to open the controller UI?")
    print("  1) This computer only (recommended)")
    print("  2) Other devices on my local network (LAN)")
    print()

    while True:
        raw = input("  Choose 1 or 2 [1]: ").strip()
        if raw in ("", "1"):
            bind_mode = "local"
            break
        if raw == "2":
            bind_mode = "lan"
            break
        print("  Please enter 1 or 2.")

    print()
    while True:
        raw = input(f"  Preferred web port [{_DEFAULT_PORT}]: ").strip()
        if raw == "":
            port = _DEFAULT_PORT
            break
        try:
            port = int(raw)
            if 1 <= port <= 65535:
                break
            print("  Please enter a port between 1 and 65535.")
        except ValueError:
            print("  Please enter a valid port number.")

    print()
    while True:
        raw = input("  Open the UI in your browser automatically? (Y/n) [Y]: ").strip().lower()
        if raw in ("", "y", "yes"):
            auto_open = True
            break
        if raw in ("n", "no"):
            auto_open = False
            break
        print("  Please enter Y or n.")

    config: dict = {"bind_mode": bind_mode, "port": port, "auto_open_browser": auto_open}
    _save_config(config_path, config)
    print()
    print(f"  Settings saved to: {config_path}")
    print()
    return config


def _is_port_free(host: str, port: int) -> bool:
    """Return True if *host*:*port* is available to bind.

    Always probes on 127.0.0.1 to avoid binding a transient diagnostic
    socket to all interfaces. A port in use on any interface will also
    conflict on loopback on the same machine.
    """
    probe_host = "127.0.0.1"
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((probe_host, port))
            return True
        except OSError:
            return False


def _find_free_port(host: str) -> int:
    """Find any available port (probes on loopback to avoid binding to all interfaces)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _choose_port(bind_host: str, preferred: int, config_path: str, config: dict) -> int:
    """
    Return a port to use, prompting the user if the preferred one is taken.
    Saves the chosen port back to config if it differs from the preferred.
    """
    if _is_port_free(bind_host, preferred):
        return preferred

    print()
    print(f"  Port {preferred} is already in use.")
    while True:
        free = _find_free_port(bind_host)
        print(f"  Suggested free port: {free}")
        raw = input(f"  Use {free} instead? (Y/n) [Y]: ").strip().lower()

        if raw in ("", "y", "yes"):
            chosen = free
        elif raw in ("n", "no"):
            raw2 = input("  Enter a port number (or press Enter to quit): ").strip()
            if not raw2:
                print("  Exiting.")
                sys.exit(0)
            try:
                chosen = int(raw2)
                if not 1 <= chosen <= 65535:
                    print("  Invalid port number.")
                    continue
            except ValueError:
                print("  Invalid port number.")
                continue
        else:
            continue

        if not _is_port_free(bind_host, chosen):
            print(f"  Port {chosen} is also in use. Please try again.")
            continue

        config["port"] = chosen
        _save_config(config_path, config)
        print(f"  Config updated with new port: {chosen}")
        return chosen


_DNS_PROBE_HOST = "8.8.8.8"  # used only to find the default outgoing interface; no data sent


def _get_lan_ips() -> list[str]:
    """Best-effort detection of local LAN IP addresses."""
    ips: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((_DNS_PROBE_HOST, 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    return ips


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(title="HyperDeck Vibe", description="Web controller for Blackmagic HyperDeck")

_STATIC_DIR = _get_static_dir()
app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def serve_index() -> FileResponse:
    return FileResponse(os.path.join(_STATIC_DIR, "index.html"))


@app.get("/api/connections")
async def get_connections() -> dict:
    """Return saved connection profiles."""
    async with _connections_file_lock:
        return {"connections": _read_connections_file()}


@app.post("/api/connections")
async def create_connection(payload: dict) -> dict:
    """Create a saved connection profile in JSON storage."""
    name = str(payload.get("name", "")).strip()
    host = str(payload.get("host", "")).strip()
    model = str(payload.get("model", "")).strip()
    port = _normalize_port(payload.get("port", HYPERDECK_DEFAULT_PORT))

    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    if not host:
        raise HTTPException(status_code=400, detail="Host is required")

    entry = {
        "id": str(uuid.uuid4()),
        "name": name,
        "host": host,
        "port": port,
        "model": model,
    }

    async with _connections_file_lock:
        connections = _read_connections_file()
        connections.append(entry)
        _write_connections_file(connections)

    return {"ok": True, "connection": entry}


@app.delete("/api/connections/{connection_id}")
async def delete_connection(connection_id: str) -> dict:
    """Delete a saved profile by ID."""
    async with _connections_file_lock:
        connections = _read_connections_file()
        updated = [c for c in connections if str(c.get("id", "")) != connection_id]
        if len(updated) == len(connections):
            raise HTTPException(status_code=404, detail="Connection not found")
        _write_connections_file(updated)

    return {"ok": True}


@app.put("/api/connections/reorder")
async def reorder_connections(payload: dict) -> dict:
    """Persist a new ordering of saved profiles by ID list."""
    ids = payload.get("ids")
    if not isinstance(ids, list) or not ids:
        raise HTTPException(status_code=400, detail="ids must be a non-empty list")

    ids = [str(item) for item in ids]

    async with _connections_file_lock:
        existing = _read_connections_file()
        by_id = {str(entry.get("id", "")): entry for entry in existing}

        if set(ids) != set(by_id.keys()):
            raise HTTPException(status_code=400, detail="ids must match current saved entries")

        reordered = [by_id[item_id] for item_id in ids]
        _write_connections_file(reordered)

    return {"ok": True}


@app.patch("/api/connections/model")
async def update_connection_model(payload: dict) -> dict:
    """Update model for saved entries matching host/port after successful connect."""
    host = str(payload.get("host", "")).strip()
    model = str(payload.get("model", "")).strip()
    port = _normalize_port(payload.get("port", HYPERDECK_DEFAULT_PORT))

    if not host or not model:
        raise HTTPException(status_code=400, detail="Host and model are required")

    updated_count = 0
    async with _connections_file_lock:
        connections = _read_connections_file()
        for entry in connections:
            entry_host = str(entry.get("host", "")).strip()
            try:
                entry_port = int(entry.get("port", HYPERDECK_DEFAULT_PORT))
            except (ValueError, TypeError):
                entry_port = HYPERDECK_DEFAULT_PORT

            if entry_host == host and entry_port == port:
                if str(entry.get("model", "")).strip() != model:
                    entry["model"] = model
                updated_count += 1
        if updated_count > 0:
            _write_connections_file(connections)

    return {"ok": True, "updated": updated_count}


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
                    await _prime_device_state()
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
                quiet = bool(message.get("quiet", False))
                if not command:
                    continue
                if not _device.connected:
                    await _broadcaster.send_to(
                        websocket,
                        {"type": "error", "message": "Not connected to a HyperDeck"},
                    )
                    continue
                try:
                    if quiet and command.lower() == "transport info":
                        global _pending_quiet_transport_blocks
                        _pending_quiet_transport_blocks += 1
                    await _device.send(command)
                    # Echo back so the console shows what was sent
                    if not quiet:
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
    # ── CLI argument parsing ───────────────────────────────────────────────
    parser = argparse.ArgumentParser(
        description="HyperDeck Vibe — web controller for Blackmagic HyperDeck recorders"
    )
    parser.add_argument(
        "--setup", action="store_true",
        help="Re-run the first-run setup prompt even if a config file already exists.",
    )
    bind_group = parser.add_mutually_exclusive_group()
    bind_group.add_argument(
        "--lan", action="store_true",
        help="Bind to all interfaces (LAN mode) — overrides config.",
    )
    bind_group.add_argument(
        "--local", action="store_true", dest="local",
        help="Bind to 127.0.0.1 only (local mode) — overrides config.",
    )
    parser.add_argument(
        "--port", type=int, metavar="PORT",
        help="Web UI port — overrides config.",
    )
    parser.add_argument(
        "--no-browser", action="store_true",
        help="Do not open the browser automatically — overrides config.",
    )
    args = parser.parse_args()

    # ── Config resolution ─────────────────────────────────────────────────
    config_path = _resolve_config_path()
    config_exists = os.path.isfile(config_path)

    if args.setup or not config_exists:
        config = _run_first_time_setup(config_path)
    else:
        config = _load_config(config_path)

    # ── Apply CLI overrides ───────────────────────────────────────────────
    if args.lan:
        config["bind_mode"] = "lan"
    elif args.local:
        config["bind_mode"] = "local"
    if args.port is not None:
        config["port"] = args.port
    if args.no_browser:
        config["auto_open_browser"] = False

    bind_mode: str = config.get("bind_mode", "local")
    preferred_port: int = int(config.get("port", _DEFAULT_PORT))
    auto_open: bool = bool(config.get("auto_open_browser", True))

    # ── Host binding ──────────────────────────────────────────────────────
    bind_host = "0.0.0.0" if bind_mode == "lan" else "127.0.0.1"

    # ── Port selection with conflict detection ────────────────────────────
    port = _choose_port(bind_host, preferred_port, config_path, config)

    # ── Print startup URLs ────────────────────────────────────────────────
    local_url = f"http://127.0.0.1:{port}/"
    print()
    print(f"  HyperDeck Vibe starting on {local_url}")

    if bind_mode == "lan":
        lan_ips = _get_lan_ips()
        if lan_ips:
            print("  LAN access enabled — on other devices, open:")
            for ip in lan_ips:
                print(f"    http://{ip}:{port}/")
        else:
            print("  LAN access enabled — could not detect local IP address.")
    else:
        print("  Access is limited to this computer (local mode).")
        print("  Run with --lan or re-run --setup to enable LAN access.")

    print()

    # ── Open browser ──────────────────────────────────────────────────────
    if auto_open:
        webbrowser.open(local_url)

    # ── Start Uvicorn ─────────────────────────────────────────────────────
    uvicorn.run(
        app,
        host=bind_host,
        port=port,
        reload=False,
        log_level="info",
    )
