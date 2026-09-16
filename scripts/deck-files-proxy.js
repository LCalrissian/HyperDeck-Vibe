"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 8081;
const DEFAULT_HOST = "127.0.0.1";
const MAX_REQUEST_BODY = 64 * 1024 * 1024;
const MAX_CAPTURE_BODY = 32 * 1024 * 1024;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, host: DEFAULT_HOST, log: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--host") args.host = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
  }
  return args;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
    });
    req.on("end", () => resolve({ buffers: Buffer.concat(chunks), bytes: total }));
    req.on("error", reject);
  });
}

function captureResponseStream(res, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    res.on("data", (chunk) => {
      total += chunk.length;
      if (chunks.length < Math.floor(maxBytes / 65536)) {
        chunks.push(chunk);
        if (chunks.reduce((n, c) => n + c.length, 0) > maxBytes) chunks.length = 0;
      } else if (chunks.length === 0) {
        chunks.push(Buffer.alloc(0));
      }
    });
    res.on("end", () => resolve({ buffers: Buffer.concat(chunks), bytes: total }));
    res.on("error", () => resolve({ buffers: Buffer.alloc(0), bytes: total }));
  });
}

function safeHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const lower = key.toLowerCase();
    if (
      lower === "connection" ||
      lower === "proxy-connection" ||
      lower === "host" ||
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "keep-alive" ||
      lower === "upgrade"
    ) {
      continue;
    }
    out[lower] = headers[key];
  }
  return out;
}

function describeBody(buffer, bytes) {
  let text = null;
  let base64 = null;
  if (bytes <= 512 * 1024) {
    const candidate = buffer.toString("utf8");
    if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(candidate)) {
      text = candidate;
    } else {
      base64 = buffer.toString("base64");
    }
  }
  return { bytes, sampled: bytes > buffer.length, text, base64 };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const logPath = args.log || path.join(process.cwd(), "deck-files-capture.jsonl");
  let seq = 0;

  const server = http.createServer((clientReq, clientRes) => {
    (async () => {
      let pathAndQuery;
      let target;

      if (/^https?:\/\//i.test(clientReq.url)) {
        const targetUrl = new URL(clientReq.url);
        pathAndQuery = `${targetUrl.pathname}${targetUrl.search}`;
        target = { host: targetUrl.hostname, port: Number(targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80)) };
      } else {
        pathAndQuery = clientReq.url;
        if (!args.target) {
          const err = new Error("No target configured for relative-form request");
          err.statusCode = 400;
          throw err;
        }
        const [host, port] = args.target.split(":");
        target = { host, port: Number(port || 80) };
      }

      const reqBody = await readBody(clientReq, MAX_REQUEST_BODY);
      const reqDescription = describeBody(reqBody.buffers, reqBody.bytes);
      const forwardHeaders = safeHeaders(clientReq.headers);
      forwardHeaders.host = `${target.host}:${target.port}`;

      const fwdReq = http.request({
        host: target.host,
        port: target.port,
        method: clientReq.method,
        path: pathAndQuery,
        headers: forwardHeaders,
      });

      const start = Date.now();
      const proxyRes = await new Promise((resolve, reject) => {
        fwdReq.on("response", resolve);
        fwdReq.on("error", reject);
        fwdReq.end(reqBody.buffers);
      });

      const entryPromise = captureResponseStream(proxyRes, MAX_CAPTURE_BODY)
        .then((body) => {
          const resDescription = describeBody(body.buffers, body.bytes);
          const entry = {
            seq: (seq += 1),
            ts: new Date().toISOString(),
            handler: "deck-files-proxy",
            meta: {
              method: clientReq.method,
              sourceUrl: clientReq.url,
              targetHost: target.host,
              targetPort: target.port,
              forwardedPath: pathAndQuery,
            },
            request: {
              headers: forwardHeaders,
              body: reqDescription,
            },
            response: {
              status: proxyRes.statusCode,
              statusMessage: proxyRes.statusMessage,
              headers: proxyRes.headers,
              body: resDescription,
            },
          };
          const short = String(resDescription.text || "").slice(0, 120).replace(/\s+/g, " ");
          console.log(
            `[${entry.seq}] ${clientReq.method} ${clientReq.url} -> ${proxyRes.statusCode} ` +
            `in ${Date.now() - start}ms (req ${reqDescription.bytes}B, res ${body.bytes}B)${short ? ` :: ${short}` : ""}`,
          );
          return new Promise((resolve) => {
            fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, (error) => {
              if (error) console.error("proxy log write failed:", error.message);
              resolve();
            });
          });
        });

      proxyRes.pipe(clientRes);
      await entryPromise;
    })().catch((error) => {
      console.error("Proxy error:", error.message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(error.statusCode || 502, { "Content-Type": "text/plain" });
        clientRes.end(`Proxy error: ${error.message}`);
      } else {
        clientRes.destroy();
      }
    });
  });

  server.listen(args.port, args.host, () => {
    console.log(`deck-files-proxy listening on http://${args.host}:${args.port}`);
    console.log(`logging capture to ${logPath}`);
  });
}

main();