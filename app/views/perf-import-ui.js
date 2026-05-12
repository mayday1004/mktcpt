// 成效匯入 UI helper
//
// 提供兩個 binding：
//   bindPerfImportButtons(root) — 把 "btn-perf-init" / "btn-perf-import" 按鈕掛上 handler
//   openPerfConfirmModal(valid, errors, conflicts, setStatus?) — 預覽匯入內容的彈窗
//
// 由「成效調整」頁呼叫；獨立成模組是避免邏輯散在多個 view 之間。

import {
  ensurePerfInputSheet, fetchPerfInput, clearPerfInput,
  parsePerfInputRows, mergeIntoState, resolveConflicts, pushPerfDataSheet,
} from "../io/performance-import.js";

export function bindPerfImportButtons(root, opts = {}) {
  const { onStatus = (msg, kind) => { if (msg) window.toast(msg, kind || ""); } } = opts;

  const btnInit = root.querySelector("#btn-perf-init");
  const btnImport = root.querySelector("#btn-perf-import");

  if (btnInit) btnInit.onclick = async () => {
    onStatus("建立中…", "");
    try {
      const r = await ensurePerfInputSheet();
      const msg = r.created ? "✓ 已建立「成效輸入」分頁" : `✓ 分頁已存在（${r.rowCount} 列）`;
      onStatus(msg, "ok");
      window.toast(r.created ? "已建立成效輸入分頁" : `分頁已存在（${r.rowCount} 列）`, "ok");
    } catch (e) {
      onStatus(`✗ ${e.message}`, "bad");
      window.toast(`失敗：${e.message}`, "bad");
    }
  };

  if (btnImport) btnImport.onclick = async () => {
    onStatus("讀取成效輸入分頁…", "");
    try {
      const { headers, rows } = await fetchPerfInput();
      if (!headers.length) {
        onStatus("", "");
        const ok = await window.confirmAsync({
          title: "建立成效輸入分頁",
          body: "尚未建立「成效輸入」分頁。現在建立空表頭嗎？",
          okText: "建立",
        });
        if (ok) {
          await ensurePerfInputSheet();
          window.toast("已建立，請到 Sheets 貼入本週資料後再按此按鈕", "ok");
        }
        return;
      }
      if (!rows.length) {
        onStatus("成效輸入分頁沒有資料列", "bad");
        window.toast("成效輸入分頁沒有資料", "bad");
        return;
      }
      const { valid, errors, conflicts } = parsePerfInputRows(headers, rows);
      openPerfConfirmModal(valid, errors, conflicts, onStatus);
    } catch (e) {
      onStatus(`✗ ${e.message}`, "bad");
      window.toast(`失敗：${e.message}`, "bad");
    }
  };
}

