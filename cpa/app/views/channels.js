// 線路管理:CRUD + 淘汰生命週期狀態機。
// 渠道名稱 = 匯入時的唯一識別鍵,不可重複(同站長內最嚴格,不同站長也警示)。
// 狀態:啟用中 → 標記淘汰(填截止日 + 模式)→ 淘汰中 → 確認淘汰 → 已淘汰
//        ↑──────────── 恢復啟用 ──────────────────────────────┘

import { getState, update, uid } from "../state.js";
import { todayTaipei, nowTaipeiStamp } from "../lib/dates.js";
import { CHANNEL_STATUSES, ELIMINATION_MODES, channelStatusColor } from "../schema.js";

export function render(root) {
  const s = getState();
  const channels = (s.channels || []).slice().sort((a, b) => {
    // 啟用中在最前、淘汰中其次、已淘汰最後;狀態內依 created_at
    const order = { "啟用中": 0, "淘汰中": 1, "已淘汰": 2 };
    const oa = order[a.status] ?? 9;
    const ob = order[b.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return (a.created_at || "").localeCompare(b.created_at || "") || a.id.localeCompare(b.id);
  });
  const publishers = s.publishers || [];
  const pubById = {};
  publishers.forEach((p) => { pubById[p.id] = p; });

  // 截止日已到但還沒確認的「淘汰中」線路 → 提醒
  const today = todayTaipei();
  const pendingConfirm = channels.filter((c) =>
    c.status === "淘汰中" && c.billing_end_date && c.billing_end_date <= today
  );

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>🔌 線路</h1>
        <div class="desc">渠道名稱為匯入時唯一識別鍵;淘汰生命週期見「⋯」按鈕</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add" ${publishers.length === 0 ? "disabled" : ""}>＋ 新增線路</button>
      </div>
    </div>

    ${publishers.length === 0 ? `
      <div class="card">
        <p class="ink-2" style="margin:0">⚠️ 尚未建立站長,請先到「站長」頁建立至少一位站長,才能新增線路。</p>
      </div>
    ` : ""}

    ${pendingConfirm.length > 0 ? `
      <div class="card" style="border-left:3px solid #ff9800;background:#fff8e1">
        <h2 style="margin-top:0">⏰ ${pendingConfirm.length} 條線路截止計費日已到</h2>
        <p class="ink-2" style="margin:6px 0">以下線路的截止計費日 ≤ 今天(${today}),請確認是否切換到「已淘汰」(停止計費):</p>
        <ul style="margin:6px 0;padding-left:20px">
          ${pendingConfirm.map((c) => `
            <li>
              <strong>${esc(c.name)}</strong>(${esc(pubById[c.publisher_id]?.name || "—")})
              · 截止 ${esc(c.billing_end_date)}
              <button data-confirm-elim="${esc(c.id)}" class="primary" style="margin-left:8px;padding:2px 8px;font-size:12px">確認淘汰</button>
            </li>
          `).join("")}
        </ul>
      </div>
    ` : ""}

    <div class="card">
      ${channels.length === 0 ? `
        <p class="ink-2" style="margin:0">${publishers.length === 0 ? "先新增站長" : "尚無線路,按右上「＋ 新增線路」開始"}</p>
      ` : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道名稱</th>
                <th>所屬站長</th>
                <th>CPA 單價(RMB)</th>
                <th>狀態</th>
                <th>淘汰備註</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${channels.map((c) => row(c, pubById)).join("")}</tbody>
          </table>
        </div>
      `}
    </div>
  `;

  const q = (sel) => root.querySelector(sel);
  q("#btn-add")?.addEventListener("click", () => openEditor(null));
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.edit);
  });
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = () => deleteChannel(el.dataset.del);
  });
  root.querySelectorAll("[data-lifecycle]").forEach((el) => {
    el.onclick = () => openLifecycle(el.dataset.lifecycle);
  });
  root.querySelectorAll("[data-confirm-elim]").forEach((el) => {
    el.onclick = () => confirmEliminate(el.dataset.confirmElim);
  });
}

