// 衝突佇列:當 push CAS 失敗或 pull 偵測到「本機 dirty + server 也改過」時,
// 把該筆衝突收進佇列等使用者處理。
//
// 結構:
//   conflict = {
//     id: 自動產生(用 sheetName::_id::timestamp)
//     sheetName: 哪張分頁
//     entityId: 該筆 row 的 _id
//     source: "push" | "pull"
//     detectedAt: ISO timestamp
//     mine: { dataRow, dataHeaders, fingerprint, knownVersion }  // 本機的狀態
//     theirs: { dataRow, dataHeaders, version, updatedAt }       // server 的狀態
//   }
//
// 持久化:localStorage,跨頁重整保留,直到使用者處理或清空。
//
// 監聽:supports subscribe(fn) 給 banner / UI 用,有變動時被通知。

import { logInfo, logWarn } from "../lib/sync-log.js";

const STORAGE_KEY = "cpa_conflicts_v1";
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save(arr) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); } catch {}
}

let queue = load();

function emit() {
  listeners.forEach((fn) => {
    try { fn(queue); } catch (e) { /* swallow listener errors */ }
  });
}

export function getConflicts() {
  return queue.slice();
}

export function getConflictCount() {
  return queue.length;
}

export function subscribeConflicts(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 加入一筆衝突。同一個 (sheetName, entityId) 已存在 → 用新的覆蓋(以最新 server 狀態為準)。
export function addConflict(conflict) {
  const key = `${conflict.sheetName}::${conflict.entityId}`;
  const idx = queue.findIndex((c) => `${c.sheetName}::${c.entityId}` === key);
  const enriched = {
    id: `${key}::${Date.now()}`,
    detectedAt: new Date().toISOString(),
    ...conflict,
  };
  if (idx >= 0) {
    queue[idx] = enriched;
    logInfo("conflict.update", { sheet: conflict.sheetName, id: conflict.entityId, source: conflict.source });
  } else {
    queue.push(enriched);
    logWarn("conflict.detected", { sheet: conflict.sheetName, id: conflict.entityId, source: conflict.source });
  }
  save(queue);
  emit();
}

// 解決衝突 → 從佇列移除。
export function removeConflict(conflictId) {
  const before = queue.length;
  queue = queue.filter((c) => c.id !== conflictId);
  if (queue.length < before) {
    save(queue);
    emit();
    logInfo("conflict.resolved", { conflictId });
  }
}

export function clearConflicts() {
  if (queue.length === 0) return;
  logInfo("conflict.clearAll", { count: queue.length });
  queue = [];
  save(queue);
  emit();
}
