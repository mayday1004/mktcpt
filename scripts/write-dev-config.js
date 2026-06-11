import fs from "node:fs";
import path from "node:path";

loadLocalEnv(".env.local");

const config = {
  sheetsWebappUrl: readEnv("SHEETS_WEBAPP_URL"),
  sheetsToken: readEnv("SHEETS_TOKEN"),
  yourlsWakeUrl: readEnv("YOURLS_WAKE_URL"),
  yourlsWakeToken: readEnv("YOURLS_WAKE_TOKEN"),
};

fs.writeFileSync(
  path.resolve("config.local.js"),
  `globalThis.__BUYADS_CONFIG__=${JSON.stringify(config)};\n`,
);

console.log(
  `wrote config.local.js — sheets=${config.sheetsWebappUrl ? "ON" : "OFF"} yourls-wake=${config.yourlsWakeUrl ? "ON" : "OFF"}`,
);

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

function readEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}
