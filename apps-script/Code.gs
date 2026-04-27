// ===== 廣告預算同步 Apps Script =====
// 把這份貼到「擴充功能 → Apps Script」，把 SECRET 改成你的隨機字串
// 部署為「網頁應用程式」（執行身分：我；存取：任何人）

const SECRET = 'CHANGE_ME_TO_A_RANDOM_STRING';

function doPost(e) {
  try {
    // 前端以 FormData.payload 傳 JSON（避開跨域 POST + JSON 在 Apps Script 302 下回 405 的問題）
    // 同時相容舊版 text/plain JSON body
    const raw = (e.parameter && e.parameter.payload) || (e.postData && e.postData.contents) || '{}';
    const body = JSON.parse(raw);
    if (body.token !== SECRET) return _resp({ error: 'invalid token' });
    switch (body.action) {
      case 'ping':       return _resp({ ok: true, version: 1 });
      case 'writeTable': return _resp(writeTable(body.sheetName, body.headers, body.rows));
      case 'readTable':  return _resp(readTable(body.sheetName));
      default: return _resp({ error: 'unknown action: ' + body.action });
    }
  } catch (err) {
    return _resp({ error: String(err && err.message || err) });
  }
}

function doGet() {
  return _resp({ ok: true, hint: 'POST with {action,token,...}' });
}

function _resp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function writeTable(name, headers, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  if (rows && rows.length > 0) {
    // 把長得像日期/時間戳的字串欄位設為純文字格式，避免 Sheets 自動轉型
    for (let i = 0; i < headers.length; i++) {
      const sample = rows[0][i];
      if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) {
        sh.getRange(2, i + 1, rows.length, 1).setNumberFormat('@');
      }
    }
    sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sh.setFrozenRows(1);
  return { ok: true, written: rows ? rows.length : 0 };
}

function readTable(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) return { headers: [], rows: [] };
  const values = sh.getDataRange().getValues();
  if (values.length < 1) return { headers: [], rows: [] };
  const headers = values[0].map(String);
  // 用 spreadsheet 時區（使用者眼中的時區），而不是 script 時區（常被預設成 UTC）
  // 這樣 Sheets 顯示 2026-04-01 的 cell 就會回 "2026-04-01" 字串而不是 ISO UTC
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Taipei';
  const rows = values.slice(1)
    .filter(row => row.some(v => v !== '' && v != null))
    .map(row => row.map(v => {
      if (v instanceof Date) {
        // 用 spreadsheet 時區檢查時分秒；若皆 0 視為純日期
        const hh = Number(Utilities.formatDate(v, tz, 'H'));
        const mm = Number(Utilities.formatDate(v, tz, 'm'));
        const ss2 = Number(Utilities.formatDate(v, tz, 's'));
        if (hh === 0 && mm === 0 && ss2 === 0) {
          return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
        }
        return Utilities.formatDate(v, tz, "yyyy-MM-dd'T'HH:mm:ssXXX");
      }
      return v;
    }));
  return { headers, rows };
}
