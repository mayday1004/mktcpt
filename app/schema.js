export const VERSION = 3;

// Ad lifecycle reasons (§3.4 in CLAUDE.md). Every new segment must carry one.
export const RENEWAL_REASONS = [
  "初始",        // 新增廣告
  "續費",        // 完整延續（可能改 RMB/匯率/攤提天/權重）
  "續費匯率",    // 續費時只改匯率
  "匯率調漲",    // 續費時 RMB 變高（沿用舊名「漲價」）
  "匯率調降",    // 續費時 RMB 變低（沿用舊名「降價」）
  "權重調整",    // 成效調整後，只改 weights
  "拆t改名",     // 權重觸發同家族母+破圈碰撞,系統自動拆 pair 並改名(§5.7.2)
  "送天數",      // 贈送期間，某些產品權重暫時歸 0
  "送天數結束",  // 贈送結束恢復
  "轉移",        // 舊事件,新系統不再產生(§3.4)
  "批量匯率調整", // 歷史用：月末 4.5→4.7 全面換匯；新系統不再產生
];

export const METRICS = [
  "花費",
  "不重複安裝數",
  "廠商安裝",
  "不重複首頁開啟數",
  "不重複活躍用戶數",
  "首儲訂單數",
  "首儲購買金額",
  "加總訂單數",
  "加總購買金額",
  "所有渠道不重複安裝數",
  "所有渠道不重複活躍用戶數",
  "總活躍用戶",
  "總下載點擊",
  "事件計數",
];

export const PRODUCT_TYPES = {
  app:    { label: "APP",  band_pct: 30,   desc: "每日攤提可 ±30%" },
  island: { label: "小島", band_pct: 0.5,  desc: "每日攤提僅 ±0.5%" },
};

// 「不檢查每日帶寬」標記:由產品的 no_band 欄位決定(可在 Sheets「產品」分頁
// 設「不檢查每日帶寬=Y」或在產品編輯彈窗勾選)。原本寫死的 av9_poquan / jk_poquan
// 在 migrate() 中自動補上 no_band=true,維持既有行為。
export function isNoBand(product) {
  return product?.no_band === true;
}

// 產品顯示順序(各 UI 一致,APP 家族先 + 各自破圈,小島照常見順序排)。
// 不在此清單中的產品(未來新增 / 非標準)會排到最後,並以 id 字母序處理。
export const PRODUCT_DISPLAY_ORDER = [
  "AV9", "av9_poquan",
  "JK", "jk_poquan",
  "HYC",
  "PJ8", "ZFB", "OJI", "MYS", "XRK", "BS",
];
const _PRODUCT_ORDER_INDEX = Object.fromEntries(
  PRODUCT_DISPLAY_ORDER.map((id, i) => [id, i])
);
export function compareProductOrder(a, b) {
  const ai = _PRODUCT_ORDER_INDEX[a?.id] ?? 9999;
  const bi = _PRODUCT_ORDER_INDEX[b?.id] ?? 9999;
  if (ai !== bi) return ai - bi;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}
export function isNoBandPid(state, pid) {
  return state?.products?.find((p) => p.id === pid)?.no_band === true;
}

// 破圈產品標記。原本寫死的 av9_poquan / jk_poquan 在 migrate() 中自動補上
// is_poquan=true + parent_product_id=AV9/JK。未來新增破圈(例:HYC_poquan)時,
// 在產品編輯彈窗勾選「這是破圈產品」+ 選母產品即可,所有依賴此邏輯的地方都會自動套用。
export function isPoquan(product) {
  return product?.is_poquan === true;
}

// 廣告鎖定三段(影響「自動建議」是否可動權重;手動編輯永遠放行)
//   free   = 完全自由,自動可分權重也可整桶搬
//   weight = 鎖權重比例,只能整桶搬(100% → 100%);自動分權重不可
//   full   = 禁止挪動,自動完全跳過;成效爛只顯示「建議淘汰」
export const LOCK_STATES = {
  free:   { id: "free",   icon: "🔓", label: "自由" },
  weight: { id: "weight", icon: "🔒", label: "鎖權重" },
  full:   { id: "full",   icon: "🚫", label: "禁止挪動" },
};

export function getAdLockState(ad) {
  if (ad?.lock_full) return "full";
  if (ad?.lock_perf_adjust) return "weight";
  return "free";
}

