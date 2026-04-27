// 成效報表
//
// 功能：
//   1. 📥 成效資料匯入（從 Sheets「成效輸入」分頁拉本週資料）
//   2. 依產品瀏覽匯入後的成效資料 + 系統算的花費
//   3. 產品的 performance_targets（公式 + 目標值）自動展開為欄位
//   4. 每產品可以「篩選欄位」+「自訂計算欄位」，設定存在 state.report_config[pid]
//      自訂欄位例：首存ROI = 首儲購買金額 × 收入匯率 / 花費，公式可用變數：
//        - 14 個 METRICS（花費、不重複安裝數、…、事件計數）
//        - 收入匯率、支出匯率（取當月設定）

import { getState, update, uid } from "../state.js";
import { METRICS, getExpenseRate, getIncomeRate } from "../schema.js";
import { evalFormula, validateFormula, REPORT_EXTRA_VARS } from "../lib/formula.js";
import { bindPerfImportButtons } from "./perf-import-ui.js";

let selectedProductId = null;

// 預設隱藏：依產品類型給出合理的初始隱藏欄。使用者按「設定欄位」儲存後就以儲存值為準，
// 即使儲存的 hidden_metrics 是空陣列也不會 fallback 到預設（避免「我故意全顯示」被覆蓋）。
function defaultHiddenForType(type) {
  const APP_HIDE = ["廠商安裝", "總活躍用戶", "總下載點擊", "事件計數"];
  const ISLAND_HIDE = [
    "不重複安裝數", "廠商安裝", "不重複首頁開啟數", "不重複活躍用戶數",
    "首儲訂單數", "首儲購買金額", "加總訂單數", "加總購買金額",
    "所有渠道不重複安裝數", "所有渠道不重複活躍用戶數",
    "總活躍用戶", "總下載點擊", "事件計數",
  ];
  const list = type === "island" ? ISLAND_HIDE : APP_HIDE;
  return list.map((m) => `metric:${m}`);
}

// 取「該產品最終要使用的設定」：
//   - 已儲存（state.report_config[pid] 存在）→ 用儲存值
//   - 未儲存 → 套產品類型預設 hidden + 空 custom_metrics
function effectiveConfig(state, product) {
  const saved = state?.report_config?.[product.id];
  if (saved) {
    return {
      hidden_metrics: saved.hidden_metrics || [],
      custom_metrics: saved.custom_metrics || [],
    };
  }
  return {
    hidden_metrics: defaultHiddenForType(product.type),
    custom_metrics: [],
  };
}

