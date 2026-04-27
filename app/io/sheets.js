import { getState, replaceState } from "../state.js";
import { TABLES, assembleFromTables } from "./sheets-schema.js";

async function call(payload) {
  const s = getState();
  const url = s.settings.sheets_webapp_url;
  if (!url) throw new Error("尚未設定 Apps Script Web App URL");
  if (!s.settings.sheets_token) throw new Error("尚未設定 Token");

  const fd = new FormData();
  fd.append("payload", JSON.stringify({ ...payload, token: s.settings.sheets_token }));

  const res = await fetch(url, { method: "POST", body: fd, redirect: "follow" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`回應非 JSON（前 200 字）：${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error);
  return json;
}

export async function pingSheets() {
  return await call({ action: "ping" });
}

export async function pushToSheets(onProgress) {
  const s = getState();
  let written = 0;
  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i];
    onProgress?.({ phase: "push", current: i + 1, total: TABLES.length, name: t.name });
    const r = await call({ action: "writeTable", sheetName: t.name, headers: t.headers, rows: t.toRows(s) });
    written += r.written || 0;
  }
  return { ok: true, tables: TABLES.length, rowsWritten: written };
}

export async function pullFromSheets(onProgress) {
  const raw = {};
  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i];
    onProgress?.({ phase: "pull", current: i + 1, total: TABLES.length, name: t.name });
    const r = await call({ action: "readTable", sheetName: t.name });
    raw[t.name] = { headers: r.headers || [], rows: r.rows || [] };
  }
  const data = assembleFromTables(raw);
  const current = getState();
  data.settings.sheets_webapp_url = current.settings.sheets_webapp_url;
  data.settings.sheets_token = current.settings.sheets_token;
  // 報表 custom_metrics 從 Sheets 拉（跨裝置共享公式）；
  // hidden_metrics 是裝置端顯示偏好 → 從本機保留，不被 pull 蓋掉。
  const pulledRC = data.report_config || {};
  const localRC = current.report_config || {};
  const mergedRC = {};
  const allPids = new Set([...Object.keys(pulledRC), ...Object.keys(localRC)]);
  for (const pid of allPids) {
    mergedRC[pid] = {
      hidden_metrics: localRC[pid]?.hidden_metrics || [],
      custom_metrics: pulledRC[pid]?.custom_metrics || [],
    };
  }
  data.report_config = mergedRC;
  replaceState(data, "從 Sheets 拉取");
  return { ok: true, tables: TABLES.length };
}
