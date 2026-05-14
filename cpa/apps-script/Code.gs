// ===== 廣告預算同步 Apps Script =====
// 把這份貼到「擴充功能 → Apps Script」，把 SECRET 改成你的隨機字串
// 部署為「網頁應用程式」（執行身分：我；存取：任何人）
//
// Row-level CAS 同步協定（v4）:
//   每張分頁的最後 4 欄固定為 `_id`、`_updated_at`、`_deleted`、`_version`(隱性 metadata)
//   - `_id`: row 主鍵(自然 id 或複合鍵字串)
//   - `_updated_at`: server 寫入時用 server 時鐘填的 ISO 字串(單一時間源)
//   - `_deleted`: tombstone 旗標,"Y" 代表已刪除(讀回時客戶端要過濾)
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
      case 'writeTable':      return _resp(writeTable(body.sheetName, body.headers, body.rows));
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
        // 不存在 → create(無論 expected_version 為何,都讓客戶端的版本贏)
        const newVer = expectedVersion > 0 ? expectedVersion + 1 : 1;
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
function readAllTables(names) {
  const out = { sheets: {}, server_version: readMeta().server_version };
  for (let i = 0; i < names.length; i++) {
    out.sheets[names[i]] = readTable(names[i]);
  }
  return out;
}
