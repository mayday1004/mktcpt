// 衝突解決 UI:列出每筆衝突,使用者選擇保留哪邊。
//
// modal 結構:
//   - 標題:⚠️ N 筆同步衝突待處理
//   - 每筆衝突顯示為一個區塊:
//       sheet + _id + source + 偵測時間
//       per-field diff 表(只列「兩邊不同」的欄位):
//         欄位 | 我的版本 | 對方版本 | 結果 radio(用我 / 用對方)
//       區塊底下:🟢 用我的 / 🔵 用對方 / 🟡 智慧合併(不衝突欄位自動合併)
//   - 全域底部:處理所有衝突按鈕,或「全部用我的」/「全部用對方」快捷
//
// 解決邏輯:
//   - 「用我的」:把該筆衝突當「重新提交」處理 — 用對方的 _version 當 expected_version,
//                 我的 dataRow 重推 → 因為對得上,server 接受、bump version
//   - 「用對方的」:直接套用 theirs 進 local state,更新 sync_meta 版本與 fingerprint
//   - 「智慧合併」:逐欄位比對,我這邊改過(value != lastKnown)且對方沒改 → 用我的;
//                  對方改過、我沒改 → 用對方;雙方都改過 → 顯示 radio 強制選一邊
//
// 套用後從 conflict-store 移除該筆。

import { getConflicts, removeConflict, subscribeConflicts } from "./conflict-store.js";
import { getState, applySync } from "../state.js";
import { TABLE_SYNC_SPECS } from "./sync-specs.js";
import { logInfo, logWarn, logError } from "../lib/sync-log.js";

let resolverModalOpen = false;

// === 公用 helpers ===

function specByName(sheetName) {
  return TABLE_SYNC_SPECS.find((s) => s.sheetName === sheetName);
}

// 把 dataRow + dataHeaders 轉成 { header: value } 物件,給 diff / 套用用。
function rowToObj(dataRow, dataHeaders) {
  const obj = {};
  dataHeaders.forEach((h, i) => { obj[h] = dataRow[i]; });
  return obj;
}

function fieldsDiffer(a, b) {
  // 用字串化比較(處理數字 vs 字串、null vs "")
  const A = a == null ? "" : String(a);
  const B = b == null ? "" : String(b);
  return A !== B;
}

