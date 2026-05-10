// 廣告調整建議 Modal(CLAUDE.md §5.8.3 v2)
//
// 對外 API:
//   openGiftDayFixModal(onApplied?)
//
// 自動跑 planAdjustments,把建議列出來。每筆有勾選框,預設全勾;確認後產 `權重調整` 段並建一筆待辦。
// 找不到任何建議時 → 顯示提示文字 + 「前往採買建議」按鈕(會把目標日期存進 sessionStorage)。

import { getState, update, uid } from "../state.js";
import {
  planAdjustments, detectFutureGaps, detectShortfalls, detectAppMonthlyUnderspend,
} from "../domain/gift-days.js";
import { buildWeightAdjust } from "../domain/lifecycle.js";
import { captureUndoSnapshot } from "../domain/undo.js";
import { todayTaipei, nowTaipeiStamp } from "../lib/dates.js";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 按鈕「前往採買建議」 — 把建議日期塞進 sessionStorage,reverse view 載入時自動帶入
function gotoReverseWithDate(date) {
  if (date) sessionStorage.setItem("buyads_reverse_prefill_date", date);
  window.location.hash = "#reverse";
}

export function openGiftDayFixModal(onApplied) {
  const state = getState();
  const today = todayTaipei();
  const planned = planAdjustments(state, today);

  if (planned.length === 0) {
    // 找不到任何修補建議 — 用 detect 結果分情境給文案
    const gaps = detectFutureGaps(state, today);
    const shortfalls = detectShortfalls(state, today);
    const underspends = detectAppMonthlyUnderspend(state, today);
    const earliestDate = pickEarliestRelevantDate(gaps, shortfalls);

    let body = "";
    let showGotoBtn = false;

    if (shortfalls.length === 0 && underspends.length === 0 && gaps.length === 0) {
      body = "目前沒有偵測到需要調整的廣告:沒有未採買空檔、沒有產品日花費低於下限、APP 月攤提也沒少花超過 6 萬。";
    } else if (shortfalls.length === 0 && underspends.length === 0) {
      body = `偵測到 <strong>${gaps.length}</strong> 段未採買空檔,但這段期間各產品的建議日花費都還在<strong>下限以上</strong>,不需要調整(此情況系統會被動接受少花)。`;
    } else {
      // 有 shortfall 或 monthly underspend,但 plan 為空 → 通常代表沒得借
      const totalShortfall = shortfalls.reduce((s, sf) => s + sf.totalShortfall, 0);
      const totalUnderspend = underspends.reduce((s, u) => s + u.underspend, 0);
      body = renderNoSourceMessage(shortfalls, underspends, totalShortfall, totalUnderspend);
      showGotoBtn = true;
    }

    const html = `
      <h2>🎁 廣告調整建議</h2>
      <p style="font-size:14px;line-height:1.8">${body}</p>
      <div class="modal-actions">
        ${showGotoBtn && earliestDate
          ? `<button class="primary" id="goto-reverse">前往採買建議</button>
             <button id="ok">了解</button>`
          : `<button class="primary" id="ok">了解</button>`}
      </div>
    `;
    const dlg = window.modal.open(html);
    dlg.querySelector("#ok").onclick = () => window.modal.close();
    const gotoBtn = dlg.querySelector("#goto-reverse");
    if (gotoBtn) {
      gotoBtn.onclick = () => {
        window.modal.close();
        gotoReverseWithDate(earliestDate);
      };
    }
    return;
  }

  // 依 effective date 排序
  planned.sort((a, b) => (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0));

  const nameOfP = Object.fromEntries((state.products || []).map((p) => [p.id, p.name]));

  // 統計各 priority 的數量
  const pri1 = planned.filter((p) => p.priority === 1).length;
  const pri2 = planned.filter((p) => p.priority === 2).length;
  const pri3 = planned.filter((p) => p.priority === 3).length;
  const affectedAds = new Set(planned.map((p) => p.ad.id));
  const affectedTargets = new Set(planned.map((p) => p.targetPid));

  const priorityLabel = (p) => {
    if (p === 1) return `<span class="pill bad" style="font-size:10px">小島補下限</span>`;
    if (p === 2) return `<span class="pill" style="background:#eef4ff;color:var(--accent);font-size:10px">APP 補月預算</span>`;
    return `<span class="pill warn" style="font-size:10px">APP 補下限</span>`;
  };

  const rows = planned.map((p, i) => {
    const sourceName = nameOfP[p.sourcePid] || p.sourcePid;
    const targetName = nameOfP[p.targetPid] || p.targetPid;
    const isTransfer = p.kind === "transfer";
    const transferTag = isTransfer
      ? ` <span class="pill" style="background:#fff8e6;color:#a06b00;font-size:10px;margin-left:4px">🔒 整桶搬</span>`
      : "";
    const breachTag = p.sourceLowerBreached
      ? ` <span class="pill bad" style="font-size:10px;margin-left:4px" title="此調整會讓 ${esc(sourceName)} 跌破建議日花費下限,建議盡快採買新廣告補上">⚠ ${esc(sourceName)} 將破下限</span>`
      : "";
    const variation = isTransfer
      ? `${esc(sourceName)} 100% <span class="ink-3">→</span> ${esc(targetName)} 100%`
      : `${esc(sourceName)} <span class="ink-3">→</span> ${esc(targetName)} <strong>${p.deltaW}%</strong>`;
    return `
      <tr ${p.sourceLowerBreached ? 'class="row-warn"' : ''}>
        <td><input type="checkbox" class="gd-fix-pick" data-idx="${i}" checked /></td>
        <td>${priorityLabel(p.priority)}${transferTag}${breachTag}</td>
        <td class="mono">${esc(p.ad.ad_code)}</td>
        <td>${esc(p.ad.ad_name)}</td>
        <td class="mono">${esc(p.effective)}</td>
        <td>${variation}</td>
      </tr>
    `;
  }).join("");

  const summaryParts = [];
  if (pri1 > 0) summaryParts.push(`<strong>${pri1}</strong> 筆「小島補下限」`);
  if (pri2 > 0) summaryParts.push(`<strong>${pri2}</strong> 筆「APP 補月預算」`);
  if (pri3 > 0) summaryParts.push(`<strong>${pri3}</strong> 筆「APP 補下限」`);

  // 偵測有沒有「補小島會讓 APP 跌破下限」的調整
  const breachedFixes = planned.filter((p) => p.sourceLowerBreached);
  const breachedSourceNames = [...new Set(breachedFixes.map((p) => nameOfP[p.sourcePid] || p.sourcePid))];

  const html = `
    <h2>🎁 廣告調整建議</h2>
    <p class="ink-2" style="font-size:13px;line-height:1.7">
      系統建議 ${summaryParts.join("、")},涉及 <strong>${affectedAds.size}</strong> 支廣告、<strong>${affectedTargets.size}</strong> 個目標產品。
      <br>每筆預設勾選,可手動取消;按下「套用」會對勾選筆產生 <strong>權重調整</strong> 新段並建一筆待辦。
    </p>

    ${breachedFixes.length > 0 ? `
      <div style="margin-bottom:10px;padding:10px 12px;background:#fde3e3;border-left:3px solid var(--bad);border-radius:4px;font-size:13px;line-height:1.6">
        <strong>⚠️ 有 ${breachedFixes.length} 筆調整會讓 APP 產品跌破日花費下限</strong><br>
        受影響:${breachedSourceNames.map((n) => `<strong>${esc(n)}</strong>`).join("、")}。為了優先補小島下限(優先序 1)而軟性犧牲 APP 下限(優先序 4)。
        <br><strong>👉 建議盡快採買新廣告補上 ${breachedSourceNames.map((n) => esc(n)).join("、")} 的不足。</strong>
      </div>
    ` : ""}

    <div class="impact-legend" style="margin-bottom:8px">
      <span class="impact-legend-item"><span class="pill bad" style="font-size:10px">小島補下限</span> 嚴格 ±0.5%(最高優先)</span>
      <span class="impact-legend-item"><span class="pill" style="background:#eef4ff;color:var(--accent);font-size:10px">APP 補月預算</span> 少花 > 6 萬時可破上限</span>
      <span class="impact-legend-item"><span class="pill warn" style="font-size:10px">APP 補下限</span> ±30%(軟性)</span>
    </div>

    <div class="table-wrap" style="max-height:400px;overflow:auto">
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="gd-fix-pick-all" checked title="全選/取消" /></th>
            <th>類型</th>
            <th>廣告代碼</th>
            <th>名稱</th>
            <th>生效日</th>
            <th>變動</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    <div class="modal-actions">
      <button id="gd-cancel">取消</button>
      <button class="primary" id="gd-apply">套用 <span id="gd-pick-count">${planned.length}</span> 筆</button>
    </div>
  `;

  const dlg = window.modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  const updatePickCount = () => {
    const n = dlg.querySelectorAll(".gd-fix-pick:checked").length;
    q("#gd-pick-count").textContent = String(n);
  };

  q("#gd-fix-pick-all").onchange = (e) => {
    dlg.querySelectorAll(".gd-fix-pick").forEach((c) => { c.checked = e.target.checked; });
    updatePickCount();
  };
  dlg.querySelectorAll(".gd-fix-pick").forEach((c) => {
    c.onchange = () => updatePickCount();
  });

  q("#gd-cancel").onclick = () => window.modal.close();

  q("#gd-apply").onclick = async () => {
    const pickedIdx = [...dlg.querySelectorAll(".gd-fix-pick:checked")].map((c) => Number(c.dataset.idx));
    if (pickedIdx.length === 0) {
      window.toast("沒有勾選任何項目", "");
      return;
    }
    const picked = pickedIdx.map((i) => planned[i]).sort((a, b) =>
      (a.effective < b.effective ? -1 : a.effective > b.effective ? 1 : 0)
    );

    let okCount = 0, errCount = 0;
    const successDescs = [];

    update((st) => {
      // 撤回快照:先 snapshot 所有要被改的「原段」(picked 唯一的 seg)
      const targetSegIds = [...new Set(picked.map((p) => {
        const segs = st.ads.filter((a) => a.ad_code === p.ad.ad_code && !a.eliminated)
          .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
        return segs.find((s) => s.start_date <= p.effective && p.effective < s.end_date)?.id;
      }).filter(Boolean))];
      const ad_snapshots = captureUndoSnapshot(st, targetSegIds);
      const added_ad_ids = [];

      for (const p of picked) {
        const segs = st.ads.filter((a) => a.ad_code === p.ad.ad_code && !a.eliminated)
          .sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
        const seg = segs.find((s) =>
          s.start_date <= p.effective && p.effective < s.end_date
        );
        if (!seg) { errCount++; continue; }
        const newWeights = { ...(seg.weights || {}) };
        const sourceCur = Number(newWeights[p.sourcePid]) || 0;
        const targetCur = Number(newWeights[p.targetPid]) || 0;
        newWeights[p.sourcePid] = sourceCur - p.deltaW;
        newWeights[p.targetPid] = targetCur + p.deltaW;
        for (const k of Object.keys(newWeights)) {
          if (Number(newWeights[k]) <= 0) delete newWeights[k];
        }
        try {
          if (p.effective <= seg.start_date) {
            seg.weights = newWeights;
          } else {
            const r = buildWeightAdjust(seg, p.effective, newWeights, p.reasonNote);
            const i = st.ads.findIndex((a) => a.id === seg.id);
            if (i >= 0) st.ads[i] = r.closed;
            st.ads.push(...r.segments);
            added_ad_ids.push(...r.segments.map((s) => s.id));
          }
          okCount++;
          successDescs.push(`${seg.ad_code} ${seg.ad_name}｜${p.effective} ${nameOfP[p.sourcePid] || p.sourcePid}↔${nameOfP[p.targetPid] || p.targetPid} ${p.deltaW}%`);
        } catch (e) {
          errCount++;
        }
      }
      if (okCount > 0) {
        const targetNames = [...affectedTargets].map((pid) => nameOfP[pid] || pid).join("、");
        st.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type: "補日花費缺口",
          description: `補日花費缺口 ${okCount} 筆${errCount ? `(${errCount} 筆失敗)` : ""},涉及產品:${targetNames}\n${successDescs.join("\n")}\n(請至連結後台調整)`,
          status: "pending",
          undo_payload: { ad_snapshots, added_ad_ids },
        });
      }
    });

    window.modal.close();
    if (okCount > 0) {
      window.toast(`已套用 ${okCount} 筆${errCount ? `,失敗 ${errCount}` : ""}`, "ok");
      if (typeof onApplied === "function") onApplied();
    } else {
      window.toast(`套用失敗(${errCount})`, "bad");
    }
  };
}

