// 線路管理:站長分組 + 搜尋 + 排序 + 本月成效 + per-product 展開 + CRUD + 淘汰生命週期。
//
// 為 150+ 線路的使用情境設計:
//   - 站長分組摺疊(記憶狀態)避免一次看全部
//   - 搜尋 / 狀態 / 排序工具列
//   - 每線路一列顯示本月安裝 / 結算 / 不重複 / 質量比(垂直決策需要的數字)
//   - 點線路展開 → 看 per-product 拆分(同支線路 AV9 跑了多少、JK 跑了多少)
//   - 質量比(不重複/廠商)< 70% 標黃、< 50% 標紅(可疑刷量)

import { getState, update, uid } from "../state.js";
import { todayTaipei, nowTaipeiStamp } from "../lib/dates.js";
import { CHANNEL_STATUSES, ELIMINATION_MODES, channelStatusColor } from "../schema.js";
import { buildChannelMonthMatrix, getEffectivePrice, summarizeAllPublishers } from "../domain/billing.js";

const VIEW_KEY = "cpa_channels_view_v1";
const EXPAND_KEY = "cpa_channels_expand_v1";

function loadView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY) || "{}"); } catch { return {}; }
}
function saveView(v) {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch {}
}
function loadExpand() {
  try { return JSON.parse(localStorage.getItem(EXPAND_KEY) || "{}"); } catch { return {}; }
}
function saveExpand(v) {
  try { localStorage.setItem(EXPAND_KEY, JSON.stringify(v)); } catch {}
}

