import { getState, update } from "../state.js";

const SHORT_URL_BAG_TYPE = "提包";
const TYPE_LABEL = { L1: "權重", L3: "APK", L5: "小島" };
const DEFAULT_PREFIX_MAP = { L1: "L1", L3: "L3", L5: "L5" };
const PREFIX_SLOTS = new Set(Object.keys(DEFAULT_PREFIX_MAP));

function parseShortUrlType(value) {
  const parts = String(value || "").split("+").map((p) => p.trim()).filter(Boolean);
  const slot = parts.find((part) => PREFIX_SLOTS.has(part)) || "";
  const hasBag = parts.includes(SHORT_URL_BAG_TYPE) || value === SHORT_URL_BAG_TYPE;
  return { slot, hasBag };
}

// 取得 slot 對應的實際前綴(2026-05,§5.7.x):
//   settings.short_url_prefix_map[slotId] → 實際前綴(預設與 slot 同名)
function prefixOf(state, slotType) {
  const map = state?.settings?.short_url_prefix_map || DEFAULT_PREFIX_MAP;
  const slot = parseShortUrlType(slotType).slot;
  return map[slot] || slot || "";
}

// 構造完整 URL: https://{actualPrefix-lowercased}.{domain}/{param}
//   slotType = "L1"/"L3"/"L5" 業務 slot;實際前綴由 settings.short_url_prefix_map 決定
//   prefixOverride(選填):明確指定前綴(用於舊 URL 渲染,當 ad.short_url_old_prefix 有值時)
function buildUrl(slotType, domain, param, state, prefixOverride) {
  const slot = parseShortUrlType(slotType).slot;
  if (!slot || !domain || !param) return "";
  const cleanDomain = String(domain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!cleanDomain) return "";
  const prefix = prefixOverride || prefixOf(state || getState(), slot);
  return `https://${prefix.toLowerCase()}.${cleanDomain}/${param}`;
}

// 取得舊 URL:若 ad.short_url_old_prefix 有值(前綴 cascade 時凍結),用它;否則用當前 slot 前綴
function oldUrlOf(ad, oldDomain, state) {
  return buildUrl(ad.short_url_type, oldDomain, ad.short_url_param, state, ad.short_url_old_prefix || undefined);
}

// 顯示模型(2026-05 修):
//   - 新網址(newDomain):per-ad override 優先,否則 fall back 到全站 settings.short_url_new_domain
//   - 舊網址(oldDomain):per-ad override 優先,不 fall back 到全站(沒寫=這支廣告沒有舊網址,屬於新合作)
function effectiveDomains(s, ad) {
  return {
    oldDomain: ad.short_url_old_override || "",
    newDomain: ad.short_url_new_override || s.settings.short_url_new_domain || "",
    oldOverridden: !!ad.short_url_old_override,
    newOverridden: !!ad.short_url_new_override,
  };
}

// 同站長(contact_info)的廣告分組。空 contact_info 視為各自獨立(每筆單獨群組)。
// 回傳陣列,multi-ad 群組(2+ 筆同 contact)排前,其他依首支 ad_code 排序。
function groupByContact(rows) {
  const groupedByContact = new Map();
  const ungrouped = [];
  for (const a of rows) {
    const key = (a.contact_info || "").trim();
    if (!key) {
      ungrouped.push({ contact: "", ads: [a] });
    } else {
      if (!groupedByContact.has(key)) groupedByContact.set(key, { contact: key, ads: [] });
      groupedByContact.get(key).ads.push(a);
    }
  }
  const groups = [...groupedByContact.values(), ...ungrouped];
  // multi-ad-with-contact 排前,其他依首支 ad_code
  groups.sort((g1, g2) => {
    const m1 = g1.ads.length >= 2 ? 0 : 1;
    const m2 = g2.ads.length >= 2 ? 0 : 1;
    if (m1 !== m2) return m1 - m2;
    if (g1.contact && g2.contact && g1.contact !== g2.contact) return g1.contact.localeCompare(g2.contact);
    return (g1.ads[0]?.ad_code || "").localeCompare(g2.ads[0]?.ad_code || "");
  });
  // group 內依 ad_code 排序
  for (const g of groups) g.ads.sort((a, b) => (a.ad_code || "").localeCompare(b.ad_code || ""));
  return groups;
}

