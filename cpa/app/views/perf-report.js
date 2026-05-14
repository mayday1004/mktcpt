// 內部報表:TWD + 自訂欄目,可篩 / pivot / 匯出 CSV。
//
// 資料來源:
//   - 原始 9 欄(install_data)
//   - 系統計算:廠商安裝(rounded) / 適用單價 / 結算金額(RMB) / 花費(TWD,FIFO) / 適用匯率
//   - 自訂欄目(state.custom_metrics):公式引用任何欄位
//
// pivot:可選 group by 任何維度(渠道 / 產品 / 站長 / 日期 / 月份)
// 篩選:期間 / 站長 / 產品 / 渠道

import { getState, update, uid } from "../state.js";
import { todayTaipei } from "../lib/dates.js";
import { computeFIFO, getEffectivePrice } from "../domain/billing.js";
import { RAW_INSTALL_FIELDS } from "../schema.js";

const VIEW_KEY = "cpa_perf_report_view_v1";

// 可用欄位定義(label → key)
const RAW_METRICS = RAW_INSTALL_FIELDS.slice();       // 9 個原始指標
const DERIVED_METRICS = ["廠商安裝(計費)", "適用單價", "結算金額_RMB", "適用匯率", "花費_TWD"];
const ALL_METRICS = [...RAW_METRICS, ...DERIVED_METRICS];

const DIMENSIONS = {
  channel: "渠道",
  product: "產品",
  publisher: "站長",
  date: "日期",
  month: "月份",
};

function loadView() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveView(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {}
}

