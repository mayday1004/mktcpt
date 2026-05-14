// 縮網址管理:per-(線路, 產品) URL + 全站新網域 cascade + 站長分組批次通知。
//
// 模型(對齊 CPT 的概念,簡化在 CPA 上):
//   - settings.short_url_new_domain      全站當前新網域
//   - settings.short_url_prefix_map      { L1: "l1", L3: "l3", L5: "l5" } — 同 CPT
//   - publisher.short_url_type           "L1" / "L3" / "L5" / ""(不採用)
//   - product.short_url_code             縮網址代碼(例:AV9 → "9"、JK → "jk")
//   - channel.short_url_params           { [product_id]: 縮網址參數 }(per-product;沒填走自動帶入)
//   - channel.short_url_old_override     per-channel 舊網域 snapshot
//   - channel.short_url_new_override     per-channel 新網域覆寫(罕用)
//   - channel.short_url_notified         該 channel 是否已通知
//
// 自動帶入規則(channel.short_url_params[product_id] 為空時):
//   param = product.short_url_code + channel.name        例:9rehuo23 / jkrehuo23
//
// URL 構造:
//   https://{prefix_map[publisher.short_url_type]}.{domain}/{param}
//
// 顯示規則:
//   - Row = (channel × product) 組合
//   - Filter 條件:
//       publisher.short_url_type 必須非空
//       product.short_url_code 必須非空
//       channel.status !== "已淘汰"
//       (channel × product) 必須有 install_data 或 explicit param override(避免無關產品塞滿表)
//   - Group by publisher;同 publisher 內依 channel 名稱排序;同 channel 內依 product 名稱

import { getState, update } from "../state.js";
import { todayTaipei } from "../lib/dates.js";
import { SHORT_URL_TYPE_LABEL } from "../schema.js";

// ─── URL helpers ──────────────────────────────────────
function buildUrl(prefix, domain, param) {
  if (!domain || !param) return "";
  const d = String(domain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!d) return "";
  const p = String(prefix || "").trim().replace(/\.$/, "").toLowerCase();
  const host = p ? `${p}.${d}` : d;
  return `https://${host}/${param}`;
}

function getPrefix(settings, publisher) {
  const map = settings?.short_url_prefix_map || {};
  const slot = publisher?.short_url_type || "";
  if (!slot) return "";
  return String(map[slot] ?? slot).toLowerCase();
}

function getParam(channel, product) {
  const override = channel.short_url_params?.[product.id];
  if (override) return override;
  if (!product.short_url_code) return "";  // 沒設代碼 → 無自動帶入
  return `${product.short_url_code}${channel.name || ""}`;
}

function getNewDomain(channel, settings) {
  return channel.short_url_new_override || settings.short_url_new_domain || "";
}

function getOldDomain(channel) {
  return channel.short_url_old_override || "";
}

// 建立 (channel × product) row 清單
function buildRows(state) {
  const settings = state.settings || {};
  const pubById = Object.fromEntries((state.publishers || []).map((p) => [p.id, p]));
  const prById = Object.fromEntries((state.products || []).map((p) => [p.id, p]));
  // 收集每 channel 跑過的產品 id
  const installedByChannel = new Map();
  for (const d of state.install_data || []) {
    if (!installedByChannel.has(d.channel_id)) installedByChannel.set(d.channel_id, new Set());
    installedByChannel.get(d.channel_id).add(d.product_id);
  }

  const rows = [];
  for (const ch of state.channels || []) {
    if (ch.status === "已淘汰") continue;
    const pub = pubById[ch.publisher_id];
    if (!pub || !pub.short_url_type) continue;  // 站長必須採用連結
    const explicitParams = ch.short_url_params || {};
    const installed = installedByChannel.get(ch.id) || new Set();
    // 列入考量的 product:有 install_data 或有 explicit param
    const candidateProductIds = new Set([...installed, ...Object.keys(explicitParams)]);
    for (const pid of candidateProductIds) {
      const pr = prById[pid];
      if (!pr) continue;
      if (!pr.short_url_code && !explicitParams[pid]) continue;  // 沒代碼 又 沒手填 → 跳過
      const param = getParam(ch, pr);
      if (!param) continue;
      rows.push({
        channel: ch,
        publisher: pub,
        product: pr,
        param,
        is_override: !!explicitParams[pid],
        new_domain: getNewDomain(ch, settings),
        old_domain: getOldDomain(ch),
        prefix: getPrefix(settings, pub),
      });
    }
  }
  return rows;
}

