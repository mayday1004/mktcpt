import { getState, subscribe, canUndo, peekUndo, undo } from "./state.js";
import { getExpenseRate, getIncomeRate, getRateSource } from "./schema.js";
import { initSyncOrchestrator } from "./io/sync.js";
import * as Dashboard from "./views/dashboard.js";
import * as Products from "./views/products.js";
import * as Ads from "./views/ads.js";
import * as PerfAdjust from "./views/perf-adjust.js";
import * as PerfReport from "./views/perf-report.js";
import * as Reverse from "./views/reverse.js";
import * as Todos from "./views/todos.js";
import * as Settings from "./views/settings.js";
import * as ShortUrls from "./views/short-urls.js";

const views = {
  dashboard: Dashboard,
  products: Products,
  ads: Ads,
  "perf-adjust": PerfAdjust,
  "perf-report": PerfReport,
  reverse: Reverse,
  "short-urls": ShortUrls,
  todos: Todos,
  settings: Settings,
};

function route() {
  const hash = location.hash.slice(1) || "dashboard";
  const view = views[hash] || Dashboard;
  const root = document.getElementById("view");
  root.innerHTML = "";
  view.render(root);
  document.querySelectorAll(".sidebar nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.view === hash);
  });
}

function renderSidebar() {
  const s = getState();
  const ym = s.settings.current_month;
  document.getElementById("brand-month").textContent = ym;
  // 顯示當月解析後匯率，並標示是否來自月度覆寫
  const expRate = getExpenseRate(s, ym);
  const incRate = getIncomeRate(s, ym);
  const expSrc = getRateSource(s, ym, "expense") === "monthly" ? "★" : "";
  const incSrc = getRateSource(s, ym, "income") === "monthly" ? "★" : "";
  document.getElementById("rate-mini").innerHTML = `
    支出 ${expRate.toFixed(2)} ${expSrc}<br>
    收入 ${incRate.toFixed(2)} ${incSrc}
    ${(expSrc || incSrc) ? `<div style="font-size:10px;opacity:0.6;margin-top:2px">★=本月覆寫</div>` : ""}
  `;
  renderBadges(s);
  renderUndoBtn();
}

function renderBadges(s) {
  // 概覽 badge 已移除：原本是健康度 ribbon 的數字，但 ribbon 已拿掉，
  // 即將到期搬到「廣告列表」、預算/帶寬警示在 dashboard 內各區塊已可視，
  // 留在這裡會誤導使用者以為有未處理事項。
  // 待辦：pending 數量
  const pending = (s.todos || []).filter((t) => (t.status || "pending") === "pending").length;
  setBadge("todos", pending, pending > 0 ? "info" : "");
}

function setBadge(view, count, kind) {
  const el = document.querySelector(`[data-badge="${view}"]`);
  if (!el) return;
  if (!count) {
    el.textContent = "";
    el.className = "nav-badge";
    return;
  }
  el.textContent = String(count);
  el.className = `nav-badge ${kind}`;
}

function renderUndoBtn() {
  const btn = document.getElementById("btn-undo");
  if (!btn) return;
  const ok = canUndo();
  btn.disabled = !ok;
  const labelEl = document.getElementById("undo-label");
  const peek = peekUndo();
  if (labelEl) {
    labelEl.textContent = ok && peek?.label ? `復原「${peek.label}」` : "復原";
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  renderSidebar();
  route();
  bindUndoBtn();
  bindKeyboard();
  bindSidebarToggle();
  // 啟動 row-level LWW 同步：載入時跑一次、state 變動 debounce 5 秒、每 30 秒背景 poll
  initSyncOrchestrator();
});
subscribe(() => {
  renderSidebar();
  route();
});

function bindUndoBtn() {
  const btn = document.getElementById("btn-undo");
  if (!btn) return;
  btn.onclick = () => {
    const entry = undo();
    if (entry) {
      window.toast(`已復原：${entry.label}`, "ok");
    } else {
      window.toast("沒有可復原的操作", "");
    }
  };
}

const SIDEBAR_KEY = "buyads_sidebar_collapsed";
function bindSidebarToggle() {
  const aside = document.querySelector(".sidebar");
  const btn = document.getElementById("sidebar-toggle");
  if (!aside || !btn) return;
  if (localStorage.getItem(SIDEBAR_KEY) === "1") aside.classList.add("collapsed");
  btn.onclick = () => {
    aside.classList.toggle("collapsed");
    localStorage.setItem(SIDEBAR_KEY, aside.classList.contains("collapsed") ? "1" : "0");
  };
}

