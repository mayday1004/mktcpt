// 合併兩份 buyads JSON:
//   - base = 較完整的舊版本(有 short_url 全套 metadata、amount_twd、monthly_rates)
//   - delta = 較新但被 Sheets pull 汙染的版本(只取它多出來的 ad)
//
// 用法:
//   node scripts/merge-buyads-json.mjs <base.json> <delta.json> <out.json>
//   例: node scripts/merge-buyads-json.mjs "buyads_2026-05.json" "buyads_2026-05 (1).json" buyads_merged.json
//
// 合併規則:
//   1. settings / monthly_budgets / daily_budgets / products / todos / performance_data
//      / budget_changes / report_config 全都用 base 的(較完整,沒被 Sheets pull 洗掉)
//   2. ads:以 base 為主,把 delta 裡 base 沒有的 ad.id 補進去(通常是新建的續費段)
//      若同 id 兩邊都有 → 用 base 的(因為 base 的 short_url metadata 較完整)
//   3. 印出 diff 報告供使用者檢視

import { readFileSync, writeFileSync } from "node:fs";

const [, , basePath, deltaPath, outPath] = process.argv;
if (!basePath || !deltaPath || !outPath) {
  console.error("用法: node scripts/merge-buyads-json.mjs <base.json> <delta.json> <out.json>");
  process.exit(1);
}

const base = JSON.parse(readFileSync(basePath, "utf8"));
const delta = JSON.parse(readFileSync(deltaPath, "utf8"));

const baseAdIds = new Set((base.ads || []).map((a) => a.id));
const deltaAdIds = new Set((delta.ads || []).map((a) => a.id));

const onlyInDelta = (delta.ads || []).filter((a) => !baseAdIds.has(a.id));
const onlyInBase = (base.ads || []).filter((a) => !deltaAdIds.has(a.id));

console.log("=== 合併報告 ===");
console.log(`Base ads: ${baseAdIds.size}`);
console.log(`Delta ads: ${deltaAdIds.size}`);
console.log(`只在 delta 有(會補進去): ${onlyInDelta.length}`);
for (const a of onlyInDelta) {
  console.log(`  + ${a.id}  ${a.ad_code}  ${a.ad_name}  ${a.start_date}~${a.end_date}  ${a.renewal_reason || ""}`);
}
console.log(`只在 base 有(保留): ${onlyInBase.length}`);
for (const a of onlyInBase) {
  console.log(`  - ${a.id}  ${a.ad_code}  ${a.ad_name}  ${a.start_date}~${a.end_date}  ${a.renewal_reason || ""}`);
}

const merged = {
  ...base,
  ads: [...(base.ads || []), ...onlyInDelta],
};

writeFileSync(outPath, JSON.stringify(merged, null, 2), "utf8");
console.log(`\n✓ 已輸出 ${outPath}(共 ${merged.ads.length} 支 ad)`);
console.log("→ 到 設定頁 → 匯入 JSON 把這個檔案丟進去覆寫本地");
console.log("→ 接著按「☁️ 從本地強制覆寫 Sheets」把這份完整資料推回雲端,再清掉所有衝突");
