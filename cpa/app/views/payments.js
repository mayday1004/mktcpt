// 帳務管理:各站長餘額一覽 + 打款 CRUD + FIFO 批次表。
// 主要視角:左側站長清單(餘額排序、低於閾值紅標)+ 右側選中站長的打款 / 批次。

import { getState, update, uid } from "../state.js";
import { nowTaipeiStamp, todayTaipei } from "../lib/dates.js";
import { computeFIFO, summarizeAllPublishers } from "../domain/billing.js";

let selectedPublisherId = null;

export function render(root) {
  const s = getState();
  const publishers = s.publishers || [];

  // 預設選第一個(或維持原本選擇)
  if (publishers.length > 0 && !publishers.find((p) => p.id === selectedPublisherId)) {
    selectedPublisherId = publishers[0].id;
  }
  if (publishers.length === 0) selectedPublisherId = null;

  const summary = summarizeAllPublishers(s, todayTaipei());
  const threshold = Number(s.settings?.low_balance_threshold_rmb || 200);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>💰 帳務</h1>
        <div class="desc">站長 RMB 餘額 = Σ 預付款 − Σ 結算費用;後結算可為負數</div>
      </div>
    </div>

    ${publishers.length === 0 ? `
      <div class="card">
        <p class="ink-2" style="margin:0">尚無站長,請先到「站長」頁建立。</p>
      </div>
    ` : `
      <div style="display:grid;grid-template-columns:280px 1fr;gap:12px;align-items:start">
        <div class="card" style="padding:0">
          <div style="padding:10px 12px;border-bottom:1px solid #eee;font-weight:600">站長餘額(RMB)</div>
          <div id="pub-list">${summary.map((row) => publisherRow(row, threshold, selectedPublisherId)).join("")}</div>
        </div>

        <div id="detail-panel"></div>
      </div>
    `}
  `;

  root.querySelectorAll("[data-pub]").forEach((el) => {
    el.onclick = () => {
      selectedPublisherId = el.dataset.pub;
      render(root);
    };
  });

  renderDetail(root);
}

function publisherRow(row, threshold, selectedId) {
  const p = row.publisher;
  const lowBalance = row.balance_rmb < threshold;
  const isSelected = p.id === selectedId;
  return `
    <div data-pub="${esc(p.id)}"
         style="padding:10px 12px;border-bottom:1px solid #f3f3f3;cursor:pointer;${isSelected ? "background:#eef7ff" : ""}">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <strong>${esc(p.name)}</strong>
        ${lowBalance ? '<span style="font-size:11px;color:#d32f2f">⚠️ 低餘額</span>' : ""}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:4px">
        <span class="ink-3">${row.channel_count} 線路 · ${p.settlement_mode === "postpaid" ? "後結算" : "預付款"}</span>
        <span style="color:${row.balance_rmb < 0 ? "#d32f2f" : (lowBalance ? "#f57c00" : "#333")};font-weight:600">
          ${formatRmb(row.balance_rmb)}
        </span>
      </div>
      <div class="ink-3" style="font-size:11px;margin-top:2px">
        打款 ${formatRmb(row.paid_rmb)} · 結算 ${formatRmb(row.settled_rmb)}
      </div>
    </div>
  `;
}

function renderDetail(root) {
  const panel = root.querySelector("#detail-panel");
  if (!panel) return;
  const s = getState();
  if (!selectedPublisherId) {
    panel.innerHTML = "";
    return;
  }
  const pub = (s.publishers || []).find((p) => p.id === selectedPublisherId);
  if (!pub) {
    panel.innerHTML = "";
    return;
  }

  const fifo = computeFIFO(s, { publisherId: pub.id });
  const totalRemaining = fifo.batches.reduce((sum, b) => sum + b.remaining_rmb, 0);
  const totalConsumed = fifo.batches.reduce((sum, b) => sum + b.consumed_rmb, 0);

  panel.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <h2 style="margin:0">${esc(pub.name)}</h2>
          <div class="ink-3" style="font-size:12px;margin-top:2px">
            ${pub.settlement_mode === "postpaid" ? "後結算" : "預付款"} · 預設單價 ${formatRmb(pub.default_cpa_price_rmb)}
          </div>
        </div>
        <button class="primary" id="btn-add-payment">＋ 新增打款</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px">
        ${kpi("批次剩餘", totalRemaining, totalRemaining < 0 ? "bad" : "")}
        ${kpi("批次已消耗", totalConsumed)}
        ${kpi("Fallback 匯率消耗", fifo.shortfall_rmb, fifo.shortfall_rmb > 0 ? "warn" : "", `沒對應批次的 RMB 用預設匯率 ${fifo.expense_rate_fallback}`)}
      </div>
    </div>

    <div class="card mt-8">
      <h2 style="margin-top:0">📥 FIFO 批次表</h2>
      <p class="ink-3" style="font-size:12px;margin:6px 0">
        每筆打款記錄一個獨立批次,花費時依日期順序消耗較早批次;每批次匯率鎖定不變
      </p>
      ${fifo.batches.length === 0 ? `
        <p class="ink-2" style="margin:8px 0">尚無打款記錄,按右上「＋ 新增打款」開始</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>RMB 金額</th>
                <th>匯率</th>
                <th>對應 TWD</th>
                <th>已消耗</th>
                <th>剩餘</th>
                <th>備註</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${fifo.batches.map((b) => batchRow(b)).join("")}</tbody>
          </table>
        </div>
      `}
    </div>
  `;

  panel.querySelector("#btn-add-payment")?.addEventListener("click", () => openPaymentEditor(null, pub.id, root));
  panel.querySelectorAll("[data-edit-pay]").forEach((el) => {
    el.onclick = () => openPaymentEditor(el.dataset.editPay, pub.id, root);
  });
  panel.querySelectorAll("[data-del-pay]").forEach((el) => {
    el.onclick = () => deletePayment(el.dataset.delPay, root);
  });
}

