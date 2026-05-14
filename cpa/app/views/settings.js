// 設定:Apps Script Web App URL / Token、匯率、警示閾值、危險操作。
// 提供「⚙️ 一次性設定步驟」嚮導,內含 Code.gs 複製按鈕與測試連線。

import { getState, update, replaceState, resetAll } from "../state.js";
import { manualSync, resetSyncMeta, pingSheets } from "../io/sync.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import { DEPLOY_SHEETS_URL, DEPLOY_SHEETS_TOKEN, isDeployManaged } from "../lib/deploy-config.js";

export function render(root) {
  const s = getState();
  const url = isDeployManaged() ? DEPLOY_SHEETS_URL : (s.settings.sheets_webapp_url || "");
  const token = isDeployManaged() ? DEPLOY_SHEETS_TOKEN : (s.settings.sheets_token || "");

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>設定</h1>
        <div class="desc">Apps Script 同步、匯率、警示閾值</div>
      </div>
    </div>

    <div class="card sheets-card">
      <h2>☁️ Google Sheets 同步(CPA 專屬)</h2>
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

    <div class="card mt-8">
      <h2>💱 匯率(內部報表用)</h2>
      <p class="ink-3" style="font-size:13px">
        TWD 花費 = 廠商安裝 × 適用單價(RMB)× 適用匯率;適用匯率優先看打款記錄的批次匯率(FIFO),沒對到批次才用這裡的預設。
      </p>
      <div class="rates-default-grid">
        <div class="field"><label>支出匯率(RMB→TWD,花費換算)</label><input id="cfg-expense" type="number" step="0.01" value="${s.settings.expense_rate ?? 4.8}" /></div>
        <div class="field"><label>收入匯率(RMB→TWD,首儲金額等)</label><input id="cfg-income" type="number" step="0.01" value="${s.settings.income_rate ?? 4.6}" /></div>
      </div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button id="btn-save-rates" class="primary">儲存匯率</button>
      </div>
    </div>

    <div class="card mt-8">
      <h2>⚠️ 警示閾值</h2>
      <div class="field">
        <label>站長低餘額警示(RMB,低於此值在概覽顯示警示)</label>
        <input id="cfg-low-balance" type="number" value="${s.settings.low_balance_threshold_rmb ?? 200}" />
      </div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button id="btn-save-threshold" class="primary">儲存</button>
      </div>
    </div>

    <div class="card mt-8" style="border-left:3px solid var(--bad);background:#fff8f8">
      <h2>🧨 危險操作</h2>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="danger" id="btn-reset-meta">重設同步狀態</button>
        <button class="danger" id="btn-reset-all">重設全部資料</button>
      </div>
      <p class="ink-3" style="font-size:11px;margin-top:6px">
        重設同步狀態 = 清掉 sync_meta(下次同步從 server 重拉版本);本機 state 不動。
        重設全部資料 = 清掉本機 state(站長/線路/產品/打款/安裝/自訂欄目),Sheets 資料不動。
      </p>
    </div>
  `;

  bindHandlers(root);
  loadCodeBlock(root);
}

function bindHandlers(root) {
  const q = (sel) => root.querySelector(sel);
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

  q("#btn-save-sync")?.addEventListener("click", () => {
    saveSyncFields();
    window.toast("已儲存", "ok");
  });

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

  q("#btn-save-rates")?.addEventListener("click", () => {
    const exp = Number(q("#cfg-expense").value) || 4.8;
    const inc = Number(q("#cfg-income").value) || 4.6;
    update((st) => {
      st.settings.expense_rate = exp;
      st.settings.income_rate = inc;
    }, "更新匯率");
    window.toast("已儲存匯率", "ok");
  });

  q("#btn-save-threshold")?.addEventListener("click", () => {
    const t = Number(q("#cfg-low-balance").value) || 200;
    update((st) => { st.settings.low_balance_threshold_rmb = t; }, "更新警示閾值");
    window.toast("已儲存", "ok");
  });

  q("#btn-reset-meta")?.addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "重設同步狀態?",
      body: "清掉 sync_meta(每筆 row 已知的版本與 fingerprint)。下次同步從 server 重新拉所有版本。本機 state 不動。",
      okText: "重設",
      danger: true,
    });
    if (!ok) return;
    resetSyncMeta();
    window.toast("✓ 已重設同步狀態", "ok");
  });

  q("#btn-reset-all")?.addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "重設全部本機資料?",
      body: "本機 state 整個清空(站長 / 線路 / 產品 / 打款 / 安裝數據 / 自訂欄目)。Sheets 資料不動,下次同步會重新拉下來。",
      okText: "清空本機",
      danger: true,
      requireType: { word: "清空", label: "請輸入「清空」以確認" },
    });
    if (!ok) return;
    resetAll();
    window.toast("✓ 已重設本機資料", "ok");
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

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
