// ===== 廣告預算同步 Apps Script =====
// 把這份貼到「擴充功能 → Apps Script」，把 SECRET 改成你的隨機字串
// 部署為「網頁應用程式」（執行身分：我；存取：任何人）
//
// Row-level CAS 同步協定（v4）:
//   每張分頁的最後 4 欄固定為 `_id`、`_updated_at`、`_deleted`、`_version`(隱性 metadata)
//   - `_id`: row 主鍵(自然 id 或複合鍵字串)
//   - `_updated_at`: server 寫入時用 server 時鐘填的 ISO 字串(單一時間源)
//   - `_deleted`: legacy deletion flag; new deleteRows deletes the whole sheet row
//   - `_version`: 整數,每次成功寫入 +1。CAS 比對用 — 客戶端 push 時帶 _expected_version,
//                 不等於 sheet 內目前版本就算衝突,不寫入,server 回 conflicts 給客戶端處理。
//
//   隱藏的 `_sync_meta` 分頁存全域版本號:
//   - A1 = server_version (每次 upsert/writeTable 後 +1，client 用來短路 pull)
//   - B1 = last_modified_at (ISO)
//
// 對外 actions:
//   - ping
//   - readMeta()                            — 拿 server_version + last_modified_at(輕量,~200ms)
//   - readTable(name)                        — 讀單張 sheet(含 metadata 四欄)
//   - readAllTables(sheetNames)              — 一次拉多張 sheet(合 12 個 round trip 為 1 個)
//   - upsertRows(name, headers, rows)        — CAS 寫入:rows 內 _version 為 expected,
//                                              不符就進 conflicts 不寫入;符合就寫入 + version+1
//   - writeTable(name, headers, rows)        — 整份覆寫(保留作救援用;不檢查 version)
//
// 第一次跑 upsertRows 時若 sheet header 沒有 metadata 四欄會自動 migrate 補上。
// v3 → v4 migration:既有 row 沒有 _version 欄 → 視為 _version = 0,首次 CAS 寫入時開始計數。

const SECRET = 'CHANGE_ME_TO_A_RANDOM_STRING';

const META_COLS = ['_id', '_updated_at', '_deleted', '_version'];
const SYNC_META_SHEET = '_sync_meta';

function doPost(e) {
  try {
    const raw = (e.parameter && e.parameter.payload) || (e.postData && e.postData.contents) || '{}';
    const body = JSON.parse(raw);
    if (body.token !== SECRET) return _resp({ error: 'invalid token' });
    switch (body.action) {
      case 'ping':            return _resp({ ok: true, version: 4 });
      case 'readMeta':        return _resp(readMeta());
      case 'readTable':       return _resp(readTable(body.sheetName));
      case 'readAllTables':   return _resp(readAllTables(body.sheetNames || []));
      case 'upsertRows':      return _resp(upsertRows(body.sheetName, body.headers, body.rows));
      case 'deleteRows':      return _resp(deleteRows(body.sheetName, body.rows));
      case 'writeTable':      return _resp(writeTable(body.sheetName, body.headers, body.rows));
      case 'yourlsListQueuedActions': return _resp(yourlsListQueuedActions(body.limit || 20));
      case 'yourlsClaimAction':       return _resp(yourlsClaimAction(body.action_id, body.worker_id));
      case 'yourlsReportActionResult': return _resp(yourlsReportActionResult(body));
      case 'yourlsAppendExecutionLog': return _resp(yourlsAppendExecutionLog(body.log || body));
      default: return _resp({ error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return _resp({ error: String(err && err.message || err) });
  }
}

function doGet() {
  return _resp({ ok: true, hint: 'POST with {action,token,...}', version: 4 });
}

// ===== _sync_meta 版本號 =====
// 隱藏分頁,A1 = server_version (整數)、B1 = last_modified_at (ISO)
function _getMetaSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SYNC_META_SHEET);
  if (!sh) {
    sh = ss.insertSheet(SYNC_META_SHEET);
    sh.getRange('A1:B1').setValues([[0, '']]);
    try { sh.hideSheet(); } catch (e) {}  // 失敗就讓它顯示也沒差
  }
  return sh;
}

function readMeta() {
  const sh = _getMetaSheet();
  const range = sh.getRange('A1:B1').getValues()[0];
  return {
    server_version: Number(range[0]) || 0,
    last_modified_at: String(range[1] || ''),
  };
}

function _bumpServerVersion() {
  const sh = _getMetaSheet();
  const cur = Number(sh.getRange('A1').getValue()) || 0;
  const next = cur + 1;
  const now = new Date().toISOString();
  sh.getRange('A1:B1').setValues([[next, now]]);
  return { server_version: next, last_modified_at: now };
}

function _resp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _headers(sh) {
  const lastCol = sh.getLastColumn();
  return lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
}

// 整份覆寫(舊 API,留作救援用;不走 CAS,會把 _version 強制重設)
function writeTable(name, headers, rows) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    if (rows && rows.length > 0) {
      for (let i = 0; i < headers.length; i++) {
        const sample = rows[0][i];
        if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) {
          sh.getRange(2, i + 1, rows.length, 1).setNumberFormat('@');
        }
      }
      sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    sh.setFrozenRows(1);
    const bumped = _bumpServerVersion();
    return { ok: true, written: rows ? rows.length : 0, server_version: bumped.server_version };
  } finally {
    lock.releaseLock();
  }
}