export function render(root) {
  const s = getState();
  const view = Object.assign({
    from: defaultFrom(),
    to: todayTaipei(),
    publisher_id: "",   // 空 = 全部
    product_id: "",
    channel_id: "",
    group_by: "channel",  // 預設按渠道
    hidden_metrics: [],   // 隱藏的指標 key
  }, loadView());
  saveView(view);

  const publishers = s.publishers || [];
  const products = s.products || [];
  const channels = s.channels || [];

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>📈 內部報表</h1>
        <div class="desc">廣告主用 · TWD 走 FIFO 匯率消耗;自訂欄目走 state.custom_metrics</div>
      </div>
      <div class="view-actions">
        <button id="btn-metrics">⚙️ 自訂欄目</button>
        <button class="primary" id="btn-csv">⬇ 匯出 CSV</button>
      </div>
    </div>

    <div class="card">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end">
        <div class="field"><label>起始日</label><input id="f-from" type="date" value="${esc(view.from)}" /></div>
        <div class="field"><label>結束日</label><input id="f-to" type="date" value="${esc(view.to)}" /></div>
        <div class="field">
          <label>站長</label>
          <select id="f-pub">
            <option value="">全部</option>
            ${publishers.map((p) => `<option value="${esc(p.id)}" ${p.id === view.publisher_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>產品</label>
          <select id="f-prod">
            <option value="">全部</option>
            ${products.map((p) => `<option value="${esc(p.id)}" ${p.id === view.product_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>渠道</label>
          <select id="f-ch">
            <option value="">全部</option>
            ${channels.map((c) => `<option value="${esc(c.id)}" ${c.id === view.channel_id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>分組</label>
          <select id="f-group">
            ${Object.entries(DIMENSIONS).map(([k, l]) => `<option value="${k}" ${k === view.group_by ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
        </div>
      </div>

      <details style="margin-top:8px">
        <summary style="cursor:pointer;font-size:13px">隱藏 / 顯示欄位</summary>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;font-size:12px">
          ${ALL_METRICS.concat((s.custom_metrics || []).map((m) => m.name)).map((label) => `
            <label style="padding:2px 6px;background:${view.hidden_metrics.includes(label) ? "#eee" : "#e3f2fd"};border-radius:4px;cursor:pointer">
              <input type="checkbox" data-toggle-metric="${esc(label)}" ${!view.hidden_metrics.includes(label) ? "checked" : ""} style="margin-right:4px" />
              ${esc(label)}
            </label>
          `).join("")}
        </div>
      </details>
    </div>

    <div id="report" class="mt-8"></div>
  `;

  const q = (sel) => root.querySelector(sel);
  const updateView = (patch) => {
    Object.assign(view, patch);
    saveView(view);
    renderReport(root, view);
  };

  q("#f-from")?.addEventListener("change", () => updateView({ from: q("#f-from").value }));
  q("#f-to")?.addEventListener("change", () => updateView({ to: q("#f-to").value }));
  q("#f-pub")?.addEventListener("change", () => updateView({ publisher_id: q("#f-pub").value }));
  q("#f-prod")?.addEventListener("change", () => updateView({ product_id: q("#f-prod").value }));
  q("#f-ch")?.addEventListener("change", () => updateView({ channel_id: q("#f-ch").value }));
  q("#f-group")?.addEventListener("change", () => updateView({ group_by: q("#f-group").value }));

  root.querySelectorAll("[data-toggle-metric]").forEach((el) => {
    el.addEventListener("change", () => {
      const label = el.dataset.toggleMetric;
      const hidden = new Set(view.hidden_metrics);
      if (el.checked) hidden.delete(label);
      else hidden.add(label);
      view.hidden_metrics = [...hidden];
      saveView(view);
      renderReport(root, view);
    });
  });

  q("#btn-metrics")?.addEventListener("click", () => openCustomMetricsEditor(root));
  q("#btn-csv")?.addEventListener("click", () => exportCsv(view));

  renderReport(root, view);
}

function defaultFrom() {
  const t = todayTaipei();
  const [y, m] = t.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function renderReport(root, view) {
  const panel = root.querySelector("#report");
  if (!panel) return;
  const rows = computeRows(view);
  if (rows.length === 0) {
    panel.innerHTML = `<div class="card"><p class="ink-2" style="margin:0">區間內無資料</p></div>`;
    return;
  }

  const s = getState();
  const customMetrics = s.custom_metrics || [];
  const visibleMetrics = ALL_METRICS.concat(customMetrics.map((m) => m.name))
    .filter((m) => !view.hidden_metrics.includes(m));

  // 算總計列
  const totals = computeTotals(rows, visibleMetrics, customMetrics);

  const groupLabel = DIMENSIONS[view.group_by] || view.group_by;

  panel.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">${esc(groupLabel)} pivot(${rows.length} 列)</h2>
      <div class="table-wrap" style="max-height:600px;overflow:auto">
        <table>
          <thead>
            <tr>
              <th style="position:sticky;left:0;background:#fff;z-index:2">${esc(groupLabel)}</th>
              ${visibleMetrics.map((m) => `<th class="num">${esc(m)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td style="position:sticky;left:0;background:#fff"><strong>${esc(r.label)}</strong></td>
                ${visibleMetrics.map((m) => `<td class="num">${formatMetric(m, r.metrics[m], customMetrics)}</td>`).join("")}
              </tr>
            `).join("")}
            <tr style="font-weight:700;background:#f7f7f7;position:sticky;bottom:0">
              <td style="position:sticky;left:0;background:#f7f7f7">合計</td>
              ${visibleMetrics.map((m) => `<td class="num">${formatMetric(m, totals[m], customMetrics)}</td>`).join("")}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// 計算每筆 install_data 的所有欄位 → 依 group_by 彙總成 rows
function computeRows(view) {
  const s = getState();
  const channels = s.channels || [];
  const products = s.products || [];
  const publishers = s.publishers || [];
  const chById = Object.fromEntries(channels.map((c) => [c.id, c]));
  const prById = Object.fromEntries(products.map((p) => [p.id, p]));
  const pubById = Object.fromEntries(publishers.map((p) => [p.id, p]));

  // 先用 computeFIFO 算各站長的日花費(TWD),建一個 quick lookup
  const twdLookup = new Map();  // key: date::channel::product → twd
  const pubsInvolved = new Set();
  for (const d of s.install_data || []) {
    const ch = chById[d.channel_id];
    if (ch) pubsInvolved.add(ch.publisher_id);
  }
  for (const pubId of pubsInvolved) {
    if (view.publisher_id && pubId !== view.publisher_id) continue;
    const fifo = computeFIFO(s, { publisherId: pubId, asOf: view.to });
    for (const d of fifo.dailyCosts) {
      twdLookup.set(`${d.date}::${d.channel_id}::${d.product_id}`, d.twd_cost);
    }
  }

  const groups = new Map();
  for (const d of s.install_data || []) {
    if (view.from && d.date < view.from) continue;
    if (view.to && d.date > view.to) continue;
    const ch = chById[d.channel_id];
    const pr = prById[d.product_id];
    if (!ch || !pr) continue;
    if (view.publisher_id && ch.publisher_id !== view.publisher_id) continue;
    if (view.product_id && d.product_id !== view.product_id) continue;
    if (view.channel_id && d.channel_id !== view.channel_id) continue;

    const installs = Math.round(d["廠商安裝"] || 0);
    const price = getEffectivePrice(s, d.channel_id);
    const cpaOn = pr.cpa_enabled !== false;
    const settledRmb = cpaOn ? installs * price : 0;
    const twd = twdLookup.get(`${d.date}::${d.channel_id}::${d.product_id}`) || 0;
    const rate = settledRmb > 0 ? twd / settledRmb : 0;

    const groupKey = buildGroupKey(view.group_by, d, ch, pr, pubById);
    const groupLabel = buildGroupLabel(view.group_by, d, ch, pr, pubById);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { key: groupKey, label: groupLabel, metrics: zeroMetrics() });
    }
    const m = groups.get(groupKey).metrics;
    for (const f of RAW_METRICS) m[f] = (m[f] || 0) + Number(d[f] || 0);
    m["廠商安裝(計費)"] = (m["廠商安裝(計費)"] || 0) + installs;
    m["結算金額_RMB"] = (m["結算金額_RMB"] || 0) + settledRmb;
    m["花費_TWD"] = (m["花費_TWD"] || 0) + twd;
    // 適用單價 / 匯率為加權平均(用 sum + count 暫存,渲染時除)
    m.__sum_price = (m.__sum_price || 0) + price * installs;
    m.__sum_rate = (m.__sum_rate || 0) + (rate || 0) * installs;
    m.__count = (m.__count || 0) + installs;
  }

  const customMetrics = s.custom_metrics || [];
  return Array.from(groups.values())
    .map((r) => {
      const m = r.metrics;
      m["適用單價"] = m.__count > 0 ? m.__sum_price / m.__count : 0;
      m["適用匯率"] = m.__count > 0 ? m.__sum_rate / m.__count : 0;
      // 計算自訂欄目
      for (const cm of customMetrics) {
        try {
          m[cm.name] = evalFormula(cm.formula, m);
        } catch {
          m[cm.name] = null;
        }
      }
      delete m.__sum_price; delete m.__sum_rate; delete m.__count;
      return r;
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function zeroMetrics() {
  const m = {};
  for (const f of RAW_METRICS) m[f] = 0;
  for (const f of DERIVED_METRICS) m[f] = 0;
  return m;
}

function buildGroupKey(by, d, ch, pr, pubById) {
  if (by === "channel") return ch.id;
  if (by === "product") return pr.id;
  if (by === "publisher") return ch.publisher_id;
  if (by === "date") return d.date;
  if (by === "month") return d.date.slice(0, 7);
  return "all";
}
function buildGroupLabel(by, d, ch, pr, pubById) {
  if (by === "channel") return ch.name;
  if (by === "product") return pr.name;
  if (by === "publisher") return pubById[ch.publisher_id]?.name || "?";
  if (by === "date") return d.date;
  if (by === "month") return d.date.slice(0, 7);
  return "全部";
}

function computeTotals(rows, visibleMetrics, customMetrics) {
  const totals = {};
  // 簡單加總 raw + derived(花費 / 結算 / 安裝),適用單價 / 匯率取加權平均
  for (const m of visibleMetrics) totals[m] = 0;
  let totalInstalls = 0;
  let totalSettled = 0;
  let totalTwd = 0;
  for (const r of rows) {
    for (const m of visibleMetrics) {
      if (m === "適用單價" || m === "適用匯率") continue;
      if (customMetrics.find((c) => c.name === m)) continue;
      totals[m] += Number(r.metrics[m] || 0);
    }
    totalInstalls += Number(r.metrics["廠商安裝(計費)"] || 0);
    totalSettled += Number(r.metrics["結算金額_RMB"] || 0);
    totalTwd += Number(r.metrics["花費_TWD"] || 0);
  }
  if (visibleMetrics.includes("適用單價")) {
    totals["適用單價"] = totalInstalls > 0 ? totalSettled / totalInstalls : 0;
  }
  if (visibleMetrics.includes("適用匯率")) {
    totals["適用匯率"] = totalSettled > 0 ? totalTwd / totalSettled : 0;
  }
  // 自訂欄目 — 用 totals 自身的值再算一次
  for (const cm of customMetrics) {
    if (!visibleMetrics.includes(cm.name)) continue;
    try {
      totals[cm.name] = evalFormula(cm.formula, totals);
    } catch {
      totals[cm.name] = null;
    }
  }
  return totals;
}

// 公式 eval:把 metric 名稱替換成數值,然後 Function 計算
// 變數名:中文可,但 JS identifier 不允許 → 改用對應表替換
function evalFormula(formula, metrics) {
  if (!formula) return null;
  // 排序長 keys 在前避免短的先 match(例:廠商安裝 vs 廠商安裝(計費))
  const keys = Object.keys(metrics).sort((a, b) => b.length - a.length);
  let expr = formula;
  for (const k of keys) {
    const v = Number(metrics[k] || 0);
    // 簡單字串替換(中文 + 英文混合 key)
    expr = expr.split(k).join(`(${v})`);
  }
  // 移除常見的 RMB / TWD / % 等單位字
  expr = expr.replace(/RMB|TWD|％|%|台幣|人民幣/gi, "");
  // 防呆:只允許數字 + 運算符 + 括號 + 空白
  if (!/^[\d+\-*/().\s]*$/.test(expr)) {
    throw new Error(`公式含未知變數:${formula}`);
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return (${expr || 0})`)();
}

function formatMetric(name, value, customMetrics) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  const cm = customMetrics.find((m) => m.name === name);
  if (cm?.show_as_percent) return `${(n * 100).toFixed(2)}%`;
  if (name === "花費_TWD") return `NT$${Math.round(n).toLocaleString("zh-TW")}`;
  if (name === "結算金額_RMB") return `¥${n.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (name === "適用單價") return n.toFixed(2);
  if (name === "適用匯率") return n.toFixed(3);
  if (Number.isInteger(n)) return n.toLocaleString("zh-TW");
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
}

// ── 自訂欄目編輯器 ──────────────────────────────────────
function openCustomMetricsEditor(root) {
  const s = getState();
  const list = s.custom_metrics || [];
  const html = `
    <h2>⚙️ 自訂欄目</h2>
    <p class="ink-3" style="font-size:12px;margin-bottom:8px">
      公式可引用任何指標名稱,例:
      <code>花費_TWD / 不重複安裝數</code>(CPI)、
      <code>首儲金額 * 4.6 / 花費_TWD</code>(ROI)
    </p>
    ${list.length === 0 ? `<p class="ink-2" style="margin:0">尚無自訂欄目</p>` : `
      <div class="table-wrap">
        <table>
          <thead><tr><th>名稱</th><th>公式</th><th>百分比</th><th></th></tr></thead>
          <tbody>
            ${list.map((m) => `
              <tr>
                <td>${esc(m.name)}</td>
                <td><code>${esc(m.formula)}</code></td>
                <td>${m.show_as_percent ? "✓" : ""}</td>
                <td><button class="danger" data-del-metric="${esc(m.id)}">刪除</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `}
    <h3 style="margin:14px 0 6px;font-size:14px">＋ 新增欄目</h3>
    <div class="field"><label>名稱 *</label><input id="cm-name" placeholder="例:CPI" /></div>
    <div class="field mt-8"><label>公式 *</label><input id="cm-formula" placeholder="例:花費_TWD / 不重複安裝數" /></div>
    <div class="field mt-8"><label><input id="cm-percent" type="checkbox" /> 顯示成百分比</label></div>
    <div class="modal-actions">
      <button id="btn-add-metric" class="primary">＋ 新增</button>
      <button id="btn-close-cm">完成</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  q("#btn-close-cm").onclick = () => { window.modal.close(); render(root); };

  q("#btn-add-metric").onclick = () => {
    const name = q("#cm-name").value.trim();
    const formula = q("#cm-formula").value.trim();
    const pct = q("#cm-percent").checked;
    if (!name) { window.toast("名稱必填", "bad"); return; }
    if (!formula) { window.toast("公式必填", "bad"); return; }
    update((st) => {
      st.custom_metrics = st.custom_metrics || [];
      st.custom_metrics.push({ id: uid("cm"), name, formula, show_as_percent: pct });
    }, "新增自訂欄目");
    window.toast("✓ 已新增", "ok");
    window.modal.close();
    openCustomMetricsEditor(root);  // 重開
  };

  dlg.querySelectorAll("[data-del-metric]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.delMetric;
      const m = (s.custom_metrics || []).find((x) => x.id === id);
      if (!m) return;
      const ok = await window.confirmAsync({
        title: `刪除「${m.name}」?`,
        body: `公式:${m.formula}`,
        okText: "刪除",
        danger: true,
      });
      if (!ok) return;
      update((st) => { st.custom_metrics = st.custom_metrics.filter((x) => x.id !== id); }, "刪除自訂欄目");
      window.toast("已刪除", "ok");
      window.modal.close();
      openCustomMetricsEditor(root);
    };
  });
}

// ── CSV 匯出 ─────────────────────────────────────────
function exportCsv(view) {
  const rows = computeRows(view);
  if (rows.length === 0) {
    window.toast("無資料可匯出", "bad");
    return;
  }
  const s = getState();
  const customMetrics = s.custom_metrics || [];
  const allCols = ALL_METRICS.concat(customMetrics.map((m) => m.name))
    .filter((m) => !view.hidden_metrics.includes(m));

  const groupLabel = DIMENSIONS[view.group_by] || view.group_by;
  const headers = [groupLabel, ...allCols];
  const csvRows = [headers.join(",")];
  for (const r of rows) {
    const row = [csvField(r.label), ...allCols.map((c) => csvField(formatMetricCsv(c, r.metrics[c], customMetrics)))];
    csvRows.push(row.join(","));
  }

  const blob = new Blob(["﻿" + csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const fname = `CPA_report_${view.group_by}_${view.from}_${view.to}.csv`;
  a.href = url;
  a.download = fname;
  a.click();
  URL.revokeObjectURL(url);
  window.toast(`✓ 匯出 ${rows.length} 列 → ${fname}`, "ok");
}

function csvField(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function formatMetricCsv(name, value, customMetrics) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  const cm = customMetrics.find((m) => m.name === name);
  if (cm?.show_as_percent) return (Number(value) * 100).toFixed(2);
  return Number(value);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
