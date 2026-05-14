// 對帳報表:站長 × 月份的 RMB 流水帳,給站長對帳用。
// 全 RMB,不顯示 TWD;後結算站長剩餘可為負(代表應付給站長的金額)。

import { getState } from "../state.js";
import { aggregateByPublisherMonth } from "../domain/billing.js";

const VIEW_KEY = "cpa_settlement_view_v1";

function loadViewState() {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveViewState(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {}
}

export function render(root) {
  const s = getState();
  const publishers = s.publishers || [];
  const view = loadViewState();
  const currentMonth = s.settings?.current_month || nowYm();
  if (!view.month) view.month = currentMonth;
  if (!view.publisher_id || !publishers.find((p) => p.id === view.publisher_id)) {
    view.publisher_id = publishers[0]?.id || "";
  }
  saveViewState(view);

  // 月份選項:近 12 個月
  const monthOptions = listMonths(12, currentMonth);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>📄 對帳報表</h1>
        <div class="desc">給站長對帳用,全程 RMB;後結算的「剩餘」為負 = 應付給站長</div>
      </div>
    </div>

    <div class="card">
      <div class="row" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        <div class="field" style="flex:1;min-width:200px">
          <label>站長</label>
          <select id="f-pub">
            ${publishers.map((p) => `<option value="${esc(p.id)}" ${p.id === view.publisher_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="flex:1;min-width:140px">
          <label>月份</label>
          <select id="f-month">
            ${monthOptions.map((m) => `<option value="${m}" ${m === view.month ? "selected" : ""}>${m}</option>`).join("")}
          </select>
        </div>
        <div>
          <button class="primary" id="btn-print">🖨️ 列印 / 截圖</button>
        </div>
      </div>
    </div>

    <div id="report" class="mt-8"></div>
  `;

  const q = (sel) => root.querySelector(sel);
  q("#f-pub")?.addEventListener("change", () => {
    view.publisher_id = q("#f-pub").value;
    saveViewState(view);
    renderReport(root, view);
  });
  q("#f-month")?.addEventListener("change", () => {
    view.month = q("#f-month").value;
    saveViewState(view);
    renderReport(root, view);
  });
  q("#btn-print")?.addEventListener("click", () => window.print());

  if (publishers.length === 0) {
    root.querySelector("#report").innerHTML = `
      <div class="card"><p class="ink-2" style="margin:0">尚無站長,先到「站長」頁建立。</p></div>
    `;
    return;
  }
  renderReport(root, view);
}

function renderReport(root, view) {
  const panel = root.querySelector("#report");
  if (!panel || !view.publisher_id || !view.month) return;
  const s = getState();
  const pub = (s.publishers || []).find((p) => p.id === view.publisher_id);
  if (!pub) { panel.innerHTML = ""; return; }

  const r = aggregateByPublisherMonth(s, pub.id, view.month);

  // 按 (date, product) 彙總到「日明細」表
  const dayProductMap = new Map();
  const productTotals = new Map();
  for (const d of r.daily_costs) {
    const key = `${d.date}::${d.product_id}`;
    if (!dayProductMap.has(key)) {
      dayProductMap.set(key, {
        date: d.date,
        product_id: d.product_id,
        product_name: d.product_name,
        installs: 0,
        price_rmb: d.price_rmb,
        cost_rmb: 0,
      });
    }
    const row = dayProductMap.get(key);
    row.installs += d.installs_billed;
    row.cost_rmb += d.cost_rmb;

    if (!productTotals.has(d.product_id)) {
      productTotals.set(d.product_id, { name: d.product_name, installs: 0, cost: 0 });
    }
    const pt = productTotals.get(d.product_id);
    pt.installs += d.installs_billed;
    pt.cost += d.cost_rmb;
  }
  const dayProductRows = Array.from(dayProductMap.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.product_name.localeCompare(b.product_name)
  );

  panel.innerHTML = `
    <div class="card" id="print-target">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <h2 style="margin:0">${esc(pub.name)} · ${esc(view.month)} 對帳單</h2>
          <div class="ink-3" style="font-size:12px;margin-top:2px">
            區間:${esc(r.from)} ~ ${esc(r.to)} · 結算模式:${pub.settlement_mode === "postpaid" ? "後結算" : "預付款"}
          </div>
        </div>
        <div style="text-align:right">
          <div class="ink-3" style="font-size:11px">剩餘金額(RMB)</div>
          <div style="font-size:24px;font-weight:700;color:${r.closing_balance_rmb < 0 ? "#d32f2f" : "#333"}">
            ${formatRmb(r.closing_balance_rmb)}
          </div>
          ${r.closing_balance_rmb < 0 ? '<div class="ink-3" style="font-size:11px;color:#d32f2f">應付給站長</div>' : ""}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:10px 0">
        ${kpi("期初餘額", r.opening_balance_rmb)}
        ${kpi("本期打款", r.total_paid_in_period_rmb, "ok")}
        ${kpi("本期結算", r.total_settled_rmb, "danger")}
        ${kpi("期末餘額", r.closing_balance_rmb, r.closing_balance_rmb < 0 ? "danger" : "")}
      </div>

      ${r.shortfall_rmb > 0 ? `
        <div style="background:#fff8e1;border-left:3px solid #ff9800;padding:8px 12px;border-radius:6px;margin:8px 0;font-size:13px">
          ⚠️ 期間內有 ${formatRmb(r.shortfall_rmb)} 的結算費用沒對應到打款批次,匯率走預設值(僅影響內部 TWD 報表,RMB 對帳不變)
        </div>
      ` : ""}

      <h3 style="margin:14px 0 6px;font-size:14px">本期打款記錄(${r.payments_in_period.length} 筆)</h3>
      ${r.payments_in_period.length === 0 ? `
        <p class="ink-3" style="margin:0;font-size:13px">本期內無打款</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>日期</th><th class="num">RMB 金額</th><th>匯率</th><th>備註</th></tr>
            </thead>
            <tbody>
              ${r.payments_in_period.map((p) => `
                <tr>
                  <td>${esc(p.date)}</td>
                  <td class="num">${formatRmb(p.amount_rmb)}</td>
                  <td class="num">${Number(p.exchange_rate || 0).toFixed(2)}</td>
                  <td class="ink-3" style="font-size:12px">${esc(p.notes || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `}

      <h3 style="margin:14px 0 6px;font-size:14px">產品結算小計</h3>
      ${productTotals.size === 0 ? `
        <p class="ink-3" style="margin:0;font-size:13px">本期內無計費紀錄</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>產品</th><th class="num">廠商安裝(總)</th><th class="num">結算金額(RMB)</th></tr>
            </thead>
            <tbody>
              ${Array.from(productTotals.entries()).map(([pid, pt]) => `
                <tr>
                  <td>${esc(pt.name)}</td>
                  <td class="num">${numFmt(pt.installs)}</td>
                  <td class="num">${formatRmb(pt.cost)}</td>
                </tr>
              `).join("")}
              <tr style="font-weight:700;background:#f7f7f7">
                <td>合計</td>
                <td class="num">${numFmt(Array.from(productTotals.values()).reduce((a, b) => a + b.installs, 0))}</td>
                <td class="num">${formatRmb(r.total_settled_rmb)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      `}

      <h3 style="margin:14px 0 6px;font-size:14px">日明細(${dayProductRows.length} 列)</h3>
      ${dayProductRows.length === 0 ? `
        <p class="ink-3" style="margin:0;font-size:13px">本期內無計費紀錄</p>
      ` : `
        <div class="table-wrap" style="max-height:500px;overflow:auto">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>產品</th>
                <th class="num">廠商安裝</th>
                <th class="num">單價(RMB)</th>
                <th class="num">小計(RMB)</th>
              </tr>
            </thead>
            <tbody>
              ${dayProductRows.map((d) => `
                <tr>
                  <td>${esc(d.date)}</td>
                  <td>${esc(d.product_name)}</td>
                  <td class="num">${numFmt(d.installs)}</td>
                  <td class="num">${Number(d.price_rmb).toFixed(2)}</td>
                  <td class="num">${formatRmb(d.cost_rmb)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

function nowYm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function listMonths(count, fromYm) {
  const [y, m] = fromYm.split("-").map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    const dt = new Date(y, m - 1 - i, 1);
    out.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

function kpi(label, value, tone = "") {
  const color = tone === "danger" ? "#d32f2f" : tone === "ok" ? "#2e7d32" : "#333";
  return `
    <div style="background:#fafafa;border-radius:6px;padding:8px 10px">
      <div class="ink-3" style="font-size:11px">${esc(label)}</div>
      <div style="font-size:18px;font-weight:600;color:${color};margin-top:2px">${formatRmb(value)}</div>
    </div>
  `;
}

function formatRmb(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(n).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function numFmt(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("zh-TW");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
