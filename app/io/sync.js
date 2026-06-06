// Row-level CAS 同步層(v4 — 取代原本 silent LWW)
//
// 設計:
//   - 每筆 row 多一個 `_version` 整數欄位,server CAS 寫入時 +1
//   - sync_meta 額外存每筆 row 的 `_version`(_updated_at + fingerprint 仍保留)
//   - push 時帶 expected_version = sync_meta._version,server CAS 不符 → 進 conflict-store
//   - pull 時若 (server _updated_at 更新) AND (本機 fingerprint 跟 meta 不同) → 進 conflict-store
//     而非靜默 LWW
//
// sync_meta(localStorage `buyads_sync_meta_v1`):
//   { [sheetName]: { [_id]: { _updated_at, _version, fingerprint } } }
//   fingerprint 為 "__tombstone__" 代表 server 已標記刪除
//   forcePush 為 true 代表「使用者選了用我的方案,下次 push 強制重推」
//
// 衝突處理:
//   有衝突待處理時自動同步暫停(避免一直跳警告)。使用者開 conflict-resolver 處理後 sync 恢復。

import { getState, applySync, subscribe } from "../state.js";
import { getEffectiveSheetsUrl, getEffectiveSheetsToken, assertValidSheetsUrl } from "../lib/deploy-config.js";
import { showSyncBanner, markSyncDone } from "../lib/sync-banner.js";
import { TABLE_SYNC_SPECS } from "./sync-specs.js";
import { addConflict, getConflictCount, subscribeConflicts } from "./conflict-store.js";
import { logInfo, logWarn, logError } from "../lib/sync-log.js";
import { normalizeTodoCreatedAt } from "../domain/todo-utils.js";
import { formatAppsScriptJsonError, formatAppsScriptNonJsonError, isAppsScriptConfigErrorMessage } from "./apps-script-errors.js";
import {
  clearSyncDeleted,
  hasPendingSyncDeletions,
  loadPendingSyncDeletions,
} from "./sync-deletions.js";

// ===== 同步狀態廣播(給 sidebar status pill 用)=====
// 統一一份輕量狀態,有變動時 emit 給所有訂閱者(sidebar / debug overlay 等)。
// 不存到 localStorage,只在記憶體;主要供 UI 即時顯示。
const _statusListeners = new Set();
let _lastSuccessAt = 0;
let _lastFailedAt = 0;
let _lastError = "";
let _hasPendingChanges = false;  // state 動過但還沒 sync 成功
let _autoSyncSuspendedReason = "";
let _autoSyncSuspendedCredentialKey = "";

function _emitStatus() {
  for (const fn of _statusListeners) {
    try { fn(); } catch { /* swallow */ }
  }
}
export function subscribeSyncStatus(fn) {
  _statusListeners.add(fn);
  return () => _statusListeners.delete(fn);
}
export function getSyncStatus() {
  return {
    isSyncing,
    lastSuccessAt: _lastSuccessAt,
    lastFailedAt: _lastFailedAt,
    lastError: _lastError,
    hasPendingChanges: _hasPendingChanges || hasPendingSyncDeletions(),
    nextEarliestSyncAt,
    consecutiveFailures,
    autoSyncSuspendedReason: _autoSyncSuspendedReason,
    serverVersion: loadServerVersion(),
    conflictCount: getConflictCount(),
    isConfigured: hasCredentials(),
  };
}

// 自動同步調節
const DEBOUNCE_AFTER_CHANGE_MS = 5000;     // state 改後 5 秒無新變動 → 同步
const POLL_INTERVAL_MS = 30 * 1000;        // 每 30 秒背景同步一次
const MIN_GAP_BETWEEN_SYNCS_MS = 5000;     // 同步成功後至少這麼久才再跑

const META_KEY = "buyads_sync_meta_v1";
const VERSION_KEY = "buyads_server_version_v1";  // server 全域版本號的 last-seen,用來短路 pull
const META_COLS = ["_id", "_updated_at", "_deleted", "_version"];
const FP_DELIM = "";  // 不會出現在資料的分隔符
const TOMBSTONE_FP = "__tombstone__";

function pendingDeleteSet(pendingDeletions, sheetName) {
  return new Set((pendingDeletions?.[sheetName] || []).map((id) => String(id || "")).filter(Boolean));
}

function queuePendingDeleteClear(bucket, sheetName, id) {
  if (!sheetName || !id) return;
  if (!bucket[sheetName]) bucket[sheetName] = new Set();
  bucket[sheetName].add(id);
}

function flushPendingDeleteClears(bucket) {
  for (const [sheetName, ids] of Object.entries(bucket)) {
    clearSyncDeleted(sheetName, [...ids]);
  }
}