function readTable(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) return { headers: [], rows: [] };
  const values = sh.getDataRange().getValues();
  if (values.length < 1) return { headers: [], rows: [] };
  const headers = values[0].map(String);
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Taipei';
  const rows = values.slice(1)
    .filter(function (row) { return row.some(function (v) { return v !== '' && v != null; }); })
    .map(function (row) {
      return row.map(function (v) {
        if (v instanceof Date) {
          const hh = Number(Utilities.formatDate(v, tz, 'H'));
          const mm = Number(Utilities.formatDate(v, tz, 'm'));
          const ss2 = Number(Utilities.formatDate(v, tz, 's'));
          if (hh === 0 && mm === 0 && ss2 === 0) {
            return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
          }
          return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
        }
        return v;
      });
    });
  return { headers: headers, rows: rows };
}

// Row-level CAS upsert by _id。
//
// headers 必須包含 META_COLS(順序自由,但通常放最後)。
// rows 每筆是一個 array,順序對齊 headers。每筆的 `_version` 欄位是「客戶端寫入時知道的版本」
// (expected_version)— 不是要寫入的新版本,server 會自己 +1。
//
// 行為:
//   1. sheet 不存在 → 建立 + 寫入 header
//   2. sheet 存在但 header 不一致 → 整片清掉並重建(migration);既有 row 保留為 _version=0 不可能
//      (但因為清掉了,實際是 resync;客戶端會把全部 local row 推上來,等於從零開始)
//   3. 對每筆輸入 row:
//      - 找 sheet 內既有 row(by _id)
//      - 既有不存在 + expected_version <= 0  → create,version=1
//      - 既有不存在 + expected_version > 0   → 視為 resurrection / 客戶端認為它在但 server 沒
//                                              → create,version=expected_version+1(讓客戶端的版本贏)
//      - 既有存在,server.version == expected → 寫入,version=expected+1
//      - 既有存在,server.version != expected → **衝突**,不寫入,收進 conflicts 回應
//   4. 回傳 { applied: [{_id, _updated_at, _version}, ...],
//             conflicts: [{_id, current_row, current_version, current_updated_at}, ...] }
function upsertRows(name, headers, rows) {
  if (!headers || !headers.length) throw new Error('headers required');
  if (!rows) rows = [];

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(name);

    // META_COLS 在 headers 中的索引(0-indexed)
    const idIdx = headers.indexOf('_id');
    const updatedAtIdx = headers.indexOf('_updated_at');
    const deletedIdx = headers.indexOf('_deleted');
    const versionIdx = headers.indexOf('_version');
    if (idIdx < 0 || updatedAtIdx < 0 || deletedIdx < 0 || versionIdx < 0) {
      throw new Error('headers must include _id, _updated_at, _deleted, _version');
    }

    // 確認 sheet 與 header;不一致就「整片清掉」並重建(migration)
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      const lastCol = sh.getLastColumn();
      let existingHeaders = [];
      if (lastCol > 0) {
        existingHeaders = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      }
      const headersMatch = existingHeaders.length === headers.length &&
        existingHeaders.every(function (h, i) { return h === headers[i]; });
      if (!headersMatch) {
        sh.clear();
        sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
        sh.setFrozenRows(1);
      }
    }

    // 讀現有 row:建 _id → { sheetRow, version, fullRow } 的 map
    const lastRow = sh.getLastRow();
    const existing = {};
    if (lastRow >= 2) {
      const allVals = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
      for (let i = 0; i < allVals.length; i++) {
        const id = String(allVals[i][idIdx] || '');
        if (!id) continue;
        existing[id] = {
          sheetRow: i + 2,
          version: Number(allVals[i][versionIdx]) || 0,
          fullRow: allVals[i],
        };
      }
    }

    const now = new Date().toISOString();
    const applied = [];
    const conflicts = [];
    const newRows = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].slice();
      const id = String(row[idIdx] || '');
      if (!id) continue;  // 跳過沒有 _id 的 row
      const expectedVersion = Number(row[versionIdx]) || 0;
      const cur = existing[id];

      if (!cur) {
        if (expectedVersion > 0) {
          const deletedRow = headers.map(function () { return ''; });
          deletedRow[idIdx] = id;
          deletedRow[deletedIdx] = 'Y';
          deletedRow[versionIdx] = expectedVersion;
          conflicts.push({
            _id: id,
            current_row: deletedRow,
            current_version: expectedVersion,
            current_updated_at: '',
            expected_version: expectedVersion,
            _deleted: true,
          });
          continue;
        }
        const newVer = 1;
        row[updatedAtIdx] = now;
        row[versionIdx] = newVer;
        newRows.push(row);
        applied.push({ _id: id, _updated_at: now, _version: newVer });
      } else if (cur.version === expectedVersion) {
        // 版本對得上 → 寫入,version+1
        const newVer = cur.version + 1;
        row[updatedAtIdx] = now;
        row[versionIdx] = newVer;
        sh.getRange(cur.sheetRow, 1, 1, headers.length).setValues([row]);
        // 更新 existing 表的版本,避免同一批裡同 _id 多次更新(理論上不會發生,但保險)
        cur.version = newVer;
        cur.fullRow = row;
        applied.push({ _id: id, _updated_at: now, _version: newVer });
      } else {
        // 衝突:客戶端的 expected_version 跟 server 對不上
        conflicts.push({
          _id: id,
          current_row: cur.fullRow,
          current_version: cur.version,
          current_updated_at: String(cur.fullRow[updatedAtIdx] || ''),
          expected_version: expectedVersion,
        });
      }
    }

    if (newRows.length > 0) {
      const startRow = sh.getLastRow() + 1;
      sh.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    }

    const bumped = applied.length > 0 ? _bumpServerVersion() : readMeta();
    return {
      ok: true,
      applied: applied,
      conflicts: conflicts,
      server_version: bumped.server_version,
    };
  } finally {
    lock.releaseLock();
  }
}

