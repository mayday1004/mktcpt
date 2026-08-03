#!/usr/bin/env node
// 換一個全新的 /exec 網址。只在「舊網址被 Google 持續回 404 HTML」這類路由故障時用;
// 平常改 Code.gs 請用 npm run as:deploy(同 ID、網址不變)。
//
// 流程:
//   1. clasp push 最新程式碼
//   2. 建「新」deployment(新 /exec 網址)
//   3. 打新網址驗證活著(doGet 回 {"ok":true})
//   4. 寫回 apps-script/deployment.json(之後平常部署就沿用新 ID)
//   5. 更新 .env.local 的 SHEETS_WEBAPP_URL(本機 dev 用,檔案存在才動)
//   6. 用 Railway CLI 更新 SHEETS_WEBAPP_URL 變數 → Railway 自動重佈,前端 config.js 就拿到新網址
//
// 舊 deployment 不刪:同事開著的分頁會繼續打舊網址,等他們重整就切到新的。
//
// 用法:npm run as:rotate-url
// 前置:npx @google/clasp login;Railway 那步需要 npx @railway/cli login + 在 repo 目錄 railway link
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const deploymentFile = path.join(repoRoot, "apps-script", "deployment.json");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const { scriptId } = JSON.parse(fs.readFileSync(path.join(repoRoot, ".clasp.json"), "utf8"));
if (!scriptId || scriptId.startsWith("REPLACE")) {
  fail(".clasp.json 的 scriptId 還沒填。到 Apps Script 編輯器 → 專案設定 → 複製「指令碼 ID」貼進去。");
}
const oldDeploymentId = JSON.parse(fs.readFileSync(deploymentFile, "utf8")).deploymentId || "";

console.log("→ clasp push(上傳最新程式碼)");
execSync("npx --yes @google/clasp push --force", { stdio: "inherit", cwd: repoRoot });

const desc = `rotate-url ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
console.log("→ clasp deploy(建立全新 deployment)");
const out = execSync(`npx --yes @google/clasp deploy --description "${desc}"`, {
  encoding: "utf8",
  cwd: repoRoot,
});
process.stdout.write(out);

// clasp 輸出格式:「- AKfycb... @<version>」
const ids = [...out.matchAll(/(AKfycb[A-Za-z0-9_-]{20,})/g)].map((m) => m[1]);
const newDeploymentId = ids.find((id) => id !== oldDeploymentId);
if (!newDeploymentId) fail("從 clasp 輸出解析不到新的 deployment ID,請把上面輸出貼給工程師看。");

const newUrl = `https://script.google.com/macros/s/${newDeploymentId}/exec`;
console.log(`→ 新網址:${newUrl}`);

// 驗證新網址活著(doGet 應回 {"ok":true,...};部署剛建好偶爾要等幾秒)
let alive = false;
for (let attempt = 1; attempt <= 5 && !alive; attempt++) {
  try {
    const res = await fetch(newUrl, { redirect: "follow" });
    const text = await res.text();
    alive = res.ok && text.includes('"ok":true');
    if (!alive) console.log(`  驗證第 ${attempt} 次:HTTP ${res.status},${text.slice(0, 60)}`);
  } catch (e) {
    console.log(`  驗證第 ${attempt} 次:${e.message}`);
  }
  if (!alive) await new Promise((r) => setTimeout(r, 3000));
}
if (!alive) fail(`新網址 5 次驗證都失敗,先不更新任何設定。手動打開看看:${newUrl}`);
console.log("✓ 新網址驗證通過");

fs.writeFileSync(deploymentFile, JSON.stringify({ deploymentId: newDeploymentId }, null, 2) + "\n");
console.log("✓ 已寫回 apps-script/deployment.json(之後 as:deploy 沿用新 ID)");

const envLocal = path.join(repoRoot, ".env.local");
if (fs.existsSync(envLocal)) {
  const src = fs.readFileSync(envLocal, "utf8");
  const line = `SHEETS_WEBAPP_URL=${newUrl}`;
  const next = /^SHEETS_WEBAPP_URL=.*$/m.test(src)
    ? src.replace(/^SHEETS_WEBAPP_URL=.*$/m, line)
    : src.trimEnd() + "\n" + line + "\n";
  fs.writeFileSync(envLocal, next);
  console.log("✓ 已更新 .env.local 的 SHEETS_WEBAPP_URL");
}

console.log("→ 更新 Railway 變數 SHEETS_WEBAPP_URL(會觸發自動重佈)");
try {
  execSync(`npx --yes @railway/cli variables --set "SHEETS_WEBAPP_URL=${newUrl}"`, {
    stdio: "inherit",
    cwd: repoRoot,
  });
  console.log("✓ Railway 變數已更新,等重佈完成後同事重整頁面即切到新網址");
} catch {
  console.error("✗ Railway CLI 失敗(還沒 login / link?)。請手動到 Railway 把 SHEETS_WEBAPP_URL 改成:");
  console.error(`  ${newUrl}`);
  console.error("  之後跑一次:npx @railway/cli login && npx @railway/cli link,下次就能全自動。");
  process.exit(1);
}
