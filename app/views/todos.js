import { getState, update, uid } from "../state.js";
import { nowTaipeiStamp } from "../lib/dates.js";
import { applyUndo } from "../domain/undo.js";

export function render(root) {
  const s = getState();
  const pending = s.todos.filter((t) => t.status === "pending");
  const done = s.todos.filter((t) => t.status === "done");

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

    ${done.length ? `<div class="card"><h2>已完成（${done.length}）</h2>${listHtml(done, true)}</div>` : ""}
  `;

  root.querySelector("#btn-add-todo").onclick = () => openTodoEditor();

  root.querySelectorAll("[data-done]").forEach((el) => {
    el.onclick = () => {
      update((st) => {
        const t = st.todos.find((x) => x.id === el.dataset.done);
        if (t) {
          t.status = "done";
          keepEliminatedAdsDone(st, t);
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

function keepEliminatedAdsDone(state, todo) {
  if (todo?.action_type !== "淘汰廣告") return;
  const codes = new Set();
  for (const snap of (todo.undo_payload?.ad_snapshots || [])) {
    if (snap?.ad_code) codes.add(snap.ad_code);
  }
  const firstLine = String(todo.description || "").trim().split(/\s|\n|：|:/)[0];
  if (firstLine) codes.add(firstLine);
  if (codes.size === 0) return;
  for (const ad of (state.ads || [])) {
    if (codes.has(ad.ad_code)) ad.eliminated = true;
  }
}

function listHtml(todos, isDone) {
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>時間</th><th>類型</th><th>內容</th><th></th></tr>
        </thead>
        <tbody>
          ${todos.map((t) => `
            <tr>
              <td class="mono ink-2" style="font-size:12px">${t.created_at}</td>
              <td><span class="pill">${escape(t.action_type)}</span></td>
              <td style="white-space:pre-wrap;line-height:1.6">${highlightTodoDesc(t.description)}</td>
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

// 與各個 view 寫入的 action_type 對齊(風格 X:看名字就知道目的)
const ACTION_TYPES = ["手動", "手動改權重", "新增廣告", "廣告續費", "成效調整權重", "補日花費缺口", "淘汰廣告", "其他"];

function openTodoEditor(id) {
  const s = getState();
  const t = id ? structuredClone(s.todos.find((x) => x.id === id)) : null;
  const isEdit = !!t;
  const html = `
    <h2>${isEdit ? "編輯待辦" : "新增待辦"}</h2>
    <div class="field">
      <label>類型</label>
      <select id="t-type">
        ${ACTION_TYPES.map((a) => `<option value="${a}" ${t?.action_type === a ? "selected" : ""}>${a}</option>`).join("")}
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
    const action_type = dlg.querySelector("#t-type").value || "手動";
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
    }, isEdit ? "更新待辦" : "新增手動待辦");
    modal.close();
    toast(isEdit ? "已更新" : "已新增", "ok");
  };
}

function escape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 渲染 todo description：把 " → " 後面（直到行尾）標粗體深綠 — 強調權重調整後的新狀態
function highlightTodoDesc(desc) {
  if (!desc) return "<span class='ink-3'>—</span>";
  const escaped = escape(desc);
  return escaped.replace(/( → )([^\n]+)/g, (m, arrow, after) =>
    `${arrow}<strong style="color:#1f7a3a">${after}</strong>`);
}
