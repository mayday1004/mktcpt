// 產品管理:CPA 產品 CRUD。
// 欄位:名稱 / GSheets 欄位代碼(匯入時對應)/ 是否啟用 CPA 計價。

import { getState, update, uid } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";

export function render(root) {
  const s = getState();
  const list = (s.products || []).slice().sort((a, b) =>
    (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id)
  );
  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>🎯 產品</h1>
        <div class="desc">CPA 計費的產品定義,匯入時用「GSheets 欄位代碼」對應到匯入表格的欄位。</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add">＋ 新增產品</button>
      </div>
    </div>

    <div class="card">
      ${list.length === 0 ? `
        <p class="ink-2" style="margin:0">尚無產品。先新增產品才能開始匯入安裝數據。</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名稱</th>
                <th>GSheets 欄位代碼</th>
                <th>縮網址代碼</th>
                <th>CPA 計費</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${list.map(row).join("")}</tbody>
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
    el.onclick = () => deleteProduct(el.dataset.del);
  });
}

function row(p) {
  return `
    <tr>
      <td>
        <strong>${esc(p.name)}</strong>
        <div class="ink-3" style="font-size:11px;margin-top:2px">id: <code>${esc(p.id)}</code></div>
      </td>
      <td><code>${esc(p.gsheet_field_code || "—")}</code></td>
      <td><code>${esc(p.short_url_code || "—")}</code></td>
      <td>${p.cpa_enabled ? "✓ 啟用" : "—"}</td>
      <td class="num">
        <button data-edit="${esc(p.id)}">編輯</button>
        <button class="danger" data-del="${esc(p.id)}">刪除</button>
      </td>
    </tr>
  `;
}

function openEditor(productId) {
  const s = getState();
  const isNew = !productId;
  const p = isNew
    ? { id: uid("prod"), name: "", gsheet_field_code: "", short_url_code: "", cpa_enabled: true }
    : s.products.find((x) => x.id === productId);
  if (!p) return;

  const html = `
    <h2>${isNew ? "＋ 新增產品" : "✎ 編輯產品"}</h2>
    <div class="field">
      <label>名稱 *</label>
      <input id="f-name" type="text" value="${esc(p.name || "")}" placeholder="例:愛威奶、健康" />
    </div>
    <div class="field mt-8">
      <label>GSheets 欄位代碼 <span class="ink-3" style="font-weight:400">(匯入時用此代碼對應欄位,不可重複)</span></label>
      <input id="f-code" type="text" value="${esc(p.gsheet_field_code || "")}" placeholder="例:AV9、jk" />
    </div>
    <div class="field mt-8">
      <label>縮網址代碼 <span class="ink-3" style="font-weight:400">(縮網址參數預設 = 此代碼 + 渠道名稱;例:AV9 → 9、JK → jk;留空 = 不參與)</span></label>
      <input id="f-su-code" type="text" value="${esc(p.short_url_code || "")}" placeholder="例:9 / jk / hyc" />
    </div>
    <div class="field mt-8">
      <label><input id="f-enabled" type="checkbox" ${p.cpa_enabled ? "checked" : ""} /> 啟用 CPA 計費(未勾選的產品不參與結算)</label>
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
    const code = q("#f-code").value.trim();
    const suCode = q("#f-su-code").value.trim();
    const enabled = q("#f-enabled").checked;
    if (!name) { window.toast("名稱必填", "bad"); return; }
    if (!code) { window.toast("GSheets 欄位代碼必填", "bad"); return; }
    // 檢查 code 重複
    const dupe = (s.products || []).find((x) => x.id !== p.id && x.gsheet_field_code === code);
    if (dupe) { window.toast(`欄位代碼「${code}」已被「${dupe.name}」使用`, "bad"); return; }

    update((st) => {
      st.products = st.products || [];
      const existing = st.products.find((x) => x.id === p.id);
      const rec = {
        id: p.id,
        name,
        gsheet_field_code: code,
        short_url_code: suCode,
        cpa_enabled: enabled,
        created_at: existing?.created_at || nowTaipeiStamp(),
      };
      if (existing) Object.assign(existing, rec);
      else st.products.push(rec);
    }, isNew ? "新增產品" : "編輯產品");
    window.modal.close();
    window.toast(isNew ? "✓ 已新增" : "✓ 已儲存", "ok");
  };

  setTimeout(() => q("#f-name").focus(), 0);
}

async function deleteProduct(productId) {
  const s = getState();
  const p = (s.products || []).find((x) => x.id === productId);
  if (!p) return;
  // 檢查是否有 install_data 引用此產品
  const refCount = (s.install_data || []).filter((d) => d.product_id === productId).length;
  const detail = refCount > 0
    ? [`⚠️ 目前有 ${refCount} 筆安裝數據引用此產品`,
       "刪除後這些紀錄會變孤兒,內部報表會少這筆資料"]
    : null;

  const ok = await window.confirmAsync({
    title: `刪除產品「${p.name}」?`,
    body: "刪除後此產品不再出現在新匯入流程中。",
    okText: "刪除", danger: true,
    details: detail,
  });
  if (!ok) return;
  update((st) => {
    st.products = st.products.filter((x) => x.id !== productId);
  }, "刪除產品");
  window.toast("已刪除", "ok");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
