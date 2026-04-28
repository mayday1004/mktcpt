import esbuild from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";
import fs from "node:fs";
import path from "node:path";

const dist = "dist";
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const t0 = Date.now();

const result = await esbuild.build({
  entryPoints: ["app/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020"],
  legalComments: "none",
  write: false,
});
const bundled = result.outputFiles[0].text;
const bundledSize = Buffer.byteLength(bundled);

const obf = JavaScriptObfuscator.obfuscate(bundled, {
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
});
const finalCode = obf.getObfuscatedCode();
fs.writeFileSync(path.join(dist, "app.js"), finalCode);

fs.copyFileSync("app/styles.css", path.join(dist, "styles.css"));

fs.mkdirSync(path.join(dist, "apps-script"), { recursive: true });
fs.copyFileSync("apps-script/Code.gs", path.join(dist, "apps-script", "Code.gs"));

let html = fs.readFileSync("index.html", "utf8");
html = html.replace('href="app/styles.css"', 'href="styles.css"');
html = html.replace(
  /<script\s+type="module"\s+src="app\/main\.js"\s*><\/script>/,
  '<script src="app.js" defer></script>',
);
fs.writeFileSync(path.join(dist, "index.html"), html);

const finalSize = Buffer.byteLength(finalCode);
console.log(
  `built in ${Date.now() - t0}ms — bundle ${(bundledSize / 1024).toFixed(1)}kb → obfuscated ${(finalSize / 1024).toFixed(1)}kb`,
);
