import esbuild from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dist = "dist";
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const t0 = Date.now();

const deploySheetsUrl = process.env.SHEETS_WEBAPP_URL || "";
const deploySheetsToken = process.env.SHEETS_TOKEN || "";

const result = await esbuild.build({
  entryPoints: ["app/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  legalComments: "none",
  write: false,
  define: {
    __BUYADS_SHEETS_URL__: JSON.stringify(deploySheetsUrl),
    __BUYADS_SHEETS_TOKEN__: JSON.stringify(deploySheetsToken),
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
html = html.replace('href="app/styles.css"', `href="styles.css?v=${cssHash}"`);
html = html.replace(
  /<script\s+type="module"\s+src="app\/main\.js"\s*><\/script>/,
  `<script src="config.js" defer></script>\n  <script src="app.js?v=${jsHash}" defer></script>`,
);
fs.writeFileSync(path.join(dist, "index.html"), html);

const finalSize = Buffer.byteLength(finalCode);
const deployTag = deploySheetsUrl ? "deploy-config: ON" : "deploy-config: OFF";
console.log(
  `built in ${Date.now() - t0}ms — bundle ${(bundledSize / 1024).toFixed(1)}kb → ${shouldObfuscate ? "obfuscated" : "minified"} ${(finalSize / 1024).toFixed(1)}kb · ${deployTag}`,
);
