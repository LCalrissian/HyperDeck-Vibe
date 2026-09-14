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
- Configuration controls, including option to hide GUI features you may not need
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

## ALL TEXT BELOW THIS SECTION WAS HAND WRITTEN - Note from "author" 
This project was written nearly entirely by GitHub Copilot; I essentially gave it the HyperDeck Ethernet Protocol document and asked it to make a full-featured controller using all of the available commands.  I spent a lot of time iterating afterwards with both CoPilot and with OpenCode's Big Pickle, bug testing and refining the interface, and it is working well enough for my own purposes.  I cannot vouch for the quality of the code itself; I suspect it could be better structured for maintainability. 

## KNOWN ISSUES
- When switching between card slots the Timeline is cleared and re-populated with all the clips on the card.  I believe this is a limitation of the deck itself.  It would be interesting to attempt a way to save the Timeline clips / ins and outs and have them persist, or be saved / restored from an external file.   
- This program was developed and tested against a HyperDeck Studio  HD Plus.  I do not have access to other HyperDeck models and this program has not yet been tested with them.
- The NAS and SLATE tabs are completely untested!  They may not work at all.


## TODO
- Test and bug fix the NAS and SLATE tabs.
- Test with other HyperDeck models.

## WISHLIST
- Add a GUI option for Theming.
- Refactor the code in a more logical way.
- Wishlist: Add support for connections to multiple Decks simultaneously, potentially with ability to start/stop playback in unison. 

