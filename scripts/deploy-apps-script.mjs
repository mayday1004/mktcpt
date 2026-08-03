#!/usr/bin/env node
// 部署 Apps Script(平常用):把 apps-script/ 的最新程式碼 push 上去,
// 然後更新「同一個 deployment」(deployment ID 固定)。
//
// deployment ID 固定 → /exec 網址永遠不變 → Railway / 設定頁什麼都不用改。
//
// 用法:npm run as:deploy
// 一次性設定見 apps-script/README.md「自動部署(clasp)」段。
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`${label} 不存在:${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} 不是有效 JSON:${file}`);
  }
}

const { scriptId } = readJson(path.join(repoRoot, ".clasp.json"), ".clasp.json");
if (!scriptId || scriptId.startsWith("REPLACE")) {
  fail(".clasp.json 的 scriptId 還沒填。到 Apps Script 編輯器 → 專案設定 → 複製「指令碼 ID」貼進去。");
}

const { deploymentId } = readJson(path.join(repoRoot, "apps-script", "deployment.json"), "apps-script/deployment.json");
if (!deploymentId) fail("apps-script/deployment.json 缺 deploymentId(= /exec 網址中 /macros/s/ 後面那串)。");

const run = (cmd) => execSync(cmd, { stdio: "inherit", cwd: repoRoot });

console.log("→ clasp push(上傳 Code.gs + appsscript.json)");
run("npx --yes @google/clasp push --force");

const desc = `auto-deploy ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
console.log(`→ clasp deploy(沿用同一個 deployment,/exec 網址不變)`);
run(`npx --yes @google/clasp deploy --deploymentId ${deploymentId} --description "${desc}"`);

console.log(`✓ 完成。/exec 網址不變:https://script.google.com/macros/s/${deploymentId}/exec`);
