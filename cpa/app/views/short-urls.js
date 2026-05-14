// 縮網址管理:per-線路 URL + 全站新網域 cascade + 站長分組批次通知。
//
// 模型(mirror CPT short-urls,簡化版 — 沒有 prefix slot mapping,單一全站 prefix):
//   - 全站:settings.short_url_new_domain(當前新網域)、settings.short_url_prefix(可空)
//   - per-線路:
//       short_url_param         = URL path,預設等於渠道名稱
//       short_url_old_override  = 舊網域(空 = 沒舊網址,屬於新合作)
//       short_url_new_override  = 新網域 override(空 = 沿用全站)
//       short_url_notified      = 已通知 bool
//
// URL 構造:`https://{[prefix.]}{domain}/{param}`
//
// 「💾 套用為新網址」cascade:
//   1. 對所有線路:把當下有效的新網址(override 或全站)寫進 short_url_old_override
//   2. settings.short_url_new_domain ← 使用者輸入
//   3. 所有線路 short_url_notified 重置為 false

import { getState, update } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";

// ─── URL helpers ──────────────────────────────────────
function buildUrl(prefix, domain, param) {
  if (!domain || !param) return "";
  const d = String(domain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!d) return "";
  const p = String(prefix || "").trim().replace(/\.$/, "").toLowerCase();
  const host = p ? `${p}.${d}` : d;
  return `https://${host}/${param}`;
}

function effectiveParam(c) {
  return (c.short_url_param || "").trim() || (c.name || "").trim();
}

function effectiveNewDomain(c, settings) {
  return c.short_url_new_override || settings.short_url_new_domain || "";
}

function effectiveOldDomain(c) {
  return c.short_url_old_override || "";  // 空 = 新合作
}

// 站長分組
function groupByPublisher(channels, publishers) {
  const pubById = Object.fromEntries(publishers.map((p) => [p.id, p]));
  const groups = new Map();
  for (const c of channels) {
    const pid = c.publisher_id || "_orphan";
    if (!groups.has(pid)) {
      groups.set(pid, {
        publisher: pubById[pid] || null,
        publisher_id: pid,
        channels: [],
      });
    }
    groups.get(pid).channels.push(c);
  }
  return Array.from(groups.values()).sort((a, b) => {
    // multi-channel 先排
    const ma = a.channels.length >= 2 ? 0 : 1;
    const mb = b.channels.length >= 2 ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return (a.publisher?.name || "~").localeCompare(b.publisher?.name || "~");
  });
}

// 群組複製文字
function buildGroupCopyText(group, settings) {
  const pub = group.publisher;
  const blocks = group.channels.map((c) => {
    const param = effectiveParam(c);
    const oldDomain = effectiveOldDomain(c);
    const newDomain = effectiveNewDomain(c, settings);
    const newUrl = buildUrl(settings.short_url_prefix, newDomain, param);
    const oldUrl = oldDomain ? buildUrl(settings.short_url_prefix, oldDomain, param) : "";
    const lines = [`[${c.name}]`];
    if (oldUrl) {
      lines.push(`旧:  ${oldUrl}`);
      lines.push(`新:  ${newUrl || "(未設定)"}`);
    } else {
      lines.push(`链接:${newUrl || "(未設定)"}`);
    }
    if (c.notes) lines.push(`(備註:${c.notes.split("\n")[0]})`);
    return lines.join("\n");
  });
  const anyHasOld = group.channels.some((c) => !!effectiveOldDomain(c));
  const greeting = anyHasOld
    ? `${pub?.name ? pub.name + " " : ""}你好,麻烦广告链结更换`
    : `${pub?.name ? pub.name + " " : ""}新合作`;
  return greeting + "\n" + blocks.join("\n\n");
}

