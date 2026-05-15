// 「偵測到新版本,點此重整」banner。
// 右下角固定,使用者可選擇立即重整或稍後(關掉 banner、本次 session 不再提示)。
// 不自動 reload — 避免吞掉沒推上去的 in-flight 改動。

let bannerEl = null;

export function showUpdateBanner({ runningBuild, serverBuild, onReload }) {
  if (bannerEl) return; // 已經在畫面上了
  bannerEl = document.createElement("div");
  bannerEl.className = "update-banner";
  bannerEl.style.cssText = `
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 9999;
    background: #2563eb;
    color: #fff;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,.2);
    max-width: 320px;
    font-size: 14px;
    line-height: 1.5;
  `;
  bannerEl.innerHTML = `
    <div style="font-weight:600;margin-bottom:4px">🔄 偵測到新版本</div>
    <div style="opacity:.85;font-size:12px;margin-bottom:8px">
      ${runningBuild} → ${serverBuild}<br>
      建議重新整理以套用更新。
    </div>
    <div style="display:flex;gap:8px">
      <button data-act="reload" style="flex:1;padding:6px 12px;background:#fff;color:#2563eb;border:none;border-radius:4px;font-weight:600;cursor:pointer">立即重整</button>
      <button data-act="dismiss" style="padding:6px 12px;background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:4px;cursor:pointer">稍後</button>
    </div>
  `;
  bannerEl.querySelector('[data-act="reload"]').addEventListener("click", () => {
    if (onReload) onReload();
    else location.reload();
  });
  bannerEl.querySelector('[data-act="dismiss"]').addEventListener("click", () => {
    bannerEl?.remove();
    bannerEl = null;
  });
  // 用 __mountBanner 而不是直接 appendChild 到 body — 若此刻 modal 正開著,
  // 會掛進 modal 內讓 banner 跟著進 top-layer,不被 backdrop 模糊化(main.js)
  if (window.__mountBanner) window.__mountBanner(bannerEl);
  else document.body.appendChild(bannerEl);
}
