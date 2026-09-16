"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      probe.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        if (!port) {
          reject(new Error("Could not determine free port"));
          return;
        }
        resolve(port);
      });
    });
  });
}

function createFakeDeck() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method === "GET" && req.url === "/mounts/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ "name": "UNTITLED-sd1", "type": "directory", "mtime": "Mon, 31 Dec 1979 00:00:00" }]));
        return;
      }
      if (req.method === "GET" && req.url === "/mounts/UNTITLED-sd1/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ "name": "clip.mp4", "type": "file", "mtime": "Mon, 01 Jan 2024 00:00:00", "size": 123456 }]));
        return;
      }
      if (req.method === "GET" && req.url === "/mounts/UNTITLED-sd1/hello.txt") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": "11" });
        res.end("hello world");
        return;
      }
      if (req.method === "GET") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      if (req.method === "DELETE") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<title>200 OK</title>");
        return;
      }
      if (req.method === "MKCOL") {
        res.writeHead(201, { "Content-Type": "text/html" });
        res.end("Created");
        return;
      }
      if (req.method === "PUT") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<title>200 OK</title>");
        return;
      }
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    });
  });
  return { requests, server };
}

test("deck files API proxies to the connected deck's web file manager", async () => {
  const fakePort = await getFreePort();
  const fakeDeck = createFakeDeck();
  await new Promise((resolve) => fakeDeck.server.listen(fakePort, "127.0.0.1", resolve));

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "hyperdeck-vibe-files-test-"));
  const configPath = path.join(tempDir, "connections.json");
  const appPort = await getFreePort();
  await fsp.writeFile(
    configPath,
    `${JSON.stringify({ server: { bind_host: "127.0.0.1", port: appPort }, connections: [] }, null, 2)}\n`,
    "utf8",
  );

  process.env.HYPERDECK_CONFIG_PATH = configPath;
  delete require.cache[require.resolve("../server.js")];
  const mod = require("../server.js");

  try {
    await mod.startServer();
    const base = `http://127.0.0.1:${appPort}`;

    assert.equal(mod.normalizeFilesPath("/a/b"), "/a/b");
    assert.equal(mod.normalizeFilesPath("a/b"), "/a/b");
    assert.throws(() => mod.normalizeFilesPath("/a/../b"), /Invalid path/);
    assert.throws(() => mod.normalizeFilesPath(""), /Path is required/);
    assert.equal(mod.buildDeckMountUrl("/sd1/"), "/mounts/sd1/");
    assert.equal(mod.buildDeckMountUrl("clip.mp4"), "/mounts/clip.mp4");

    const notConnected = await fetch(`${base}/api/files/list?path=${encodeURIComponent("/")}`);
    assert.equal(notConnected.status, 400);
    assert.match((await notConnected.json()).detail, /Not connected/);

    mod.state.is_connected = true;
    mod.state.host = "127.0.0.1";
    mod.setFilesWebPort(fakePort);

    const listRoot = await fetch(`${base}/api/files/list?path=${encodeURIComponent("/")}`);
    assert.equal(listRoot.status, 200);
    const listRootJson = await listRoot.json();
    assert.equal(listRootJson.ok, true);
    assert.equal(listRootJson.entries.length, 1);
    assert.equal(listRootJson.entries[0].name, "UNTITLED-sd1");
    assert.equal(listRootJson.entries[0].type, "directory");

    const listDir = await fetch(`${base}/api/files/list?path=${encodeURIComponent("/UNTITLED-sd1/")}`);
    assert.equal(listDir.status, 200);
    const listDirJson = await listDir.json();
    assert.equal(listDirJson.entries[0].name, "clip.mp4");
    assert.equal(listDirJson.entries[0].size, 123456);

    const traversal = await fetch(`${base}/api/files/list?path=${encodeURIComponent("/../secret")}`);
    assert.equal(traversal.status, 400);
    assert.match((await traversal.json()).detail, /Invalid path/);

    const mkdirRes = await fetch(`${base}/api/files/mkdir?path=${encodeURIComponent("/UNTITLED-sd1/_test_folder")}`, { method: "POST" });
    assert.equal(mkdirRes.status, 200);
    assert.equal((await mkdirRes.json()).ok, true);
    assert.ok(fakeDeck.requests.some((r) => r.method === "MKCOL" && r.url === "/mounts/UNTITLED-sd1/_test_folder"));

    const deleteRes = await fetch(`${base}/api/files/delete?path=${encodeURIComponent("/UNTITLED-sd1/clip.mp4")}`, { method: "DELETE" });
    assert.equal(deleteRes.status, 200);
    assert.equal((await deleteRes.json()).ok, true);
    assert.ok(fakeDeck.requests.some((r) => r.method === "DELETE" && r.url === "/mounts/UNTITLED-sd1/clip.mp4"));

    const deleteMissing = await fetch(`${base}/api/files/delete?path=${encodeURIComponent("/UNTITLED-sd1/missing.mp4")}`, { method: "DELETE" });
    assert.equal(deleteMissing.status, 200);
    const deleteMissingJson = await deleteMissing.json();
    assert.equal(deleteMissingJson.ok, true);

    const downloadRes = await fetch(`${base}/api/files/download?path=${encodeURIComponent("/UNTITLED-sd1/hello.txt")}`);
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers.get("content-disposition"), 'attachment; filename="hello.txt"');
    assert.equal(await downloadRes.text(), "hello world");

    const uploadRes = await fetch(`${base}/api/files/upload?path=${encodeURIComponent("/UNTITLED-sd1/up.bin")}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: "UPLOAD-BYTES-12345",
    });
    assert.equal(uploadRes.status, 200);
    assert.equal((await uploadRes.json()).ok, true);
    const uploaded = fakeDeck.requests.find((r) => r.method === "PUT" && r.url === "/mounts/UNTITLED-sd1/up.bin");
    assert.ok(uploaded, "fake deck should have received the upload");
    assert.equal(uploaded.body.toString("utf8"), "UPLOAD-BYTES-12345");
    assert.equal(Number(uploaded.headers["content-length"]), "UPLOAD-BYTES-12345".length);

    const missingList = await mod.deckFilesList("127.0.0.1", "/missing/", fakePort);
    assert.equal(missingList.ok, false);
    assert.equal(missingList.status, 404);

    const downloadMissing = await fetch(`${base}/api/files/download?path=${encodeURIComponent("/hello.txt")}`);
    assert.equal(downloadMissing.status, 404);
    const downloadMissingJson = await downloadMissing.json();
    assert.equal(downloadMissingJson.ok, false);
  } finally {
    await mod.stopServer();
    mod.state.is_connected = false;
    mod.setFilesWebPort(80);
    await new Promise((resolve) => fakeDeck.server.close(resolve));
    delete process.env.HYPERDECK_CONFIG_PATH;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});