// ─── render ───────────────────────────────────────────
export function render(root) {
  const s = getState();
  const settings = s.settings || {};
  const publishers = s.publishers || [];

  // 過濾:只看未淘汰(已淘汰的線路不用發通知)
  const channels = (s.channels || []).filter((c) => c.status !== "已淘汰");
  const groups = groupByPublisher(channels, publishers);

  const totalCount = channels.length;
  const notifiedCount = channels.filter((c) => c.short_url_notified).length;
  const unnotifiedCount = totalCount - notifiedCount;

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>🔗 縮網址管理</h1>
        <div class="desc" style="max-width:760px;line-height:1.5">
          套用「全站當前網址」時,所有線路會把當下新網址 snapshot 為自己的舊網址,通知狀態重置為未通知。同站長的線路自動分組,一次複製通知文字 + 批次標記已通知。
        </div>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0">全站當前網址</h2>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:4px">
        <div class="field" style="flex:2;min-width:200px;margin-bottom:0">
          <label>當前新網域(僅網域,例:abc.com)</label>
          <input id="su-domain" type="text" value="${esc(settings.short_url_new_domain || "")}" placeholder="例:abc.com" />
        </div>
        <div class="field" style="flex:1;min-width:140px;margin-bottom:0">
          <label>前綴(選填,例:l5 或 go)</label>
          <input id="su-prefix" type="text" value="${esc(settings.short_url_prefix || "")}" placeholder="留空 = 無前綴" />
        </div>
        <button id="btn-apply" class="primary">💾 套用為新網址</button>
      </div>
      <div class="ink-3" style="font-size:12px;margin-top:8px;line-height:1.5">
        套用流程:
        ① 所有線路當下的有效新網址 → 寫進各自的舊網域(snapshot)·
        ② 全站當前網域 ← 你輸入的值 ·
        ③ 所有通知狀態重置為「未通知」
      </div>
      <div style="margin-top:10px;display:inline-flex;gap:8px;align-items:center;font-size:13px;padding:6px 12px;background:#f5f7fa;border-radius:4px">
        <span class="ink-3">目前全站新網址</span>
        <strong style="font-family:monospace">${esc(buildUrl(settings.short_url_prefix, settings.short_url_new_domain, "{param}") || "—")}</strong>
      </div>
    </div>

    <div class="card mt-8" style="padding:0">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #eee">
        <div>
          <strong>線路清單</strong>
          <span class="ink-3" style="font-size:13px;margin-left:6px">${totalCount} 條</span>
        </div>
        <div style="display:flex;gap:10px;align-items:center;font-size:13px">
          <span class="pill ok" style="background:#d4edda;color:#155724;padding:2px 8px;border-radius:10px;font-size:12px">✅ 已通知 ${notifiedCount}</span>
          <span class="pill warn" style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:10px;font-size:12px">⏳ 未通知 ${unnotifiedCount}</span>
          ${notifiedCount > 0 ? `<button id="btn-reset-notified" style="font-size:12px;padding:4px 8px">↺ 全標未通知</button>` : ""}
        </div>
      </div>
      ${totalCount === 0 ? `
        <p class="ink-2" style="padding:14px;margin:0">尚無啟用中的線路</p>
      ` : `
        <table class="su-table">
          <thead>
            <tr>
              <th style="width:160px">渠道 / 站長</th>
              <th style="width:120px">參數</th>
              <th>舊連結</th>
              <th>新連結</th>
              <th style="width:160px;text-align:center">操作</th>
            </tr>
          </thead>
          <tbody>
            ${groups.map((g) => renderGroup(g, settings)).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;

  bindHandlers(root, groups);
}

function renderGroup(g, settings) {
  const pub = g.publisher;
  const groupCount = g.channels.length;
  const allNotified = g.channels.every((c) => c.short_url_notified);
  const isMulti = groupCount >= 2;
  const channelIds = g.channels.map((c) => c.id);

  const groupHeader = isMulti ? `
    <tr class="su-group-header">
      <td colspan="5">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <strong>${esc(pub?.name || "⚠️ 站長已刪除 / 未設站長")}</strong>
            <span class="ink-3" style="font-size:12px;margin-left:6px">${groupCount} 條 · ${pub?.contact_info ? esc(pub.contact_info) : "未設聯繫資料"}</span>
            <span style="margin-left:10px;font-size:12px;color:${allNotified ? "#155724" : "#856404"}">${allNotified ? "✅ 全部已通知" : "⏳ 待通知"}</span>
          </div>
          <div>
            <button class="primary su-group-copy-btn" data-group-copy="${channelIds.join(",")}">📋 批次通知 (${groupCount})</button>
            <button data-group-toggle="${channelIds.join(",")}" data-to-state="${!allNotified}" style="margin-left:4px">${allNotified ? "↺ 標未通知" : "✓ 標已通知"}</button>
          </div>
        </div>
      </td>
    </tr>
  ` : "";

  return groupHeader + g.channels.map((c) => renderRow(c, settings, isMulti, pub)).join("");
}

function renderRow(c, settings, isInGroup, pub) {
  const param = effectiveParam(c);
  const oldDomain = effectiveOldDomain(c);
  const newDomain = effectiveNewDomain(c, settings);
  const newUrl = buildUrl(settings.short_url_prefix, newDomain, param);
  const oldUrl = oldDomain ? buildUrl(settings.short_url_prefix, oldDomain, param) : "";
  const newOverridden = !!c.short_url_new_override;
  const oldOverridden = !!c.short_url_old_override;

  return `
    <tr class="${isInGroup ? "su-group-row" : ""}">
      <td>
        <strong>${esc(c.name)}</strong>
        ${!isInGroup && pub ? `<div class="ink-3" style="font-size:11px">${esc(pub.name)}${pub.contact_info ? ` · ${esc(pub.contact_info)}` : ""}</div>` : ""}
      </td>
      <td>
        <code style="font-size:12px">${esc(param)}</code>
        ${c.short_url_param ? "" : '<div class="ink-3" style="font-size:10px">(=渠道名)</div>'}
      </td>
      <td>
        ${oldUrl ? `<code style="font-size:12px;word-break:break-all">${esc(oldUrl)}</code>${oldOverridden ? '' : ''}` : '<span class="ink-3" style="font-size:12px">— 新合作</span>'}
      </td>
      <td>
        ${newUrl ? `<code style="font-size:12px;word-break:break-all">${esc(newUrl)}</code>${newOverridden ? ' <span class="pill" style="background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 5px;border-radius:8px">override</span>' : ""}` : '<span class="ink-3" style="font-size:12px">— 未設定</span>'}
      </td>
      <td style="text-align:center;white-space:nowrap">
        ${!isInGroup ? `
          <button class="su-row-copy-btn" data-row-copy="${esc(c.id)}">📋 通知</button>
          <button data-row-toggle="${esc(c.id)}" style="margin-left:2px;font-size:11px;color:${c.short_url_notified ? "#155724" : "#856404"}">${c.short_url_notified ? "✅" : "⏳"}</button>
        ` : ""}
        <button data-edit-su="${esc(c.id)}" style="margin-left:2px">✎</button>
      </td>
    </tr>
  `;
}

function bindHandlers(root, groups) {
  const q = (sel) => root.querySelector(sel);

  q("#btn-apply")?.addEventListener("click", async () => {
    const s = getState();
    const settings = s.settings || {};
    const newDomain = q("#su-domain").value.trim();
    const newPrefix = q("#su-prefix").value.trim().toLowerCase();
    const curDomain = settings.short_url_new_domain || "";
    const curPrefix = settings.short_url_prefix || "";

    if (newDomain === curDomain && newPrefix === curPrefix) {
      window.toast("沒變動,無須套用", "");
      return;
    }

    const channels = (s.channels || []).filter((c) => c.status !== "已淘汰");
    const ok = await window.confirmAsync({
      title: "套用為新網址?",
      body: `會做這幾件事:\n① 把 ${channels.length} 條未淘汰線路當下的新網址 snapshot 為各自的舊網址\n② 全站新網域:「${curDomain || "(空)"}」→「${newDomain || "(空)"}」\n③ 全部標記為「未通知」`,
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
      st.settings.short_url_prefix = newPrefix;
    }, `更新全站新網址:${newDomain || "(空)"}`);
    window.toast(`✓ 已套用,通知狀態已重置`, "ok");
  });

  q("#btn-reset-notified")?.addEventListener("click", async () => {
    const ok = await window.confirmAsync({
      title: "全部標為未通知?",
      body: "把所有線路的通知狀態重置為未通知(不會動到網址)",
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
      const ids = btn.dataset.groupCopy.split(",").filter(Boolean);
      const s = getState();
      const channels = (s.channels || []).filter((c) => ids.includes(c.id));
      if (channels.length === 0) return;
      const group = { publisher: s.publishers.find((p) => p.id === channels[0].publisher_id), channels };
      const text = buildGroupCopyText(group, s.settings || {});
      try {
        await navigator.clipboard.writeText(text);
        update((st) => {
          for (const c of st.channels || []) {
            if (ids.includes(c.id)) c.short_url_notified = true;
          }
        }, `批次通知 ${channels.length} 條`);
        window.toast(`✓ 已複製 ${channels.length} 條通知文字,全部標為已通知`, "ok");
      } catch {
        window.toast("複製失敗,請手動", "bad");
      }
    };
  });

  // 群組通知狀態 toggle
  root.querySelectorAll("[data-group-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const ids = btn.dataset.groupToggle.split(",").filter(Boolean);
      const nextState = btn.dataset.toState === "true";
      update((st) => {
        for (const c of st.channels || []) {
          if (ids.includes(c.id)) c.short_url_notified = nextState;
        }
      }, "切換通知狀態");
      window.toast(nextState ? "✓ 已標為已通知" : "↺ 已標為未通知", "ok");
    };
  });

  // 單條複製(non-group rows)
  root.querySelectorAll("[data-row-copy]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.rowCopy;
      const s = getState();
      const c = (s.channels || []).find((x) => x.id === id);
      if (!c) return;
      const group = { publisher: s.publishers.find((p) => p.id === c.publisher_id), channels: [c] };
      const text = buildGroupCopyText(group, s.settings || {});
      try {
        await navigator.clipboard.writeText(text);
        update((st) => {
          const target = st.channels.find((x) => x.id === id);
          if (target) target.short_url_notified = true;
        }, "通知 + 標記");
        window.toast("✓ 已複製並標為已通知", "ok");
      } catch {
        window.toast("複製失敗,請手動", "bad");
      }
    };
  });

  // 單條通知狀態 toggle
  root.querySelectorAll("[data-row-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.rowToggle;
      update((st) => {
        const target = st.channels.find((x) => x.id === id);
        if (target) target.short_url_notified = !target.short_url_notified;
      }, "切換通知狀態");
    };
  });

  // 編輯 per-channel override
  root.querySelectorAll("[data-edit-su]").forEach((btn) => {
    btn.onclick = () => openEditUrlModal(btn.dataset.editSu);
  });
}

function openEditUrlModal(channelId) {
  const s = getState();
  const c = (s.channels || []).find((x) => x.id === channelId);
  if (!c) return;
  const settings = s.settings || {};
  const param = effectiveParam(c);
  const effNew = effectiveNewDomain(c, settings);
  const effOld = effectiveOldDomain(c);

  const html = `
    <h2>✎ 縮網址覆寫:${esc(c.name)}</h2>
    <p class="ink-3" style="font-size:12px;margin-bottom:8px">
      參數預設等於渠道名稱;舊網域空白 = 新合作;新網域空白 = 沿用全站
    </p>
    <div class="field">
      <label>縮網址參數(URL 路徑)</label>
      <input id="su-edit-param" type="text" value="${esc(c.short_url_param || "")}" placeholder="留空 = ${esc(c.name)}" />
    </div>
    <div class="field mt-8">
      <label>舊網域 override(僅網域)</label>
      <input id="su-edit-old" type="text" value="${esc(c.short_url_old_override || "")}" placeholder="留空 = 新合作(無舊網址)" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">目前有效舊網域:<code>${esc(effOld || "(無)")}</code></div>
    </div>
    <div class="field mt-8">
      <label>新網域 override(僅網域)</label>
      <input id="su-edit-new" type="text" value="${esc(c.short_url_new_override || "")}" placeholder="留空 = 沿用全站 (${esc(settings.short_url_new_domain || "未設")})" />
      <div class="ink-3" style="font-size:11px;margin-top:4px">目前有效新網域:<code>${esc(effNew || "(無)")}</code></div>
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
    const paramV = q("#su-edit-param").value.trim();
    const oldV = q("#su-edit-old").value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const newV = q("#su-edit-new").value.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    update((st) => {
      const target = st.channels.find((x) => x.id === channelId);
      if (!target) return;
      target.short_url_param = paramV;
      target.short_url_old_override = oldV;
      target.short_url_new_override = newV;
    }, "編輯縮網址");
    window.modal.close();
    window.toast("✓ 已儲存", "ok");
  };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
