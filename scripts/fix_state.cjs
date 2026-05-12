#!/usr/bin/env node
// 用途:把舊版 buyads JSON 升級到支援 is_poquan / parent_product_id / split_pair_id / split_role 的新版
// 同時:對「拆出破圈分流」之後 t-variant 未續段(視為金額已回流 parent)的歷史段補正金額
//
// 用法: node fix_state.js <input.json> <output.json>

const fs = require("fs");

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node fix_state.js <input.json> <output.json>");
  process.exit(1);
}
const [inputPath, outputPath] = args;
const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));

// ───────────────────────────────────────────────────────
// 1) 產品:補 is_poquan / parent_product_id
// ───────────────────────────────────────────────────────
const HARDCODED_POQUAN_PARENT = {
  av9_poquan: "AV9",
  jk_poquan: "JK",
};
for (const p of data.products || []) {
  const isPoq = p.id === "av9_poquan" || p.id === "jk_poquan";
  if (typeof p.is_poquan !== "boolean") p.is_poquan = isPoq;
  if (typeof p.parent_product_id !== "string") {
    p.parent_product_id = isPoq ? (HARDCODED_POQUAN_PARENT[p.id] || "") : "";
  }
  if (typeof p.no_band !== "boolean") {
    p.no_band = isPoq;
  }
}

// ───────────────────────────────────────────────────────
// 2) 廣告:依 ad_code 配對寫 split_pair_id + split_role
//    規則:t-variant = 結尾為 't' 且非 'dh' 結尾,parent = 去掉結尾 't' 對應的代碼
// ───────────────────────────────────────────────────────
function genPairId(parentCode) {
  return `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${parentCode}`;
}

const codeSet = new Set();
for (const a of data.ads || []) {
  if (a.ad_code) codeSet.add(a.ad_code);
}

const pairAssigned = new Set();  // 已經處理過的代碼
for (const code of codeSet) {
  if (pairAssigned.has(code)) continue;
  const lower = code.toLowerCase();
  if (!lower.endsWith("t") || lower.endsWith("dh")) continue;
  const parentCode = code.slice(0, -1);
  if (!codeSet.has(parentCode)) continue;

  const tAds = data.ads.filter((a) => a.ad_code === code);
  const pAds = data.ads.filter((a) => a.ad_code === parentCode);
  if (tAds.some((a) => a.split_pair_id) || pAds.some((a) => a.split_pair_id)) {
    pairAssigned.add(code);
    pairAssigned.add(parentCode);
    continue;
  }
  const pairId = genPairId(parentCode);
  for (const a of pAds) { a.split_pair_id = pairId; a.split_role = "parent"; }
  for (const a of tAds) { a.split_pair_id = pairId; a.split_role = "t_variant"; }
  pairAssigned.add(code);
  pairAssigned.add(parentCode);
  console.log(`配對:${parentCode} (${pAds.length} 段) ↔ ${code} (${tAds.length} 段)  pair_id = ${pairId.slice(0, 20)}…`);
}

// ───────────────────────────────────────────────────────
// 3) 對 t-variant 已結束、parent 仍續段的歷史 mismatches 補正
//    判定:對每個 split pair,掃 parent 的每一段,若該段期間內沒有任何 t-variant 段
//    (= t-variant 已停運),則該 parent 段的 amount 應該 = parent 原 amount + 上一個 t-variant 段的 amount
//    (因為當初拆分流時,parent + t-variant 加總 = 完整廣告金額)
// ───────────────────────────────────────────────────────
function overlapsRange(a, start, end) {
  // a.start_date <= end && a.end_date > start
  return a.start_date <= end && a.end_date > start;
}

const pairIds = new Set();
for (const a of data.ads) {
  if (a.split_pair_id) pairIds.add(a.split_pair_id);
}

for (const pairId of pairIds) {
  const adsInPair = data.ads.filter((a) => a.split_pair_id === pairId);
  const parents = adsInPair.filter((a) => a.split_role === "parent")
    .sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
  const tVariants = adsInPair.filter((a) => a.split_role === "t_variant")
    .sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));

  for (const par of parents) {
    // 找這個 parent 段期間內 active 的 t-variant 段
    const overlappingT = tVariants.filter((t) => overlapsRange(t, par.start_date, par.end_date));

    if (overlappingT.length === 0) {
      // 沒有任何 t-variant active 在這個 parent 段期間 → 視為 t-variant 已停運,amount 應回流到 parent
      // 找最後一個 t-variant 段(在 par.start_date 之前的最近一段),取其 amount
      const lastT = tVariants
        .filter((t) => t.end_date && t.end_date <= par.start_date)
        .sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""))[0];
      if (lastT && Number(lastT.amount_cny) > 0) {
        const oldAmount = Number(par.amount_cny) || 0;
        const tAmount = Number(lastT.amount_cny) || 0;
        const newAmount = oldAmount + tAmount;
        const rate = Number(par.exchange_rate) || 4.7;
        const days = Number(par.amortize_days) || 30;
        par.amount_cny = newAmount;
        par.amount_orig = par.currency === "USDT" ? par.amount_orig : newAmount;
        par.amount_twd = newAmount * rate;
        par.daily_amort_twd = (newAmount * rate) / days;
        console.log(`補正 ${par.ad_code} 段 ${par.start_date}~${par.end_date}: ${oldAmount} → ${newAmount} RMB (回收 t-variant ${lastT.ad_code} ${lastT.start_date}~${lastT.end_date} 的 ${tAmount} RMB)`);
      }
    }
  }
}

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
console.log(`\n✅ 已輸出至 ${outputPath}`);