// Group by publisher
function groupRows(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.publisher.id)) {
      groups.set(r.publisher.id, { publisher: r.publisher, rows: [] });
    }
    groups.get(r.publisher.id).rows.push(r);
  }
  // group 內排序:channel name asc → product name asc
  for (const g of groups.values()) {
    g.rows.sort((a, b) =>
      (a.channel.name || "").localeCompare(b.channel.name || "") ||
      (a.product.name || "").localeCompare(b.product.name || "")
    );
  }
  return Array.from(groups.values()).sort((a, b) => {
    const ma = a.rows.length >= 2 ? 0 : 1;
    const mb = b.rows.length >= 2 ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return (a.publisher.name || "~").localeCompare(b.publisher.name || "~");
  });
}

// Group 內所有 row 是否已通知:用「該 group 涉及的 channel 都 notified」判定
function isGroupNotified(group) {
  const channelIds = new Set(group.rows.map((r) => r.channel.id));
  return Array.from(channelIds).every((cid) => group.rows.find((r) => r.channel.id === cid)?.channel.short_url_notified);
}

// 群組複製文字 — 簡體
function buildGroupCopyText(group, settings) {
  const pub = group.publisher;
  // 依 channel 分組(同 channel 多 product 合一塊)
  const byChannel = new Map();
  for (const r of group.rows) {
    if (!byChannel.has(r.channel.id)) byChannel.set(r.channel.id, { channel: r.channel, items: [] });
    byChannel.get(r.channel.id).items.push(r);
  }
  const blocks = Array.from(byChannel.values()).map(({ channel, items }) => {
    const lines = [`[${channel.name}]`];
    for (const r of items) {
      const newUrl = buildUrl(r.prefix, r.new_domain, r.param);
      const oldUrl = r.old_domain ? buildUrl(r.prefix, r.old_domain, r.param) : "";
      if (oldUrl) {
        lines.push(`${r.product.name}`);
        lines.push(`  旧:${oldUrl}`);
        lines.push(`  新:${newUrl || "(未设定)"}`);
      } else {
        lines.push(`${r.product.name}:${newUrl || "(未设定)"}`);
      }
    }
    return lines.join("\n");
  });
  const anyHasOld = group.rows.some((r) => !!r.old_domain);
  const greeting = anyHasOld
    ? `${pub.name} 你好,麻烦广告链接更换`
    : `${pub.name} 新合作`;
  return greeting + "\n" + blocks.join("\n\n");
}