function row(c, pubById) {
  const pub = pubById[c.publisher_id];
  const effectivePrice = c.cpa_price_rmb ?? pub?.default_cpa_price_rmb;
  const priceLabel = effectivePrice != null
    ? `${Number(effectivePrice).toFixed(2)}${c.cpa_price_rmb != null ? "" : ' <span class="ink-3" style="font-size:11px">(沿用站長)</span>'}`
    : "—";
  const color = channelStatusColor(c.status);
  const elimNote = buildElimNote(c);
  return `
    <tr>
      <td>
        <strong>${esc(c.name)}</strong>
        <div class="ink-3" style="font-size:11px;margin-top:2px">id: <code>${esc(c.id)}</code></div>
      </td>
      <td>${esc(pub?.name || "⚠️ 站長已刪除")}</td>
      <td class="num">${priceLabel}</td>
      <td>
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${color};color:#fff;font-size:12px;font-weight:600">
          ${esc(c.status || "啟用中")}
        </span>
      </td>
      <td class="ink-3" style="font-size:12px">${elimNote}</td>
      <td class="num" style="white-space:nowrap">
        <button data-edit="${esc(c.id)}">編輯</button>
        <button data-lifecycle="${esc(c.id)}">生命週期</button>
        <button class="danger" data-del="${esc(c.id)}">刪除</button>
      </td>
    </tr>
  `;
}

function buildElimNote(c) {
  if (c.status === "啟用中") return "—";
  const parts = [];
  if (c.eliminated_at) parts.push(`標記 ${c.eliminated_at}`);
  if (c.elimination_mode) {
    parts.push(c.elimination_mode === "winding-down" ? "繼續計費" : "停止計費");
  }
  if (c.billing_end_date) parts.push(`截止 ${c.billing_end_date}`);
  if (c.confirmed_eliminated_at) parts.push(`✓ ${c.confirmed_eliminated_at} 確認`);
  return parts.join(" · ") || "—";
}

