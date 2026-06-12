import { getState, update, replaceState, resetAll } from "../state.js";
import { pushToSheets, pullFromSheets, pingSheets } from "../io/sheets.js";
import { showSyncBanner, markSyncDone } from "../lib/sync-banner.js";
import { manualSync, resetSyncFailureState, resetSyncMeta } from "../io/sync.js";
import { clearConflicts } from "../io/conflict-store.js";
import { downloadText } from "../lib/csv.js";
import { getExpenseRate, getIncomeRate, getRateSource, getUsdtToCnyRate, getUsdToTwdRate } from "../schema.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import {
  DEPLOY_CONFIG_SOURCE,
  DEPLOY_SHEETS_TOKEN,
  DEPLOY_SHEETS_URL,
  DEPLOY_YOURLS_WAKE_TOKEN,
  DEPLOY_YOURLS_WAKE_URL,
  describeYourlsWakeUrlProblem,
  isDeployManaged,
  isYourlsWakeDeployManaged,
} from "../lib/deploy-config.js";

let activeSub = "sync";  // sync / rates / data / advanced

export function render(root) {
  const s = getState();
  const wakeDeployManaged = isYourlsWakeDeployManaged();
  const canSaveConnection = !isDeployManaged() || !wakeDeployManaged;
  const effectiveWakeUrl = wakeDeployManaged ? DEPLOY_YOURLS_WAKE_URL : (s.settings.yourls_wake_url || "");
  const wakeUrlProblem = describeYourlsWakeUrlProblem(effectiveWakeUrl);

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
        全量拉回前會自動下載一份本機 JSON 備份,避免誤覆蓋。報表(月度 / 每日花費 / 分組 / 攤提)為單向推送(規劃中)。
      </p>

      ${isDeployManaged() ? `
      <div class="callout" style="background:#eef7ff;border-left:3px solid #2a82c8;padding:10px 12px;border-radius:6px;margin:8px 0 14px;font-size:13px">
        🔒 <strong>URL / Token 由部署環境變數提供</strong>。<br>
        所有使用者共用同一份 Sheets,推送 / 拉取均可。<br>
        <span class="ink-3">目前來源:${escape(DEPLOY_CONFIG_SOURCE)}</span>
      </div>` : ""}

      <details class="collapse" ${(s.settings.sheets_webapp_url || isDeployManaged()) ? "" : "open"}>
        <summary>⚙️ 一次性設定步驟${(s.settings.sheets_webapp_url || isDeployManaged()) ? "(點開)" : "(首次使用先看這裡)"}</summary>
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
          <label>Apps Script Web App URL${isDeployManaged() ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-url" ${isDeployManaged() ? "readonly" : ""} value="${escape(isDeployManaged() ? DEPLOY_SHEETS_URL : s.settings.sheets_webapp_url)}" placeholder="https://script.google.com/macros/s/.../exec" />
        </div>
        <div class="field" style="flex:2">
          <label>共享密鑰 Token${isDeployManaged() ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-token" type="password" ${isDeployManaged() ? "readonly" : ""} value="${escape(isDeployManaged() ? DEPLOY_SHEETS_TOKEN : s.settings.sheets_token)}" placeholder="與 Apps Script 中 SECRET 相同" />
        </div>
        <div class="sheets-form-actions">
          ${canSaveConnection ? `<button id="btn-save-sync">儲存設定</button>` : ""}
          <button id="btn-ping">測試連線</button>
        </div>
      </div>

      <div class="sheets-form">
        <div class="field" style="flex:3">
          <label>yourls帕魯 Wake URL${wakeDeployManaged ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-yourls-wake-url" ${wakeDeployManaged ? "readonly" : ""} value="${escape(wakeDeployManaged ? DEPLOY_YOURLS_WAKE_URL : (s.settings.yourls_wake_url || ""))}" placeholder="/api/yourls-wake/notify" />
        </div>
        <div class="field" style="flex:2">
          <label>Wake Token${wakeDeployManaged ? " <span class=\"pill\">部署提供</span>" : ""}</label>
          <input id="f-yourls-wake-token" type="password" ${wakeDeployManaged ? "readonly" : ""} value="${escape(wakeDeployManaged ? DEPLOY_YOURLS_WAKE_TOKEN : (s.settings.yourls_wake_token || ""))}" placeholder="與 yourls帕魯 WAKE_TOKEN 相同" />
        </div>
      </div>
      <p class="ink-3" style="font-size:12px;margin-top:6px">
        Yourls 待辦批准成功後，系統會先同步 Google Sheets，再通知 Railway wake relay 喚醒 yourls帕魯。
      </p>
      ${wakeUrlProblem ? `
      <div class="callout" style="background:#fff6ed;border-left:3px solid #d97706;padding:10px 12px;border-radius:6px;margin:8px 0 14px;font-size:13px">
        ${escape(wakeUrlProblem)}
      </div>` : ""}

      <div class="sheets-actions">
        <button class="primary" id="btn-sync-now">🔄 立即同步</button>
        <div id="sync-status" class="sync-status"></div>
      </div>

      <div id="sync-progress" class="sync-progress hidden">
        <div class="sync-progress-bar"><div class="sync-progress-fill" id="sync-progress-fill"></div></div>
        <div class="sync-progress-text" id="sync-progress-text">準備中…</div>
      </div>
    </div>
    </div>

    <div class="${activeSub === "rates" ? "" : "hidden"}">
    <div class="card rates-default-card">
      <h2>預設匯率</h2>
      <p class="ink-3 rates-default-desc">「預設匯率」是當月份沒在下方表格設定時，系統預設拿來用的值；匯率變動頻率低的話可以全年沿用。</p>
      <div class="rates-default-grid">
        <div class="field"><label>支出 RMB→TWD（採買用）</label><input type="number" step="0.01" id="f-exp" value="${s.settings.expense_rate ?? 4.8}" /></div>
        <div class="field"><label>收入 RMB→TWD</label><input type="number" step="0.01" id="f-inc" value="${s.settings.income_rate ?? 4.6}" /></div>
        <div class="field"><label>USDT→RMB</label><input type="number" step="0.01" id="f-usdt" value="${s.settings.usdt_to_cny_rate ?? 7}" /></div>
        <div class="field"><label>USD→TWD（美元）</label><input type="number" step="0.01" id="f-usd" value="${s.settings.usd_to_twd_rate ?? 32}" /></div>
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
    <div class="card" style="border-left:3px solid var(--bad);background:#fff8f8">
      <h2>⚠️ 同步救援工具</h2>
      <p class="ink-2" style="font-size:13px;line-height:1.7">
        <strong style="color:var(--bad)">僅在資料壞掉、需要救援時使用。</strong>
        平時使用「Google Sheets 同步」分頁的「🔄 立即同步」即可,系統會自動 row-level 雙向同步。<br>
        下面兩顆按鈕是<strong>整份覆寫</strong>,會清掉對應端的所有改動。
      </p>
      <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:12px">
        <button class="danger" id="btn-pull-overwrite" title="從 Sheets 整份覆寫本地 — 會清掉本地未推送的改動">⬇️ 從 Sheets 強制覆寫本地</button>
        <button class="danger" id="btn-push-overwrite" title="把本地整份覆寫到 Sheets — 會清掉 Sheets 上別人的改動">☁️ 整份覆寫 Sheets</button>
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
  const curUsd = getUsdToTwdRate(s, ym);
  const curExpSrc = getRateSource(s, ym, "expense");
  const curIncSrc = getRateSource(s, ym, "income");
  const curUsdtSrc = getRateSource(s, ym, "usdt_to_cny");
  const curUsdSrc = getRateSource(s, ym, "usd_to_twd");
  const defUsdt = s.settings.usdt_to_cny_rate ?? 7;
  const defUsd = s.settings.usd_to_twd_rate ?? 32;

  const cur = monthlyRates[ym] || {};
  const otherMonths = Object.keys(monthlyRates)
    .filter((m) => m !== ym && monthlyRates[m] && (Number.isFinite(monthlyRates[m].expense) || Number.isFinite(monthlyRates[m].income) || Number.isFinite(monthlyRates[m].usdt_to_cny) || Number.isFinite(monthlyRates[m].usd_to_twd)))
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
          <div class="rate-cell">
            <label>USD→TWD</label>
            <input type="number" step="0.01" data-rate-month="${ym}" data-rate-kind="usd_to_twd" value="${cur.usd_to_twd ?? ""}" placeholder="${defUsd}" />
            <span class="rate-eff ${curUsdSrc}">→ <strong>${curUsd.toFixed(2)}</strong> ${curUsdSrc === "monthly" ? "(覆寫)" : "(預設)"}</span>
          </div>
        </div>

        ${otherMonths.map((m) => {
          const r = monthlyRates[m] || {};
          const expEff = getExpenseRate(s, m);
          const incEff = getIncomeRate(s, m);
          const usdtEff = getUsdtToCnyRate(s, m);
          const usdEff = getUsdToTwdRate(s, m);
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
              <div class="rate-cell">
                <label>USD→TWD</label>
                <input type="number" step="0.01" data-rate-month="${m}" data-rate-kind="usd_to_twd" value="${r.usd_to_twd ?? ""}" placeholder="${defUsd}" />
                <span class="rate-eff">→ <strong>${usdEff.toFixed(2)}</strong></span>
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
      st.settings.expense_rate = Number(root.querySelector("#f-exp").value) || 4.8;
      st.settings.income_rate = Number(root.querySelector("#f-inc").value) || 4.6;
      st.settings.usdt_to_cny_rate = Number(root.querySelector("#f-usdt").value) || 7;
      st.settings.usd_to_twd_rate = Number(root.querySelector("#f-usd").value) || 32;
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
    resetSyncFailureState();
    toast("已儲存", "ok");
  });

  bind("#btn-ping", async () => {
    saveSyncFields(root);
    setStatus("連線中…");
    try {
      const r = await pingSheets();
      resetSyncFailureState();
      setStatus(`✓ 連線成功（v${r.version || "?"}）`, "ok");
      toast("連線成功", "ok");
    } catch (e) { setStatus(`✗ ${e.message}`, "bad"); toast(`失敗：${e.message}`, "bad"); }
  });

  // 立即同步：跑 row-level LWW 同步（與背景自動同步同樣邏輯）
  bind("#btn-sync-now", async () => {
    saveSyncFields(root);
    setBusy(true);
    showProgress(true);
    setStatus("同步中…", "");
    try {
      await manualSync();
      setStatus(`✓ 同步完成`, "ok");
      if (progFill) progFill.style.width = "100%";
      if (progText) progText.textContent = `✓ 完成`;
      toast("同步完成", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      if (progText) progText.textContent = `✗ ${e.message}`;
      toast(`失敗：${e.message}`, "bad");
    } finally {
      setBusy(false);
      setTimeout(() => showProgress(false), 4000);
    }
  });

  // 整份覆寫 Sheets：救援用，會清掉 Sheets 上別人的改動。事前先 reset sync_meta 強制 push 全部。
  bind("#btn-push-overwrite", async () => {
    saveSyncFields(root);
    const ok = await confirmAsync({
      title: "⚠️ 整份覆寫 Sheets",
      body: "將以本地資料整份覆寫到 Sheets,會清掉 Sheets 上其他人未同步到本地的改動。\n\n這個動作不可逆,只在「需要救援/重置」時用。一般協作不需要 — 自動同步已經處理多人協作。",
      okText: "整份覆寫", danger: true,
      requireType: { word: "覆寫", label: "確定要做的話,在下方輸入「覆寫」二字解鎖按鈕" },
    });
    if (!ok) return;
    setBusy(true);
    showProgress(true);
    setStatus("整份覆寫中…", "");
    showSyncBanner({ phase: "push", current: 0, total: 1, name: "整份覆寫啟動..." });
    try {
      const r = await pushToSheets(onProg);
      const doneMsg = `✓ 整份覆寫完成（${r.tables} 個分頁 / ${r.rowsWritten} 列）`;
      setStatus(doneMsg, "ok");
      if (progFill) progFill.style.width = "100%";
      if (progText) progText.textContent = `✓ 完成`;
      // 整份 push 後清掉 sync_meta — 下次 sync 會重新從 sheets 拉所有 row 重建 meta
      resetSyncMeta();
      markSyncDone(doneMsg, "ok");
      toast("已整份覆寫 Sheets", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      if (progText) progText.textContent = `✗ ${e.message}`;
      markSyncDone(`✗ 整份覆寫失敗：${e.message}`, "bad");
      toast(`失敗：${e.message}`, "bad");
    } finally {
      setBusy(false);
      setTimeout(() => showProgress(false), 4000);
    }
  });

  // 從 Sheets 強制覆寫本地：救援用,把 Sheets 整份拉回來覆寫 local。事前先備份本地 JSON。
  bind("#btn-pull-overwrite", async () => {
    saveSyncFields(root);
    const ok = await confirmAsync({
      title: "從 Sheets 強制覆寫本地",
      body: "將以 Sheets 資料整份覆寫本地全部。會清掉本地未推送的改動。系統會先自動下載一份本地 JSON 備份。\n\n這個動作不可逆,只在「需要救援/重置」時用。",
      okText: "強制覆寫本地", danger: true,
    });
    if (!ok) return;
    setBusy(true);
    showProgress(true);
    setStatus("拉取中…", "");
    showSyncBanner({ phase: "pull", current: 0, total: 1, name: "強制覆寫本地啟動..." });
    try {
      const current = getState();
      const stamp = nowTaipeiStamp().replace(/[: ]/g, "-");
      downloadText(`buyads_backup_${stamp}.json`, JSON.stringify(current, null, 2), "application/json");

      const r = await pullFromSheets(onProg);
      const doneMsg = `✓ 強制覆寫完成（${r.tables} 個分頁）`;
      setStatus(doneMsg, "ok");
      if (progFill) progFill.style.width = "100%";
      if (progText) progText.textContent = `✓ 完成（${r.tables} 個分頁）`;
      // 強制覆寫後 sync_meta 失效，下次 sync 會重建
      resetSyncMeta();
      // 強制覆寫 = 已採用 server 版,清掉所有待處理衝突
      clearConflicts();
      markSyncDone(doneMsg, "ok");
      toast("已從 Sheets 強制覆寫本地", "ok");
    } catch (e) {
      setStatus(`✗ ${e.message}`, "bad");
      if (progText) progText.textContent = `✗ ${e.message}`;
      markSyncDone(`✗ 強制覆寫失敗：${e.message}`, "bad");
      toast(`失敗：${e.message}`, "bad");
    } finally {
      setBusy(false);
      setTimeout(() => showProgress(false), 4000);
    }
  });

  bind("#btn-export-json", () => {
    const s2 = getState();
    // 把裝置相關 settings 拿掉,避免別人匯入後本機 URL/token 被覆寫掉
    const { sheets_webapp_url, sheets_token, yourls_wake_url, yourls_wake_token, ...sharedSettings } = s2.settings || {};
    const exportData = { ...s2, settings: sharedSettings };
    downloadText(`buyads_${s2.settings.current_month}.json`, JSON.stringify(exportData, null, 2), "application/json");
    toast("已匯出 JSON(不含本機 Apps Script URL/token)", "ok");
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
        // 保留本機的 Apps Script URL/token,免得匯入別人的 JSON 後同步失效
        const localSettings = getState().settings || {};
        data.settings = data.settings || {};
        data.settings.sheets_webapp_url = localSettings.sheets_webapp_url || "";
        data.settings.sheets_token = localSettings.sheets_token || "";
        data.settings.yourls_wake_url = localSettings.yourls_wake_url || "";
        data.settings.yourls_wake_token = localSettings.yourls_wake_token || "";
        replaceState(data, "匯入 JSON");
        clearConflicts();
        toast("已匯入(本機 Apps Script URL/token 保留不變)", "ok");
      } catch (e) { toast(`失敗：${e.message}`, "bad"); }
    };
    inp.click();
  });

  bind("#btn-reset", async () => {
    const ok = await confirmAsync({
      title: "重設全部資料",
      body: "將清空所有本地產品、廣告、預算、成效、設定。下次同步會從 Sheets 拉回真資料。此動作不可逆。",
      okText: "重設", danger: true,
    });
    if (!ok) return;
    resetAll();
    toast("已重設", "ok");
  });
}

function saveSyncFields(root) {
  // deploy 模式下 URL/token 由 env 提供，input 為唯讀；不要寫回 state 蓋掉拉回的資料
  update((st) => {
    if (!isDeployManaged()) {
      st.settings.sheets_webapp_url = root.querySelector("#f-url").value.trim();
      st.settings.sheets_token = root.querySelector("#f-token").value.trim();
    }
    if (!isYourlsWakeDeployManaged()) {
      st.settings.yourls_wake_url = root.querySelector("#f-yourls-wake-url")?.value.trim() || "";
      st.settings.yourls_wake_token = root.querySelector("#f-yourls-wake-token")?.value.trim() || "";
    }
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