// 直接 mutate(在 update() 內呼叫);也可單獨用,但要注意呼叫端責任 persist
export function setAdLockState(ad, state) {
  ad.lock_perf_adjust = (state === "weight" || state === "full");
  ad.lock_full = (state === "full");
}

// 產品清單完全由使用者透過 Sheets「產品」分頁或 UI 維護,不再有 hardcode 預設值。
// 第一次開啟(無資料 + 未連 Sheets)會看到空清單,使用者按「+ 新增產品」開始建立。

export function defaultState() {
  return {
    version: VERSION,
    settings: {
      current_month: thisMonth(),
      // 預設匯率（當月份沒有指定 monthly_rates 時 fallback 用）
      expense_rate: 4.8,
      income_rate: 4.6,
      usdt_to_cny_rate: 7,
      usd_to_twd_rate: 32,
      // 每月匯率覆寫：monthly_rates[YYYY-MM] = { expense?, income?, usdt_to_cny?, usd_to_twd? }
      // 缺值就 fallback 到 settings.expense_rate / income_rate / usdt_to_cny_rate / usd_to_twd_rate（單值預設）
      monthly_rates: {},
      sheets_webapp_url: "",
      sheets_token: "",
      yourls_wake_url: "",
      yourls_wake_token: "",
      // 縮網址前綴對應(2026-05,§5.7.x):業務 slot L1/L3/L5 → 實際 URL 子網域前綴
      // 預設值 = 同名(slot id 就是前綴);使用者可在縮網址頁修改
      short_url_prefix_map: { L1: "L1", L3: "L3", L5: "L5" },
    },
    products: [],
    // monthly_budgets[product_id][YYYY-MM] = budget_twd.
    // 未設定時 UI 顯示空白 + 警告（§5.1）；永遠不自動繼承前月。
    monthly_budgets: {},
    // daily_budgets[product_id][YYYY-MM] = daily_twd.
    // 小島型產品偏好用日預算（穩定）；當設定時，月預算 = daily × 該月天數，
    // 不再讀 monthly_budgets。允許 APP 也用日預算，無強制限制。
    daily_budgets: {},
    ads: [],
    todos: [],
    yourls_actions: [],
    yourls_execution_logs: [],
    performance_data: [],
    // 預算變動歷程：budget_changes[product_id][YYYY-MM] = [{at_date, amount}, ...]
    // 第一筆代表月初預算；後續為「於 at_date 起改為 amount」的調整
    // 沒紀錄時系統自動視為 [{at_date: ym+'-01', amount: monthly_budgets[pid][ym]}]
    budget_changes: {},
    // 成效報表的「每產品欄位設定」— 不影響權重邏輯，純報表呈現偏好
    //   report_config[product_id] = {
    //     hidden_metrics: ["欄名", ...],     // 要隱藏的 metric / 目標 / 自訂欄位（空陣列 = 全顯示）
    //     custom_metrics: [{ id, name, formula }, ...]  // 報表自訂計算欄位（如 ROI）
    //   }
    report_config: {},
  };
}

function _daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

// 直接取使用者輸入的日預算（沒設則 null）
export function getDailyBudget(state, productId, ym) {
  const d = state?.daily_budgets?.[productId]?.[ym];
  return Number.isFinite(d) && d > 0 ? d : null;
}

// 取月預算：
//   1. 若有 budget_changes（多段預算變動）→ 依產品類型加總計算實際月度
//   2. 否則 daily_budgets 設定時 → daily × 該月天數
//   3. 否則 fallback 到 monthly_budgets
// Null 代表未設定。
export function getMonthlyBudget(state, productId, ym) {
  const arr = state?.budget_changes?.[productId]?.[ym];
  if (Array.isArray(arr) && arr.length > 0) {
    const product = state?.products?.find((p) => p.id === productId);
    const computed = computeMonthlyFromChanges(arr, product, ym);
    if (computed != null) return computed;
  }
  const daily = getDailyBudget(state, productId, ym);
  if (daily != null) return daily * _daysInMonth(ym);
  const m = state?.monthly_budgets?.[productId];
  if (!m) return null;
  const v = m[ym];
  return Number.isFinite(v) && v > 0 ? v : null;
}