// === Helpers ===

// 找最早的相關日期(空檔起 / shortfall 起)— 用來預填到「採買建議」
function pickEarliestRelevantDate(gaps, shortfalls) {
  const candidates = [];
  for (const g of gaps) candidates.push(g.gapStart);
  for (const sf of shortfalls) {
    if (sf.days.length > 0) candidates.push(sf.days[0].date);
  }
  if (candidates.length === 0) return null;
  candidates.sort();
  return candidates[0];
}

// 「找不到來源」訊息 — 提供具體的 shortfall 細節 + 為什麼沒法做權重調整 + 建議
function renderNoSourceMessage(shortfalls, underspends, totalShortfall, totalUnderspend) {
  const parts = [];

  // 1. shortfall 摘要(按產品)
  if (shortfalls.length > 0) {
    const islandSf = shortfalls.filter((sf) => sf.productType === "island");
    const appSf = shortfalls.filter((sf) => sf.productType === "app");
    const sub = [];
    if (islandSf.length > 0) {
      sub.push(`<strong>${islandSf.length}</strong> 個小島產品(${islandSf.map((s) => s.productName).join("、")})`);
    }
    if (appSf.length > 0) {
      sub.push(`<strong>${appSf.length}</strong> 個 APP 產品(${appSf.map((s) => s.productName).join("、")})`);
    }
    parts.push(`偵測到 ${sub.join(" 與 ")} 未來日花費低於建議下限,合計缺 <strong>${Math.round(totalShortfall / 1000)}k</strong> TWD。`);
  }

  if (underspends.length > 0) {
    parts.push(`另有 <strong>${underspends.length}</strong> 個 APP 產品(${underspends.map((u) => u.productName).join("、")})本月預估會少花 > 6 萬,合計 <strong>${Math.round(totalUnderspend / 1000)}k</strong> TWD。`);
  }

  // 2. 按日期切片:列前幾個最嚴重的 shortfall 日,讓使用者看「哪天缺多少」
  const byDate = new Map();  // date → [{ pid, name, shortfall }]
  for (const sf of shortfalls) {
    for (const d of sf.days) {
      if (!byDate.has(d.date)) byDate.set(d.date, []);
      byDate.get(d.date).push({ pid: sf.pid, name: sf.productName, shortfall: d.shortfall });
    }
  }
  if (byDate.size > 0) {
    const sortedDates = [...byDate.entries()]
      .map(([date, items]) => ({
        date, items,
        total: items.reduce((s, x) => s + x.shortfall, 0),
      }))
      .sort((a, b) => b.total - a.total);  // 缺得最多的天優先
    const topN = sortedDates.slice(0, 5);
    const dayLines = topN.map((d) => {
      const items = d.items
        .sort((a, b) => b.shortfall - a.shortfall)
        .slice(0, 3)
        .map((it) => `${it.name} 缺 ${Math.round(it.shortfall).toLocaleString()}`)
        .join("、");
      const more = d.items.length > 3 ? `…等 ${d.items.length} 項` : "";
      return `<li><strong>${d.date.slice(5)}</strong>:${items}${more} <span class="ink-3">(合計缺 ${Math.round(d.total).toLocaleString()} TWD)</span></li>`;
    }).join("");
    const remainder = sortedDates.length > topN.length ? `<div class="ink-3" style="font-size:12px;margin-top:4px">…還有 ${sortedDates.length - topN.length} 天 shortfall 未列出</div>` : "";
    parts.push(`<div style="margin-top:8px"><strong>缺最多的日子:</strong><ul style="margin:6px 0 0;padding-left:20px;line-height:1.7;font-size:13px">${dayLines}</ul>${remainder}</div>`);
  }

  // 3. 為什麼系統沒給權重建議
  parts.push(
    `<div style="margin-top:8px;padding:10px 12px;background:#fffbf0;border-left:3px solid var(--warn);border-radius:4px;font-size:13px;line-height:1.7">` +
    `<strong>🚫 為什麼系統沒給權重調整建議?</strong><br>` +
    `權重調整是零和搬運 — 從 A 產品借權重給 B,A 必須有「高於下限的剩餘」可以借出,且借出後 A 在該廣告剩下的整段期間都不能掉到下限以下。` +
    `當前所有偵測到的產品 ${shortfalls.length > 0 ? "都已經低於下限" : "預算還有空間但日花費卡上限"},沒有任何產品有剩餘可以做零和搬運。` +
    `</div>`
  );

  // 4. 實務上能做的(三選項)
  parts.push(
    `<div style="margin-top:10px"><strong>實務上能做的:</strong>` +
    `<ul style="margin:6px 0 0;padding-left:20px;line-height:1.8;font-size:13px">` +
    `<li>採買新廣告補上 — 採買建議會自動算每個產品這天能加多少</li>` +
    `<li>找願意做短期(一個月以內)的廣告主直接採買 — 這種廣告不是常態,要碰運氣</li>` +
    `<li>接受這幾天少花 — 如果是空檔期(舊廣告剛結束、新廣告還沒上),這就是市場限制造成的少花,月度有容差(小島 2 萬、APP 6 萬)可以承受</li>` +
    `</ul></div>`
  );

  return parts.join("<br>");
}
