import { VERSION, defaultState } from "./schema.js";
import { nowTaipeiTime } from "./lib/dates.js";

const KEY = "buyads_state_v1";
const UNDO_KEY = "buyads_undo_v1";
const MAX_UNDO = 8;
const listeners = new Set();
let state = load();
let undoStack = loadUndo();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return migrate(parsed);
  } catch (e) {
    console.error("state load failed", e);
    return defaultState();
  }
}

function loadUndo() {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-MAX_UNDO) : [];
  } catch {
    return [];
  }
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
      // 淘汰旗標：到期未續費、使用者明確標記不再通知。即將到期清單會跳過
      if (typeof a.eliminated !== "boolean") a.eliminated = false;
      // 清掉舊匯入腳本(samples/build_v2_weight_log_priority.py)誤塞進 notes 的內部
      // debug 訊息(例:「V2 fallback INDEPENDENT(…)」、「V2 匯入(權重紀錄為主;…)」)。
      // notes 是給使用者寫備註的欄位,不該裝匯入腳本內部訊息。
      if (typeof a.notes === "string" && /^V2 /.test(a.notes.trim())) {
        a.notes = "";
      }
    });
  }
  st.version = VERSION;
  return st;
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function persistUndo() {
  try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch {}
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
  pushUndo(label);
  mutator(state);
  persist();
  emit();
}

// sync.js 專用：套用伺服器 LWW 合併。不進 undo（避免「同步」灌爆 ↶ 復原）；
// 仍會 persist + emit 讓畫面更新。
export function applySync(mutator) {
  mutator(state);
  persist();
  emit();
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
  pushUndo("重設全部資料");
  state = defaultState();
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
  try {
    state = migrate(JSON.parse(entry.snapshot));
  } catch (e) {
    console.error("undo restore failed", e);
    return null;
  }
  persist();
  persistUndo();
  emit();
  return entry;
}
