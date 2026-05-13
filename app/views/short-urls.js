import { getState, update } from "../state.js";

const TYPE_LABEL = { L1: "權重", L3: "APK", L5: "小島" };

// 構造完整 URL: https://{type-lowercased}.{domain}/{param}
function buildUrl(type, domain, param) {
  if (!type || !domain || !param) return "";
  const cleanDomain = String(domain).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!cleanDomain) return "";
  return `https://${type.toLowerCase()}.${cleanDomain}/${param}`;
}

// 顯示模型(2026-05 修):
//   - 新網址(newDomain):per-ad override 優先,否則 fall back 到全站 settings.short_url_new_domain
//   - 舊網址(oldDomain):per-ad override 優先,不 fall back 到全站(沒寫=這支廣告沒有舊網址,屬於新合作)
// 套用全站新網址時,系統會把每支廣告當下的「有效新網址」snapshot 進它自己的 short_url_old_override,
// 讓既有廣告自動帶上歷史,新建廣告(沒走過 cascade)就維持「舊=(空)」。
function effectiveDomains(s, ad) {
  return {
    oldDomain: ad.short_url_old_override || "",
    newDomain: ad.short_url_new_override || s.settings.short_url_new_domain || "",
    oldOverridden: !!ad.short_url_old_override,
    newOverridden: !!ad.short_url_new_override,
  };
}

// 複製模板分兩種:
//   有舊連結 → 通知站長更換鏈接
//   無舊連結 → 新合作(該廣告從沒在別處跑過)
function buildCopyText(ad, oldUrl, newUrl) {
  if (!oldUrl) {
    const head = ad.ad_name ? `新合作 [${ad.ad_name}]` : "新合作";
    const lines = [head];
    if (ad.ad_copy) lines.push(`文案：  ${ad.ad_copy}`);
    lines.push(`链接：${newUrl || "(未設定)"}`);
    return lines.join("\n");
  }
  const lines = ["你好，麻烦广告链结更换"];
  if (ad.ad_name) lines.push(`[${ad.ad_name}]`);
  if (ad.ad_copy) lines.push(`文案：  ${ad.ad_copy}`);
  lines.push(`旧：  ${oldUrl}`);
  lines.push(`新：  ${newUrl || "(未設定)"}`);
  return lines.join("\n");
}

