// CPA state container — localStorage namespace `cpa_*`,跟 CPT 完全隔離。
// 結構參考 CPT app/state.js,簡化掉廣告 / 權重的 migration。

import { VERSION, defaultState } from "./schema.js";
import { nowTaipeiTime } from "./lib/dates.js";

const KEY = "cpa_state_v1";
const UNDO_KEY = "cpa_undo_v1";
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
    console.error("cpa state load failed", e);
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

// 結構升級。目前 schema v1,留空,未來新增欄位再加 migration step。
function migrate(st) {
  if (!st || typeof st !== "object") return defaultState();
  if (!st.settings) st.settings = {};
  if (!Array.isArray(st.products)) st.products = [];
  if (!Array.isArray(st.publishers)) st.publishers = [];
  if (!Array.isArray(st.channels)) st.channels = [];
  if (!Array.isArray(st.payments)) st.payments = [];
  if (!Array.isArray(st.install_data)) st.install_data = [];
  if (!Array.isArray(st.custom_metrics)) st.custom_metrics = [];
  if (!Array.isArray(st.todos)) st.todos = [];
  // current_month 永遠用系統當月,避免跨月誤判
  const _now = new Date();
  st.settings.current_month = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, "0")}`;
  st.version = VERSION;
  return st;
}

function persist() {
  localStorage.setItem(KEY, JSON.stringify(state));
}

function persistUndo() {
  try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch {}
}

let lastUndoPushAt = 0;
function pushUndo(label) {
  const now = Date.now();
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

// sync.js 專用:套用伺服器合併。不進 undo(避免「同步」灌爆 ↶ 復原);
// 仍 persist + emit 讓畫面更新。
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
