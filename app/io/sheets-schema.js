import { METRICS, RENEWAL_REASONS } from "../schema.js";
import { normalizeTodoCreatedAt } from "../domain/todo-utils.js";
import {
  YOURLS_ACTION_SHEET,
  YOURLS_EXEC_LOG_SHEET,
  parsePayloadJson,
  stableJson,
} from "../domain/yourls-actions.js";

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

// 將外部後台代碼正規化為基本碼,讓「後台 noise 變體」可以對齊,但保留語意尾綴。
//
// 規則(per-product 等價類):
//   1. 前綴 `dh`(大小寫不分)→ 後台 noise,砍掉。
//   2. 尾巴整段英文字母:
//        - 剛好等於 `dh`(大小寫不分)→ **語意尾綴「第二位」**,保留為 `dh`。
//        - 剛好等於 `t`(大小寫不分) → **語意尾綴「破圈」**, 保留為 `t`。
//        - 其餘任何純字母尾(`H` / `J` / `h` / `j` / `ABC` / `XY` 等)→ 後台 noise,砍掉。
//
// 例:
//   st100 = dhst100 = st100H = st100h = st100J = st100j → "st100"
//   st100dh = st100DH = dhst100dh → "st100dh"  (第二位,跟 st100 不等)
//   st100t = st100T → "st100t"                 (破圈,跟 st100 不等)
//   st1002 / dhst1002J → "st1002"
//
// 注意:
//   - 語意尾綴必須**整段**剛好命中(避免 `st100tH` / `st100Hdh` 之類的混合
//     歧義);未來廣告代碼命名請避免「語意尾綴 + noise 尾綴」同時出現。
const SEMANTIC_SUFFIXES = new Set(["t", "dh"]);

