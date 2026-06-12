import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_ROOT = fs.existsSync(path.join(__dirname, "dist")) ? path.join(__dirname, "dist") : "/srv";
const STATIC_ROOT = path.resolve(process.env.BUYADS_STATIC_ROOT || DEFAULT_STATIC_ROOT);
const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const RELAY_NOTIFY_PATH = "/api/yourls-wake/notify";
const RELAY_WAIT_PATH = "/api/yourls-wake/wait";
const RELAY_HEALTH_PATH = "/api/yourls-wake/health";

let wakeSeq = 0;
let waiters = new Set();

function envValue(name) {
  return String(process.env[name] || "").trim();
}

function maskToken(token) {
  if (!token) return "(unset)";
  return `${token.slice(0, 6)}... (length=${token.length})`;
}

function logRuntimeEnv() {
  console.error(`[server] SHEETS_WEBAPP_URL = '${envValue("SHEETS_WEBAPP_URL") || "(unset)"}'`);
  console.error(`[server] SHEETS_TOKEN     = '${maskToken(envValue("SHEETS_TOKEN"))}'`);
  console.error(`[server] YOURLS_WAKE_URL = '${envValue("YOURLS_WAKE_URL") || "(relay default)"}'`);
  console.error(`[server] YOURLS_WAKE_TOKEN = '${maskToken(envValue("YOURLS_WAKE_TOKEN"))}'`);
}

function shouldUseRelayWakeUrl(rawWakeUrl) {
  const value = String(rawWakeUrl || "").trim();
  if (!value) return true;
  if (value.startsWith("/")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && envValue("YOURLS_WAKE_ALLOW_HTTP_DIRECT") !== "1";
  } catch {
    return false;
  }
}

function runtimeConfig() {
  const wakeToken = envValue("YOURLS_WAKE_TOKEN");
  const configuredWakeUrl = envValue("YOURLS_WAKE_URL");
  const yourlsWakeUrl = wakeToken && shouldUseRelayWakeUrl(configuredWakeUrl)
    ? RELAY_NOTIFY_PATH
    : configuredWakeUrl;

  return {
    sheetsWebappUrl: envValue("SHEETS_WEBAPP_URL"),
    sheetsToken: envValue("SHEETS_TOKEN"),
    yourlsWakeUrl,
    yourlsWakeToken: wakeToken,
  };
}

function jsonResponse(res, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store, max-age=0",
    ...extraHeaders,
  });
  res.end(body);
}

