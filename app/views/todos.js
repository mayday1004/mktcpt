import { getState, update, uid } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import { applyUndo } from "../domain/undo.js";
import { applyDoneEliminateTodos } from "../domain/todo-utils.js";

// 已完成事件紀錄的篩選狀態(留在 module level,切頁回來保留)
let doneFilter = {
  startDate: "",    // YYYY-MM-DD,空 = 不限
  endDate: "",      // YYYY-MM-DD,空 = 不限
  actionType: "",   // 空 = 全部類型
  search: "",       // 模糊搜尋 description / action_type / created_at
};

function filterDoneTodos(done) {
  const q = doneFilter.search.trim().toLowerCase();
  return done.filter((t) => {
    const shownType = displayActionType(t.action_type);
    if (doneFilter.actionType && shownType !== doneFilter.actionType) return false;
    const day = (t.created_at || "").slice(0, 10);   // YYYY-MM-DD
    if (doneFilter.startDate && day && day < doneFilter.startDate) return false;
    if (doneFilter.endDate && day && day > doneFilter.endDate) return false;
    if (q) {
      const hay = `${t.description || ""} ${t.action_type || ""} ${shownType} ${t.created_at || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function render(root) {
  const s = getState();
  const pending = s.todos.filter((t) => t.status === "pending");
  const done = s.todos.filter((t) => t.status === "done");
  const doneFiltered = filterDoneTodos(done);

  // 類型下拉:從已完成資料中實際出現過的 action_type + 預設清單合併,unique
  const typesInData = [...new Set(done.map((t) => displayActionType(t.action_type)).filter(Boolean))];
  const typeOptions = [...new Set([...ACTION_TYPES, ...typesInData])];
  const hasFilter = !!(doneFilter.startDate || doneFilter.endDate || doneFilter.actionType || doneFilter.search);

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>待辦</h1>
        <div class="desc">權重調整 / 廣告採買 / 提前結束 等動作會自動建立待辦；也可手動新增。</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add-todo">＋ 新增待辦</button>
      </div>
    </div>

    <div class="card">
      <h2>待處理（${pending.length}）</h2>
      ${pending.length === 0 ? `<div class="empty">目前沒有待辦<br><span class="ink-3" style="font-size:12px">儲存廣告 / 套用成效調整時會自動建立提醒</span></div>` : listHtml(pending, false)}
    </div>

    ${done.length ? `
      <div class="card">
        <h2>已完成（${hasFilter ? `<span style="color:var(--accent)">${doneFiltered.length}</span> / ${done.length}` : done.length}）</h2>
        <div class="done-filter">
          <div class="done-filter-row">
            <div class="done-filter-group">
              <span class="done-filter-label">📅 期間</span>
              <input type="date" id="df-start" value="${doneFilter.startDate}" />
              <span class="done-filter-sep">~</span>
              <input type="date" id="df-end" value="${doneFilter.endDate}" />
            </div>
            <div class="done-filter-group">
              <span class="done-filter-label">🏷 類型</span>
              <select id="df-type">
                <option value="">全部</option>
                ${typeOptions.map((a) => `<option value="${escape(a)}" ${doneFilter.actionType === a ? "selected" : ""}>${escape(a)}</option>`).join("")}
              </select>
            </div>
            <div class="done-filter-search">
              <span class="done-filter-icon">🔍</span>
              <input type="text" id="df-search" value="${escape(doneFilter.search)}" placeholder="搜尋類型、內容、日期…(例:破解 / 權重 / 2026-05)" autocomplete="off" />
              ${doneFilter.search ? `<button class="done-filter-search-clear" id="df-search-clear" title="清除搜尋">✕</button>` : ""}
            </div>
            ${hasFilter ? `<button class="done-filter-clear" id="df-clear">✕ 清除全部</button>` : ""}
          </div>
        </div>
        ${doneFiltered.length === 0
          ? `<div class="empty" style="padding:30px 0">沒有符合條件的紀錄<br><span class="ink-3" style="font-size:12px">調整上方條件試試</span></div>`
          : listHtml(doneFiltered, true, doneFilter.search.trim())}
      </div>
    ` : ""}
  `;

  // 篩選 inputs
  const startInp = root.querySelector("#df-start");
  const endInp = root.querySelector("#df-end");
  const typeSel = root.querySelector("#df-type");
  const searchInp = root.querySelector("#df-search");
  if (startInp) startInp.onchange = () => { doneFilter.startDate = startInp.value; render(root); };
  if (endInp) endInp.onchange = () => { doneFilter.endDate = endInp.value; render(root); };
  if (typeSel) typeSel.onchange = () => { doneFilter.actionType = typeSel.value; render(root); };
  // 搜尋:用 input 事件即時更新,但用 debounce 避免每打一個字就 re-render
  if (searchInp) {
    let debounceTimer = null;
    searchInp.oninput = () => {
      clearTimeout(debounceTimer);
      const val = searchInp.value;
      debounceTimer = setTimeout(() => {
        doneFilter.search = val;
        const focusPos = searchInp.selectionStart;
        render(root);
        // re-render 後重新聚焦在搜尋框,保留 cursor 位置
        const newInp = root.querySelector("#df-search");
        if (newInp) { newInp.focus(); newInp.setSelectionRange(focusPos, focusPos); }
      }, 180);
    };
  }
  const searchClear = root.querySelector("#df-search-clear");
  if (searchClear) searchClear.onclick = () => { doneFilter.search = ""; render(root); };
  const clearBtn = root.querySelector("#df-clear");
  if (clearBtn) clearBtn.onclick = () => {
    doneFilter = { startDate: "", endDate: "", actionType: "", search: "" };
    render(root);
  };

  root.querySelector("#btn-add-todo").onclick = () => openTodoEditor();

  root.querySelectorAll("[data-done]").forEach((el) => {
    el.onclick = () => {
      update((st) => {
        const t = st.todos.find((x) => x.id === el.dataset.done);
        if (t) {
          t.status = "done";
          applyDoneEliminateTodos(st);
        }
      }, "完成待辦");
      toast("已標記完成", "ok");
    };
  });
  root.querySelectorAll("[data-undo]").forEach((el) => {
    el.onclick = () => {
      update((st) => {
        const t = st.todos.find((x) => x.id === el.dataset.undo);
        if (t) t.status = "pending";
      }, "重新打開待辦");
      toast("已重新打開", "ok");
    };
  });
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => openTodoEditor(el.dataset.edit);
  });
  // 撤回:有 undo_payload 的還原資料,沒有的只刪待辦
  root.querySelectorAll("[data-revoke]").forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.revoke;
      const todo = getState().todos.find((t) => t.id === id);
      if (!todo) return;
      const hasUndo = !!todo.undo_payload && (
        (todo.undo_payload.ad_snapshots?.length || 0) > 0 ||
        (todo.undo_payload.added_ad_ids?.length || 0) > 0
      );
      const ok = await confirmAsync({
        title: hasUndo ? "撤回此決定" : "刪除此待辦",
        body: hasUndo
          ? "撤回會還原此次決定的資料變動(刪掉新建的段、把原段恢復)。\n資料異動「之後」對同一支廣告的調整也會一併回滾,確定?"
          : "此待辦沒有可還原的資料變動,僅刪除提醒。確定?",
        okText: hasUndo ? "撤回" : "刪除", danger: true,
      });
      if (!ok) return;
      let undoResult = { ok: false };
      update((st) => {
        if (hasUndo) {
          undoResult = applyUndo(st, todo.undo_payload);
        }
        st.todos = st.todos.filter((t) => t.id !== id);
      }, hasUndo ? "撤回待辦" : "刪除待辦");
      if (hasUndo && undoResult.ok) {
        toast(`已撤回(還原 ${undoResult.restoredCount} 段、刪除 ${undoResult.deletedCount} 段)`, "ok");
      } else {
        toast(hasUndo ? "撤回失敗" : "已刪除", hasUndo ? "bad" : "ok");
      }
    };
  });
}