export function normalizeAdCode(code) {
  let s = String(code || "").trim();
  if (!s) return "";
  s = s.replace(/^dh/i, "");                       // 1. 砍可選 dh 前綴
  const m = s.match(/^(.*?)([a-zA-Z]+)$/);
  if (!m) return s.toLowerCase();
  const [, base, tail] = m;
  const tLow = tail.toLowerCase();
  if (SEMANTIC_SUFFIXES.has(tLow)) {
    // 命中語意尾綴 — 保留(統一小寫)
    return (base + tLow).toLowerCase();
  }
  // 其他純字母尾(後台 noise)→ 砍掉
  return base.toLowerCase();
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

function undoPayloadJson(payload) {
  if (!payload) return "";
  try {
    const text = JSON.stringify(payload);
    return text.length <= 30000 ? text : "";
  } catch {
    return "";
  }
}

function firstSheetValue(headers, obj, names, fallback = "") {
  for (const name of names) {
    if (headers.includes(name)) return obj[name];
  }
  return fallback;
}

function hasAnyHeader(headers, names) {
  return names.some((name) => headers.includes(name));
}

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function hasMeaningfulAdData(ad) {
  if (!String(ad?.id || "").trim()) return false;
  return !!(
    String(ad.ad_code || "").trim() ||
    String(ad.ad_name || "").trim() ||
    String(ad.start_date || "").trim() ||
    String(ad.end_date || "").trim() ||
    numOrZero(ad.amount_cny) > 0 ||
    numOrZero(ad.amount_twd) > 0
  );
}

function positiveWeightEntries(weights) {
  return Object.entries(weights || {})
    .map(([pid, raw]) => ({ pid, weight: Number(raw) }))
    .filter(({ pid, weight }) => String(pid || "").trim() && Number.isFinite(weight) && weight > 0);
}

// ── 正規化分頁（一般 push/pull 走這些） ────────────────────────────
export const TABLES = [
  {
    name: "產品",
    headers: ["id", "名稱", "類型", "不檢查每日帶寬", "是破圈", "母產品ID"],
    toRows: (s) => s.products.map((p) => [
      p.id,
      p.name,
      p.type,
      p.no_band ? "Y" : "",
      p.is_poquan ? "Y" : "",
      p.parent_product_id || "",
    ]),
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
      "id", "廣告代碼", "廣告名稱", "廣告分組",
      "幣別", "原幣金額", "原幣→RMB匯率",
      "人民幣金額", "匯率", "台幣金額",
      "開始日期", "結束日期", "攤提天數", "每日攤提(台幣)",
      "購買模式", "續費來源", "調整原因", "鎖定不調整", "禁止挪動",
      "廣告文案", "聯絡用TG號", "站長聯繫", "備註", "已淘汰",
      "縮網址類型", "縮網址參數", "縮網址舊網域", "縮網址舊前綴", "縮網址新網域", "縮網址已通知",
      "段建立代碼", "配對ID", "配對角色",
    ],
    toRows: (s) => (s.ads || []).filter(hasMeaningfulAdData).map((a) => [
      a.id, a.ad_code, a.ad_name, a.group || "",
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
      a.ad_copy || "",
      a.contact_tg || "",
      a.contact_info || "",
      a.notes || "",
      a.eliminated ? "Y" : "",
      a.short_url_type || "",
      a.short_url_param || "",
      a.short_url_old_override || "",
      a.short_url_old_prefix || "",
      a.short_url_new_override || "",
      a.short_url_notified ? "Y" : "",
      a.code_at_creation || "",
      a.split_pair_id || "",
      a.split_role || "",
    ]),
  },
  {
    name: "廣告權重",
    headers: ["廣告ID", "廣告代碼", "廣告名稱", "產品ID", "產品名稱", "權重%"],
    toRows: (s) => {
      const nameOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      return (s.ads || []).filter(hasMeaningfulAdData).flatMap((a) =>
        positiveWeightEntries(a.weights).map(({ pid, weight }) => [
          a.id, a.ad_code, a.ad_name, pid, nameOf[pid] || "", Math.round(weight),
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
    headers: [
      "id", "建立時間", "動作類型", "描述", "狀態", "撤回資料JSON",
      "Yourls狀態", "Yourls操作JSON", "Yourls操作IDs", "Yourls批准時間", "Yourls套用時間", "Yourls最後錯誤",
    ],
    toRows: (s) => (s.todos || []).map((t) => {
      const yourlsPayload = Array.isArray(t.yourls_actions) ? t.yourls_actions : (t.yourls_action ? [t.yourls_action] : []);
      return [
        t.id, normalizeTodoCreatedAt(t.created_at), t.action_type, t.description || "", t.status || "pending",
        undoPayloadJson(t.undo_payload),
        t.yourls_status || "", yourlsPayload.length ? stableJson(yourlsPayload) : "",
        (t.yourls_action_ids || []).join(","), t.yourls_approved_at || "", t.yourls_applied_at || "", t.yourls_last_error || "",
      ];
    }),
  },
  {
    name: YOURLS_ACTION_SHEET,
    headers: [
      "action_id", "todo_id", "created_at", "approved_at", "approved_by",
      "kind", "short_url_param", "source_ad_code", "ad_name", "weight_summary",
      "payload_json", "status", "worker_id", "claimed_at", "completed_at",
      "last_error", "attempts", "updated_at",
    ],
    toRows: (s) => (s.yourls_actions || []).map((a) => [
      a.action_id || "", a.todo_id || "", normalizeTodoCreatedAt(a.created_at), normalizeTodoCreatedAt(a.approved_at), a.approved_by || "",
      a.kind || "", a.short_url_param || "", a.source_ad_code || "", a.ad_name || "", a.weight_summary || "",
      stableJson(a.payload), a.status || "queued", a.worker_id || "", normalizeTodoCreatedAt(a.claimed_at), normalizeTodoCreatedAt(a.completed_at),
      a.last_error || "", Number(a.attempts) || 0, normalizeTodoCreatedAt(a.updated_at),
    ]),
  },
  {
    name: YOURLS_EXEC_LOG_SHEET,
    headers: [
      "log_id", "action_id", "at", "status", "kind", "short_url_param",
      "before_json", "after_json", "operations_json", "error_msg", "worker_id", "dry_run",
    ],
    toRows: (s) => (s.yourls_execution_logs || []).map((log) => [
      log.log_id || "", log.action_id || "", normalizeTodoCreatedAt(log.at), log.status || "",
      log.kind || "", log.short_url_param || "", stableJson(log.before), stableJson(log.after),
      stableJson(log.operations || []), log.error_msg || "", log.worker_id || "", log.dry_run ? "Y" : "",
    ]),
  },
  {
    name: "設定",
    headers: ["key", "value"],
    toRows: (s) => {
      const settings = s.settings || {};
      const rows = [
        ["current_month", settings.current_month || ""],
        ["expense_rate", settings.expense_rate ?? 4.8],
        ["income_rate", settings.income_rate ?? 4.6],
        ["usdt_to_cny_rate", settings.usdt_to_cny_rate ?? 7],
        ["usd_to_twd_rate", settings.usd_to_twd_rate ?? 32],
      ];
      for (const [ym, rates] of Object.entries(settings.monthly_rates || {})) {
        for (const kind of ["expense", "income", "usdt_to_cny", "usd_to_twd"]) {
          const value = rates?.[kind];
          if (Number.isFinite(value) && value > 0) rows.push([`monthly_rate::${ym}::${kind}`, value]);
        }
      }
      if (settings.short_url_new_domain) rows.push(["short_url_new_domain", settings.short_url_new_domain]);
      if (settings.short_url_old_domain) rows.push(["short_url_old_domain", settings.short_url_old_domain]);
      if (settings.short_url_prefix_map && typeof settings.short_url_prefix_map === "object") {
        rows.push(["short_url_prefix_map", JSON.stringify(settings.short_url_prefix_map)]);
      }
      return rows;
    },
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

export function assembleFromTables(raw) {
  const pick = (name) => raw[name] || { headers: [], rows: [] };
  const toObj = (headers, row) => Object.fromEntries(headers.map((h, i) => [h, row[i]]));

  const prodT = pick("產品");
  // 只在 Sheets 真的有該欄位時才覆寫對應 flag,否則留給 migrate() 補(避免新欄位
  // 還沒推上 Sheets 之前先 PULL,把 av9_poquan / jk_poquan 的 is_poquan 洗成 false)
  const hasNoBandCol = prodT.headers.includes("不檢查每日帶寬");
  const hasPoqCol = hasAnyHeader(prodT.headers, ["是破圈", "是否破圈"]);
  const hasParentCol = prodT.headers.includes("母產品ID");
  const yes = (v) => String(v || "").trim().toUpperCase() === "Y";
  const products = prodT.rows.map((r) => {
    const o = toObj(prodT.headers, r);
    const obj = {
      id: String(o.id || ""),
      name: String(o["名稱"] || ""),
      type: o["類型"] === "island" ? "island" : "app",
      performance_targets: [],
    };
    if (hasNoBandCol) obj.no_band = yes(o["不檢查每日帶寬"]);
    if (hasPoqCol) obj.is_poquan = yes(firstSheetValue(prodT.headers, o, ["是破圈", "是否破圈"]));
    if (hasParentCol) obj.parent_product_id = String(o["母產品ID"] || "");
    return obj;
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
    const adValue = (names, fallback = "") => firstSheetValue(adT.headers, o, names, fallback);
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
      ...(adT.headers.includes("已淘汰")
        ? { eliminated: String(o["已淘汰"] || "").trim().toUpperCase() === "Y" } : {}),
      ...(hasAnyHeader(adT.headers, ["配對ID", "破圈分流配對ID"]) && adValue(["配對ID", "破圈分流配對ID"])
        ? { split_pair_id: String(adValue(["配對ID", "破圈分流配對ID"])) } : {}),
      ...(hasAnyHeader(adT.headers, ["配對角色", "破圈分流角色"]) && adValue(["配對角色", "破圈分流角色"])
        ? { split_role: String(adValue(["配對角色", "破圈分流角色"])) } : {}),
      ...(hasAnyHeader(adT.headers, ["段建立代碼", "段建立時代碼"]) && adValue(["段建立代碼", "段建立時代碼"])
        ? { code_at_creation: String(adValue(["段建立代碼", "段建立時代碼"])) } : {}),
      ...(adT.headers.includes("廣告文案")
        ? { ad_copy: String(o["廣告文案"] || "") } : {}),
      ...(adT.headers.includes("聯絡用TG號")
        ? { contact_tg: String(o["聯絡用TG號"] || "") } : {}),
      ...(adT.headers.includes("站長聯繫")
        ? { contact_info: String(o["站長聯繫"] || "") } : {}),
      ...(adT.headers.includes("縮網址類型")
        ? { short_url_type: String(o["縮網址類型"] || "") } : {}),
      ...(adT.headers.includes("縮網址參數")
        ? { short_url_param: String(o["縮網址參數"] || "") } : {}),
      ...(hasAnyHeader(adT.headers, ["縮網址舊網域", "縮網址舊網域覆寫"])
        ? { short_url_old_override: String(adValue(["縮網址舊網域", "縮網址舊網域覆寫"]) || "") } : {}),
      ...(hasAnyHeader(adT.headers, ["縮網址新網域", "縮網址新網域覆寫"])
        ? { short_url_new_override: String(adValue(["縮網址新網域", "縮網址新網域覆寫"]) || "") } : {}),
      ...(adT.headers.includes("縮網址舊前綴") && o["縮網址舊前綴"]
        ? { short_url_old_prefix: String(o["縮網址舊前綴"]) } : {}),
      ...(adT.headers.includes("縮網址已通知")
        ? { short_url_notified: String(o["縮網址已通知"] || "").trim().toUpperCase() === "Y" } : {}),
    };
  }).filter(hasMeaningfulAdData);

  const wT = pick("廣告權重");
  wT.rows.forEach((r) => {
    const o = toObj(wT.headers, r);
    const ad = ads.find((a) => a.id === String(o["廣告ID"]));
    const pid = String(o["產品ID"] || "");
    const weight = Number(o["權重%"]) || 0;
    if (ad && pid && weight > 0) ad.weights[pid] = weight;
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
    const rec = {
      id: String(o.id || ""),
      created_at: normalizeTodoCreatedAt(o["建立時間"]),
      action_type: String(o["動作類型"] || ""),
      description: String(o["描述"] || ""),
      status: o["狀態"] === "done" ? "done" : "pending",
    };
    if (todoT.headers.includes("撤回資料JSON")) {
      const payload = parsePayloadJson(o["撤回資料JSON"]);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) rec.undo_payload = payload;
    }
    if (todoT.headers.includes("Yourls狀態")) {
      rec.yourls_status = String(o["Yourls狀態"] || "");
      const payload = parsePayloadJson(o["Yourls操作JSON"]);
      if (Array.isArray(payload)) rec.yourls_actions = payload;
      else if (payload) rec.yourls_action = payload;
      rec.yourls_action_ids = String(o["Yourls操作IDs"] || "").split(",").map((s) => s.trim()).filter(Boolean);
      rec.yourls_approved_at = normalizeTodoCreatedAt(o["Yourls批准時間"]);
      rec.yourls_applied_at = normalizeTodoCreatedAt(o["Yourls套用時間"]);
      rec.yourls_last_error = String(o["Yourls最後錯誤"] || "");
    }
    return rec;
  });

  const yourlsActionT = pick(YOURLS_ACTION_SHEET);
  const yourls_actions = yourlsActionT.rows.map((r) => {
    const o = toObj(yourlsActionT.headers, r);
    const payload = parsePayloadJson(o.payload_json);
    return {
      action_id: String(o.action_id || ""),
      todo_id: String(o.todo_id || ""),
      created_at: normalizeTodoCreatedAt(o.created_at),
      approved_at: normalizeTodoCreatedAt(o.approved_at),
      approved_by: String(o.approved_by || ""),
      kind: String(o.kind || payload?.kind || ""),
      short_url_param: String(o.short_url_param || payload?.short_url_param || ""),
      source_ad_code: String(o.source_ad_code || payload?.source_ad_code || ""),
      ad_name: String(o.ad_name || payload?.ad_name || ""),
      weight_summary: String(o.weight_summary || payload?.weight_summary || ""),
      payload: payload || {},
      status: String(o.status || "queued"),
      worker_id: String(o.worker_id || ""),
      claimed_at: normalizeTodoCreatedAt(o.claimed_at),
      completed_at: normalizeTodoCreatedAt(o.completed_at),
      last_error: String(o.last_error || ""),
      attempts: Number(o.attempts) || 0,
      updated_at: normalizeTodoCreatedAt(o.updated_at),
    };
  }).filter((a) => a.action_id);

  const yourlsLogT = pick(YOURLS_EXEC_LOG_SHEET);
  const yourls_execution_logs = yourlsLogT.rows.map((r) => {
    const o = toObj(yourlsLogT.headers, r);
    return {
      log_id: String(o.log_id || ""),
      action_id: String(o.action_id || ""),
      at: normalizeTodoCreatedAt(o.at),
      status: String(o.status || ""),
      kind: String(o.kind || ""),
      short_url_param: String(o.short_url_param || ""),
      before: parsePayloadJson(o.before_json) || {},
      after: parsePayloadJson(o.after_json) || {},
      operations: parsePayloadJson(o.operations_json) || [],
      error_msg: String(o.error_msg || ""),
      worker_id: String(o.worker_id || ""),
      dry_run: String(o.dry_run || "").toUpperCase() === "Y",
    };
  }).filter((log) => log.log_id);

  const settings = {
    current_month: "",
    expense_rate: 4.8,
    income_rate: 4.6,
    usdt_to_cny_rate: 7,
    usd_to_twd_rate: 32,
    monthly_rates: {},
    sheets_webapp_url: "",
    sheets_token: "",
    short_url_new_domain: "",
    short_url_old_domain: "",
    short_url_prefix_map: { L1: "L1", L3: "L3", L5: "L5" },
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
    else if (o.key === "short_url_new_domain") settings.short_url_new_domain = String(v || "");
    else if (o.key === "short_url_old_domain") settings.short_url_old_domain = String(v || "");
    else if (o.key === "short_url_prefix_map") {
      const raw = String(v || "").trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") settings.short_url_prefix_map = parsed;
        } catch { /* 舊資料手改錯時保留預設 */ }
      }
    }
    else if (o.key === "short_url_prefix_L1") settings.short_url_prefix_map.L1 = String(v || "L1").trim() || "L1";
    else if (o.key === "short_url_prefix_L3") settings.short_url_prefix_map.L3 = String(v || "L3").trim() || "L3";
    else if (o.key === "short_url_prefix_L5") settings.short_url_prefix_map.L5 = String(v || "L5").trim() || "L5";
    else if (String(o.key || "").startsWith("monthly_rate::")) {
      const [, ym, kind] = String(o.key).split("::");
      if (!/^\d{4}-\d{2}$/.test(ym)) return;
      if (!["expense", "income", "usdt_to_cny", "usd_to_twd"].includes(kind)) return;
      const num = Number(v) || 0;
      if (num <= 0) return;
      if (!settings.monthly_rates[ym]) settings.monthly_rates[ym] = {};
      settings.monthly_rates[ym][kind] = num;
    }
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
    settings, products, monthly_budgets, daily_budgets, ads, todos, yourls_actions, yourls_execution_logs, performance_data,
    budget_changes, report_config,
  };
}
