// Row-level LWW 同步層
//
// 設計：
//   - 每張表有一個 spec（TABLE_SYNC_SPECS）描述如何在 nested state 與 row list 互轉
//   - state 不變動 shape；view code 完全不動
//   - sync_meta 是 per-device 紀錄（在 localStorage `buyads_sync_meta_v1`）
//     形式：{ [sheetName]: { [_id]: { _updated_at, fingerprint } } }
//     fingerprint 為 "__tombstone__" 代表 server 已標記刪除
//
// Sync 順序（每次 syncOnce）:
//   1. 對每張表 readTable (拉 server 全部 row，含 metadata)
//   2. LWW 合併 server rows 進 local state（spec.applyServerRows）
//      - 同時更新 _sync_meta（用 server 的 _updated_at 為單一時間源）
//   3. 對每張表計算 dirty + deletions：
//      - dirty: local row 的 fingerprint 不等於 sync_meta 的 fingerprint
//      - deletions: sync_meta 有但 local flatten 沒有的 id（且不是已 tombstone）
//   4. upsertRows，用 server 回的 _updated_at 更新 sync_meta
//
// 衝突解決：LWW（後寫贏）。client 改完未 sync 時，pull 階段拿到的 server row 若 _updated_at
// 比 sync_meta 紀錄新（代表 server 在我們 sync 之間被別人改過），server 版本套進 local，
// 覆蓋我們的改動。

import { getState, applySync, subscribe } from "../state.js";
import { getEffectiveSheetsUrl, getEffectiveSheetsToken } from "../lib/deploy-config.js";
import { showSyncBanner, markSyncDone } from "../lib/sync-banner.js";
import { TABLE_SYNC_SPECS } from "./sync-specs.js";

// 自動同步調節
const DEBOUNCE_AFTER_CHANGE_MS = 5000;     // state 改後 5 秒無新變動 → 同步
const POLL_INTERVAL_MS = 30 * 1000;        // 每 30 秒背景同步一次
const MIN_GAP_BETWEEN_SYNCS_MS = 5000;     // 同步成功後至少這麼久才再跑

const META_KEY = "buyads_sync_meta_v1";
const VERSION_KEY = "buyads_server_version_v1";  // server 全域版本號的 last-seen,用來短路 pull
const META_COLS = ["_id", "_updated_at", "_deleted"];
const FP_DELIM = "";  // 不會出現在資料的分隔符
const TOMBSTONE_FP = "__tombstone__";

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