export function openPerfConfirmModal(valid, errors, conflicts, setStatus) {
  const previewRows = valid.slice(0, 8).map((v) => {
    const variant = v.adCodeRaw && v.adCodeRaw !== v.rec.ad_code
      ? `<div class="ink-3" style="font-size:11px">輸入：${escape(v.adCodeRaw)}</div>` : "";
    return `
    <tr>
      <td class="mono">${v.rowNum}</td>
      <td class="mono">${escape(v.rec.ad_code || "")}${variant}</td>
      <td>${escape(v.adName || "")}</td>
      <td>${escape(v.productKey)}</td>
      <td class="mono">${v.rec.period_start}~${v.rec.period_end}</td>
      <td class="num">${Math.round(v.rec["花費"] || 0).toLocaleString()}</td>
      <td class="num">${v.rec["不重複安裝數"] || 0}</td>
    </tr>
  `;
  }).join("");

  const errorList = errors.length
    ? `<div class="perf-errors">
        <strong style="color:var(--bad)">⚠️ ${errors.length} 筆資料有問題（會被跳過）：</strong>
        <ul>${errors.slice(0, 20).map((e) => `<li>第 ${e.row} 列：${escape(e.msg)}</li>`).join("")}
        ${errors.length > 20 ? `<li>…還有 ${errors.length - 20} 筆</li>` : ""}</ul>
       </div>`
    : "";

  const conflictList = conflicts.length
    ? `<div class="perf-conflicts" style="margin-top:12px;padding:12px;border:1px solid var(--warn);border-radius:6px;background:rgba(255,180,0,0.05)">
        <strong>⚠️ ${conflicts.length} 筆代碼重複匹配（需手動選擇）：</strong>
        ${conflicts.map((c) => `
          <div style="margin:8px 0;padding:8px;border-top:1px dashed var(--line)">
            <div style="font-size:12px" class="ink-2">第 ${c.rowNum} 列：輸入 <strong class="mono">${escape(c.adCodeRaw)}</strong> → ${escape(c.productKey)}（${c.periodStart}~${c.periodEnd}）</div>
            <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px">
              <label style="font-size:13px">
                <input type="radio" name="conflict-${c.rowNum}" value="" checked /> 跳過此筆
              </label>
              ${c.candidates.map((a) => `
                <label style="font-size:13px">
                  <input type="radio" name="conflict-${c.rowNum}" value="${a.id}" />
                  ${escape(a.ad_code)} / ${escape(a.ad_name)} — ${a.start_date}~${a.end_date} (每日攤提 ${Math.round(a.daily_amort_twd).toLocaleString()} TWD, ${escape(a.renewal_reason || "")})
                </label>
              `).join("")}
            </div>
          </div>
        `).join("")}
       </div>`
    : "";

  const html = `
    <h2>📥 匯入本週成效</h2>
    <p class="ink-2" style="font-size:13px">
      可匯入 <strong>${valid.length}</strong> 筆${conflicts.length ? `、<strong style="color:var(--warn)">${conflicts.length}</strong> 筆衝突` : ""}${errors.length ? `、<strong style="color:var(--bad)">${errors.length}</strong> 筆錯誤` : ""}
    </p>

    ${conflictList}
    ${errorList}

    ${valid.length ? `
      <h3 class="mt-16">前 ${Math.min(8, valid.length)} 筆預覽</h3>
      <div class="table-wrap" style="max-height:280px">
        <table style="font-size:12px">
          <thead><tr><th>列</th><th>代碼</th><th>名稱</th><th>產品</th><th>期間</th><th class="num">花費</th><th class="num">安裝</th></tr></thead>
          <tbody>${previewRows}</tbody>
        </table>
      </div>
    ` : ""}

    <div class="card" style="margin-top:12px;padding:12px;background:#f7f9fc">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px">
        <input type="checkbox" id="opt-replace-all" />
        <span>🧹 整批替換：清空現有所有成效資料，僅保留本批</span>
      </label>
      <div class="hint" style="margin-top:4px">
        <strong>預設不勾</strong> = 依 (廣告代碼+產品+期間) 自動覆寫;不同週的資料會並存,「依廣告瀏覽」才能算連續兩週的成本漲幅。<br>
        勾起 = 清空所有舊紀錄,只保留本批(會導致上週資料丟失,僅在想完全重來時用)。
      </div>
    </div>

    <div class="modal-actions">
      <button id="cancel">取消</button>
      ${(valid.length || conflicts.length) ? `<button class="primary" id="confirm">匯入</button>` : ""}
    </div>
  `;
  const dlg = window.modal.open(html);
  dlg.querySelector("#cancel").onclick = () => window.modal.close();
  const confirmBtn = dlg.querySelector("#confirm");
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "處理中…";
      try {
        const chosen = {};
        conflicts.forEach((c) => {
          const picked = dlg.querySelector(`input[name="conflict-${c.rowNum}"]:checked`);
          if (picked && picked.value) chosen[c.rowNum] = picked.value;
        });
        const resolved = resolveConflicts(conflicts, chosen);
        const allRecs = [...valid, ...resolved];
        const skipped = conflicts.length - resolved.length;
        const replaceAll = dlg.querySelector("#opt-replace-all")?.checked;
        const { added, overwritten, dropped } = mergeIntoState(
          allRecs,
          replaceAll ? { replaceAll: true } : {}
        );
        await pushPerfDataSheet();
        window.modal.close();
        const summary = `✓ 匯入完成（新增 ${added}、覆寫 ${overwritten}${dropped ? `、清舊 ${dropped}` : ""}${skipped ? `、跳過衝突 ${skipped}` : ""}）`;
        if (setStatus) setStatus(summary, "ok");
        window.toast(`已匯入 ${added + overwritten} 筆${dropped ? `（清掉 ${dropped} 筆舊紀錄）` : ""}`, "ok");
        const clear = await window.confirmAsync({
          title: "清空成效輸入分頁？",
          body: "本次匯入已完成。是否清空 Sheets「成效輸入」分頁，準備下一週貼資料？",
          okText: "清空",
        });
        if (clear) {
          await clearPerfInput();
          window.toast("已清空成效輸入分頁", "ok");
        }
      } catch (e) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "匯入";
        window.toast(`失敗：${e.message}`, "bad");
      }
    };
  }
}

function escape(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
