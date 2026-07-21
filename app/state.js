import { VERSION, defaultState } from "./schema.js";
import { nowTaipeiTime } from "./lib/dates.js";
import { isDeployManaged, isYourlsWakeDeployManaged } from "./lib/deploy-config.js";
import { applyDoneEliminateTodos, normalizeTodosInState } from "./domain/todo-utils.js";
import { materializeTodosAppliedSnapshots } from "./domain/undo.js";
import { normalizeWeightsToTotal, reconcileSplitPairs } from "./domain/auto-split.js";
import { reconcileYourlsTodos } from "./domain/yourls-actions.js";
import { pruneResidualSegments } from "./domain/cleanup.js";
import { markSyncDeleted } from "./io/sync-deletions.js";

const MAX_UNDO = 8;
const listeners = new Set();
function collectAdWeightSyncRows(st) {
  const rows = [];
  for (const ad of (st.ads || [])) {
    const adId = String(ad?.id || "").trim();
    if (!adId) continue;
    for (const [pid, raw] of Object.entries(ad.weights || {})) {
      if ((Number(raw) || 0) > 0 && String(pid || "").trim()) rows.push({ id: `${adId}::${pid}` });
    }
  }
  return rows;
}

const SYNC_DELETE_TRACKERS = [
  { sheetName: "\u5ee3\u544a", select: (st) => st.ads, idOf: (row) => row.id },
  { sheetName: "\u5ee3\u544a\u6b0a\u91cd", select: collectAdWeightSyncRows, idOf: (row) => row.id },
  { sheetName: "\u5f85\u8fa6", select: (st) => st.todos, idOf: (row) => row.id },
  { sheetName: "YOURLS\u64cd\u4f5c\u4f47\u5217", select: (st) => st.yourls_actions, idOf: (row) => row.action_id },
  { sheetName: "YOURLS\u57f7\u884c\u7d00\u9304", select: (st) => st.yourls_execution_logs, idOf: (row) => row.log_id },
];

// Runtime state is intentionally memory-only. On reload the app starts from the
// schema default and the sync layer pulls the current Sheets data.
let state = migrate(defaultState());
let undoStack = [];

function collectSyncEntityIds(st) {
  const out = {};
  for (const tracker of SYNC_DELETE_TRACKERS) {
    const ids = new Set();
    const rows = tracker.select(st) || [];
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const id = String(tracker.idOf(row) || "").trim();
        if (id) ids.add(id);
      }
    }
    out[tracker.sheetName] = ids;
  }
  return out;
}

function markRemovedSyncRows(beforeIds, afterIds) {
  for (const tracker of SYNC_DELETE_TRACKERS) {
    const before = beforeIds[tracker.sheetName] || new Set();
    const after = afterIds[tracker.sheetName] || new Set();
    const removed = [...before].filter((id) => !after.has(id));
    if (removed.length > 0) markSyncDeleted(tracker.sheetName, removed);
  }
}