// 計算 mine vs theirs 的「不同欄位」清單
function diffFields(mineObj, theirsObj, dataHeaders) {
  const out = [];
  for (const h of dataHeaders) {
    if (fieldsDiffer(mineObj[h], theirsObj[h])) {
      out.push({ header: h, mine: mineObj[h], theirs: theirsObj[h] });
    }
  }
  return out;
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// === 套用解決方案 ===

// 「用對方的」:把 theirs 套進 local state,並通知 sync 層更新 sync_meta
// (sync_meta 更新由 sync.js 提供的 callback 處理,這裡只負責改 state)
function applyTheirs(conflict, onMetaUpdate) {
  const spec = specByName(conflict.sheetName);
  if (!spec) {
    logError("conflict.resolve.specMissing", { sheet: conflict.sheetName });
    return false;
  }
  try {
    const obj = rowToObj(conflict.theirs.dataRow, conflict.theirs.dataHeaders);
    if (String(conflict.theirs._deleted || "").toUpperCase() === "Y") {
      applySync((st) => spec.removeFromState(st, conflict.entityId));
    } else {
      applySync((st) => spec.upsertInState(st, conflict.entityId, obj));
    }
    // 通知 sync 層:本機已對齊 theirs,sync_meta 應更新成 theirs 版本
    if (onMetaUpdate) {
      onMetaUpdate({
        sheetName: conflict.sheetName,
        entityId: conflict.entityId,
        _version: conflict.theirs.version,
        _updated_at: conflict.theirs.updatedAt,
        dataRow: conflict.theirs.dataRow,
      });
    }
    logInfo("conflict.resolve.takeTheirs", { sheet: conflict.sheetName, id: conflict.entityId });
    return true;
  } catch (e) {
    logError("conflict.resolve.applyTheirsFailed", { sheet: conflict.sheetName, id: conflict.entityId, error: String(e?.message || e) });
    return false;
  }
}

// 「用我的」:本機 state 不動,但同步層需要用 theirs 的 version 當新的 expected_version,
// 下次 push 時才會成功(不再衝突)。把 sync_meta 內該筆的 _version 改成 theirs.version,
// 並把 fingerprint 強制設成「跟本機不同」(用 "FORCE_PUSH" 標記),確保下次 sync 一定重推。
function applyMine(conflict, onMetaUpdate) {
  if (onMetaUpdate) {
    onMetaUpdate({
      sheetName: conflict.sheetName,
      entityId: conflict.entityId,
      _version: conflict.theirs.version,  // 用對方的版本當 expected
      _updated_at: conflict.theirs.updatedAt,
      forcePush: true,  // 標記:即使 fingerprint 對得上也要重推
    });
  }
  logInfo("conflict.resolve.takeMine", { sheet: conflict.sheetName, id: conflict.entityId });
  return true;
}

// 「智慧合併」:逐欄位決定 — 我改過且對方沒改 → 用我;對方改過我沒改 → 用對方;
// 雙方都改過 → 退回讓使用者逐欄選(modal 內 radio)。
// 套用方式:組一個合併後的 obj,upsertInState 進本機,再標 forcePush 讓 sync 推上去。
function applyMerge(conflict, perFieldChoices, onMetaUpdate) {
  const spec = specByName(conflict.sheetName);
  if (!spec) {
    logError("conflict.resolve.specMissing", { sheet: conflict.sheetName });
    return false;
  }
  try {
    const mineObj = rowToObj(conflict.mine.dataRow, conflict.mine.dataHeaders);
    const theirsObj = rowToObj(conflict.theirs.dataRow, conflict.theirs.dataHeaders);
    const merged = {};
    for (const h of conflict.mine.dataHeaders) {
      const choice = perFieldChoices?.[h];
      if (choice === "theirs") merged[h] = theirsObj[h];
      else merged[h] = mineObj[h];  // 預設用我的
    }
    applySync((st) => spec.upsertInState(st, conflict.entityId, merged));
    if (onMetaUpdate) {
      onMetaUpdate({
        sheetName: conflict.sheetName,
        entityId: conflict.entityId,
        _version: conflict.theirs.version,
        _updated_at: conflict.theirs.updatedAt,
        forcePush: true,
      });
    }
    logInfo("conflict.resolve.merge", { sheet: conflict.sheetName, id: conflict.entityId });
    return true;
  } catch (e) {
    logError("conflict.resolve.mergeFailed", { sheet: conflict.sheetName, id: conflict.entityId, error: String(e?.message || e) });
    return false;
  }
}

// === Modal 渲染 ===

function renderConflictBlock(conflict, idx) {
  const fields = diffFields(
    rowToObj(conflict.mine.dataRow, conflict.mine.dataHeaders),
    rowToObj(conflict.theirs.dataRow, conflict.theirs.dataHeaders),
    conflict.mine.dataHeaders,
  );

  // 衝突欄位的 radio(預設選「我的」)
  const fieldRows = fields.length === 0
    ? `<tr><td colspan="3" class="ink-2">(內容相同,可能是 metadata 衝突)</td></tr>`
    : fields.map((f) => `
      <tr data-field="${esc(f.header)}">
        <td><strong>${esc(f.header)}</strong></td>
        <td class="diff-mine">${esc(f.mine)}</td>
        <td class="diff-theirs">${esc(f.theirs)}</td>
        <td class="diff-pick">
          <label><input type="radio" name="pick-${idx}-${esc(f.header)}" value="mine" checked /> 我</label>
          <label><input type="radio" name="pick-${idx}-${esc(f.header)}" value="theirs" /> 對方</label>
        </td>
      </tr>
    `).join("");

  return `
    <div class="conflict-block" data-conflict-id="${esc(conflict.id)}" data-idx="${idx}">
      <div class="conflict-head">
        <span class="conflict-badge ${conflict.source === "push" ? "src-push" : "src-pull"}">
          ${conflict.source === "push" ? "推送被拒" : "拉取衝突"}
        </span>
        <strong>${esc(conflict.sheetName)}</strong>
        <span class="ink-2 mono">${esc(conflict.entityId)}</span>
        <span class="ink-3" style="margin-left:auto;font-size:11px">
          偵測 ${esc(conflict.detectedAt.slice(11, 19))} ·
          對方版本 v${esc(conflict.theirs.version)}(${esc((conflict.theirs.updatedAt || "").slice(11, 19))})
        </span>
      </div>
      <table class="conflict-diff">
        <thead>
          <tr>
            <th style="width:25%">欄位</th>
            <th style="width:30%">我的版本</th>
            <th style="width:30%">對方版本</th>
            <th style="width:15%">採用</th>
          </tr>
        </thead>
        <tbody>${fieldRows}</tbody>
      </table>
      <div class="conflict-actions">
        <button class="conflict-take-mine">🟢 全用我的</button>
        <button class="conflict-take-theirs">🔵 全用對方</button>
        <button class="conflict-merge primary">🟡 套用上方逐欄選擇</button>
      </div>
    </div>
  `;
}

// 開啟衝突解決 modal。onMetaUpdate(updateObj) 由 sync.js 提供,套用解決方案後
// 同步層用它來更新 sync_meta(把 _version 對齊 theirs 並決定是否 forcePush)。
export function openConflictResolver(onMetaUpdate) {
  if (resolverModalOpen) return;
  resolverModalOpen = true;

  const render = () => {
    const conflicts = getConflicts();
    if (conflicts.length === 0) {
      window.modal.close();
      resolverModalOpen = false;
      window.toast?.("✓ 衝突已全部處理", "ok");
      return;
    }
    const blocks = conflicts.map((c, i) => renderConflictBlock(c, i)).join("");
    const html = `
      <h2>⚠️ ${conflicts.length} 筆同步衝突待處理</h2>
      <p class="ink-2" style="font-size:13px;line-height:1.6">
        以下資料同事跟你都動過。每筆獨立處理:可全用我的、全用對方,或逐欄選擇後按「套用上方逐欄選擇」。
        <br><span class="ink-3">處理完成的衝突會自動消失。未處理前自動同步會暫停,避免覆寫。</span>
      </p>
      <div class="conflict-list">${blocks}</div>
      <div class="modal-actions">
        <button class="conflict-bulk-mine">🟢 全部用我的</button>
        <button class="conflict-bulk-theirs">🔵 全部用對方</button>
        <button id="conflict-close">關閉(稍後再處理)</button>
      </div>
    `;
    const dlg = window.modal.open(html);

    const handleResolve = (conflictId, fn) => {
      const conflict = getConflicts().find((c) => c.id === conflictId);
      if (!conflict) return;
      const ok = fn(conflict);
      if (ok) removeConflict(conflictId);
      // re-render
      render();
    };

    dlg.querySelectorAll(".conflict-block").forEach((block) => {
      const conflictId = block.dataset.conflictId;
      block.querySelector(".conflict-take-mine").onclick = () =>
        handleResolve(conflictId, (c) => applyMine(c, onMetaUpdate));
      block.querySelector(".conflict-take-theirs").onclick = () =>
        handleResolve(conflictId, (c) => applyTheirs(c, onMetaUpdate));
      block.querySelector(".conflict-merge").onclick = () => {
        const picks = {};
        block.querySelectorAll("tr[data-field]").forEach((tr) => {
          const field = tr.dataset.field;
          const checked = tr.querySelector(`input[type=radio]:checked`);
          picks[field] = checked?.value || "mine";
        });
        handleResolve(conflictId, (c) => applyMerge(c, picks, onMetaUpdate));
      };
    });

    dlg.querySelector(".conflict-bulk-mine").onclick = () => {
      const all = getConflicts();
      for (const c of all) {
        if (applyMine(c, onMetaUpdate)) removeConflict(c.id);
      }
      render();
    };
    dlg.querySelector(".conflict-bulk-theirs").onclick = () => {
      const all = getConflicts();
      for (const c of all) {
        if (applyTheirs(c, onMetaUpdate)) removeConflict(c.id);
      }
      render();
    };
    dlg.querySelector("#conflict-close").onclick = () => {
      window.modal.close();
      resolverModalOpen = false;
    };
  };

  render();
}

// 衝突 banner — 固定釘在右下角,有衝突就顯示計數,點擊開 resolver
let bannerEl = null;

function ensureBanner(onClick) {
  if (bannerEl) return bannerEl;
  bannerEl = document.createElement("div");
  bannerEl.className = "conflict-banner hidden";
  bannerEl.innerHTML = `
    <span class="conflict-banner-icon">⚠️</span>
    <span class="conflict-banner-text">0 筆衝突</span>
  `;
  bannerEl.onclick = onClick;
  document.body.appendChild(bannerEl);
  return bannerEl;
}

export function initConflictBanner(onMetaUpdate) {
  const el = ensureBanner(() => openConflictResolver(onMetaUpdate));
  const update = (queue) => {
    if (queue.length === 0) {
      el.classList.add("hidden");
    } else {
      el.classList.remove("hidden");
      el.querySelector(".conflict-banner-text").textContent =
        `${queue.length} 筆衝突,點此處理`;
    }
  };
  update(getConflicts());
  subscribeConflicts(update);
}