// ===== sync_meta 持久化 =====
function loadMeta() {
  try {
    const raw = localStorage.getItem(META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveMeta(meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}
function loadServerVersion() {
  try {
    const v = localStorage.getItem(VERSION_KEY);
    return v == null ? null : Number(v);
  } catch { return null; }
}
function saveServerVersion(v) {
  try { localStorage.setItem(VERSION_KEY, String(v)); } catch {}
}
export function resetSyncMeta() {
  try {
    localStorage.removeItem(META_KEY);
    localStorage.removeItem(VERSION_KEY);
  } catch {}
}

// ===== fingerprint:把資料 row 序列化成穩定字串供比對 =====
//
// Google Sheets 會把 "2026-05" 這種 YYYY-MM 字串自動轉成日期物件,讀回來
// 變成 "2026-05-01" 或 ISO 時戳。為避免 client 推 "2026-05" 後讀回 "2026-05-01"
// 永遠 fingerprint 不對 → 死循環衝突,在 fingerprint 階段把 YYYY-MM 值 canonicalize。
//
// 規則:
//   1. 看 header 包含 "(YYYY-MM)" → 該 cell 取前 7 字
//   2. 設定表 (key=current_month) → value 也取前 7 字
//   3. ISO 8601 timestamp "YYYY-MM-DDT..." → 取前 10 字(YYYY-MM-DD,主要給 created_at 用)
const DATE_TIME_DATA_HEADERS = new Set([
  "created_at",
  "approved_at",
  "claimed_at",
  "completed_at",
  "updated_at",
  "at",
  "建立時間",
  "Yourls批准時間",
  "Yourls套用時間",
]);

function isDateTimeDataHeader(header) {
  const h = String(header || "");
  return DATE_TIME_DATA_HEADERS.has(h) || (/_at$/.test(h) && !META_COLS.includes(h));
}

function canonicalizeDataCell(header, value, _id) {
  if (value == null) return value;
  const h = String(header || "");
  const s = (value instanceof Date) ? value.toISOString() : String(value);
  // 1. 月份欄(YYYY-MM)— Sheets 會把 "2026-05" 自動補成 "2026-05-01"
  if (h.includes("(YYYY-MM)") && /^\d{4}-\d{2}-?\d{0,2}/.test(s)) {
    return s.slice(0, 7);
  }
  // 2. 設定表特殊欄
  if (h === "value" && _id === "current_month" && /^\d{4}-\d{2}-?\d{0,2}/.test(s)) {
    return s.slice(0, 7);
  }
  if (isDateTimeDataHeader(h)) {
    return normalizeTodoCreatedAt(s);
  }
  return s;
}

function canonicalizeForFingerprint(headers, dataRow, _id) {
  if (!headers || headers.length === 0) return dataRow;
  return dataRow.map((v, i) => canonicalizeDataCell(headers[i], v, _id));
}

export function fingerprintDataRow(dataRow, headers, _id) {
  const row = canonicalizeForFingerprint(headers, dataRow, _id);
  return row.map((v) => {
    if (v == null) return "";
    if (typeof v === "number" && !Number.isFinite(v)) return "";
    if (v instanceof Date) return v.toISOString();
    return String(v);
  }).join(FP_DELIM);
}

// ===== Apps Script call =====
async function call(payload) {
  const s = getState();
  const url = getEffectiveSheetsUrl(s.settings);
  const token = getEffectiveSheetsToken(s.settings);
  if (!url) throw new Error("尚未設定 Apps Script Web App URL");
  if (!token) throw new Error("尚未設定 Token");
  assertValidSheetsUrl(url);

  const fd = new FormData();
  fd.append("payload", JSON.stringify({ ...payload, token }));
  let res;
  try {
    res = await fetch(url, { method: "POST", body: fd, redirect: "follow" });
  } catch (e) {
    logError("network.fetchFailed", { action: payload.action, error: String(e?.message || e) });
    throw e;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    logError("network.parseFailed", { action: payload.action, status: res.status, preview: text.slice(0, 200) });
    throw new Error(formatAppsScriptNonJsonError(text, res.status));
  }
  if (json.error) {
    logError("network.serverError", { action: payload.action, error: json.error });
    throw new Error(formatAppsScriptJsonError(json.error));
  }
  return json;
}

// 給設定頁的「測試連線」按鈕用 — 只 ping,不動資料。
// URL / Token 未設或錯誤 → 拋 Error。
export async function pingSheets() {
  return await call({ action: "ping" });
}

// 把 server 回的 raw row 解析成 { _id, _updated_at, _deleted, _version, dataRow, dataHeaders }
function parseServerRows(headers, rows) {
  const idIdx = headers.indexOf("_id");
  const updatedAtIdx = headers.indexOf("_updated_at");
  const deletedIdx = headers.indexOf("_deleted");
  const versionIdx = headers.indexOf("_version");
  if (idIdx < 0) return null;  // 沒 metadata(legacy sheet)
  const dataHeaders = headers.filter((h) => !META_COLS.includes(h));
  const dataIndices = dataHeaders.map((h) => headers.indexOf(h));
  return rows.map((row) => {
    const id = String(row[idIdx] || "");
    return {
      _id: id,
      _updated_at: String(row[updatedAtIdx] || ""),
      _deleted: String(row[deletedIdx] || "").toUpperCase() === "Y",
      _version: versionIdx >= 0 ? (Number(row[versionIdx]) || 0) : 0,
      dataRow: dataIndices.map((i, pos) => canonicalizeDataCell(dataHeaders[pos], row[i], id)),
      dataHeaders,
    };
  }).filter((r) => r._id);
}

// 把 legacy headers/rows 包裝成 serverRecords 格式(無 _updated_at / _version)
function legacyToServerRecords(spec, headers, rows) {
  if (!spec.legacyParse) return [];
  const records = spec.legacyParse(headers, rows);  // 回 [{ _id, dataRow }]
  return records.map((r) => ({
    _id: r._id,
    _updated_at: "",
    _deleted: false,
    _version: 0,
    dataRow: r.dataRow,
    dataHeaders: spec.dataHeaders,
  }));
}

// ===== 衝突 store 與 sync_meta 的橋接 callback =====
// conflict-resolver 把使用者的選擇套用後,呼叫這個 callback 來更新 sync_meta。
// 這樣下次 push 就會用對的 expected_version、且 forcePush 標記能讓 fingerprint 對得上也重推。
export function onConflictResolved(update) {
  const meta = loadMeta();
  const { sheetName, entityId, _version, _updated_at, forcePush } = update;
  if (!meta[sheetName]) meta[sheetName] = {};
  const existing = meta[sheetName][entityId] || {};
  meta[sheetName][entityId] = {
    _updated_at: _updated_at || existing._updated_at || "",
    _version: typeof _version === "number" ? _version : (existing._version || 0),
    fingerprint: forcePush
      ? "__force_push__"  // 跟任何本機 fingerprint 都不同 → 下次 sync 必推
      : (update.dataRow ? fingerprintDataRow(update.dataRow, update.dataHeaders, entityId) : existing.fingerprint),
  };
  saveMeta(meta);
  logInfo("conflict.metaUpdated", { sheet: sheetName, id: entityId, version: _version, forcePush: !!forcePush });
}

// ===== 核心同步流程 =====
export async function syncOnce(onProgress, options = {}) {
  const { serverWins = false } = options;

  // 有衝突待處理 → 暫停同步,等使用者處理
  if (getConflictCount() > 0) {
    logInfo("sync.pausedDueToConflicts", { count: getConflictCount() });
    return { ok: true, paused: "conflicts_pending" };
  }

  const meta = loadMeta();
  const lastSeenVersion = loadServerVersion();
  const pendingDeletions = loadPendingSyncDeletions();
  const hasPendingDeletionIntent = Object.values(pendingDeletions).some((ids) => (ids || []).length > 0);
  const pendingDeleteClears = {};
  const forcePushSheets = new Set();

  // ---- Step 0: 拿 server 版本號(輕量短路)
  let remoteMeta;
  try {
    remoteMeta = await call({ action: "readMeta" });
  } catch (e) {
    logError("sync.readMetaFailed", { error: String(e?.message || e) });
    throw e;
  }
  const serverVersion = Number(remoteMeta.server_version) || 0;
  let shouldPull = lastSeenVersion == null || serverVersion !== lastSeenVersion;
  if (!shouldPull) {
    for (const spec of TABLE_SYNC_SPECS) {
      const pendingIds = pendingDeletions[spec.sheetName] || [];
      if (pendingIds.some((id) => !meta[spec.sheetName]?.[id])) {
        shouldPull = true;
        break;
      }
    }
  }

  // ---- Step 1: 拉所有 sheet(一個 round trip)+ 合併 ----
  if (shouldPull) {
    onProgress?.({ phase: "pull", current: 0, total: 1, name: `拉取 ${TABLE_SYNC_SPECS.length} 張表...` });
    const sheetNames = TABLE_SYNC_SPECS.map((s) => s.sheetName);
    const resp = await call({ action: "readAllTables", sheetNames });
    const allSheets = resp.sheets || {};

    for (const spec of TABLE_SYNC_SPECS) {
      const { headers = [], rows = [] } = allSheets[spec.sheetName] || {};
      let serverRecords;
      let isModern = false;
      if (!headers.length) {
        serverRecords = [];
        if (!serverWins) forcePushSheets.add(spec.sheetName);
      } else {
        const parsed = parseServerRows(headers, rows);
        if (parsed === null) {
          serverRecords = legacyToServerRecords(spec, headers, rows);
          if (!serverWins) forcePushSheets.add(spec.sheetName);
        } else {
          serverRecords = parsed;
          isModern = true;
        }
      }

      const sheetMeta = meta[spec.sheetName] || {};

      // === 建本機 row map(用來偵測 dirty)===
      // localRecords: [{ _id, dataRow }],由 spec.flatten 從 state 推算
      const localRecords = spec.flatten(getState());
      const localById = new Map(localRecords.map((r) => [r._id, r]));
      const pendingDeletedIds = pendingDeleteSet(pendingDeletions, spec.sheetName);
      const serverRecordIds = new Set(serverRecords.map((r) => r._id));
      if (pendingDeletedIds.size > 0) {
        meta[spec.sheetName] = meta[spec.sheetName] || {};
        for (const id of pendingDeletedIds) {
          if (serverRecordIds.has(id) || localById.has(id)) continue;
          const known = meta[spec.sheetName][id] || {};
          meta[spec.sheetName][id] = {
            _updated_at: known._updated_at || "",
            _version: known._version || 0,
            fingerprint: TOMBSTONE_FP,
          };
          queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, id);
        }
      }

      if (serverWins && isModern) {
        // serverWins + modern:整片以 server 為準,但本機 dirty 的 row 進衝突佇列、不直接覆寫
        const serverIds = new Set(serverRecords.filter((r) => !r._deleted && !pendingDeletedIds.has(r._id)).map((r) => r._id));
        applySync((st) => {
          for (const sr of serverRecords) {
            if (pendingDeletedIds.has(sr._id)) {
              spec.removeFromState(st, sr._id);
              continue;
            }
            const localFP = localById.has(sr._id) ? fingerprintDataRow(localById.get(sr._id).dataRow, spec.dataHeaders, sr._id) : null;
            const knownFP = sheetMeta[sr._id]?.fingerprint;
            // canonical 過後本機 == server 就不算衝突(YYYY-MM 欄被 Sheets 自動轉成 YYYY-MM-DD
            // 的最大兇手在這:當 meta 還沒對齊時 knownFP 是 undefined,單純比 knownFP 會誤判 dirty)
            const serverFP = !sr._deleted ? fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) : null;
            const sameContent = localFP != null && serverFP != null && localFP === serverFP;
            const localDirty = !sameContent && localFP != null && localFP !== knownFP && knownFP !== TOMBSTONE_FP && knownFP !== "__force_push__";
            const serverChanged = !knownFP || sr._updated_at > (sheetMeta[sr._id]?._updated_at || "");

            if (localDirty && serverChanged && !sr._deleted) {
              // 衝突:本機 dirty + server 也改過 → 進佇列
              addConflict({
                sheetName: spec.sheetName,
                entityId: sr._id,
                source: "pull",
                mine: {
                  dataRow: localById.get(sr._id).dataRow,
                  dataHeaders: spec.dataHeaders,
                  fingerprint: localFP,
                  knownVersion: sheetMeta[sr._id]?._version || 0,
                },
                theirs: {
                  dataRow: sr.dataRow,
                  dataHeaders: spec.dataHeaders,
                  version: sr._version,
                  updatedAt: sr._updated_at,
                  _deleted: sr._deleted,
                },
              });
              continue;
            }

            if (sr._deleted) {
              spec.removeFromState(st, sr._id);
            } else {
              const obj = Object.fromEntries(spec.dataHeaders.map((h, i) => [h, sr.dataRow[i]]));
              spec.upsertInState(st, sr._id, obj);
            }
          }
          // 刪除 local 有但 server 沒有的 row,但本機 dirty 的留下(可能是本機新增還沒推上去)
          const localIds = spec.flatten(st).map((r) => r._id);
          for (const id of localIds) {
            if (serverIds.has(id)) continue;
            // server 沒有 + 本機 dirty(不在 meta 內 = 本機新增還沒推)→ 留下
            if (!sheetMeta[id]) continue;
            spec.removeFromState(st, id);
          }
        });
        // 重設 meta:跟 server 對齊(被加入衝突的 row 不更新 meta,等使用者解完再更新)
        const conflictedIds = new Set();
        for (const sr of serverRecords) {
          if (pendingDeletedIds.has(sr._id)) continue;
          const localFP = localById.has(sr._id) ? fingerprintDataRow(localById.get(sr._id).dataRow, spec.dataHeaders, sr._id) : null;
          const knownFP = sheetMeta[sr._id]?.fingerprint;
          const serverFP = !sr._deleted ? fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) : null;
          const sameContent = localFP != null && serverFP != null && localFP === serverFP;
          if (!sameContent && localFP != null && localFP !== knownFP && knownFP !== TOMBSTONE_FP && knownFP !== "__force_push__"
              && (!knownFP || sr._updated_at > (sheetMeta[sr._id]?._updated_at || ""))
              && !sr._deleted) {
            conflictedIds.add(sr._id);
          }
        }
        meta[spec.sheetName] = meta[spec.sheetName] || {};
        for (const sr of serverRecords) {
          if (pendingDeletedIds.has(sr._id)) {
            meta[spec.sheetName][sr._id] = sr._deleted
              ? { _updated_at: sr._updated_at, _version: sr._version, fingerprint: TOMBSTONE_FP }
              : { _updated_at: sr._updated_at, _version: sr._version, fingerprint: fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) };
            if (sr._deleted) queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, sr._id);
            continue;
          }
          if (conflictedIds.has(sr._id)) continue;
          meta[spec.sheetName][sr._id] = sr._deleted
            ? { _updated_at: sr._updated_at, _version: sr._version, fingerprint: TOMBSTONE_FP }
            : { _updated_at: sr._updated_at, _version: sr._version, fingerprint: fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) };
        }
      } else if (serverWins) {
        // server 是 empty / legacy / no-headers — 不動 local 也不動 meta
      } else {
        // 一般合併:LWW + 衝突偵測
        applySync((st) => {
          for (const sr of serverRecords) {
            if (pendingDeletedIds.has(sr._id)) {
              spec.removeFromState(st, sr._id);
              continue;
            }
            const known = sheetMeta[sr._id];
            const isNewerOrFirst = !known || (sr._updated_at && sr._updated_at > (known._updated_at || ""));
            if (!isNewerOrFirst) continue;

            // 偵測本機 dirty:server 比 meta 新,且本機跟 meta fingerprint 不同
            const localFP = localById.has(sr._id) ? fingerprintDataRow(localById.get(sr._id).dataRow, spec.dataHeaders, sr._id) : null;
            const knownFP = known?.fingerprint;
            const serverFP = !sr._deleted ? fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) : null;
            const sameContent = localFP != null && serverFP != null && localFP === serverFP;
            const localDirty = !sameContent && localFP != null && knownFP && localFP !== knownFP
                              && knownFP !== TOMBSTONE_FP && knownFP !== "__force_push__";

            if (localDirty && !sr._deleted) {
              addConflict({
                sheetName: spec.sheetName,
                entityId: sr._id,
                source: "pull",
                mine: {
                  dataRow: localById.get(sr._id).dataRow,
                  dataHeaders: spec.dataHeaders,
                  fingerprint: localFP,
                  knownVersion: known?._version || 0,
                },
                theirs: {
                  dataRow: sr.dataRow,
                  dataHeaders: spec.dataHeaders,
                  version: sr._version,
                  updatedAt: sr._updated_at,
                  _deleted: sr._deleted,
                },
              });
              continue;  // 不套用,等使用者處理
            }

            if (sr._deleted) {
              spec.removeFromState(st, sr._id);
            } else {
              const obj = Object.fromEntries(spec.dataHeaders.map((h, i) => [h, sr.dataRow[i]]));
              spec.upsertInState(st, sr._id, obj);
            }
          }
        });

        // 更新 meta:沒進衝突的 row 對齊 server 狀態
        if (!meta[spec.sheetName]) meta[spec.sheetName] = {};
        const conflictedIds = new Set();
        for (const sr of serverRecords) {
          if (pendingDeletedIds.has(sr._id)) {
            meta[spec.sheetName][sr._id] = sr._deleted
              ? { _updated_at: sr._updated_at, _version: sr._version, fingerprint: TOMBSTONE_FP }
              : { _updated_at: sr._updated_at, _version: sr._version, fingerprint: fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) };
            if (sr._deleted) queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, sr._id);
            continue;
          }
          const known = sheetMeta[sr._id];
          const isNewerOrFirst = !known || (sr._updated_at && sr._updated_at > (known._updated_at || ""));
          if (!isNewerOrFirst) continue;
          const localFP = localById.has(sr._id) ? fingerprintDataRow(localById.get(sr._id).dataRow, spec.dataHeaders, sr._id) : null;
          const knownFP = known?.fingerprint;
          const serverFP = !sr._deleted ? fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) : null;
          const sameContent = localFP != null && serverFP != null && localFP === serverFP;
          const localDirty = !sameContent && localFP != null && knownFP && localFP !== knownFP
                            && knownFP !== TOMBSTONE_FP && knownFP !== "__force_push__";
          if (localDirty && !sr._deleted) {
            conflictedIds.add(sr._id);
            continue;
          }
          meta[spec.sheetName][sr._id] = sr._deleted
            ? { _updated_at: sr._updated_at, _version: sr._version, fingerprint: TOMBSTONE_FP }
            : { _updated_at: sr._updated_at, _version: sr._version, fingerprint: fingerprintDataRow(sr.dataRow, spec.dataHeaders, sr._id) };
        }
      }
    }

    saveServerVersion(serverVersion);
    logInfo("sync.pulled", { server_version: serverVersion, conflicts: getConflictCount() });
  }

  // 拉完發現有衝突 → 不要 push,等使用者處理
  if (getConflictCount() > 0) {
    saveMeta(meta);
    flushPendingDeleteClears(pendingDeleteClears);
    saveServerVersion(serverVersion);
    return { ok: true, pulled: shouldPull, pushedTables: 0, conflicts: getConflictCount() };
  }

  if (serverWins && !hasPendingDeletionIntent) {
    saveMeta(meta);
    flushPendingDeleteClears(pendingDeleteClears);
    saveServerVersion(serverVersion);
    return { ok: true, pulled: shouldPull, pushedTables: 0, serverWins: true };
  }

  // ---- Step 2: 對每張表計算 dirty + deletions → upsert ----
  let totalUpserts = 0;
  let latestPushedVersion = serverVersion;
  for (const spec of TABLE_SYNC_SPECS) {
    const dataHeaders = spec.dataHeaders;
    const fullHeaders = [...dataHeaders, ...META_COLS];
    const localRecords = spec.flatten(getState());
    const sheetMeta = meta[spec.sheetName] || {};

    const upserts = [];
    const upsertIds = [];
    const localIds = new Set(localRecords.map((r) => r._id));
    const isFullPush = forcePushSheets.has(spec.sheetName);
    const pendingDeletedIds = pendingDeleteSet(pendingDeletions, spec.sheetName);

    // 改動 / 新增
    for (const lr of localRecords) {
      let needsPush = isFullPush;
      const known = sheetMeta[lr._id];
      const expectedVersion = known?._version || 0;
      if (!needsPush) {
        const fp = fingerprintDataRow(lr.dataRow, dataHeaders, lr._id);
        const isForcePush = known?.fingerprint === "__force_push__";
        needsPush = !known || known.fingerprint !== fp || isForcePush;
      }
      if (needsPush) {
        // _id, _updated_at, _deleted, _version 順序對齊 META_COLS
        upserts.push([...lr.dataRow, lr._id, "", "", expectedVersion]);
        upsertIds.push(lr._id);
      }
    }

    // 刪除:sync_meta 有但 local flatten 不在,且尚未 tombstone
    const deletedIds = [];
    const deleteCandidates = new Set([...Object.keys(sheetMeta), ...pendingDeletedIds]);
    for (const id of deleteCandidates) {
      const known = sheetMeta[id];
      if (known?.fingerprint === TOMBSTONE_FP) {
        if (pendingDeletedIds.has(id)) queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, id);
        continue;
      }
      if (localIds.has(id)) {
        if (pendingDeletedIds.has(id)) queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, id);
        continue;
      }
      if (!known) {
        if (pendingDeletedIds.has(id)) queuePendingDeleteClear(pendingDeleteClears, spec.sheetName, id);
        continue;
      }
      const expectedVersion = known._version || 0;
      upserts.push([...dataHeaders.map(() => ""), id, "", "Y", expectedVersion]);
      upsertIds.push(id);
      deletedIds.push(id);
    }

    if (upserts.length === 0) continue;

    onProgress?.({ phase: "push", current: totalUpserts + 1, total: TABLE_SYNC_SPECS.length, name: spec.sheetName });
    totalUpserts++;

    let resp;
    try {
      resp = await call({
        action: "upsertRows",
        sheetName: spec.sheetName,
        headers: fullHeaders,
        rows: upserts,
      });
    } catch (e) {
      logError("sync.upsertFailed", { sheet: spec.sheetName, count: upserts.length, error: String(e?.message || e) });
      throw e;
    }

    // 處理 applied:更新 sync_meta
    if (!meta[spec.sheetName]) meta[spec.sheetName] = {};
    const localById = new Map(localRecords.map((r) => [r._id, r]));
    const deletedSet = new Set(deletedIds);
    for (const a of (resp.applied || [])) {
      if (deletedSet.has(a._id)) {
        meta[spec.sheetName][a._id] = {
          _updated_at: a._updated_at,
          _version: a._version,
          fingerprint: TOMBSTONE_FP,
        };
        clearSyncDeleted(spec.sheetName, [a._id]);
      } else {
        const lr = localById.get(a._id);
        if (lr) {
          meta[spec.sheetName][a._id] = {
            _updated_at: a._updated_at,
            _version: a._version,
            fingerprint: fingerprintDataRow(lr.dataRow, dataHeaders, lr._id),
          };
        }
      }
    }
    if ((resp.applied || []).length > 0) {
      logInfo("sync.pushed", { sheet: spec.sheetName, applied: resp.applied.length });
    }

    // 處理 conflicts:進 conflict-store
    for (const c of (resp.conflicts || [])) {
      const serverDataRow = c.current_row.slice(0, dataHeaders.length);
      if (deletedSet.has(c._id)) {
        meta[spec.sheetName][c._id] = {
          _updated_at: c.current_updated_at,
          _version: c.current_version,
          fingerprint: fingerprintDataRow(serverDataRow, dataHeaders, c._id),
        };
        continue;
      }
      const lr = localById.get(c._id);
      if (!lr) continue;  // 我們不知道這筆?跳過(理論上不會發生)
      // 從 current_row 解出 server 的 dataRow + metadata
      addConflict({
        sheetName: spec.sheetName,
        entityId: c._id,
        source: "push",
        mine: {
          dataRow: lr.dataRow,
          dataHeaders: dataHeaders,
          fingerprint: fingerprintDataRow(lr.dataRow, dataHeaders, lr._id),
          knownVersion: sheetMeta[c._id]?._version || 0,
        },
        theirs: {
          dataRow: serverDataRow,
          dataHeaders: dataHeaders,
          version: c.current_version,
          updatedAt: c.current_updated_at,
          _deleted: false,
        },
      });
    }
    if ((resp.conflicts || []).length > 0) {
      logWarn("sync.conflicts", { sheet: spec.sheetName, count: resp.conflicts.length });
    }

    if (resp.server_version != null) latestPushedVersion = Number(resp.server_version);
  }

  saveMeta(meta);
  flushPendingDeleteClears(pendingDeleteClears);
  saveServerVersion(latestPushedVersion);
  return { ok: true, pulled: shouldPull, pushedTables: totalUpserts, conflicts: getConflictCount() };
}