export function render(root) {
  const s = getState();
  const products = s.products || [];
  if (!selectedProductId || !products.find((p) => p.id === selectedProductId)) {
    selectedProductId = products[0]?.id || null;
  }
  const product = products.find((p) => p.id === selectedProductId);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>成效報表</h1>
        <div class="desc">瀏覽匯入的成效資料；產品的目標公式自動成為新欄位。每個產品可獨立「篩選欄位」與新增「報表自訂計算欄位」（如 首存ROI = 首儲購買金額 × 收入匯率 / 花費）。</div>
      </div>
    </div>

    ${renderImportCard()}

    ${products.length === 0 ? `
      <div class="card"><p class="ink-2">請先建立產品。</p></div>
    ` : `
      ${renderProductPicker(s, selectedProductId)}
      ${product ? renderProductReport(s, product) : ""}
    `}
  `;

  bindPerfImportButtons(root, {
    onStatus: (msg, kind) => {
      const el = root.querySelector("#perf-import-status");
      if (el) {
        el.textContent = msg || "";
        el.className = `sync-status ${kind || ""}`;
      }
    },
  });

  root.querySelectorAll("[data-pick-pid]").forEach((el) => {
    el.onclick = () => {
      selectedProductId = el.dataset.pickPid;
      render(root);
    };
  });

  const btnSettings = root.querySelector("#btn-report-settings");
  if (btnSettings && product) {
    btnSettings.onclick = () => openColumnSettings(product, root);
  }
}

function renderImportCard() {
  return `
    <div class="card">
      <div class="card-head">
        <h2>📥 成效資料匯入</h2>
        <div class="ink-3" style="font-size:12px">
          先把本週成效資料貼到 Sheets「成效輸入」分頁，再按「附加本週成效」拉進來
        </div>
      </div>
      <div class="sheets-actions" style="border-top:0;padding-top:0">
        <button id="btn-perf-init" title="在 Sheets 建立空的成效輸入分頁">🗂️ 建立成效輸入分頁</button>
        <button id="btn-perf-import" class="primary">📥 附加本週成效</button>
        <div id="perf-import-status" class="sync-status"></div>
      </div>
      <div class="ink-3" style="font-size:12px;margin-top:8px">
        匯入規則：依 (廣告代碼 × 產品 × 期間) 去重；同一基本碼支援 dh 前綴與英文字尾變體 fuzzy 配對。
      </div>
    </div>
  `;
}

function renderProductPicker(s, sel) {
  const counts = countByProduct(s);
  const chips = s.products.map((p) => {
    const n = counts[p.id] || 0;
    const active = p.id === sel ? "active" : "";
    return `
      <button class="filter-chip ${active}" data-pick-pid="${esc(p.id)}">
        ${esc(p.name)}
        <span style="opacity:0.7;margin-left:4px">${n}</span>
      </button>
    `;
  }).join("");
  return `
    <div class="filter-row">
      <span class="ink-3" style="font-size:12px">產品：</span>
      ${chips}
    </div>
  `;
}

function countByProduct(s) {
  const out = {};
  for (const r of s.performance_data || []) {
    out[r.product_id] = (out[r.product_id] || 0) + 1;
  }
  return out;
}

function renderProductReport(s, product) {
  const cfg = effectiveConfig(s, product);
  const hidden = new Set(cfg.hidden_metrics);
  const customMetrics = cfg.custom_metrics;
  const targets = product.performance_targets || [];
  const showGroup = !hidden.has("fixed:group");

  const perfData = (s.performance_data || [])
    .filter((r) => r.product_id === product.id)
    .sort((a, b) => {
      const k1 = (a.period_end || "") + (a.ad_code || "");
      const k2 = (b.period_end || "") + (b.ad_code || "");
      return k1 < k2 ? 1 : k1 > k2 ? -1 : 0;  // 最新在上
    });

  // 報表額外變數：當月支出/收入匯率
  const ym = s.settings.current_month;
  const expenseRate = getExpenseRate(s, ym);
  const incomeRate = getIncomeRate(s, ym);
  const reportVars = { "收入匯率": incomeRate, "支出匯率": expenseRate };

  // 可見欄位（hidden set 控制）
  const visibleMetrics = METRICS.filter((m) => !hidden.has(`metric:${m}`));
  const visibleTargets = targets.filter((t) => !hidden.has(`target:${t.id}`));
  const visibleCustom = customMetrics.filter((m) => !hidden.has(`custom:${m.id}`));

  const totalCols = visibleMetrics.length + visibleTargets.length + visibleCustom.length;
  const settingsBtn = `<button id="btn-report-settings" class="link-btn" style="margin-left:8px;font-size:12px">⚙ 設定欄位（${totalCols} 個顯示中）</button>`;

  if (perfData.length === 0) {
    return `
      <div class="card">
        <div class="card-head">
          <h2>${esc(product.name)} <span class="pill ${product.type}" style="margin-left:6px;font-size:10px">${product.type === "app" ? "APP" : "小島"}</span></h2>
          <div>${settingsBtn}</div>
        </div>
        <p class="ink-3">此產品尚無成效資料。請先匯入或到 Sheets「成效輸入」貼資料。</p>
        ${targets.length === 0 && customMetrics.length === 0
          ? `<p class="ink-3" style="font-size:12px">此產品尚未設定成效目標或自訂報表欄位。可在「⚙ 設定欄位」新增、或到「產品」頁設定成效目標。</p>`
          : renderColumnsHint(targets, customMetrics)}
      </div>
    `;
  }

  const targetCols = visibleTargets.map((t) => {
    const dirArrow = t.direction === "lower_better" ? "↓" : "↑";
    return `<th class="num" title="${esc(t.formula)}">
      ${esc(t.name)}
      <div class="ink-3" style="font-size:10px;font-weight:400">${dirArrow} ${fmt2(t.goal_value)}</div>
    </th>`;
  }).join("");

  const customCols = visibleCustom.map((m) => `
    <th class="num" title="${esc(m.formula)}">
      ${esc(m.name)}
      <div class="ink-3" style="font-size:10px;font-weight:400">自訂${m.show_as_percent ? " · %" : ""}</div>
    </th>
  `).join("");

  const rows = perfData.map((r) => {
    const evalVars = { ...r, ...reportVars };
    const targetCells = visibleTargets.map((t) => {
      let actual = null;
      try { actual = evalFormula(t.formula, evalVars); } catch { actual = null; }
      if (actual == null) return `<td class="num ink-3">—</td>`;
      const met = t.direction === "lower_better" ? actual <= t.goal_value : actual >= t.goal_value;
      return `<td class="num ${met ? "ok" : "bad"}"><strong>${fmt2(actual)}</strong> ${met ? "✓" : "✗"}</td>`;
    }).join("");
    const customCells = visibleCustom.map((m) => {
      let actual = null;
      try { actual = evalFormula(m.formula, evalVars); } catch { actual = null; }
      if (actual == null) return `<td class="num ink-3">—</td>`;
      return `<td class="num"><strong>${fmtMetric(actual, m.show_as_percent)}</strong></td>`;
    }).join("");
    return `
      <tr>
        <td class="mono">${r.period_start || ""}</td>
        <td class="mono">${r.period_end || ""}</td>
        <td class="mono">${esc(r.ad_code || "")}</td>
        <td>${esc(r.ad_name || "")}</td>
        ${showGroup ? `<td>${esc(r.group || "")}</td>` : ""}
        ${visibleMetrics.map((m) => `<td class="num">${fmt(r[m])}</td>`).join("")}
        ${targetCells}
        ${customCells}
      </tr>
    `;
  }).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>
          ${esc(product.name)}
          <span class="pill ${product.type}" style="margin-left:6px;font-size:10px">${product.type === "app" ? "APP" : "小島"}</span>
        </h2>
        <div class="ink-3" style="font-size:12px">
          ${perfData.length} 筆紀錄
          ${settingsBtn}
        </div>
      </div>
      ${(targets.length || customMetrics.length) ? renderColumnsHint(targets, customMetrics) : ""}
      <div class="table-wrap" style="max-height:600px">
        <table style="font-size:12px">
          <thead>
            <tr>
              <th>資料起始日</th>
              <th>資料結束日</th>
              <th>廣告代碼</th>
              <th>廣告名稱</th>
              ${showGroup ? "<th>廣告分組</th>" : ""}
              ${visibleMetrics.map((m) => `<th class="num">${esc(m)}</th>`).join("")}
              ${targetCols}
              ${customCols}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderColumnsHint(targets, customMetrics) {
  const items = [];
  for (const t of targets) {
    const dir = t.direction === "lower_better" ? "越低越好" : "越高越好";
    items.push(`<li><strong>${esc(t.name)}</strong> = <span class="mono">${esc(t.formula)}</span>（目標 ${fmt2(t.goal_value)}，${dir}）</li>`);
  }
  for (const m of customMetrics) {
    items.push(`<li><strong>${esc(m.name)}</strong> = <span class="mono">${esc(m.formula)}</span> <span class="ink-3">(自訂)</span></li>`);
  }
  if (items.length === 0) return "";
  return `
    <div class="ink-2" style="font-size:12px;margin:8px 0;padding:8px 12px;background:#f7f9fc;border-radius:6px">
      <div style="margin-bottom:4px">公式欄位：</div>
      <ul style="margin:0;padding-left:20px">${items.join("")}</ul>
    </div>
  `;
}

// ── 設定欄位 modal ─────────────────────────────────────────────
function openColumnSettings(product, root) {
  const s = getState();
  const cfg = effectiveConfig(s, product);
  const targets = product.performance_targets || [];

  // 工作副本（modal 內編輯不直接動 state，按儲存才寫入）
  const draft = {
    hidden: new Set(cfg.hidden_metrics),
    customMetrics: cfg.custom_metrics.map((m) => ({ ...m })),
  };

  const allVarsHint = [...METRICS, ...REPORT_EXTRA_VARS].join("、");
  const isFirstTime = !s.report_config?.[product.id];

  const renderCheckbox = (key, label, sub) => `
    <label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:13px">
      <input type="checkbox" data-tk="${esc(key)}" ${draft.hidden.has(key) ? "" : "checked"} />
      <span>${esc(label)}${sub ? `<span class="ink-3" style="font-size:11px;margin-left:6px">${sub}</span>` : ""}</span>
    </label>
  `;

  const html = `
    <h2>${esc(product.name)} — 報表欄位設定</h2>
    <p class="ink-3" style="font-size:12px;margin:0 0 12px">
      勾選 = 顯示，取消勾選 = 隱藏。顯示偏好按產品分別存在本機。
      ${isFirstTime ? `<br><span style="color:var(--accent)">目前是「${product.type === "island" ? "小島" : "APP"}」預設顯示組合</span>` : ""}
    </p>

    <div class="settings-section" style="margin-bottom:14px">
      <h3 style="font-size:14px;margin:0 0 6px">基本欄位</h3>
      ${renderCheckbox("fixed:group", "廣告分組")}
      <div class="ink-3" style="font-size:11px">資料起始日 / 結束日 / 廣告代碼 / 廣告名稱 永遠顯示。</div>
    </div>

    <div class="settings-section" style="margin-bottom:14px">
      <h3 style="font-size:14px;margin:0 0 6px">內建指標（${METRICS.length}）</h3>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0 16px">
        ${METRICS.map((m) => renderCheckbox(`metric:${m}`, m)).join("")}
      </div>
    </div>

    ${targets.length > 0 ? `
      <div class="settings-section" style="margin-bottom:14px">
        <h3 style="font-size:14px;margin:0 0 6px">產品成效目標（${targets.length}）</h3>
        <div style="display:flex;flex-direction:column">
          ${targets.map((t) => renderCheckbox(`target:${t.id}`, t.name, `${t.formula} ${t.direction === "lower_better" ? "↓" : "↑"} ${t.goal_value}`)).join("")}
        </div>
        <div class="ink-3" style="font-size:11px;margin-top:4px">目標公式請至「產品」頁編輯，這裡只能控制顯示/隱藏。</div>
      </div>
    ` : ""}

    <div class="settings-section">
      <h3 style="font-size:14px;margin:0 0 6px">報表自訂計算欄位</h3>
      <div id="custom-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px"></div>
      <div style="padding:10px;border:1px dashed var(--line);border-radius:6px;background:#fafbfd">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">
          <div class="field" style="flex:1;min-width:120px">
            <label style="font-size:12px">欄位名稱</label>
            <input id="new-cm-name" placeholder="例：首存ROI" style="width:100%" />
          </div>
          <div class="field" style="flex:2;min-width:240px">
            <label style="font-size:12px">公式</label>
            <input id="new-cm-formula" placeholder="例：首儲購買金額 * 收入匯率 / 花費" style="width:100%;font-family:var(--mono)" />
          </div>
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;height:32px">
            <input type="checkbox" id="new-cm-pct" />
            <span>顯示百分比</span>
          </label>
          <button id="btn-add-cm" class="primary" style="height:32px">+ 新增</button>
        </div>
        <div class="ink-3" style="font-size:11px;margin-top:6px">
          可用變數：${esc(allVarsHint)}<br>
          <strong>顯示百分比</strong>勾起：值 × 100 加 % 顯示（例 0.025 → 2.5%）；不勾：兩位小數
        </div>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:16px">
      <button id="cm-cancel">取消</button>
      <button id="cm-save" class="primary">儲存</button>
    </div>
  `;

  const dlg = window.modal.open(html);

  // 渲染現有自訂欄位列
  const renderCustomList = () => {
    const host = dlg.querySelector("#custom-list");
    if (draft.customMetrics.length === 0) {
      host.innerHTML = `<div class="ink-3" style="font-size:12px">尚無自訂欄位。</div>`;
      return;
    }
    host.innerHTML = draft.customMetrics.map((m, i) => {
      const hiddenKey = `custom:${m.id}`;
      return `
        <div style="display:flex;gap:8px;align-items:center;padding:6px 8px;background:#f7f9fc;border-radius:4px;flex-wrap:wrap">
          <input type="checkbox" data-tk="${esc(hiddenKey)}" ${draft.hidden.has(hiddenKey) ? "" : "checked"} title="顯示/隱藏" />
          <input data-cm-i="${i}" data-cm-f="name" value="${esc(m.name)}" style="flex:1;min-width:100px" />
          <input data-cm-i="${i}" data-cm-f="formula" value="${esc(m.formula)}" style="flex:2;min-width:200px;font-family:var(--mono)" />
          <label style="display:flex;align-items:center;gap:4px;font-size:11px" title="勾起：值 × 100 + %">
            <input type="checkbox" data-cm-i="${i}" data-cm-f="show_as_percent" ${m.show_as_percent ? "checked" : ""} />
            <span>%</span>
          </label>
          <button data-cm-del="${i}" class="link-btn" style="color:var(--bad)">刪除</button>
        </div>
      `;
    }).join("");
    host.querySelectorAll("input[data-cm-i]").forEach((inp) => {
      const handler = () => {
        const idx = Number(inp.dataset.cmI);
        const field = inp.dataset.cmF;
        if (!draft.customMetrics[idx]) return;
        if (inp.type === "checkbox") {
          draft.customMetrics[idx][field] = inp.checked;
        } else {
          draft.customMetrics[idx][field] = inp.value;
        }
      };
      inp.oninput = handler;
      inp.onchange = handler;
    });
    host.querySelectorAll("[data-cm-del]").forEach((btn) => {
      btn.onclick = () => {
        const idx = Number(btn.dataset.cmDel);
        const removed = draft.customMetrics.splice(idx, 1)[0];
        if (removed) draft.hidden.delete(`custom:${removed.id}`);
        renderCustomList();
      };
    });
    // 重新綁 hidden checkbox（因為 innerHTML 重 render 了）
    rebindHiddenToggles();
  };

  // 綁所有 hidden 開關（包括 metric/target/custom）
  const rebindHiddenToggles = () => {
    dlg.querySelectorAll("input[type=checkbox][data-tk]").forEach((cb) => {
      cb.onchange = () => {
        const key = cb.dataset.tk;
        if (cb.checked) draft.hidden.delete(key);
        else draft.hidden.add(key);
      };
    });
  };
  rebindHiddenToggles();
  renderCustomList();

  dlg.querySelector("#btn-add-cm").onclick = () => {
    const name = dlg.querySelector("#new-cm-name").value.trim();
    const formula = dlg.querySelector("#new-cm-formula").value.trim();
    const showPct = dlg.querySelector("#new-cm-pct").checked;
    if (!name) { window.toast("請輸入欄位名稱", "bad"); return; }
    if (!formula) { window.toast("請輸入公式", "bad"); return; }
    if (draft.customMetrics.some((m) => m.name === name)) {
      window.toast(`已有同名欄位「${name}」`, "bad"); return;
    }
    if (targets.some((t) => t.name === name)) {
      window.toast(`與成效目標「${name}」同名，請改一個`, "bad"); return;
    }
    if (METRICS.includes(name)) {
      window.toast(`「${name}」是內建指標名稱，請改一個`, "bad"); return;
    }
    const err = validateFormula(formula);
    if (err) { window.toast(`公式錯誤：${err}`, "bad"); return; }
    draft.customMetrics.push({ id: uid("cm"), name, formula, show_as_percent: showPct });
    dlg.querySelector("#new-cm-name").value = "";
    dlg.querySelector("#new-cm-formula").value = "";
    dlg.querySelector("#new-cm-pct").checked = false;
    renderCustomList();
  };

  dlg.querySelector("#cm-cancel").onclick = () => window.modal.close();
  dlg.querySelector("#cm-save").onclick = () => {
    // 公式逐筆驗證
    for (const m of draft.customMetrics) {
      if (!m.name.trim()) { window.toast(`空白欄位名稱`, "bad"); return; }
      const err = validateFormula(m.formula);
      if (err) { window.toast(`「${m.name}」公式錯：${err}`, "bad"); return; }
    }
    update((st) => {
      if (!st.report_config) st.report_config = {};
      st.report_config[product.id] = {
        hidden_metrics: [...draft.hidden],
        custom_metrics: draft.customMetrics.map((m) => ({
          id: m.id,
          name: m.name.trim(),
          formula: m.formula.trim(),
          show_as_percent: !!m.show_as_percent,
        })),
      };
    }, "成效報表欄位設定");
    window.modal.close();
    window.toast("已儲存欄位設定", "ok");
    render(root);
  };
}

function fmt(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}

function fmt2(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return (Math.round(v * 100) / 100).toLocaleString();
}

// 自訂欄位專用：show_as_percent=true → 100×小數兩位 + "%"，否則 fmt2
function fmtMetric(n, asPercent) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (asPercent) return `${(Math.round(v * 10000) / 100).toLocaleString()}%`;
  return (Math.round(v * 100) / 100).toLocaleString();
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