// 一個群組合併成一段複製文字。
//   - 全部都「無舊連結」→ 用「新合作」當開頭
//   - 任一筆有舊連結 → 用「你好，麻烦广告链结更换」當開頭
//   - 每筆 ad 一個 block:[name] / 文案 / (旧+新 或 链接),block 間空一行
function buildGroupCopyText(ads, s) {
  const adBlocks = ads.map((a) => {
    const dom = effectiveDomains(s, a);
    const oldUrl = oldUrlOf(a, dom.oldDomain, s);
    const newUrl = buildUrl(a.short_url_type, dom.newDomain, a.short_url_param, s);
    const lines = [];
    if (a.ad_name) lines.push(`[${a.ad_name}]`);
    if (a.ad_copy) lines.push(`文案：  ${a.ad_copy}`);
    if (oldUrl) {
      lines.push(`旧：  ${oldUrl}`);
      lines.push(`新：  ${newUrl || "(未設定)"}`);
    } else {
      lines.push(`链接：${newUrl || "(未設定)"}`);
    }
    return lines.join("\n");
  });
  const anyHasOld = ads.some((a) => !!effectiveDomains(s, a).oldDomain);
  const greeting = anyHasOld ? "你好，麻烦广告链结更换" : "新合作";
  return greeting + "\n" + adBlocks.join("\n\n");
}

// 取今天的台北日期(YYYY-MM-DD)
function todayYmd() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date());
}