// 給 settings UI 看的:大致狀態
export function getSyncMetaStats() {
  const meta = loadMeta();
  const stats = {};
  for (const sheetName of Object.keys(meta)) {
    const entries = Object.values(meta[sheetName]);
    stats[sheetName] = {
      tracked: entries.length,
      tombstones: entries.filter((e) => e.fingerprint === TOMBSTONE_FP).length,
    };
  }
  return stats;
}

// ===== Orchestrator =====
let isSyncing = false;
let lastSyncEndedAt = 0;
let debounceTimer = null;
let pollTimer = null;
let orchestratorStarted = false;
let consecutiveFailures = 0;
let nextEarliestSyncAt = 0;

function hasCredentials() {
  const s = getState();
  return !!(getEffectiveSheetsUrl(s.settings) && getEffectiveSheetsToken(s.settings));
}

function currentCredentialKey() {
  const s = getState();
  return `${getEffectiveSheetsUrl(s.settings)}\n${getEffectiveSheetsToken(s.settings)}`;
}

export function resetSyncFailureState() {
  const hadFailure = consecutiveFailures > 0 || !!_autoSyncSuspendedReason || !!_lastError;
  consecutiveFailures = 0;
  nextEarliestSyncAt = 0;
  _autoSyncSuspendedReason = "";
  _autoSyncSuspendedCredentialKey = "";
  _lastError = "";
  if (hadFailure) {
    logInfo("sync.failureStateReset");
    _emitStatus();
  }
}