function batchRow(b) {
  const amount = Number(b.amount_rmb || 0);
  const rate = Number(b.exchange_rate || 0);
  const twd = amount * rate;
  return `
    <tr>
      <td>${esc(b.date || "—")}</td>
      <td class="num">${formatRmb(amount)}</td>
      <td class="num">${rate.toFixed(2)}</td>
      <td class="num">${formatTwd(twd)}</td>
      <td class="num">${formatRmb(b.consumed_rmb)}</td>
      <td class="num" style="font-weight:600;color:${b.remaining_rmb < 0 ? "#d32f2f" : "#333"}">${formatRmb(b.remaining_rmb)}</td>
      <td class="ink-3" style="font-size:12px">${esc(b.notes || "")}</td>
      <td class="num" style="white-space:nowrap">
        <button data-edit-pay="${esc(b.id)}">編輯</button>
        <button class="danger" data-del-pay="${esc(b.id)}">刪除</button>
      </td>
    </tr>
  `;
}

function openPaymentEditor(paymentId, publisherId, root) {
  const s = getState();
  const isNew = !paymentId;
  const p = isNew
    ? {
        id: uid("pay"),
        publisher_id: publisherId,
        date: todayTaipei(),
        amount_rmb: "",
        exchange_rate: Number(s.settings?.expense_rate || 4.8),
        notes: "",
      }
    : (s.payments || []).find((x) => x.id === paymentId);
  if (!p) return;

  const html = `
    <h2>${isNew ? "＋ 新增打款" : "✎ 編輯打款"}</h2>
    <div class="field">
      <label>日期 *</label>
      <input id="f-date" type="date" value="${esc(p.date || todayTaipei())}" />
    </div>
    <div class="field mt-8">
      <label>RMB 金額 *</label>
      <input id="f-amount" type="number" step="0.01" min="0" value="${p.amount_rmb ?? ""}" placeholder="例:5000" />
    </div>
    <div class="field mt-8">
      <label>匯率(RMB→TWD)*</label>
      <input id="f-rate" type="number" step="0.01" min="0" value="${p.exchange_rate ?? ""}" placeholder="例:4.8" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">
        此批次的匯率會鎖定,後續花費按 FIFO 消耗(較早的批次先用完)
      </div>
    </div>
    <div class="field mt-8">
      <label>備註</label>
      <input id="f-notes" type="text" value="${esc(p.notes || "")}" placeholder="例:5/14 微信轉帳" />
    </div>
    <div class="modal-actions">
      <button id="btn-cancel">取消</button>
      <button id="btn-save" class="primary">儲存</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  q("#btn-cancel").onclick = () => window.modal.close();
  q("#btn-save").onclick = () => {
    const date = q("#f-date").value;
    const amount = Number(q("#f-amount").value);
    const rate = Number(q("#f-rate").value);
    const notes = q("#f-notes").value.trim();
    if (!date) { window.toast("日期必填", "bad"); return; }
    if (!Number.isFinite(amount) || amount <= 0) { window.toast("RMB 金額要 > 0", "bad"); return; }
    if (!Number.isFinite(rate) || rate <= 0) { window.toast("匯率要 > 0", "bad"); return; }

    update((st) => {
      st.payments = st.payments || [];
      const existing = st.payments.find((x) => x.id === p.id);
      const rec = {
        id: p.id,
        publisher_id: publisherId,
        date,
        amount_rmb: amount,
        exchange_rate: rate,
        remaining_rmb: amount,  // 初始 = 全額,FIFO 算的時候會重新分配
        notes,
        created_at: existing?.created_at || nowTaipeiStamp(),
      };
      if (existing) Object.assign(existing, rec);
      else st.payments.push(rec);
    }, isNew ? "新增打款" : "編輯打款");
    window.modal.close();
    window.toast(isNew ? "✓ 已新增" : "✓ 已儲存", "ok");
    render(root);
  };

  setTimeout(() => q("#f-amount").focus(), 0);
}

async function deletePayment(paymentId, root) {
  const s = getState();
  const p = (s.payments || []).find((x) => x.id === paymentId);
  if (!p) return;
  const ok = await window.confirmAsync({
    title: `刪除打款記錄?`,
    body: `${p.date} · ${formatRmb(p.amount_rmb)} @ ${Number(p.exchange_rate || 0).toFixed(2)}`,
    okText: "刪除",
    danger: true,
    details: ["⚠️ 刪除後 FIFO 重算,若有歷史結算曾用過這批次,匯率會回退到下一個可用批次"],
  });
  if (!ok) return;
  update((st) => {
    st.payments = st.payments.filter((x) => x.id !== paymentId);
  }, "刪除打款");
  window.toast("已刪除", "ok");
  render(root);
}

function kpi(label, value, tone = "", hint = "") {
  const color = tone === "bad" ? "#d32f2f" : tone === "warn" ? "#f57c00" : "#333";
  return `
    <div style="background:#fafafa;border-radius:6px;padding:8px 10px">
      <div class="ink-3" style="font-size:11px">${esc(label)}</div>
      <div style="font-size:18px;font-weight:600;color:${color};margin-top:2px">${formatRmb(value)}</div>
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

function formatTwd(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `NT$${Number(v).toLocaleString("zh-TW", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