export function render(root) {
  const s = getState();
  const view = Object.assign({
    search: "",
    status: "all",     // all / 啟用中 / 淘汰中 / 已淘汰
    publisher_id: "",  // 空 = 全部
    sort: "cost_desc", // cost_desc / installs_desc / unique_desc / quality_asc / name / created
    month: s.settings?.current_month || todayTaipei().slice(0, 7),
  }, loadView());
  saveView(view);

  const expand = loadExpand();   // { [groupKey]: true/false, [channelId]: true } 共用
  const publishers = s.publishers || [];
  const channels = s.channels || [];
  const today = todayTaipei();

  // 本月 metrics
  const matrix = buildChannelMonthMatrix(s, view.month);

  // 站長餘額 lookup
  const pubSummary = Object.fromEntries(summarizeAllPublishers(s, today).map((r) => [r.publisher.id, r]));
  const threshold = Number(s.settings?.low_balance_threshold_rmb || 200);

  // 套用 filter
  let filteredChannels = channels.slice();
  if (view.search) {
    const q = view.search.toLowerCase();
    filteredChannels = filteredChannels.filter((c) => {
      const pub = publishers.find((p) => p.id === c.publisher_id);
      return c.name.toLowerCase().includes(q) || (pub?.name || "").toLowerCase().includes(q);
    });
  }
  if (view.status !== "all") {
    filteredChannels = filteredChannels.filter((c) => (c.status || "啟用中") === view.status);
  }
  if (view.publisher_id) {
    filteredChannels = filteredChannels.filter((c) => c.publisher_id === view.publisher_id);
  }

  // 排序
  const sortFn = {
    cost_desc: (a, b) => (matrix.get(b.id)?.total.cost_rmb || 0) - (matrix.get(a.id)?.total.cost_rmb || 0),
    installs_desc: (a, b) => (matrix.get(b.id)?.total.installs_billed || 0) - (matrix.get(a.id)?.total.installs_billed || 0),
    unique_desc: (a, b) => (matrix.get(b.id)?.total.installs_unique || 0) - (matrix.get(a.id)?.total.installs_unique || 0),
    quality_asc: (a, b) => qualityRatio(matrix.get(a.id)?.total) - qualityRatio(matrix.get(b.id)?.total),
    name: (a, b) => a.name.localeCompare(b.name),
    created: (a, b) => (a.created_at || "").localeCompare(b.created_at || ""),
  }[view.sort] || ((a, b) => 0);
  filteredChannels.sort(sortFn);

  // 站長分組
  const grouped = new Map();
  for (const c of filteredChannels) {
    if (!grouped.has(c.publisher_id)) grouped.set(c.publisher_id, []);
    grouped.get(c.publisher_id).push(c);
  }

  // 統計
  const totalChannels = channels.length;
  const stats = {
    active: channels.filter((c) => c.status === "啟用中").length,
    eliminating: channels.filter((c) => c.status === "淘汰中").length,
    eliminated: channels.filter((c) => c.status === "已淘汰").length,
  };
  const monthTotalCost = Array.from(matrix.values()).reduce((s, r) => s + r.total.cost_rmb, 0);
  const monthTotalInstalls = Array.from(matrix.values()).reduce((s, r) => s + r.total.installs_billed, 0);

  // 截止日到提醒
  const pendingConfirm = channels.filter((c) =>
    c.status === "淘汰中" && c.billing_end_date && c.billing_end_date <= today
  );

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>🔌 線路</h1>
        <div class="desc">${totalChannels} 條 · 啟用 ${stats.active} · 淘汰中 ${stats.eliminating} · 已淘汰 ${stats.eliminated} · ${view.month} 結算 ¥${formatNum(monthTotalCost)} · 安裝 ${formatNum(monthTotalInstalls)}</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add" ${publishers.length === 0 ? "disabled" : ""}>＋ 新增線路</button>
      </div>
    </div>

    ${publishers.length === 0 ? `
      <div class="card">
        <p class="ink-2" style="margin:0">⚠️ 尚未建立站長,請先到「站長」頁建立。</p>
      </div>
    ` : ""}

    ${pendingConfirm.length > 0 ? `
      <div class="card" style="border-left:3px solid #ff9800;background:#fff8e1;margin-bottom:8px">
        <h2 style="margin-top:0">⏰ ${pendingConfirm.length} 條線路截止計費日已到</h2>
        <p class="ink-2" style="margin:6px 0;font-size:13px">截止日 ≤ 今天(${today}),點下方一鍵切到「已淘汰」(停止計費):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${pendingConfirm.map((c) => `
            <button data-confirm-elim="${esc(c.id)}" class="ch-pending-btn">
              ✓ ${esc(c.name)} · 截止 ${esc(c.billing_end_date)}
            </button>
          `).join("")}
        </div>
      </div>
    ` : ""}

    <div class="card ch-toolbar">
      <div class="ch-toolbar-row">
        <input type="search" id="f-search" placeholder="🔍 搜尋渠道 / 站長..." value="${esc(view.search)}" />
        <select id="f-publisher">
          <option value="">全部站長</option>
          ${publishers.map((p) => `<option value="${esc(p.id)}" ${p.id === view.publisher_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <select id="f-status">
          <option value="all" ${view.status === "all" ? "selected" : ""}>全部狀態</option>
          ${CHANNEL_STATUSES.map((st) => `<option value="${st}" ${view.status === st ? "selected" : ""}>${st}</option>`).join("")}
        </select>
        <select id="f-month-ch">
          ${listMonths(6, view.month).map((m) => `<option value="${m}" ${m === view.month ? "selected" : ""}>${m}</option>`).join("")}
        </select>
        <select id="f-sort">
          <option value="cost_desc" ${view.sort === "cost_desc" ? "selected" : ""}>排序:本月結算 ↓</option>
          <option value="installs_desc" ${view.sort === "installs_desc" ? "selected" : ""}>排序:廠商安裝 ↓</option>
          <option value="unique_desc" ${view.sort === "unique_desc" ? "selected" : ""}>排序:不重複安裝 ↓</option>
          <option value="quality_asc" ${view.sort === "quality_asc" ? "selected" : ""}>排序:質量比 ↑(看可疑線路)</option>
          <option value="name" ${view.sort === "name" ? "selected" : ""}>排序:渠道名稱</option>
          <option value="created" ${view.sort === "created" ? "selected" : ""}>排序:建立時間</option>
        </select>
        <button id="btn-expand-all" class="ch-toolbar-mini">全部展開</button>
        <button id="btn-collapse-all" class="ch-toolbar-mini">全部摺疊</button>
      </div>
    </div>

    <div class="card mt-8" style="padding:0">
      ${filteredChannels.length === 0 ? `
        <p class="ink-2" style="margin:0;padding:14px">${channels.length === 0 ? "尚無線路,按右上「＋ 新增線路」開始" : "沒有符合條件的線路"}</p>
      ` : renderGroupedTable(grouped, publishers, matrix, pubSummary, threshold, expand, view.month)}
    </div>
  `;

  bindHandlers(root, view, expand);
}

function renderGroupedTable(grouped, publishers, matrix, pubSummary, threshold, expand, ym) {
  const pubById = Object.fromEntries(publishers.map((p) => [p.id, p]));
  // 各站長依本月總結算降序
  const sortedPubIds = Array.from(grouped.keys()).sort((a, b) => {
    const sa = grouped.get(a).reduce((s, c) => s + (matrix.get(c.id)?.total.cost_rmb || 0), 0);
    const sb = grouped.get(b).reduce((s, c) => s + (matrix.get(c.id)?.total.cost_rmb || 0), 0);
    return sb - sa;
  });

  return `
    <table class="ch-table">
      <thead>
        <tr>
          <th class="ch-col-name">渠道 / 站長</th>
          <th class="ch-col-status">狀態</th>
          <th class="num">單價</th>
          <th class="num">本月廠商安裝</th>
          <th class="num">本月不重複</th>
          <th class="num">本月結算</th>
          <th class="num">質量比</th>
          <th class="ch-col-actions"></th>
        </tr>
      </thead>
      <tbody>
        ${sortedPubIds.map((pubId) => {
          const pub = pubById[pubId];
          const list = grouped.get(pubId);
          const groupKey = `pub:${pubId}`;
          const groupOpen = expand[groupKey] !== false;  // 預設展開
          const groupCost = list.reduce((s, c) => s + (matrix.get(c.id)?.total.cost_rmb || 0), 0);
          const groupInstalls = list.reduce((s, c) => s + (matrix.get(c.id)?.total.installs_billed || 0), 0);
          const groupUnique = list.reduce((s, c) => s + (matrix.get(c.id)?.total.installs_unique || 0), 0);
          const balance = pubSummary[pubId]?.balance_rmb;
          const balLow = balance != null && balance < threshold;
          return `
            <tr class="ch-group-header" data-toggle-group="${esc(groupKey)}">
              <td colspan="8">
                <span class="ch-arrow">${groupOpen ? "▼" : "▶"}</span>
                <strong>${esc(pub?.name || "⚠️ 站長已刪除")}</strong>
                <span class="ink-3" style="margin-left:8px;font-size:12px">
                  ${list.length} 條 · 本月安裝 ${formatNum(groupInstalls)} · 不重複 ${formatNum(groupUnique)} · 結算 ¥${formatNum(groupCost)}
                  ${balance != null ? ` · 餘額 <span style="color:${balance < 0 ? "#d32f2f" : (balLow ? "#f57c00" : "#666")};font-weight:600">¥${formatNum(balance)}</span>` : ""}
                  ${balance != null && balance < 0 ? ' <span style="color:#d32f2f">⚠️ 欠款</span>' : (balLow ? ' <span style="color:#f57c00">⚠️ 低餘額</span>' : "")}
                </span>
              </td>
            </tr>
            ${groupOpen ? list.map((c) => channelRow(c, matrix.get(c.id), expand, ym)).join("") : ""}
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

function channelRow(c, m, expand, ym) {
  const rowKey = `ch:${c.id}`;
  const rowOpen = !!expand[rowKey];
  const total = m?.total || { installs_billed: 0, installs_unique: 0, cost_rmb: 0 };
  const price = getEffectivePriceDisplay(c);
  const status = c.status || "啟用中";
  const statusColor = channelStatusColor(status);
  const qRatio = qualityRatio(total);
  const qClass = qRatio < 0.5 ? "q-bad" : (qRatio < 0.7 ? "q-warn" : "");
  const qLabel = total.installs_billed > 0 ? `${(qRatio * 100).toFixed(0)}%` : "—";
  const hasData = total.installs_billed > 0;

  const productBreakdown = m && rowOpen ? renderProductBreakdown(m) : "";

  return `
    <tr class="ch-row ${rowOpen ? "ch-row-open" : ""}" data-toggle-row="${esc(rowKey)}">
      <td class="ch-col-name">
        <span class="ch-arrow-mini">${rowOpen ? "▼" : "▶"}</span>
        <strong>${esc(c.name)}</strong>
        ${c.notes ? `<div class="ink-3" style="font-size:11px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px">${esc(c.notes.split("\n")[0])}</div>` : ""}
      </td>
      <td class="ch-col-status">
        <span class="ch-status-pill" style="background:${statusColor}">${esc(status)}</span>
        ${c.billing_end_date ? `<div class="ink-3" style="font-size:10px;margin-top:2px">截止 ${esc(c.billing_end_date)}</div>` : ""}
      </td>
      <td class="num">${price}</td>
      <td class="num">${hasData ? formatNum(total.installs_billed) : '<span class="ink-3">—</span>'}</td>
      <td class="num">${hasData ? formatNum(total.installs_unique) : '<span class="ink-3">—</span>'}</td>
      <td class="num"><strong>${hasData ? "¥" + formatNum(total.cost_rmb) : '<span class="ink-3">—</span>'}</strong></td>
      <td class="num ${qClass}">${qLabel}</td>
      <td class="ch-col-actions" onclick="event.stopPropagation()">
        <button data-edit="${esc(c.id)}">編輯</button>
        <button data-lifecycle="${esc(c.id)}">生命週期</button>
        <button class="danger" data-del="${esc(c.id)}">刪</button>
      </td>
    </tr>
    ${productBreakdown}
  `;
}

function renderProductBreakdown(m) {
  const items = Array.from(m.by_product.values()).sort((a, b) => b.cost_rmb - a.cost_rmb);
  if (items.length === 0) {
    return `
      <tr class="ch-row-detail">
        <td colspan="8" class="ink-3" style="padding:6px 16px 10px 56px;font-size:12px">本月此線路無安裝數據</td>
      </tr>
    `;
  }
  return `
    <tr class="ch-row-detail">
      <td colspan="8" style="padding:6px 16px 10px 56px">
        <table class="ch-product-breakdown">
          <thead>
            <tr>
              <th>產品</th>
              <th class="num">廠商安裝</th>
              <th class="num">不重複</th>
              <th class="num">結算 RMB</th>
              <th class="num">質量比</th>
              <th class="num">CPI(RMB)</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((p) => {
              const q = p.installs_billed > 0 ? p.installs_unique / p.installs_billed : 0;
              const qC = q < 0.5 ? "q-bad" : (q < 0.7 ? "q-warn" : "");
              const cpi = p.installs_unique > 0 ? p.cost_rmb / p.installs_unique : null;
              return `
                <tr>
                  <td>${esc(p.product_name)}</td>
                  <td class="num">${formatNum(p.installs_billed)}</td>
                  <td class="num">${formatNum(p.installs_unique)}</td>
                  <td class="num">¥${formatNum(p.cost_rmb)}</td>
                  <td class="num ${qC}">${p.installs_billed > 0 ? (q * 100).toFixed(0) + "%" : "—"}</td>
                  <td class="num">${cpi != null ? cpi.toFixed(2) : "—"}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </td>
    </tr>
  `;
}

function bindHandlers(root, view, expand) {
  const q = (sel) => root.querySelector(sel);

  q("#f-search")?.addEventListener("input", debounce(() => {
    view.search = q("#f-search").value;
    saveView(view);
    render(root);
  }, 200));
  q("#f-publisher")?.addEventListener("change", () => {
    view.publisher_id = q("#f-publisher").value;
    saveView(view);
    render(root);
  });
  q("#f-status")?.addEventListener("change", () => {
    view.status = q("#f-status").value;
    saveView(view);
    render(root);
  });
  q("#f-month-ch")?.addEventListener("change", () => {
    view.month = q("#f-month-ch").value;
    saveView(view);
    render(root);
  });
  q("#f-sort")?.addEventListener("change", () => {
    view.sort = q("#f-sort").value;
    saveView(view);
    render(root);
  });
  q("#btn-expand-all")?.addEventListener("click", () => {
    const s = getState();
    for (const p of s.publishers || []) expand[`pub:${p.id}`] = true;
    for (const c of s.channels || []) expand[`ch:${c.id}`] = true;
    saveExpand(expand);
    render(root);
  });
  q("#btn-collapse-all")?.addEventListener("click", () => {
    const s = getState();
    for (const p of s.publishers || []) expand[`pub:${p.id}`] = false;
    for (const c of s.channels || []) expand[`ch:${c.id}`] = false;
    saveExpand(expand);
    render(root);
  });

  q("#btn-add")?.addEventListener("click", () => openEditor(null));

  root.querySelectorAll("[data-toggle-group]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("button")) return;
      const key = el.dataset.toggleGroup;
      expand[key] = expand[key] === false ? true : false;
      saveExpand(expand);
      render(root);
    };
  });
  root.querySelectorAll("[data-toggle-row]").forEach((el) => {
    el.onclick = (e) => {
      if (e.target.closest("button")) return;
      const key = el.dataset.toggleRow;
      expand[key] = !expand[key];
      saveExpand(expand);
      render(root);
    };
  });
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openEditor(el.dataset.edit); };
  });
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); deleteChannel(el.dataset.del); };
  });
  root.querySelectorAll("[data-lifecycle]").forEach((el) => {
    el.onclick = (e) => { e.stopPropagation(); openLifecycle(el.dataset.lifecycle); };
  });
  root.querySelectorAll("[data-confirm-elim]").forEach((el) => {
    el.onclick = () => confirmEliminate(el.dataset.confirmElim);
  });
}

function qualityRatio(total) {
  if (!total || total.installs_billed <= 0) return 1;  // 沒安裝視為「無從判斷」,不標紅
  return total.installs_unique / total.installs_billed;
}

function getEffectivePriceDisplay(c) {
  const s = getState();
  const own = c.cpa_price_rmb;
  if (own != null && Number.isFinite(Number(own))) {
    return `¥${Number(own).toFixed(2)}`;
  }
  const pub = (s.publishers || []).find((p) => p.id === c.publisher_id);
  const def = pub?.default_cpa_price_rmb;
  if (def != null) return `<span class="ink-3">¥${Number(def).toFixed(2)}</span>`;
  return '<span class="ink-3">—</span>';
}

function formatNum(v) {
  if (v == null || !Number.isFinite(Number(v))) return "0";
  const n = Number(v);
  if (Math.abs(n) >= 1000 || Number.isInteger(n)) return Math.round(n).toLocaleString("zh-TW");
  return n.toLocaleString("zh-TW", { maximumFractionDigits: 2 });
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

function debounce(fn, ms) {
  let t;
  return (...a) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ─── 以下保留原本的 CRUD + 生命週期 modals ─────────────────

function openEditor(channelId) {
  const s = getState();
  const isNew = !channelId;
  const c = isNew
    ? { id: uid("ch"), name: "", publisher_id: (s.publishers[0]?.id) || "", cpa_price_rmb: null, status: "啟用中", notes: "" }
    : s.channels.find((x) => x.id === channelId);
  if (!c) return;
  if (isNew && !c.publisher_id) { window.toast("先建立至少一位站長", "bad"); return; }

  const publishers = s.publishers || [];
  const pub = publishers.find((p) => p.id === c.publisher_id);
  const defaultPriceHint = pub?.default_cpa_price_rmb != null
    ? `站長預設:${Number(pub.default_cpa_price_rmb).toFixed(2)} RMB`
    : "站長未設預設單價";

  const html = `
    <h2>${isNew ? "＋ 新增線路" : "✎ 編輯線路"}</h2>
    <div class="field">
      <label>渠道名稱 * <span class="ink-3" style="font-weight:400">(匯入時的唯一比對鍵,要跟試算表完全一致)</span></label>
      <input id="f-name" type="text" value="${esc(c.name || "")}" placeholder="例:rehuo23" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">同站長下這個名稱會用在所有產品(AV9 + JK 等),不用為每個產品另外建一條</div>
    </div>
    <div class="field mt-8">
      <label>所屬站長 *</label>
      <select id="f-pub">
        ${publishers.map((p) => `<option value="${esc(p.id)}" ${p.id === c.publisher_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field mt-8">
      <label>CPA 單價(RMB)<span class="ink-3" style="font-weight:400">(留空沿用站長預設)</span></label>
      <input id="f-price" type="number" step="0.01" min="0" value="${c.cpa_price_rmb ?? ""}" placeholder="留空 = 沿用站長" />
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

function openLifecycle(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  const pub = (s.publishers || []).find((p) => p.id === c.publisher_id);
  const status = c.status || "啟用中";
  const actions = buildLifecycleActions(status);

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
    <div class="modal-actions"><button id="btn-close">關閉</button></div>
  `;
  const dlg = window.modal.open(html);
  dlg.querySelector("#btn-close").onclick = () => window.modal.close();
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
  if (status === "啟用中") return [{ act: "mark-eliminate", title: "🟧 標記淘汰", desc: "進入「淘汰中」,要填截止計費日與淘汰模式" }];
  if (status === "淘汰中") return [
    { act: "confirm-eliminate", title: "✅ 確認淘汰", desc: "切換到「已淘汰」,從確認日起不再計入結算金額" },
    { act: "revert", title: "↩ 恢復啟用", desc: "改變主意,回到「啟用中」,清掉淘汰相關欄位" },
  ];
  if (status === "已淘汰") return [{ act: "revert", title: "↩ 恢復啟用", desc: "重新合作,回到「啟用中」(歷史紀錄保留)" }];
  return [];
}

function buildLifecycleSummary(c) {
  const rows = [];
  if (c.eliminated_at) rows.push(["標記淘汰", c.eliminated_at]);
  if (c.elimination_mode) rows.push(["淘汰模式", c.elimination_mode === "winding-down" ? "winding-down(繼續計費)" : "stop(停止計費)"]);
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
    <div class="ink-2" style="font-size:13px;margin-bottom:6px">線路:<strong>${esc(c.name)}</strong></div>
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
          <div class="ink-3" style="font-size:12px;margin-top:2px">已通知站長但對方還在處理,**繼續計費**並顯示淘汰標記</div>
        </label>
      </div>
    </div>
    <div class="field mt-8">
      <label>截止計費日</label>
      <input id="f-end-date" type="date" value="${today}" />
    </div>
    <div class="field mt-8">
      <label>備註(選填)</label>
      <input id="f-notes-add" type="text" placeholder="例:成效太差 / 廠商主動下架" />
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
    body: "從今天起,此線路的安裝數不再計入結算金額(匯入紀錄保留)。",
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
    ? [`⚠️ 目前有 ${installRefs.length} 筆安裝數據引用此線路`, "刪除後這些紀錄會變孤兒,內部報表會少資料", "建議改用「生命週期 → 標記淘汰」"]
    : null;
  const ok = await window.confirmAsync({
    title: `刪除線路「${c.name}」?`,
    body: installRefs.length > 0 ? "此線路有歷史安裝數據,通常應該「標記淘汰」而非直接刪除。" : "確認刪除?",
    okText: "刪除", danger: true, details: detail,
  });
  if (!ok) return;
  update((st) => { st.channels = st.channels.filter((x) => x.id !== channelId); }, "刪除線路");
  window.toast("已刪除", "ok");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