export function render(root) {
  const s = getState();
  const ads = (s.ads || []).filter((a) => !a.eliminated && (a.short_url_type || a.short_url_param));

  // 同代碼多段:取最新一段(start_date 最大)
  const byCode = new Map();
  for (const a of ads) {
    const cur = byCode.get(a.ad_code);
    if (!cur || (a.start_date || "") > (cur.start_date || "")) byCode.set(a.ad_code, a);
  }
  const rows = [...byCode.values()].sort((a, b) =>
    (a.ad_code || "").localeCompare(b.ad_code || "")
  );

  const globalNew = s.settings.short_url_new_domain || "";

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>縮網址管理</h1>
        <div class="desc" style="max-width:760px;line-height:1.6">
          記錄正在使用中的連結,並通知站長更換。「全站當前網址」即為新網址;套用後<strong>現有廣告</strong>會把當下新網址 snapshot 為自己的舊網址(代表「曾經跑在那」),<strong>新增的廣告</strong>則無舊網址(直接視為新合作)。
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
      </div>
      <div class="hint" style="margin-top:10px;line-height:1.6;font-size:12px">
        套用時:<strong>現有廣告</strong>會把目前的新網址(<span class="mono">${esc(globalNew || "未設定")}</span>)寫進各自的舊網址;新網址 ← 您輸入的值。<br>
        <strong>之後新增的廣告</strong>仍然維持「無舊網址」狀態。
      </div>
      <div style="margin-top:14px;display:inline-flex;gap:10px;align-items:center;font-size:13px;color:var(--ink-2);padding:8px 14px;background:#f6f7f9;border-radius:6px;border:1px solid var(--line)">
        <span style="color:var(--ink-3)">目前全站新網址</span>
        <strong class="mono" style="font-size:14px;color:var(--ink)">${esc(globalNew || "—")}</strong>
      </div>
    </div>

    <div class="card">
      <h2>清單<span class="ink-3" style="font-size:13px;font-weight:400;margin-left:6px">(${rows.length})</span></h2>
      ${rows.length === 0 ? `
        <div class="empty">尚無設定縮網址資訊的廣告<br><span class="ink-3" style="font-size:12px">到「廣告列表 → 新增/編輯廣告」勾選採用連結 (L1/L3/L5) + 填入縮網址參數</span></div>
      ` : `
        <div class="table-wrap" style="margin-top:8px">
          <table class="short-urls-table">
            <colgroup>
              <col style="width:90px" />
              <col style="width:140px" />
              <col style="width:110px" />
              <col style="width:130px" />
              <col />
              <col />
              <col style="width:110px" />
              <col style="width:90px" />
            </colgroup>
            <thead>
              <tr>
                <th>廣告代碼</th>
                <th>廣告名稱</th>
                <th>廣告文案</th>
                <th>類型 / 參數</th>
                <th>舊連結</th>
                <th>新連結</th>
                <th style="text-align:center">發送站長</th>
                <th style="text-align:center">動作</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((a) => renderRow(a, s)).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;

  // 套用「當前網址」:對所有現有廣告做 cascade(snapshot 進 per-ad old override)
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
        ? `將全站新網址設為「${v}」,並把 ${adCount} 支廣告當下的新網址(${cur || "(空)"})寫進它們各自的舊網址。確定?`
        : `將全站新網址清空,並把 ${adCount} 支廣告當下的新網址(${cur || "(空)"})寫進它們各自的舊網址。確定?`;
      if (!window.confirm(confirmMsg)) return;
      update((st) => {
        const previousGlobalNew = st.settings.short_url_new_domain || "";
        for (const ad of st.ads || []) {
          // 該支廣告當下的有效新網址 = override 優先,否則用全站舊值
          const adCurrentNew = ad.short_url_new_override || previousGlobalNew;
          if (adCurrentNew) {
            ad.short_url_old_override = adCurrentNew;
          }
          // 清掉 new override 讓廣告繼續跟全站新值
          delete ad.short_url_new_override;
        }
        st.settings.short_url_new_domain = v;
        // settings.short_url_old_domain 棄用(改 per-ad),清乾淨避免老 UI 誤用
        st.settings.short_url_old_domain = "";
      }, `更新當前網址:${v || "(空)"}`);
      window.toast(v ? `已套用 ${v} 為新網址(現有廣告已更新舊網址)` : "已清空當前網址", "ok");
    };
  }

  // 每筆 複製通知文字
  root.querySelectorAll("[data-copy-code]").forEach((btn) => {
    btn.onclick = () => {
      const code = btn.dataset.copyCode;
      const ad = rows.find((r) => r.ad_code === code);
      if (!ad) return;
      const dom = effectiveDomains(s, ad);
      const oldUrl = buildUrl(ad.short_url_type, dom.oldDomain, ad.short_url_param);
      const newUrl = buildUrl(ad.short_url_type, dom.newDomain, ad.short_url_param);
      const text = buildCopyText(ad, oldUrl, newUrl);
      copyToClipboard(text)
        .then(() => window.toast(`已複製 ${code} 的通知文字`, "ok"))
        .catch(() => window.toast("複製失敗,請手動", "bad"));
    };
  });

  // 每筆 開啟覆寫彈窗
  root.querySelectorAll("[data-override-code]").forEach((btn) => {
    btn.onclick = () => openOverrideModal(btn.dataset.overrideCode);
  });
}

function renderRow(a, s) {
  const dom = effectiveDomains(s, a);
  const oldUrl = buildUrl(a.short_url_type, dom.oldDomain, a.short_url_param);
  const newUrl = buildUrl(a.short_url_type, dom.newDomain, a.short_url_param);
  const typeLabel = a.short_url_type
    ? `<span class="pill">${esc(a.short_url_type)}${TYPE_LABEL[a.short_url_type] ? `(${TYPE_LABEL[a.short_url_type]})` : ""}</span>`
    : "<span class='ink-3'>—</span>";
  const paramText = a.short_url_param
    ? `<div class="mono" style="font-size:11px;color:var(--ink-2);margin-top:3px">${esc(a.short_url_param)}</div>`
    : "";
  const oldTag = dom.oldOverridden ? `<span class="pill" style="font-size:10px;margin-left:6px;background:#fff3cd;color:#856404">覆寫</span>` : "";
  const newTag = dom.newOverridden ? `<span class="pill" style="font-size:10px;margin-left:6px;background:#fff3cd;color:#856404">覆寫</span>` : "";
  const hasOverride = dom.oldOverridden || dom.newOverridden;
  const isNewCollab = !oldUrl;
  const copyLabel = isNewCollab ? "📋 新合作" : "📋 複製";
  const copyTitle = isNewCollab ? "複製「新合作」通知文字(此廣告沒有舊連結)" : "複製通知站長更換鏈接的文字";
  return `
    <tr>
      <td class="mono">${esc(a.ad_code)}</td>
      <td>${esc(a.ad_name || "")}</td>
      <td>${a.ad_copy ? esc(a.ad_copy) : "<span class='ink-3'>—</span>"}</td>
      <td>${typeLabel}${paramText}</td>
      <td class="url-cell">${oldUrl ? esc(oldUrl) : "<span class='ink-3'>(無)</span>"}${oldTag}</td>
      <td class="url-cell">${newUrl ? esc(newUrl) : "<span class='ink-3'>(未設定)</span>"}${newTag}</td>
      <td style="text-align:center"><button data-copy-code="${esc(a.ad_code)}" title="${copyTitle}" class="su-btn">${copyLabel}</button></td>
      <td style="text-align:center"><button data-override-code="${esc(a.ad_code)}" title="編輯此筆的舊/新網域覆寫" class="su-btn">${hasOverride ? "🔧 已編輯" : "✎ 編輯"}</button></td>
    </tr>
  `;
}

function openOverrideModal(adCode) {
  const s = getState();
  // 取最新一段當顯示來源(實際上覆寫會同步寫到所有同代碼 segments)
  const segs = (s.ads || []).filter((a) => a.ad_code === adCode);
  if (segs.length === 0) return;
  segs.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""));
  const ad = segs[0];
  const globalNew = s.settings.short_url_new_domain || "";
  const dom = effectiveDomains(s, ad);
  const oldUrl = buildUrl(ad.short_url_type, dom.oldDomain, ad.short_url_param);
  const newUrl = buildUrl(ad.short_url_type, dom.newDomain, ad.short_url_param);
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
