"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizePort,
  normalizeConfigShape,
  normalizeTransportStatus,
  HYPERDECK_DEFAULT_PORT,
} = require("../server.js");

// Tests for deterministic pure functions with no network or filesystem dependencies.

test("normalizePort accepts valid integer port", () => {
  assert.equal(normalizePort(9993), 9993);
});

test("normalizePort defaults when value is not an integer", () => {
  assert.equal(normalizePort("invalid"), HYPERDECK_DEFAULT_PORT);
});

test("normalizePort throws for out-of-range ports", () => {
  assert.throws(() => normalizePort(70000), /Port must be between 1 and 65535/);
});

test("normalizeConfigShape tolerates invalid stored connection port", () => {
  // This verifies the resilience policy introduced in refactoring:
  // invalid persisted ports should not crash config normalization.
  const normalized = normalizeConfigShape({
    server: { bind_host: "127.0.0.1", port: 8080 },
    connections: [{ id: "a", name: "Deck", host: "10.0.0.8", port: 99999 }],
  });

  assert.equal(normalized.connections.length, 1);
  assert.equal(normalized.connections[0].port, HYPERDECK_DEFAULT_PORT);
});

test("normalizeTransportStatus maps max-speed shuttle to forward", () => {
  assert.equal(normalizeTransportStatus("shuttle", 5000), "forward");
});

test("normalizeTransportStatus maps max-speed shuttle to rewind", () => {
  assert.equal(normalizeTransportStatus("shuttle", -5000), "rewind");
});

test("normalizeTransportStatus maps shuttle at speed 0 to paused", () => {
  assert.equal(normalizeTransportStatus("shuttle", 0), "paused");
});

test("normalizeTransportStatus falls back to status for a bare speed 0 update", () => {
  assert.equal(normalizeTransportStatus(undefined, 0, "shuttle"), "paused");
});

test("normalizeTransportStatus keeps a literal stopped status as stopped", () => {
  assert.equal(normalizeTransportStatus("stopped", 0), "stopped");
});
