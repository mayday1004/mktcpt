import { getState } from "../state.js";

// 多縮網址管理:列出有設定縮網址資訊的廣告(縮網址類型 或 縮網址參數 至少一個有值)。
// 新舊連結欄位暫定不加,後續規劃。
export function render(root) {
  const s = getState();
  const ads = (s.ads || []).filter((a) => !a.eliminated && (a.short_url_type || a.short_url_param));

  // 依 ad_code 取最新段(以 start_date 排序取最後)— 同代碼多段共用廣告層級資訊,只列一筆
  const byCode = new Map();
  for (const a of ads) {
    const cur = byCode.get(a.ad_code);
    if (!cur || (a.start_date || "") > (cur.start_date || "")) {
      byCode.set(a.ad_code, a);
    }
  }
  const rows = [...byCode.values()].sort((a, b) =>
    (a.ad_code || "").localeCompare(b.ad_code || "")
  );

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>多縮網址管理</h1>
        <div class="desc">列出所有有設定縮網址資訊的廣告。新增/編輯廣告時可在表單填入「採用連結」與「縮網址參數」。新舊連結欄位後續規劃。</div>
      </div>
    </div>

    <div class="card">
      <h2>清單（${rows.length}）</h2>
      ${rows.length === 0 ? `
        <div class="empty">尚無設定縮網址資訊的廣告<br><span class="ink-3" style="font-size:12px">到「廣告列表 → 新增/編輯廣告」勾選採用連結 (L1/L3/L5) 或填入縮網址參數</span></div>
      ` : `
        <table class="data-grid">
          <thead>
            <tr>
              <th>廣告代碼</th>
              <th>廣告名稱</th>
              <th>廣告文案</th>
              <th>採用連結</th>
              <th>縮網址參數</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((a) => `
              <tr>
                <td class="mono">${esc(a.ad_code)}</td>
                <td>${esc(a.ad_name || "")}</td>
                <td>${a.ad_copy ? esc(a.ad_copy) : "<span class='ink-3'>—</span>"}</td>
                <td>${a.short_url_type ? `<span class="pill">${esc(a.short_url_type)}(${linkLabel(a.short_url_type)})</span>` : "<span class='ink-3'>—</span>"}</td>
                <td class="mono">${a.short_url_param ? esc(a.short_url_param) : "<span class='ink-3'>—</span>"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `}
    </div>
  `;
}

function linkLabel(t) {
  if (t === "L1") return "權重";
  if (t === "L3") return "APK";
  if (t === "L5") return "小島";
  return "";
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