// ─── render ───────────────────────────────────────────
export function render(root) {
  const s = getState();
  const settings = s.settings || {};

  const rows = buildRows(s);
  const groups = groupRows(rows);

  // 站長 count(以 row 為 unit;通知狀態以「該 channel 是否通知」為主,所以聚合用 channel set)
  const allChannelIds = new Set();
  const notifiedChannelIds = new Set();
  for (const r of rows) {
    allChannelIds.add(r.channel.id);
    if (r.channel.short_url_notified) notifiedChannelIds.add(r.channel.id);
  }
  const totalChannels = allChannelIds.size;
  const notifiedCount = notifiedChannelIds.size;
  const unnotifiedCount = totalChannels - notifiedCount;

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>🔗 縮網址管理</h1>
        <div class="desc" style="max-width:760px;line-height:1.5">
          每條線路依「採用連結」前綴 + 產品代碼 + 渠道名稱組合 URL。同站長多條線路一次通知,可批次複製 + 標記已通知。
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">全站當前網址</h2>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:4px">
        <div class="field" style="flex:2;min-width:240px;margin-bottom:0">
          <label>當前新網域(僅網域,例:abc.com)</label>
          <input id="su-domain" type="text" value="${esc(settings.short_url_new_domain || "")}" placeholder="例:abc.com" />
        </div>
        <button id="btn-apply" class="primary">💾 套用為新網址</button>
        <button id="btn-open-prefix" style="border:1px solid #d8d8d8;background:#fff;padding:8px 14px;border-radius:6px">🔧 縮網址前綴</button>
      </div>
      <div class="ink-3" style="font-size:12px;margin-top:8px;line-height:1.5">
        套用流程:① 所有線路當下的有效新網址 → snapshot 為各自的舊網域 · ② 全站當前網域 ← 你輸入的值 · ③ 所有通知狀態重置為「未通知」<br>
        URL 形式:<code>https://{prefix}.{domain}/{param}</code>;param 預設 = 產品縮網址代碼 + 渠道名稱(✎ 可覆寫)
      </div>
    </div>

    <div class="card mt-8" style="padding:0">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eee">
        <div>
          <strong>線路清單</strong>
          <span class="ink-3" style="font-size:13px;margin-left:6px">${rows.length} 個 (線路 × 產品) · ${totalChannels} 條線路</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;font-size:13px">
          <span style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:10px;font-size:12px">✅ 已通知 ${notifiedCount}</span>
          <span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:10px;font-size:12px">⏳ 未通知 ${unnotifiedCount}</span>
          ${notifiedCount > 0 ? `<button id="btn-reset-notified" style="font-size:12px;padding:4px 8px">↺ 全標未通知</button>` : ""}
        </div>
      </div>
      ${rows.length === 0 ? `
        <p class="ink-2" style="padding:14px;margin:0">尚無資料,需要:① 至少一位站長設「採用連結」≠ 不採用 ② 至少一個產品有「縮網址代碼」 ③ 線路有對應產品的安裝數據(或手動覆寫參數)</p>
      ` : `
        <table class="su-table">
          <thead>
            <tr>
              <th style="width:160px">渠道 / 產品</th>
              <th style="width:60px">類型</th>
              <th style="width:130px">參數</th>
              <th>舊連結</th>
              <th>新連結</th>
              <th style="width:120px;text-align:center">操作</th>
            </tr>
          </thead>
          <tbody>
            ${groups.map((g) => renderGroup(g, settings)).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;

  bindHandlers(root);
}

function renderGroup(g, settings) {
  const pub = g.publisher;
  const channelIds = Array.from(new Set(g.rows.map((r) => r.channel.id)));
  const isMulti = channelIds.length >= 2;
  const allNotified = isGroupNotified(g);
  const rowCount = g.rows.length;

  const groupHeader = isMulti ? `
    <tr class="su-group-header">
      <td colspan="6">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <strong>${esc(pub.name)}</strong>
            <span style="margin-left:4px;padding:1px 6px;background:#e3f2fd;color:#1565c0;border-radius:4px;font-size:11px">${pub.short_url_type} · ${SHORT_URL_TYPE_LABEL[pub.short_url_type]}</span>
            <span class="ink-3" style="font-size:12px;margin-left:6px">${channelIds.length} 條 · ${rowCount} 個 URL · ${pub.contact_info ? esc(pub.contact_info) : "未設聯繫資料"}</span>
            <span style="margin-left:10px;font-size:12px;color:${allNotified ? "#155724" : "#856404"}">${allNotified ? "✅ 全部已通知" : "⏳ 待通知"}</span>
          </div>
          <div>
            <button class="primary su-group-copy-btn" data-group-copy="${pub.id}">📋 批次通知 (${rowCount})</button>
            <button data-group-toggle="${pub.id}" data-to-state="${!allNotified}" style="margin-left:4px">${allNotified ? "↺ 標未通知" : "✓ 標已通知"}</button>
          </div>
        </div>
      </td>
    </tr>
  ` : "";

  return groupHeader + g.rows.map((r, i) => renderRow(r, settings, isMulti, i, g.rows)).join("");
}

function renderRow(r, settings, isInGroup, i, allRowsInGroup) {
  const newUrl = buildUrl(r.prefix, r.new_domain, r.param);
  const oldUrl = r.old_domain ? buildUrl(r.prefix, r.old_domain, r.param) : "";
  const channelKey = `ch:${r.channel.id}:${r.product.id}`;
  // 是否為 channel 第一行(用來顯示渠道名;後續同 channel 的 row 縮排)
  const isFirstOfChannel = i === 0 || allRowsInGroup[i - 1].channel.id !== r.channel.id;

  return `
    <tr class="${isInGroup ? "su-group-row" : ""}">
      <td>
        ${isFirstOfChannel ? `<strong>${esc(r.channel.name)}</strong>` : '<span style="padding-left:14px;color:#999">↳</span>'}
        <div class="ink-3" style="font-size:11px;margin-left:${isFirstOfChannel ? "0" : "16"}px">${esc(r.product.name)}</div>
      </td>
      <td>
        <span style="padding:1px 5px;background:#eef;border-radius:3px;font-size:11px">${esc(r.publisher.short_url_type)}</span>
      </td>
      <td>
        <code style="font-size:12px;background:#f5f5f5;padding:1px 4px;border-radius:3px">${esc(r.param)}</code>
        ${r.is_override ? '' : '<div class="ink-3" style="font-size:10px;margin-top:1px">自動帶入</div>'}
      </td>
      <td>
        ${oldUrl ? `<code style="font-size:12px;word-break:break-all">${esc(oldUrl)}</code>` : '<span class="ink-3" style="font-size:12px">— 新合作</span>'}
      </td>
      <td>
        ${newUrl ? `<code style="font-size:12px;word-break:break-all">${esc(newUrl)}</code>` : '<span class="ink-3" style="font-size:12px">— 未設定</span>'}
      </td>
      <td style="text-align:center;white-space:nowrap">
        ${!isInGroup && isFirstOfChannel ? `
          <button class="su-row-copy-btn" data-row-copy="${esc(r.channel.id)}">📋 通知</button>
          <button data-row-toggle="${esc(r.channel.id)}" style="margin-left:2px;font-size:11px;color:${r.channel.short_url_notified ? "#155724" : "#856404"}">${r.channel.short_url_notified ? "✅" : "⏳"}</button>
        ` : ""}
        <button data-edit-param="${esc(r.channel.id)}:${esc(r.product.id)}" style="margin-left:2px" title="覆寫此 (線路 × 產品) 的縮網址參數">✎</button>
      </td>
    </tr>
  `;
}

function bindHandlers(root) {
  const q = (sel) => root.querySelector(sel);

  q("#btn-apply")?.addEventListener("click", async () => {
    const s = getState();
    const settings = s.settings || {};
    const newDomain = q("#su-domain").value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const curDomain = settings.short_url_new_domain || "";
    if (newDomain === curDomain) { window.toast("沒變動,無須套用", ""); return; }

    const channels = (s.channels || []).filter((c) => c.status !== "已淘汰");
    const ok = await window.confirmAsync({
      title: "套用為新網址?",
      body: `① 把 ${channels.length} 條未淘汰線路當下的新網域 snapshot 為各自的舊網域\n② 全站新網域:「${curDomain || "(空)"}」→「${newDomain || "(空)"}」\n③ 全部標記為「未通知」`,
      okText: "套用",
    });
    if (!ok) return;

    update((st) => {
      const prevDomain = st.settings.short_url_new_domain || "";
      for (const c of st.channels || []) {
        if (c.status === "已淘汰") continue;
        const adCurrentNew = c.short_url_new_override || prevDomain;
        if (adCurrentNew) c.short_url_old_override = adCurrentNew;
        delete c.short_url_new_override;
        c.short_url_notified = false;
      }
      st.settings.short_url_new_domain = newDomain;
    }, `更新全站新網址:${newDomain || "(空)"}`);
    window.toast(`✓ 已套用,通知狀態已重置`, "ok");
  });

  q("#btn-open-prefix")?.addEventListener("click", () => openPrefixMapModal());

  q("#btn-reset-notified")?.addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "全部標為未通知?",
      body: "把所有線路通知狀態重置為未通知(不會動到網址)",
      okText: "重置",
    });
    if (!ok) return;
    update((st) => {
      for (const c of st.channels || []) c.short_url_notified = false;
    }, "重置所有通知狀態");
    window.toast("已重置", "ok");
  });

  // 群組批次複製
  root.querySelectorAll("[data-group-copy]").forEach((btn) => {
    btn.onclick = async () => {
      const pubId = btn.dataset.groupCopy;
      const s = getState();
      const rows = buildRows(s).filter((r) => r.publisher.id === pubId);
      if (rows.length === 0) return;
      const group = { publisher: s.publishers.find((p) => p.id === pubId), rows };
      const text = buildGroupCopyText(group, s.settings || {});
      try {
        await navigator.clipboard.writeText(text);
        const channelIds = new Set(rows.map((r) => r.channel.id));
        update((st) => {
          for (const c of st.channels || []) {
            if (channelIds.has(c.id)) c.short_url_notified = true;
          }
        }, `批次通知 ${pubId}`);
        window.toast(`✓ 已複製 ${rows.length} 條 URL,線路全標已通知`, "ok");
      } catch {
        window.toast("複製失敗,請手動", "bad");
      }
    };
  });

  // 群組通知 toggle
  root.querySelectorAll("[data-group-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const pubId = btn.dataset.groupToggle;
      const nextState = btn.dataset.toState === "true";
      const s = getState();
      const channelIds = new Set((s.channels || []).filter((c) => c.publisher_id === pubId).map((c) => c.id));
      update((st) => {
        for (const c of st.channels || []) {
          if (channelIds.has(c.id)) c.short_url_notified = nextState;
        }
      }, "切換群組通知狀態");
      window.toast(nextState ? "✓ 已標為已通知" : "↺ 已標為未通知", "ok");
    };
  });

  // 單條複製 + 標記
  root.querySelectorAll("[data-row-copy]").forEach((btn) => {
    btn.onclick = async () => {
      const cid = btn.dataset.rowCopy;
      const s = getState();
      const rows = buildRows(s).filter((r) => r.channel.id === cid);
      if (rows.length === 0) return;
      const group = { publisher: rows[0].publisher, rows };
      const text = buildGroupCopyText(group, s.settings || {});
      try {
        await navigator.clipboard.writeText(text);
        update((st) => {
          const target = st.channels.find((x) => x.id === cid);
          if (target) target.short_url_notified = true;
        }, "通知 + 標記");
        window.toast("✓ 已複製並標為已通知", "ok");
      } catch {
        window.toast("複製失敗,請手動", "bad");
      }
    };
  });

  // 單條 toggle
  root.querySelectorAll("[data-row-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const cid = btn.dataset.rowToggle;
      update((st) => {
        const target = st.channels.find((x) => x.id === cid);
        if (target) target.short_url_notified = !target.short_url_notified;
      }, "切換通知狀態");
    };
  });

  // 編輯 per-(channel, product) param 覆寫
  root.querySelectorAll("[data-edit-param]").forEach((btn) => {
    btn.onclick = () => {
      const [cid, pid] = btn.dataset.editParam.split(":");
      openEditParamModal(cid, pid);
    };
  });
}

// 縮網址前綴對應彈窗(同 CPT pattern):編輯 settings.short_url_prefix_map
// 業務 slot 永遠是 L1/L3/L5,實際 URL 子網域前綴可以另外設定(例如 L1 → L7)
const DEFAULT_PREFIX_MAP = { L1: "l1", L3: "l3", L5: "l5" };

function openPrefixMapModal() {
  const s = getState();
  const map = { ...DEFAULT_PREFIX_MAP, ...(s.settings.short_url_prefix_map || {}) };
  const domainSample = s.settings.short_url_new_domain || "abc.com";
  const html = `
    <h2>🔧 縮網址前綴</h2>
    <p class="ink-2" style="font-size:13px;line-height:1.6">
      <strong>業務 slot</strong>(L1/L3/L5)是站長的「採用連結」標籤,在站長頁設定。<br>
      <strong>實際前綴</strong>是 URL 子網域,可以另設(例如 L1 改成 L7),儲存後所有對應 slot 站長的線路 URL 立刻換新前綴,線路資料不動。
    </p>
    <div class="field">
      <label>L1 (權重)</label>
      <input id="pf-L1" type="text" value="${esc(map.L1)}" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">範例 URL:https://<strong id="pf-L1-preview">${esc(String(map.L1).toLowerCase())}</strong>.${esc(domainSample)}/foo</div>
    </div>
    <div class="field mt-8">
      <label>L3 (APK)</label>
      <input id="pf-L3" type="text" value="${esc(map.L3)}" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">範例 URL:https://<strong id="pf-L3-preview">${esc(String(map.L3).toLowerCase())}</strong>.${esc(domainSample)}/foo</div>
    </div>
    <div class="field mt-8">
      <label>L5 (小島)</label>
      <input id="pf-L5" type="text" value="${esc(map.L5)}" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">範例 URL:https://<strong id="pf-L5-preview">${esc(String(map.L5).toLowerCase())}</strong>.${esc(domainSample)}/foo</div>
    </div>
    <div class="modal-actions">
      <button id="pf-cancel">取消</button>
      <button class="primary" id="pf-save">儲存</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);
  ["L1", "L3", "L5"].forEach((slot) => {
    const inp = q(`#pf-${slot}`);
    const pv = q(`#pf-${slot}-preview`);
    if (!inp || !pv) return;
    inp.oninput = () => {
      pv.textContent = (inp.value.trim() || slot).toLowerCase();
    };
  });
  q("#pf-cancel").onclick = () => window.modal.close();
  q("#pf-save").onclick = () => {
    const newMap = {
      L1: (q("#pf-L1").value.trim().toLowerCase() || "l1"),
      L3: (q("#pf-L3").value.trim().toLowerCase() || "l3"),
      L5: (q("#pf-L5").value.trim().toLowerCase() || "l5"),
    };
    for (const [slot, v] of Object.entries(newMap)) {
      if (/[.\/\s]/.test(v)) {
        window.toast(`${slot} 前綴格式錯誤(不可含 . / 或空白)`, "bad");
        return;
      }
    }
    const oldMap = { ...DEFAULT_PREFIX_MAP, ...(s.settings.short_url_prefix_map || {}) };
    const changedSlots = Object.keys(newMap).filter((slot) => newMap[slot] !== oldMap[slot]);
    if (changedSlots.length === 0) {
      window.modal.close();
      window.toast("前綴沒有變更", "");
      return;
    }
    const summary = changedSlots
      .map((slot) => `${slot}: ${oldMap[slot]} → ${newMap[slot]}`).join("、");
    if (!window.confirm(`將更新 ${changedSlots.length} 個 slot 前綴(${summary})。確定?`)) return;
    update((st) => {
      st.settings.short_url_prefix_map = newMap;
    }, "更新縮網址前綴對應");
    window.modal.close();
    window.toast("✓ 已套用前綴更新", "ok");
  };
}

