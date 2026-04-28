import { getState, update, replaceState, resetAll } from "../state.js";
import { pushToSheets, pullFromSheets, pingSheets } from "../io/sheets.js";
import { showSyncBanner, markSyncDone } from "../lib/sync-banner.js";
import { downloadText } from "../lib/csv.js";
import { getExpenseRate, getIncomeRate, getRateSource, getUsdtToCnyRate } from "../schema.js";
import { nowTaipeiStamp } from "../lib/dates.js";

let activeSub = "sync";  // sync / rates / data / advanced

export function render(root) {
  const s = getState();

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>設定</h1>
        <div class="desc">當月、匯率、Google Sheets 同步、資料匯入匯出</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab ${activeSub === "sync" ? "active" : ""}" data-sub="sync">Google Sheets 同步</button>
      <button class="tab ${activeSub === "rates" ? "active" : ""}" data-sub="rates">匯率</button>
      <button class="tab ${activeSub === "data" ? "active" : ""}" data-sub="data">匯入匯出</button>
      <button class="tab ${activeSub === "advanced" ? "active" : ""}" data-sub="advanced">進階</button>
    </div>

    <div class="${activeSub === "sync" ? "" : "hidden"}">
    <div class="card sheets-card">
      <h2>☁️ Google Sheets 同步（混合模式）</h2>
      <p class="sheets-desc">
        本機 localStorage 為主，按鈕手動推送 / 拉回到 Google 試算表。<br>
        全量拉回前會自動下載一份本機 JSON 備份，避免誤覆蓋。報表（月度 / 每日花費 / 分組 / 攤提）為單向推送（規劃中）。
      </p>

      <details class="collapse" ${s.settings.sheets_webapp_url ? "" : "open"}>
        <summary>⚙️ 一次性設定步驟${s.settings.sheets_webapp_url ? "（點開）" : "（首次使用先看這裡）"}</summary>
        <div class="collapse-body">
          <ol class="setup-steps">
            <li>新建或開啟一份 <strong>Google 試算表</strong></li>
            <li>選單「<strong>擴充功能 → Apps Script</strong>」</li>
            <li>把 <code>Code.gs</code> 內容全部刪掉，貼上下方程式碼。把第一行 <code>SECRET</code> 改成你自己的隨機字串（記得跟下面 Token 欄位一致）</li>
            <li>儲存（Ctrl+S）→ 右上「<strong>部署</strong>」→「<strong>新增部署</strong>」→ 類型選「<strong>網頁應用程式</strong>」</li>
            <li>執行身分：「<strong>我</strong>」；誰可以存取：「<strong>任何人</strong>」→ 部署 → 同意授權</li>
            <li>複製「網頁應用程式 URL」（網址結尾是 <code>/exec</code>），貼到下方「Web App URL」</li>
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
          <label>Apps Script Web App URL</label>
          <input id="f-url" value="${escape(s.settings.sheets_webapp_url)}" placeholder="https://script.google.com/macros/s/.../exec" />
        </div>
        <div class="field" style="flex:2">
          <label>共享密鑰 Token</label>
          <input id="f-token" type="password" value="${escape(s.settings.sheets_token)}" placeholder="與 Apps Script 中 SECRET 相同" />
        </div>
        <div class="sheets-form-actions">
          <button id="btn-save-sync">儲存設定</button>
          <button id="btn-ping">測試連線</button>
        </div>
      </div>

      <div class="sheets-actions">
        <button id="btn-pull">⬇️ 從 Sheets 拉下來</button>
        <button class="primary" id="btn-push">☁️ 推到 Sheets</button>
        <div id="sync-status" class="sync-status"></div>
      </div>

      <div id="sync-progress" class="sync-progress hidden">
        <div class="sync-progress-bar"><div class="sync-progress-fill" id="sync-progress-fill"></div></div>
        <div class="sync-progress-text" id="sync-progress-text">準備中…</div>
      </div>
    </div>
    </div>

    <div class="${activeSub === "rates" ? "" : "hidden"}">
    <div class="card">
      <h2>預設匯率</h2>
      <p class="ink-3" style="font-size:12px;margin:-4px 0 12px">「預設匯率」是當月份未在下方覆寫時 fallback 使用的值；變動頻率低時可全年沿用。</p>
      <div class="grid-3">
        <div class="field"><label>預設支出匯率（採買用）</label><input type="number" step="0.01" id="f-exp" value="${s.settings.expense_rate}" /></div>
        <div class="field"><label>預設收入匯率</label><input type="number" step="0.01" id="f-inc" value="${s.settings.income_rate}" /></div>
      </div>
      <div class="modal-actions" style="justify-content:flex-start">
        <button class="primary" id="save-rates-default">儲存預設匯率</button>
      </div>
    </div>

    ${renderMonthlyRatesCard(s)}
    </div>

    <div class="${activeSub === "data" ? "" : "hidden"}">
    <div class="card">
      <h2>本機 JSON 備份</h2>
      <p class="ink-3" style="font-size:13px">將整份本機資料匯出成 JSON 檔，或從先前的 JSON 還原。</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button id="btn-export-json">匯出 JSON</button>
        <button id="btn-import-json">匯入 JSON</button>
      </div>
    </div>
    </div>

    <div class="${activeSub === "advanced" ? "" : "hidden"}">
    <div class="card">
      <h2>範例資料（開發用）</h2>
      <p class="ink-3" style="font-size:13px">預先準備好的 2026-04 / 2026-05 樣本資料，用來看完整 UI 長怎樣。</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button id="btn-sample-apr">🧪 載入 4 月範例</button>
        <button id="btn-sample-may">🧪 載入 5 月範例</button>
      </div>
    </div>
    <div class="card">
      <h2>重設</h2>
      <p class="ink-3" style="font-size:13px">將清除所有本機資料並還原為預設產品。動作不可逆。</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="danger" id="btn-reset">重設全部資料</button>
      </div>
    </div>
    </div>
  `;

  bindHandlers(root);
  loadCodeBlock(root);
}

// 每月匯率覆寫卡片：顯示當月 + 其他已設過的月份；可新增月份
function renderMonthlyRatesCard(s) {
  const ym = s.settings.current_month;
  const monthlyRates = s.settings.monthly_rates || {};
  const curExp = getExpenseRate(s, ym);
  const curInc = getIncomeRate(s, ym);
  const curUsdt = getUsdtToCnyRate(s, ym);
  const curExpSrc = getRateSource(s, ym, "expense");
  const curIncSrc = getRateSource(s, ym, "income");
  const curUsdtSrc = getRateSource(s, ym, "usdt_to_cny");
  const defUsdt = s.settings.usdt_to_cny_rate ?? 7.2;

  const cur = monthlyRates[ym] || {};
  const otherMonths = Object.keys(monthlyRates)
    .filter((m) => m !== ym && monthlyRates[m] && (Number.isFinite(monthlyRates[m].expense) || Number.isFinite(monthlyRates[m].income) || Number.isFinite(monthlyRates[m].usdt_to_cny)))
    .sort((a, b) => b.localeCompare(a));

  return `
    <div class="card">
      <div class="card-head">
        <h2>每月匯率覆寫</h2>
        <div class="ink-3" style="font-size:12px">留空 = 沿用預設；新建廣告會用「廣告開始月」的匯率</div>
      </div>

      <div class="rate-table">
        <div class="rate-row rate-row-current">
          <div class="rate-month">
            <strong>${ym}</strong>
            <span class="pill" style="margin-left:6px">當月</span>
          </div>
          <div class="rate-cell">
            <label>支出 RMB→TWD</label>
            <input type="number" step="0.01" data-rate-month="${ym}" data-rate-kind="expense" value="${cur.expense ?? ""}" placeholder="${s.settings.expense_rate}" />
            <span class="rate-eff ${curExpSrc}">→ <strong>${curExp.toFixed(2)}</strong> ${curExpSrc === "monthly" ? "(覆寫)" : "(預設)"}</span>
          </div>
          <div class="rate-cell">
            <label>收入 RMB→TWD</label>
            <input type="number" step="0.01" data-rate-month="${ym}" data-rate-kind="income" value="${cur.income ?? ""}" placeholder="${s.settings.income_rate}" />
            <span class="rate-eff ${curIncSrc}">→ <strong>${curInc.toFixed(2)}</strong> ${curIncSrc === "monthly" ? "(覆寫)" : "(預設)"}</span>
          </div>
          <div class="rate-cell">
            <label>USDT→RMB</label>
            <input type="number" step="0.01" data-rate-month="${ym}" data-rate-kind="usdt_to_cny" value="${cur.usdt_to_cny ?? ""}" placeholder="${defUsdt}" />
            <span class="rate-eff ${curUsdtSrc}">→ <strong>${curUsdt.toFixed(2)}</strong> ${curUsdtSrc === "monthly" ? "(覆寫)" : "(預設)"}</span>
          </div>
        </div>

        ${otherMonths.map((m) => {
          const r = monthlyRates[m] || {};
          const expEff = getExpenseRate(s, m);
          const incEff = getIncomeRate(s, m);
          const usdtEff = getUsdtToCnyRate(s, m);
          return `
            <div class="rate-row">
              <div class="rate-month"><strong>${m}</strong></div>
              <div class="rate-cell">
                <label>支出 RMB→TWD</label>
                <input type="number" step="0.01" data-rate-month="${m}" data-rate-kind="expense" value="${r.expense ?? ""}" placeholder="${s.settings.expense_rate}" />
                <span class="rate-eff">→ <strong>${expEff.toFixed(2)}</strong></span>
              </div>
              <div class="rate-cell">
                <label>收入 RMB→TWD</label>
                <input type="number" step="0.01" data-rate-month="${m}" data-rate-kind="income" value="${r.income ?? ""}" placeholder="${s.settings.income_rate}" />
                <span class="rate-eff">→ <strong>${incEff.toFixed(2)}</strong></span>
              </div>
              <div class="rate-cell">
                <label>USDT→RMB</label>
                <input type="number" step="0.01" data-rate-month="${m}" data-rate-kind="usdt_to_cny" value="${r.usdt_to_cny ?? ""}" placeholder="${defUsdt}" />
                <span class="rate-eff">→ <strong>${usdtEff.toFixed(2)}</strong></span>
              </div>
              <button class="ghost rate-remove" data-rate-remove="${m}" title="移除此月覆寫">✕</button>
            </div>
          `;
        }).join("")}

        <div class="rate-row rate-row-add">
          <input type="month" id="rate-new-month" />
          <button id="rate-add">＋ 新增月份</button>
          <span class="ink-3" style="font-size:12px">先選月份再新增；新增後會出現在上方列表</span>
        </div>
      </div>

      <div class="modal-actions" style="justify-content:flex-start">
        <button class="primary" id="save-rates">儲存匯率</button>
      </div>
    </div>
  `;
}

function bindHandlers(root) {
  root.querySelectorAll("[data-sub]").forEach((el) => {
    el.onclick = () => { activeSub = el.dataset.sub; render(root); };
  });

  const bind = (sel, fn) => { const el = root.querySelector(sel); if (el) el.onclick = fn; };

  const status = root.querySelector("#sync-status");
  const progBox = root.querySelector("#sync-progress");
  const progFill = root.querySelector("#sync-progress-fill");
  const progText = root.querySelector("#sync-progress-text");
  const pushBtn = root.querySelector("#btn-push");
  const pullBtn = root.querySelector("#btn-pull");
  const pingBtn = root.querySelector("#btn-ping");

  const setStatus = (text, kind = "") => {
    if (!status) return;
    status.textContent = text;
    status.className = `sync-status ${kind}`;
  };
  const showProgress = (show) => {
    if (!progBox) return;
    progBox.classList.toggle("hidden", !show);
    if (!show && progFill) progFill.style.width = "0%";
  };
  const setBusy = (busy) => {
    [pushBtn, pullBtn, pingBtn].forEach((b) => { if (b) b.disabled = busy; });
  };
  const onProg = (p) => {
    // 同步更新「設定頁內的進度條」+「浮動 banner」（跨頁可見）
    showSyncBanner(p);
    if (!progBox || !progFill || !progText) return;
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    progFill.style.width = `${pct}%`;
    progText.textContent = `${p.phase === "push" ? "推送" : "拉取"} ${p.current}/${p.total} 個分頁 · ${p.name} (${pct}%)`;
  };

  // 「匯率」tab 預設匯率儲存
  bind("#save-rates-default", () => {
    update((st) => {
      st.settings.expense_rate = Number(root.querySelector("#f-exp").value) || 4.7;
      st.settings.income_rate = Number(root.querySelector("#f-inc").value) || 4.5;
    }, "儲存預設匯率");
    toast("已儲存預設匯率", "ok");
  });

  // 儲存每月匯率覆寫
  bind("#save-rates", () => {
    const inputs = root.querySelectorAll("[data-rate-month][data-rate-kind]");
    const collected = {};
    inputs.forEach((inp) => {
      const m = inp.dataset.rateMonth;
      const kind = inp.dataset.rateKind;
      const v = Number(inp.value);
      if (Number.isFinite(v) && v > 0) {
        if (!collected[m]) collected[m] = {};
        collected[m][kind] = v;
      }
    });
    update((st) => {
      st.settings.monthly_rates = collected;
    }, "儲存每月匯率");
    toast("已儲存每月匯率", "ok");
  });

  // 新增月份覆寫
  bind("#rate-add", () => {
    const m = root.querySelector("#rate-new-month")?.value;
    if (!/^\d{4}-\d{2}$/.test(m || "")) {
      toast("請先選擇月份", "bad");
      return;
    }
    const s2 = getState();
    if (s2.settings.monthly_rates?.[m]) {
      toast(`${m} 已在列表中`, "");
      return;
    }
    update((st) => {
      if (!st.settings.monthly_rates) st.settings.monthly_rates = {};
      // 用一個 placeholder 數字讓那一列出現；使用者再填實際值（也可儲存 0 但會被 fallback）
      st.settings.monthly_rates[m] = { expense: st.settings.expense_rate };
    }, `新增 ${m} 匯率覆寫`);
    toast(`已加入 ${m}，請填入實際匯率後儲存`, "ok");
  });

  // 移除月份覆寫
  root.querySelectorAll("[data-rate-remove]").forEach((btn) => {
    btn.onclick = async () => {
      const m = btn.dataset.rateRemove;
      const ok = await confirmAsync({
        title: "移除月份匯率覆寫",
        body: `${m} 將改為使用預設匯率。已存在廣告段的鎖定匯率不受影響。`,
        okText: "移除", danger: true,
      });
      if (!ok) return;
      update((st) => {
        if (st.settings.monthly_rates) delete st.settings.monthly_rates[m];
      }, `移除 ${m} 匯率覆寫`);
      toast("已移除", "ok");
    };
  });

  bind("#btn-save-sync", () => {
    saveSyncFields(root);
    toast("已儲存", "ok");
  });

  bind("#btn-ping", async () => {
    saveSyncFields(root);
    setStatus("連線中…");
    try {
      const r = await pingSheets();
      setStatus(`✓ 連線成功（v${r.version || "?"}）`, "ok");
      toast("連線成功", "ok");
    } catch (e) { setStatus(`✗ ${e.message}`, "bad"); toast(`失敗：${e.message}`, "bad"); }
  });

  bind("#btn-push", async () => {
    saveSyncFields(root);
    const ok = await confirmAsync({
      title: "推到 Google Sheets",
      body: "將以本地資料覆寫雲端 Sheets 各分頁。雲端原內容會被覆蓋。",
      okText: "推送", danger: true,
    });
    if (!ok) return;
    setBusy(true);
    showProgress(true);
    setStatus("推送中…", "");
    showSyncBanner({ phase: "push", current: 0, total: 1, name: "啟動..." });
    try {
      const r = await pushToSheets(onProg);
      const doneMsg = `✓ 推送完成（${r.tables} 個分頁 / ${r.rowsWritten} 列）`;
      setStatus(doneMsg, "ok");
      if (progFill) progFill.style.width = "100%";
      if (progText) progText.textContent = `✓ 完成（${r.tables} 個分頁 / ${r.rowsWritten} 列）`;
      markSyncDone(doneMsg, "ok");
      toast("已推到 Sheets", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      if (progText) progText.textContent = `✗ ${e.message}`;
      markSyncDone(`✗ 推送失敗：${e.message}`, "bad");
      toast(`失敗：${e.message}`, "bad");
    } finally {
      setBusy(false);
      // 進度條保留 4 秒讓使用者看到結果，再隱藏
      setTimeout(() => showProgress(false), 4000);
    }
  });

  bind("#btn-pull", async () => {
    saveSyncFields(root);
    const ok = await confirmAsync({
      title: "從 Sheets 拉下來",
      body: "將以雲端資料覆寫本地全部。系統會先自動下載一份本地 JSON 備份。",
      okText: "拉取覆寫", danger: true,
    });
    if (!ok) return;
    setBusy(true);
    showProgress(true);
    setStatus("拉取中…", "");
    showSyncBanner({ phase: "pull", current: 0, total: 1, name: "啟動..." });
    try {
      const current = getState();
      const stamp = nowTaipeiStamp().replace(/[: ]/g, "-");
      downloadText(`buyads_backup_${stamp}.json`, JSON.stringify(current, null, 2), "application/json");

      const r = await pullFromSheets(onProg);
      const doneMsg = `✓ 拉取完成（${r.tables} 個分頁）`;
      setStatus(doneMsg, "ok");
      if (progFill) progFill.style.width = "100%";
      if (progText) progText.textContent = `✓ 完成（${r.tables} 個分頁）`;
      markSyncDone(doneMsg, "ok");
      toast("已從 Sheets 拉下來", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      if (progText) progText.textContent = `✗ ${e.message}`;
      markSyncDone(`✗ 拉取失敗：${e.message}`, "bad");
      toast(`失敗：${e.message}`, "bad");
    } finally {
      setBusy(false);
      setTimeout(() => showProgress(false), 4000);
    }
  });

  bind("#btn-export-json", () => {
    const s2 = getState();
    downloadText(`buyads_${s2.settings.current_month}.json`, JSON.stringify(s2, null, 2), "application/json");
    toast("已匯出 JSON", "ok");
  });

  bind("#btn-import-json", () => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = ".json";
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const data = JSON.parse(text);
        const ok = await confirmAsync({
          title: "匯入 JSON",
          body: "將覆寫本地所有資料（產品、廣告、成效…）。確定？",
          okText: "覆寫", danger: true,
        });
        if (!ok) return;
        replaceState(data, "匯入 JSON");
        toast("已匯入", "ok");
      } catch (e) { toast(`失敗：${e.message}`, "bad"); }
    };
    inp.click();
  });

  bind("#btn-reset", async () => {
    const ok = await confirmAsync({
      title: "重設全部資料",
      body: "將刪除所有本地廣告、成效、設定，並重設為預設產品。此動作不可逆。",
      okText: "重設", danger: true,
    });
    if (!ok) return;
    resetAll();
    toast("已重設", "ok");
  });

  const loadSample = async (month) => {
    const ok = await confirmAsync({
      title: `載入 ${month} 範例`,
      body: `將以 samples/buyads_${month}.json 覆寫本地所有資料。`,
      okText: "載入",
    });
    if (!ok) return;
    try {
      const res = await fetch(`samples/buyads_${month}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      replaceState(data, `載入 ${month} 範例`);
      toast(`已載入 ${month} 範例`, "ok");
    } catch (e) { toast(`載入失敗：${e.message}`, "bad"); }
  };
  bind("#btn-sample-apr", () => loadSample("2026-04"));
  bind("#btn-sample-may", () => loadSample("2026-05"));
}

function saveSyncFields(root) {
  update((st) => {
    st.settings.sheets_webapp_url = root.querySelector("#f-url").value.trim();
    st.settings.sheets_token = root.querySelector("#f-token").value.trim();
  });
}

async function loadCodeBlock(root) {
  const block = root.querySelector("#code-block");
  let code = "";
  try {
    const res = await fetch("apps-script/Code.gs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    code = await res.text();
  } catch (e) {
    block.textContent = `（無法載入 apps-script/Code.gs：${e.message}。請到專案資料夾直接開啟該檔複製）`;
    return;
  }
  block.textContent = code;

  const copy = async (btn, normalLabel) => {
    try {
      await navigator.clipboard.writeText(code);
      btn.textContent = "✓ 已複製";
      setTimeout(() => btn.textContent = normalLabel, 1500);
    } catch {
      toast("複製失敗，請手動選取代碼", "bad");
    }
  };

  const blockBtn = root.querySelector("#copy-code-block");
  if (blockBtn) blockBtn.onclick = (e) => { e.preventDefault(); copy(blockBtn, "📋 複製"); };
}

function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
