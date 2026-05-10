import { METRICS, RENEWAL_REASONS } from "../schema.js";

// ── 成效輸入（暫存區 / Apps Script 寫入） ─────────────────────────────
// Apps Script 從外部平台拉數據，寫入此分頁。資料期間由使用者自填起訖日，
// 每週匯入 2 週資料。前端收資料時：
//   1. 用 (廣告代碼 fuzzy-match, 對應產品) + 期間重疊解析到 ad_id
//      fuzzy 規則：去掉可選的 "dh" 前綴與可選的英文字尾後比對基本碼。
//      範例：st100 = dhst100 = st100H = dhst100H；不等於 st1002、dhst1002J。
//   2. 花費由系統內部算（daily_amort × weight × days），不從這裡拿
//   3. 同 (ad_code, 產品) 只保留最新匯入；重名有衝突在預覽 modal 讓使用者選
// 外部來源不會給 花費，故 METRICS 中排除 "花費" 欄。
export const PERF_INPUT_SHEET = "成效輸入";
export const PERF_INPUT_METRICS = METRICS.filter((m) => m !== "花費");
export const PERF_INPUT_HEADERS = [
  "資料起始日", "資料結束日",
  "廣告代碼", "對應產品", "廣告分組",
  ...PERF_INPUT_METRICS,
];

// 將外部後台代碼正規化為基本碼，讓 dh 前綴與英文字尾的變體可以對齊：
//   st100 = dhst100 = st100H = dhst100H → "st100"
//   st1002 / dhst1002J → "st1002"（不會等於 st100）
// 比對時雙邊都用此函式正規化後比較（不分大小寫）。
export function normalizeAdCode(code) {
  let s = String(code || "").trim();
  if (!s) return "";
  s = s.replace(/^dh/i, "");      // 可選 dh 前綴
  s = s.replace(/[a-zA-Z]+$/, ""); // 可選英文字尾（純字母，不含數字）
  return s.toLowerCase();
}

// Sheets cell 容錯轉 YYYY-MM 與 YYYY-MM-DD：
// Apps Script 把日期 cell 序列化為 ISO 字串時，用 Sheet 的 timezone（可能 +8 台北、可能 GMT、可能其他）；
// 前端用 toISOString-style "2026-04-11T16:00:00.000Z" 拿到的是 UTC，**必須用台北時區還原**才能拿到使用者眼中的日期。
//
// 之前用瀏覽器 local 時區（getFullYear/getMonth/getDate）— 對台北使用者沒事，但若使用者在 UTC 時區
// （例如部分伺服器、瀏覽器設定）會 ±1 day。改用 Intl.DateTimeFormat with timeZone: "Asia/Taipei" 永遠對。
const _TPE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Taipei",
  year: "numeric", month: "2-digit", day: "2-digit",
});
function _toTaipeiYmd(d) {
  return _TPE_FMT.format(d);  // "YYYY-MM-DD"
}

export function toYearMonth(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return _toTaipeiYmd(v).slice(0, 7);
  const s = String(v).trim();
  // 純 YYYY-MM 或 YYYY-MM-DD（無時間部分）→ 直接 slice，不過 Date
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s.slice(0, 7);
  // 含時間部分 → 用台北 TZ 還原
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return _toTaipeiYmd(d).slice(0, 7);
  return "";
}

export function toYmd(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return _toTaipeiYmd(v);
  const s = String(v).trim();
  // 純 YYYY-MM-DD → 直接保留（無時區歧義）
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // 含時間 → 台北 TZ 還原
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return _toTaipeiYmd(d);
  return "";
}

