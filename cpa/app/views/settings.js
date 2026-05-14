// 設定:CPA 自己的 Apps Script URL + Token、匯率、月份、閾值。
// P1 骨架,先放最重要的 Apps Script 連線設定讓開發期可以測同步。

import { getState, update, resetAll } from "../state.js";
import { manualSync, resetSyncMeta } from "../io/sync.js";

export function render(root) {
  const s = getState();
  root.innerHTML = `
    <header class="view-head">
      <h1>⚙️ 設定</h1>
    </header>

    <section class="card">
      <h2>☁️ Google Sheets 同步</h2>
      <p class="ink-2" style="font-size:13px;line-height:1.6">
        填入你 CPA 專屬 Apps Script 的 Web App URL 與 Token(跟 CPT 用不同的 Sheets!)。
        儲存後系統會自動 row-level CAS 同步。
      </p>
      <div class="field">
        <label>Apps Script Web App URL</label>
        <input id="cfg-url" type="text" value="${esc(s.settings.sheets_webapp_url || "")}" placeholder="https://script.google.com/macros/s/.../exec" style="width:100%" />
      </div>
      <div class="field mt-8">
        <label>Token(對應 Apps Script 內的 SECRET)</label>
        <input id="cfg-token" type="text" value="${esc(s.settings.sheets_token || "")}" placeholder="自訂隨機字串" style="width:100%" />
      </div>
      <div class="modal-actions">
        <button id="btn-save-sheets" class="primary">儲存</button>
        <button id="btn-manual-sync">手動同步一次</button>
      </div>
    </section>

    <section class="card mt-8">
      <h2>💱 匯率</h2>
      <div class="field">
        <label>支出匯率(RMB → TWD,用於內部報表花費)</label>
        <input id="cfg-expense" type="number" step="0.01" value="${s.settings.expense_rate || 4.8}" />
      </div>
      <div class="field mt-8">
        <label>收入匯率(TWD,用於首儲金額轉換)</label>
        <input id="cfg-income" type="number" step="0.01" value="${s.settings.income_rate || 4.6}" />
      </div>
      <div class="modal-actions">
        <button id="btn-save-rates" class="primary">儲存匯率</button>
      </div>
    </section>

    <section class="card mt-8">
      <h2>⚠️ 警示閾值</h2>
      <div class="field">
        <label>站長低餘額警示(RMB,低於此值在概覽顯示警示)</label>
        <input id="cfg-low-balance" type="number" value="${s.settings.low_balance_threshold_rmb || 200}" />
      </div>
      <div class="modal-actions">
        <button id="btn-save-threshold" class="primary">儲存</button>
      </div>
    </section>

    <section class="card mt-8 danger">
      <h2>🧨 危險操作</h2>
      <div class="modal-actions">
        <button id="btn-reset-meta" class="danger">重設同步狀態</button>
        <button id="btn-reset-all" class="danger">重設全部資料</button>
      </div>
      <p class="ink-3" style="font-size:11px;margin-top:6px">
        重設同步狀態 = 清掉 sync_meta(下次同步從 server 重拉版本)。重設全部資料 = 清掉本機 state。
      </p>
    </section>
  `;

  const q = (sel) => root.querySelector(sel);

  q("#btn-save-sheets").onclick = () => {
    const url = q("#cfg-url").value.trim();
    const token = q("#cfg-token").value.trim();
    update((st) => {
      st.settings.sheets_webapp_url = url;
      st.settings.sheets_token = token;
    }, "更新 Sheets 設定");
    window.toast("已儲存", "ok");
  };

  q("#btn-manual-sync").onclick = async () => {
    try {
      await manualSync();
    } catch (e) {
      // sync banner 已經顯示了錯誤,不重複 toast
    }
  };

  q("#btn-save-rates").onclick = () => {
    const exp = Number(q("#cfg-expense").value) || 4.8;
    const inc = Number(q("#cfg-income").value) || 4.6;
    update((st) => {
      st.settings.expense_rate = exp;
      st.settings.income_rate = inc;
    }, "更新匯率");
    window.toast("已儲存匯率", "ok");
  };

  q("#btn-save-threshold").onclick = () => {
    const t = Number(q("#cfg-low-balance").value) || 200;
    update((st) => { st.settings.low_balance_threshold_rmb = t; }, "更新警示閾值");
    window.toast("已儲存", "ok");
  };

  q("#btn-reset-meta").onclick = async () => {
    const ok = await window.confirmAsync({
      title: "重設同步狀態?",
      body: "清掉 sync_meta(每筆 row 已知的版本與 fingerprint)。下次同步會從 server 重新拉所有版本。本機 state 不動。",
      okText: "重設",
      danger: true,
    });
    if (!ok) return;
    resetSyncMeta();
    window.toast("✓ 已重設同步狀態", "ok");
  };

  q("#btn-reset-all").onclick = async () => {
    const ok = await window.confirmAsync({
      title: "重設全部本機資料?",
      body: "本機 state 整個清空(站長 / 線路 / 產品 / 打款 / 安裝數據 / 自訂欄目)。Sheets 上的資料不動,下次同步會重新拉下來。",
      okText: "清空本機",
      danger: true,
      requireType: { word: "清空", label: "請輸入「清空」以確認" },
    });
    if (!ok) return;
    resetAll();
    window.toast("✓ 已重設本機資料", "ok");
  };
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
