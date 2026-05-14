// 設定:分頁式(同步 / 匯率 / 警示 / 危險操作),匯率支援月份表 + JSON 匯入匯出。

import { getState, update, replaceState, resetAll } from "../state.js";
import { manualSync, resetSyncMeta, pingSheets } from "../io/sync.js";
import { nowTaipeiStamp, todayTaipei } from "../lib/dates.js";
import { DEPLOY_SHEETS_URL, DEPLOY_SHEETS_TOKEN, isDeployManaged } from "../lib/deploy-config.js";

const VIEW_KEY = "cpa_settings_view_v1";
const TABS = [
  { id: "sync", label: "Google Sheets 同步" },
  { id: "rates", label: "匯率" },
  { id: "io", label: "匯入匯出" },
  { id: "advanced", label: "進階" },
];

function loadView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}"); } catch { return {}; }
}
function saveView(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {}
}

export function render(root) {
  const view = Object.assign({ tab: "sync" }, loadView());
  if (!TABS.find((t) => t.id === view.tab)) view.tab = "sync";
  saveView(view);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>設定</h1>
        <div class="desc">當月、匯率、Google Sheets 同步、資料匯入匯出</div>
      </div>
    </div>

    <div class="settings-tabs">
      ${TABS.map((t) => `
        <button class="settings-tab ${t.id === view.tab ? "active" : ""}" data-tab="${t.id}">${t.label}</button>
      `).join("")}
    </div>

    <div id="tab-body" class="mt-8"></div>
  `;

  root.querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = () => {
      view.tab = el.dataset.tab;
      saveView(view);
      render(root);
    };
  });

  const body = root.querySelector("#tab-body");
  if (view.tab === "sync") renderSyncTab(body);
  else if (view.tab === "rates") renderRatesTab(body);
  else if (view.tab === "io") renderIoTab(body);
  else if (view.tab === "advanced") renderAdvancedTab(body);
}

// ─── 同步 ────────────────────────────────────────────
function renderSyncTab(body) {
  const s = getState();
  const url = isDeployManaged() ? DEPLOY_SHEETS_URL : (s.settings.sheets_webapp_url || "");
  const token = isDeployManaged() ? DEPLOY_SHEETS_TOKEN : (s.settings.sheets_token || "");

  body.innerHTML = `
    <div class="card sheets-card">
      <p class="sheets-desc">
        本機 localStorage 當主資料,系統會自動 row-level CAS 雙向同步到 Google 試算表。<br>
        ⚠️ CPA 必須開**獨立**的 Google Sheets 與 Apps Script(別跟 CPT 用同一份),否則資料會混在一起。
      </p>

      ${isDeployManaged() ? `
      <div class="callout" style="background:#eef7ff;border-left:3px solid #2a82c8;padding:10px 12px;border-radius:6px;margin:8px 0 14px;font-size:13px">
        🔒 <strong>URL / Token 由部署環境變數提供</strong>(__CPA_CONFIG__ / __CPA_SHEETS_URL__ / __CPA_SHEETS_TOKEN__)。
      </div>` : ""}

      <details class="collapse" ${(s.settings.sheets_webapp_url || isDeployManaged()) ? "" : "open"}>
        <summary>⚙️ 一次性設定步驟${(s.settings.sheets_webapp_url || isDeployManaged()) ? "(點開)" : "(首次使用先看這裡)"}</summary>
        <div class="collapse-body">
          <ol class="setup-steps">
            <li><strong>新建一份</strong> Google 試算表(取名隨意,例如「CPA 計價後台」)。**不要跟 CPT 的混用!**</li>
            <li>選單「<strong>擴充功能 → Apps Script</strong>」</li>
            <li>把 <code>Code.gs</code> 內容全部刪掉,貼上下方程式碼。把第一行 <code>SECRET</code> 改成你自己的隨機字串(記得跟下面 Token 欄位一致)</li>
            <li>儲存(Ctrl+S)→ 右上「<strong>部署</strong>」→「<strong>新增部署</strong>」→ 類型選「<strong>網頁應用程式</strong>」</li>
            <li>執行身分:「<strong>我</strong>」;誰可以存取:「<strong>任何人</strong>」→ 部署 → 同意授權</li>
            <li>複製「網頁應用程式 URL」(網址結尾是 <code>/exec</code>),貼到下方「Web App URL」</li>
            <li>把你在程式碼裡填的 SECRET 也填到下方「Token」</li>
            <li>按「測試連線」確認</li>
          </ol>

          <div class="code-wrap">
            <button class="code-copy-btn" id="copy-code-block">📋 複製</button>
            <pre class="code" id="code-block">載入中…</pre>
          </div>
        </div>
      </details>

      <div class="sheets-form">
        <div class="field" style="flex:3">
          <label>Apps Script Web App URL${isDeployManaged() ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-url" ${isDeployManaged() ? "readonly" : ""} value="${esc(url)}" placeholder="https://script.google.com/macros/s/.../exec" />
        </div>
        <div class="field" style="flex:2">
          <label>共享密鑰 Token${isDeployManaged() ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-token" type="password" ${isDeployManaged() ? "readonly" : ""} value="${esc(token)}" placeholder="與 Apps Script 中 SECRET 相同" />
        </div>
        <div class="sheets-form-actions">
          ${isDeployManaged() ? "" : `<button id="btn-save-sync">儲存設定</button>`}
          <button id="btn-ping">測試連線</button>
        </div>
      </div>

      <div class="sheets-actions">
        <button class="primary" id="btn-sync-now">🔄 立即同步</button>
        <div id="sync-status" class="sync-status"></div>
      </div>
    </div>
  `;

  bindSyncHandlers(body);
  loadCodeBlock(body);
}

function bindSyncHandlers(body) {
  const q = (sel) => body.querySelector(sel);
  const status = q("#sync-status");
  const setStatus = (text, kind = "") => {
    if (!status) return;
    status.textContent = text;
    status.className = `sync-status ${kind}`;
  };
  const saveSyncFields = () => {
    if (isDeployManaged()) return;
    const url = q("#f-url")?.value.trim() || "";
    const token = q("#f-token")?.value.trim() || "";
    update((st) => {
      st.settings.sheets_webapp_url = url;
      st.settings.sheets_token = token;
    }, "更新 Sheets 設定");
  };
  q("#btn-save-sync")?.addEventListener("click", () => { saveSyncFields(); window.toast("已儲存", "ok"); });
  q("#btn-ping")?.addEventListener("click", async () => {
    saveSyncFields();
    setStatus("連線中…");
    try {
      const r = await pingSheets();
      setStatus(`✓ 連線成功(v${r.version || "?"})`, "ok");
      window.toast("連線成功", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      window.toast(`失敗:${e.message}`, "bad");
    }
  });
  q("#btn-sync-now")?.addEventListener("click", async () => {
    saveSyncFields();
    setStatus("同步中…");
    try {
      await manualSync();
      setStatus(`✓ 同步完成(${nowTaipeiStamp()})`, "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
    }
  });
}

async function loadCodeBlock(root) {
  const block = root.querySelector("#code-block");
  if (!block) return;
  let code = "";
  try {
    const res = await fetch("apps-script/Code.gs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    code = await res.text();
  } catch (e) {
    block.textContent = `(無法載入 apps-script/Code.gs:${e.message}。請到專案資料夾直接開啟該檔複製)`;
    return;
  }
  block.textContent = code;
  const blockBtn = root.querySelector("#copy-code-block");
  if (!blockBtn) return;
  blockBtn.onclick = async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(code);
      blockBtn.textContent = "✓ 已複製";
      setTimeout(() => blockBtn.textContent = "📋 複製", 1500);
    } catch {
      window.toast("複製失敗,請手動選取代碼", "bad");
    }
  };
}

// ─── 匯率(月份表)──────────────────────────────────
function renderRatesTab(body) {
  const s = getState();
  const settings = s.settings || {};
  const monthly = settings.monthly_rates || {};
  const sortedMonths = Object.keys(monthly).sort().reverse();
  const currentMonth = settings.current_month || todayTaipei().slice(0, 7);

  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">全局預設匯率</h2>
      <p class="ink-3" style="font-size:12px;margin:4px 0 10px">
        某月沒在下方表中設定 → 走全局預設;打款記錄的批次匯率永遠優先
      </p>
      <div class="rates-default-grid">
        <div class="field"><label>支出匯率(RMB→TWD)</label><input id="cfg-expense" type="number" step="0.01" value="${settings.expense_rate ?? 4.8}" /></div>
        <div class="field"><label>收入匯率(RMB→TWD,首儲金額等)</label><input id="cfg-income" type="number" step="0.01" value="${settings.income_rate ?? 4.6}" /></div>
      </div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button id="btn-save-rates" class="primary">儲存全局預設</button>
      </div>
    </div>

    <div class="card mt-8">
      <h2 style="margin-top:0">月份匯率表(優先 > 全局預設)</h2>
      <p class="ink-3" style="font-size:12px;margin:4px 0 10px">
        例:5 月實際支出匯率 4.85,收入 4.65 → 在這加一列;對帳報表 / 內部報表會優先用這個值。<br>
        JSON 匯入匯出在「匯入匯出」分頁。
      </p>

      <table class="rates-table">
        <thead>
          <tr>
            <th>月份</th>
            <th class="num">支出匯率</th>
            <th class="num">收入匯率</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sortedMonths.length === 0 ? `
            <tr><td colspan="4" class="ink-3" style="text-align:center;padding:14px">尚未設定月份匯率,走全局預設</td></tr>
          ` : sortedMonths.map((m) => `
            <tr>
              <td><strong>${esc(m)}</strong>${m === currentMonth ? ' <span style="font-size:10px;background:#fff3a3;padding:1px 4px;border-radius:3px">當月</span>' : ""}</td>
              <td class="num">${Number(monthly[m]?.expense ?? 0).toFixed(2)}</td>
              <td class="num">${Number(monthly[m]?.income ?? 0).toFixed(2)}</td>
              <td class="num">
                <button data-edit-rate="${esc(m)}">✎</button>
                <button class="danger" data-del-rate="${esc(m)}">刪</button>
              </td>
            </tr>
          `).join("")}
          <tr style="background:#f7f9fc">
            <td><input id="new-rate-month" type="month" value="${esc(currentMonth)}" /></td>
            <td><input id="new-rate-expense" type="number" step="0.01" placeholder="例 4.85" class="num" style="width:80px;text-align:right" /></td>
            <td><input id="new-rate-income" type="number" step="0.01" placeholder="例 4.65" class="num" style="width:80px;text-align:right" /></td>
            <td class="num"><button id="btn-add-rate" class="primary">＋ 新增</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  bindRatesHandlers(body);
}

function bindRatesHandlers(body) {
  const q = (sel) => body.querySelector(sel);

  q("#btn-save-rates")?.addEventListener("click", () => {
    const exp = Number(q("#cfg-expense").value) || 4.8;
    const inc = Number(q("#cfg-income").value) || 4.6;
    update((st) => {
      st.settings.expense_rate = exp;
      st.settings.income_rate = inc;
    }, "更新全局匯率");
    window.toast("已儲存", "ok");
  });

  q("#btn-add-rate")?.addEventListener("click", () => {
    const m = q("#new-rate-month").value;
    const exp = Number(q("#new-rate-expense").value);
    const inc = Number(q("#new-rate-income").value);
    if (!m) { window.toast("月份必填", "bad"); return; }
    if (!Number.isFinite(exp) || exp <= 0) { window.toast("支出匯率要 > 0", "bad"); return; }
    if (!Number.isFinite(inc) || inc <= 0) { window.toast("收入匯率要 > 0", "bad"); return; }
    update((st) => {
      st.settings.monthly_rates = st.settings.monthly_rates || {};
      st.settings.monthly_rates[m] = { expense: exp, income: inc };
    }, `新增/更新匯率 ${m}`);
    window.toast(`✓ ${m} 已儲存`, "ok");
  });

  body.querySelectorAll("[data-edit-rate]").forEach((el) => {
    el.onclick = () => openEditRateModal(el.dataset.editRate);
  });
  body.querySelectorAll("[data-del-rate]").forEach((el) => {
    el.onclick = async () => {
      const m = el.dataset.delRate;
      const ok = await window.confirmAsync({
        title: `刪除 ${m} 的月匯率?`,
        body: `${m} 的計算會 fallback 到全局預設`,
        okText: "刪除", danger: true,
      });
      if (!ok) return;
      update((st) => {
        if (st.settings.monthly_rates) delete st.settings.monthly_rates[m];
      }, `刪除月匯率 ${m}`);
      window.toast("已刪除", "ok");
    };
  });
}

function openEditRateModal(monthYm) {
  const s = getState();
  const rec = s.settings?.monthly_rates?.[monthYm] || { expense: 4.8, income: 4.6 };
  const html = `
    <h2>✎ 編輯 ${esc(monthYm)} 匯率</h2>
    <div class="field"><label>支出匯率(RMB→TWD)</label><input id="m-exp" type="number" step="0.01" value="${Number(rec.expense || 0)}" /></div>
    <div class="field mt-8"><label>收入匯率(RMB→TWD)</label><input id="m-inc" type="number" step="0.01" value="${Number(rec.income || 0)}" /></div>
    <div class="modal-actions">
      <button id="btn-cancel">取消</button>
      <button id="btn-save" class="primary">儲存</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);
  q("#btn-cancel").onclick = () => window.modal.close();
  q("#btn-save").onclick = () => {
    const exp = Number(q("#m-exp").value);
    const inc = Number(q("#m-inc").value);
    if (!Number.isFinite(exp) || exp <= 0) { window.toast("支出匯率要 > 0", "bad"); return; }
    if (!Number.isFinite(inc) || inc <= 0) { window.toast("收入匯率要 > 0", "bad"); return; }
    update((st) => {
      st.settings.monthly_rates = st.settings.monthly_rates || {};
      st.settings.monthly_rates[monthYm] = { expense: exp, income: inc };
    }, `編輯月匯率 ${monthYm}`);
    window.modal.close();
    window.toast("✓ 已儲存", "ok");
  };
}

// ─── 匯入匯出 ──────────────────────────────────────
function renderIoTab(body) {
  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">💱 月匯率 JSON</h2>
      <p class="ink-3" style="font-size:12px;margin:4px 0 10px">
        匯出當前所有月份匯率;匯入時會跟現有的合併(同月份覆蓋,沒在 JSON 裡的月份不動)。
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-rates-export" class="primary">⬇ 匯出月匯率 JSON</button>
        <button id="btn-rates-import">⬆ 匯入月匯率 JSON</button>
        <input type="file" id="rates-file-input" accept=".json,application/json" style="display:none" />
      </div>
    </div>

    <div class="card mt-8">
      <h2 style="margin-top:0">📦 全部資料 JSON(完整備份)</h2>
      <p class="ink-3" style="font-size:12px;margin:4px 0 10px">
        匯出整個本機 state(站長 / 線路 / 產品 / 打款 / 安裝 / 設定);匯入會「完全取代」本機資料。<br>
        ⚠️ 匯入前會自動先匯出一份備份,避免誤覆蓋。匯入後請手動執行同步把資料推回 Sheets。
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button id="btn-state-export" class="primary">⬇ 匯出全部資料 JSON</button>
        <button id="btn-state-import" class="danger">⬆ 匯入全部資料 JSON(取代)</button>
        <input type="file" id="state-file-input" accept=".json,application/json" style="display:none" />
      </div>
    </div>
  `;

  body.querySelector("#btn-rates-export")?.addEventListener("click", () => {
    const s = getState();
    const data = s.settings?.monthly_rates || {};
    downloadJson(data, `cpa_monthly_rates_${todayTaipei()}.json`);
    window.toast(`✓ 已匯出 ${Object.keys(data).length} 個月份`, "ok");
  });

  body.querySelector("#btn-rates-import")?.addEventListener("click", () => body.querySelector("#rates-file-input").click());
  body.querySelector("#rates-file-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("格式不對");
      const valid = {};
      let count = 0;
      for (const [m, v] of Object.entries(parsed)) {
        if (!/^\d{4}-\d{2}$/.test(m)) continue;
        const exp = Number(v?.expense);
        const inc = Number(v?.income);
        if (!Number.isFinite(exp) || !Number.isFinite(inc)) continue;
        valid[m] = { expense: exp, income: inc };
        count++;
      }
      if (count === 0) throw new Error("沒有有效列");
      const ok = await window.confirmAsync({
        title: `匯入 ${count} 個月份的匯率?`,
        body: "現有月份會被覆蓋,沒在 JSON 裡的月份保留不動",
        okText: "匯入",
      });
      if (!ok) { e.target.value = ""; return; }
      update((st) => {
        st.settings.monthly_rates = { ...(st.settings.monthly_rates || {}), ...valid };
      }, `JSON 匯入匯率 ${count} 筆`);
      window.toast(`✓ 已匯入 ${count} 筆`, "ok");
    } catch (err) {
      window.toast(`匯入失敗:${err.message}`, "bad");
    }
    e.target.value = "";
  });

  body.querySelector("#btn-state-export")?.addEventListener("click", () => {
    const s = getState();
    downloadJson(s, `cpa_state_backup_${todayTaipei()}.json`);
    window.toast(`✓ 已匯出全部資料`, "ok");
  });

  body.querySelector("#btn-state-import")?.addEventListener("click", () => body.querySelector("#state-file-input").click());
  body.querySelector("#state-file-input")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object") throw new Error("格式不對(不是 object)");
      if (!Array.isArray(parsed.publishers) && !Array.isArray(parsed.channels)) {
        throw new Error("格式不像 CPA state(缺 publishers / channels)");
      }
      const counts = {
        產品: (parsed.products || []).length,
        站長: (parsed.publishers || []).length,
        線路: (parsed.channels || []).length,
        打款: (parsed.payments || []).length,
        安裝數據: (parsed.install_data || []).length,
      };
      const ok = await window.confirmAsync({
        title: `匯入並「取代」全部資料?`,
        body: `會把本機 state 整個替換成 JSON 內容:\n${Object.entries(counts).map(([k, v]) => `· ${k}:${v} 筆`).join("\n")}\n\n匯入前會先自動下載當前資料當備份`,
        okText: "取代",
        danger: true,
        requireType: { word: "取代", label: "請輸入「取代」以確認" },
      });
      if (!ok) { e.target.value = ""; return; }
      // 自動備份
      downloadJson(getState(), `cpa_state_before_replace_${todayTaipei()}.json`);
      replaceState(parsed, "JSON 匯入全部資料");
      window.toast(`✓ 已匯入並取代`, "ok");
    } catch (err) {
      window.toast(`匯入失敗:${err.message}`, "bad");
    }
    e.target.value = "";
  });
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── 進階(警示閾值 + 危險操作)─────────────────────
function renderAdvancedTab(body) {
  const s = getState();
  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">⚠️ 警示閾值</h2>
      <div class="field">
        <label>站長低餘額警示(RMB,低於此值在概覽顯示警示)</label>
        <input id="cfg-low-balance" type="number" value="${s.settings.low_balance_threshold_rmb ?? 200}" />
      </div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button id="btn-save-threshold" class="primary">儲存</button>
      </div>
    </div>

    <div class="card mt-8" style="border-left:3px solid #d32f2f;background:#fff8f8">
      <h2 style="margin-top:0">🧨 危險操作</h2>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        <button class="danger" id="btn-reset-meta">重設同步狀態</button>
        <button class="danger" id="btn-reset-all">重設全部資料</button>
      </div>
      <p class="ink-3" style="font-size:11px;margin-top:6px">
        重設同步狀態 = 清掉 sync_meta(下次同步從 server 重拉版本);本機 state 不動。<br>
        重設全部資料 = 清掉本機 state(站長 / 線路 / 產品 / 打款 / 安裝 / 自訂欄目),Sheets 資料不動。
      </p>
    </div>
  `;
  body.querySelector("#btn-save-threshold").addEventListener("click", () => {
    const t = Number(body.querySelector("#cfg-low-balance").value) || 200;
    update((st) => { st.settings.low_balance_threshold_rmb = t; }, "更新警示閾值");
    window.toast("已儲存", "ok");
  });
  body.querySelector("#btn-reset-meta").addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "重設同步狀態?",
      body: "清掉 sync_meta(每筆 row 已知的版本與 fingerprint)。下次同步從 server 重新拉所有版本。本機 state 不動。",
      okText: "重設", danger: true,
    });
    if (!ok) return;
    resetSyncMeta();
    window.toast("✓ 已重設同步狀態", "ok");
  });
  body.querySelector("#btn-reset-all").addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "重設全部本機資料?",
      body: "本機 state 整個清空(站長 / 線路 / 產品 / 打款 / 安裝數據 / 自訂欄目)。Sheets 資料不動,下次同步會重新拉下來。",
      okText: "清空本機", danger: true,
      requireType: { word: "清空", label: "請輸入「清空」以確認" },
    });
    if (!ok) return;
    resetAll();
    window.toast("✓ 已重設本機資料", "ok");
  });
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