export function render(root) {
  const s = getState();
  const today = todayYmd();
  // 過濾條件(2026-05):
  //   1. short_url_type 不為空(= 採用 L1/L3/L5,可附加 +提包)
  //   2. 未過期(end_date > 今天;end_date 不含當日,所以 end_date = 今天時已經是最後一天無效)
  //      — 不再排除「已淘汰」:按了淘汰但結束日還沒到的廣告仍在跑,縮網址也要顯示讓使用者通知站長
  //   3. 家族配對只顯示 parent(一般側)作為代表 — 一般 + 破圈是同一份合約共用一條鏈結
  const ads = (s.ads || []).filter((a) =>
    !!a.short_url_type &&
    (!a.end_date || a.end_date > today) &&
    a.split_role !== "t_variant"
  );

  // 同代碼同參數多段:取最新一段(start_date 最大)
  // 用 (ad_code, short_url_param) 當 key:
  //   - 同代碼但不同產品的獨立採買(例:70 同時 AV9/JK/PJ8/ZFB/MYS 各 100%),
  //     若大家共用同一個縮網址參數 → 視為同一條鏈結,只顯示一列
  //   - 若縮網址參數不同 → 視為不同鏈結,各自獨立顯示
  const byKey = new Map();
  for (const a of ads) {
    const key = `${a.ad_code}|${a.short_url_param || ""}`;
    const cur = byKey.get(key);
    if (!cur || (a.start_date || "") > (cur.start_date || "")) byKey.set(key, a);
  }
  const rows = [...byKey.values()];
  const groups = groupByContact(rows);
  const totalCount = rows.length;
  const notifiedCount = rows.filter((a) => a.short_url_notified).length;
  const unnotifiedCount = totalCount - notifiedCount;

  const globalNew = s.settings.short_url_new_domain || "";

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>縮網址管理</h1>
        <div class="desc" style="max-width:760px;line-height:1.6">
          記錄正在使用中的連結,並通知站長更換。「全站當前網址」即為新網址;套用後<strong>現有廣告</strong>會把當下新網址 snapshot 為自己的舊網址,<strong>新增的廣告</strong>則無舊網址(直接視為新合作)。同站長(聯繫資料相同)的廣告自動分組,一次複製、一次標記已通知。
        </div>
      </div>
    </div>

    <div class="card">
      <h2>全站當前網址</h2>
      <div style="display:flex;gap:12px;align-items:flex-end;margin-top:4px">
        <div class="field" style="flex:1;margin-bottom:0">
          <label>當前網址(僅輸入網域,如 abc.com)</label>
          <input id="su-current" type="text" value="${esc(globalNew)}" placeholder="例:abc.com" style="font-size:14px;padding:9px 12px" />
        </div>
        <button id="su-apply" class="primary" style="padding:9px 16px;font-size:14px;white-space:nowrap;align-self:flex-end">💾 套用為新網址</button>
        <button id="su-prefix" style="padding:9px 14px;font-size:14px;white-space:nowrap;align-self:flex-end;border:1px solid var(--line);border-radius:6px;background:#fff">🔧 縮網址前綴</button>
      </div>
      <div class="hint" style="margin-top:10px;line-height:1.6;font-size:12px">
        套用時:<strong>現有廣告</strong>會把目前的新網址(<span class="mono">${esc(globalNew || "未設定")}</span>)寫進各自的舊網址;新網址 ← 您輸入的值;<strong>所有廣告的通知狀態會重置為「未通知」</strong>。<br>
        <strong>之後新增的廣告</strong>仍然維持「無舊網址」狀態。
      </div>

      <div style="margin-top:14px;display:inline-flex;gap:10px;align-items:center;font-size:13px;color:var(--ink-2);padding:8px 14px;background:#f6f7f9;border-radius:6px;border:1px solid var(--line)">
        <span style="color:var(--ink-3)">目前全站新網址</span>
        <strong class="mono" style="font-size:14px;color:var(--ink)">${esc(globalNew || "—")}</strong>
      </div>
    </div>

    <div class="card">
      <div class="card-head" style="align-items:center">
        <h2>清單<span class="ink-3" style="font-size:13px;font-weight:400;margin-left:6px">(${totalCount})</span></h2>
        <div style="margin-left:auto;display:flex;gap:10px;align-items:center;font-size:13px">
          <span class="pill ok" style="font-size:11px">✅ 已通知 ${notifiedCount}</span>
          <span class="pill warn" style="font-size:11px">⏳ 未通知 ${unnotifiedCount}</span>
          ${notifiedCount > 0 ? `<button id="su-reset-notified" class="link-btn" style="font-size:12px">↺ 全部標記未通知</button>` : ""}
        </div>
      </div>
      ${rows.length === 0 ? `
        <div class="empty">尚無設定縮網址資訊的廣告<br><span class="ink-3" style="font-size:12px">到「廣告列表 → 新增/編輯廣告」選擇採用連結 (L1/L3/L5,可額外勾提包) + 填入縮網址參數</span></div>
      ` : `
        <div class="table-wrap" style="margin-top:8px">
          <table class="short-urls-table">
            <colgroup>
              <col style="width:90px" />
              <col style="width:160px" />
              <col style="width:110px" />
              <col style="width:130px" />
              <col />
              <col />
              <col style="width:130px" />
              <col style="width:90px" />
            </colgroup>
            <thead>
              <tr>
                <th>廣告代碼</th>
                <th>廣告名稱 / 站長</th>
                <th>廣告文案</th>
                <th>類型 / 參數</th>
                <th>舊連結</th>
                <th>新連結</th>
                <th style="text-align:center">發送站長</th>
                <th style="text-align:center">動作</th>
              </tr>
            </thead>
            <tbody>
              ${groups.map((g) => renderGroup(g, s)).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;

  // 縮網址前綴 — 按鈕在「套用為新網址」旁邊,點開彈窗(同 CPA)
  const prefixBtn = document.getElementById("su-prefix");
  if (prefixBtn) prefixBtn.onclick = () => openPrefixMapModal();

  // 套用「當前網址」:cascade + 重置通知狀態
  const applyBtn = document.getElementById("su-apply");
  if (applyBtn) {
    applyBtn.onclick = () => {
      const input = document.getElementById("su-current");
      const v = (input?.value || "").trim();
      const cur = s.settings.short_url_new_domain || "";
      if (v === cur) {
        window.toast("新網址沒變,無須套用", "");
        return;
      }
      const adCount = (s.ads || []).length;
      const confirmMsg = v
        ? `將全站新網址設為「${v}」,把 ${adCount} 支廣告當下的新網址(${cur || "(空)"})寫進它們各自的舊網址,並把所有通知狀態重置為未通知。確定?`
        : `將全站新網址清空,把 ${adCount} 支廣告當下的新網址(${cur || "(空)"})寫進它們各自的舊網址,並把所有通知狀態重置為未通知。確定?`;
      if (!window.confirm(confirmMsg)) return;
      update((st) => {
        const previousGlobalNew = st.settings.short_url_new_domain || "";
        for (const ad of st.ads || []) {
          const adCurrentNew = ad.short_url_new_override || previousGlobalNew;
          if (adCurrentNew) {
            ad.short_url_old_override = adCurrentNew;
          }
          delete ad.short_url_new_override;
          // 域名 cascade 時清掉前綴凍結 — 舊 URL 用當前 slot 前綴(這是「域名」變動,不是前綴變動)
          delete ad.short_url_old_prefix;
          ad.short_url_notified = false;
        }
        st.settings.short_url_new_domain = v;
        st.settings.short_url_old_domain = "";
      }, `更新當前網址:${v || "(空)"}`);
      window.toast(v ? `已套用 ${v} 為新網址(通知狀態已重置)` : "已清空當前網址", "ok");
    };
  }

  // 全部標記為未通知(不動網址)
  const resetBtn = document.getElementById("su-reset-notified");
  if (resetBtn) {
    resetBtn.onclick = () => {
      if (!window.confirm(`將所有廣告的通知狀態重置為「未通知」?(不會動到網址)`)) return;
      update((st) => {
        for (const ad of st.ads || []) ad.short_url_notified = false;
      }, "重置所有通知狀態");
      window.toast("已重置所有通知狀態", "ok");
    };
  }

  // 同 (ad_code, short_url_param) 視為「同一條鏈結」— 標記通知要對所有此組合的 segments 一起標
  const linkKey = (ad) => `${ad.ad_code}|${ad.short_url_param || ""}`;

  // 群組複製 + 標記已通知
  root.querySelectorAll("[data-group-copy]").forEach((btn) => {
    btn.onclick = () => {
      const ids = btn.dataset.groupCopy.split(",").filter(Boolean);
      const adsInGroup = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
      if (adsInGroup.length === 0) return;
      const text = buildGroupCopyText(adsInGroup, s);
      copyToClipboard(text)
        .then(() => {
          // 標記已通知:用 (ad_code, short_url_param) 配對覆蓋該 row 的所有歷史 segments
          const keys = new Set(adsInGroup.map(linkKey));
          update((st) => {
            for (const ad of st.ads || []) {
              if (keys.has(linkKey(ad))) ad.short_url_notified = true;
            }
          }, `標記已通知 ${adsInGroup.length} 筆`);
          window.toast(
            adsInGroup.length === 1
              ? `已複製 ${adsInGroup[0].ad_code} 的通知文字,標記為已通知`
              : `已複製 ${adsInGroup.length} 筆通知文字(${(adsInGroup[0].contact_info || "")}),全部標記為已通知`,
            "ok"
          );
        })
        .catch(() => window.toast("複製失敗,請手動", "bad"));
    };
  });

  // 群組通知狀態手動 toggle
  root.querySelectorAll("[data-group-toggle]").forEach((btn) => {
    btn.onclick = () => {
      const ids = btn.dataset.groupToggle.split(",").filter(Boolean);
      const adsInGroup = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean);
      const nextState = btn.dataset.toState === "true";  // "true" 字串 → true
      const keys = new Set(adsInGroup.map(linkKey));
      update((st) => {
        for (const ad of st.ads || []) {
          if (keys.has(linkKey(ad))) ad.short_url_notified = nextState;
        }
      }, `${nextState ? "標記已通知" : "標記未通知"} ${adsInGroup.length} 筆`);
      window.toast(`已標記為${nextState ? "已通知" : "未通知"}`, "ok");
    };
  });

  // 編輯網域覆寫
  root.querySelectorAll("[data-override-code]").forEach((btn) => {
    btn.onclick = () => openOverrideModal(btn.dataset.overrideCode);
  });
}

function renderGroup(group, s) {
  const isMulti = group.ads.length >= 2 && !!group.contact;
  if (isMulti) {
    return renderGroupHeader(group, s) + group.ads.map((a) => renderRow(a, s, { inGroup: true })).join("");
  }
  // 單筆群組(無 contact 或 contact 只有自己一筆)
  return group.ads.map((a) => renderRow(a, s, { inGroup: false })).join("");
}

function renderGroupHeader(group, s) {
  // 用 ad.id(每段唯一)當識別碼,避免同 ad_code 不同 short_url_param 的多筆 row 被當成同一筆
  const idsAttr = group.ads.map((a) => a.id).join(",");
  const count = group.ads.length;
  const allNotified = group.ads.every((a) => !!a.short_url_notified);
  const statusBadge = allNotified
    ? `<span class="pill ok" style="font-size:11px">✅ 已通知</span>`
    : `<span class="pill warn" style="font-size:11px">⏳ 未通知</span>`;
  const toggleBtn = allNotified
    ? `<button class="su-btn" data-group-toggle="${esc(idsAttr)}" data-to-state="false" title="標記為未通知">↺ 標未通知</button>`
    : `<button class="su-btn" data-group-toggle="${esc(idsAttr)}" data-to-state="true" title="手動標為已通知(不複製)">✓ 標已通知</button>`;
  return `
    <tr class="su-group-header">
      <td colspan="8" style="background:#eef3f9;padding:10px 14px;border-top:2px solid #c5d4e3;border-bottom:1px solid #c5d4e3">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:13px;color:var(--ink-3)">站長</span>
          <strong style="font-size:13px">${esc(group.contact)}</strong>
          <span class="ink-3" style="font-size:12px">(${count} 筆)</span>
          ${statusBadge}
          <div style="margin-left:auto;display:flex;gap:8px">
            <button class="primary su-btn" data-group-copy="${esc(idsAttr)}" title="複製此站長的所有廣告通知文字,並標記為已通知">📋 通知此站長 (${count})</button>
            ${toggleBtn}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderRow(a, s, { inGroup = false } = {}) {
  const dom = effectiveDomains(s, a);
  const oldUrl = oldUrlOf(a, dom.oldDomain, s);
  const newUrl = buildUrl(a.short_url_type, dom.newDomain, a.short_url_param, s);
  const shortUrlType = parseShortUrlType(a.short_url_type);
  const typeTags = [
    shortUrlType.slot
      ? `<span class="pill">${esc(shortUrlType.slot)}${TYPE_LABEL[shortUrlType.slot] ? `(${TYPE_LABEL[shortUrlType.slot]})` : ""}</span>`
      : "",
    shortUrlType.hasBag ? `<span class="pill short-url-bag">!提包</span>` : "",
  ].filter(Boolean);
  const typeLabel = typeTags.length > 0
    ? `<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">${typeTags.join("")}</div>`
    : "<span class='ink-3'>—</span>";
  const paramText = a.short_url_param
    ? `<div class="mono" style="font-size:11px;color:var(--ink-2);margin-top:3px">${esc(a.short_url_param)}</div>`
    : "";
  const oldTag = dom.oldOverridden ? `<span class="pill" style="font-size:10px;margin-left:6px;background:#fff3cd;color:#856404">覆寫</span>` : "";
  const newTag = dom.newOverridden ? `<span class="pill" style="font-size:10px;margin-left:6px;background:#fff3cd;color:#856404">覆寫</span>` : "";
  const hasOverride = dom.oldOverridden || dom.newOverridden;
  const notified = !!a.short_url_notified;

  // 「發送站長」欄:在多筆群組內時只顯示狀態(動作在群組 header);單筆時顯示 📋 + 狀態
  let sendCell;
  if (inGroup) {
    sendCell = `<span class="pill ${notified ? "ok" : "warn"}" style="font-size:11px">${notified ? "✅ 已通知" : "⏳ 未通知"}</span>`;
  } else {
    const isNewCollab = !oldUrl;
    const copyLabel = isNewCollab ? "📋 新合作" : "📋 複製";
    const copyTitle = isNewCollab ? "複製「新合作」通知文字並標記已通知" : "複製通知站長更換鏈接的文字並標記已通知";
    const toggleBtn = notified
      ? `<button class="link-btn" data-group-toggle="${esc(a.id)}" data-to-state="false" style="font-size:11px" title="標記為未通知">↺ 標未通知</button>`
      : `<button class="link-btn" data-group-toggle="${esc(a.id)}" data-to-state="true" style="font-size:11px" title="手動標為已通知(不複製)">✓ 標已通知</button>`;
    sendCell = `
      <button class="su-btn" data-group-copy="${esc(a.id)}" title="${copyTitle}">${copyLabel}</button>
      <div style="margin-top:4px;display:flex;flex-direction:column;align-items:center;gap:2px">
        <span class="pill ${notified ? "ok" : "warn"}" style="font-size:10px">${notified ? "✅ 已通知" : "⏳ 未通知"}</span>
        ${toggleBtn}
      </div>
    `;
  }

  // 「廣告名稱 / 站長」欄:單筆時若有 contact_info 顯示在名稱下方;群組內已在 header 顯示,row 不重複
  const nameCell = `
    ${esc(a.ad_name || "")}
    ${!inGroup && a.contact_info ? `<div class="ink-3" style="font-size:11px;margin-top:3px">站長:${esc(a.contact_info)}</div>` : ""}
  `;

  return `
    <tr${inGroup ? ' class="su-group-row"' : ""}>
      <td class="mono">${esc(a.ad_code)}</td>
      <td>${nameCell}</td>
      <td>${a.ad_copy ? esc(a.ad_copy) : "<span class='ink-3'>—</span>"}</td>
      <td>${typeLabel}${paramText}</td>
      <td class="url-cell">${oldUrl ? esc(oldUrl) : "<span class='ink-3'>(無)</span>"}${oldTag}</td>
      <td class="url-cell">${newUrl ? esc(newUrl) : "<span class='ink-3'>(未設定)</span>"}${newTag}</td>
      <td style="text-align:center">${sendCell}</td>
      <td style="text-align:center"><button data-override-code="${esc(a.ad_code)}" title="編輯此筆的舊/新網域覆寫" class="su-btn">${hasOverride ? "🔧 已編輯" : "✎ 編輯"}</button></td>
    </tr>
  `;
}

// 縮網址前綴對應彈窗:編輯 settings.short_url_prefix_map
// 業務 slot 永遠是 L1/L3/L5,實際 URL 子網域前綴可以另外設定(例如 L1 → L7)
// 可選擇是否把目前的新連結 snapshot 成舊連結(預設不勾,舊連結保持原樣)
function openPrefixMapModal() {
  const s = getState();
  const map = { ...DEFAULT_PREFIX_MAP, ...(s.settings.short_url_prefix_map || {}) };
  const domainSample = s.settings.short_url_new_domain || "abc.com";
  const html = `
    <h2>🔧 縮網址前綴</h2>
    <p class="ink-2" style="font-size:13px;line-height:1.6">
      <strong>業務 slot</strong>(L1/L3/L5)是辨識用途的固定標籤,新增廣告時用它選類別。<br>
      <strong>實際前綴</strong>是 URL 子網域,可以另設(例如 L1 改成 L7),儲存後所有對應 slot 的廣告 URL 立刻換新前綴,廣告資料不動。
    </p>
    <div class="field">
      <label>L1 (權重)</label>
      <input id="pf-L1" type="text" value="${esc(map.L1)}" />
      <div class="hint">範例 URL:https://<strong id="pf-L1-preview">${esc(map.L1).toLowerCase()}</strong>.${esc(domainSample)}/foo</div>
    </div>
    <div class="field mt-8">
      <label>L3 (APK)</label>
      <input id="pf-L3" type="text" value="${esc(map.L3)}" />
      <div class="hint">範例 URL:https://<strong id="pf-L3-preview">${esc(map.L3).toLowerCase()}</strong>.${esc(domainSample)}/foo</div>
    </div>
    <div class="field mt-8">
      <label>L5 (小島)</label>
      <input id="pf-L5" type="text" value="${esc(map.L5)}" />
      <div class="hint">範例 URL:https://<strong id="pf-L5-preview">${esc(map.L5).toLowerCase()}</strong>.${esc(domainSample)}/foo</div>
    </div>

    <div style="margin-top:14px;padding:12px 14px;background:#f6f7f9;border:1px solid var(--line);border-radius:6px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;font-size:13px">
        <input id="pf-overwrite-old" type="checkbox" style="margin:0" />
        <span>同時把目前新連結覆蓋為舊連結</span>
      </label>
      <div class="hint" style="margin-top:6px;line-height:1.6">
        <strong>勾起來</strong>:把目前的新連結 snapshot 成舊連結(站長要被通知前綴改了),通知狀態重置。<br>
        <strong>不勾</strong>:舊連結維持不變,只更新前綴 map。適合「之前已經換過網域、舊連結要保留」的情境。
      </div>
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
      L1: (q("#pf-L1").value.trim() || "L1"),
      L3: (q("#pf-L3").value.trim() || "L3"),
      L5: (q("#pf-L5").value.trim() || "L5"),
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
    const overwriteOld = q("#pf-overwrite-old").checked;
    const affectedAds = (s.ads || []).filter((a) =>
      changedSlots.includes(parseShortUrlType(a.short_url_type).slot) && a.short_url_param
    );
    const summary = changedSlots
      .map((slot) => `${slot}: ${oldMap[slot]} → ${newMap[slot]}`).join("、");
    const confirmMsg = `將更新 ${changedSlots.length} 個 slot 前綴(${summary})。\n` +
      (overwriteOld
        ? `${affectedAds.length} 支廣告的「目前 URL」會 snapshot 為各自的舊連結,通知狀態重置為未通知。確定?`
        : `${affectedAds.length} 支廣告的舊連結維持不變,只更新前綴 map(通知狀態不變)。確定?`);
    if (!window.confirm(confirmMsg)) return;
    update((st) => {
      if (overwriteOld) {
        const previousGlobalNew = st.settings.short_url_new_domain || "";
        for (const ad of st.ads || []) {
          const slot = parseShortUrlType(ad.short_url_type).slot;
          if (!slot || !changedSlots.includes(slot)) continue;
          if (!ad.short_url_param) continue;
          const currentNewDomain = ad.short_url_new_override || previousGlobalNew;
          if (currentNewDomain) ad.short_url_old_override = currentNewDomain;
          ad.short_url_old_prefix = oldMap[slot];
          delete ad.short_url_new_override;
          ad.short_url_notified = false;
        }
      } else {
        // 不勾覆蓋:把當前的舊前綴凍結到 ad,讓舊連結保持原樣(否則會跟著新 prefix map 變動)。
        // 只對有 old_override 且還沒凍結過的廣告處理(新合作廣告不需要;已凍結的保留更早的值)。
        for (const ad of st.ads || []) {
          const slot = parseShortUrlType(ad.short_url_type).slot;
          if (!slot || !changedSlots.includes(slot)) continue;
          if (!ad.short_url_param) continue;
          if (ad.short_url_old_override && !ad.short_url_old_prefix) {
            ad.short_url_old_prefix = oldMap[slot];
          }
        }
      }
      st.settings.short_url_prefix_map = newMap;
    }, overwriteOld ? "更新縮網址前綴(覆蓋舊連結)" : "更新縮網址前綴(舊連結保留)");
    window.modal.close();
    window.toast(overwriteOld
      ? `已套用前綴更新(${affectedAds.length} 支廣告 snapshot 為舊連結,通知狀態已重置)`
      : `已套用前綴更新(舊連結保持不變)`, "ok");
  };
}


function openOverrideModal(adCode) {
  const s = getState();
  const segs = (s.ads || []).filter((a) => a.ad_code === adCode);
  if (segs.length === 0) return;
  segs.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
  const ad = segs[0];
  const globalNew = s.settings.short_url_new_domain || "";
  const dom = effectiveDomains(s, ad);
  const oldUrl = oldUrlOf(ad, dom.oldDomain, s);
  const newUrl = buildUrl(ad.short_url_type, dom.newDomain, ad.short_url_param, s);
  const html = `
    <h2>編輯網域覆寫:${esc(adCode)} ${esc(ad.ad_name || "")}</h2>
    <p class="ink-2" style="font-size:13px;line-height:1.6">
      針對單筆廣告設定獨立的舊/新網域。覆寫會套用到此代碼的所有段。
    </p>
    <ul class="ink-2" style="font-size:12px;line-height:1.6;margin:6px 0 12px 18px;padding:0">
      <li><strong>舊網域</strong>空白 = 此廣告沒有舊連結(複製時走「新合作」模板)</li>
      <li><strong>新網域</strong>空白 = 使用全站新值(${esc(globalNew || "未設定")})</li>
    </ul>
    <div class="field-row">
      <div class="field" style="flex:1">
        <label>舊網域(空=新合作,無舊連結)</label>
        <input id="ov-old" type="text" value="${esc(ad.short_url_old_override || "")}" placeholder="例:abc.com(留空=無舊連結)" />
      </div>
      <div class="field" style="flex:1">
        <label>新網域(空=用全站)</label>
        <input id="ov-new" type="text" value="${esc(ad.short_url_new_override || "")}" placeholder="(空=使用全站「${esc(globalNew || "未設定")}」)" />
      </div>
    </div>
    <div class="hint" style="margin-top:6px;font-size:12px;line-height:1.6">
      目前舊連結:<span class="mono">${oldUrl ? esc(oldUrl) : "(無)"}</span><br>
      目前新連結:<span class="mono">${newUrl ? esc(newUrl) : "(未設定)"}</span>
    </div>
    <div class="modal-actions">
      <button id="ov-clear">清除覆寫</button>
      <button id="ov-cancel">取消</button>
      <button id="ov-save" class="primary">儲存</button>
    </div>
  `;
  const dlg = window.modal.open(html);
  dlg.querySelector("#ov-cancel").onclick = () => window.modal.close();
  dlg.querySelector("#ov-clear").onclick = () => {
    update((st) => {
      st.ads.forEach((a) => {
        if (a.ad_code === adCode) {
          delete a.short_url_old_override;
          delete a.short_url_new_override;
        }
      });
    }, `清除 ${adCode} 縮網址覆寫`);
    window.modal.close();
    window.toast(`已清除 ${adCode} 的覆寫`, "ok");
  };
  dlg.querySelector("#ov-save").onclick = () => {
    const oldV = dlg.querySelector("#ov-old").value.trim();
    const newV = dlg.querySelector("#ov-new").value.trim();
    update((st) => {
      st.ads.forEach((a) => {
        if (a.ad_code === adCode) {
          a.short_url_old_override = oldV;
          a.short_url_new_override = newV;
        }
      });
    }, `更新 ${adCode} 縮網址覆寫`);
    window.modal.close();
    window.toast(`已更新 ${adCode} 的覆寫`, "ok");
  };
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      ok ? resolve() : reject(new Error("execCommand failed"));
    } catch (e) {
      reject(e);
    }
  });
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