function openEditor(channelId) {
  const s = getState();
  const isNew = !channelId;
  const c = isNew
    ? {
        id: uid("ch"),
        name: "",
        publisher_id: (s.publishers[0]?.id) || "",
        cpa_price_rmb: null,
        status: "啟用中",
        notes: "",
      }
    : s.channels.find((x) => x.id === channelId);
  if (!c) return;
  if (isNew && !c.publisher_id) {
    window.toast("先建立至少一位站長", "bad");
    return;
  }

  const publishers = s.publishers || [];
  const pub = publishers.find((p) => p.id === c.publisher_id);
  const defaultPriceHint = pub?.default_cpa_price_rmb != null
    ? `站長預設:${Number(pub.default_cpa_price_rmb).toFixed(2)} RMB`
    : "站長未設預設單價";

  const html = `
    <h2>${isNew ? "＋ 新增線路" : "✎ 編輯線路"}</h2>
    <div class="field">
      <label>渠道名稱 * <span class="ink-3" style="font-weight:400">(匯入時的唯一比對鍵,要跟試算表完全一致)</span></label>
      <input id="f-name" type="text" value="${esc(c.name || "")}" placeholder="例:tspdh70 / lyy_av9_70" />
    </div>
    <div class="field mt-8">
      <label>所屬站長 *</label>
      <select id="f-pub">
        ${publishers.map((p) => `
          <option value="${esc(p.id)}" ${p.id === c.publisher_id ? "selected" : ""}>${esc(p.name)}</option>
        `).join("")}
      </select>
    </div>
    <div class="field mt-8">
      <label>CPA 單價(RMB)<span class="ink-3" style="font-weight:400">(留空沿用站長預設)</span></label>
      <input id="f-price" type="number" step="0.01" min="0" value="${c.cpa_price_rmb ?? ""}" placeholder="留空" />
      <div class="ink-3" style="font-size:11px;margin-top:4px" id="hint-default-price">${defaultPriceHint}</div>
    </div>
    <div class="field mt-8">
      <label>備註</label>
      <textarea id="f-notes" rows="2" style="width:100%;font-family:inherit">${esc(c.notes || "")}</textarea>
    </div>
    <div class="modal-actions">
      <button id="btn-cancel">取消</button>
      <button id="btn-save" class="primary">儲存</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  q("#f-pub").addEventListener("change", () => {
    const newPub = publishers.find((p) => p.id === q("#f-pub").value);
    q("#hint-default-price").textContent = newPub?.default_cpa_price_rmb != null
      ? `站長預設:${Number(newPub.default_cpa_price_rmb).toFixed(2)} RMB`
      : "站長未設預設單價";
  });

  q("#btn-cancel").onclick = () => window.modal.close();
  q("#btn-save").onclick = () => {
    const name = q("#f-name").value.trim();
    const publisher_id = q("#f-pub").value;
    const priceRaw = q("#f-price").value.trim();
    const cpa_price_rmb = priceRaw === "" ? null : Number(priceRaw);
    const notes = q("#f-notes").value.trim();

    if (!name) { window.toast("渠道名稱必填", "bad"); return; }
    if (!publisher_id) { window.toast("站長必選", "bad"); return; }
    if (cpa_price_rmb != null && (!Number.isFinite(cpa_price_rmb) || cpa_price_rmb <= 0)) {
      window.toast("CPA 單價要 > 0 或留空", "bad"); return;
    }

    // 渠道名稱唯一性檢查(全系統,不限同站長)
    const dupe = (s.channels || []).find((x) => x.id !== c.id && x.name === name);
    if (dupe) {
      const dupePub = publishers.find((p) => p.id === dupe.publisher_id);
      window.toast(`渠道名稱「${name}」已被「${dupePub?.name || "?"}」的線路使用`, "bad");
      return;
    }

    update((st) => {
      st.channels = st.channels || [];
      const existing = st.channels.find((x) => x.id === c.id);
      const rec = {
        id: c.id,
        name,
        publisher_id,
        cpa_price_rmb,
        status: existing?.status || "啟用中",
        eliminated_at: existing?.eliminated_at || null,
        billing_end_date: existing?.billing_end_date || null,
        elimination_mode: existing?.elimination_mode || null,
        confirmed_eliminated_at: existing?.confirmed_eliminated_at || null,
        notes,
        created_at: existing?.created_at || nowTaipeiStamp(),
      };
      if (existing) Object.assign(existing, rec);
      else st.channels.push(rec);
    }, isNew ? "新增線路" : "編輯線路");
    window.modal.close();
    window.toast(isNew ? "✓ 已新增" : "✓ 已儲存", "ok");
  };

  setTimeout(() => q("#f-name").focus(), 0);
}

// ── 生命週期彈窗 ────────────────────────────────────────────
function openLifecycle(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  const pub = (s.publishers || []).find((p) => p.id === c.publisher_id);

  const status = c.status || "啟用中";
  const actions = buildLifecycleActions(status);
  const today = todayTaipei();

  const html = `
    <h2>🔄 線路生命週期</h2>
    <div class="ink-2" style="font-size:13px;margin-bottom:8px">
      <strong>${esc(c.name)}</strong>(${esc(pub?.name || "—")})· 目前狀態:
      <span style="padding:1px 8px;border-radius:8px;background:${channelStatusColor(status)};color:#fff;font-weight:600">${esc(status)}</span>
    </div>

    ${buildLifecycleSummary(c)}

    <h3 style="margin:14px 0 6px;font-size:14px">可執行的操作</h3>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${actions.map((a) => `
        <button data-act="${a.act}" style="text-align:left;padding:10px 12px;background:${a.danger ? "#fff8f8" : "#f7f7f7"};border:1px solid ${a.danger ? "#fcd0d0" : "#ddd"};border-radius:6px;cursor:pointer">
          <strong>${a.title}</strong>
          <div class="ink-3" style="font-size:12px;margin-top:2px">${a.desc}</div>
        </button>
      `).join("") || `<p class="ink-3" style="margin:0;font-size:13px">目前狀態下沒有可執行的操作</p>`}
    </div>

    <div class="modal-actions">
      <button id="btn-close">關閉</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  q("#btn-close").onclick = () => window.modal.close();
  dlg.querySelectorAll("[data-act]").forEach((el) => {
    el.onclick = () => {
      const act = el.dataset.act;
      if (act === "mark-eliminate") openMarkEliminate(channelId);
      else if (act === "confirm-eliminate") confirmEliminate(channelId);
      else if (act === "revert") revertToActive(channelId);
    };
  });
}

