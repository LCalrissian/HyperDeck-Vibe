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
Browser ←─── WebSocket ──── Node.js (server.js) ←─── TCP 9993 ──── HyperDeck
```

- `server.js` — Node.js backend; maintains the TCP connection to the HyperDeck,
  parses every response line-by-line, updates a server-side device state model,
  and broadcasts typed JSON messages to all connected browser WebSocket clients.
- `static/index.html` — single-page application structure
- `static/style.css`  — dark broadcast-environment theme
- `static/app.js`     — protocol message router, command builders, UI state binding

## Requirements

- Node.js 18+
- HyperDeck device on the same network with remote control enabled

## Quick start

```bash
npm install
npm start
```

The backend now persists local settings in `connections.json`:

- `server.bind_host` and `server.port` for the Node server bind address/port
- `connections[]` for saved HyperDeck devices (name, host, port, model)

This file is read on startup and kept across launches.

1. Enter the HyperDeck IP address and click **Connect**.
2. If you see error `111 remote control disabled`, click **Enable Remote** on the Dashboard
   or the Remote Control section in the Configuration tab.
3. Use any of the tabs to send commands and monitor device state.


## Persistent Config

`connections.json` is now the single local persistence file for:

- Server binding: `server.bind_host` (`127.0.0.1` or `0.0.0.0`, or another host)
- Server port: `server.port`
- Saved HyperDeck device profiles: `connections[]`

The backend reads this file on startup and writes updates via API calls, so your settings survive across launches.

### File format

```json
{
  "server": {
    "bind_host": "0.0.0.0",
    "port": 8080
  },
  "connections": [
    {
      "id": "uuid",
      "name": "Studio Deck",
      "host": "192.168.1.50",
      "port": 9993,
      "model": "HyperDeck Studio"
    }
  ]
}
```

### Backward compatibility

If `connections.json` contains the older list-only format, the Node backend auto-upgrades it to the new object shape the next time the server starts.

### Updating server bind/port

You can edit `connections.json` directly or call:

- `GET /api/settings`
- `PATCH /api/settings/server`

`PATCH /api/settings/server` returns `restart_required: true` when settings change.

## Protocol notes

- All known response codes (200–226, 500–520, 100–163) are handled.
- Multiline commands (authenticate, nas add/remove/select, slate clips/project/lens)
  are sent as proper protocol blocks terminated with a blank line.
- The format command uses the documented two-step prepare → confirm flow.
- Async notifications (5xx) update the UI in real time without polling.
- The watchdog timer sends a `ping` every 20 seconds to maintain the connection.

## License

MIT

## Native WebView Packaging

If you want a desktop app shell that uses the host OS native webview instead of bundling Chromium, the recommended option is **Tauri**.

- Windows: WebView2
- macOS: WKWebView
- Linux: WebKitGTK

For this project, the practical approach is:

1. Keep `server.js` as the HyperDeck TCP/WebSocket bridge.
2. Run it as a sidecar process from a Tauri desktop wrapper.
3. Load the existing `static/index.html` UI in the Tauri webview.

This gives you a lightweight, cross-platform desktop package while preserving the current web UI.
