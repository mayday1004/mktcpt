import { getState, update, uid } from "../state.js";

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
        if (t) t.status = "done";
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
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmAsync({
        title: "刪除待辦",
        body: "確認刪除此筆待辦？",
        okText: "刪除", danger: true,
      });
      if (!ok) return;
      update((st) => { st.todos = st.todos.filter((t) => t.id !== el.dataset.del); }, "刪除待辦");
    };
  });
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
              <td>${escape(t.description) || "<span class='ink-3'>—</span>"}</td>
              <td class="right nowrap">
                ${isDone
                  ? `<button data-undo="${t.id}">↺ 重新打開</button>`
                  : `<button data-edit="${t.id}">編輯</button> <button class="primary" data-done="${t.id}">完成</button>`}
                <button class="danger" data-del="${t.id}">刪</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

const ACTION_TYPES = ["手動", "權重變更", "新增廣告", "廣告續費", "成效驅動權重調整", "提前結束（成效淘汰）", "其他"];

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
          created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
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