function buildLifecycleActions(status) {
  if (status === "啟用中") {
    return [{
      act: "mark-eliminate",
      title: "🟧 標記淘汰",
      desc: "進入「淘汰中」,要填截止計費日與淘汰模式",
    }];
  }
  if (status === "淘汰中") {
    return [
      {
        act: "confirm-eliminate",
        title: "✅ 確認淘汰",
        desc: "切換到「已淘汰」,從確認日起不再計入結算金額",
      },
      {
        act: "revert",
        title: "↩ 恢復啟用",
        desc: "改變主意 / 站長談下來,回到「啟用中」,清掉淘汰相關欄位",
      },
    ];
  }
  if (status === "已淘汰") {
    return [{
      act: "revert",
      title: "↩ 恢復啟用",
      desc: "重新合作,回到「啟用中」(歷史紀錄保留)",
      danger: false,
    }];
  }
  return [];
}

function buildLifecycleSummary(c) {
  const rows = [];
  if (c.eliminated_at) rows.push(["標記淘汰", c.eliminated_at]);
  if (c.elimination_mode) {
    rows.push(["淘汰模式", c.elimination_mode === "winding-down" ? "winding-down(繼續計費)" : "stop(停止計費)"]);
  }
  if (c.billing_end_date) rows.push(["截止計費日", c.billing_end_date]);
  if (c.confirmed_eliminated_at) rows.push(["確認淘汰", c.confirmed_eliminated_at]);
  if (rows.length === 0) return "";
  return `
    <div style="background:#f7f7f7;border-radius:6px;padding:8px 12px;margin-top:6px">
      ${rows.map(([k, v]) => `
        <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px">
          <span class="ink-3">${esc(k)}</span><span><strong>${esc(v)}</strong></span>
        </div>
      `).join("")}
    </div>
  `;
}