// ── 正規化分頁（一般 push/pull 走這些） ────────────────────────────
export const TABLES = [
  {
    name: "產品",
    headers: ["id", "名稱", "類型"],
    toRows: (s) => s.products.map((p) => [p.id, p.name, p.type]),
  },
  {
    // 每產品每月獨立預算，產品分頁移除單一月預算欄位，改用此分頁管理
    name: "產品月預算",
    headers: ["產品ID", "產品名稱", "月份(YYYY-MM)", "月預算(台幣)"],
    toRows: (s) => {
      const rows = [];
      const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
      const budgets = s.monthly_budgets || {};
      for (const [pid, months] of Object.entries(budgets)) {
        for (const [ym, amt] of Object.entries(months)) {
          if (Number.isFinite(amt) && amt > 0) {
            rows.push([pid, nameOf[pid] || "", ym, amt]);
          }
        }
      }
      rows.sort((a, b) => (a[0] + a[2]).localeCompare(b[0] + b[2]));
      return rows;
    },
  },
  {
    // 產品日預算（小島型常用）。若同 (產品, 月份) 在「產品月預算」也有值，
    // 此分頁優先；月預算 = 日預算 × 該月天數。
    name: "產品日預算",
    headers: ["產品ID", "產品名稱", "月份(YYYY-MM)", "日預算(台幣)"],
    toRows: (s) => {
      const rows = [];
      const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
      const budgets = s.daily_budgets || {};
      for (const [pid, months] of Object.entries(budgets)) {
        for (const [ym, amt] of Object.entries(months)) {
          if (Number.isFinite(amt) && amt > 0) {
            rows.push([pid, nameOf[pid] || "", ym, amt]);
          }
        }
      }
      rows.sort((a, b) => (a[0] + a[2]).localeCompare(b[0] + b[2]));
      return rows;
    },
  },
  {
    // 產品月預算分段時序：每筆 = 「於 at_date 起該產品該月預算改為 amount（mode 解讀）」
    // mode = 'monthly'（APP）：amount 是月度目標總額
    // mode = 'daily'（小島）：amount 是每日預算
    name: "產品預算變動",
    headers: ["產品ID", "產品名稱", "月份(YYYY-MM)", "生效日", "金額(台幣)", "模式"],
    toRows: (s) => {
      const rows = [];
      const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
      const typeOf = Object.fromEntries(s.products.map((p) => [p.id, p.type]));
      const bc = s.budget_changes || {};
      for (const [pid, months] of Object.entries(bc)) {
        for (const [ym, arr] of Object.entries(months)) {
          if (!Array.isArray(arr)) continue;
          for (const c of arr) {
            if (!c || !c.at_date || !Number.isFinite(c.amount)) continue;
            const mode = c.mode || (typeOf[pid] === "island" ? "daily" : "monthly");
            rows.push([pid, nameOf[pid] || "", ym, c.at_date, c.amount, mode]);
          }
        }
      }
      rows.sort((a, b) => (a[0] + a[2] + a[3]).localeCompare(b[0] + b[2] + b[3]));
      return rows;
    },
  },
  {
    name: "成效目標",
    headers: ["id", "產品ID", "名稱", "公式", "目標值", "方向"],
    toRows: (s) =>
      s.products.flatMap((p) =>
        (p.performance_targets || []).map((t) => [t.id, p.id, t.name, t.formula, t.goal_value, t.direction])
      ),
  },
  {
    name: "廣告",
    headers: [
      "id", "廣告代碼", "廣告名稱", "廣告分組", "對應產品",
      "幣別", "原幣金額", "原幣→RMB匯率",
      "人民幣金額", "匯率", "台幣金額",
      "開始日期", "結束日期", "攤提天數", "每日攤提(台幣)",
      "購買模式", "續費來源", "調整原因", "鎖定不調整", "禁止挪動", "備註",
    ],
    toRows: (s) => s.ads.map((a) => [
      a.id, a.ad_code, a.ad_name, a.group || "",
      summarizeWeights(a.weights),
      a.currency || "CNY",
      a.amount_orig != null ? a.amount_orig : a.amount_cny,
      a.currency_rate || 1,
      a.amount_cny, a.exchange_rate, a.amount_twd,
      a.start_date, a.end_date, a.amortize_days, a.daily_amort_twd,
      a.purchase_mode || "",
      a.renewal_of || "",
      a.renewal_reason || "初始",
      a.lock_perf_adjust ? "Y" : "",
      a.lock_full ? "Y" : "",
      a.notes || "",
    ]),
  },
  {
    name: "廣告權重",
    headers: ["廣告ID", "廣告代碼", "廣告名稱", "產品ID", "產品名稱", "權重%"],
    toRows: (s) => {
      const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
      return s.ads.flatMap((a) =>
        Object.entries(a.weights || {}).map(([pid, w]) => [
          a.id, a.ad_code, a.ad_name, pid, nameOf[pid] || "", Math.round(Number(w) || 0),
        ])
      );
    },
  },
  {
    // 系統內部維護的成效資料（push 時寫出、pull 時讀回）。
    // 來源是 PERF_INPUT_SHEET 匯入 + 系統算的花費。
    // 不存 廣告名稱 / ad_id — pull 時用 (廣告代碼, 對應產品, 期間重疊) 自動解析回 ad_id 並補上廣告名稱。
    name: "成效資料",
    headers: [
      "廣告代碼", "對應產品", "廣告分組",
      "資料起始日", "資料結束日",
      ...METRICS,
    ],
    toRows: (s) => (s.performance_data || []).map((r) => [
      r.ad_code || "", r.product_id, r.group || "",
      r.period_start, r.period_end,
      ...METRICS.map((m) => (r[m] ?? "")),
    ]),
  },
  {
    name: "待辦",
    headers: ["id", "建立時間", "動作類型", "描述", "狀態"],
    toRows: (s) => (s.todos || []).map((t) => [
      t.id, t.created_at, t.action_type, t.description || "", t.status || "pending",
    ]),
  },
  {
    name: "設定",
    headers: ["key", "value"],
    toRows: (s) => [
      ["current_month", s.settings.current_month || ""],
      ["expense_rate", s.settings.expense_rate ?? 4.8],
      ["income_rate", s.settings.income_rate ?? 4.6],
      ["usdt_to_cny_rate", s.settings.usdt_to_cny_rate ?? 7],
      ["usd_to_twd_rate", s.settings.usd_to_twd_rate ?? 32],
    ],
  },
  {
    // 報表自訂計算欄位（如「首存ROI」）— 公式跨裝置共享。
    // 注意：欄位顯示偏好（hidden_metrics）是裝置端設定，不在這同步。
    name: "報表自訂欄位",
    headers: ["id", "產品ID", "產品名稱", "名稱", "公式", "顯示百分比"],
    toRows: (s) => {
      const rows = [];
      const nameOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      const rc = s.report_config || {};
      for (const [pid, cfg] of Object.entries(rc)) {
        for (const m of (cfg?.custom_metrics || [])) {
          if (!m || !m.name || !m.formula) continue;
          rows.push([m.id || "", pid, nameOf[pid] || "", m.name, m.formula, m.show_as_percent ? "Y" : ""]);
        }
      }
      rows.sort((a, b) => (a[1] + a[3]).localeCompare(b[1] + b[3]));
      return rows;
    },
  },
];

