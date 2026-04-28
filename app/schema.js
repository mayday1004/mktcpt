export const VERSION = 3;

// Ad lifecycle reasons (§3.4 in CLAUDE.md). Every new segment must carry one.
export const RENEWAL_REASONS = [
  "初始",        // 新增廣告
  "續費",        // 完整延續（可能改 RMB/匯率/攤提天/權重）
  "續費匯率",    // 續費時只改匯率
  "漲價",        // 續費時 RMB 變高
  "降價",        // 續費時 RMB 變低
  "權重調整",    // 成效調整後，只改 weights
  "送天數",      // 贈送期間，某些產品權重暫時歸 0
  "送天數結束",  // 贈送結束恢復
  "轉移",        // 一般↔破圈 或 轉小島
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

// 不需檢查每日帶寬的產品（破圈系列極端花費照常）。
// 在每日攤提表、詳細檢視、成效調整影響表都跳過帶寬警示。
export const NO_BAND_PIDS = new Set(["av9_poquan", "jk_poquan"]);

export const PRODUCT_SEED = [
  { id: "AV9",        name: "愛威奶",      type: "app" },
  { id: "av9_poquan", name: "愛威奶破圈",  type: "app" },
  { id: "JK",         name: "健康",        type: "app" },
  { id: "jk_poquan",  name: "健康破圈",    type: "app" },
  { id: "HYC",        name: "黃油圈",      type: "app" },
  { id: "PJ8",        name: "破解吧",      type: "island" },
  { id: "ZFB",        name: "汁婦寶",      type: "island" },
  { id: "OJI",        name: "萬精游",      type: "island" },
  { id: "MYS",        name: "磨欲爽",      type: "island" },
  { id: "XRK",        name: "色軟庫",      type: "island" },
  { id: "BS",         name: "熊貓巴士",    type: "island" },
];

export function defaultState() {
  return {
    version: VERSION,
    settings: {
      current_month: thisMonth(),
      // 預設匯率（當月份沒有指定 monthly_rates 時 fallback 用）
      expense_rate: 4.7,
      income_rate: 4.5,
      usdt_to_cny_rate: 7.2,
      // 每月匯率覆寫：monthly_rates[YYYY-MM] = { expense?, income?, usdt_to_cny? }
      // 缺值就 fallback 到 settings.expense_rate / income_rate / usdt_to_cny_rate（單值預設）
      monthly_rates: {},
      sheets_webapp_url: "",
      sheets_token: "",
    },
    products: PRODUCT_SEED.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      performance_targets: [],
    })),
    // monthly_budgets[product_id][YYYY-MM] = budget_twd.
    // 未設定時 UI 顯示空白 + 警告（§5.1）；永遠不自動繼承前月。
    monthly_budgets: {},
    // daily_budgets[product_id][YYYY-MM] = daily_twd.
    // 小島型產品偏好用日預算（穩定）；當設定時，月預算 = daily × 該月天數，
    // 不再讀 monthly_budgets。允許 APP 也用日預算，無強制限制。
    daily_budgets: {},
    ads: [],
    todos: [],
    performance_data: [],
    daily_amort_override: {},
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
  return Number.isFinite(def) && def > 0 ? def : 4.7;
}

export function getIncomeRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.income;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.income_rate;
  return Number.isFinite(def) && def > 0 ? def : 4.5;
}

// 取該月 USDT→RMB 匯率：先看 settings.monthly_rates[ym].usdt_to_cny，沒有就用 settings.usdt_to_cny_rate
// 預設 7.2（這是個常見近似值，使用者可在「設定」頁調整）
export function getUsdtToCnyRate(state, ym) {
  const m = state?.settings?.monthly_rates?.[ym]?.usdt_to_cny;
  if (Number.isFinite(m) && m > 0) return m;
  const def = state?.settings?.usdt_to_cny_rate;
  return Number.isFinite(def) && def > 0 ? def : 7.2;
}

// 'monthly' / 'default'
export function getRateSource(state, ym, kind /* 'expense'|'income'|'usdt_to_cny' */) {
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