// 一次讀取多張 sheet,把 12 個 round trip 合成 1 個。
// 回傳 { sheets: { [name]: { headers, rows } }, server_version }
function deleteRows(name, rows) {
  rows = rows || [];
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(name);
    const applied = [];
    const conflicts = [];
    if (!sh || sh.getLastRow() < 2) {
      rows.forEach(function (item) {
        const id = String((item && (item._id || item.id)) || '');
        if (id) applied.push({ _id: id, _deleted: true });
      });
      const meta = readMeta();
      return { ok: true, applied: applied, conflicts: conflicts, server_version: meta.server_version };
    }

    const headers = _headers(sh);
    const idIdx = headers.indexOf('_id');
    const updatedAtIdx = headers.indexOf('_updated_at');
    const deletedIdx = headers.indexOf('_deleted');
    const versionIdx = headers.indexOf('_version');
    if (idIdx < 0 || updatedAtIdx < 0 || deletedIdx < 0 || versionIdx < 0) {
      throw new Error('headers must include _id, _updated_at, _deleted, _version');
    }

    const allVals = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
    const existing = {};
    for (let i = 0; i < allVals.length; i++) {
      const id = String(allVals[i][idIdx] || '');
      if (!id) continue;
      existing[id] = { sheetRow: i + 2, version: Number(allVals[i][versionIdx]) || 0, fullRow: allVals[i] };
    }

    const toDelete = [];
    rows.forEach(function (item) {
      const id = String((item && (item._id || item.id)) || '');
      if (!id) return;
      const expectedVersion = Number(item._version || item.expected_version || 0) || 0;
      const cur = existing[id];
      if (!cur) {
        applied.push({ _id: id, _deleted: true });
      } else if (cur.version === expectedVersion) {
        toDelete.push(cur.sheetRow);
        applied.push({ _id: id, _deleted: true, _version: cur.version + 1 });
      } else {
        conflicts.push({
          _id: id,
          current_row: cur.fullRow,
          current_version: cur.version,
          current_updated_at: String(cur.fullRow[updatedAtIdx] || ''),
          expected_version: expectedVersion,
        });
      }
    });

    toDelete.sort(function (a, b) { return b - a; }).forEach(function (sheetRow) {
      sh.deleteRow(sheetRow);
    });
    const bumped = toDelete.length > 0 ? _bumpServerVersion() : readMeta();
    return { ok: true, applied: applied, conflicts: conflicts, server_version: bumped.server_version };
  } finally {
    lock.releaseLock();
  }
}