function bindKeyboard() {
  document.addEventListener("keydown", (e) => {
    // 在輸入框/編輯區內不處理快捷鍵
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    // Ctrl+Z / Cmd+Z → undo
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
      if (canUndo()) {
        e.preventDefault();
        const entry = undo();
        if (entry) window.toast(`已復原：${entry.label}`, "ok");
      }
    }
  });
}

// Global helpers for views
window.toast = (msg, kind = "") => {
  // <dialog showModal()> 開啟時走 browser top-layer,凌駕所有 z-index。
  // 若把 toast 放在 body 下方的 toast-host,modal 開著時 toast 會被蓋住 → 改 append 進 modal 內,
  // 讓 toast 跟著進 top-layer。
  const modal = document.getElementById("modal");
  let host;
  if (modal && modal.open) {
    host = modal.querySelector(".toast-host-in-modal");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host-in-modal";
      modal.appendChild(host);
    }
  } else {
    host = document.getElementById("toast-host");
  }
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 2600);
};

window.modal = {
  open(html) {
    const dlg = document.getElementById("modal");
    dlg.innerHTML = `<div class="modal-inner">${html}</div>`;
    dlg.showModal();
    return dlg;
  },
  close() {
    const dlg = document.getElementById("modal");
    if (dlg.open) dlg.close();
    dlg.innerHTML = "";
  },
};

// 點 modal backdrop（點擊到 dialog 本身、而非 .modal-inner 內部）→ 關閉。
// dialog 元素本身佔據整個 viewport 並用 ::backdrop 著色；點擊事件 target 是 dialog 時代表點到了 backdrop。
document.getElementById("modal")?.addEventListener("click", (e) => {
  if (e.target.id === "modal") window.modal.close();
});

// 取代 native confirm()。回傳 Promise<boolean>。
// opts: { title, body, okText, cancelText, danger, details: [string]|HTML, requireType }
// requireType:危險動作要使用者打字確認,例 { word: "覆寫", label: "請輸入「覆寫」以確認" } —
// 輸入框內容必須完全等於 word 才會啟用確認按鈕。
window.confirmAsync = function (opts) {
  if (typeof opts === "string") opts = { body: opts };
  const {
    title = "確認動作",
    body = "確定？",
    okText = "確認",
    cancelText = "取消",
    danger = false,
    details = null,
    requireType = null,
  } = opts || {};

  const detailsHtml = details
    ? (Array.isArray(details)
        ? `<ul class="confirm-details">${details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`
        : `<div class="confirm-details">${details}</div>`)
    : "";

  const typeHtml = requireType
    ? `
      <div class="field" style="margin-top:12px">
        <label style="font-size:13px;color:var(--ink-2)">${esc(requireType.label || `請輸入「${requireType.word}」以確認`)}</label>
        <input id="cmf-type" type="text" placeholder="${esc(requireType.word)}" autocomplete="off" style="width:100%" />
      </div>
    `
    : "";

  return new Promise((resolve) => {
    const html = `
      <h2>${esc(title)}</h2>
      <p style="font-size:14px;color:var(--ink-2);white-space:pre-wrap">${esc(body)}</p>
      ${detailsHtml}
      ${typeHtml}
      <div class="modal-actions">
        <button id="cmf-cancel">${esc(cancelText)}</button>
        <button id="cmf-ok" class="primary ${danger ? "danger" : ""}" ${requireType ? "disabled" : ""}>${esc(okText)}</button>
      </div>
    `;
    const dlg = window.modal.open(html);
    const finish = (v) => { window.modal.close(); resolve(v); };
    const okBtn = dlg.querySelector("#cmf-ok");
    dlg.querySelector("#cmf-cancel").onclick = () => finish(false);
    okBtn.onclick = () => { if (!okBtn.disabled) finish(true); };
    if (requireType) {
      const typeInput = dlg.querySelector("#cmf-type");
      typeInput.oninput = () => {
        okBtn.disabled = typeInput.value !== requireType.word;
      };
      typeInput.onkeydown = (e) => {
        if (e.key === "Enter" && !okBtn.disabled) finish(true);
      };
      setTimeout(() => typeInput.focus(), 0);
    } else {
      setTimeout(() => okBtn.focus(), 0);
    }
  });
};

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