function clearSuspensionIfCredentialsChanged() {
  if (!_autoSyncSuspendedReason) return;
  if (currentCredentialKey() === _autoSyncSuspendedCredentialKey) return;
  resetSyncFailureState();
  logInfo("sync.credentialsChangedResuming");
}

function suspendAutoSyncForConfigError(e, reason) {
  const message = String(e?.message || e);
  _autoSyncSuspendedReason = message;
  _autoSyncSuspendedCredentialKey = currentCredentialKey();
  consecutiveFailures = 0;
  nextEarliestSyncAt = 0;
  _lastFailedAt = Date.now();
  _lastError = message;
  markSyncDone(`✗ 同步已暫停：${message}`, "bad");
  logError("sync.suspendedConfigError", { reason, error: message });
}

async function runSyncIfReady(reason, options = {}) {
  if (isSyncing) return;
  if (!hasCredentials()) return;
  clearSuspensionIfCredentialsChanged();
  if (_autoSyncSuspendedReason) return;
  if (Date.now() < nextEarliestSyncAt) return;
  if (Date.now() - lastSyncEndedAt < MIN_GAP_BETWEEN_SYNCS_MS) return;
  // 衝突待處理 → 不要再同步
  if (getConflictCount() > 0) {
    logInfo("sync.skippedDueToConflicts", { reason, count: getConflictCount() });
    return;
  }

  isSyncing = true;
  _emitStatus();
  try {
    const result = await syncOnce(
      (p) => showSyncBanner({ ...p, name: `${reason} · ${p.name}` }),
      options,
    );
    consecutiveFailures = 0;
    nextEarliestSyncAt = 0;
    if (result.paused === "conflicts_pending") return;
    if (result.pulled || result.pushedTables > 0) {
      markSyncDone(`✓ 同步完成(${reason})`, "ok");
    }
    if (result.conflicts > 0) {
      markSyncDone(`⚠️ 有 ${result.conflicts} 筆衝突待處理`, "bad");
    }
    // 同步成功 → 清掉 pending(只在 push 沒衝突時才算真的全推上去)
    _lastSuccessAt = Date.now();
    _lastError = "";
    if ((result.conflicts || 0) === 0) _hasPendingChanges = hasPendingSyncDeletions();
  } catch (e) {
    if (isAppsScriptConfigErrorMessage(e?.message || e)) {
      suspendAutoSyncForConfigError(e, reason);
      return;
    }
    consecutiveFailures += 1;
    const backoffMs = Math.min(10 * 60 * 1000, 30 * 1000 * Math.pow(2, consecutiveFailures - 1));
    nextEarliestSyncAt = Date.now() + backoffMs;
    markSyncDone(`✗ 同步失敗:${e.message}(${Math.round(backoffMs / 1000)}s 後再試)`, "bad");
    logError("sync.runFailed", { reason, attempts: consecutiveFailures, error: String(e?.message || e) });
    _lastFailedAt = Date.now();
    _lastError = String(e?.message || e);
  } finally {
    isSyncing = false;
    lastSyncEndedAt = Date.now();
    _emitStatus();
  }
}

