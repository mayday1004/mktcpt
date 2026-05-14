#!/usr/bin/env node
// 一次性腳本:批次設定廣告的縮網址類型(L1/L5)與參數(dh+廣告代碼)
// 用法:
//   node scripts/fix_short_urls.cjs <input.json> <output.json>
//
// 邏輯:
//   - MAP 內列出的 ad_code → 設定 short_url_type + short_url_param=dh+ad_code
//   - value 為 null → 清空(不採用),例如 1001 "換包"
//   - MAP 內沒列到的 ad_code → 不動(保留原值)
//   - 同 ad_code 多筆廣告(例 70 有 5 個產品版本)會全部套上同一個 prefix

const fs = require("fs");

// 從使用者表格抽出的對應(L1/L5)
// 註:使用者表格裡 70/829/st100 各列了兩次(L5/L1 衝突),這裡採「最後一筆優先」
//     如有歧義請手動覆寫
const MAP = {
  "70":      ["L1", "dh70"],
  "614":     ["L1", "dh614"],
  "829":     ["L1", "dh829"],
  "878":     ["L5", "dh878"],
  "925":     ["L1", "dh925"],
  "948":     ["L1", "dh948"],
  "949":     ["L1", "dh949"],
  "952":     ["L1", "dh952"],
  "955":     ["L1", "dh955"],
  "960":     ["L1", "dh960"],
  "972":     ["L1", "dh972"],
  "976":     ["L1", "dh976"],
  "977":     ["L1", "dh977"],
  "979":     ["L1", "dh979"],
  "996":     ["L1", "dh996"],
  "1001":    [null, null],            // 不採用(換包)
  "1003":    ["L1", "dh1003"],
  "1004":    ["L1", "dh1004"],
  "1005":    ["L1", "dh1005"],
  "1007":    ["L1", "dh1007"],
  "1008":    ["L1", "dh1008"],
  "1009t":   ["L1", "dh1009t"],       // 目前 JSON 沒這支,先放著
  "st100":   ["L1", "dhst100"],
  "st100dh": ["L5", "dhst100dh"],
  "st201":   ["L1", "dhst201"],
  "st214":   ["L1", "dhst214"],
  "st215":   ["L1", "dhst215"],
  "st225":   ["L1", "dhst225"],
  "st238":   ["L1", "dhst238"],
  "st257":   ["L1", "dhst257"],
  "st273":   ["L1", "dhst273"],
  "st285":   ["L1", "dhst285"],
  "st286":   ["L1", "dhst286"],
  "st287":   ["L1", "dhst287"],
  "st287t":  ["L1", "dhst287t"],
  "st288":   ["L1", "dhst288"],
  "st289":   ["L1", "dhst289"],
  "st289t":  ["L1", "dhst289t"],
  "st290":   ["L1", "dhst290"],
  "st291":   ["L1", "dhst291"],
  "st1002":  ["L1", "dhst1002"],
  "x183":    ["L5", "dhx183"],
};

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Usage: node scripts/fix_short_urls.cjs <input.json> <output.json>");
    process.exit(1);
  }
  const raw = fs.readFileSync(inPath, "utf8");
  const data = JSON.parse(raw);

  const stats = { setL1: 0, setL5: 0, cleared: 0, unchanged: 0, skipped: 0 };
  const changedAds = [];

  for (const ad of data.ads || []) {
    const entry = MAP[ad.ad_code];
    if (!entry) { stats.skipped++; continue; }
    const [type, param] = entry;
    const before = `${ad.short_url_type || ""}/${ad.short_url_param || ""}`;
    if (type === null) {
      if (ad.short_url_type || ad.short_url_param) {
        delete ad.short_url_type;
        delete ad.short_url_param;
        stats.cleared++;
        changedAds.push(`${ad.id} ${ad.ad_code} ${ad.ad_name}: ${before} → (清空)`);
      } else {
        stats.unchanged++;
      }
    } else {
      if (ad.short_url_type === type && ad.short_url_param === param) {
        stats.unchanged++;
      } else {
        ad.short_url_type = type;
        ad.short_url_param = param;
        if (type === "L1") stats.setL1++;
        else if (type === "L5") stats.setL5++;
        changedAds.push(`${ad.id} ${ad.ad_code} ${ad.ad_name}: ${before} → ${type}/${param}`);
      }
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), "utf8");
  console.log(`✅ 輸出:${outPath}`);
  console.log(`   設 L1:${stats.setL1}、設 L5:${stats.setL5}、清空:${stats.cleared}、未變動(已是目標值):${stats.unchanged}、不在 MAP 跳過:${stats.skipped}`);
  console.log("\n變動明細:");
  for (const line of changedAds) console.log("  " + line);
}

main();