function openEditParamModal(channelId, productId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  const p = (s.products || []).find((x) => x.id === productId);
  if (!c || !p) return;
  const currentParam = c.short_url_params?.[productId] || "";
  const autoParam = `${p.short_url_code || ""}${c.name || ""}`;

  const html = `
    <h2>✎ 覆寫縮網址參數</h2>
    <p class="ink-3" style="font-size:12px;margin-bottom:8px">
      線路:<strong>${esc(c.name)}</strong> · 產品:<strong>${esc(p.name)}</strong>
    </p>
    <div class="field">
      <label>縮網址參數</label>
      <input id="sue-param" type="text" value="${esc(currentParam)}" placeholder="留空 = 自動帶入:${esc(autoParam)}" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">
        自動帶入:<code>${esc(autoParam || "(產品未設縮網址代碼)")}</code>
      </div>
    </div>
    <h3 style="margin:14px 0 6px;font-size:14px">線路網域(per-線路,影響所有產品)</h3>
    <div class="field">
      <label>舊網域 override</label>
      <input id="sue-old" type="text" value="${esc(c.short_url_old_override || "")}" placeholder="留空 = 新合作" />
    </div>
    <div class="field mt-8">
      <label>新網域 override</label>
      <input id="sue-new" type="text" value="${esc(c.short_url_new_override || "")}" placeholder="留空 = 沿用全站 (${esc(s.settings?.short_url_new_domain || "未設")})" />
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
    const pv = q("#sue-param").value.trim();
    const ov = q("#sue-old").value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const nv = q("#sue-new").value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    update((st) => {
      const target = st.channels.find((x) => x.id === channelId);
      if (!target) return;
      target.short_url_params = target.short_url_params || {};
      if (pv) target.short_url_params[productId] = pv;
      else delete target.short_url_params[productId];
      target.short_url_old_override = ov;
      target.short_url_new_override = nv;
    }, "編輯縮網址");
    window.modal.close();
    window.toast("✓ 已儲存", "ok");
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