function readAllTables(names) {
  const out = { sheets: {}, server_version: readMeta().server_version };
  for (let i = 0; i < names.length; i++) {
    out.sheets[names[i]] = readTable(names[i]);
  }
  return out;
}

// ===== Yourls worker queue API =====
const YOURLS_ACTION_SHEET = 'YOURLS操作佇列';
const YOURLS_EXEC_LOG_SHEET = 'YOURLS執行紀錄';
const YOURLS_ACTION_HEADERS = [
  'action_id', 'todo_id', 'created_at', 'approved_at', 'approved_by',
  'kind', 'short_url_param', 'source_ad_code', 'ad_name', 'weight_summary',
  'payload_json', 'status', 'worker_id', 'claimed_at', 'completed_at',
  'last_error', 'attempts', 'updated_at',
];
const YOURLS_LOG_HEADERS = [
  'log_id', 'action_id', 'at', 'status', 'kind', 'short_url_param',
  'before_json', 'after_json', 'operations_json', 'error_msg', 'worker_id', 'dry_run',
];

function _yourlsEnsureSheet(name, dataHeaders) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  const fullHeaders = dataHeaders.concat(META_COLS);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, fullHeaders.length).setValues([fullHeaders]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }

  const lastCol = Math.max(sh.getLastColumn(), 1);
  let headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  if (headers.length === 1 && !headers[0]) headers = [];
  const missing = fullHeaders.filter(function (h) { return headers.indexOf(h) < 0; });
  if (missing.length > 0) {
    sh.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
  }
  sh.setFrozenRows(1);
  return sh;
}

function _yourlsHeaders(sh) {
  return _headers(sh);
}

function _yourlsRowObject(headers, row) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
  return obj;
}

function _yourlsSafeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(String(raw)); } catch (e) { return null; }
}

function _yourlsDisplayNow() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

function _yourlsTodayDate() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
}

