"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const staticDir = path.join(__dirname, "..", "static");
const appSource = fs.readFileSync(path.join(staticDir, "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(staticDir, "index.html"), "utf8");
const cssSource = fs.readFileSync(path.join(staticDir, "style.css"), "utf8");

// Regression tests for cross-file consistency. These ensure fixes like the
// undefined --accent-yellow usage and the orphaned slotInfoResult target stay fixed.

test("every CSS variable used in app.js is defined in style.css", () => {
  const usedVars = new Set([...appSource.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
  assert.ok(usedVars.size > 0, "expected at least one var(--...) reference in app.js");

  const definedVars = new Set([...cssSource.matchAll(/--[\w-]+\s*:/g)].map((m) => m[0].replace(/\s*:/, "")));
  const missing = [...usedVars].filter((v) => !definedVars.has(v));
  assert.deepEqual(missing, [], `CSS variables used in app.js but missing from style.css: ${missing.join(", ")}`);
});

test("every result box targeted by displayResultBox exists in index.html", () => {
  const targetIds = new Set([...appSource.matchAll(/displayResultBox\(\s*(["'])([^"']+)\1/g)].map((m) => m[2]));
  assert.ok(targetIds.size > 0, "expected at least one displayResultBox(...) call in app.js");

  const htmlIds = new Set([...htmlSource.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...targetIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `Result boxes targeted in app.js but missing from index.html: ${missing.join(", ")}`);
});