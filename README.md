# HyperDeck Vibe

A cross-platform web-based controller for [Blackmagic Design HyperDeck](https://www.blackmagicdesign.com/products/hyperdeckstudio) disk recorders.

Built against the **Blackmagic HyperDeck Ethernet Protocol — December 2024** specification.

## Features

- **Dashboard** — complete live state at a glance: timecode, transport status, device info, configuration summary, remote state, and troubleshooting reference
- **Transport** — play (with speed/loop/single-clip/clip-id/timecode parameters), stop, jog, shuttle (with speed presets), goto, playrange, play-on-startup, play-option, preview
- **Clips** — clips get/count/rebuild/clear, clip info, clips add (with trim points), clips remove, record (with optional clip name), record spill
- **Slots / Disk** — slot info, slot select, slot unblock, disk list, external drive management, two-step disk format (prepare → confirm)
- **Configuration** — all `configuration` parameters: video/audio input, file format, audio codec, timecode, recording options, reference/sync, XLR/RCA mapping
- **Notifications** — all 15 asynchronous notification subscriptions (transport, slot, remote, configuration, display timecode, timeline position, playrange, cache, dynamic range, slate, clips, disk, device info, NAS, dropped frames)
- **Dynamic Range** — playback and record override for HDR models
- **Slate** — multiline slate clips, slate project, slate lens metadata
- **NAS** — discover, add/remove bookmark, mount/unmount SMB shares
- **Advanced** — ping, help, commands XML, uptime, cache info, identify, watchdog, reboot, quit, and a raw command input
- **Console** — colour-coded live protocol log with command history (↑/↓) and manual input

## Architecture

```
Browser ←─── WebSocket ──── FastAPI (app.py) ←─── TCP 9993 ──── HyperDeck
```

- `app.py` — FastAPI backend; maintains the TCP connection to the HyperDeck,
  parses every response line-by-line, updates a server-side device state model,
  and broadcasts typed JSON messages to all connected browser WebSocket clients.
- `static/index.html` — single-page application structure
- `static/style.css`  — dark broadcast-environment theme
- `static/app.js`     — protocol message router, command builders, UI state binding

## Requirements

- Python 3.10+
- HyperDeck device on the same network with remote control enabled

## Quick start

```bash
pip install -r requirements.txt
python app.py
```

On first run you will be prompted to configure the app (see [First-run setup](#first-run-setup)). After that the browser opens automatically to the controller UI.

1. Enter the HyperDeck IP address and click **Connect**.
2. If you see error `111 remote control disabled`, click **Enable Remote** on the Dashboard
   or the Remote Control section in the Configuration tab.
3. Use any of the tabs to send commands and monitor device state.

## First-run setup

When `hyperdeck-vibe.config.json` is not found, the app runs an interactive console wizard:

```
HyperDeck Vibe — First-run setup
==================================================

Who should be able to open the controller UI?
  1) This computer only (recommended)
  2) Other devices on my local network (LAN)

  Choose 1 or 2 [1]:
  Preferred web port [8080]:
  Open the UI in your browser automatically? (Y/n) [Y]:
```

Answers are saved to `hyperdeck-vibe.config.json` (see [Portable config](#portable-config)).
To re-run the wizard at any time, pass `--setup`:

```bash
python app.py --setup
```

## Portable config

Settings are stored in `hyperdeck-vibe.config.json` alongside the application so the whole
folder can be copied to another machine and it will start with the same settings.

| Platform | Portable location | Fallback location (if portable folder is not writable) |
|----------|-------------------|--------------------------------------------------------|
| Windows / Linux | Same folder as the executable | `%APPDATA%\HyperDeckVibe\` / `~/.config/HyperDeckVibe/` |
| macOS (`.app` bundle) | Folder **containing** the `.app` | `~/Library/Application Support/HyperDeckVibe/` |
| Source (`python app.py`) | Same folder as `app.py` | (same OS fallbacks as above) |

When the app cannot write to the portable location (e.g. the `.app` is in `/Applications`, or
the exe is in `Program Files`) it falls back automatically and prints a message explaining
where config was saved and how to restore portable behaviour.

Example fallback message:

```
  NOTE: The app folder is not writable. Config will be saved to:
        /Users/alice/Library/Application Support/HyperDeckVibe/hyperdeck-vibe.config.json
  To enable portable mode (config travels with the app), move the app
  to a writable folder such as your Desktop or a USB drive.
```

### Config file format

```json
{
  "bind_mode": "local",
  "port": 8080,
  "auto_open_browser": true
}
```

Edit the file directly to change settings, or pass `--setup` to re-run the wizard.

## Local-only vs LAN mode

| Mode | Uvicorn binds to | Who can access the UI |
|------|------------------|-----------------------|
| `local` (default) | `127.0.0.1` | Only the computer running the app |
| `lan` | `0.0.0.0` | Any device on the same local network |

In **LAN mode** the app prints the reachable URLs for other devices:

```
  HyperDeck Vibe starting on http://127.0.0.1:8080/
  LAN access enabled — on other devices, open:
    http://192.168.1.50:8080/
```

The local browser always opens `http://127.0.0.1:<port>/` regardless of mode.

> **Security note:** LAN mode exposes the controller to any device on the same Wi-Fi or
> Ethernet segment. Use it only on trusted networks.

## CLI flags

| Flag | Description |
|------|-------------|
| `--setup` | Re-run the first-run setup wizard (re-prompts all questions and saves new config). |
| `--lan` | Force LAN mode for this run (overrides config). |
| `--local` | Force local-only mode for this run (overrides config). |
| `--port PORT` | Use the specified port (overrides config). |
| `--no-browser` | Do not open the browser automatically (overrides config). |

Examples:

```bash
# Re-run setup to change bind mode or port
python app.py --setup

# Start in LAN mode on port 9000 without opening the browser
python app.py --lan --port 9000 --no-browser
```

## Port conflict handling

If the configured port is already in use, the app finds a free port and prompts you:

```
  Port 8080 is already in use.
  Suggested free port: 51327
  Use 51327 instead? (Y/n) [Y]:
```

Accepting updates the config file so the next launch uses the new port automatically.
If you decline, you can enter any port number or press Enter to quit.

## Protocol notes

- All known response codes (200–226, 500–520, 100–163) are handled.
- Multiline commands (authenticate, nas add/remove/select, slate clips/project/lens)
  are sent as proper protocol blocks terminated with a blank line.
- The format command uses the documented two-step prepare → confirm flow.
- Async notifications (5xx) update the UI in real time without polling.
- The watchdog timer sends a `ping` every 20 seconds to maintain the connection.

## License

MIT