// "AV9:50, HYC:30, PJ8:20" 人眼易讀的對應產品摘要（整數百分比）
function summarizeWeights(weights) {
  if (!weights) return "";
  const entries = Object.entries(weights)
    .filter(([, v]) => Number(v) > 0)
    .sort(([, a], [, b]) => b - a);
  return entries.map(([pid, w]) => `${pid}:${Math.round(Number(w) || 0)}`).join(", ");
}

export function assembleFromTables(raw) {
  const pick = (name) => raw[name] || { headers: [], rows: [] };
  const toObj = (headers, row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]));

  const prodT = pick("產品");
  const products = prodT.rows.map((r) => {
    const o = toObj(prodT.headers, r);
    return {
      id: String(o.id || ""),
      name: String(o["名稱"] || ""),
      type: o["類型"] === "island" ? "island" : "app",
      performance_targets: [],
    };
  });

  const budT = pick("產品月預算");
  const monthly_budgets = {};
  budT.rows.forEach((r) => {
    const o = toObj(budT.headers, r);
    const pid = String(o["產品ID"] || "");
    const ym = toYearMonth(o["月份(YYYY-MM)"]);
    const amt = Number(o["月預算(台幣)"]) || 0;
    if (!pid || !ym || amt <= 0) return;
    if (!monthly_budgets[pid]) monthly_budgets[pid] = {};
    monthly_budgets[pid][ym] = amt;
  });

  const dbudT = pick("產品日預算");
  const daily_budgets = {};
  dbudT.rows.forEach((r) => {
    const o = toObj(dbudT.headers, r);
    const pid = String(o["產品ID"] || "");
    const ym = toYearMonth(o["月份(YYYY-MM)"]);
    const amt = Number(o["日預算(台幣)"]) || 0;
    if (!pid || !ym || amt <= 0) return;
    if (!daily_budgets[pid]) daily_budgets[pid] = {};
    daily_budgets[pid][ym] = amt;
  });

  // 預算變動歷程
  const bcT = pick("產品預算變動");
  const budget_changes = {};
  bcT.rows.forEach((r) => {
    const o = toObj(bcT.headers, r);
    const pid = String(o["產品ID"] || "");
    const ym = toYearMonth(o["月份(YYYY-MM)"]);
    const at = toYmd(o["生效日"]);
    const amt = Number(o["金額(台幣)"]) || 0;
    const modeRaw = String(o["模式"] || "").trim().toLowerCase();
    const mode = modeRaw === "daily" ? "daily" : modeRaw === "monthly" ? "monthly" : "";
    if (!pid || !ym || !at || amt <= 0) return;
    if (!budget_changes[pid]) budget_changes[pid] = {};
    if (!budget_changes[pid][ym]) budget_changes[pid][ym] = [];
    const entry = { at_date: at, amount: amt };
    if (mode) entry.mode = mode;
    budget_changes[pid][ym].push(entry);
  });
  // 排序每個 (pid, ym) 的時序
  for (const pid of Object.keys(budget_changes)) {
    for (const ym of Object.keys(budget_changes[pid])) {
      budget_changes[pid][ym].sort((a, b) => (a.at_date < b.at_date ? -1 : 1));
    }
  }

  const tgtT = pick("成效目標");
  tgtT.rows.forEach((r) => {
    const o = toObj(tgtT.headers, r);
    const p = products.find((x) => x.id === String(o["產品ID"]));
    if (!p) return;
    p.performance_targets.push({
      id: String(o.id || ""),
      name: String(o["名稱"] || ""),
      formula: String(o["公式"] || ""),
      goal_value: Number(o["目標值"]) || 0,
      direction: o["方向"] === "higher_better" ? "higher_better" : "lower_better",
    });
  });

  const adT = pick("廣告");
  const ads = adT.rows.map((r) => {
    const o = toObj(adT.headers, r);
    const reason = String(o["調整原因"] || "初始");
    const cny = Number(o["人民幣金額"]) || 0;
    const currency = String(o["幣別"] || "CNY").toUpperCase() === "USDT" ? "USDT" : "CNY";
    const amountOrig = Number(o["原幣金額"]);
    const currencyRate = Number(o["原幣→RMB匯率"]);
    return {
      id: String(o.id || ""),
      ad_code: String(o["廣告代碼"] || ""),
      ad_name: String(o["廣告名稱"] || ""),
      group: String(o["廣告分組"] || ""),
      currency,
      amount_orig: Number.isFinite(amountOrig) && amountOrig > 0 ? amountOrig : cny,
      currency_rate: Number.isFinite(currencyRate) && currencyRate > 0 ? currencyRate : 1,
      amount_cny: cny,
      exchange_rate: Number(o["匯率"]) || 4.7,
      amount_twd: Number(o["台幣金額"]) || 0,
      start_date: toYmd(o["開始日期"]),
      end_date: toYmd(o["結束日期"]),
      amortize_days: Number(o["攤提天數"]) || 30,
      daily_amort_twd: Number(o["每日攤提(台幣)"]) || 0,
      purchase_mode: String(o["購買模式"] || ""),
      weights: {},
      renewal_of: o["續費來源"] ? String(o["續費來源"]) : null,
      renewal_reason: RENEWAL_REASONS.includes(reason) ? reason : "初始",
      lock_perf_adjust: String(o["鎖定不調整"] || "").trim().toUpperCase() === "Y",
      lock_full: String(o["禁止挪動"] || "").trim().toUpperCase() === "Y",
      notes: String(o["備註"] || ""),
    };
  });

  const wT = pick("廣告權重");
  wT.rows.forEach((r) => {
    const o = toObj(wT.headers, r);
    const ad = ads.find((a) => a.id === String(o["廣告ID"]));
    if (ad) ad.weights[String(o["產品ID"])] = Number(o["權重%"]) || 0;
  });

  const perfT = pick("成效資料");
  const performance_data = perfT.rows.map((r) => {
    const o = toObj(perfT.headers, r);
    const adCode = String(o["廣告代碼"] || "");
    const productId = String(o["對應產品"] || "");
    const periodStart = toYmd(o["資料起始日"]);
    const periodEnd = toYmd(o["資料結束日"]);
    // 用 (廣告代碼, 對應產品, 期間重疊最大者) 解析回 ad_id；廣告名稱由匹配到的廣告補上
    const candidates = ads.filter(
      (a) => a.ad_code === adCode
        && Number(a.weights?.[productId]) > 0
        && a.start_date < periodEnd
        && a.end_date > periodStart
    );
    let pickedAd = null;
    if (candidates.length === 1) {
      pickedAd = candidates[0];
    } else if (candidates.length > 1) {
      let best = candidates[0], bestOverlap = -1;
      for (const a of candidates) {
        const os = a.start_date > periodStart ? a.start_date : periodStart;
        const oe = a.end_date < periodEnd ? a.end_date : periodEnd;
        const overlap = Date.parse(oe) - Date.parse(os);
        if (overlap > bestOverlap) { best = a; bestOverlap = overlap; }
      }
      pickedAd = best;
    }
    // 若無法匹配（例：廣告已刪），仍允許保留紀錄但 ad_id 為空、ad_name 退而求其次以 code 做替代
    const fallbackName = ads.find((a) => a.ad_code === adCode)?.ad_name || "";
    const rec = {
      ad_id: pickedAd?.id || "",
      ad_code: adCode,
      ad_name: pickedAd?.ad_name || fallbackName,
      product_id: productId,
      group: String(o["廣告分組"] || pickedAd?.group || ""),
      period_start: periodStart,
      period_end: periodEnd,
    };
    METRICS.forEach((m) => { rec[m] = Number(o[m]) || 0; });
    return rec;
  });

  const todoT = pick("待辦");
  const todos = todoT.rows.map((r) => {
    const o = toObj(todoT.headers, r);
    return {
      id: String(o.id || ""),
      created_at: String(o["建立時間"] || ""),
      action_type: String(o["動作類型"] || ""),
      description: String(o["描述"] || ""),
      status: o["狀態"] === "done" ? "done" : "pending",
    };
  });

  const settings = {
    current_month: "",
    expense_rate: 4.8,
    income_rate: 4.6,
    usdt_to_cny_rate: 7,
    usd_to_twd_rate: 32,
    monthly_rates: {},
    sheets_webapp_url: "",
    sheets_token: "",
  };
  const setT = pick("設定");
  setT.rows.forEach((r) => {
    const o = toObj(setT.headers, r);
    const v = o.value;
    if (o.key === "current_month") settings.current_month = toYearMonth(v);
    else if (o.key === "expense_rate") settings.expense_rate = Number(v) || 4.8;
    else if (o.key === "income_rate") settings.income_rate = Number(v) || 4.6;
    else if (o.key === "usdt_to_cny_rate") settings.usdt_to_cny_rate = Number(v) || 7;
    else if (o.key === "usd_to_twd_rate") settings.usd_to_twd_rate = Number(v) || 32;
  });

  // 報表自訂欄位（公式跨裝置共享；hidden_metrics 是裝置端設定，不在這裡）
  const rcT = pick("報表自訂欄位");
  const report_config = {};
  rcT.rows.forEach((r) => {
    const o = toObj(rcT.headers, r);
    const pid = String(o["產品ID"] || "");
    const name = String(o["名稱"] || "").trim();
    const formula = String(o["公式"] || "").trim();
    if (!pid || !name || !formula) return;
    if (!report_config[pid]) report_config[pid] = { hidden_metrics: [], custom_metrics: [] };
    report_config[pid].custom_metrics.push({
      id: String(o.id || "") || `cm_${Math.random().toString(36).slice(2, 10)}`,
      name,
      formula,
      show_as_percent: String(o["顯示百分比"] || "").trim().toUpperCase() === "Y",
    });
  });

  return {
    version: 3,
    settings, products, monthly_budgets, daily_budgets, ads, todos, performance_data,
    budget_changes, report_config,
  };
}