// 計算多段預算下的實際月度合計：
//   APP：取最新段；該段 mode='monthly' 直接是月度，'daily' 則 × 月天數
//   小島：依各段 mode 加總（'daily'→amount × segDays，'monthly'→(amount/月天數) × segDays）
//
// 每筆 entry 的 mode 不一致時（legacy 混新資料）也能正確處理。
function computeMonthlyFromChanges(changes, product, ym) {
  const sorted = [...changes]
    .filter((c) => c && c.at_date && Number.isFinite(c.amount) && c.amount > 0)
    .sort((a, b) => (a.at_date < b.at_date ? -1 : 1));
  if (sorted.length === 0) return null;
  const isIsland = product?.type === "island";
  const dim = _daysInMonth(ym);

  if (!isIsland) {
    const last = sorted[sorted.length - 1];
    const mode = last.mode || "monthly";
    return mode === "daily" ? last.amount * dim : last.amount;
  }

  // 小島：分段加總
  const monthFirst = `${ym}-01`;
  const monthLastPlusOne = nextMonthFirst(ym);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const segStart = cur.at_date < monthFirst ? monthFirst : cur.at_date;
    const next = sorted[i + 1];
    const segEndExclusive = next ? next.at_date : monthLastPlusOne;
    const segDays = Math.max(0, _diffDays(segStart, segEndExclusive));
    const mode = cur.mode || "monthly";
    if (mode === "daily") {
      total += cur.amount * segDays;
    } else {
      // legacy monthly entry：amount 是該段的「月度目標」→ 換算 daily-equivalent
      total += (cur.amount / dim) * segDays;
    }
  }
  return total;
}

function nextMonthFirst(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
function _diffDays(start, endExclusive) {
  const a = Date.parse(start), b = Date.parse(endExclusive);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

// 預算來源：依產品類型決定（app→monthly, island→daily）；同時支援 legacy 反向偵測
export function getBudgetSource(state, productId, ym) {
  const product = state?.products?.find((p) => p.id === productId);
  if (product?.type === "island") {
    if (getDailyBudget(state, productId, ym) != null) return "daily";
    // legacy fallback: 小島若只有月度資料，仍視為 monthly
    const m = state?.monthly_budgets?.[productId]?.[ym];
    if (Number.isFinite(m) && m > 0) return "monthly";
    return null;
  }
  // APP 與其他：優先 monthly
  const m = state?.monthly_budgets?.[productId]?.[ym];
  if (Number.isFinite(m) && m > 0) return "monthly";
  if (getDailyBudget(state, productId, ym) != null) return "daily";
  return null;
}

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 取該月支出匯率：先看 settings.monthly_rates[ym].expense，沒有就用 settings.expense_rate
export function getExpenseRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.expense;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.expense_rate;
  return Number.isFinite(def) && def > 0 ? def : 4.8;
}

export function getIncomeRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.income;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.income_rate;
  return Number.isFinite(def) && def > 0 ? def : 4.6;
}

// 給成效目標公式用的額外變數(收入匯率、支出匯率),所有 scoreRecord 呼叫都該帶入,
// 否則公式中參考的匯率會被當成 0,「扣首儲收入後 CPI」這類目標會系統性算錯。
export function getReportVars(state, ym) {
  const m = ym || state?.settings?.current_month;
  return {
    "收入匯率": getIncomeRate(state, m),
    "支出匯率": getExpenseRate(state, m),
  };
}

// 取該月 USDT→RMB 匯率：先看 settings.monthly_rates[ym].usdt_to_cny，沒有就用 settings.usdt_to_cny_rate
export function getUsdtToCnyRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.usdt_to_cny;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.usdt_to_cny_rate;
  return Number.isFinite(def) && def > 0 ? def : 7;
}

// 取該月 USD→TWD 匯率：先看 settings.monthly_rates[ym].usd_to_twd，沒有就用 settings.usd_to_twd_rate
export function getUsdToTwdRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.usd_to_twd;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.usd_to_twd_rate;
  return Number.isFinite(def) && def > 0 ? def : 32;
}

// 'monthly' / 'default'
export function getRateSource(state, ym, kind /* 'expense'|'income'|'usdt_to_cny'|'usd_to_twd' */) {
  const m = state?.settings?.monthly_rates?.[ym]?.[kind];
  return (Number.isFinite(m) && m > 0) ? "monthly" : "default";
}

