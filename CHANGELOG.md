# Changelog

All notable changes to HyperDeck Vibe are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-15

Initial public release. HyperDeck Vibe is a browser-based control surface for
Blackmagic HyperDeck recorders, bridging the deck's Ethernet protocol (TCP 9993)
to the browser through a Node.js + Express + WebSocket server.

### Added

- **Connection management** - connect to a deck by IP/host, saved connection
  profiles, first-run setup, automatic browser launch, and web-port conflict
  handling. The web-server settings and saved decks persist to `connections.json`.
- **Live dashboard** - device and transport status (model, software/protocol
  version, slot count, unique ID, remote state, reference lock, video format,
  recording status, and clip name).
- **Transport tab** - play, stop, jog, shuttle (with presets), go-to, play range,
  loop and single-clip toggles, and "record with custom clip name".
- **Timeline tab** - live clip list, cue/remove clips, manually add clips, and
  rebuild the timeline.
- **Media tab** - current slot media view, slot selection and active-slot info,
  record spill, add clips by format, and disk format flow.
- **Device tab** - device configuration (video/audio, file format, timecode,
  recording, reference & sync), preview mode, play on startup, play options,
  authenticate, and dynamic range overrides.
- **NAS tab** - NAS status, bookmarks, mount share, network discovery, and
  switching the external slot between NAS and USB.
- **Slate tab** - clip, project, and lens slate fields (experimental).
- **Advanced tab** - utility commands, identify, watchdog, reboot, close
  connection, command-list XML, and a common error-code reference.
- **Console tab** - live protocol console with optional auto-update.
- **Interface preferences** - show/hide tabs and individual GUI cards, pin the
  transport controls or dashboard on mobile, and toggle transport sections.
- **Docker support** - `Dockerfile` and Compose file, published to GHCR, with
  `connections.json` persisted on a named volume via `HYPERDECK_CONFIG_PATH`.
- Unit and integration test suite run with `npm test`.

### Notes

- Developed and tested against a HyperDeck Studio HD Plus; other models are
  untested.
- No authentication; intended for trusted/internal networks only.

## [1.0.1] - 2026-09-16

Focus: the **Media tab** gains a full **Media Browser** ("Deck Files") backed by
the deck's built-in web file manager.

### Added

- **Media Browser card** - replaces the read-only "Current Slot Media" list with
  a browsable file manager that merges the deck's file-manager listing (folders
  first) with the TCP clip list. Includes breadcrumb navigation and a "⬆ Folder
  Up" row when inside a subfolder.
- **Deck file-manager proxy** in `server.js` - new `/api/files/list`,
  `/api/files/mkdir`, `/api/files/delete`, `/api/files/download`, and
  `/api/files/upload` endpoints proxy the deck's undocumented port-80 web file
  manager. The browser cannot call the deck directly because the deck sends no
  CORS headers.
- **File actions** - upload clips, create folders, refresh the listing, download
  individual files, and delete files or folders.
- **Active Recording Slot card** - shows the active slot in its title and hosts
  the slot-select buttons and active-slot info.
- **Per-slot browse buttons** - "View files" browses a slot without making it the
  active slot (read-only). USB is browsed the same way. NAS/USB buttons replace
  the old "Slot 3" button and appear only when that drive is mounted.
- **NAS browsing over TCP** - the NAS share is not exposed by the web API, so its
  listing is read from the `disk list` snapshot; the browser auto-enters NAS mode
  when the external slot becomes the active NAS.
- **Double-click to append** - double-clicking a clip adds it to the timeline.
  Only clips at the mount root of the active slot can be added; folders,
  non-active slots, and subfolders are blocked, matching deck limitations.
- **Sortable columns** - Name, File Format, Video Format, Duration, and File Size
  (click a heading; click again to reverse). Folders always sort by name and stay
  pinned above files.
- **Preferences → Media Tab** - new "Show Media Browser" toggle, plus a "Show
  warning when changing Active Slot" toggle for the timeline-rebuild warning.
- Supporting docs and tooling: `docs/deck-web-api.md` (reverse-engineered deck
  web file-manager API), `scripts/deck-files-proxy.js` (HTTP logging proxy to
  capture the deck's file-manager traffic), and `test/deck-files.test.js`.

### Changed

- Media tab rebuilt around the Media Browser; folder names show an inline folder
  icon in the Name column.
- Media Browser column list no longer includes the ID column.

### Fixed

- NAS Media Browser now displays the NAS share's clips when the NAS becomes the
  active slot; Refresh and column sorting no longer overwrite the NAS listing
  cache with another slot's files.
- Selecting the NAS via the slot switcher or the NAS tab now reliably enters NAS
  browse mode (NAS detection falls back to the live transport device).

### Notes

- The deck refuses to append clips from inside a folder to the timeline
  (`clips add` returns `112 clip not found` for every folder-path variant
  tested), so folder clips cannot be added.