export function initSyncOrchestrator() {
  if (orchestratorStarted) return;
  orchestratorStarted = true;

  setTimeout(() => runSyncIfReady("啟動載入", { serverWins: true }), 100);

  subscribe(() => {
    // state 動了 → 標 dirty 並通知 status 訂閱者(sidebar 即時亮起「有未同步變更」)
    // 但若同步中,變動可能是 applySync(伺服器拉下來的)觸發的,不能算成 user dirty
    if (!isSyncing && !_hasPendingChanges) {
      _hasPendingChanges = true;
      _emitStatus();
    }
    if (isSyncing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSyncIfReady("改動後");
    }, DEBOUNCE_AFTER_CHANGE_MS);
  });

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => runSyncIfReady("背景輪詢", { serverWins: true }), POLL_INTERVAL_MS);

  // 衝突解決完(佇列歸零)→ 立刻試一次 sync
  subscribeConflicts((queue) => {
    // 衝突數變動 → 通知 status 訂閱者(讓 sidebar 即時更新衝突徽章)
    _emitStatus();
    if (queue.length === 0 && orchestratorStarted) {
      setTimeout(() => runSyncIfReady("衝突已解決"), 200);
    }
  });
}

// 給「☁️ 推到 Sheets」/「⬇️ 從 Sheets 拉下來」手動按鈕呼叫
export async function manualSync() {
  if (isSyncing) throw new Error("同步進行中,請稍候");
  if (getConflictCount() > 0) throw new Error("有衝突待處理,請先解決");
  _autoSyncSuspendedReason = "";
  _autoSyncSuspendedCredentialKey = "";
  isSyncing = true;
  _emitStatus();
  try {
    await syncOnce((p) => showSyncBanner(p));
    resetSyncFailureState();
    _lastSuccessAt = Date.now();
    if (getConflictCount() > 0) {
      markSyncDone(`⚠️ 有 ${getConflictCount()} 筆衝突待處理`, "bad");
    } else {
      _hasPendingChanges = hasPendingSyncDeletions();
      markSyncDone("✓ 手動同步完成", "ok");
    }
  } catch (e) {
    if (isAppsScriptConfigErrorMessage(e?.message || e)) {
      suspendAutoSyncForConfigError(e, "manual");
    }
    markSyncDone(`✗ 手動同步失敗:${e.message}`, "bad");
    logError("sync.manualFailed", { error: String(e?.message || e) });
    _lastFailedAt = Date.now();
    _lastError = String(e?.message || e);
    throw e;
  } finally {
    isSyncing = false;
    lastSyncEndedAt = Date.now();
    _emitStatus();
  }
}
