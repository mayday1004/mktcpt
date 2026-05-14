// 資料匯入:從 GSheets「安裝數據輸入」分頁讀資料,比對渠道 + 產品後寫入 install_data。
// 不走一般同步循環(避免暫存區資料污染主資料)。
//
// 流程:
//   1. 「🗂️ 建立輸入分頁」→ writeTable with headers,清空現有資料
//   2. 使用者去 GSheets 貼資料
//   3. 「📥 讀取並驗證」→ readTable,在這頁顯示預覽 + 錯誤清單
//   4. 「✓ 匯入 N 筆」→ 寫入 state.install_data(同 date+channel+product 覆寫),推「安裝數據」分頁
//   5. (選)「🗑️ 清空輸入分頁」→ 準備下一週貼

import { getState, update } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import { RAW_INSTALL_FIELDS } from "../schema.js";
import { getEffectiveSheetsUrl, getEffectiveSheetsToken } from "../lib/deploy-config.js";

const INPUT_SHEET = "安裝數據輸入";
const INPUT_HEADERS = ["日期", "渠道名稱", "產品代碼", ...RAW_INSTALL_FIELDS];

let parsed = null;  // { valid: [...], errors: [...] }

async function call(payload) {
  const s = getState();
  const url = getEffectiveSheetsUrl(s.settings);
  const token = getEffectiveSheetsToken(s.settings);
  if (!url) throw new Error("尚未設定 Apps Script Web App URL(設定頁)");
  if (!token) throw new Error("尚未設定 Token(設定頁)");
  const fd = new FormData();
  fd.append("payload", JSON.stringify({ ...payload, token }));
  const res = await fetch(url, { method: "POST", body: fd, redirect: "follow" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`回應非 JSON(前 200 字):${text.slice(0, 200)}`); }
  if (json.error) throw new Error(json.error);
  return json;
}

