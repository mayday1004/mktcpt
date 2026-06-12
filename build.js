import esbuild from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dist = "dist";
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const t0 = Date.now();

loadLocalEnv(".env.local");

const deploySheetsUrl = readEnv("SHEETS_WEBAPP_URL");
const deploySheetsToken = readEnv("SHEETS_TOKEN");
const deployYourlsWakeToken = readEnv("YOURLS_WAKE_TOKEN");
const deployYourlsWakeUrl = readEnv("YOURLS_WAKE_URL") || (deployYourlsWakeToken ? "/api/yourls-wake/notify" : "");

function loadLocalEnv(fileName) {
  const filePath = path.resolve(fileName);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    process.env[key] = parseEnvValue(rawValue);
  }
}

function parseEnvValue(rawValue) {
  let value = String(rawValue || "").trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
    return quote === '"' ? value.replace(/\\n/g, "\n").replace(/\\"/g, '"') : value;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return "";
}

// Build identifier:用 git short SHA(Railway 會把 commit SHA 帶進 env);
// 沒 git / 不在 CI 時 fallback 用 timestamp。每次 deploy 改變就會觸發前端版本 gate。
function resolveBuildId() {
  const env = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || process.env.COMMIT_SHA;
  if (env) return env.slice(0, 10);
  try {
    return execSync("git rev-parse --short=10 HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString().trim();
  } catch {
    return Date.now().toString(36);
  }
}
const buildId = resolveBuildId();

const result = await esbuild.build({
  entryPoints: ["app/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  legalComments: "none",
  write: false,
  define: {
    __BUYADS_BUILD__: JSON.stringify(buildId),
  },
});
const bundled = result.outputFiles[0].text;
const bundledSize = Buffer.byteLength(bundled);

const shouldObfuscate = process.env.OBFUSCATE_JS === "1";
const finalCode = shouldObfuscate
  ? JavaScriptObfuscator.obfuscate(bundled, {
      compact: true,
      identifierNamesGenerator: "hexadecimal",
      renameGlobals: false,
      stringArray: true,
      stringArrayEncoding: ["base64"],
      stringArrayThreshold: 0.75,
      splitStrings: true,
      splitStringsChunkLength: 10,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
      selfDefending: false,
      controlFlowFlattening: false,
      deadCodeInjection: false,
    }).getObfuscatedCode()
  : bundled;
fs.writeFileSync(path.join(dist, "app.js"), finalCode);

const runtimeConfig = {
  sheetsWebappUrl: deploySheetsUrl,
  sheetsToken: deploySheetsToken,
  yourlsWakeUrl: deployYourlsWakeUrl,
  yourlsWakeToken: deployYourlsWakeToken,
};
fs.writeFileSync(
  path.join(dist, "config.js"),
  `globalThis.__BUYADS_CONFIG__=${JSON.stringify(runtimeConfig)};\n`,
);

const cssSrc = fs.readFileSync("app/styles.css");
fs.writeFileSync(path.join(dist, "styles.css"), cssSrc);

fs.mkdirSync(path.join(dist, "apps-script"), { recursive: true });
fs.copyFileSync("apps-script/Code.gs", path.join(dist, "apps-script", "Code.gs"));

// 用 bundle 內容算 hash 當 cache-buster query。Caddyfile 對 *.js / *.css 設了 max-age=3600,
// 固定檔名遇到 deploy 會讓瀏覽器繼續吃舊版最多 1 小時 — query 一變,瀏覽器就會重抓。
const jsHash = crypto.createHash("sha256").update(finalCode).digest("hex").slice(0, 10);
const cssHash = crypto.createHash("sha256").update(cssSrc).digest("hex").slice(0, 10);

let html = fs.readFileSync("index.html", "utf8");
html = html.replace(/\s*<script\s+src="config\.local\.js"\s+data-dev-config><\/script>\s*/g, "\n");
html = html.replace('href="app/styles.css"', `href="styles.css?v=${cssHash}"`);
html = html.replace(
  /<script\s+type="module"\s+src="app\/main\.js"\s*><\/script>/,
  `<script src="config.js" defer></script>\n  <script src="app.js?v=${jsHash}" defer></script>`,
);
fs.writeFileSync(path.join(dist, "index.html"), html);

// version.txt:給長 tab 偵測用。長 tab 每 30 秒 fetch 一次,內容跟 build id 對不上就 banner 提示重整。
fs.writeFileSync(path.join(dist, "version.txt"), buildId + "\n");

const finalSize = Buffer.byteLength(finalCode);
const deployTag = deploySheetsUrl ? "deploy-config: ON" : "deploy-config: OFF";
const wakeTag = deployYourlsWakeUrl ? "yourls-wake: ON" : "yourls-wake: OFF";
console.log(
  `built in ${Date.now() - t0}ms — bundle ${(bundledSize / 1024).toFixed(1)}kb → ${shouldObfuscate ? "obfuscated" : "minified"} ${(finalSize / 1024).toFixed(1)}kb · ${deployTag} · ${wakeTag} · build ${buildId}`,
);
