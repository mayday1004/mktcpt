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
import { METRICS, getExpenseRate, getIncomeRate, getReportVars } from "../schema.js";
import { evalFormula, validateFormula, REPORT_EXTRA_VARS } from "../lib/formula.js";
import { bindPerfImportButtons } from "./perf-import-ui.js";
import { scoreRecord } from "../domain/perf-adjust.js";
import { todayTaipei } from "../lib/dates.js";

let selectedProductId = null;
let reportFilter = "all";
let expandedRows = new Set();
let reportView = "by-product";  // "by-product" | "by-ad"

// 預設設定:依產品 id 給出合理的初始 hidden_metrics + custom_metrics。
// 使用者按「設定欄位」儲存後就以儲存值為準,即使是空陣列也不會 fallback。
const ALL_METRICS = [
  "不重複安裝數", "廠商安裝", "不重複首頁開啟數", "不重複活躍用戶數",
  "首儲訂單數", "首儲購買金額", "加總訂單數", "加總購買金額",
  "所有渠道不重複安裝數", "所有渠道不重複活躍用戶數",
  "總活躍用戶", "總下載點擊", "事件計數",
];

function hiddenExcept(visibleMetricNames, extra = []) {
  const hidden = ALL_METRICS.filter((m) => !visibleMetricNames.includes(m)).map((m) => `metric:${m}`);
  return [...hidden, ...extra];
}

function defaultConfigForProduct(product) {
  const APP_INSTALL_PIDS = new Set(["AV9", "av9_poquan", "JK", "jk_poquan"]);

  const presetA = () => ({
    hidden_metrics: hiddenExcept(["不重複安裝數", "不重複活躍用戶數"]),
    custom_metrics: [
      { id: uid("cm"), name: "活躍率", formula: "不重複活躍用戶數/不重複安裝數", show_as_percent: true },
      { id: uid("cm"), name: "排重安裝率", formula: "所有渠道不重複安裝數/不重複安裝數", show_as_percent: true },
      { id: uid("cm"), name: "首購率", formula: "首儲訂單數/不重複安裝數", show_as_percent: true },
      { id: uid("cm"), name: "首存ROI", formula: "首儲購買金額*收入匯率/花費", show_as_percent: false },
    ],
  });
  const presetB = () => ({
    hidden_metrics: hiddenExcept(["不重複安裝數", "總活躍用戶", "總下載點擊"]),
    custom_metrics: [
      { id: uid("cm"), name: "活躍用戶CPI", formula: "花費/總活躍用戶", show_as_percent: false },
    ],
  });
  const presetC = () => ({
    hidden_metrics: hiddenExcept(["事件計數"], ["fixed:group"]),
    custom_metrics: [],
  });

  // 三個明確 preset
  if (APP_INSTALL_PIDS.has(product.id)) return presetA();   // 排重安裝CPI 系列
  if (product.id === "HYC") return presetB();               // 下載CPC
  if (product.type === "island") return presetC();          // 小島(CPC)

  // 未列舉的新 APP 產品:fallback 到 Preset A
  return presetA();
}

// 取「該產品最終要使用的設定」:
//   - 已儲存(state.report_config[pid] 存在) → 用儲存值
//   - 未儲存 → 套 defaultConfigForProduct
function effectiveConfig(state, product) {
  const saved = state?.report_config?.[product.id];
  if (saved) {
    const defaults = defaultConfigForProduct(product);
    const hasSavedHidden =
      saved.hidden_metrics_user_configured === true ||
      (Array.isArray(saved.hidden_metrics) && saved.hidden_metrics.length > 0);
    const hasSavedCustom =
      saved.custom_metrics_user_configured === true ||
      (Array.isArray(saved.custom_metrics) && saved.custom_metrics.length > 0);
    return {
      hidden_metrics: hasSavedHidden ? saved.hidden_metrics : defaults.hidden_metrics,
      custom_metrics: hasSavedCustom ? saved.custom_metrics : defaults.custom_metrics,
    };
  }
  return defaultConfigForProduct(product);
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
      <div class="filter-row" style="margin-bottom:12px">
        <span class="ink-3" style="font-size:12px">瀏覽方式：</span>
        <button class="filter-chip ${reportView === "by-product" ? "active" : ""}" data-report-view="by-product">依產品瀏覽</button>
        <button class="filter-chip ${reportView === "by-ad" ? "active" : ""}" data-report-view="by-ad">依廣告瀏覽</button>
      </div>
      ${reportView === "by-ad"
        ? renderAdView(s)
        : `${renderProductPicker(s, selectedProductId)}${product ? renderProductReport(s, product) : ""}`}
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
  root.querySelectorAll("[data-report-filter]").forEach((el) => {
    el.onclick = () => {
      reportFilter = el.dataset.reportFilter;
      render(root);
    };
  });
  root.querySelectorAll("[data-report-expand]").forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.reportExpand;
      if (expandedRows.has(key)) expandedRows.delete(key);
      else expandedRows.add(key);
      render(root);
    };
  });
  root.querySelectorAll("[data-report-view]").forEach((el) => {
    el.onclick = () => {
      reportView = el.dataset.reportView;
      render(root);
    };
  });
}