function weightSum(weights) {
  return Object.values(weights || {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function purchaseModeFor(weights) {
  const keys = Object.keys(weights || {}).filter((key) => Number(weights[key]) > 0);
  return keys.length === 1 && Number(weights[keys[0]]) === 100 ? "independent" : "shared";
}

function segmentsOverlap(a, b) {
  return !!(a?.start_date && a?.end_date && b?.start_date && b?.end_date &&
    a.start_date < b.end_date && b.start_date < a.end_date);
}

function normalizeLegacySplitPairWeights(st) {
  if (!Array.isArray(st?.ads)) return;
  const byPair = new Map();
  for (const ad of st.ads) {
    if (!ad?.split_pair_id) continue;
    if (!byPair.has(ad.split_pair_id)) byPair.set(ad.split_pair_id, []);
    byPair.get(ad.split_pair_id).push(ad);
  }

  for (const pairAds of byPair.values()) {
    if (pairAds.length < 2) continue;
    for (const ad of pairAds) {
      const sum = weightSum(ad.weights);
      if (sum <= 0 || sum >= 99.5) continue;

      const linkedByCode = new Map();
      for (const other of pairAds) {
        if (other === ad || !segmentsOverlap(ad, other)) continue;
        const key = other.ad_code || other.id;
        const current = linkedByCode.get(key);
        if (!current || String(other.start_date || "") > String(current.start_date || "")) {
          linkedByCode.set(key, other);
        }
      }
      const linked = [...linkedByCode.values()];
      if (linked.length === 0) continue;

      const ownAmount = Number(ad.amount_cny) || 0;
      const totalAmount = ownAmount + linked.reduce((acc, other) => acc + (Number(other.amount_cny) || 0), 0);
      if (totalAmount <= 0 || ownAmount <= 0) continue;

      const amountSharePct = ownAmount / totalAmount * 100;
      if (Math.abs(sum - amountSharePct) > 1.5) continue;

      const normalized = normalizeWeightsToTotal(ad.weights, 100);
      if (Object.keys(normalized).length === 0) continue;
      ad.weights = normalized;
      ad.purchase_mode = purchaseModeFor(normalized);
    }
  }
}

function reconcileDerivedState(st) {
  reconcileYourlsTodos(st);
  materializeTodosAppliedSnapshots(st);
  applyDoneEliminateTodos(st);
}

// Migrate older state shapes to current schema. Non-destructive.
function migrate(st) {
  if (!st || typeof st !== "object") return defaultState();
  // v1/v2 → v3: move per-product monthly_budget_twd into monthly_budgets[pid][ym]
  if (!st.monthly_budgets) st.monthly_budgets = {};
  if (!st.daily_budgets) st.daily_budgets = {};
  // 每月匯率覆寫（沒寫過就空 dict，fallback 用 settings.expense_rate / income_rate）
  if (!st.settings) st.settings = {};
  if (!st.settings.monthly_rates) st.settings.monthly_rates = {};
  // current_month 永遠取系統當月（不存使用者設定值，避免 ISO/timezone 拉資料時誤判）
  // 想看其他月份請至「概覽」頁的月份選擇器
  const _now = new Date();
  st.settings.current_month = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}`;
  // 舊版有 daily_amort_override（給歷史 xlsx 匯入用），新系統不再使用，直接清掉
  if (st.daily_amort_override) delete st.daily_amort_override;
  // budget_changes：每產品每月的預算變動時序（forward-only band）
  if (!st.budget_changes) st.budget_changes = {};
  // report_config：成效報表每產品的欄位顯示設定 + 自訂計算欄位
  if (!st.report_config) st.report_config = {};
  if (Array.isArray(st.products)) {
    const ym = st?.settings?.current_month || "";
    st.products.forEach((p) => {
      if (p && "monthly_budget_twd" in p) {
        const v = Number(p.monthly_budget_twd);
        if (ym && Number.isFinite(v) && v > 0) {
          if (!st.monthly_budgets[p.id]) st.monthly_budgets[p.id] = {};
          if (st.monthly_budgets[p.id][ym] == null) {
            st.monthly_budgets[p.id][ym] = v;
          }
        }
        delete p.monthly_budget_twd;
      }
      // no_band 欄位:既有 av9_poquan / jk_poquan 第一次升上來時補成 true,
      // 維持原本「破圈系列不檢查 ±30% 帶寬」的行為;其餘產品預設 false。
      if (typeof p?.no_band !== "boolean") {
        p.no_band = (p?.id === "av9_poquan" || p?.id === "jk_poquan");
      }
      // is_poquan / parent_product_id:既有 av9_poquan / jk_poquan 自動歸位,
      // 未來新增的破圈(例:HYC_poquan)在產品編輯彈窗勾選即可,不再寫死。
      if (typeof p?.is_poquan !== "boolean") {
        p.is_poquan = (p?.id === "av9_poquan" || p?.id === "jk_poquan");
      }
      if (typeof p?.parent_product_id !== "string") {
        if (p?.id === "av9_poquan") p.parent_product_id = "AV9";
        else if (p?.id === "jk_poquan") p.parent_product_id = "JK";
        else p.parent_product_id = "";
      }
    });
  }
  // Ads: ensure renewal_reason + purchase_mode + lock_perf_adjust + eliminated defaults
  if (Array.isArray(st.ads)) {
    st.ads.forEach((a) => {
      if (!a.renewal_reason) a.renewal_reason = a.renewal_of ? "續費" : "初始";
      // 舊資料 / 舊匯入腳本的 reason 名稱遷移
      if (a.renewal_reason === "漲價") a.renewal_reason = "匯率調漲";
      else if (a.renewal_reason === "降價") a.renewal_reason = "匯率調降";
      if (!a.purchase_mode) {
        const wk = Object.keys(a.weights || {});
        a.purchase_mode = (wk.length === 1 && a.weights[wk[0]] === 100) ? "independent" : "shared";
      }
      if (typeof a.lock_perf_adjust !== "boolean") a.lock_perf_adjust = false;
      // 淘汰旗標：到期未續費、使用者明確標記不再通知。警告會跳過；廣告頁本週清單可保留作回顧
      if (typeof a.eliminated !== "boolean") a.eliminated = false;
      // 清掉舊匯入腳本(samples/build_v2_weight_log_priority.py)誤塞進 notes 的內部
      // debug 訊息(例:「V2 fallback INDEPENDENT(…)」、「V2 匯入(權重紀錄為主;…)」)。
      // notes 是給使用者寫備註的欄位,不該裝匯入腳本內部訊息。
      if (typeof a.notes === "string" && /^V2 /.test(a.notes.trim())) {
        a.notes = "";
      }
    });

    // X/Xt 配對整理(domain/auto-split.js):
    //   - 只在「兩側真正同家族母+破圈碰撞」時自動配對 st287 + st287t 樣式廣告
    //   - 解除舊版依代碼硬配、實為獨立採買的錯誤配對(例 1012 黃油圈 + 1012t 破圈)
    //   - 獨立採買單列多產品全 100% 拆成 per-product 副本
    reconcileSplitPairs(st);
    normalizeLegacySplitPairWeights(st);
  }
  normalizeTodosInState(st);
  if (!Array.isArray(st.yourls_actions)) st.yourls_actions = [];
  if (!Array.isArray(st.yourls_execution_logs)) st.yourls_execution_logs = [];
  reconcileDerivedState(st);
  st.version = VERSION;
  // 部署模式下,本機絕不快取 sheets_webapp_url / sheets_token,
  // 一律走 DEPLOY_SHEETS_URL/TOKEN(避免 JSON 匯入、舊版 cache、別台機器留下的 placeholder 污染)
  if (isDeployManaged() && st.settings) {
    st.settings.sheets_webapp_url = "";
    st.settings.sheets_token = "";
  }
  if (isYourlsWakeDeployManaged() && st.settings) {
    st.settings.yourls_wake_url = "";
    st.settings.yourls_wake_token = "";
  }
  return st;
}

function persist() {
  if (isDeployManaged() && state.settings) {
    state.settings.sheets_webapp_url = "";
    state.settings.sheets_token = "";
  }
  if (isYourlsWakeDeployManaged() && state.settings) {
    state.settings.yourls_wake_url = "";
    state.settings.yourls_wake_token = "";
  }
}

function persistUndo() {
  // Undo history is memory-only and is cleared by page reload.
}

// 推進 undo 堆疊（在每次 mutate 前呼叫）。同一秒內連續呼叫會合併（避免細碎 input 灌爆）。
let lastUndoPushAt = 0;
function pushUndo(label) {
  const now = Date.now();
  // 200ms 內的連續變動視為同一筆操作（避免拖曳/連打瞬間吞噬整個堆疊）
  if (now - lastUndoPushAt < 200 && undoStack.length > 0) {
    lastUndoPushAt = now;
    return;
  }
  lastUndoPushAt = now;
  undoStack.push({
    label: label || "操作",
    at: nowTaipeiTime(),
    snapshot: JSON.stringify(state),
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  persistUndo();
}

export function getState() {
  return state;
}

export function replaceState(next, label = "整批替換") {
  pushUndo(label);
  state = migrate(next);
  persist();
  emit();
}

export function update(mutator, label) {
  const beforeSyncIds = collectSyncEntityIds(state);
  pushUndo(label);
  mutator(state);
  // X/Xt 配對整理 + 未串鏈殘留段自動清理:放在 markRemovedSyncRows 之前,
  // 被清掉/拆分的列會由 before/after 差異自動登記進同步刪除佇列
  reconcileSplitPairs(state);
  pruneResidualSegments(state);
  markRemovedSyncRows(beforeSyncIds, collectSyncEntityIds(state));
  reconcileDerivedState(state);
  persist();
  emit();
}

// sync.js 專用：套用伺服器 LWW 合併。不進 undo（避免「同步」灌爆 ↶ 復原）；
// 仍會 persist + emit 讓畫面更新。
// 注意:這裡「不跑」殘留段清理 — applySync 在 pull 時逐 sheet 呼叫,
// Ads 先到、AdWeights 後到的半套狀態會讓清理誤判;清理走 pruneResidualsAfterSync,
// 由 sync.js 在「全部 sheet 合併完、無衝突」之後呼叫一次。
export function applySync(mutator) {
  mutator(state);
  reconcileDerivedState(state);
  persist();
  emit();
}

// 同步拉回完成後的配對整理 + 殘留段清理:不進 undo;刪除登記進同步刪除佇列,下次 push 推 tombstone
export function pruneResidualsAfterSync() {
  const beforeSyncIds = collectSyncEntityIds(state);
  const reconciled = reconcileSplitPairs(state);
  const removed = pruneResidualSegments(state);
  if (removed === 0 && reconciled === 0) return 0;
  markRemovedSyncRows(beforeSyncIds, collectSyncEntityIds(state));
  persist();
  emit();
  return removed + reconciled;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => fn(state));
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function resetAll() {
  const beforeSyncIds = collectSyncEntityIds(state);
  pushUndo("重設全部資料");
  state = defaultState();
  markRemovedSyncRows(beforeSyncIds, collectSyncEntityIds(state));
  persist();
  emit();
}

// ── Undo API ───────────────────────────────────────
export function canUndo() {
  return undoStack.length > 0;
}

export function peekUndo() {
  return undoStack.length > 0 ? undoStack[undoStack.length - 1] : null;
}

export function undo() {
  if (undoStack.length === 0) return null;
  const entry = undoStack.pop();
  const beforeSyncIds = collectSyncEntityIds(state);
  try {
    state = migrate(JSON.parse(entry.snapshot));
  } catch (e) {
    console.error("undo restore failed", e);
    return null;
  }
  markRemovedSyncRows(beforeSyncIds, collectSyncEntityIds(state));
  persist();
  persistUndo();
  emit();
  return entry;
}
