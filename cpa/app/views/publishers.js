// 站長管理:CRUD。
// 欄位:名稱 / 預設 CPA 單價(RMB) / 聯絡方式 / 結算模式(預付/後結)。

import { getState, update, uid } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import { SETTLEMENT_MODES } from "../schema.js";

export function render(root) {
  const s = getState();
  const list = (s.publishers || []).slice().sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id)
  );
  // 為每位站長算旗下線路數(快速 reference)
  const channelCountByPub = {};
  for (const c of (s.channels || [])) {
    channelCountByPub[c.publisher_id] = (channelCountByPub[c.publisher_id] || 0) + 1;
  }

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>👤 站長</h1>
        <div class="desc">站長基本資料、預設 CPA 單價、結算模式</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add">＋ 新增站長</button>
      </div>
    </div>

    <div class="card">
      ${list.length === 0 ? `
        <p class="ink-2" style="margin:0">尚無站長。先新增站長,才能在「線路」頁建立線路。</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名稱</th>
                <th>預設 CPA 單價(RMB)</th>
                <th>結算模式</th>
                <th>聯絡方式</th>
                <th>旗下線路</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${list.map((p) => row(p, channelCountByPub[p.id] || 0)).join("")}</tbody>
          </table>
        </div>
      `}
    </div>
  `;

  root.querySelector("#btn-add").onclick = () => openEditor(null);
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.edit);
  });
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = () => deletePublisher(el.dataset.del);
  });
}

function row(p, channelCount) {
  const modeLabel = p.settlement_mode === "postpaid" ? "後結算" : "預付款";
  return `
    <tr>
      <td>
        <strong>${esc(p.name)}</strong>
        <div class="ink-3" style="font-size:11px;margin-top:2px">id: <code>${esc(p.id)}</code></div>
      </td>
      <td class="num">${formatPrice(p.default_cpa_price_rmb)}</td>
      <td>${modeLabel}</td>
      <td>${esc(p.contact_info || "—")}</td>
      <td class="num">${channelCount}</td>
      <td class="num">
        <button data-edit="${esc(p.id)}">編輯</button>
        <button class="danger" data-del="${esc(p.id)}">刪除</button>
      </td>
    </tr>
  `;
}

function formatPrice(v) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(2);
}

function openEditor(publisherId) {
  const s = getState();
  const isNew = !publisherId;
  const p = isNew
    ? { id: uid("pub"), name: "", default_cpa_price_rmb: 2.5, contact_info: "", settlement_mode: "prepaid" }
    : s.publishers.find((x) => x.id === publisherId);
  if (!p) return;

  const html = `
    <h2>${isNew ? "＋ 新增站長" : "✎ 編輯站長"}</h2>
    <div class="field">
      <label>站長名稱 *</label>
      <input id="f-name" type="text" value="${esc(p.name || "")}" placeholder="例:張三 / 站長 A" />
    </div>
    <div class="field mt-8">
      <label>預設 CPA 單價(RMB)<span class="ink-3" style="font-weight:400">(範圍約 1.5 ~ 2.5;線路可個別覆寫)</span></label>
      <input id="f-price" type="number" step="0.01" min="0" value="${p.default_cpa_price_rmb ?? ""}" />
    </div>
    <div class="field mt-8">
      <label>結算模式</label>
      <div>
        ${SETTLEMENT_MODES.map((m) => `
          <label style="margin-right:16px">
            <input type="radio" name="f-mode" value="${m}" ${p.settlement_mode === m ? "checked" : ""} />
            ${m === "prepaid" ? "預付款" : "後結算"}
          </label>
        `).join("")}
      </div>
      <div class="ink-3" style="font-size:11px;margin-top:4px">
        預付款 = 先打款後扣費;後結算 = 結帳時付款,剩餘金額可為負(欠款)
      </div>
    </div>
    <div class="field mt-8">
      <label>聯絡方式</label>
      <input id="f-contact" type="text" value="${esc(p.contact_info || "")}" placeholder="例:@telegram_id / email / 微信" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">同站長的線路在「縮網址」頁會分一組批次通知</div>
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
    const name = q("#f-name").value.trim();
    const price = Number(q("#f-price").value);
    const contact = q("#f-contact").value.trim();
    const mode = dlg.querySelector('input[name="f-mode"]:checked')?.value || "prepaid";
    if (!name) { window.toast("站長名稱必填", "bad"); return; }
    if (!Number.isFinite(price) || price <= 0) { window.toast("預設單價要 > 0", "bad"); return; }

    update((st) => {
      st.publishers = st.publishers || [];
      const existing = st.publishers.find((x) => x.id === p.id);
      const rec = {
        id: p.id,
        name,
        default_cpa_price_rmb: price,
        contact_info: contact,
        settlement_mode: SETTLEMENT_MODES.includes(mode) ? mode : "prepaid",
        created_at: existing?.created_at || nowTaipeiStamp(),
      };
      if (existing) Object.assign(existing, rec);
      else st.publishers.push(rec);
    }, isNew ? "新增站長" : "編輯站長");
    window.modal.close();
    window.toast(isNew ? "✓ 已新增" : "✓ 已儲存", "ok");
  };

  setTimeout(() => q("#f-name").focus(), 0);
}

async function deletePublisher(publisherId) {
  const s = getState();
  const p = (s.publishers || []).find((x) => x.id === publisherId);
  if (!p) return;

  const channels = (s.channels || []).filter((c) => c.publisher_id === publisherId);
  const payments = (s.payments || []).filter((pay) => pay.publisher_id === publisherId);

  if (channels.length > 0) {
    await window.confirmAsync({
      title: `無法刪除站長「${p.name}」`,
      body: `此站長旗下還有 ${channels.length} 條線路。請先刪除 / 轉移那些線路,再回來刪站長。`,
      okText: "我知道了",
      cancelText: "",
    });
    return;
  }

  const detail = payments.length > 0
    ? [`此站長有 ${payments.length} 筆打款記錄`, "刪除站長不會刪打款記錄,但打款記錄會變孤兒(找不到對應站長)"]
    : null;

  const ok = await window.confirmAsync({
    title: `刪除站長「${p.name}」?`,
    body: "確認刪除?",
    okText: "刪除", danger: true,
    details: detail,
  });
  if (!ok) return;
  update((st) => {
    st.publishers = st.publishers.filter((x) => x.id !== publisherId);
  }, "刪除站長");
  window.toast("已刪除", "ok");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