// 取某產品某月的預算變動序列（按日期排序），每筆 = { at_date, amount, mode }
// mode = 'monthly' (APP)：amount 是該段的「月度目標總額」
// mode = 'daily'   (小島)：amount 是該段的「每日預算」
//
// 沒有紀錄時：依產品類型從 monthly_budgets / daily_budgets 推首段；
// 都沒有就回空陣列（代表預算未設）。
export function getBudgetChanges(state, pid, ym) {
  const product = state?.products?.find((p) => p.id === pid);
  const isIsland = product?.type === "island";
  const defaultMode = isIsland ? "daily" : "monthly";

  const arr = state?.budget_changes?.[pid]?.[ym];
  if (Array.isArray(arr) && arr.length > 0) {
    return [...arr]
      .filter((c) => c && c.at_date && Number.isFinite(c.amount) && c.amount > 0)
      .map((c) => ({ ...c, mode: c.mode || defaultMode }))
      .sort((a, b) => (a.at_date < b.at_date ? -1 : a.at_date > b.at_date ? 1 : 0));
  }
  // 從預算回推首段（依產品類型）
  if (isIsland) {
    const daily = getDailyBudget(state, pid, ym);
    if (daily != null && daily > 0) return [{ at_date: `${ym}-01`, amount: daily, mode: "daily" }];
    // legacy fallback：小島只填了月預算
    const m = state?.monthly_budgets?.[pid]?.[ym];
    if (Number.isFinite(m) && m > 0) {
      return [{ at_date: `${ym}-01`, amount: m / _daysInMonth(ym), mode: "daily" }];
    }
  } else {
    const m = state?.monthly_budgets?.[pid]?.[ym];
    if (Number.isFinite(m) && m > 0) return [{ at_date: `${ym}-01`, amount: m, mode: "monthly" }];
    // legacy: APP 只填了日預算
    const daily = getDailyBudget(state, pid, ym);
    if (daily != null && daily > 0) return [{ at_date: `${ym}-01`, amount: daily * _daysInMonth(ym), mode: "monthly" }];
  }
  return [];
}

// 「最終 / 最新」預算的 amount（按 mode 解讀；APP=月度 TWD，小島=日 TWD）
export function getLatestBudget(state, pid, ym) {
  const changes = getBudgetChanges(state, pid, ym);
  return changes.length > 0 ? changes[changes.length - 1].amount : null;
}

// 採買建議專用：取月預算，若該月未設定則往回找最近一個有設定的月份。
// 用途：使用者跨月採買時，若下個月預算未填，仍能讓採買建議顯示（默認沿用本月）。
// 不影響「產品」頁的「未設定」狀態顯示——只在 suggestion 路徑用。
export function getMonthlyBudgetWithFallback(state, pid, ym) {
  const direct = getMonthlyBudget(state, pid, ym);
  if (direct != null) return direct;
  let cursor = ym;
  for (let i = 0; i < 12; i++) {
    cursor = _prevMonth(cursor);
    const v = getMonthlyBudget(state, pid, cursor);
    if (v != null) return v;
  }
  return null;
}

function _prevMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

// 每日攤提表頭用:取「該產品該月的目標日花費」— 以「最新段」為準
//   APP   → 取最新段金額(月度 TWD)/ 月天數;若最新段是 daily mode 則直接用
//   小島  → 取最新段金額(日 TWD);若最新段是 monthly mode 則 /月天數
// 用途:概覽 / 權重調整預覽 / 採買建議的表頭下方顯示目標,跟實際比對。
//
// 為什麼要看「最新段」:
//   小島如果用「+加預算」改過(例:5/1 4000/日 → 5/6 5000/日),目標應該是
//   最新值 5000,而不是月初基準 4000。getBudgetChanges 在沒紀錄時會 fallback
//   到 monthly_budgets/daily_budgets 推出單段,所以單段情境也對。
//
// 沒設預算回 null,呼叫端自己決定要不要顯示。
export function getTargetDailyBudget(state, pid, ym) {
  const product = state?.products?.find((p) => p.id === pid);
  if (!product) return null;
  const changes = getBudgetChanges(state, pid, ym);
  if (changes.length === 0) return null;
  const last = changes[changes.length - 1];
  if (!Number.isFinite(last.amount) || last.amount <= 0) return null;
  const mode = last.mode || (product.type === "island" ? "daily" : "monthly");
  if (mode === "daily") return last.amount;
  // monthly → 均攤到日
  return last.amount / _daysInMonth(ym);
}
