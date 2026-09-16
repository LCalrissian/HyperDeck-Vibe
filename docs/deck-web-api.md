# HyperDeck Web File Manager API

The Blackmagic HyperDeck ships a small built-in web application on **port 80** that
lets you browse, download, upload, and delete media on its attached storage (SD card
slots and USB drives). It is undocumented and unadvertised; the app behind it calls
itself the "Blackmagic Web File Manager" and is a React SPA served from the deck root.
HyperDeck Vibe surfaces this file manager in the **Media** tab.

All requests below are plain HTTP against the deck (e.g. `http://192.0.2.10`), no
authentication, and the deck does **not** send CORS headers. That last point is why the
browser never talks to the deck directly; HyperDeck Vibe proxies every call through its
own Node server (`/api/files/*`).

Media paths always start *and* end with `/`. The root directory `/` lists the storage
mounts, for example:

```
/UNTITLED-sd1/       (slot 1 SD card)
/UNTITLED-sd2/       (slot 2 SD card)
/usb/8GB_USB/        (USB drive)
```

Usb drive mounts include the product/model name, so a drive's mount name can itself
contain slashes (e.g. `usb/SanDisk_Ultra_...`).

## Endpoints

### List a directory

```
GET /mounts/<path>/
```

Returns a JSON array of entries. Each entry is:

| Field  | Meaning                                                |
| ------ | ------------------------------------------------------ |
| `name` | File or folder name (folders do **not** end in `/`)     |
| `type` | `"file"` or `"directory"`                              |
| `size` | Bytes; **only present on files**                       |
| `mtime`| Last-modified, RFC 1123 date-time (e.g. `Sun, 06 Feb 2022 12:03:44 GMT`) |

Example root listing:

```json
[
  { "name": "UNTITLED-sd1", "type": "directory", "mtime": "Mon, 31 Dec 1979 00:00:00" },
  { "name": "UNTITLED-sd2", "type": "directory", "mtime": "Mon, 31 Dec 1979 00:00:00" },
  { "name": "usb/8GB_USB",  "type": "directory", "mtime": "Mon, 31 Dec 1979 00:00:00" }
]
```

### Download a file

```
GET /mounts/<path>/<file>
```

Returns the raw file bytes. There is no listing envelope, no auth, and no CORS.

### Create a folder

```
MKCOL /mounts/<path>/<name>
```

Empty body. Returns HTTP **201** on success.

### Upload a file

```
PUT /mounts/<path>/<name>
```

Body = the raw file bytes, sent directly as the request body. The deck stores the bytes
as-is; `Content-Type` is ignored (verified: a `multipart/form-data` envelope is stored
verbatim, i.e. the deck does **not** parse multipart). Returns **200 OK**. HTTP **507**
means the destination storage is full.

### Delete a file or folder

```
DELETE /mounts/<path>/<name>
```

Returns **200 OK**. Deleting a **folder deletes its contents recursively** — there is no
`--recursive` flag and no trash.

### Device information (used for diagnostics)

```
GET /admin/api/v1/setupBasic
```

Returns JSON like:

```json
{
  "response": {
    "build": "586FB398",
    "deviceName": "VCR5",
    "hostname": "VCR5",
    "productName": "HyperDeck Studio HD Plus",
    "software": 9.02
  }
}
```

## Notes and quirks

- **No IPv6 / HTTPS / auth.** Port 80 only. Run the app on a trusted LAN.
- The React SPA tracks its current directory via a `?path=` query parameter, which is
  how the path convention was discovered.
- Corporate networks / firewalls that only allow the deck's TCP 9993 remote port will
  also block port 80. HyperDeck Vibe shows "Could not reach the deck's file manager" in
  that case.
- File names and folder names are used verbatim in paths; HyperDeck Vibe percent-encodes
  segments and rejects `..` traversal segments before forwarding.

## App integration

- `server.js` -> `DeckFilesController`-style helpers (`deckWebRequest`, `deckFilesList`,
  `deckFilesMkdir`, `deckFilesDelete`) plus streaming download/upload routes:
  - `GET /api/files/list?path=…`
  - `POST /api/files/mkdir?path=…`
  - `DELETE /api/files/delete?path=…`
  - `GET /api/files/download?path=…` (streams to the browser, `Content-Disposition: attachment`)
  - `PUT /api/files/upload?path=…` (streams the browser's request body through to the deck)
- Every route requires an active deck connection (`requireConnectedDeckHost`).
- Front end: the Media tab's "Current Slot Media" card merges the deck file-manager
  listing (folders first) with the TCP `disk list` clip metadata. Toolbar with mount
  picker/breadcrumbs/upload/new-folder lives in `static/index.html`, logic in
  `static/app.js` (`files*` / `slotMedia*` sections), styles in `static/style.css`.

## How the API was reverse-engineered

1. The deck's SPA bundles (`main.*.js`, `vendor.*.js`) were fetched from the deck and
   beautified; the `blackmagic` util module contained `ajax`, `uploadFile` (raw `PUT`),
   `downloadFile`, and `{method:"MKCOL"}` / `{method:"DELETE"}` helpers.
2. All behaviours above were confirmed against a live deck
   (HyperDeck Studio HD Plus, software 9.0.2) both directly and through
   `scripts/deck-files-proxy.js`, which logs full request/response captures as NDJSON.

## Reproducing captures

```bash
node scripts/deck-files-proxy.js            # listens on 127.0.0.1:8081
node -e "fetch('http://127.0.0.1:8081/mounts/').then(r=>r.text()).then(console.log)"
```

The proxy prints one JSON object per request to stdout and mirrors responses unchanged.