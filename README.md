# HyperDeck Vibe

HyperDeck Vibe is a web controller for Blackmagic HyperDeck recorders.

It gives you a browser-based control surface for transport, clips, slots, disk actions, configuration, and live status.

## SCREENSHOTS
<kbd>
<img width="909" height="760" alt="image" src="https://github.com/user-attachments/assets/6bd5042c-569d-4e04-a219-ffb276e122ee" />
</kbd><br/><br/>


<kbd>
<img width="1614" height="635" alt="image" src="https://github.com/user-attachments/assets/aebd9fdd-cef2-4890-a861-722a400ceb80" />
</kbd><br/><br/>


<kbd>
<img width="422" height="574" alt="image" src="https://github.com/user-attachments/assets/9fde4541-19ff-436e-ad19-42c31ecb49d5" />
</kbd><br/><br/>

UI is responsive and should also look good on Mobile. 

## What You Need

- Node.js 18 or newer, or Docker
- A HyperDeck on your network with remote control enabled

## Native Install

Unzip into a folder
```bash
npm install
npm start
```

Then open your browser to:

- `http://localhost:8080`

## Docker

Run the whole app in a container — no local Node.js install needed.

Easiest, using the included Compose file:

```bash
docker compose up -d
```

Or with plain Docker:

```bash
docker build -t hyperdeck-vibe .
docker run -d -p 8080:8080 hyperdeck-vibe
```

Then open `http://localhost:8080`.

Notes on the Docker setup:

- Saved connections and server settings are stored in `connections.json`. In Docker this file lives on a named volume at `/app/data/connections.json` (set via the `HYPERDECK_CONFIG_PATH` env var), so your saved decks survive container rebuilds.
- The container serves the UI on port 8080 and reaches your HyperDeck over TCP 9993. On the default bridge network it can usually reach decks on your LAN; on Linux you can switch to `network_mode: host` in Compose if that ever fails.
- The image runs as a non-root user, bundles only runtime dependencies (`npm ci --omit=dev --ignore-scripts`), and does not include the git pre-commit test hook.

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
- Slot and disk tools, NAS connectivity, and disk format flow
- **Deck Files** in the Media tab: the **Media Browser** card merges the deck file-manager listing (folders first, with a ⬆ Folder Up row when inside a subfolder) with the clip list and adds download/delete/upload/create-folder, so you can browse the media mounts on the deck (SD slots and USB drives). Uses the deck's built-in web file manager on port 80; see `docs/deck-web-api.md`. A top **Active Recording Slot** card shows the active slot in its title (e.g. `ACTIVE RECORDING SLOT - SLOT 1 (UNTITLED-SD1)`), the slot-select buttons, and the active slot info; clicking a slot button switches the active slot and points the browser at its files. Changing the active slot always warns that the timeline will be rebuilt (this can be turned off via the **Show warning when changing Active Slot** toggle in Preferences → Media Tab). The **View files** buttons browse the SD slots without making them the active slot, **USB** is browsed read-only the same way, and **NAS**/**USB** replace the old "Slot 3" button (each shown only when that drive is mounted); choosing the NAS when it isn't the active slot warns that it must be made active to browse its files, which rebuilds the timeline. Double-clicks in a folder are blocked because the deck cannot append clips from folders. Media Browser columns sort by Name, File Format, Video Format, Duration, and File Size (click a heading; click again for Z→A; folders always sort by name and stay pinned on top).
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
- `scripts/deck-files-proxy.js` - optional HTTP logging proxy for capturing the deck's file-manager traffic
- `docs/deck-web-api.md` - reverse-engineered docs for the deck's port-80 file manager API
- `connections.json` - saved local settings

## License

MIT

## ALL TEXT BELOW THIS SECTION WAS HAND WRITTEN - Note from "author" 
This project was written nearly entirely by GitHub Copilot; I essentially gave it the HyperDeck Ethernet Protocol document and asked it to make a full-featured controller using all of the available commands.  I spent a lot of time iterating afterwards with both CoPilot and with OpenCode's Big Pickle, bug testing and refining the interface, and it is working well enough for my own purposes.  I cannot vouch for the quality of the code itself; I suspect it could be better structured for maintainability. 

## KNOWN ISSUES
- I DID NOT CHECK THIS CODE FOR SECURITY. There is no user authentication flow.  Use on an internal network only, do not expose this to the internet!
- When switching between card slots the Timeline is cleared and re-populated with all the clips on the card.  I believe this is a limitation of the deck itself.  It would be interesting to attempt a way to save the Timeline clips / ins and outs and have them persist, or be saved / restored from an external file.   
- The deck refuses to append clips from inside a folder to the timeline (`clips add` returns `112 clip not found` for every folder-path variant tested, e.g. `folder1/name.mp4`, `UNTITLED-sd1/folder/name.mp4`). Only clips at the mount root of the active slot can be added, so the app blocks double-clicks on folder clips.   
- This program was developed and tested against a HyperDeck Studio  HD Plus.  I do not have access to other HyperDeck models and this program has not yet been tested with them.
- The SLATE tab is completely untested!  It may not work at all.


## TODO
- Test and bug fix the SLATE tab.
- Test with other HyperDeck models.

## WISHLIST
- Add a GUI option for Theming.
- Refactor the code in a more logical way.
- Add support for connections to multiple Decks simultaneously, potentially with ability to start/stop playback in unison. 