function textResponse(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function apiCorsHeaders(req) {
  return {
    "Access-Control-Allow-Origin": process.env.YOURLS_WAKE_ALLOWED_ORIGIN || req.headers.origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function tokenFromRequest(req, url) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(url.searchParams.get("token") || "").trim();
}

function authorizeRelay(req, url, res) {
  const expected = envValue("YOURLS_WAKE_TOKEN");
  if (!expected) {
    jsonResponse(res, 500, { ok: false, error: "YOURLS_WAKE_TOKEN is required on Railway" }, apiCorsHeaders(req));
    return false;
  }
  if (tokenFromRequest(req, url) !== expected) {
    jsonResponse(res, 401, { ok: false, error: "unauthorized" }, apiCorsHeaders(req));
    return false;
  }
  return true;
}

function parsePositiveInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function releaseWaiter(waiter, payload) {
  if (!waiters.has(waiter)) return;
  waiters.delete(waiter);
  clearTimeout(waiter.timer);
  jsonResponse(waiter.res, 200, payload, apiCorsHeaders(waiter.req));
}

function notifyWake(req, res) {
  wakeSeq += 1;
  const payload = { ok: true, wake: true, seq: wakeSeq, waiters: waiters.size };
  for (const waiter of Array.from(waiters)) {
    releaseWaiter(waiter, { ok: true, wake: true, seq: wakeSeq });
  }
  jsonResponse(res, 202, payload, apiCorsHeaders(req));
}

function waitForWake(req, url, res) {
  const since = parsePositiveInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
  const waitSeconds = parsePositiveInt(url.searchParams.get("timeout"), 25, 5, 55);
  if (wakeSeq > since) {
    jsonResponse(res, 200, { ok: true, wake: true, seq: wakeSeq }, apiCorsHeaders(req));
    return;
  }

  const waiter = {
    req,
    res,
    timer: null,
  };
  waiter.timer = setTimeout(() => {
    releaseWaiter(waiter, { ok: true, wake: false, timeout: true, seq: wakeSeq });
  }, waitSeconds * 1000);
  waiters.add(waiter);

  req.on("close", () => {
    if (!res.writableEnded && waiters.has(waiter)) {
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
    }
  });
}

function handleWakeApi(req, url, res) {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 200, { ok: true }, apiCorsHeaders(req));
    return true;
  }
  if (url.pathname === RELAY_HEALTH_PATH) {
    if (!authorizeRelay(req, url, res)) return true;
    jsonResponse(res, 200, { ok: true, seq: wakeSeq, waiters: waiters.size }, apiCorsHeaders(req));
    return true;
  }
  if (url.pathname !== RELAY_NOTIFY_PATH && url.pathname !== RELAY_WAIT_PATH) return false;
  if (!authorizeRelay(req, url, res)) return true;
  if (url.pathname === RELAY_NOTIFY_PATH) {
    if (req.method !== "POST") {
      jsonResponse(res, 405, { ok: false, error: "method not allowed" }, apiCorsHeaders(req));
      return true;
    }
    notifyWake(req, res);
    return true;
  }
  if (req.method !== "GET") {
    jsonResponse(res, 405, { ok: false, error: "method not allowed" }, apiCorsHeaders(req));
    return true;
  }
  waitForWake(req, url, res);
  return true;
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  }[ext] || "application/octet-stream";
}

function cacheControl(filePath) {
  const base = path.basename(filePath);
  if (base === "index.html" || base === "version.txt") return "no-cache";
  if (base === "app.js" || base === "styles.css") return "public, max-age=3600";
  return "public, max-age=300";
}

function staticPathFromUrl(url) {
  let rawPath;
  try {
    rawPath = decodeURIComponent(url.pathname);
  } catch {
    return "";
  }
  const normalized = path.normalize(rawPath).replace(/^([/\\])+/, "");
  const relative = normalized || "index.html";
  return path.join(STATIC_ROOT, relative);
}

function isInsideStaticRoot(filePath) {
  const relative = path.relative(STATIC_ROOT, filePath);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function serveRuntimeConfig(res) {
  const body = `globalThis.__BUYADS_CONFIG__=${JSON.stringify(runtimeConfig())};\n`;
  textResponse(res, 200, body, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
  });
}

function serveStatic(req, url, res) {
  if (url.pathname === "/config.js") {
    serveRuntimeConfig(res);
    return;
  }

  let filePath = staticPathFromUrl(url);
  if (!filePath) {
    textResponse(res, 400, "Bad request\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  if (!isInsideStaticRoot(filePath)) {
    textResponse(res, 403, "Forbidden\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      textResponse(res, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Content-Length": data.length,
      "Cache-Control": cacheControl(filePath),
    });
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(data);
    }
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (handleWakeApi(req, url, res)) return;
  if (req.method !== "GET" && req.method !== "HEAD") {
    textResponse(res, 405, "Method not allowed\n", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  serveStatic(req, url, res);
});

logRuntimeEnv();
server.listen(PORT, "0.0.0.0", () => {
  console.error(`[server] buyads listening on :${PORT}`);
  console.error(`[server] Yourls wake relay notify: ${RELAY_NOTIFY_PATH}`);
  console.error(`[server] Yourls wake relay wait: ${RELAY_WAIT_PATH}`);
});
