// ===== 廣告預算同步 Apps Script =====
// 把這份貼到「擴充功能 → Apps Script」，把 SECRET 改成你的隨機字串
// 部署為「網頁應用程式」（執行身分：我；存取：任何人）
//
// Row-level LWW 同步協定（v3）:
//   每張分頁的最後三欄固定為 `_id`、`_updated_at`、`_deleted`（隱性 metadata）
//   - `_id`: row 主鍵（自然 id 或複合鍵字串）
//   - `_updated_at`: server 寫入時用 server 時鐘填的 ISO 字串（單一時間源）
//   - `_deleted`: tombstone 旗標，"Y" 代表已刪除（讀回時客戶端要過濾）
//
//   隱藏的 `_sync_meta` 分頁存全域版本號:
//   - A1 = server_version (每次 upsert/writeTable 後 +1，client 用來短路 pull)
//   - B1 = last_modified_at (ISO)
//
// 對外 actions:
//   - ping
//   - readMeta()                            — 拿 server_version + last_modified_at（輕量,~200ms）
//   - readTable(name)                        — 讀單張 sheet（含 metadata 三欄）
//   - readAllTables(sheetNames)              — 一次拉多張 sheet（合 12 個 round trip 為 1 個）
//   - upsertRows(name, headers, rows)        — 用 _id 比對，有就更新沒就 append；server 寫入時填 _updated_at；回應含新 server_version
//   - writeTable(name, headers, rows)        — 整份覆寫（保留作救援用）
//
// 第一次跑 upsertRows 時若 sheet header 沒有 metadata 三欄會自動 migrate 補上。

const SECRET = 'CHANGE_ME_TO_A_RANDOM_STRING';

const META_COLS = ['_id', '_updated_at', '_deleted'];
const SYNC_META_SHEET = '_sync_meta';

function doPost(e) {
  try {
    const raw = (e.parameter && e.parameter.payload) || (e.postData && e.postData.contents) || '{}';
    const body = JSON.parse(raw);
    if (body.token !== SECRET) return _resp({ error: 'invalid token' });
    switch (body.action) {
      case 'ping':            return _resp({ ok: true, version: 3 });
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
  return _resp({ ok: true, hint: 'POST with {action,token,...}', version: 3 });
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

// 整份覆寫（舊 API，留作救援用）
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

// Row-level upsert by _id。
// headers 必須包含 META_COLS（順序自由，但通常放最後）。
// rows 每筆是一個 array，順序對齊 headers。
// 行為:
//   1. sheet 不存在 → 建立 + 寫入 header
//   2. sheet 存在但 header 不一致 → 覆寫 header（migration）；既有 row 保留
//   3. 對每筆輸入 row:
//      - 用 _id 找 sheet 內既有 row
//      - 找到 → 整 row 覆蓋（_updated_at 由 server 填 now()）
//      - 找不到 → append（_updated_at 由 server 填 now()）
//   4. 回傳 { applied: [{ _id, _updated_at }, ...] }
function upsertRows(name, headers, rows) {
  if (!headers || !headers.length) throw new Error('headers required');
  if (!rows) rows = [];

  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(name);

    // META_COLS 在 headers 中的索引（0-indexed）
    const idIdx = headers.indexOf('_id');
    const updatedAtIdx = headers.indexOf('_updated_at');
    const deletedIdx = headers.indexOf('_deleted');
    if (idIdx < 0 || updatedAtIdx < 0 || deletedIdx < 0) {
      throw new Error('headers must include _id, _updated_at, _deleted');
    }

    // 確認 sheet 與 header；不一致就「整片清掉」並重建（migration）
    // 為什麼整片清:留著舊 row 但他們沒有 _id 欄位資料 → 變成孤兒 row。
    // 直接清掉,client 會把 local state 全部 upsert 上來,resync 完成。
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

    // 讀現有 row（_id → 1-indexed sheet row 索引）
    const lastRow = sh.getLastRow();
    const idToSheetRow = {};
    if (lastRow >= 2) {
      const idCol = idIdx + 1;
      const idValues = sh.getRange(2, idCol, lastRow - 1, 1).getValues();
      for (let i = 0; i < idValues.length; i++) {
        const id = String(idValues[i][0] || '');
        if (id) idToSheetRow[id] = i + 2;
      }
    }

    const now = new Date().toISOString();
    const applied = [];
    const newRows = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].slice();
      const id = String(row[idIdx] || '');
      if (!id) continue;  // 跳過沒有 _id 的 row
      row[updatedAtIdx] = now;  // 蓋成 server 時間
      if (idToSheetRow[id]) {
        sh.getRange(idToSheetRow[id], 1, 1, headers.length).setValues([row]);
      } else {
        newRows.push(row);
      }
      applied.push({ _id: id, _updated_at: now });
    }

    if (newRows.length > 0) {
      const startRow = sh.getLastRow() + 1;
      sh.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    }

    const bumped = applied.length > 0 ? _bumpServerVersion() : readMeta();
    return { ok: true, applied: applied, server_version: bumped.server_version };
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