export function render(root) {
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>📥 資料匯入</h1>
        <div class="desc">把廣告平台匯出的安裝數據貼到 GSheets「${INPUT_SHEET}」分頁,在這裡按「讀取並驗證」</div>
      </div>
      <div class="view-actions">
        <button id="btn-init">🗂️ 建立 / 重設輸入分頁</button>
        <button class="primary" id="btn-load">📥 讀取並驗證</button>
      </div>
    </div>

    <details class="card" style="padding:10px 14px">
      <summary class="ink-3" style="cursor:pointer;font-size:13px">📋 欄位規格(點開展開,共 ${INPUT_HEADERS.length} 欄)</summary>
      <div class="ink-3" style="font-size:12px;line-height:1.8;margin-top:8px">
        <strong>日期</strong>(YYYY-MM-DD)·
        <strong>渠道名稱</strong>(跟線路頁「渠道名稱」完全一致)·
        <strong>產品代碼</strong>(產品的 GSheets 欄位代碼 / id / 中文名皆可)·
        ${RAW_INSTALL_FIELDS.map((f) => f === "廠商安裝" ? `<strong style="color:#d32f2f">${esc(f)}(CPA 計費依此)</strong>` : `<strong>${esc(f)}</strong>`).join(" · ")}
        <br>每列 = 一筆 (日期 × 渠道 × 產品) 的安裝數據;同 (日期+渠道+產品) 多次匯入會以最新一筆為準。
      </div>
    </details>

    <div id="preview-card"></div>

    <div id="status" class="ink-3" style="font-size:13px;margin-top:8px"></div>
  `;

  root.querySelector("#btn-init")?.addEventListener("click", () => initSheet(root));
  root.querySelector("#btn-load")?.addEventListener("click", () => loadAndValidate(root));

  if (parsed) renderPreview(root);
}

async function initSheet(root) {
  const status = root.querySelector("#status");
  if (!await window.confirmAsync({
    title: `建立 / 重設「${INPUT_SHEET}」分頁?`,
    body: "會把分頁清空(只保留表頭)。如果分頁裡還有未匯入的資料會被清掉。",
    okText: "建立 / 重設",
    danger: true,
  })) return;
  status.textContent = "建立中…";
  try {
    await call({
      action: "writeTable",
      sheetName: INPUT_SHEET,
      headers: INPUT_HEADERS,
      rows: [],
    });
    status.textContent = `✓ 已建立「${INPUT_SHEET}」分頁,可以去 Sheets 貼資料了`;
    status.style.color = "green";
    window.toast("✓ 輸入分頁已就緒", "ok");
  } catch (e) {
    status.textContent = `✗ 失敗:${e.message}`;
    status.style.color = "#d32f2f";
    window.toast(`失敗:${e.message}`, "bad");
  }
}

async function loadAndValidate(root) {
  const status = root.querySelector("#status");
  status.textContent = "讀取 Sheets 中…";
  status.style.color = "";
  try {
    const r = await call({ action: "readTable", sheetName: INPUT_SHEET });
    const headers = r.headers || [];
    const rows = r.rows || [];
    if (!headers.length) {
      throw new Error(`「${INPUT_SHEET}」分頁不存在或沒表頭,先按「🗂️ 建立 / 重設輸入分頁」`);
    }
    parsed = parseRows(headers, rows);
    status.textContent = `讀取 ${rows.length} 列,有效 ${parsed.valid.length}、錯誤 ${parsed.errors.length}`;
    renderPreview(root);
  } catch (e) {
    parsed = null;
    status.textContent = `✗ ${e.message}`;
    status.style.color = "#d32f2f";
  }
}

function parseRows(headers, rows) {
  const s = getState();
  const channels = s.channels || [];
  const products = s.products || [];
  const chByName = Object.fromEntries(channels.map((c) => [c.name, c]));
  // 產品:id / gsheet_field_code / name 都當 key
  const prodLookup = {};
  for (const p of products) {
    if (p.id) prodLookup[p.id] = p;
    if (p.gsheet_field_code) prodLookup[p.gsheet_field_code] = p;
    if (p.name) prodLookup[p.name] = p;
  }

  const idx = Object.fromEntries(INPUT_HEADERS.map((h) => [h, headers.indexOf(h)]));
  const missing = INPUT_HEADERS.filter((h) => idx[h] < 0);
  if (missing.length) {
    throw new Error(`分頁缺欄位:${missing.join("、")}(按「🗂️ 建立 / 重設輸入分頁」修復)`);
  }

  const valid = [];
  const errors = [];
  rows.forEach((row, i) => {
    const lineNo = i + 2;
    const get = (h) => idx[h] >= 0 ? row[idx[h]] : "";
    const dateRaw = String(get("日期") || "").trim();
    const chName = String(get("渠道名稱") || "").trim();
    const prodKey = String(get("產品代碼") || "").trim();

    // 空白整列 → 跳過
    if (!dateRaw && !chName && !prodKey) return;

    const date = parseDate(dateRaw);
    if (!date) {
      errors.push({ row: lineNo, msg: `日期格式無效:${dateRaw}` });
      return;
    }
    if (!chName) { errors.push({ row: lineNo, msg: "渠道名稱空白" }); return; }
    if (!prodKey) { errors.push({ row: lineNo, msg: `產品代碼空白(渠道 ${chName})` }); return; }

    const ch = chByName[chName];
    if (!ch) {
      errors.push({ row: lineNo, msg: `找不到渠道「${chName}」(請先到「線路」頁建立或檢查名稱)` });
      return;
    }
    const pr = prodLookup[prodKey];
    if (!pr) {
      errors.push({ row: lineNo, msg: `找不到產品「${prodKey}」(請對應產品的 id / GSheets 欄位代碼 / 名稱)` });
      return;
    }

    const rec = {
      _line: lineNo,
      date,
      channel_id: ch.id,
      channel_name: ch.name,
      product_id: pr.id,
      product_name: pr.name,
    };
    let hasAnyValue = false;
    for (const f of RAW_INSTALL_FIELDS) {
      const v = Number(get(f));
      rec[f] = Number.isFinite(v) ? v : 0;
      if (rec[f] !== 0) hasAnyValue = true;
    }
    if (!hasAnyValue) {
      errors.push({ row: lineNo, msg: `所有指標都是 0(${chName} × ${pr.name})— 跳過避免覆寫已存在資料` });
      return;
    }
    valid.push(rec);
  });

  return { valid, errors };
}

function parseDate(raw) {
  if (!raw) return null;
  // 已是 YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  // ISO 時間戳
  const m = String(raw).match(/^(\d{4}-\d{2}-\d{2})T/);
  if (m) return m[1];
  // YYYY/MM/DD
  const m2 = String(raw).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m2) return `${m2[1]}-${String(m2[2]).padStart(2, "0")}-${String(m2[3]).padStart(2, "0")}`;
  // 試 Date.parse
  const dt = new Date(raw);
  if (Number.isFinite(dt.getTime())) {
    const y = dt.getFullYear();
    const mo = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}

function renderPreview(root) {
  const panel = root.querySelector("#preview-card");
  if (!panel || !parsed) return;
  const { valid, errors } = parsed;

  panel.innerHTML = `
    <div class="card mt-8">
      <h2 style="margin-top:0">📊 預覽(${valid.length} 筆有效 · ${errors.length} 筆錯誤)</h2>

      ${errors.length > 0 ? `
        <details ${valid.length === 0 ? "open" : ""}>
          <summary style="cursor:pointer;color:#d32f2f;font-weight:600">⚠️ 錯誤 ${errors.length} 筆(展開)</summary>
          <div class="table-wrap" style="max-height:200px;overflow:auto;margin-top:6px">
            <table>
              <thead><tr><th>列</th><th>問題</th></tr></thead>
              <tbody>
                ${errors.map((e) => `<tr><td>${e.row}</td><td>${esc(e.msg)}</td></tr>`).join("")}
              </tbody>
            </table>
          </div>
        </details>
      ` : ""}

      ${valid.length > 0 ? `
        <details open style="margin-top:8px">
          <summary style="cursor:pointer;font-weight:600">✓ 有效 ${valid.length} 筆(展開查看前 20 筆)</summary>
          <div class="table-wrap" style="max-height:300px;overflow:auto;margin-top:6px">
            <table>
              <thead>
                <tr>
                  <th>日期</th><th>渠道</th><th>產品</th>
                  <th class="num">廠商安裝</th>
                  <th class="num">不重複安裝</th>
                  <th class="num">不重複活躍</th>
                  <th class="num">首儲訂單</th>
                  <th class="num">首儲金額</th>
                </tr>
              </thead>
              <tbody>
                ${valid.slice(0, 20).map((v) => `
                  <tr>
                    <td>${esc(v.date)}</td>
                    <td>${esc(v.channel_name)}</td>
                    <td>${esc(v.product_name)}</td>
                    <td class="num">${numFmt(v["廠商安裝"])}</td>
                    <td class="num">${numFmt(v["不重複安裝數"])}</td>
                    <td class="num">${numFmt(v["不重複活躍"])}</td>
                    <td class="num">${numFmt(v["首儲訂單數"])}</td>
                    <td class="num">${numFmt(v["首儲金額"])}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </details>
      ` : ""}

      <div class="modal-actions" style="justify-content:flex-start;gap:8px;margin-top:12px">
        <button id="btn-import" class="primary" ${valid.length === 0 ? "disabled" : ""}>✓ 匯入 ${valid.length} 筆</button>
        <button id="btn-clear">🗑️ 清空輸入分頁</button>
      </div>
    </div>
  `;

  panel.querySelector("#btn-import")?.addEventListener("click", () => doImport(root));
  panel.querySelector("#btn-clear")?.addEventListener("click", () => clearInput(root));
}

async function doImport(root) {
  if (!parsed || parsed.valid.length === 0) return;
  const valid = parsed.valid;
  const status = root.querySelector("#status");

  const ok = await window.confirmAsync({
    title: `匯入 ${valid.length} 筆安裝數據?`,
    body: `寫入本機 install_data(同 日期+渠道+產品 會覆寫舊資料)。匯入後背景同步會把資料推回 GSheets「安裝數據」分頁。`,
    okText: `匯入 ${valid.length} 筆`,
  });
  if (!ok) return;

  update((st) => {
    st.install_data = st.install_data || [];
    for (const v of valid) {
      const existing = st.install_data.findIndex((d) =>
        d.date === v.date && d.channel_id === v.channel_id && d.product_id === v.product_id
      );
      const rec = {
        date: v.date,
        channel_id: v.channel_id,
        product_id: v.product_id,
      };
      for (const f of RAW_INSTALL_FIELDS) rec[f] = v[f];
      if (existing >= 0) st.install_data[existing] = rec;
      else st.install_data.push(rec);
    }
  }, `匯入安裝數據 ${valid.length} 筆`);

  status.textContent = `✓ 已寫入 ${valid.length} 筆;背景同步會在 5 秒內把資料推回 GSheets`;
  status.style.color = "green";
  window.toast(`✓ 匯入完成 ${valid.length} 筆`, "ok");
  parsed = null;
  root.querySelector("#preview-card").innerHTML = "";
}

async function clearInput(root) {
  const ok = await window.confirmAsync({
    title: `清空「${INPUT_SHEET}」分頁?`,
    body: "把分頁清空(保留表頭),通常匯入完成後執行,準備下一批資料。",
    okText: "清空",
    danger: true,
  });
  if (!ok) return;
  const status = root.querySelector("#status");
  status.textContent = "清空中…";
  try {
    await call({
      action: "writeTable",
      sheetName: INPUT_SHEET,
      headers: INPUT_HEADERS,
      rows: [],
    });
    status.textContent = "✓ 已清空輸入分頁";
    status.style.color = "green";
    window.toast("✓ 已清空", "ok");
    parsed = null;
    root.querySelector("#preview-card").innerHTML = "";
  } catch (e) {
    status.textContent = `✗ 失敗:${e.message}`;
    status.style.color = "#d32f2f";
  }
}

function numFmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("zh-TW");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
