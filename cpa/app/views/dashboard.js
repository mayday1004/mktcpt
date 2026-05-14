// 概覽:各站長餘額、本月結算、警示。
// 數字全部來自 domain/billing.js,跟其他頁一致。

import { getState } from "../state.js";
import { todayTaipei } from "../lib/dates.js";
import { summarizeAllPublishers, aggregateByPublisherMonth } from "../domain/billing.js";

export function render(root) {
  const s = getState();
  const ym = s.settings?.current_month || todayTaipei().slice(0, 7);
  const threshold = Number(s.settings?.low_balance_threshold_rmb || 200);
  const today = todayTaipei();

  const publishers = s.publishers || [];
  const summary = summarizeAllPublishers(s, today);

  // 本月結算
  const monthSettlement = publishers.map((p) => {
    const agg = aggregateByPublisherMonth(s, p.id, ym);
    return { publisher: p, ...agg };
  });

  // 線路淘汰提醒
  const channels = s.channels || [];
  const pendingConfirm = channels.filter((c) =>
    c.status === "淘汰中" && c.billing_end_date && c.billing_end_date <= today
  );

  // KPI
  const totalChannels = channels.length;
  const totalActive = channels.filter((c) => c.status === "啟用中").length;
  const totalEliminating = channels.filter((c) => c.status === "淘汰中").length;
  const totalLowBalance = summary.filter((r) => r.balance_rmb < threshold).length;
  const totalNegativeBalance = summary.filter((r) => r.balance_rmb < 0).length;
  const totalSettledMonth = monthSettlement.reduce((sum, r) => sum + (r.total_settled_rmb || 0), 0);
  const totalPaidMonth = monthSettlement.reduce((sum, r) => sum + (r.total_paid_in_period_rmb || 0), 0);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>📊 概覽</h1>
        <div class="desc">${esc(ym)} · 本機資料截至 ${esc(today)}</div>
      </div>
    </div>

    ${publishers.length === 0 ? `
      <div class="card">
        <p class="ink-2" style="margin:0">尚未建立任何站長 / 線路。建議從「站長」頁開始,然後到「線路」建立渠道,最後在「設定」連 Sheets 同步。</p>
      </div>
    ` : `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-bottom:8px">
        ${kpi("站長 / 線路", `${publishers.length} / ${totalChannels}`, `啟用 ${totalActive} · 淘汰中 ${totalEliminating}`)}
        ${kpi("本月結算 RMB", formatRmb(totalSettledMonth), `打款 ${formatRmb(totalPaidMonth)}`)}
        ${kpi("低餘額站長", `${totalLowBalance} / ${publishers.length}`, `< ¥${threshold}`, totalLowBalance > 0 ? "warn" : "")}
        ${kpi("負餘額(欠款)", `${totalNegativeBalance} / ${publishers.length}`, "應付給站長", totalNegativeBalance > 0 ? "bad" : "")}
      </div>

      ${pendingConfirm.length > 0 ? `
        <div class="card" style="border-left:3px solid #ff9800;background:#fff8e1">
          <h2 style="margin-top:0">⏰ ${pendingConfirm.length} 條線路截止計費日已到</h2>
          <p class="ink-2" style="margin:6px 0;font-size:13px">
            這些線路的截止計費日 ≤ 今天,請到「線路」頁確認是否切換到「已淘汰」(停止計費)
          </p>
          <ul style="margin:0;padding-left:20px;font-size:13px">
            ${pendingConfirm.slice(0, 10).map((c) => `
              <li><strong>${esc(c.name)}</strong> · 截止 ${esc(c.billing_end_date)}</li>
            `).join("")}
          </ul>
        </div>
      ` : ""}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
        <div class="card">
          <h2 style="margin-top:0">💰 站長餘額(RMB)</h2>
          <div class="table-wrap" style="max-height:400px;overflow:auto">
            <table>
              <thead>
                <tr>
                  <th>站長</th>
                  <th class="num">打款累計</th>
                  <th class="num">結算累計</th>
                  <th class="num">餘額</th>
                </tr>
              </thead>
              <tbody>
                ${summary.length === 0 ? `<tr><td colspan="4" class="ink-3">無資料</td></tr>` : summary.map((r) => `
                  <tr>
                    <td>
                      <strong>${esc(r.publisher.name)}</strong>
                      <div class="ink-3" style="font-size:11px">${r.publisher.settlement_mode === "postpaid" ? "後結算" : "預付款"} · ${r.channel_count} 線路</div>
                    </td>
                    <td class="num">${formatRmb(r.paid_rmb)}</td>
                    <td class="num">${formatRmb(r.settled_rmb)}</td>
                    <td class="num" style="font-weight:600;color:${r.balance_rmb < 0 ? "#d32f2f" : (r.balance_rmb < threshold ? "#f57c00" : "#333")}">
                      ${formatRmb(r.balance_rmb)}
                      ${r.balance_rmb < threshold && r.balance_rmb >= 0 ? '<div style="font-size:10px;color:#f57c00">⚠️ 低餘額</div>' : ""}
                      ${r.balance_rmb < 0 ? '<div style="font-size:10px;color:#d32f2f">⚠️ 欠款</div>' : ""}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2 style="margin-top:0">📅 ${esc(ym)} 各站長結算</h2>
          <div class="table-wrap" style="max-height:400px;overflow:auto">
            <table>
              <thead>
                <tr>
                  <th>站長</th>
                  <th class="num">本月結算</th>
                  <th class="num">本月打款</th>
                  <th class="num">期末</th>
                </tr>
              </thead>
              <tbody>
                ${monthSettlement.length === 0 ? `<tr><td colspan="4" class="ink-3">無資料</td></tr>` : monthSettlement.map((r) => `
                  <tr>
                    <td>${esc(r.publisher.name)}</td>
                    <td class="num">${formatRmb(r.total_settled_rmb)}</td>
                    <td class="num">${formatRmb(r.total_paid_in_period_rmb)}</td>
                    <td class="num" style="color:${r.closing_balance_rmb < 0 ? "#d32f2f" : "#333"}">${formatRmb(r.closing_balance_rmb)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      ${renderLatestImports(s)}
    `}
  `;
}

function renderLatestImports(s) {
  const installData = s.install_data || [];
  if (installData.length === 0) {
    return `
      <div class="card mt-8">
        <h2 style="margin-top:0">📥 近期匯入</h2>
        <p class="ink-2" style="margin:0">尚無安裝數據,到「資料匯入」頁開始</p>
      </div>
    `;
  }
  // 近 7 天每日的匯入筆數
  const byDate = new Map();
  for (const d of installData) {
    byDate.set(d.date, (byDate.get(d.date) || 0) + 1);
  }
  const recentDates = Array.from(byDate.keys()).sort().slice(-7);
  const latestDate = recentDates[recentDates.length - 1];
  return `
    <div class="card mt-8">
      <h2 style="margin-top:0">📥 近期匯入(共 ${installData.length} 筆,最近 ${esc(latestDate)})</h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${recentDates.map((d) => `
          <div style="background:#eef;padding:6px 10px;border-radius:4px;font-size:12px">
            <strong>${esc(d)}</strong> · ${byDate.get(d)} 筆
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function kpi(label, value, hint, tone) {
  const color = tone === "bad" ? "#d32f2f" : tone === "warn" ? "#f57c00" : "#333";
  return `
    <div style="background:#fafafa;border-radius:6px;padding:10px 12px">
      <div class="ink-3" style="font-size:11px">${esc(label)}</div>
      <div style="font-size:20px;font-weight:600;color:${color};margin-top:2px">${esc(value)}</div>
      ${hint ? `<div class="ink-3" style="font-size:11px;margin-top:2px">${esc(hint)}</div>` : ""}
    </div>
  `;
}

function formatRmb(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(n).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