function listHtml(todos, isDone, searchTerm = "") {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>時間</th><th>類型</th><th>內容</th><th></th></tr>
        </thead>
        <tbody>
          ${todos.map((t) => `
            <tr>
              <td class="mono ink-2" style="font-size:12px">${highlightMatch(t.created_at, searchTerm)}</td>
              <td><span class="pill todo-type-pill ${todoTypeClass(t.action_type)}">${highlightMatch(displayActionType(t.action_type), searchTerm)}</span></td>
              <td style="white-space:pre-wrap;line-height:1.6">${highlightTodoDesc(t.description, searchTerm)}</td>
              <td class="right nowrap">
                ${isDone
                  ? `<button data-undo="${t.id}">↺ 重新打開</button>`
                  : `<button data-edit="${t.id}">編輯</button> <button class="primary" data-done="${t.id}">完成</button>`}
                <button class="danger" data-revoke="${t.id}" title="${t.undo_payload && ((t.undo_payload.ad_snapshots?.length || 0) + (t.undo_payload.added_ad_ids?.length || 0)) > 0 ? "撤回:還原此次決定的資料變動" : "刪除提醒(無可還原資料)"}">${t.undo_payload && ((t.undo_payload.ad_snapshots?.length || 0) + (t.undo_payload.added_ad_ids?.length || 0)) > 0 ? "↩ 撤回" : "刪"}</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// 舊資料顯示成目前使用的短名稱;不批次改動已同步出去的待辦資料。
const ACTION_TYPE_LABELS = {
  "手動": "備註",
  "成效調整權重": "成效調權重",
  "補日花費缺口": "補花費缺口",
};

// 與各個 view 寫入的 action_type 對齊(風格 X:看名字就知道目的)
const ACTION_TYPES = ["備註", "手動改權重", "新增廣告", "廣告續費", "成效調權重", "補花費缺口", "淘汰廣告"];

function displayActionType(actionType) {
  const raw = String(actionType || "");
  return ACTION_TYPE_LABELS[raw] || raw;
}

function todoTypeClass(actionType) {
  switch (displayActionType(actionType)) {
    case "備註": return "todo-tag-note";
    case "手動改權重": return "todo-tag-manual-weight";
    case "新增廣告": return "todo-tag-add-ad";
    case "廣告續費": return "todo-tag-renewal";
    case "成效調權重": return "todo-tag-perf-weight";
    case "補花費缺口": return "todo-tag-spend-gap";
    case "淘汰廣告": return "todo-tag-eliminate";
    default: return "todo-tag-other";
  }
}

function openTodoEditor(id) {
  const s = getState();
  const t = id ? structuredClone(s.todos.find((x) => x.id === id)) : null;
  const isEdit = !!t;
  const html = `
    <h2>${isEdit ? "編輯待辦" : "新增待辦"}</h2>
    <div class="field">
      <label>類型</label>
      <select id="t-type">
        ${ACTION_TYPES.map((a) => `<option value="${a}" ${displayActionType(t?.action_type) === a ? "selected" : ""}>${a}</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label>內容</label>
      <textarea id="t-desc" rows="3" placeholder="例：去 OneLink 把廣告 70 的 AV9 比例改成 60% / 破圈 40%">${escape(t?.description || "")}</textarea>
    </div>
    <div class="modal-actions">
      <button id="t-cancel">取消</button>
      <button class="primary" id="t-save">${isEdit ? "更新" : "新增"}</button>
    </div>
  `;
  const dlg = modal.open(html);
  dlg.querySelector("#t-cancel").onclick = () => modal.close();
  dlg.querySelector("#t-save").onclick = () => {
    const action_type = dlg.querySelector("#t-type").value || "備註";
    const description = dlg.querySelector("#t-desc").value.trim();
    if (!description) { toast("請填內容", "bad"); return; }
    update((st) => {
      if (isEdit) {
        const idx = st.todos.findIndex((x) => x.id === id);
        if (idx >= 0) st.todos[idx] = { ...st.todos[idx], action_type, description };
      } else {
        st.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type,
          description,
          status: "pending",
        });
      }
    }, isEdit ? "更新待辦" : "新增備註待辦");
    modal.close();
    toast(isEdit ? "已更新" : "已新增", "ok");
  };
}

function escape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 渲染 todo description：把 " → " 後面（直到行尾）標粗體深綠 — 強調權重調整後的新狀態
// 若帶 searchTerm,將命中字串包 <mark> 高亮
function highlightTodoDesc(desc, searchTerm = "") {
  if (!desc) return "<span class='ink-3'>—</span>";
  let escaped = escape(desc);
  escaped = escaped.replace(/( → )([^\n]+)/g, (m, arrow, after) =>
    `${arrow}<strong style="color:#1f7a3a">${after}</strong>`);
  return applySearchHighlight(escaped, searchTerm);
}

// 一般欄位的搜尋高亮(時間 / 類型 等);desc 用上面那個版本
function highlightMatch(text, searchTerm = "") {
  if (!text) return "";
  return applySearchHighlight(escape(text), searchTerm);
}

// 在已 escape 過的 HTML 上做搜尋字串高亮:case-insensitive,包 <mark>
function applySearchHighlight(escapedHtml, searchTerm) {
  const q = (searchTerm || "").trim();
  if (!q) return escapedHtml;
  // searchTerm 也要 escape 一次,並去掉 regex 特殊字元
  const escQ = escape(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escQ) return escapedHtml;
  const re = new RegExp(escQ, "gi");
  return escapedHtml.replace(re, (m) => `<mark style="background:#fff39a;padding:0 2px;border-radius:2px">${m}</mark>`);
}
