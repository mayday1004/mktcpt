#!/usr/bin/env node
// 依使用者新規格重新校正 st287 / st289 兩組廣告
// 用法: node fix_st287_st289.cjs <input.json> <output.json>

const fs = require("fs");
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("Usage: node fix_st287_st289.cjs <input.json> <output.json>");
  process.exit(1);
}
const [inputPath, outputPath] = args;
const data = JSON.parse(fs.readFileSync(inputPath, "utf8"));

// ─── 1. 產品:補 is_poquan / parent_product_id ───
const POQUAN_PARENT = { av9_poquan: "AV9", jk_poquan: "JK" };
for (const p of data.products || []) {
  const isPoq = p.id === "av9_poquan" || p.id === "jk_poquan";
  if (typeof p.is_poquan !== "boolean") p.is_poquan = isPoq;
  if (typeof p.parent_product_id !== "string") {
    p.parent_product_id = isPoq ? POQUAN_PARENT[p.id] : "";
  }
}

// ─── 2. 廣告:配對 st287/st287t 與 st289/st289t ───
function genPairId(parentCode) {
  return `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${parentCode}`;
}
function ensurePair(parentCode, tCode) {
  const tAds = data.ads.filter((a) => a.ad_code === tCode);
  const pAds = data.ads.filter((a) => a.ad_code === parentCode);
  if (tAds.some((a) => a.split_pair_id) || pAds.some((a) => a.split_pair_id)) return;
  const pairId = genPairId(parentCode);
  for (const a of pAds) { a.split_pair_id = pairId; a.split_role = "parent"; }
  for (const a of tAds) { a.split_pair_id = pairId; a.split_role = "t_variant"; }
}
ensurePair("st287", "st287t");
ensurePair("st289", "st289t");

// ─── 3. st287 / st289 段資料校正 ───
function updateAd(adId, patch) {
  const a = data.ads.find((x) => x.id === adId);
  if (!a) { console.warn(`✗ 找不到 ${adId}`); return null; }
  Object.assign(a, patch);
  // 重新算 amount_orig / amount_twd / daily_amort_twd
  if (patch.amount_cny !== undefined) {
    const cny = patch.amount_cny;
    const rate = Number(a.exchange_rate) || 4.7;
    const days = Number(a.amortize_days) || 30;
    a.amount_orig = a.currency === "USDT" ? a.amount_orig : cny;
    a.amount_twd = Math.round(cny * rate * 100) / 100;
    a.daily_amort_twd = days > 0 ? Math.round((cny * rate) / days * 100) / 100 : 0;
  }
  // weights 變動時更新 purchase_mode
  if (patch.weights !== undefined) {
    const wk = Object.keys(patch.weights).filter((k) => Number(patch.weights[k]) > 0);
    a.purchase_mode = (wk.length === 1 && Number(patch.weights[wk[0]]) === 100) ? "independent" : "shared";
  }
  console.log(`✓ ${adId} (${a.ad_code} ${a.start_date}~${a.end_date}): RMB=${a.amount_cny}, weights=${JSON.stringify(a.weights)}`);
  return a;
}

// ── st287 第一次採購 4/4-4/10 總額 20,000 RMB(rate 4.7)──
// 4/4-4/8: 一般 88% (17,600) + 破圈 12% (2,400)
updateAd("ad_r70zj2ij98", {
  amount_cny: 17600,
  weights: { AV9: 7, JK: 7, HYC: 45, PJ8: 20, OJI: 7, MYS: 9, XRK: 5 },
});
updateAd("ad_gwc73lhoq4", {
  amount_cny: 2400,
  weights: { av9_poquan: 50, jk_poquan: 50 },
});
// 4/8-4/10: 一般 88% (17,600) + 破圈 12% (2,400)
updateAd("ad_ahkcw1fjdd", {
  amount_cny: 17600,
  weights: { AV9: 6, JK: 6, HYC: 32, PJ8: 36, OJI: 7, MYS: 9, XRK: 4 },
});
updateAd("ad_4xdb4n4h3w", {
  amount_cny: 2400,
  weights: { av9_poquan: 50, jk_poquan: 50 },
});

// ── st287 第二次採購 4/22-5/22 總額 30,000 RMB(rate 4.7)──
// 4/22-5/10: 一般 90% (27,000) + 破圈 10% (3,000)
updateAd("ad_60982164e9", {
  amount_cny: 27000,
  weights: { AV9: 22, PJ8: 12, OJI: 21, MYS: 45 },
});
updateAd("ad_58sho3sc74", {
  amount_cny: 3000,
  weights: { av9_poquan: 100 },
});

// 5/10-5/13: 一般 100% (30,000),t-variant 不續段
updateAd("ad_afewatvj03", {
  end_date: "2026-05-13",
  amount_cny: 30000,
  weights: { AV9: 20, PJ8: 21, OJI: 19, MYS: 40 },
});

// 5/13-5/22: 新增段(parent only,一般 100%)
const refAfewatvj03 = data.ads.find((a) => a.id === "ad_afewatvj03");
const newSt287Seg = {
  id: `ad_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  ad_code: "st287",
  ad_name: refAfewatvj03?.ad_name || "",
  group: refAfewatvj03?.group || "",
  currency: "CNY",
  amount_orig: 30000,
  currency_rate: 1,
  amount_cny: 30000,
  exchange_rate: 4.7,
  amount_twd: 30000 * 4.7,
  start_date: "2026-05-13",
  end_date: "2026-05-22",
  amortize_days: 30,
  daily_amort_twd: (30000 * 4.7) / 30,
  purchase_mode: "shared",
  weights: { AV9: 10, PJ8: 21, OJI: 20, MYS: 40, BS: 9 },
  renewal_of: "ad_afewatvj03",
  renewal_reason: "權重調整",
  lock_perf_adjust: false,
  lock_full: false,
  notes: "",
  eliminated: false,
  split_pair_id: refAfewatvj03?.split_pair_id,
  split_role: "parent",
};
data.ads.push(newSt287Seg);
console.log(`✓ 新增段 ${newSt287Seg.id} (st287 ${newSt287Seg.start_date}~${newSt287Seg.end_date}): RMB=${newSt287Seg.amount_cny}, weights=${JSON.stringify(newSt287Seg.weights)}`);

// ── st289 採購 5/6-6/6 總額 40,000 RMB(rate 4.8)──
// 5/6-5/10: 一般 66% (26,400) + 破圈 34% (13,600)
updateAd("ad_pbqgprd4h6", {
  exchange_rate: 4.8,
  amount_cny: 26400,
  weights: { AV9: 15, JK: 15, HYC: 46, PJ8: 18, MYS: 6 },
});
updateAd("ad_837rcfuack", {
  exchange_rate: 4.8,
  amount_cny: 13600,
  weights: { av9_poquan: 44, jk_poquan: 56 },
});
// 5/10-6/6: 一般 81% (32,400) + 破圈 19% (7,600)
updateAd("ad_j2fzo1co51", {
  exchange_rate: 4.8,
  amount_cny: 32400,
  weights: { AV9: 13, HYC: 43, PJ8: 27, MYS: 17 },
});
updateAd("ad_el4nqi63th", {
  exchange_rate: 4.8,
  amount_cny: 7600,
  weights: { jk_poquan: 100 },
});

fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
console.log(`\n✅ 已輸出至 ${outputPath}`);