function _yourlsDateOnly(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function _yourlsEffectiveDate(payload) {
  return _yourlsDateOnly(payload.effective_date || payload.effective_at);
}

function _yourlsWaitsForEffectiveDate(payload) {
  const actionType = String(payload.action_type || '').trim();
  return actionType === '\u624b\u52d5\u6539\u6b0a\u91cd' ||
    actionType === '\u6210\u6548\u8abf\u6b0a\u91cd';
}

function _yourlsQueueReadiness(payload, today) {
  if (!_yourlsWaitsForEffectiveDate(payload)) return { ready: true };
  const effectiveDate = _yourlsEffectiveDate(payload);
  if (!effectiveDate) return { ready: true };
  if (effectiveDate <= today) return { ready: true };
  return { ready: false, effective_date: effectiveDate };
}

function _yourlsFindRow(sh, headers, idHeader, idValue) {
  const idIdx = headers.indexOf(idHeader);
  if (idIdx < 0 || !idValue) return null;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const values = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][idIdx] || '') === String(idValue)) {
      return { sheetRow: i + 2, row: values[i] };
    }
  }
  return null;
}

function _yourlsSet(row, headers, key, value) {
  const idx = headers.indexOf(key);
  if (idx >= 0) row[idx] = value;
}

function _yourlsTouchRow(row, headers, now) {
  const updatedIdx = headers.indexOf('_updated_at');
  const versionIdx = headers.indexOf('_version');
  const deletedIdx = headers.indexOf('_deleted');
  if (updatedIdx >= 0) row[updatedIdx] = now;
  if (deletedIdx >= 0) row[deletedIdx] = '';
  if (versionIdx >= 0) row[versionIdx] = (Number(row[versionIdx]) || 0) + 1;
}

function yourlsListQueuedActions(limit) {
  const sh = _yourlsEnsureSheet(YOURLS_ACTION_SHEET, YOURLS_ACTION_HEADERS);
  const headers = _yourlsHeaders(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, actions: [] };
  const rows = sh.getRange(2, 1, lastRow - 1, headers.length).getValues();
  const out = [];
  const today = _yourlsTodayDate();
  rows.forEach(function (row) {
    const obj = _yourlsRowObject(headers, row);
    if (String(obj.status || '') !== 'queued') return;
    const payload = _yourlsSafeJson(obj.payload_json) || {};
    if (!_yourlsQueueReadiness(payload, today).ready) return;
    out.push({
      action_id: String(obj.action_id || ''),
      todo_id: String(obj.todo_id || ''),
      approved_at: String(obj.approved_at || ''),
      kind: String(obj.kind || payload.kind || ''),
      short_url_param: String(obj.short_url_param || payload.short_url_param || ''),
      source_ad_code: String(obj.source_ad_code || payload.source_ad_code || ''),
      ad_name: String(obj.ad_name || payload.ad_name || ''),
      weight_summary: String(obj.weight_summary || ''),
      payload: payload,
      attempts: Number(obj.attempts) || 0,
    });
  });
  out.sort(function (a, b) {
    return String(a.approved_at || '').localeCompare(String(b.approved_at || '')) ||
      String(a.action_id || '').localeCompare(String(b.action_id || ''));
  });
  return { ok: true, actions: out.slice(0, Number(limit) || 20) };
}

function yourlsClaimAction(actionId, workerId) {
  if (!actionId) return { ok: false, error: 'action_id required' };
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const sh = _yourlsEnsureSheet(YOURLS_ACTION_SHEET, YOURLS_ACTION_HEADERS);
    const headers = _yourlsHeaders(sh);
    const found = _yourlsFindRow(sh, headers, 'action_id', actionId);
    if (!found) return { ok: false, error: 'action not found' };
    const obj = _yourlsRowObject(headers, found.row);
    if (String(obj.status || '') !== 'queued') {
      return { ok: false, status: String(obj.status || ''), error: 'action is not queued' };
    }
    const payload = _yourlsSafeJson(obj.payload_json) || {};
    const readiness = _yourlsQueueReadiness(payload, _yourlsTodayDate());
    if (!readiness.ready) {
      return {
        ok: false,
        status: 'queued',
        error: 'action is not ready until effective_date',
        effective_date: readiness.effective_date,
      };
    }
    const now = _yourlsDisplayNow();
    const metaNow = new Date().toISOString();
    const row = found.row.slice();
    _yourlsSet(row, headers, 'status', 'running');
    _yourlsSet(row, headers, 'worker_id', workerId || '');
    _yourlsSet(row, headers, 'claimed_at', now);
    _yourlsSet(row, headers, 'updated_at', now);
    _yourlsSet(row, headers, 'attempts', (Number(obj.attempts) || 0) + 1);
    _yourlsSet(row, headers, 'last_error', '');
    _yourlsTouchRow(row, headers, metaNow);
    sh.getRange(found.sheetRow, 1, 1, headers.length).setValues([row]);
    const bumped = _bumpServerVersion();
    return { ok: true, server_version: bumped.server_version, action: { action_id: actionId, payload: payload } };
  } finally {
    lock.releaseLock();
  }
}

