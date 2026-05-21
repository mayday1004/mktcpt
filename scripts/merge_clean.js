// 合併 buyads_2026-05-15.json (舊但 schema 完整) + buyads_2026-05-21.json (新但 amount_twd 壞掉)
// 產出乾淨可匯入的 buyads_2026-05-21-clean.json
// 規則:
//   - 廣告基本資料以 21 為主(currency/amount_orig/currency_rate/amount_cny/ad_code/dates/weights/...)
//   - amount_twd 一律重算 = amount_cny × exchange_rate
//   - daily_amort_twd 一律重算 = amount_twd / amortize_days
//   - 補回 15 才有的縮網址欄位 (short_url_*) 與 code_at_creation (同 id 才補)
//   - 丟掉 ghost row(沒 ad_code 又沒金額)
//   - settings 以 15 為主(保留 monthly_rates / sheets_webapp_url / short_url_prefix_map),current_month / 匯率用 21 的
//   - todos / performance_data / products 用 21 的較新版,products 順序保 15

import fs from "node:fs";

const aPath = "buyads_2026-05-15.json";
const cPath = "buyads_2026-05-21.json";
const outPath = "buyads_2026-05-21-clean.json";

const a = JSON.parse(fs.readFileSync(aPath, "utf8"));
const c = JSON.parse(fs.readFileSync(cPath, "utf8"));

const isGhost = (ad) =>
  (!ad.ad_code || ad.ad_code === "") &&
  (!ad.ad_name || ad.ad_name === "") &&
  (!ad.amount_cny || ad.amount_cny === 0) &&
  (!ad.amount_twd || ad.amount_twd === 0) &&
  (!ad.start_date || ad.start_date === "");

const round = (n) => Math.round(n * 1000) / 1000;

const aMap = new Map(a.ads.map((x) => [x.id, x]));

const SHORT_URL_FIELDS = [
  "short_url_old_override",
  "short_url_new_override",
  "short_url_old_prefix",
  "short_url_type",
  "short_url_param",
  "short_url_notified",
  "code_at_creation",
  "split_pair_id",
  "split_role",
];

let droppedGhost = 0;
let fixedTwd = 0;
let restoredFromA = 0;

const mergedAds = [];
for (const cAd of c.ads) {
  const aAd = aMap.get(cAd.id);

  // 21 是 ghost row 但 15 有對應正常資料 → 用 15 的資料復原(視為 21 搞壞了)
  if (isGhost(cAd)) {
    if (aAd && !isGhost(aAd)) {
      restoredFromA++;
      mergedAds.push({ ...aAd });
      continue;
    }
    // 完全沒救的 ghost row(15 也沒有 / 也是空殼)→ 丟掉
    droppedGhost++;
    continue;
  }

  const merged = { ...cAd };

  // 補回 15 才有的縮網址 / split_pair / code_at_creation 等欄位
  if (aAd) {
    for (const f of SHORT_URL_FIELDS) {
      if (
        merged[f] === undefined &&
        aAd[f] !== undefined &&
        aAd[f] !== "" &&
        aAd[f] !== null
      ) {
        merged[f] = aAd[f];
      }
    }
  } else {
    // 新廣告:預設空欄位,確保 schema 完整
    for (const f of SHORT_URL_FIELDS) {
      if (merged[f] === undefined) {
        if (f === "short_url_notified") merged[f] = false;
        else merged[f] = "";
      }
    }
  }

  // 重算 amount_twd(優先用 amount_cny × exchange_rate;若兩者皆為 0 才保留 0)
  const rate = Number(merged.exchange_rate) || 4.7;
  const cny = Number(merged.amount_cny) || 0;
  const newTwd = round(cny * rate);
  if (merged.amount_twd !== newTwd) {
    if (cny > 0) fixedTwd++;
    merged.amount_twd = newTwd;
  }

  // 重算 daily_amort_twd
  const days = Number(merged.amortize_days) || 30;
  merged.daily_amort_twd = days > 0 ? newTwd / days : 0;

  mergedAds.push(merged);
}

// settings:以 15 為主,套用 21 的當前狀態(current_month、匯率)
const mergedSettings = {
  ...a.settings,
  current_month: c.settings.current_month ?? a.settings.current_month,
  expense_rate: c.settings.expense_rate ?? a.settings.expense_rate,
  income_rate: c.settings.income_rate ?? a.settings.income_rate,
  usdt_to_cny_rate: c.settings.usdt_to_cny_rate ?? a.settings.usdt_to_cny_rate,
  usd_to_twd_rate: c.settings.usd_to_twd_rate ?? a.settings.usd_to_twd_rate,
};

// products:用 21 的(較新)
const mergedProducts = c.products || a.products;

// performance_data:只用 21 的(204 筆,代表使用者最近的 perf state)
// 15 那 208 筆 period 切法不同(15 是兩週切、21 是一週切),merge 起來會變成重複資料 → 不合併
const mergedPerf = c.performance_data || [];

// todos:用 21 的(較新)
const mergedTodos = c.todos || a.todos || [];

const out = {
  version: 3,
  settings: mergedSettings,
  products: mergedProducts,
  ads: mergedAds,
  todos: mergedTodos,
  performance_data: mergedPerf,
  ...(c.monthly_budgets ? { monthly_budgets: c.monthly_budgets } : {}),
  ...(c.daily_budgets ? { daily_budgets: c.daily_budgets } : {}),
  ...(c.budget_changes ? { budget_changes: c.budget_changes } : {}),
  ...(c.report_config ? { report_config: c.report_config } : {}),
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log("=== 合併完成 ===");
console.log("輸出:", outPath);
console.log("");
console.log("廣告:");
console.log("  原始 21 筆數:", c.ads.length);
console.log("  從 15 復原(21 是 ghost 但 15 有資料):", restoredFromA);
console.log("  丟掉真正空白 ghost:", droppedGhost);
console.log("  最終廣告數:", mergedAds.length);
console.log("  amount_twd 修復筆數:", fixedTwd);
console.log("");
console.log("其他表:");
console.log("  products:", mergedProducts.length);
console.log("  todos:", mergedTodos.length);
console.log("  performance_data:", mergedPerf.length, "(用 21 的;15 那 208 筆 period 切法不同,不合併避免重複)");
console.log("");
console.log("settings.current_month:", mergedSettings.current_month);
console.log("settings.expense_rate:", mergedSettings.expense_rate);
console.log("settings.income_rate:", mergedSettings.income_rate);
console.log("settings.short_url_new_domain:", mergedSettings.short_url_new_domain);
console.log("settings.short_url_prefix_map:", JSON.stringify(mergedSettings.short_url_prefix_map));

// 驗證:沒有 ghost row、沒有 amount_twd=0 但 cny>0
const remainingGhost = mergedAds.filter(isGhost).length;
const remainingBadTwd = mergedAds.filter((x) => x.amount_twd === 0 && x.amount_cny > 0).length;
console.log("");
console.log("=== 驗證 ===");
console.log("剩餘 ghost row:", remainingGhost, "(預期 0)");
console.log("剩餘 amount_twd=0 但 cny>0:", remainingBadTwd, "(預期 0)");
