// 對帳報表(站長視角):日期(列) × 產品(欄)矩陣,給站長對帳用,全程 RMB。
// 設計:壓縮網格、A4 直印剛好、整個畫面截圖即可、今天列高亮、未來列淡灰。
//
// 結構:
//   [日期]  [款/預付款]  [產品1]  [產品2]  ...
//   上月總結  期初餘額
//   5/1      該日打款    該日該產品結算 RMB ...
//   ...
//   5/14 (今天,高亮)
//   ... 未來日期淡灰
//   總計     期初+本期打款合計    產品結算合計 ...
//   結算     (跨所有欄)期末餘額

import { getState } from "../state.js";
import { aggregateByPublisherMonth } from "../domain/billing.js";
import { todayTaipei } from "../lib/dates.js";

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

  const monthOptions = listMonths(12, currentMonth);

  root.innerHTML = `
    <div class="view-head no-print">
      <div>
        <h1>📄 對帳報表</h1>
        <div class="desc">站長對帳用 · 全程 RMB · 按「列印 / 截圖」一畫面截下整張對帳單</div>
      </div>
    </div>

    <div class="card no-print">
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
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
        <div class="field" style="flex:1;min-width:140px">
          <label>欄位</label>
          <select id="f-product-mode">
            <option value="active" ${view.product_mode === "active" ? "selected" : ""}>有跑過的產品</option>
            <option value="all" ${view.product_mode === "all" ? "selected" : ""}>全部啟用產品</option>
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
  q("#f-product-mode")?.addEventListener("change", () => {
    view.product_mode = q("#f-product-mode").value;
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
  const today = todayTaipei();
  const yearMonth = view.month;
  const daysInMonth = lastDayOfMonth(yearMonth);

  // 決定要列哪些產品欄
  const productsToShow = decideProducts(s, pub.id, r.daily_costs, view.product_mode || "active");

  // 建 (date, product_id) → cost RMB lookup
  const dailyByKey = new Map();
  for (const d of r.daily_costs) {
    const key = `${d.date}::${d.product_id}`;
    dailyByKey.set(key, (dailyByKey.get(key) || 0) + d.cost_rmb);
  }
  // 各產品月總計
  const productTotals = new Map();
  for (const d of r.daily_costs) {
    productTotals.set(d.product_id, (productTotals.get(d.product_id) || 0) + d.cost_rmb);
  }

  // 各日打款金額
  const paymentsByDate = new Map();
  for (const p of r.payments_in_period) {
    paymentsByDate.set(p.date, (paymentsByDate.get(p.date) || 0) + Number(p.amount_rmb || 0));
  }

  const productColCount = productsToShow.length;
  const numericColCount = 1 + productColCount;  // 款 + 產品數

  panel.innerHTML = `
    <div class="settlement-print-card">
      <div class="settlement-banner">
        <div>
          <div class="settlement-title">${esc(pub.name)} · ${esc(view.month)} 對帳單</div>
          <div class="settlement-meta">
            ${pub.settlement_mode === "postpaid" ? "後結算" : "預付款"} ·
            預設單價 ¥${Number(pub.default_cpa_price_rmb || 0).toFixed(2)} ·
            ${productColCount} 個產品在跑
            ${r.shortfall_rmb > 0 ? ` · <span style="color:#d32f2f">⚠️ 有 ¥${formatNum(r.shortfall_rmb)} 結算未對應到打款批次</span>` : ""}
          </div>
        </div>
        <div class="settlement-balance">
          <div class="settlement-balance-label">期末餘額(RMB)</div>
          <div class="settlement-balance-value ${r.closing_balance_rmb < 0 ? "neg" : ""}">
            ${formatRmb(r.closing_balance_rmb)}
          </div>
          ${r.closing_balance_rmb < 0 ? '<div class="settlement-balance-hint">應付給站長</div>' : ""}
        </div>
      </div>

      <table class="settlement-grid">
        <thead>
          <tr>
            <th rowspan="2" class="col-date">日期</th>
            <th rowspan="2" class="col-payment">款/預付款</th>
            ${productColCount === 0 ? "" : `<th colspan="${productColCount}" class="col-product-group">${esc(pub.name)}</th>`}
          </tr>
          <tr>
            ${productsToShow.map((p) => `<th class="col-product">${esc(p.name)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr class="row-opening">
            <td class="col-date">上月總結</td>
            <td class="col-payment num">${formatNum(r.opening_balance_rmb, true)}</td>
            ${productsToShow.map(() => `<td class="cell-empty"></td>`).join("")}
          </tr>

          ${Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => {
            const ymd = `${yearMonth}-${String(day).padStart(2, "0")}`;
            const isToday = ymd === today;
            const isFuture = ymd > today;
            const payment = paymentsByDate.get(ymd) || 0;
            const cls = isToday ? "row-today" : (isFuture ? "row-future" : "");
            return `
              <tr class="${cls}">
                <td class="col-date">${day}日</td>
                <td class="col-payment num ${payment > 0 ? "" : "cell-empty"}">${payment > 0 ? formatNum(payment) : ""}</td>
                ${productsToShow.map((p) => {
                  const val = dailyByKey.get(`${ymd}::${p.id}`) || 0;
                  return `<td class="num ${val > 0 ? "" : "cell-empty"}">${val > 0 ? formatNum(val) : ""}</td>`;
                }).join("")}
              </tr>
            `;
          }).join("")}

          <tr class="row-totals">
            <td class="col-date">總計</td>
            <td class="col-payment num">${formatNum(r.opening_balance_rmb + r.total_paid_in_period_rmb, true)}</td>
            ${productsToShow.map((p) => {
              const t = productTotals.get(p.id) || 0;
              return `<td class="num ${t > 0 ? "" : "cell-empty"}">${t > 0 ? formatNum(t) : ""}</td>`;
            }).join("")}
          </tr>

          <tr class="row-final">
            <td class="col-date">結算</td>
            <td colspan="${numericColCount}" class="num ${r.closing_balance_rmb < 0 ? "neg" : ""}">
              ${formatRmb(r.closing_balance_rmb)}
              ${r.closing_balance_rmb < 0 ? "(應付給站長)" : ""}
            </td>
          </tr>
        </tbody>
      </table>

      ${r.payments_in_period.length > 0 ? `
        <div class="settlement-footnote">
          本期打款明細:${r.payments_in_period.map((p) =>
            `${p.date.slice(5)} ¥${formatNum(p.amount_rmb)}${p.notes ? `(${esc(p.notes)})` : ""}`
          ).join(" · ")}
        </div>
      ` : ""}
    </div>
  `;
}

// 哪些產品要列為欄
function decideProducts(state, publisherId, dailyCosts, mode) {
  const products = state.products || [];
  if (mode === "all") {
    return products.filter((p) => p.cpa_enabled !== false);
  }
  // active 模式:這站長有跑過的產品(install_data 有對應)
  const myChannelIds = new Set((state.channels || []).filter((c) => c.publisher_id === publisherId).map((c) => c.id));
  const seenProductIds = new Set();
  for (const d of state.install_data || []) {
    if (myChannelIds.has(d.channel_id)) seenProductIds.add(d.product_id);
  }
  // 也納入「本月有結算」的產品(冗餘安全網)
  for (const d of dailyCosts) seenProductIds.add(d.product_id);
  return products.filter((p) => seenProductIds.has(p.id));
}

function lastDayOfMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
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

function formatRmb(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(n).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 對帳網格內 cell 用:整數顯示(節省空間),保留 1 位小數於必要
function formatNum(v, allowZero = false) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  const n = Number(v);
  if (!allowZero && n === 0) return "";
  if (Math.abs(n) >= 100 || Number.isInteger(n)) {
    return Math.round(n).toLocaleString("zh-TW");
  }
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 1 });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