function openMarkEliminate(channelId) {
  window.modal.close();
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  const today = todayTaipei();

  const html = `
    <h2>🟧 標記淘汰</h2>
    <div class="ink-2" style="font-size:13px;margin-bottom:6px">
      線路:<strong>${esc(c.name)}</strong>
    </div>
    <div class="field">
      <label>淘汰模式 *</label>
      <div>
        <label style="display:block;margin:6px 0;padding:8px 12px;border:1px solid #ddd;border-radius:6px;cursor:pointer">
          <input type="radio" name="f-mode" value="stop" checked />
          <strong>停止計費(stop)</strong>
          <div class="ink-3" style="font-size:12px;margin-top:2px">明確停止合作。截止計費日預設 = 今天,從隔天起不計費。</div>
        </label>
        <label style="display:block;margin:6px 0;padding:8px 12px;border:1px solid #ddd;border-radius:6px;cursor:pointer">
          <input type="radio" name="f-mode" value="winding-down" />
          <strong>繼續計費(winding-down)</strong>
          <div class="ink-3" style="font-size:12px;margin-top:2px">已通知站長但對方還在處理,**繼續計費**並顯示淘汰標記;到截止計費日後系統會提醒「請確認淘汰」。</div>
        </label>
      </div>
    </div>
    <div class="field mt-8">
      <label>截止計費日 <span class="ink-3" style="font-weight:400">(stop 模式預設今天;winding-down 模式填預計結束日)</span></label>
      <input id="f-end-date" type="date" value="${today}" />
    </div>
    <div class="field mt-8">
      <label>備註(選填)</label>
      <input id="f-notes-add" type="text" placeholder="例:廠商主動下架 / 廣告主決定停止合作" />
    </div>
    <div class="modal-actions">
      <button id="btn-cancel">取消</button>
      <button id="btn-confirm" class="primary">確認標記淘汰</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  q("#btn-cancel").onclick = () => window.modal.close();
  q("#btn-confirm").onclick = () => {
    const mode = dlg.querySelector('input[name="f-mode"]:checked')?.value || "stop";
    const billingEnd = q("#f-end-date").value;
    const extraNote = q("#f-notes-add").value.trim();
    if (!ELIMINATION_MODES.includes(mode)) { window.toast("模式無效", "bad"); return; }
    if (!billingEnd) { window.toast("截止計費日必填", "bad"); return; }

    update((st) => {
      const target = st.channels.find((x) => x.id === channelId);
      if (!target) return;
      target.status = "淘汰中";
      target.eliminated_at = todayTaipei();
      target.billing_end_date = billingEnd;
      target.elimination_mode = mode;
      target.confirmed_eliminated_at = null;
      if (extraNote) {
        target.notes = target.notes
          ? `${target.notes}\n[${todayTaipei()}] 標記淘汰:${extraNote}`
          : `[${todayTaipei()}] 標記淘汰:${extraNote}`;
      }
    }, "標記淘汰");
    window.modal.close();
    window.toast("✓ 已標記淘汰", "ok");
  };
}

async function confirmEliminate(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  if (c.status !== "淘汰中") {
    window.toast("只有「淘汰中」狀態的線路才能確認淘汰", "bad");
    return;
  }
  const ok = await window.confirmAsync({
    title: `確認淘汰線路「${c.name}」?`,
    body: "從今天起,此線路的安裝數**不再計入結算金額**(但匯入紀錄會繼續保留)。",
    okText: "確認淘汰",
    danger: true,
  });
  if (!ok) return;
  update((st) => {
    const target = st.channels.find((x) => x.id === channelId);
    if (!target) return;
    target.status = "已淘汰";
    target.confirmed_eliminated_at = todayTaipei();
  }, "確認淘汰");
  window.modal.close();
  window.toast("✓ 已切換到「已淘汰」", "ok");
}

async function revertToActive(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  const ok = await window.confirmAsync({
    title: `恢復線路「${c.name}」為啟用中?`,
    body: "會清掉所有淘汰相關欄位(標記日 / 截止日 / 模式 / 確認日)。歷史的安裝數據紀錄不動。",
    okText: "恢復啟用",
  });
  if (!ok) return;
  update((st) => {
    const target = st.channels.find((x) => x.id === channelId);
    if (!target) return;
    target.status = "啟用中";
    target.eliminated_at = null;
    target.billing_end_date = null;
    target.elimination_mode = null;
    target.confirmed_eliminated_at = null;
  }, "恢復啟用");
  window.modal.close();
  window.toast("✓ 已恢復啟用", "ok");
}

async function deleteChannel(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;

  const installRefs = (s.install_data || []).filter((d) => d.channel_id === channelId);
  const detail = installRefs.length > 0
    ? [
        `⚠️ 目前有 ${installRefs.length} 筆安裝數據引用此線路`,
        "刪除後這些紀錄會變孤兒,內部報表會少這條線路的資料",
        "建議改用「生命週期 → 標記淘汰」保留歷史",
      ]
    : null;

  const ok = await window.confirmAsync({
    title: `刪除線路「${c.name}」?`,
    body: installRefs.length > 0
      ? "此線路有歷史安裝數據,通常應該「標記淘汰」而非直接刪除。"
      : "確認刪除?",
    okText: "刪除",
    danger: true,
    details: detail,
  });
  if (!ok) return;
  update((st) => {
    st.channels = st.channels.filter((x) => x.id !== channelId);
  }, "刪除線路");
  window.toast("已刪除", "ok");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