// ===== fingerprint：把資料 row 序列化成穩定字串供比對 =====
//
// 只針對「資料欄位」(不含 META_COLS)。同一筆 row 不論在 client 或 server 端
// 經過 fingerprintDataRow 應產生同樣字串（用穩定的 stringify）。
export function fingerprintDataRow(dataRow) {
  return dataRow.map((v) => {
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

  const fd = new FormData();
  fd.append("payload", JSON.stringify({ ...payload, token }));
  const res = await fetch(url, { method: "POST", body: fd, redirect: "follow" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`回應非 JSON（前 200 字）：${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error);
  return json;
}

// 把 server 回的 raw row 解析成 { _id, _updated_at, _deleted, dataRow, dataHeaders }
function parseServerRows(headers, rows) {
  const idIdx = headers.indexOf("_id");
  const updatedAtIdx = headers.indexOf("_updated_at");
  const deletedIdx = headers.indexOf("_deleted");
  if (idIdx < 0) {
    // 沒 metadata（legacy sheet）→ 回 null,讓 caller 判斷走 legacyParse
    return null;
  }
  const dataHeaders = headers.filter((h) => !META_COLS.includes(h));
  const dataIndices = dataHeaders.map((h) => headers.indexOf(h));
  return rows.map((row) => ({
    _id: String(row[idIdx] || ""),
    _updated_at: String(row[updatedAtIdx] || ""),
    _deleted: String(row[deletedIdx] || "").toUpperCase() === "Y",
    dataRow: dataIndices.map((i) => row[i]),
    dataHeaders,
  })).filter((r) => r._id);
}

// 把 legacy headers/rows 包裝成 serverRecords 格式（無 _updated_at,所以 LWW 一定是 local 贏）
function legacyToServerRecords(spec, headers, rows) {
  if (!spec.legacyParse) return [];
  const records = spec.legacyParse(headers, rows);  // 回 [{ _id, dataRow }]
  return records.map((r) => ({
    _id: r._id,
    _updated_at: "",  // 空字串字典序最小,任何 server 寫入後一定 > 它
    _deleted: false,
    dataRow: r.dataRow,
    dataHeaders: spec.dataHeaders,
  }));
}

// ===== 核心同步流程 =====
//
// 流程：
//   1. readMeta（輕量,~200ms）→ 取得 server_version
//   2. 若 server_version 不等於本機 last-seen → 一次 readAllTables 拿全部 sheet（1 個 round trip）
//   3. LWW 合併進 state
//   4. 對每張表計算 dirty + tombstone,有的話 upsertRows
//   5. 用 server 回的 server_version 更新 last-seen
//
// onProgress 收到 { phase, current, total, name } — 跟現有 sync-banner 介面相容
//
// options:
//   - serverWins (預設 false):server 死贏模式。拉到 server 資料後不做 LWW,
//     一律以 server 覆寫 local;local 有但 server 沒的 row 直接刪除;meta 重設成 server 一致。
//     並完全跳過 push 階段 — 用於「開站」與「背景輪詢」,避免把陳年舊資料推上 Sheets。
//     僅在 server 是「modern schema(有 _id 欄)」時才動 local;empty / legacy 格式一律保留 local。
export async function syncOnce(onProgress, options = {}) {
  const { serverWins = false } = options;
  const meta = loadMeta();
  const lastSeenVersion = loadServerVersion();

  // 哪些 sheet 在這次 sync 中偵測到 legacy 格式 → 後面 push 階段全部 row 都送
  const forcePushSheets = new Set();

  // ---- Step 0: 拿 server 版本號（輕量短路）— 不顯示 banner（避免閒置時頻繁跳通知）
  const remoteMeta = await call({ action: "readMeta" });
  const serverVersion = Number(remoteMeta.server_version) || 0;

  // 是否需要拉全部 sheet：第一次 sync(lastSeen=null) 或 server 版本與本機不一致
  const shouldPull = lastSeenVersion == null || serverVersion !== lastSeenVersion;

  // ---- Step 1: 拉所有 sheet（一個 round trip）+ LWW 合併 ----
  if (shouldPull) {
    onProgress?.({ phase: "pull", current: 0, total: 1, name: `拉取 ${TABLE_SYNC_SPECS.length} 張表...` });
    const sheetNames = TABLE_SYNC_SPECS.map((s) => s.sheetName);
    const resp = await call({ action: "readAllTables", sheetNames });
    const allSheets = resp.sheets || {};

    for (const spec of TABLE_SYNC_SPECS) {
      const { headers = [], rows = [] } = allSheets[spec.sheetName] || {};
      let serverRecords;
      let isModern = false;  // server 是否為 modern schema(有 _id 欄) — 決定 serverWins 是否可動 local
      if (!headers.length) {
        serverRecords = [];
        // serverWins:server 是空 / 沒分頁 → 視為「無法判斷」,不要動 local
        // 一般模式:照舊 forcePush 上去(seeding 行為)
        if (!serverWins) forcePushSheets.add(spec.sheetName);
      } else {
        const parsed = parseServerRows(headers, rows);
        if (parsed === null) {
          serverRecords = legacyToServerRecords(spec, headers, rows);
          // serverWins:legacy 格式不動 local(避免半遷移狀態誤砍)
          if (!serverWins) forcePushSheets.add(spec.sheetName);
        } else {
          serverRecords = parsed;
          isModern = true;
        }
      }

      // ── 合併分支 ──
      // serverWins + modern schema:整片以 server 為準(無 LWW、刪除 local extras)
      // 其餘:LWW 合併(原邏輯)
      const sheetMeta = meta[spec.sheetName] || {};
      if (serverWins && isModern) {
        const serverIds = new Set(serverRecords.filter((r) => !r._deleted).map((r) => r._id));
        applySync((st) => {
          // 1. 套用 server 所有 row(刪除標記 / 資料一律覆寫,不檢查 _updated_at)
          for (const sr of serverRecords) {
            if (sr._deleted) {
              spec.removeFromState(st, sr._id);
            } else {
              const obj = Object.fromEntries(spec.dataHeaders.map((h, i) => [h, sr.dataRow[i]]));
              spec.upsertInState(st, sr._id, obj);
            }
          }
          // 2. 刪除 local 有但 server 沒有的 row(server 是唯一真相)
          const localIds = spec.flatten(st).map((r) => r._id);
          for (const id of localIds) {
            if (!serverIds.has(id)) spec.removeFromState(st, id);
          }
        });
        // 重設 meta = 跟 server 完全一致
        meta[spec.sheetName] = {};
        for (const sr of serverRecords) {
          meta[spec.sheetName][sr._id] = sr._deleted
            ? { _updated_at: sr._updated_at, fingerprint: TOMBSTONE_FP }
            : { _updated_at: sr._updated_at, fingerprint: fingerprintDataRow(sr.dataRow) };
        }
      } else if (serverWins) {
        // server 是 empty / legacy / no-headers — 不動 local 也不動 meta
        // 之後 push 階段也會被跳過(serverWins=true)
      } else {
        // 一般 LWW 合併(原邏輯)
        applySync((st) => {
          for (const sr of serverRecords) {
            const known = sheetMeta[sr._id];
            const isNewerOrFirst = !known || (sr._updated_at && sr._updated_at > (known._updated_at || ""));
            if (!isNewerOrFirst) continue;
            if (sr._deleted) {
              spec.removeFromState(st, sr._id);
            } else {
              const obj = Object.fromEntries(spec.dataHeaders.map((h, i) => [h, sr.dataRow[i]]));
              spec.upsertInState(st, sr._id, obj);
            }
          }
        });

        // 更新 meta
        if (!meta[spec.sheetName]) meta[spec.sheetName] = {};
        for (const sr of serverRecords) {
          meta[spec.sheetName][sr._id] = sr._deleted
            ? { _updated_at: sr._updated_at, fingerprint: TOMBSTONE_FP }
            : { _updated_at: sr._updated_at, fingerprint: fingerprintDataRow(sr.dataRow) };
        }
      }
    }

    // 更新 last-seen 到拉回來的版本（push 階段若有改變,後面會再覆蓋）
    saveServerVersion(serverVersion);
  }

  // serverWins 模式:不做 push,單純拉資料完事
  if (serverWins) {
    saveMeta(meta);
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
    const localIds = new Set(localRecords.map((r) => r._id));
    const isFullPush = forcePushSheets.has(spec.sheetName);

    // 改動 / 新增（legacy migration 下強制 push 全部）
    const dirtyIds = [];
    for (const lr of localRecords) {
      let needsPush = isFullPush;
      if (!needsPush) {
        const fp = fingerprintDataRow(lr.dataRow);
        const known = sheetMeta[lr._id];
        needsPush = !known || known.fingerprint !== fp;
      }
      if (needsPush) {
        upserts.push([...lr.dataRow, lr._id, "", ""]);
        dirtyIds.push(lr._id);
      }
    }

    // 刪除：sync_meta 有但 local flatten 不在,且尚未 tombstone
    const deletedIds = [];
    for (const id of Object.keys(sheetMeta)) {
      if (sheetMeta[id].fingerprint === TOMBSTONE_FP) continue;
      if (localIds.has(id)) continue;
      upserts.push([...dataHeaders.map(() => ""), id, "", "Y"]);
      deletedIds.push(id);
    }

    if (upserts.length === 0) continue;

    onProgress?.({ phase: "push", current: totalUpserts + 1, total: TABLE_SYNC_SPECS.length, name: spec.sheetName });
    totalUpserts++;

    const resp = await call({
      action: "upsertRows",
      sheetName: spec.sheetName,
      headers: fullHeaders,
      rows: upserts,
    });

    // 更新 meta
    if (!meta[spec.sheetName]) meta[spec.sheetName] = {};
    const localById = new Map(localRecords.map((r) => [r._id, r]));
    const dirtySet = new Set(dirtyIds);
    const deletedSet = new Set(deletedIds);
    for (const a of (resp.applied || [])) {
      if (deletedSet.has(a._id)) {
        meta[spec.sheetName][a._id] = { _updated_at: a._updated_at, fingerprint: TOMBSTONE_FP };
      } else if (dirtySet.has(a._id)) {
        const lr = localById.get(a._id);
        if (lr) {
          meta[spec.sheetName][a._id] = {
            _updated_at: a._updated_at,
            fingerprint: fingerprintDataRow(lr.dataRow),
          };
        }
      }
    }

    if (resp.server_version != null) latestPushedVersion = Number(resp.server_version);
  }

  saveMeta(meta);
  // 我們自己 push 後 server 版本被 bump，記下,下次 readMeta 比對時就不會以為「server 改了」而再拉
  saveServerVersion(latestPushedVersion);
  return { ok: true, pulled: shouldPull, pushedTables: totalUpserts };
}

// 給 settings UI 看的：大致狀態
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
//
// 啟動後:
//   - DOMContentLoaded 立即跑一次 syncOnce
//   - subscribe state 變動 → debounce 5 秒後 syncOnce
//   - 每 30 秒固定 poll 一次 syncOnce
//   - 任何時刻最多一個 syncOnce 在跑
//   - 失敗顯示在 banner，不擋使用者；下個 poll 自動再試
//   - 沒設 URL/token 時不跑

let isSyncing = false;
let lastSyncEndedAt = 0;
let debounceTimer = null;
let pollTimer = null;
let orchestratorStarted = false;
// 失敗節流：連續失敗會延長下次嘗試間隔，避免狂打 API
let consecutiveFailures = 0;
let nextEarliestSyncAt = 0;

function hasCredentials() {
  const s = getState();
  return !!(getEffectiveSheetsUrl(s.settings) && getEffectiveSheetsToken(s.settings));
}

async function runSyncIfReady(reason, options = {}) {
  if (isSyncing) return;
  if (!hasCredentials()) return;
  if (Date.now() < nextEarliestSyncAt) return;
  if (Date.now() - lastSyncEndedAt < MIN_GAP_BETWEEN_SYNCS_MS) return;

  isSyncing = true;
  // 不預先顯示 banner — syncOnce 內部只在「真的做事」(實際拉表 / 實際 push)時才會呼叫 onProgress
  // 閒置時(server 沒變動 + 本機沒 dirty)整輪 sync 都不會顯示 banner
  try {
    const result = await syncOnce(
      (p) => showSyncBanner({ ...p, name: `${reason} · ${p.name}` }),
      options,
    );
    consecutiveFailures = 0;
    nextEarliestSyncAt = 0;
    // 只在真的有拉資料或推資料時才顯示完成 banner;閒置時靜默
    if (result.pulled || result.pushedTables > 0) {
      markSyncDone(`✓ 同步完成(${reason})`, "ok");
    }
  } catch (e) {
    consecutiveFailures += 1;
    const backoffMs = Math.min(10 * 60 * 1000, 30 * 1000 * Math.pow(2, consecutiveFailures - 1));
    nextEarliestSyncAt = Date.now() + backoffMs;
    markSyncDone(`✗ 同步失敗:${e.message}(${Math.round(backoffMs / 1000)}s 後再試)`, "bad");
  } finally {
    isSyncing = false;
    lastSyncEndedAt = Date.now();
  }
}

export function initSyncOrchestrator() {
  if (orchestratorStarted) return;
  orchestratorStarted = true;

  // 啟動時立即同步一次 — serverWins 模式:server 整片覆寫 local,不 push 任何東西。
  // 避免使用者「久未開站、本機資料陳舊」的情境下,把舊資料推回 Sheets 蓋掉現役資料。
  setTimeout(() => runSyncIfReady("啟動載入", { serverWins: true }), 100);

  // state 變動 → debounce 5 秒 → 正常同步(LWW + push)
  // 注意:同步進行中的 applySync 也會觸發 subscribe,我們用 isSyncing 過濾,
  // 避免「同步完成 → debounce 又觸發 → 再同步」的循環。
  subscribe(() => {
    if (isSyncing) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSyncIfReady("改動後");
    }, DEBOUNCE_AFTER_CHANGE_MS);
  });

  // 每 30 秒 poll — 也用 serverWins(只拉不推),只有「使用者真的有改動」才會走 push 路徑
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => runSyncIfReady("背景輪詢", { serverWins: true }), POLL_INTERVAL_MS);
}

// 提供給「☁️ 推到 Sheets」/「⬇️ 從 Sheets 拉下來」手動按鈕呼叫；行為跟 runSyncIfReady 相同（單向同步無意義，因為一律 LWW 合併）
export async function manualSync() {
  if (isSyncing) throw new Error("同步進行中，請稍候");
  isSyncing = true;
  try {
    await syncOnce((p) => showSyncBanner(p));
    consecutiveFailures = 0;
    nextEarliestSyncAt = 0;
    markSyncDone("✓ 手動同步完成", "ok");
  } catch (e) {
    markSyncDone(`✗ 手動同步失敗：${e.message}`, "bad");
    throw e;
  } finally {
    isSyncing = false;
    lastSyncEndedAt = Date.now();
  }
}
