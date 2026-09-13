# HyperDeck Vibe

HyperDeck Vibe is a web controller for Blackmagic HyperDeck recorders.

It gives you a browser-based control surface for transport, clips, slots, disk actions, configuration, and live status.

## What You Need

- Node.js 18 or newer
- A HyperDeck on your network with remote control enabled

## Quick Start

```bash
npm install
npm start
```

Then open your browser to:

- `http://localhost:8080`

## Basic Use

1. Launch the app.
2. Enter your HyperDeck IP address.
3. Click **Connect**.
4. Use the tabs to control playback, recording, and settings.

If you get `111 remote control disabled`, enable remote control on the deck and reconnect.

## Main Features

- Dashboard with live device and transport status
- Transport controls: play, stop, jog, shuttle, goto, play range
- Clip and timeline actions
- Slot and disk tools, including disk format flow
- Configuration controls
- NAS controls
- Live console for command/response visibility

## Settings File

The app stores local settings in `connections.json`.

This file includes:

- Web server host and port
- Saved HyperDeck connections

## Project Layout

- `server.js` - Node.js backend and HyperDeck TCP bridge
- `static/index.html` - web app markup
- `static/style.css` - styling
- `static/app.js` - browser-side app logic
- `test/` - unit and integration tests (run with `npm test`)
- `scripts/setup-hooks.js` - git pre-commit hook installer
- `connections.json` - saved local settings

## License

MIT
