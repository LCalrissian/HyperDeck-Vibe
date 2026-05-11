"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

async function getFreePort() {
  // We ask the OS for an ephemeral port to avoid collisions with local services.
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

test("server starts with isolated config and serves settings + connections APIs", async () => {
  // This is an integration test because it exercises multiple layers together:
  // startup, config loading, HTTP routing, and JSON persistence.
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "hyperdeck-vibe-test-"));
  const configPath = path.join(tempDir, "connections.json");
  const port = await getFreePort();

  const initialConfig = {
    server: { bind_host: "127.0.0.1", port },
    connections: [],
  };

  await fsp.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf8");

  // Point the server module at a test-only config file so this test cannot
  // modify the developer's real connections.json.
  process.env.HYPERDECK_CONFIG_PATH = configPath;
  delete require.cache[require.resolve("../server.js")];
  const mod = require("../server.js");

  try {
    await mod.startServer();

    const settingsRes = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal(settingsRes.status, 200);
    const settings = await settingsRes.json();
    assert.equal(settings.settings.server.bind_host, "127.0.0.1");
    assert.equal(settings.settings.server.port, port);

    const createRes = await fetch("http://127.0.0.1:" + port + "/api/connections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Deck A",
        host: "10.0.0.9",
        port: 9993,
      }),
    });
    assert.equal(createRes.status, 200);

    const listRes = await fetch(`http://127.0.0.1:${port}/api/connections`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    assert.equal(Array.isArray(list.connections), true);
    assert.equal(list.connections.length, 1);
    assert.equal(list.connections[0].name, "Deck A");
  } finally {
    // Cleanup is part of test correctness: always close servers and remove temp
    // files so repeated runs stay reliable.
    await mod.stopServer();
    delete process.env.HYPERDECK_CONFIG_PATH;
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
});