function renderImportCard() {
  return `
    <div class="card perf-import-card">
      <div class="card-head">
        <h2>📥 成效資料匯入</h2>
        <div class="ink-3" style="font-size:12px">
          每週貼一週資料到 Sheets「成效輸入」分頁,例 4/26~5/2 一批、5/3~5/9 一批
        </div>
      </div>
      <div class="perf-import-body">
        <button id="btn-perf-import" style="background:#fff;color:var(--accent);border-color:var(--accent)">匯入本週成效</button>
        <div id="perf-import-status" class="sync-status"></div>
      </div>
      <div class="perf-import-note">
        匯入規則:依 (廣告代碼 × 產品 × 期間) 去重;不同週的資料會並存。依產品瀏覽會把最近 2 週指標相加,依廣告瀏覽會比對「上週 vs 上上週」。同一基本碼支援 dh 前綴與英文字尾變體的模糊比對。
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
  // 同 (ad_code, product_id) 多週只算一次 — 避免一次匯入兩週導致數量翻倍
  const seen = new Set();
  const out = {};
  for (const r of s.performance_data || []) {
    const key = `${r.product_id || ""}|${r.ad_code || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[r.product_id] = (out[r.product_id] || 0) + 1;
  }
  return out;
}

function renderProductReport(s, product) {
  const cfg = effectiveConfig(s, product);
  const hidden = new Set(cfg.hidden_metrics);
  const customMetrics = cfg.custom_metrics;
  const targets = product.performance_targets || [];

  // 同 (ad_code) 取最近 2 個 period_end,把 14 個指標相加成單列
  // period 顯示用「最早 start ~ 最晚 end」,公式以加總值計算
  const allForProduct = (s.performance_data || []).filter((r) => r.product_id === product.id);
  const byCode = new Map();
  for (const r of allForProduct) {
    const code = r.ad_code || "";
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(r);
  }
  const perfData = [];
  for (const [, recs] of byCode) {
    const sorted = recs.slice().sort((a, b) => (b.period_end || "").localeCompare(a.period_end || ""));
    const top = sorted.slice(0, 2);
    const latest = top[0];
    const agg = {
      ad_id: latest.ad_id,
      ad_code: latest.ad_code,
      ad_name: latest.ad_name,
      product_id: latest.product_id,
      group: latest.group,
    };
    for (const m of METRICS) {
      agg[m] = top.reduce((sum, r) => sum + (Number(r[m]) || 0), 0);
    }
    const starts = top.map((r) => r.period_start).filter(Boolean).sort();
    const ends = top.map((r) => r.period_end).filter(Boolean).sort();
    agg.period_start = starts[0] || "";
    agg.period_end = ends[ends.length - 1] || "";
    agg.__period_count = top.length;
    perfData.push(agg);
  }
  perfData.sort((a, b) => {
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
  const reportMetrics = METRICS.filter((m) => !isFixedSpendMetric(m));
  const visibleMetrics = reportMetrics.filter((m) => !hidden.has(`metric:${m}`));
  const hiddenMetrics = reportMetrics.filter((m) => hidden.has(`metric:${m}`));
  const visibleTargets = targets.filter((t) => !hidden.has(`target:${t.id}`));
  const visibleCustom = customMetrics;
  const groupVisible = !hidden.has("fixed:group");

  const totalCols = (groupVisible ? 1 : 0) + visibleMetrics.length + visibleTargets.length + visibleCustom.length;
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

  const rows = perfData.map((r) => buildReportRow(r, visibleMetrics, hiddenMetrics, visibleTargets, visibleCustom, reportVars));
  const failedRows = rows.filter((r) => r.status === "bad");
  const okRows = rows.filter((r) => r.status === "ok");
  const noConversionRows = rows.filter((r) => (Number(r.firstOrders) || 0) === 0 && (Number(r.purchaseOrders) || 0) === 0);
  const buyerRows = rows.filter((r) => (Number(r.firstOrders) || 0) > 0 || (Number(r.purchaseOrders) || 0) > 0);
  // 加權平均:對所有 row 的指標先加總,再套「主要目標」公式
  // 比起算術平均,這對 ratio 公式(如 CPC=花費/事件計數)更準 — 大廣告 vs 小廣告會按花費 / 事件數量比例自動加權
  // 例:兩支廣告,A 花 100 萬事件 50 萬(CPC 2)+ B 花 100 元事件 5(CPC 20)
  //   算術平均 = (2+20)/2 = 11(被 B 嚴重拉高)
  //   加權平均 = (1000000+100)/(500000+5) ≈ 2.0(才是真實的單位事件成本)
  const primaryTarget = visibleTargets[0];
  let avgPrimary = null;
  if (primaryTarget && rows.length > 0) {
    const aggVars = { ...reportVars };
    for (const m of METRICS) {
      aggVars[m] = rows.reduce((sum, r) => sum + (Number(r.raw[m]) || 0), 0);
    }
    try { avgPrimary = evalFormula(primaryTarget.formula, aggVars); } catch { avgPrimary = null; }
  }

  let filtered = rows;
  if (reportFilter === "bad") filtered = rows.filter((r) => r.status === "bad");
  else if (reportFilter === "buyer") filtered = buyerRows;
  else if (reportFilter === "dead") filtered = noConversionRows;
  else if (reportFilter === "spend") filtered = [...rows].sort((a, b) => (Number(b.spend) || 0) - (Number(a.spend) || 0));

  const primaryLabel = visibleTargets[0]?.name || "主要目標";
  const primaryGoal = visibleTargets[0] ? `${visibleTargets[0].direction === "lower_better" ? "≤" : "≥"} ${fmt2(visibleTargets[0].goal_value)}` : "未設定";
  const summary = `
    <div class="perf-summary-grid">
      <div class="perf-stat"><div class="k">本產品紀錄</div><div class="v">${rows.length}</div></div>
      <div class="perf-stat ok"><div class="k">達標</div><div class="v">${okRows.length}</div></div>
      <div class="perf-stat bad"><div class="k">未達標</div><div class="v">${failedRows.length}</div></div>
      <div class="perf-stat" title="加權平均 = 對所有紀錄的各指標先加總,再套主要目標公式。對 CPC/CPI 等率比公式比算術平均更準。"><div class="k">加權平均 ${esc(primaryLabel)}</div><div class="v">${avgPrimary != null && Number.isFinite(avgPrimary) ? fmt2(avgPrimary) : "—"}</div></div>
    </div>
  `;

  const filters = `
    <div class="filter-row" style="margin-bottom:12px">
      <span class="ink-3" style="font-size:12px">快速篩選：</span>
      <button class="filter-chip ${reportFilter === "all" ? "active" : ""}" data-report-filter="all">全部</button>
      <button class="filter-chip ${reportFilter === "bad" ? "active" : ""}" data-report-filter="bad">只看未達標</button>
      <button class="filter-chip ${reportFilter === "spend" ? "active" : ""}" data-report-filter="spend">花費高到低</button>
      <button class="filter-chip ${reportFilter === "buyer" ? "active" : ""}" data-report-filter="buyer">只看有購買</button>
      <button class="filter-chip ${reportFilter === "dead" ? "active" : ""}" data-report-filter="dead">無轉換</button>
    </div>
  `;

  const outsideColumnCount = visibleMetrics.length + visibleCustom.length;
  // 8 = 期間/代碼/廣告/分組/花費/主要目標/狀態/展開鈕。分組隱藏時 -1。
  const tableColspan = 8 + outsideColumnCount - (groupVisible ? 0 : 1);
  const metricHeaders = visibleMetrics.map((m) => `<th class="num" title="${esc(m)}">${esc(m)}</th>`).join("");
  const customHeaders = visibleCustom.map((m) => `<th class="num" title="${esc(m.formula)}">${esc(m.name)}</th>`).join("");
  const tableRows = filtered.map((row) => renderSummaryRow(row, primaryLabel, primaryGoal, tableColspan, groupVisible)).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>
          ${esc(product.name)}
          <span class="pill ${product.type}" style="margin-left:6px;font-size:10px">${product.type === "app" ? "APP" : "小島"}</span>
        </h2>
        <div class="ink-3" style="font-size:12px">
          ${filtered.length} / ${perfData.length} 筆紀錄
          ${settingsBtn}
        </div>
      </div>
      ${summary}
      ${filters}
      <div class="table-wrap" style="max-height:600px">
        <table class="perf-summary-table" style="font-size:12px">
          <thead>
            <tr>
              <th style="width:82px">期間</th>
              <th style="width:92px">代碼</th>
              <th>廣告</th>
              ${groupVisible ? `<th style="width:150px">分組</th>` : ""}
              <th class="num" style="width:100px">花費</th>
              ${metricHeaders}
              ${customHeaders}
              <th class="num" style="width:128px">${esc(primaryLabel)}</th>
              <th style="width:86px">狀態</th>
              <th style="width:70px"></th>
            </tr>
          </thead>
          <tbody>${tableRows || `<tr><td colspan="${tableColspan}" class="ink-3">此篩選沒有符合的紀錄</td></tr>`}</tbody>
        </table>
      </div>
    </div>
  `;
}

function buildReportRow(r, visibleMetrics, hiddenMetrics, visibleTargets, visibleCustom, reportVars) {
  const evalVars = { ...r, ...reportVars };
  const targetResults = visibleTargets.map((t) => {
    let actual = null;
    try { actual = evalFormula(t.formula, evalVars); } catch { actual = null; }
    const met = actual == null ? null : (t.direction === "lower_better" ? actual <= t.goal_value : actual >= t.goal_value);
    return { target: t, actual, met };
  });
  const customResults = visibleCustom.map((m) => {
    let actual = null;
    try { actual = evalFormula(m.formula, evalVars); } catch { actual = null; }
    return { metric: m, actual };
  });
  const primary = targetResults[0] || null;
  const failed = targetResults.some((t) => t.met === false);
  const passed = targetResults.length > 0 && targetResults.every((t) => t.met === true);
  const key = `${r.product_id || ""}|${r.period_start || ""}|${r.period_end || ""}|${r.ad_code || ""}|${r.ad_id || ""}`;
  return {
    key,
    raw: r,
    visibleMetrics,
    hiddenMetrics,
    targetResults,
    customResults,
    status: failed ? "bad" : passed ? "ok" : "none",
    primaryActual: primary?.actual,
    primaryMet: primary?.met,
    spend: pickMetric(r, ["花費", "广告花费", "廣告花費", "spend", "cost"]),
    summaryMetric: pickMetric(r, ["不重複安裝數", "排重安裝", "安裝", "install"]),
    firstOrders: pickMetric(r, ["首儲訂單數", "首储订单数", "首儲", "first_orders"]),
    purchaseOrders: pickMetric(r, ["加總訂單數", "加總訂單", "购买订单", "purchase_orders"]),
  };
}

function renderSummaryRow(row, primaryLabel, primaryGoal, tableColspan, groupVisible = true) {
  const r = row.raw;
  const expanded = expandedRows.has(row.key);
  const statusPill = row.status === "bad"
    ? `<span class="pill bad">未達</span>`
    : row.status === "ok"
      ? `<span class="pill ok">達標</span>`
      : `<span class="pill">未判定</span>`;
  const primaryCls = row.primaryMet === false ? "bad" : row.primaryMet === true ? "ok" : "ink-3";
  const metricCells = row.visibleMetrics.map((m) => `<td class="num">${fmt(r[m])}</td>`).join("");
  const customCells = row.customResults.map(({ metric, actual }) => `
    <td class="num" title="${esc(metric.formula)}">${actual != null ? fmtMetric(actual, metric.show_as_percent) : "—"}</td>
  `).join("");
  const main = `
    <tr class="${row.status === "bad" ? "perf-row-bad" : ""}">
      <td class="mono">${compactDateRange(r.period_start, r.period_end)}</td>
      <td class="mono">${esc(r.ad_code || "")}</td>
      <td>
        <strong>${esc(r.ad_name || "")}</strong>
        <div class="ink-3" style="font-size:11px">${row.status === "bad" ? "需要檢查投放或淘汰" : row.status === "ok" ? "成效在目標內" : "尚無完整目標判定"}</div>
      </td>
      ${groupVisible ? `<td>${esc(r.group || "")}</td>` : ""}
      <td class="num">${fmt(row.spend)}</td>
      ${metricCells}
      ${customCells}
      <td class="num ${primaryCls}"><strong>${row.primaryActual != null ? fmt2(row.primaryActual) : "—"}</strong><div class="ink-3" style="font-size:10px">${esc(primaryGoal)}</div></td>
      <td>${statusPill}</td>
      <td><button class="link-btn" data-report-expand="${esc(row.key)}">${expanded ? "收起" : "展開"}</button></td>
    </tr>
  `;
  const detail = expanded ? `
    <tr class="perf-detail-row">
      <td colspan="${tableColspan}">
        <div class="perf-detail-box">
          <div class="perf-detail-card">
            <h3>展開內建指標</h3>
            ${row.hiddenMetrics.map((m) => `<div class="perf-kv"><span>${esc(m)}</span><strong>${fmt(r[m])}</strong></div>`).join("") || `<div class="ink-3">沒有被收進展開的內建指標</div>`}
          </div>
          <div class="perf-detail-card">
            <h3>成效目標</h3>
            ${row.targetResults.map(({ target, actual, met }) => `
              <div class="perf-kv">
                <span title="${esc(target.formula)}">${esc(target.name)}</span>
                <strong class="${met === false ? "bad" : met === true ? "ok" : ""}">${actual != null ? fmt2(actual) : "—"} ${met === false ? "✗" : met === true ? "✓" : ""}</strong>
              </div>
            `).join("") || `<div class="ink-3">此產品尚未設定成效目標</div>`}
          </div>
          <div class="perf-detail-card">
            <h3>外顯自訂欄位公式</h3>
            ${row.customResults.map(({ metric }) => `<div class="perf-kv"><span>${esc(metric.name)}</span><strong title="${esc(metric.formula)}">${esc(metric.formula)}</strong></div>`).join("") || `<div class="ink-3">沒有自訂欄位</div>`}
          </div>
        </div>
      </td>
    </tr>
  ` : "";
  return main + detail;
}

function pickMetric(row, preferred) {
  for (const key of preferred) {
    if (row[key] != null && row[key] !== "") return row[key];
  }
  const keys = Object.keys(row || {});
  const loose = keys.find((key) =>
    preferred.some((name) => String(key).toLowerCase().includes(String(name).toLowerCase()))
  );
  return loose ? row[loose] : null;
}

function isFixedSpendMetric(metric) {
  return ["花費", "廣告花費", "广告花费", "spend", "cost"].includes(String(metric));
}

function compactDateRange(start, end) {
  const s = start ? String(start).slice(5).replace("-", "/") : "";
  const e = end ? String(end).slice(5).replace("-", "/") : "";
  if (s && e) return `${s}~${e}`;
  return s || e || "";
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
      內建指標勾選 = 顯示在外層，取消勾選 = 收到展開明細。自訂欄位一律顯示在外層。
      ${isFirstTime ? `<br><span style="color:var(--accent)">目前是「${product.type === "island" ? "小島" : "APP"}」預設顯示組合</span>` : ""}
    </p>

    <div class="settings-section" style="margin-bottom:14px">
      <h3 style="font-size:14px;margin:0 0 6px">基本欄位</h3>
      ${renderCheckbox("fixed:group", "廣告分組")}
      <div class="ink-3" style="font-size:11px">期間 / 廣告代碼 / 廣告名稱 / 花費 永遠顯示。</div>
    </div>

    <div class="settings-section" style="margin-bottom:14px">
      <h3 style="font-size:14px;margin:0 0 6px">內建指標（${METRICS.filter((m) => !isFixedSpendMetric(m)).length}）</h3>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0 16px">
        ${METRICS.filter((m) => !isFixedSpendMetric(m)).map((m) => renderCheckbox(`metric:${m}`, m)).join("")}
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
      return `
        <div style="display:flex;gap:8px;align-items:center;padding:6px 8px;background:#f7f9fc;border-radius:4px;flex-wrap:wrap">
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
        hidden_metrics: [...draft.hidden].filter((key) => !String(key).startsWith("custom:")),
        hidden_metrics_user_configured: true,
        custom_metrics_user_configured: true,
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

// ── 依廣告瀏覽（廣告 × 小島 CPC 對照表）─────────────────────────────

function renderAdView(state) {
  const periods = listUniquePeriods(state);
  if (periods.length === 0) {
    return `<div class="card"><p class="ink-3">尚無成效資料。請先匯入。</p></div>`;
  }
  // 命名沿用 thisWeek / lastWeek 但語意 = 「上週」/「上上週」(periods[0] 是 performance_data 中最新的週)
  const thisWeek = periods[0];      // 上週(最新一週資料)
  const lastWeek = periods[1] || null;  // 上上週

  const islandProducts = (state.products || []).filter((p) => p.type === "island");
  const appProducts = (state.products || []).filter((p) => p.type === "app");
  if (islandProducts.length === 0) {
    return `<div class="card"><p class="ink-3">尚無小島型產品。</p></div>`;
  }

  const codesMap = new Map();
  for (const ad of (state.ads || [])) {
    if (!ad.ad_code) continue;
    if (!codesMap.has(ad.ad_code)) codesMap.set(ad.ad_code, []);
    codesMap.get(ad.ad_code).push(ad);
  }

  const today = todayTaipei();
  const weekRange = naturalWeekRange(today);

  const rows = [];
  for (const [code, segs] of codesMap) {
    const overlapping = segs.filter((a) =>
      a.start_date && a.end_date &&
      a.start_date <= thisWeek.end && a.end_date > thisWeek.start
    );
    if (overlapping.length === 0) continue;
    const latest = overlapping.slice().sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""))[0];
    // 獨立採買(§2.3):同 ad_code 有多支獨立 Ad,各自 100% 不同產品。
    // 取最新一段當 rep,但 weights 用 overlapping 全部段的聯集,避免漏掉另一支獨立段的產品。
    const mergedWeights = {};
    for (const seg of overlapping) {
      for (const [pid, w] of Object.entries(seg.weights || {})) {
        const n = Number(w) || 0;
        if (n > 0) mergedWeights[pid] = Math.max(mergedWeights[pid] || 0, n);
      }
    }
    // 依廣告瀏覽是「廣告 × 小島 CPC 對照表」,純 APP 廣告不在這個視圖。
    // 判定「小島有沒有跑」兩條件任一成立就保留:
    //   (A) 任一 overlapping 段含小島 weight(共購或獨立採買且時間有 overlap)
    //   (B) 本週成效資料(performance_data)有小島產品的紀錄
    //       — 獨立採買時小島段可能跟 APP 段時間不完全對齊,光靠 weights 會漏
    const hasIslandSeg = islandProducts.some((p) => Number(mergedWeights[p.id]) > 0);
    const hasIslandPerf = !hasIslandSeg && islandProducts.some((p) =>
      (state.performance_data || []).some((r) =>
        r.ad_code === code &&
        r.product_id === p.id &&
        r.period_start === thisWeek.start && r.period_end === thisWeek.end
      )
    );
    if (!hasIslandSeg && !hasIslandPerf) continue;
    const rep = { ...latest, weights: mergedWeights };
    rows.push(buildAdRowData(state, code, rep, segs, thisWeek, lastWeek, islandProducts, appProducts, weekRange, today));
  }

  // eliminate-soon(預計淘汰) 和 expire(到期) 同優先序 — 不再因為「成效全爛」就拉前面,
  // 兩者共用一個「即將到期」分組,內部按 end_date 由近到遠排序。
  const order = { eliminate: 0, "eliminate-soon": 1, expire: 1, new: 2, gap: 3, none: 4 };
  rows.sort((a, b) => {
    const diff = (order[a.status.kind] ?? 5) - (order[b.status.kind] ?? 5);
    if (diff !== 0) return diff;
    if (a.status.kind === "eliminate-soon" || a.status.kind === "expire") {
      const ea = a.rep.end_date || "";
      const eb = b.rep.end_date || "";
      if (ea !== eb) return ea.localeCompare(eb);
    }
    return a.code.localeCompare(b.code);
  });

  const colStats = computeColumnStats(rows, islandProducts);
  return renderAdViewHtml(rows, islandProducts, colStats, thisWeek, lastWeek, weekRange);
}

function listUniquePeriods(state) {
  const seen = new Set();
  const out = [];
  for (const r of (state.performance_data || [])) {
    if (!r.period_start || !r.period_end) continue;
    const key = `${r.period_start}~${r.period_end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start: r.period_start, end: r.period_end });
  }
  out.sort((a, b) => b.end.localeCompare(a.end));
  return out;
}

function naturalWeekRange(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - dow);
  const start = formatUTC(dt);
  dt.setUTCDate(dt.getUTCDate() + 6);
  const end = formatUTC(dt);
  return { start, end };
}

function formatUTC(dt) {
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function buildAdRowData(state, code, rep, allSegs, thisWeek, lastWeek, islandProducts, appProducts, weekRange, today) {
  const reportVars = getReportVars(state);
  const adMatch = (rr) => rr.ad_code === code || rr.ad_id === rep.id || rr.ad_name === rep.ad_name;
  const thisRecs = (state.performance_data || []).filter((r) =>
    adMatch(r) && r.period_start === thisWeek.start && r.period_end === thisWeek.end
  );
  const lastRecs = lastWeek
    ? (state.performance_data || []).filter((r) =>
        adMatch(r) && r.period_start === lastWeek.start && r.period_end === lastWeek.end
      )
    : [];

  const islandCPCs = {};
  const islandCPCsLast = {};
  const islandSpend = {};
  const islandEvents = {};
  const islandSpendLast = {};
  const islandEventsLast = {};
  const islandRatios = {};  // 該產品在該行的 scoreRecord ratio(< 1 = 未達標)

  for (const p of islandProducts) {
    const r = thisRecs.find((x) => x.product_id === p.id);
    if (r) {
      const sp = Number(r["花費"]) || 0;
      const ev = Number(r["事件計數"]) || 0;
      islandSpend[p.id] = sp;
      islandEvents[p.id] = ev;
      if (sp > 0 && ev > 0) islandCPCs[p.id] = sp / ev;
      const targets = p.performance_targets || [];
      if (targets.length > 0) {
        const score = scoreRecord(r, targets, reportVars);
        if (score && score.ratio != null) islandRatios[p.id] = score.ratio;
      }
    }
    const r2 = lastRecs.find((x) => x.product_id === p.id);
    if (r2) {
      const sp = Number(r2["花費"]) || 0;
      const ev = Number(r2["事件計數"]) || 0;
      islandSpendLast[p.id] = sp;
      islandEventsLast[p.id] = ev;
      if (sp > 0 && ev > 0) islandCPCsLast[p.id] = sp / ev;
    }
  }

  const cpis = [];
  const rates = [];
  for (const p of appProducts) {
    if (!Number(rep.weights?.[p.id])) continue;
    const r = thisRecs.find((x) => x.product_id === p.id);
    if (!r) continue;
    const sp = Number(r["花費"]) || 0;
    const ins = Number(r["不重複安裝數"]) || 0;
    const fo = Number(r["首儲訂單數"]) || 0;
    if (ins <= 0) continue;
    const targets = p.performance_targets || [];
    const score = targets.length > 0 ? scoreRecord(r, targets, reportVars) : null;
    const ratio = score?.ratio ?? null;
    cpis.push({ pid: p.id, name: p.name, cpi: sp / ins, ratio });
    // 首購率只在有「首儲訂單數」概念的產品上算(HYC 沒有 → 排除)
    if (hasFirstPurchaseConcept(state, p)) {
      rates.push({ pid: p.id, name: p.name, rate: fo / ins, ratio });
    }
  }
  cpis.sort((a, b) => b.cpi - a.cpi);
  rates.sort((a, b) => a.rate - b.rate);
  const worstCPI = cpis[0] || null;
  const worstRate = rates[0] || null;

  const status = computeAdStatus(rep, allSegs, weekRange, today, thisRecs, appProducts, reportVars);

  return {
    code, rep,
    islandCPCs, islandCPCsLast,
    islandSpend, islandEvents, islandSpendLast, islandEventsLast,
    islandRatios,
    worstCPI, worstRate,
    cpiRatio: worstCPI?.ratio ?? null,
    rateRatio: worstRate?.ratio ?? null,
    status,
  };
}

function hasFirstPurchaseConcept(state, product) {
  const targets = product.performance_targets || [];
  const customs = state.report_config?.[product.id]?.custom_metrics || [];
  return [...targets, ...customs].some((t) =>
    String(t.formula || "").includes("首儲") ||
    String(t.name || "").includes("首購")
  );
}

function computeAdStatus(rep, allSegs, weekRange, today, thisRecs, appProducts, reportVars = {}) {
  const { start: ws, end: we } = weekRange;
  const endD = rep.end_date;
  const startD = rep.start_date;
  const hasLater = allSegs.some((a) => a.id !== rep.id && a.start_date && a.start_date >= endD);

  if (endD && endD >= ws && endD < today && !hasLater) {
    return { kind: "eliminate", label: "🔴 本週淘汰", tooltip: `已到期未續費(${endD})` };
  }
  const allBad = isAllBadPerf(thisRecs, appProducts, rep, reportVars);
  if (endD && endD >= today && endD <= we && allBad) {
    return { kind: "eliminate-soon", label: "❗ 本週預計淘汰", tooltip: `本週到期且 APP 成效全爛(${endD})` };
  }
  if (endD && endD >= today && endD <= we) {
    return { kind: "expire", label: "🏆 本週到期", tooltip: `到期日 ${endD}` };
  }
  if (startD && startD >= ws && startD <= we) {
    return { kind: "new", label: "➕ 新上", tooltip: `起始日 ${startD}` };
  }
  const sorted = allSegs.filter((a) => a.start_date && a.end_date)
    .slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 0; i < sorted.length - 1; i++) {
    const gapStart = sorted[i].end_date;
    const gapEnd = sorted[i + 1].start_date;
    if (gapStart < gapEnd && gapStart <= we && gapEnd > ws) {
      return { kind: "gap", label: "⚠ 送天數中", tooltip: `送天數空檔 ${gapStart} ~ ${gapEnd}` };
    }
  }
  return { kind: "none", label: "", tooltip: "" };
}

function isAllBadPerf(thisRecs, appProducts, rep, reportVars = {}) {
  const withWeight = appProducts.filter((p) => Number(rep.weights?.[p.id]) > 0);
  if (withWeight.length === 0) return false;
  for (const p of withWeight) {
    const r = thisRecs.find((x) => x.product_id === p.id);
    if (!r) return false;
    const targets = p.performance_targets || [];
    if (targets.length === 0) return false;
    const score = scoreRecord(r, targets, reportVars);
    if (!score || score.ratio == null) return false;
    if (score.ratio >= 0.3) return false;
  }
  return true;
}

function computeColumnStats(rows, islandProducts) {
  // 「未達標」(ratio < 1)的值範圍 → 在這範圍內漸變;達標(ratio >= 1 或無 ratio)的格直接白底
  const stats = {};
  for (const p of islandProducts) {
    const unmet = rows
      .filter((r) => {
        const v = r.islandCPCs[p.id];
        const ratio = r.islandRatios?.[p.id];
        return v != null && ratio != null && ratio < 1;
      })
      .map((r) => r.islandCPCs[p.id]);
    const sumSp = rows.reduce((s, r) => s + (r.islandSpend?.[p.id] || 0), 0);
    const sumEv = rows.reduce((s, r) => s + (r.islandEvents?.[p.id] || 0), 0);
    const sumSpL = rows.reduce((s, r) => s + (r.islandSpendLast?.[p.id] || 0), 0);
    const sumEvL = rows.reduce((s, r) => s + (r.islandEventsLast?.[p.id] || 0), 0);
    const avgCpc = sumEv > 0 ? sumSp / sumEv : null;
    const avgCpcLast = sumEvL > 0 ? sumSpL / sumEvL : null;
    const delta = (avgCpc != null && avgCpcLast != null) ? avgCpc - avgCpcLast : null;
    stats[p.id] = {
      unmetMin: unmet.length > 0 ? Math.min(...unmet) : 0,
      unmetMax: unmet.length > 0 ? Math.max(...unmet) : 0,
      avgCpc, avgCpcLast, delta,
    };
  }
  const cpiUnmet = rows.filter((r) => r.worstCPI && r.cpiRatio != null && r.cpiRatio < 1).map((r) => r.worstCPI.cpi);
  stats.__cpi = {
    unmetMin: cpiUnmet.length > 0 ? Math.min(...cpiUnmet) : 0,
    unmetMax: cpiUnmet.length > 0 ? Math.max(...cpiUnmet) : 0,
  };
  const rateUnmet = rows.filter((r) => r.worstRate && r.rateRatio != null && r.rateRatio < 1).map((r) => r.worstRate.rate);
  stats.__rate = {
    unmetMin: rateUnmet.length > 0 ? Math.min(...rateUnmet) : 0,
    unmetMax: rateUnmet.length > 0 ? Math.max(...rateUnmet) : 0,
  };
  return stats;
}

function bgRed(t) {
  const tt = Math.max(0, Math.min(1, t));
  const g = Math.round(255 - tt * 130);
  const b = Math.round(255 - tt * 130);
  return `background:rgb(255,${g},${b})`;
}

function cpcCellStyle(v, ratio, min, max) {
  if (v == null) return "";
  if (ratio == null || ratio >= 1) return "";  // 達標白底
  if (max === min) return bgRed(0.6);
  return bgRed((v - min) / (max - min));
}

function rateCellStyle(v, ratio, min, max) {
  if (v == null) return "";
  if (ratio == null || ratio >= 1) return "";  // 達標白底
  if (max === min) return bgRed(0.6);
  // 首購率越低越紅
  return bgRed(1 - (v - min) / (max - min));
}

function fmtCPC(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (Math.round(v * 100) / 100).toLocaleString();
}

function fmtCPCSigned(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(Math.round(v * 100) / 100).toLocaleString()}`;
}

function fmtRate(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(Math.round(v * 10000) / 100).toLocaleString()}%`;
}

function renderAdViewHtml(rows, islandProducts, colStats, thisWeek, lastWeek, weekRange) {
  if (rows.length === 0) {
    return `<div class="card"><p class="ink-3">上週 ${thisWeek.start}~${thisWeek.end} 沒有任何含小島權重的廣告。</p></div>`;
  }
  const lastNote = lastWeek
    ? `vs 上上週 ${lastWeek.start}~${lastWeek.end}`
    : `上上週無資料`;

  const islandHeaders = islandProducts.map((p) =>
    `<th class="num" title="${esc(p.name)} CPC = 花費/事件計數">${esc(p.name)}<br><span class="ink-3 mono" style="font-size:10px;font-weight:normal">${esc(p.id)}</span></th>`
  ).join("");

  const dataRows = rows.map((row) => {
    const islandCells = islandProducts.map((p) => {
      const v = row.islandCPCs[p.id];
      if (v == null) return `<td class="num"></td>`;
      const stat = colStats[p.id];
      const ratio = row.islandRatios?.[p.id];
      return `<td class="num" style="${cpcCellStyle(v, ratio, stat.unmetMin, stat.unmetMax)}">${fmtCPC(v)}</td>`;
    }).join("");

    const cpiCell = row.worstCPI
      ? `<td class="num" title="來源產品:${esc(row.worstCPI.name)}">${fmtCPC(row.worstCPI.cpi)} <span class="ink-3" style="font-size:10px">(${esc(row.worstCPI.pid)})</span></td>`
      : `<td class="num ink-3">—</td>`;

    const rateCell = row.worstRate
      ? `<td class="num" title="來源產品:${esc(row.worstRate.name)}">${fmtRate(row.worstRate.rate)} <span class="ink-3" style="font-size:10px">(${esc(row.worstRate.pid)})</span></td>`
      : `<td class="num ink-3">—</td>`;

    const statusCell = row.status.label
      ? `<td title="${esc(row.status.tooltip || "")}">${row.status.label}</td>`
      : `<td></td>`;

    return `
      <tr>
        <td><strong>${esc(row.rep.ad_name || "")}</strong></td>
        <td class="mono">${esc(row.code)}</td>
        ${islandCells}
        ${cpiCell}
        ${rateCell}
        ${statusCell}
      </tr>
    `;
  }).join("");

  const avgCells = islandProducts.map((p) => {
    const v = colStats[p.id].avgCpc;
    return `<td class="num"><strong>${v != null ? fmtCPC(v) : "—"}</strong></td>`;
  }).join("");

  const deltaCells = islandProducts.map((p) => {
    const d = colStats[p.id].delta;
    if (d == null) return `<td class="num ink-3">—</td>`;
    const cls = d > 0 ? "bad" : d < 0 ? "ok" : "";
    return `<td class="num ${cls}"><strong>${fmtCPCSigned(d)}</strong></td>`;
  }).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>依廣告瀏覽 <span class="ink-3" style="font-size:12px;font-weight:normal">廣告 × 小島 CPC 對照表</span></h2>
        <div class="ink-3" style="font-size:12px">
          上週 <strong>${thisWeek.start}~${thisWeek.end}</strong> · ${lastNote}<br>
          本週(自然週 Sun~Sat) <strong>${weekRange.start}~${weekRange.end}</strong>
        </div>
      </div>
      <div class="table-wrap" style="max-height:640px">
        <table class="perf-summary-table perf-ad-table" style="font-size:12px">
          <thead>
            <tr>
              <th style="width:160px">渠道名稱</th>
              <th style="width:90px">代碼</th>
              ${islandHeaders}
              <th class="num" style="width:130px">APP CPI<br><span class="ink-3" style="font-size:10px;font-weight:normal">花費/不重複安裝數</span></th>
              <th class="num" style="width:120px">首購率<br><span class="ink-3" style="font-size:10px;font-weight:normal">首儲訂單/裝機</span></th>
              <th style="width:130px">到期狀況</th>
            </tr>
          </thead>
          <tbody>${dataRows}</tbody>
          <tfoot>
            <tr style="background:#f7f9fc">
              <td colspan="2"><strong>平均 CPC（加權）</strong></td>
              ${avgCells}
              <td colspan="3" class="ink-3"></td>
            </tr>
            <tr style="background:#f7f9fc">
              <td colspan="2"><strong>成本漲幅（vs 上上週，絕對差）</strong></td>
              ${deltaCells}
              <td colspan="3" class="ink-3"></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}
