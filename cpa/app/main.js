import { getState, subscribe, canUndo, peekUndo, undo } from "./state.js";
import { initSyncOrchestrator, onConflictResolved } from "./io/sync.js";
import { initConflictBanner } from "./io/conflict-resolver.js";
import "./lib/sync-log.js";  // 註冊 window.__cpaLog 給 DevTools 用

import * as Dashboard from "./views/dashboard.js";
import * as Publishers from "./views/publishers.js";
import * as Channels from "./views/channels.js";
import * as Products from "./views/products.js";
import * as ImportView from "./views/import.js";
import * as Payments from "./views/payments.js";
import * as Settlement from "./views/settlement.js";
import * as PerfReport from "./views/perf-report.js";
import * as Settings from "./views/settings.js";

const views = {
  dashboard: Dashboard,
  publishers: Publishers,
  channels: Channels,
  products: Products,
  import: ImportView,
  payments: Payments,
  settlement: Settlement,
  "perf-report": PerfReport,
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
  document.getElementById("rate-mini").innerHTML = `
    支出 ${(s.settings.expense_rate || 4.8).toFixed(2)}<br>
    收入 ${(s.settings.income_rate || 4.6).toFixed(2)}
  `;
  renderBadges(s);
  renderUndoBtn();
}

function renderBadges(s) {
  // 預留:低餘額警示 → 概覽 badge、待辦 pending 數
  const pending = (s.todos || []).filter((t) => (t.status || "pending") === "pending").length;
  setBadge("dashboard", pending, pending > 0 ? "info" : "");
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

function bindUndoBtn() {
  const btn = document.getElementById("btn-undo");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const entry = undo();
    if (entry) {
      window.toast?.(`↶ 已復原:${entry.label}`, "ok");
    }
  });
}

function bindKeyboard() {
  // Ctrl/Cmd+Z 復原
  document.addEventListener("keydown", (e) => {
    const isUndo = (e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey;
    if (!isUndo) return;
    const tag = (e.target?.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
    e.preventDefault();
    if (canUndo()) {
      const entry = undo();
      if (entry) window.toast?.(`↶ 已復原:${entry.label}`, "ok");
    }
  });
}

function bindSidebarToggle() {
  const btn = document.getElementById("sidebar-toggle");
  const aside = document.querySelector(".sidebar");
  if (!btn || !aside) return;
  const KEY = "cpa_sidebar_collapsed";
  if (localStorage.getItem(KEY) === "1") aside.classList.add("collapsed");
  btn.addEventListener("click", () => {
    aside.classList.toggle("collapsed");
    localStorage.setItem(KEY, aside.classList.contains("collapsed") ? "1" : "0");
  });
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", () => {
  renderSidebar();
  route();
  bindUndoBtn();
  bindKeyboard();
  bindSidebarToggle();
  // 啟動 row-level CAS 同步
  initSyncOrchestrator();
  // 衝突 banner
  initConflictBanner(onConflictResolved);
});
subscribe(() => {
  renderSidebar();
  route();
});

// === Global helpers(modal / toast / confirmAsync)===

window.toast = (msg, kind = "") => {
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

document.getElementById("modal")?.addEventListener("click", (e) => {
  if (e.target.id === "modal") window.modal.close();
});

window.confirmAsync = function (opts) {
  if (typeof opts === "string") opts = { body: opts };
  const {
    title = "確認動作",
    body = "確定?",
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
