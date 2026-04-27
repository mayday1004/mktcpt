// 浮動同步進度橫幅
//
// 目的：使用者按下推送/拉取後可能切到其他畫面，原本掛在「設定」頁的進度條就看不見了。
// 這個 banner 直接掛在 document.body 上，fixed-position，跨所有 view 顯示。
// 推送/拉取進行中持續更新；完成或失敗時顯示結果 4 秒後自動收起。

let bannerEl = null;
let hideTimer = null;

function ensureBanner() {
  if (bannerEl) return bannerEl;
  bannerEl = document.createElement("div");
  bannerEl.className = "sync-banner hidden";
  bannerEl.innerHTML = `
    <div class="sync-banner-head">
      <span class="sync-banner-icon">⟳</span>
      <span class="sync-banner-text">準備中…</span>
    </div>
    <div class="sync-banner-bar"><div class="sync-banner-fill"></div></div>
  `;
  document.body.appendChild(bannerEl);
  return bannerEl;
}

export function showSyncBanner(progress) {
  const el = ensureBanner();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  el.classList.remove("hidden", "ok", "bad", "done");
  const { phase, current = 0, total = 0, name = "" } = progress || {};
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  const verb = phase === "push" ? "推送中" : "拉取中";
  el.querySelector(".sync-banner-icon").textContent = "⟳";
  el.querySelector(".sync-banner-text").textContent =
    `${verb} ${current}/${total} · ${name || "..."} (${pct}%)`;
  el.querySelector(".sync-banner-fill").style.width = `${pct}%`;
}

export function markSyncDone(message, kind = "ok") {
  const el = ensureBanner();
  el.classList.remove("hidden");
  el.classList.add("done", kind);
  el.querySelector(".sync-banner-icon").textContent = kind === "ok" ? "✓" : "✗";
  el.querySelector(".sync-banner-text").textContent = message;
  el.querySelector(".sync-banner-fill").style.width = "100%";
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideSyncBanner(), 4000);
}

export function hideSyncBanner() {
  if (!bannerEl) return;
  bannerEl.classList.add("hidden");
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}