function yourlsReportActionResult(body) {
  const actionId = body.action_id;
  if (!actionId) return { ok: false, error: 'action_id required' };
  const status = body.status === 'applied' ? 'applied' : 'failed';
  const workerId = body.worker_id || '';
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const sh = _yourlsEnsureSheet(YOURLS_ACTION_SHEET, YOURLS_ACTION_HEADERS);
    const headers = _yourlsHeaders(sh);
    const found = _yourlsFindRow(sh, headers, 'action_id', actionId);
    if (!found) return { ok: false, error: 'action not found' };
    const obj = _yourlsRowObject(headers, found.row);
    const now = _yourlsDisplayNow();
    const metaNow = new Date().toISOString();
    const row = found.row.slice();
    _yourlsSet(row, headers, 'status', status);
    _yourlsSet(row, headers, 'worker_id', workerId || String(obj.worker_id || ''));
    _yourlsSet(row, headers, 'completed_at', now);
    _yourlsSet(row, headers, 'updated_at', now);
    _yourlsSet(row, headers, 'last_error', body.error_msg || body.last_error || '');
    _yourlsTouchRow(row, headers, metaNow);
    sh.getRange(found.sheetRow, 1, 1, headers.length).setValues([row]);

    yourlsAppendExecutionLog({
      action_id: actionId,
      at: now,
      status: status,
      kind: String(obj.kind || ''),
      short_url_param: String(obj.short_url_param || ''),
      before_json: body.before_json || JSON.stringify(body.before || {}),
      after_json: body.after_json || JSON.stringify(body.after || {}),
      operations_json: body.operations_json || JSON.stringify(body.operations || []),
      error_msg: body.error_msg || body.last_error || '',
      worker_id: workerId || String(obj.worker_id || ''),
      dry_run: body.dry_run ? 'Y' : '',
    });

    const bumped = _bumpServerVersion();
    return { ok: true, status: status, server_version: bumped.server_version };
  } finally {
    lock.releaseLock();
  }
}

function yourlsAppendExecutionLog(log) {
  const sh = _yourlsEnsureSheet(YOURLS_EXEC_LOG_SHEET, YOURLS_LOG_HEADERS);
  const headers = _yourlsHeaders(sh);
  const now = _yourlsDisplayNow();
  const metaNow = new Date().toISOString();
  const data = {
    log_id: log.log_id || ('yourls_log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
    action_id: log.action_id || '',
    at: log.at || now,
    status: log.status || '',
    kind: log.kind || '',
    short_url_param: log.short_url_param || '',
    before_json: log.before_json || JSON.stringify(log.before || {}),
    after_json: log.after_json || JSON.stringify(log.after || {}),
    operations_json: log.operations_json || JSON.stringify(log.operations || []),
    error_msg: log.error_msg || '',
    worker_id: log.worker_id || '',
    dry_run: log.dry_run === true || String(log.dry_run || '').toUpperCase() === 'Y' ? 'Y' : '',
  };
  const row = headers.map(function (h) {
    if (h === '_id') return data.log_id;
    if (h === '_updated_at') return metaNow;
    if (h === '_deleted') return '';
    if (h === '_version') return 1;
    return data[h] == null ? '' : data[h];
  });
  sh.appendRow(row);
  const bumped = _bumpServerVersion();
  return { ok: true, log_id: data.log_id, server_version: bumped.server_version };
}
