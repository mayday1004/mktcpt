import { getState, update, uid } from "../state.js";
import { suggestWeights } from "../domain/suggest.js";
import { evalFormula } from "../lib/formula.js";
import { getExpenseRate, getUsdtToCnyRate } from "../schema.js";
import { expiringAds } from "../domain/alerts.js";
import { renderGiftDayInfo } from "./dashboard.js";
import { todayTaipei, nowTaipeiStamp, addDays } from "../lib/dates.js";
import { buildWeightAdjust, buildWeightAdjustWithAutoSplit } from "../domain/lifecycle.js";
import { rebalanceSplitPair } from "../domain/split-pair.js";
import { detectFamilyCollision, splitWeightsByFamily, deriveSplitCodes, normalizeWeightsToTotal } from "../domain/auto-split.js";
import { displayWeightsForAd } from "../domain/spending.js";
import { normalizeForSearch, adMatchesQuery } from "../lib/search.js";
import { captureUndoSnapshot } from "../domain/undo.js";
import { buildYourlsActionPayload } from "../domain/yourls-actions.js";

const SHORT_URL_BAG_TYPE = "提包";
const SHORT_URL_SLOT_OPTIONS = [
  { value: "L1", label: "L1(權重)" },
  { value: "L3", label: "L3(APK)" },
  { value: "L5", label: "L5(小島)" },
];

function parseShortUrlType(value) {
  const parts = String(value || "").split("+").map((p) => p.trim()).filter(Boolean);
  const slot = SHORT_URL_SLOT_OPTIONS.find((opt) => parts.includes(opt.value))?.value || "";
  const hasBag = parts.includes(SHORT_URL_BAG_TYPE) || value === SHORT_URL_BAG_TYPE;
  return { slot, hasBag };
}

function buildShortUrlType(slot, hasBag) {
  return hasBag ? `${slot}+${SHORT_URL_BAG_TYPE}` : slot;
}

// 模組級展開狀態（記住使用者點開的 ad_code，重渲染後不重置）
const expanded = new Set();
const expandedWeights = new Set();
const expandedTimelineNodes = new Set();
let expiringThisWeekOpen = false;
// 模組級分頁（"all" 或 product.id）
let activeTab = "all";
// 模組級日期區間過濾（皆 inclusive 視覺意義，內部用 overlaps 比對）
// 預設 = 昨天 ~ 當月月底:保留昨天正在看的工作點,同時把本月後續已建立的權重調整段一起納入
function _defaultYesterdayRange() {
  const today = todayTaipei();              // "YYYY-MM-DD"
  const yesterday = addDays(today, -1);
  const [y, m] = today.split("-").map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: yesterday, end: addDays(nextMonth, -1) };
}
const _initialRange = _defaultYesterdayRange();
let filterStart = _initialRange.start;  // YYYY-MM-DD
let filterEnd = _initialRange.end;      // YYYY-MM-DD (inclusive)
// 模組級搜尋字串（廣告代碼或名稱，繁簡/大小寫不分）
let searchQuery = "";

// 計算「當月前 2 個月 1 日」當作停損 cutoff（例：2026-05 → 2026-03-01）
function monthCutoffDate(ym) {
  const [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return "0000-01-01";
  let cy = y, cm = m - 2;
  while (cm <= 0) { cy -= 1; cm += 12; }
  return `${cy}-${String(cm).padStart(2, "0")}-01`;
}

function adOverlapsRange(ad, start, end) {
  // 沒填範圍 → 視為不限
  if (!start && !end) return true;
  // ad 的區間是 [ad.start_date, ad.end_date)
  if (start && ad.end_date <= start) return false;
  if (end && ad.start_date > end) return false;
  return true;
}

function segOverlapsCurrentFilter(seg) {
  return (!filterStart && !filterEnd) ||
    (seg?.start_date && seg?.end_date &&
      (!filterEnd || seg.start_date <= filterEnd) &&
      (!filterStart || seg.end_date > filterStart));
}

function latestSegForCurrentFilter(segs) {
  const allValid = (segs || []).filter((s) => s.start_date && s.end_date);
  if (allValid.length === 0) return null;
  const inRange = allValid.filter(segOverlapsCurrentFilter);
  const pool = inRange.length > 0 ? inRange : allValid;
  return latestFirst(pool)[0] || null;
}

function lifecycleDepth(seg, byId) {
  let depth = 0;
  let cur = seg;
  const seen = new Set();
  while (cur?.renewal_of && !seen.has(cur.renewal_of)) {
    seen.add(cur.renewal_of);
    const parent = byId.get(cur.renewal_of);
    if (!parent) break;
    depth += 1;
    cur = parent;
  }
  return depth;
}

function latestFirst(segs) {
  const list = (segs || []).filter(Boolean);
  const byId = new Map(list.map((seg) => [seg.id, seg]));
  return list.slice().sort((a, b) =>
    (b.start_date || "").localeCompare(a.start_date || "") ||
    (b.end_date || "").localeCompare(a.end_date || "") ||
    lifecycleDepth(b, byId) - lifecycleDepth(a, byId)
  );
}

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;

  // 採買建議跳轉的 prefill — 一次性消費後開啟編輯彈窗
  const prefillRaw = sessionStorage.getItem("buyads_prefill_ad");
  if (prefillRaw) {
    sessionStorage.removeItem("buyads_prefill_ad");
    try {
      const prefill = JSON.parse(prefillRaw);
      // 立即開編輯器（DOM 由下方 innerHTML 後再回填）
      setTimeout(() => openEditor(null, null, prefill), 0);
    } catch {}
  }

  // 確認 activeTab 還合法（產品被刪 / 切換 sample）
  const validTabs = new Set(["all", ...s.products.map((p) => p.id)]);
  if (!validTabs.has(activeTab)) activeTab = "all";

  // 停損：保留「起始日 >= 當月前 2 個月 1 日」或「仍跨過該日」的段。
  // 例：當月 2026-06 → cutoff=2026-04-01；3/8~6/8 這種季繳續費仍要顯示。
  const cutoffDate = monthCutoffDate(ym);
  const recentAds = s.ads.filter((a) =>
    (a.start_date || "") >= cutoffDate || (a.end_date || "") > cutoffDate
  );
  const hiddenOldCount = s.ads.length - recentAds.length;

  // 先依日期過濾（任一段重疊即保留整個 ad_code）
  const codesAlive = new Set();
  for (const a of recentAds) {
    if (adOverlapsRange(a, filterStart, filterEnd)) codesAlive.add(a.ad_code);
  }
  const dateFiltered = (filterStart || filterEnd)
    ? recentAds.filter((a) => codesAlive.has(a.ad_code))
    : recentAds;

  // 搜尋過濾（任一段命中即保留整個 ad_code）
  const normQuery = normalizeForSearch(searchQuery);
  const matchedCodes = new Set();
  if (normQuery) {
    for (const a of dateFiltered) {
      if (adMatchesQuery(a, normQuery)) matchedCodes.add(a.ad_code);
    }
  }
  const searchFiltered = normQuery
    ? dateFiltered.filter((a) => matchedCodes.has(a.ad_code))
    : dateFiltered;

  // Tab filter 邏輯:
  //   1. 對每個 ad_code,先過濾出 filter 範圍內的段(沒命中則 fallback 全段)
  //   2. 在這個池裡挑「start_date 最新的一段」當「當前最新段」
  //   3. 把所有跟「當前最新段」日期 overlap 的段都拿出來(包含兄弟段:同代碼但獨立採買不同產品的 ad)
  //   4. 這群裡有任一段對 tab 產品權重 > 0 → 保留 ad_code 的所有段
  //
  // 為什麼要看「兄弟們」而不只看單一最新段:
  //   - 兄弟廣告(例 st100 一份 AV9 100%、一份 HYC 100%、一份 ZFB 100%,同日期)
  //     是 3 支獨立採買,各自存在於不同產品分頁中。
  //     只看單一段會誤判(挑到 HYC 那份 → 愛威奶分頁就少了 st100)。
  //   - 但純時間軸 t-variant(st287t 早期 av9 → 後期 jk)的不同段彼此不 overlap,
  //     檢查 overlap 就只會挑到真正的「當前段」,所以已轉 jk 的 t-variant 不會誤入愛威奶分頁。
  const inFilterForTab = (s) =>
    (!filterStart && !filterEnd) ||
    (s.start_date && s.end_date &&
      (!filterEnd || s.start_date <= filterEnd) &&
      (!filterStart || s.end_date > filterStart));
  const tabAliveCodes = (() => {
    if (activeTab === "all") return null;
    const codeSegs = new Map();
    for (const a of searchFiltered) {
      if (!codeSegs.has(a.ad_code)) codeSegs.set(a.ad_code, []);
      codeSegs.get(a.ad_code).push(a);
    }
    const alive = new Set();
    for (const [code, segs] of codeSegs) {
      const inRange = segs.filter(inFilterForTab);
      const pool = inRange.length > 0 ? inRange : segs;
      const latest = latestFirst(pool)[0];
      if (!latest) continue;
      const overlapping = pool.filter((s) =>
        s.start_date < latest.end_date && s.end_date > latest.start_date
      );
      if (overlapping.some((s) => Number(s.weights?.[activeTab]) > 0)) alive.add(code);
    }
    return alive;
  })();
  const filtered = tabAliveCodes
    ? searchFiltered.filter((a) => tabAliveCodes.has(a.ad_code))
    : searchFiltered;
  const groups = groupByCode(filtered);

  // 各 tab badge 數字,跟主 filter 邏輯一致(filter-aware latest + 兄弟 overlap)
  const counts = { all: groupByCode(searchFiltered).length };
  {
    const codeSegs = new Map();
    for (const a of searchFiltered) {
      if (!codeSegs.has(a.ad_code)) codeSegs.set(a.ad_code, []);
      codeSegs.get(a.ad_code).push(a);
    }
    // 對每個 code 預算「跟 filter-aware latest 段 overlap 的兄弟群」
    const overlappingByCode = new Map();
    for (const [code, segs] of codeSegs) {
      const inRange = segs.filter(inFilterForTab);
      const pool = inRange.length > 0 ? inRange : segs;
      const latest = latestFirst(pool)[0];
      if (!latest) continue;
      overlappingByCode.set(code, pool.filter((s) =>
        s.start_date < latest.end_date && s.end_date > latest.start_date
      ));
    }
    for (const p of s.products) {
      let n = 0;
      for (const [, overlapping] of overlappingByCode) {
        if (overlapping.some((s) => Number(s.weights?.[p.id]) > 0)) n++;
      }
      counts[p.id] = n;
    }
  }

  const expiring = expiringAds(s, 13, { includeHandledWithinDays: 6 });  // 14 天視窗；本週保留已處理項目

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>廣告列表</h1>
        <div class="desc">${activeTab === "all"
          ? "同代碼多段預設摺疊，點 ▸ 展開檢視時間軸。"
          : `顯示 ${esc(s.products.find((p) => p.id === activeTab)?.name || activeTab)} 有權重的廣告。`}</div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add">＋ 新增廣告</button>
      </div>
    </div>

    ${renderExpiringCard(expiring, s.products, s.ads)}

    ${renderGiftDayInfo(s, { withFixButton: false })}

    ${renderChurnCard(s, activeTab, filterStart, filterEnd)}

    <div class="tabs">
      <button class="tab ${activeTab === "all" ? "active" : ""}" data-tab="all">
        全部 <span class="tab-count">${counts.all}</span>
      </button>
      ${s.products.map((p) => `
        <button class="tab ${activeTab === p.id ? "active" : ""}" data-tab="${esc(p.id)}">
          ${esc(p.name)} <span class="tab-count">${counts[p.id]}</span>
        </button>
      `).join("")}
    </div>

    <div class="ad-filter">
      <span class="ink-3" style="font-size:12px">日期區間（任一段重疊即顯示）：</span>
      <input id="filt-start" type="date" value="${filterStart}" />
      <span class="ink-3">~</span>
      <input id="filt-end" type="date" value="${filterEnd}" />
      <button id="filt-apply">套用</button>
      <button id="filt-this-month" data-month="${ym}">於當月 (${ym})</button>
      <button id="filt-clear">清除</button>
      ${(filterStart || filterEnd) ? `<span class="ink-3" style="font-size:12px;margin-left:auto">已過濾：${filterStart || "—"} ~ ${filterEnd || "—"}</span>` : ""}
    </div>
    ${hiddenOldCount > 0 ? `<div class="ink-3" style="font-size:11px;margin:-4px 0 8px 4px">僅隱藏 ${cutoffDate} 前已結束的歷史段（隱藏 ${hiddenOldCount} 段；跨過 cutoff 的長週期廣告仍會顯示）</div>` : ""}

    <div class="ad-filter">
      <span class="ink-3" style="font-size:12px">搜尋：</span>
      <input id="filt-search" type="search" placeholder="輸入廣告代碼或名稱（不分繁簡 / 大小寫）" value="${esc(searchQuery)}" style="flex:1;min-width:260px" />
      ${searchQuery ? `<button id="filt-search-clear" title="清除搜尋">✕</button>` : ""}
      ${searchQuery ? `<span class="ink-3" style="font-size:12px;margin-left:auto">已搜尋「${esc(searchQuery)}」</span>` : ""}
    </div>

    <div class="card">
      <div class="table-wrap">
        <table class="ads-table">
          <thead>
            <tr>
              <th style="width:32px"></th>
              <th>代碼</th>
              <th>名稱</th>
              <th>分組</th>
              <th class="num">RMB</th>
              <th>起訖</th>
              <th class="num">每日</th>
              <th>權重</th>
              <th style="width:140px"></th>
            </tr>
          </thead>
          <tbody>
            ${groups.length ? groupByFamily(groups).map((fam) => renderFamily(fam, s.products)).join("") :
              `<tr><td colspan="9"><div class="empty">尚無廣告。點右上「＋ 新增廣告」開始</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bindHandlers(root, s);
}

// 廣告 churn 統計卡:在當前 (產品分類 + 日期區間) 範圍下,算新增/淘汰廣告數量、花費比例
//
// 定義:
//   新增廣告:ad_code 的最早 start_date 落在 [filterStart, filterEnd]
//   淘汰廣告:ad_code 的最晚 end_date 落在 [filterStart, filterEnd] 且已停運
//             (latest end_date <= today,涵蓋使用者明確 eliminate + 自然到期沒續費)
//   產品過濾:activeTab !== "all" 時,只算對該產品有 weight > 0 的 ad_code,
//             花費也只算該產品的 weight share
//   花費:Σ(daily_amort_twd × overlap_days × weight_share),overlap_days 用 filter
//        範圍跟段區間取交集(段本身 end-exclusive,filter end 也視為 exclusive)
//   淘汰比例 = 淘汰花費 / 總花費
function computeChurnStats(allAds, productFilter, filterStart, filterEnd, today) {
  const byCode = new Map();
  for (const a of allAds) {
    if (!a.ad_code) continue;
    if (!byCode.has(a.ad_code)) byCode.set(a.ad_code, []);
    byCode.get(a.ad_code).push(a);
  }

  const inRange = (date) => {
    if (!date) return false;
    if (filterStart && date < filterStart) return false;
    if (filterEnd && date > filterEnd) return false;
    return true;
  };

  const overlapDays = (segStart, segEnd) => {
    let s = segStart;
    let e = segEnd;
    const endExclusive = filterEnd ? addDays(filterEnd, 1) : "";
    if (filterStart && s < filterStart) s = filterStart;
    if (endExclusive && e > endExclusive) e = endExclusive;
    if (!s || !e || s >= e) return 0;
    return (Date.parse(e) - Date.parse(s)) / 86400000;
  };

  let newCount = 0;
  let elimCount = 0;
  let totalSpend = 0;
  let elimSpend = 0;
  const elimCodes = [];
  const newCodes = [];
  const details = [];  // 每個 code 的明細,給 UI 展開用

  for (const [code, segs] of byCode) {
    if (productFilter !== "all") {
      const has = segs.some((sg) => Number(sg.weights?.[productFilter]) > 0);
      if (!has) continue;
    }

    const earliestStart = segs.reduce(
      (m, sg) => (sg.start_date && (!m || sg.start_date < m) ? sg.start_date : m),
      ""
    );
    const latestEnd = segs.reduce(
      (m, sg) => ((sg.end_date || "") > m ? (sg.end_date || "") : m),
      ""
    );

    // 「已淘汰」=「使用者按淘汰按鈕」(eliminated=true) OR「自然到期沒續費」(latestEnd <= today)
    // 不再要求停運日落在篩選區間內 — 只要這支廣告現在算淘汰,且區間內有花到錢,就計入淘汰金額
    const anyEliminated = segs.some((sg) => !!sg.eliminated);
    const naturallyExpired = latestEnd && latestEnd <= today;
    const isEliminated = anyEliminated || naturallyExpired;

    const isNew = earliestStart && inRange(earliestStart);
    // effectiveStopDate 給明細顯示用:eliminated=true 但 end_date 還沒到 → 顯示 today
    const effectiveStopDate = (anyEliminated && latestEnd > today) ? today : latestEnd;

    if (isNew) {
      newCount++;
      newCodes.push(code);
    }

    let spendForCode = 0;
    let totalOverlapDays = 0;
    let sampleDaily = 0;
    let sampleWeight = 0;
    for (const seg of segs) {
      if (!seg.start_date || !seg.end_date) continue;
      // 已淘汰廣告:未來那段不會真的花到錢,把 effective end 卡在 today
      const effectiveSegEnd = (anyEliminated && seg.end_date > today) ? today : seg.end_date;
      const days = overlapDays(seg.start_date, effectiveSegEnd);
      if (days <= 0) continue;
      const daily = Number(seg.daily_amort_twd) || 0;
      const w = productFilter === "all" ? 100 : (Number(seg.weights?.[productFilter]) || 0);
      const contrib = daily * days * (w / 100);
      spendForCode += contrib;
      totalOverlapDays += days;
      if (daily > sampleDaily) { sampleDaily = daily; sampleWeight = w; }
    }
    totalSpend += spendForCode;

    // 淘汰金額 = 所有已淘汰廣告(任何時候被淘汰)在篩選區間內的花費加總
    const isElim = isEliminated && spendForCode > 0;
    if (isElim) {
      elimSpend += spendForCode;
      elimCount++;
      elimCodes.push(code);
    }

    // 沒被算淘汰時記錄原因(明細展開用)
    let notElimReason = "";
    if (!isEliminated) {
      if (!latestEnd) notElimReason = "無結束日";
      else notElimReason = `仍在跑(最晚結束日 ${latestEnd} > 今日 ${today},且未按淘汰)`;
    } else if (spendForCode <= 0) {
      notElimReason = "已淘汰但區間內無花費";
    }

    // 該 code 任一段的 ad_name(取最新段)
    const sortedSegs = segs.slice().sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""));
    const adName = sortedSegs[0]?.ad_name || "";

    details.push({
      code,
      adName,
      earliestStart,
      latestEnd,
      hasEnded: naturallyExpired,
      anyEliminated,
      effectiveStopDate,
      isNew,
      isElim,
      notElimReason,
      segCount: segs.length,
      totalOverlapDays,
      sampleDaily,
      sampleWeight,
      contribution: spendForCode,
    });
  }

  // 依貢獻排序方便檢視
  details.sort((a, b) => b.contribution - a.contribution);

  return {
    newCount,
    elimCount,
    totalSpend,
    elimSpend,
    elimRatio: totalSpend > 0 ? elimSpend / totalSpend : 0,
    newCodes,
    elimCodes,
    details,
  };
}

function renderChurnCard(state, productFilter, filterStart, filterEnd) {
  const today = todayTaipei();
  const stats = computeChurnStats(state.ads || [], productFilter, filterStart, filterEnd, today);
  const product = state.products?.find((p) => p.id === productFilter);
  const scopeLabel = productFilter === "all" ? "全部產品" : (product?.name || productFilter);
  const rangeLabel = (filterStart || filterEnd)
    ? `${filterStart || "—"} ~ ${filterEnd || "—"}`
    : "不限日期";
  const fmtNum = (n) => Math.round(n).toLocaleString();
  const fmtPct = (n) => `${(n * 100).toFixed(1)}%`;
  const ratioColor = stats.elimRatio >= 0.5 ? "var(--bad)"
                   : stats.elimRatio >= 0.3 ? "var(--warn)"
                   : "var(--ink)";
  const newTitle = stats.newCodes.length > 0 ? `新增的 ad_code:${stats.newCodes.slice(0, 30).join("、")}${stats.newCodes.length > 30 ? "…" : ""}` : "";
  const elimTitle = stats.elimCodes.length > 0 ? `淘汰的 ad_code:${stats.elimCodes.slice(0, 30).join("、")}${stats.elimCodes.length > 30 ? "…" : ""}` : "";

  const elimDetailRows = stats.details
    .filter((d) => d.isElim)
    .map((d) => {
      const reason = d.anyEliminated && d.latestEnd > today
        ? `已按淘汰(原結束日 ${d.latestEnd})`
        : `自然到期 ${d.latestEnd}`;
      return `<tr>
        <td class="mono">${esc(d.code)}</td>
        <td>${esc(d.adName)}</td>
        <td class="ink-3 mono" style="font-size:11px">${esc(reason)}</td>
        <td class="num mono">${d.totalOverlapDays.toFixed(0)}</td>
        <td class="num mono">${fmtNum(d.sampleDaily)}</td>
        <td class="num mono">${d.sampleWeight}%</td>
        <td class="num"><strong>${fmtNum(d.contribution)}</strong></td>
      </tr>`;
    }).join("");
  const notElimRows = stats.details
    .filter((d) => !d.isElim && d.contribution > 0)
    .slice(0, 30)
    .map((d) => `<tr>
      <td class="mono">${esc(d.code)}</td>
      <td>${esc(d.adName)}</td>
      <td class="ink-3" style="font-size:11px">${esc(d.notElimReason || "—")}</td>
      <td class="num mono">${d.totalOverlapDays.toFixed(0)}</td>
      <td class="num mono">${fmtNum(d.sampleDaily)}</td>
      <td class="num mono">${d.sampleWeight}%</td>
      <td class="num ink-3">${fmtNum(d.contribution)}</td>
    </tr>`).join("");

  return `
    <div class="card churn-card" style="margin-bottom:12px">
      <div class="card-head">
        <h2>📊 廣告狀態 <span class="ink-3" style="font-size:12px;font-weight:400">${esc(scopeLabel)} · ${esc(rangeLabel)}</span></h2>
        <div class="ink-3" style="font-size:11px">隨下方產品分類 / 日期區間連動</div>
      </div>
      <div class="churn-grid">
        <div class="churn-stat" title="${esc(newTitle)}">
          <div class="ink-3" style="font-size:12px">➕ 新增廣告</div>
          <div class="churn-stat-val">${stats.newCount}</div>
          <div class="ink-3" style="font-size:11px">最早起始日落在區間內</div>
        </div>
        <div class="churn-stat" title="${esc(elimTitle)}">
          <div class="ink-3" style="font-size:12px">⛔ 淘汰廣告</div>
          <div class="churn-stat-val">${stats.elimCount}</div>
          <div class="ink-3" style="font-size:11px">已淘汰且區間內有花費</div>
        </div>
        <div class="churn-stat">
          <div class="ink-3" style="font-size:12px">淘汰花費 / 總花費 (TWD)</div>
          <div class="churn-stat-val" style="font-size:18px">${fmtNum(stats.elimSpend)} / ${fmtNum(stats.totalSpend)}</div>
          <div class="ink-3" style="font-size:11px">區間內每日攤提加總</div>
        </div>
        <div class="churn-stat">
          <div class="ink-3" style="font-size:12px">淘汰比例</div>
          <div class="churn-stat-val" style="color:${ratioColor}">${fmtPct(stats.elimRatio)}</div>
          <div class="ink-3" style="font-size:11px">淘汰花費 ÷ 總花費</div>
        </div>
      </div>
      <details class="churn-details" style="margin-top:14px">
        <summary class="ink-2" style="cursor:pointer;font-size:12px;font-weight:600">📋 明細(共 ${stats.elimCount} 支淘汰 · 點開驗證每筆)</summary>
        <div class="table-wrap" style="margin-top:8px;max-height:380px;overflow:auto">
          <table style="font-size:12px">
            <thead>
              <tr>
                <th>代碼</th>
                <th>名稱</th>
                <th>淘汰原因</th>
                <th class="num">區間天數</th>
                <th class="num">每日攤提(台幣)</th>
                <th class="num">${productFilter === "all" ? "權重" : "本產品權重"}</th>
                <th class="num">區間貢獻(台幣)</th>
              </tr>
            </thead>
            <tbody>
              ${elimDetailRows || `<tr><td colspan="7" class="ink-3" style="text-align:center;padding:14px">區間內沒有已淘汰廣告</td></tr>`}
              ${notElimRows ? `
                <tr><td colspan="7" style="background:#fafbfc;padding:6px 12px;color:var(--ink-3);font-size:11px"><strong>未列入淘汰(仍在跑或無花費):</strong>顯示前 30 筆貢獻最高的</td></tr>
                ${notElimRows}
              ` : ""}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  `;
}

// 即將到期清單：待處理顯示操作；本週內已續費/已淘汰仍保留成狀態列
// 計算「家族總額」(供 expiring card 顯示):
//   - 共購家族(含破圈成員)→ carve-out:取每個 code 的 latest seg 加總(= 一般 + 破圈 = 合約總額)
//   - 兄弟廣告(無破圈)→ sum 所有 ads,skip「接收前段」(renewal_of + 權重調整)
// 與 renderFamily 內的合計算法一致,確保家族卡頭 vs expiring 顯示同一個數字。
function computeFamilyTotal(allAds, familyBase, filterRange) {
  // filterRange = { start, end }(可選)— 若給,優先選 parent 在此期間內 active 的最後段
  const familyAds = allAds.filter((a) => familyBaseOf(a.ad_code) === familyBase);
  if (familyAds.length === 0) return 0;
  const hasPoquan = familyAds.some((a) => familyRoleOf(a.ad_code) === "破圈");
  if (hasPoquan) {
    // 規則:
    //   - parent 最後段(若有 filterRange,先選跟它 overlap 的最後段,否則 fallback 取全段最新)
    //   - 其他 code 只有最後段跟 parent 最後段 overlap 時才算進總額
    //   - 不 overlap = 已停運/已回流到 parent,parent 最後段金額已涵蓋整個合約
    const inFilter = (a) =>
      !filterRange ||
      (a.start_date && a.end_date && a.start_date < filterRange.end && a.end_date > filterRange.start);
    const parentAdsAll = familyAds.filter((a) =>
      familyRoleOf(a.ad_code) === "一般" && a.start_date && a.end_date
    );
    if (parentAdsAll.length === 0) return 0;
    const parentInFilter = parentAdsAll.filter(inFilter);
    const parentPool = parentInFilter.length > 0 ? parentInFilter : parentAdsAll;
    const parentLast = parentPool.slice().sort((a, b) =>
      (b.end_date || "").localeCompare(a.end_date || ""))[0];
    let total = Number(parentLast.amount_cny) || 0;
    const byCode = new Map();
    for (const a of familyAds) {
      if (a.ad_code === parentLast.ad_code) continue;
      if (!a.start_date || !a.end_date) continue;
      const overlap = a.start_date < parentLast.end_date && a.end_date > parentLast.start_date;
      if (!overlap) continue;
      const cur = byCode.get(a.ad_code);
      if (!cur || (a.end_date || "") > (cur.end_date || "")) byCode.set(a.ad_code, a);
    }
    for (const a of byCode.values()) total += Number(a.amount_cny) || 0;
    return total;
  }
  let total = 0;
  for (const a of familyAds) {
    if (a.renewal_of && a.renewal_reason === "權重調整") continue;
    total += Number(a.amount_cny) || 0;
  }
  return total;
}

// 待處理項目有兩個動作：續費（開新段）/ 淘汰（標 eliminated 跳過後續通知）
function renderExpiringCard(expiring, products, allAds) {
  if (!expiring || expiring.length === 0) return "";
  const nameOf = Object.fromEntries((products || []).map((p) => [p.id, p.name]));

  // 依「廣告名稱」分組（同名 = 同一支廣告）
  const byName = new Map();
  for (const { ad, daysLeft, poorPerf, status = "pending" } of expiring) {
    const key = ad.ad_name || ad.ad_code;
    if (!byName.has(key)) {
      byName.set(key, {
        adName: ad.ad_name,
        latestAd: ad,
        actionAd: status === "pending" ? ad : null,
        codes: new Set(),
        productIds: new Set(),
        earliestEnd: ad.end_date,
        earliestDays: daysLeft,
        amountCny: 0,
        amountOrig: 0,
        currency: ad.currency || "CNY",
        segments: 0,
        poorPerf: null,
        pendingCount: 0,
        renewedCount: 0,
        eliminatedCount: 0,
        status: "pending",
      });
    }
    const g = byName.get(key);
    g.codes.add(ad.ad_code);
    Object.entries(ad.weights || {}).forEach(([pid, w]) => { if (Number(w) > 0) g.productIds.add(pid); });
    if (ad.end_date < g.earliestEnd) {
      g.earliestEnd = ad.end_date;
      g.earliestDays = daysLeft;
      g.latestAd = ad;
      g.currency = ad.currency || "CNY";
    }
    g.amountCny += Number(ad.amount_cny) || 0;
    g.amountOrig += Number(ad.amount_orig) || Number(ad.amount_cny) || 0;
    g.segments += 1;
    if (poorPerf) g.poorPerf = poorPerf;
    if (status === "eliminated") g.eliminatedCount += 1;
    else if (status === "renewed") g.renewedCount += 1;
    else {
      g.pendingCount += 1;
      if (!g.actionAd || ad.end_date < g.actionAd.end_date) g.actionAd = ad;
    }
  }

  // 按剩餘天數排序(近到遠);成效全爛只當 badge 顯示,不影響順序。
  const grouped = [...byName.values()].sort((a, b) => a.earliestDays - b.earliestDays);
  for (const g of grouped) {
    if (g.pendingCount > 0) g.status = "pending";
    else if (g.eliminatedCount > 0 && g.renewedCount > 0) g.status = "handled";
    else if (g.eliminatedCount > 0) g.status = "eliminated";
    else if (g.renewedCount > 0) g.status = "renewed";
  }

  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const fmtEnd = (ymd) => {
    if (!ymd) return "";
    const d = new Date(ymd + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };
  const thisWeekCount = grouped.filter((g) => g.earliestDays <= 6).length;
  const nextWeekCount = grouped.length - thisWeekCount;
  const handledCount = grouped.filter((g) => g.status !== "pending").length;

  return `
    <div class="card expiring-card">
      <div class="card-head expiring-head">
        <div class="expiring-title">
          <h2>即將到期 <span class="ink-3" style="font-size:12px;font-weight:400">（14 天內,${grouped.length} 支廣告）</span></h2>
        </div>
        <div class="expiring-summary">
          <span><span class="exp-legend exp-red"></span>本週 ${thisWeekCount}</span>
          <span><span class="exp-legend exp-blue"></span>下週 ${nextWeekCount}</span>
          ${handledCount > 0 ? `<span class="exp-status exp-status-done">已處理 ${handledCount}</span>` : ""}
          <span class="ink-3">🚨 = 所有產品成效 &lt; 30% 建議淘汰</span>
        </div>
      </div>
      <div class="expiring-split">
        <div class="expiring-list expiring-red-list">
          ${(() => {
            const reds = grouped.filter((g) => g.earliestDays <= 6);
            if (reds.length === 0) return `<div class="ink-3" style="font-size:12px;padding:8px">本週(6 天內)無到期</div>`;
            const redHandled = reds.filter((g) => g.status !== "pending").length;
            return `
              <div class="expiring-list-head">
                <span>本週(6 天內) ${reds.length} 支${redHandled ? ` · 已處理 ${redHandled}` : ""}</span>
                <button class="icon-btn expiring-red-toggle" data-expiring-red-toggle title="${expiringThisWeekOpen ? "收合本週到期" : "展開本週到期"}">${expiringThisWeekOpen ? "▾" : "▸"}</button>
              </div>
              ${expiringThisWeekOpen
                ? reds.map((g) => renderExpiringItem(g, nameOf, allAds)).join("")
                : `<div class="expiring-collapsed">本週紅色區塊已收合</div>`}
            `;
          })()}
        </div>
        <div class="expiring-list">
          ${(() => {
            const blues = grouped.filter((g) => g.earliestDays > 6);
            if (blues.length === 0) return `<div class="ink-3" style="font-size:12px;padding:8px">下週(7~13 天)無到期</div>`;
            return blues.map((g) => renderExpiringItem(g, nameOf, allAds)).join("");
          })()}
        </div>
      </div>
    </div>
  `;
}

// 單筆「即將到期」row(red/blue 兩欄共用 — renderExpiringCard 拆紅藍兩欄渲染)
function renderExpiringItem(g, nameOf, allAds) {
  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const fmtEnd = (ymd) => {
    if (!ymd) return "";
    const d = new Date(ymd + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };
  const isUrgent = g.earliestDays <= 6;
  const tone = isUrgent ? "exp-row-red" : "exp-row-blue";
  const productPills = [...g.productIds].map((pid) =>
    `<span class="pill exp-product-pill">${esc(nameOf[pid] || pid)}</span>`).join("");
  const codeStr = [...g.codes].join(" / ");
  const poorBadge = g.poorPerf
    ? `<span class="pill exp-perf-bad" title="${esc(g.poorPerf.map((p) => `${p.productName} ${(p.ratio * 100).toFixed(0)}%`).join("、"))}">🚨 成效全爛</span>`
    : "";
  const isUsdt = g.currency === "USDT";
  const famBase = familyBaseOf(g.latestAd.ad_code);
  const famAds = (allAds || []).filter((a) => familyBaseOf(a.ad_code) === famBase);
  const hasFamily = new Set(famAds.map((a) => a.ad_code)).size > 1;
  const famTotal = hasFamily ? computeFamilyTotal(allAds, famBase) : (isUsdt ? g.amountOrig : g.amountCny);
  const amountStr = isUsdt
    ? `${Math.round(famTotal).toLocaleString()} USDT`
    : `${Math.round(famTotal).toLocaleString()} RMB`;
  const amountTitle = hasFamily ? `家族(${famBase})總額` : "";
  const statusHtml = (() => {
    if (g.status === "renewed") return `<span class="exp-status exp-status-renewed">已續費</span>`;
    if (g.status === "eliminated") return `<span class="exp-status exp-status-eliminated">已淘汰</span>`;
    if (g.status === "handled") return `<span class="exp-status exp-status-done">已處理</span>`;
    return "";
  })();
  const actionAd = g.actionAd || g.latestAd;
  return `
    <div class="expiring-item ${tone} ${g.status !== "pending" ? "exp-row-handled" : ""}">
      <span class="exp-days">${g.earliestDays}天</span>
      <span class="exp-end mono">${fmtEnd(g.earliestEnd)}</span>
      <span class="exp-code mono">${esc(codeStr)}</span>
      <strong class="exp-name">${esc(g.adName || "—")}</strong>
      ${poorBadge}
      <span class="exp-products">${productPills}</span>
      <span class="exp-amount mono"${amountTitle ? ` title="${esc(amountTitle)}"` : ""}>${amountStr}</span>
      <span class="exp-actions">
        ${g.status === "pending" ? `
          <button class="primary" data-exp-renew="${esc(actionAd.id)}">續費</button>
          <button data-exp-eliminate="${esc(actionAd.id)}" title="標記為到期不再投放">淘汰</button>
        ` : statusHtml}
      </span>
    </div>
  `;
}

function groupByCode(ads) {
  const map = new Map();
  for (const a of ads) {
    if (!map.has(a.ad_code)) map.set(a.ad_code, []);
    map.get(a.ad_code).push(a);
  }
  // 段內依 start_date 排序;group 之間依「最早 start」排序穩定
  const out = [];
  for (const [code, segs] of map.entries()) {
    segs.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
    out.push({ code, segs });
  }
  out.sort((a, b) => (a.segs[0].start_date || "").localeCompare(b.segs[0].start_date || ""));
  return out;
}

// 取 ad_code 的「家族 base」:
//   st287 / st287t / st287dh 三個都屬於 base = "st287" 的家族
function familyBaseOf(code) {
  const c = code || "";
  const lower = c.toLowerCase();
  if (lower.endsWith("t")) return c.slice(0, -1);
  if (lower.endsWith("dh")) return c.slice(0, -2);
  return c;
}

// 家族角色:一般 / 破圈 / 第二位 — UI 用來顯示 badge label
function familyRoleOf(code) {
  const lower = (code || "").toLowerCase();
  if (lower.endsWith("t")) return "破圈";
  if (lower.endsWith("dh")) return "第二位";
  return "一般";
}

// 把 groupByCode 出的 groups 再依「家族」聚合
// 回傳 [{ familyBase, members: [{code, segs}], hasMultipleMembers }]
function groupByFamily(groups) {
  const byFamily = new Map();
  for (const g of groups) {
    const fam = familyBaseOf(g.code);
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam).push(g);
  }
  const result = [];
  for (const [fam, members] of byFamily) {
    // 家族內排序:一般(0) → 破圈(1) → 第二位(2)
    const score = (g) => {
      const r = familyRoleOf(g.code);
      return r === "一般" ? 0 : r === "破圈" ? 1 : 2;
    };
    members.sort((a, b) => {
      const sa = score(a), sb = score(b);
      if (sa !== sb) return sa - sb;
      return (a.segs[0].start_date || "").localeCompare(b.segs[0].start_date || "");
    });
    result.push({
      familyBase: fam,
      members,
      hasMultipleMembers: members.length > 1,
    });
  }
  // 家族之間用「家族內最早 start」排序
  result.sort((a, b) => {
    const aStart = a.members[0].segs[0].start_date || "";
    const bStart = b.members[0].segs[0].start_date || "";
    return aStart.localeCompare(bStart);
  });
  return result;
}

// 渲染整個家族(可能 1 或多支廣告)
//  - 多支:上方加家族 header(B)、每張卡頭加 link badge 指向兄弟(C)
//  - 單支:直接渲染那張卡
function renderFamily(fam, products) {
  const { familyBase, members, hasMultipleMembers } = fam;
  if (!hasMultipleMembers) {
    return renderGroup(members[0], products, {});
  }
  // 共購家族(有破圈成員,如 stXXXt):一般 + 破圈 = 合約總額(carve-out),套 familyScale
  // 兄弟廣告(無破圈,只有一般 + 第二位 dh 等):各自獨立採買,不套 scale,各權重維持 100%
  const hasPoquan = members.some((g) => familyRoleOf(g.code) === "破圈");

  let totalContractRmb = 0;
  let poquanRmb = 0;
  let generalRmb = 0;
  if (hasPoquan) {
    // carve-out:以 parent 最後一段(優先在 filter 範圍內)當「當前合約期間」參考。
    // t-variant 只在最後段跟 parent 最後段 overlap 時才加入,否則視為已停運/已回流到 parent。
    const inFilter = (s) =>
      (!filterStart && !filterEnd) ||
      (s.start_date && s.end_date &&
        (!filterEnd || s.start_date <= filterEnd) &&
        (!filterStart || s.end_date > filterStart));
    const pickLatest = (segs) => {
      const allValid = segs.filter((s) => s.start_date && s.end_date);
      if (allValid.length === 0) return null;
      const inRange = allValid.filter(inFilter);
      const pool = inRange.length > 0 ? inRange : allValid;
      return pool.slice().sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""))[0];
    };
    const parentMember = members.find((g) => familyRoleOf(g.code) === "一般");
    const parentLast = parentMember ? pickLatest(parentMember.segs) : null;
    if (parentLast) {
      generalRmb = Number(parentLast.amount_cny) || 0;
      totalContractRmb = generalRmb;
      for (const g of members) {
        if (g === parentMember) continue;
        const myLast = pickLatest(g.segs);
        if (!myLast) continue;
        const overlap = myLast.start_date < parentLast.end_date && myLast.end_date > parentLast.start_date;
        if (!overlap) continue;
        const amt = Number(myLast.amount_cny) || 0;
        totalContractRmb += amt;
        const role = familyRoleOf(g.code);
        if (role === "破圈") poquanRmb += amt;
        else generalRmb += amt;
      }
    } else {
      // 沒 parent member(理論上不會發生),fallback to 原本邏輯
      for (const g of members) {
        const last = latestSegForCurrentFilter(g.segs) || g.segs[g.segs.length - 1];
        const amt = Number(last.amount_cny) || 0;
        totalContractRmb += amt;
        const role = familyRoleOf(g.code);
        if (role === "破圈") poquanRmb += amt;
        else if (role === "一般") generalRmb += amt;
      }
    }
  } else {
    // 兄弟廣告:sum 各「初始」採購,跳過「接收前段」(權重調整轉移)— 那是同位置續費,不算新採購
    for (const g of members) {
      for (const s of g.segs) {
        if (s.renewal_of && s.renewal_reason === "權重調整") continue;
        totalContractRmb += Number(s.amount_cny) || 0;
      }
    }
  }
  const poquanPct = hasPoquan && totalContractRmb > 0 ? Math.round(poquanRmb / totalContractRmb * 100) : 0;
  const generalPct = hasPoquan && totalContractRmb > 0 ? Math.round(generalRmb / totalContractRmb * 100) : 0;
  // 家族名稱 = 一般成員的 ad_name(去掉 t 後綴);沒一般時用第一個 member
  const generalMember = members.find((g) => familyRoleOf(g.code) === "一般") || members[0];
  const generalLatest = latestSegForCurrentFilter(generalMember.segs) || generalMember.segs[generalMember.segs.length - 1];
  const baseName = generalLatest?.ad_name || "";
  const totalLabel = hasPoquan ? "總額" : "合計";

  // 家族列「權重調整」按鈕(§5.7.2):
  // 只當家族裡有 split_pair 配對成員(parent + t-variant 同時存在)才顯示。
  // 兄弟廣告(stXXX + stXXXdh,各自獨立 split_pair_id=null)走 per-ad 按鈕,不需家族視角。
  let familyPairId = "";
  if (hasPoquan) {
    const parentMember = members.find((g) => familyRoleOf(g.code) === "一般");
    const parentLast = parentMember
      ? parentMember.segs.slice().reverse().find((s) => s.split_pair_id) : null;
    if (parentLast) familyPairId = parentLast.split_pair_id;
  }
  const familyWeightBtn = familyPairId
    ? `<button class="family-weight-btn" data-fam-weight-pair="${esc(familyPairId)}" title="整體合約視角編輯權重(parent + t-variant 一次調)">權重調整</button>`
    : "";

  const familyHeader = `
    <tr class="family-head-row">
      <td colspan="9">
        <div class="family-head">
          <strong class="family-base-name">${esc(familyBase)}</strong>
          ${baseName ? `<span class="family-ad-name">${esc(baseName)}</span>` : ""}
          <span class="family-meta">${totalLabel} ${Math.round(totalContractRmb).toLocaleString()} RMB</span>
          ${hasPoquan ? `<span class="family-meta family-poquan-pct" title="破圈金額 ${Math.round(poquanRmb).toLocaleString()} RMB / 一般 ${Math.round(generalRmb).toLocaleString()} RMB(時間加權)">一般 ${generalPct}% · 破圈 ${poquanPct}%</span>` : ""}
          <span class="family-roles">
            ${members.map((g) => `<span class="family-role-pill family-role-${familyRoleOf(g.code) === "一般" ? "normal" : familyRoleOf(g.code) === "破圈" ? "poquan" : "secondary"}">${esc(g.code)} <span class="family-role-tag">${familyRoleOf(g.code)}</span></span>`).join("")}
          </span>
          ${familyWeightBtn ? `<span class="family-actions">${familyWeightBtn}</span>` : ""}
        </div>
      </td>
    </tr>
  `;
  // 共購家族才套 familyScale;兄弟廣告各權重維持 100%
  const memberRows = members.map((m, idx) => {
    const isLast = idx === members.length - 1;
    let familyScale;
    if (hasPoquan) {
      const lastSeg = latestSegForCurrentFilter(m.segs) || m.segs[m.segs.length - 1];
      const lastAmt = Number(lastSeg.amount_cny) || 0;
      familyScale = totalContractRmb > 0 ? lastAmt / totalContractRmb : 1;
    } else {
      familyScale = 1;  // 兄弟廣告不縮放
    }
    return renderGroup(m, products, {
      familyBase,
      familyScale,
      familyPos: isLast ? "family-last" : "family-mid",
    });
  }).join("");
  return familyHeader + memberRows;
}

function renderGroup(group, products, opts = {}) {
  const { code, segs } = group;
  // 「最新段」選擇規則:
  //   - 在某產品 tab → 挑「該產品 weight > 0 的最新段」(兄弟廣告每個產品各自的最新)
  //   - 全部 tab → 整 group 最新段(segs 已按 start_date 升序排,取最後一個)
  // filter 只決定「哪些 group 顯示」,不影響 group 內 latest 的選擇 — 否則 filter 卡過去日期時,
  // 摺疊列會顯示舊段(忽略後續續費),按鈕指錯段。
  let latest;
  if (activeTab && activeTab !== "all") {
    const tabSegs = segs.filter((s) => Number(s.weights?.[activeTab]) > 0);
    if (tabSegs.length > 0) latest = latestSegForCurrentFilter(tabSegs);
  }
  if (!latest) latest = latestSegForCurrentFilter(segs) || segs[segs.length - 1];
  // 不在 family 渲染情境(opts.familyScale 沒給)時,若 ad 是 t-variant,自動算「占整體合約 %」
  // 讓使用者切到「愛威奶破圈」等產品分頁時,看到的權重就是占整體合約的比例,而不是 ad 自身 100%
  if (opts.familyScale == null && latest.split_pair_id && latest.split_role === "t_variant") {
    const allAdsForScale = getState().ads || [];
    const parentOverlap = allAdsForScale
      .filter((a) =>
        a.split_pair_id === latest.split_pair_id && a.split_role === "parent" &&
        a.start_date && a.end_date &&
        a.start_date < latest.end_date && a.end_date > latest.start_date
      )
      .sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""))[0];
    if (parentOverlap) {
      const ownAmt = Number(latest.amount_cny) || 0;
      const parentAmt = Number(parentOverlap.amount_cny) || 0;
      const tot = ownAmt + parentAmt;
      if (tot > 0) opts = { ...opts, familyScale: ownAmt / tot };
    }
  }
  let latestRmb = Number(latest.amount_cny) || 0;
  // 共購家族:如果 latest seg 期間家族其他 code 都不 overlap(例:st287t 已結束,5/10~5/22 只剩 st287),
  // 則此段一般部分等於整個合約金額,顯示家族總額而非 ad 自身 carve-out
  if (opts.familyBase && opts.familyScale && opts.familyScale > 0 && opts.familyScale < 1) {
    const allAds = getState().ads || [];
    const familyOthers = allAds.filter((a) =>
      familyBaseOf(a.ad_code) === opts.familyBase && a.ad_code !== code
    );
    const hasOverlap = familyOthers.some((o) =>
      o.start_date < latest.end_date && o.end_date > latest.start_date
    );
    if (!hasOverlap && familyOthers.length > 0) {
      latestRmb = computeFamilyTotal(allAds, opts.familyBase);
    }
  }
  const isOpen = expanded.has(code);
  const weightsOpen = expandedWeights.has(code);
  const isMulti = segs.length > 1;
  const eliminated = segs.some((s) => s.eliminated);
  const role = familyRoleOf(code);
  // 破圈/第二位 badge,t-variant 多顯示「← parent_code」幫使用者認出是從哪支廣告拆出
  let parentHint = "";
  if (latest.split_pair_id && latest.split_role === "t_variant") {
    const allAdsForParent = getState().ads || [];
    const parentAd = allAdsForParent.find((a) =>
      a.split_pair_id === latest.split_pair_id && a.split_role === "parent"
    );
    if (parentAd?.ad_code) {
      // 算當前段對「父+本身」的金額占比,讓使用者一眼看出占整體幾%
      const parentLatest = allAdsForParent
        .filter((a) => a.split_pair_id === latest.split_pair_id && a.split_role === "parent" &&
          a.start_date && a.end_date && a.start_date < latest.end_date && a.end_date > latest.start_date)
        .sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""))[0];
      const tAmt = Number(latest.amount_cny) || 0;
      const pAmt = Number(parentLatest?.amount_cny) || 0;
      const total = tAmt + pAmt;
      const pct = total > 0 ? Math.round(tAmt / total * 100) : 0;
      const pctText = pct > 0 ? `(整體 ${pct}%)` : "";
      parentHint = `<span class="ink-3" style="margin-left:4px;font-size:11px" title="由 ${esc(parentAd.ad_code)} 拆出破圈分流${pctText}">← ${esc(parentAd.ad_code)} ${pctText}</span>`;
    }
  }
  const roleBadge = role !== "一般"
    ? `<span class="seg-badge family-role-${role === "破圈" ? "poquan" : "secondary"}">${role}</span>${parentHint}`
    : "";
  // 家族成員加 class,用 CSS 畫外框
  const familyMemberClass = opts.familyBase ? `family-member family-${esc(opts.familyBase)}` : "";
  const familyPosClass = opts.familyPos || "";  // family-first / family-mid / family-last

  const headRow = `
    <tr class="group-head ${isOpen ? "open" : ""} ${eliminated ? "ad-eliminated" : ""} ${familyMemberClass} ${familyPosClass}" data-anchor-code="${esc(code)}">
      <td class="toggle"><button class="icon-btn" data-toggle="${esc(code)}">${isOpen ? "▾" : "▸"}</button></td>
      <td class="code-cell mono">${esc(code)}${roleBadge}</td>
      <td>
        <strong>${esc(latest.ad_name)}</strong>
        ${isMulti ? `<span class="seg-badge">${segs.length} 段</span>` : ""}
        ${eliminated ? `<span class="seg-badge" style="background:#fde3e3;color:var(--bad)">已淘汰</span>` : ""}
      </td>
      <td>${esc(latest.group || "—")}</td>
      <td class="num">${Math.round(latestRmb).toLocaleString()}</td>
      <td class="date-compact mono nowrap">${formatCompactDateRange(latest.start_date, latest.end_date)}</td>
      <td class="num">${Math.round(latest.daily_amort_twd || 0).toLocaleString()}</td>
      <td>${weightSummary(latest, products, "bar", { code, open: weightsOpen, allSegs: segs, referenceSeg: latest, familyScale: opts.familyScale })}</td>
      <td class="actions-cell right nowrap">
        ${actionButtons(latest, /*compact=*/true)}
      </td>
    </tr>
  `;

  const weightDetailRow = weightsOpen ? renderWeightDetailRow(latest, products, { allSegs: segs, referenceSeg: latest, familyScale: opts.familyScale }) : "";

  if (!isOpen) return headRow + weightDetailRow;

  const timeline = timelineSegsForReference(segs, latest);
  // 展開時:即使單段也顯示 timeline node(讓備註 / 廣告文案 / 站長 / 短網址資訊有地方看)
  return headRow + weightDetailRow + `
    <tr class="seg-timeline-row">
      <td></td>
      <td colspan="8">
        <div class="seg-timeline">
          ${timeline.items.map(({ seg, index }, pos) => renderTimelineNode(seg, index, segs, products, {
            familyScale: opts.familyScale,
            referenceSeg: latest,
            timelineMode: timeline.mode,
            timelinePos: pos,
            timelineCount: timeline.items.length,
            prevSeg: pos > 0 ? timeline.items[pos - 1].seg : null,
          })).join("")}
        </div>
      </td>
    </tr>
  `;
}

// 展開時的 timeline 顯示「列表列頭那筆最新段」的同一個時間截面。
// 同代碼多個獨立採買段若與最新段 overlap,一併顯示;權重調整切段則只顯示新段。
function latestSnapshotSegs(segs, referenceSeg) {
  const indexed = segs.map((seg, index) => ({ seg, index }));
  const refItem = indexed.find(({ seg }) => seg.id === referenceSeg?.id) || indexed[indexed.length - 1];
  const ref = refItem?.seg;
  if (!ref) return [];

  const snapshot = indexed.filter(({ seg }) =>
    seg.start_date && seg.end_date &&
    ref.start_date && ref.end_date &&
    seg.start_date < ref.end_date &&
    seg.end_date > ref.start_date
  );

  return snapshot.length > 0 ? snapshot : [refItem];
}

function timelineSegsForReference(segs, referenceSeg) {
  const indexed = segs.map((seg, index) => ({ seg, index }));
  const refItem = indexed.find(({ seg }) => seg.id === referenceSeg?.id) || indexed[indexed.length - 1];
  if (!refItem?.seg) return { mode: "snapshot", items: [] };

  const byId = new Map(indexed.map((item) => [item.seg.id, item]));
  const path = [];
  const seen = new Set();
  let curItem = refItem;
  while (curItem?.seg && !seen.has(curItem.seg.id)) {
    seen.add(curItem.seg.id);
    path.push(curItem);
    curItem = curItem.seg.renewal_of ? byId.get(curItem.seg.renewal_of) : null;
  }
  path.reverse();

  const refPos = path.findIndex(({ seg }) => seg.id === refItem.seg.id);
  if (refPos >= 0) {
    let anchorPos = refPos;
    for (let i = refPos; i >= 0; i--) {
      if (path[i].seg.renewal_reason !== "權重調整") {
        anchorPos = i;
        break;
      }
    }
    const contractItems = path.slice(anchorPos, refPos + 1);
    const hasWeightAdjust = contractItems.some(({ seg }) => seg.renewal_reason === "權重調整");
    if (hasWeightAdjust && contractItems.length > 1) {
      return { mode: "weight-chain", items: contractItems };
    }
  }

  return { mode: "snapshot", items: latestSnapshotSegs(segs, referenceSeg) };
}

function lifecycleAncestorIds(referenceSeg, segs) {
  const byId = new Map((segs || []).map((seg) => [seg.id, seg]));
  const ids = new Set();
  let cur = referenceSeg;
  while (cur?.renewal_of && !ids.has(cur.renewal_of)) {
    ids.add(cur.renewal_of);
    cur = byId.get(cur.renewal_of);
  }
  return ids;
}

function renderWeightDetailRow(seg, products, opts = {}) {
  const details = opts.allSegs
    ? weightSnapshotDetails(opts.allSegs, products, { referenceSeg: opts.referenceSeg || seg })
    : { entries: productWeightEntries(seg, products), snapshotSegs: [seg], referenceSeg: seg };
  const rawEntries = details.entries;
  if (rawEntries.length <= 3) return "";
  const scale = opts.familyScale && opts.familyScale > 0 && opts.familyScale < 1 ? opts.familyScale : null;
  const scaled = scale ? scaleWithLargestRemainder(rawEntries, scale) : rawEntries;
  // 「完整權重產品」面板的顯示順序依 state.products 陣列(= Sheets「產品」分頁列順序),
  // 不依權重大小排序;未列在 products 的 pid(不該發生)排到最後。
  const orderMap = new Map((products || []).map((p, i) => [p.id, i]));
  const entries = scaled.slice().sort((a, b) => {
    const ai = orderMap.has(a.pid) ? orderMap.get(a.pid) : 999;
    const bi = orderMap.has(b.pid) ? orderMap.get(b.pid) : 999;
    return ai - bi || String(a.pid).localeCompare(String(b.pid));
  });
  return `
    <tr class="weight-detail-row">
      <td></td>
      <td colspan="8">
        <div class="weight-detail-panel">
          <div class="weight-detail-title">完整權重產品${scale ? `<span class="ink-3" style="font-weight:400;margin-left:8px;font-size:11px">（家族整體占比;hover 看此 ad 內 %）</span>` : ""}</div>
          <div class="weight-detail-grid">
            ${entries.map(({ pid, name, weight, rawWeight }) => {
              const tip = rawWeight !== undefined ? ` title="此 ad 內 ${Math.round(rawWeight)}%"` : "";
              return `
              <div class="weight-detail-item" style="--w-color:${productColor(pid)}"${tip}>
                <span class="weight-dot"></span>
                <span class="weight-detail-name">${esc(name)}</span>
                <strong>${Math.round(weight)}%</strong>
              </div>
            `;
            }).join("")}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderTimelineNode(seg, idx, segs, products, opts = {}) {
  const prev = Object.prototype.hasOwnProperty.call(opts, "prevSeg")
    ? opts.prevSeg
    : (idx > 0 ? segs[idx - 1] : null);
  const delta = prev ? segDelta(prev, seg, products) : "";
  const reasonCls = reasonClass(seg.renewal_reason);
  // 廣告文案 / 站長 / 短網址 等資訊只在最新段(段落鏈的 latest)顯示 — 這些是「廣告層級」資料,
  // 多段都同步,顯示在最新段避免重複
  const isGlobalLatest = idx === segs.length - 1;
  const isReference = opts.referenceSeg?.id ? seg.id === opts.referenceSeg.id : isGlobalLatest;
  const isWeightChain = opts.timelineMode === "weight-chain";
  const pos = Number.isFinite(opts.timelinePos) ? opts.timelinePos : idx;
  const count = Number.isFinite(opts.timelineCount) ? opts.timelineCount : segs.length;
  const canCollapse = isWeightChain && seg.renewal_reason === "權重調整" && !isReference && pos > 0 && count > 2;
  const isCollapsed = canCollapse && !expandedTimelineNodes.has(seg.id);
  const extraInfo = isReference && !isCollapsed ? renderAdExtras(seg) : "";
  const showHistory = !isCollapsed && (isWeightChain ? pos > 0 : isReference);
  const weightHistory = showHistory ? renderWeightHistoryPanel(seg, products, { allSegs: segs, referenceSeg: seg, familyScale: opts.familyScale }) : "";
  const collapsedSummary = isCollapsed
    ? `<span class="tl-collapsed-summary">${weightSummary(seg, products, "inline", { familyScale: opts.familyScale })}</span>`
    : "";
  const actions = isCollapsed
    ? ""
    : (isReference
      ? actionButtons(seg, /*compact=*/false)
      : actionButtons(seg, /*compact=*/false, { lifecycle: false }));
  return `
    <div class="tl-node ${isCollapsed ? "collapsed" : ""}">
      <div class="tl-rail"></div>
      ${canCollapse ? `<button class="tl-collapse-btn" data-timeline-toggle="${esc(seg.id)}" title="${isCollapsed ? "展開此權重調整" : "收合此權重調整"}">${isCollapsed ? "▸" : "▾"}</button>` : ""}
      <div class="tl-dot ${reasonCls.includes("warn") ? "warn" : ""}"></div>
      <div class="tl-content">
        <div class="tl-title">
          <span class="${reasonCls}" style="font-size:11px">${esc(seg.renewal_reason || "—")}</span>
          <span class="mono ink-2" style="font-size:12px;margin-left:8px">#${idx + 1} ${seg.start_date} → ${seg.end_date}</span>
          ${delta ? `<span class="ink-3" style="font-size:11px;margin-left:8px">Δ ${esc(delta)}</span>` : ""}
          ${collapsedSummary}
        </div>
        ${isCollapsed ? "" : `
        <div class="tl-meta">
          <span>${seg.amortize_days} 天 @ ${seg.exchange_rate}</span>
          <span>${seg.currency === "USDT" ? `${Math.round(seg.amount_orig || 0).toLocaleString()} USDT × ${seg.currency_rate} = ${Math.round(seg.amount_cny || 0).toLocaleString()} RMB` : `${Math.round(seg.amount_cny || 0).toLocaleString()} RMB`}</span>
          <span>每日攤提 ${Math.round(seg.daily_amort_twd || 0).toLocaleString()}</span>
          <span>${weightSummary(seg, products, "inline", { familyScale: opts.familyScale })}</span>
        </div>
        ${weightHistory}
        ${(seg.notes && !/^V2 /.test(seg.notes.trim())) ? `<div class="tl-notes ink-2" style="font-size:12px;margin-top:4px;padding:4px 8px;background:#f7f9fc;border-radius:4px">📝 ${esc(seg.notes)}</div>` : ""}
        ${extraInfo}
        ${actions ? `<div class="tl-actions">${actions}</div>` : ""}
        `}
      </div>
    </div>
  `;
}

// 廣告層級的附加資訊(只顯示廣告文案;站長 / 連結 / 縮網址參數移到「🔗 縮網址」頁集中管理)
function renderAdExtras(ad) {
  const items = [];
  if (ad.ad_copy) items.push(`<span><strong>文案:</strong> ${esc(ad.ad_copy)}</span>`);
  if (ad.contact_tg) items.push(`<span><strong>TG:</strong> ${esc(ad.contact_tg)}</span>`);
  if (items.length === 0) return "";
  return `<div class="tl-meta" style="margin-top:4px;font-size:12px;color:var(--ink-2)">${items.join("")}</div>`;
}

function segDelta(prev, cur, products) {
  const parts = [];
  if (prev.exchange_rate !== cur.exchange_rate) parts.push(`匯率 ${prev.exchange_rate}→${cur.exchange_rate}`);
  if (prev.amount_cny !== cur.amount_cny) parts.push(`RMB ${Math.round(prev.amount_cny).toLocaleString()}→${Math.round(cur.amount_cny).toLocaleString()}`);
  if (prev.amortize_days !== cur.amortize_days) parts.push(`攤提 ${prev.amortize_days}→${cur.amortize_days} 天`);
  const wA = JSON.stringify(prev.weights || {});
  const wB = JSON.stringify(cur.weights || {});
  if (wA !== wB) parts.push(`權重變更`);
  return parts.length ? parts.join(" / ") : "（同前段）";
}

function reasonClass(r) {
  if (!r) return "";
  if (r === "初始") return "pill";
  if (r === "送天數" || r === "送天數結束") return "pill warn";
  if (r === "權重調整") return "pill";
  if (r === "轉移") return "pill warn";
  if (r === "匯率調漲" || r === "匯率調降") return "pill warn";
  return "pill";
}

// 產品調色盤(11 色,搭配 productColor 的 stable hash 取色)
const PRODUCT_PALETTE = [
  "#6366f1", "#14b8a6", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#84cc16", "#f43f5e", "#0ea5e9", "#818cf8", "#2dd4bf",
];
const _colorCache = new Map();
function productColor(pid) {
  if (!pid) return "#94a3b8";
  if (_colorCache.has(pid)) return _colorCache.get(pid);
  let h = 0;
  for (let i = 0; i < pid.length; i++) h = ((h << 5) - h + pid.charCodeAt(i)) | 0;
  const c = PRODUCT_PALETTE[Math.abs(h) % PRODUCT_PALETTE.length];
  _colorCache.set(pid, c);
  return c;
}

// 把日期改成緊湊格式:`4/25 → 5/22 (28天)`,跨年才顯示年份
function formatCompactDateRange(start, end) {
  if (!start || !end) return "—";
  const m = (d) => `${parseInt(d.slice(5, 7), 10)}/${parseInt(d.slice(8, 10), 10)}`;
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const head = sameYear ? `${m(start)} → ${m(end)}` : `${start} → ${end}`;
  const days = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86400000));
  return `${head}<span class="date-days"> ${days}天</span>`;
}

// 權重摘要:模式 = "bar"(列表用,group 級彙總每產品最新權重) / "inline"(時間軸用,單段純文字 pill)
function productWeightEntries(seg, products) {
  return Object.entries(seg.weights || {})
    .filter(([, v]) => Number(v) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .map(([pid, w]) => ({
      pid,
      name: products.find((p) => p.id === pid)?.name || pid,
      weight: Number(w) || 0,
    }));
}

// 整個 group 的權重彙總:以列表列頭選到的「最新段」為基準,取同代碼且與它 overlap 的段。
// 解決兩個問題:
//   (a) INDEPENDENT 廣告同代碼多產品各自 100%,但只看 latest 段時其他產品看不到
//   (b) 已被移出的產品(舊段有,新段沒有)不該再出現
//   (c) 未來已建立的新段(例 6/1 權重調整)要立刻顯示,不能被今天 active 的舊段蓋回去
function weightSnapshotDetails(segs, products, opts = {}) {
  const allSegs = segs || [];
  const allProducts = products || [];
  const referenceSeg = opts.referenceSeg || latestFirst(allSegs)[0];
  const byId = new Map(allSegs.map((seg) => [seg.id, seg]));

  const collectFrom = (segList) => {
    const m = new Map();
    for (const seg of segList) {
      for (const [pid, w] of Object.entries(seg.weights || {})) {
        const wn = Number(w) || 0;
        if (wn <= 0) continue;
        const cur = m.get(pid);
        const sd = seg.start_date || "";
        const depth = lifecycleDepth(seg, byId);
        if (!cur || sd > cur.startDate || (sd === cur.startDate && depth >= cur.depth)) {
          m.set(pid, { weight: wn, startDate: sd, depth });
        }
      }
    }
    return m;
  };

  const ancestorIds = lifecycleAncestorIds(referenceSeg, allSegs);
  let snapshotSegs = referenceSeg
    ? allSegs.filter((seg) =>
      seg.start_date && seg.end_date &&
      referenceSeg.start_date && referenceSeg.end_date &&
      seg.start_date < referenceSeg.end_date &&
      seg.end_date > referenceSeg.start_date &&
      (seg.id === referenceSeg.id || !ancestorIds.has(seg.id))
    )
    : [];
  let byPid = collectFrom(snapshotSegs.length > 0 ? snapshotSegs : (referenceSeg ? [referenceSeg] : []));
  // fallback:資料缺日期時,退回「整體 latest seg」避免空白。
  if (byPid.size === 0) {
    const lastSeg = latestFirst(allSegs)[0];
    if (lastSeg) {
      snapshotSegs = [lastSeg];
      byPid = collectFrom(snapshotSegs);
    }
  }

  const entries = [...byPid.entries()]
    .map(([pid, info]) => ({
      pid,
      name: allProducts.find((p) => p.id === pid)?.name || pid,
      weight: info.weight,
    }))
    .sort((a, b) => b.weight - a.weight);
  return { entries, snapshotSegs, referenceSeg };
}

function aggregateGroupWeights(segs, products, opts = {}) {
  return weightSnapshotDetails(segs, products, opts).entries;
}

// 把 entries 的 weight × scale 並用 largest-remainder method round,讓加總精確 = round(rawSum × scale)
function scaleWithLargestRemainder(rawEntries, scale) {
  const rawSum = rawEntries.reduce((s, e) => s + (Number(e.weight) || 0), 0);
  const target = Math.round(rawSum * scale);
  const scaledVals = rawEntries.map((e) => (Number(e.weight) || 0) * scale);
  const floors = scaledVals.map((v) => Math.floor(v));
  let diff = target - floors.reduce((a, b) => a + b, 0);
  const indexed = scaledVals
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  const final = [...floors];
  for (let k = 0; k < diff && k < indexed.length; k++) {
    final[indexed[k].i] += 1;
  }
  return rawEntries.map((e, i) => ({ ...e, weight: final[i], rawWeight: Number(e.weight) || 0 }));
}

function renderWeightPills(entries, opts = {}) {
  const TOP_N = 3;
  const top = entries.slice(0, TOP_N).map(({ pid, name, weight, rawWeight }, i) => {
    const pct = `${Math.round(weight)}%`;
    const tip = rawWeight !== undefined ? ` title="此 ad 內 ${Math.round(rawWeight)}%"` : "";
    return `<span class="weight-top-item ${i === 0 ? "lead" : ""}" style="border-left:3px solid ${productColor(pid)};padding-left:6px"${tip}>${esc(name)} ${pct}</span>`;
  }).join("<span class=\"sep\"> · </span>");
  const moreCount = entries.length - TOP_N;
  const more = moreCount > 0
    ? (opts.moreButton
      ? `<button class="weight-more ${opts.open ? "active" : ""}" data-weight-toggle="${esc(opts.code)}" title="查看完整權重">+${moreCount} 個</button>`
      : `<span class="more">+${moreCount} 個</span>`)
    : "";
  return `<div class="weights-summary">${top}${more}</div>`;
}

function previousWeightSnapshotForReference(segs, products, opts = {}) {
  const allSegs = segs || [];
  const referenceSeg = opts.referenceSeg || latestFirst(allSegs)[0];
  const byId = new Map(allSegs.map((seg) => [seg.id, seg]));
  const valid = allSegs
    .map((seg, index) => ({ seg, index }))
    .filter(({ seg }) => seg.start_date && seg.end_date)
    .sort((a, b) =>
      (a.seg.start_date || "").localeCompare(b.seg.start_date || "") ||
      (a.seg.end_date || "").localeCompare(b.seg.end_date || "") ||
      lifecycleDepth(a.seg, byId) - lifecycleDepth(b.seg, byId)
    );
  let refPos = referenceSeg?.id
    ? valid.findIndex(({ seg }) => seg.id === referenceSeg.id)
    : valid.length - 1;
  if (refPos < 0) refPos = valid.length;
  for (let i = refPos - 1; i >= 0; i--) {
    const { seg: candidate, index } = valid[i];
    const entries = productWeightEntries(candidate, products);
    if (entries.length === 0) continue;
    return { entries, snapshotSegs: [candidate], referenceSeg: candidate, recordNo: index + 1 };
  }
  return null;
}

function formatWeightHistoryDate(ymd) {
  if (!ymd) return "";
  const m = parseInt(ymd.slice(5, 7), 10);
  const d = parseInt(ymd.slice(8, 10), 10);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return "";
  return `${m}/${d}`;
}

function mapRoundedWeights(entries, scale) {
  const visibleEntries = scale ? scaleWithLargestRemainder(entries, scale) : entries;
  const map = new Map();
  for (const entry of visibleEntries) {
    map.set(entry.pid, {
      ...entry,
      weight: Math.round(Number(entry.weight) || 0),
    });
  }
  return { entries: visibleEntries, map };
}

function weightDeltaEntries(currentEntries, previousEntries, scale) {
  const current = mapRoundedWeights(currentEntries, scale);
  const previous = mapRoundedWeights(previousEntries, scale);
  const orderedPids = [
    ...current.entries.map((entry) => entry.pid),
    ...previous.entries.map((entry) => entry.pid).filter((pid) => !current.map.has(pid)),
  ];
  return orderedPids.map((pid) => {
    const cur = current.map.get(pid);
    const prev = previous.map.get(pid);
    const curWeight = cur?.weight || 0;
    const prevWeight = prev?.weight || 0;
    return {
      pid,
      name: cur?.name || prev?.name || pid,
      rawWeight: cur?.rawWeight,
      delta: curWeight - prevWeight,
    };
  }).filter((entry) => entry.delta !== 0);
}

function renderWeightDeltaLine(currentEntries, previous, label, cls, scale) {
  const deltas = weightDeltaEntries(currentEntries, previous.entries, scale);
  const date = formatWeightHistoryDate(previous.referenceSeg?.start_date);
  const reason = previous.referenceSeg?.renewal_reason || "";
  const title = `${label}${previous.referenceSeg?.start_date ? ` ${previous.referenceSeg.start_date}` : ""}${reason ? ` · ${reason}` : ""}`;
  const record = previous.recordNo ? ` #${previous.recordNo}` : "";
  const chips = deltas.length > 0
    ? deltas.map(({ pid, name, delta, rawWeight }) => {
      const trendCls = delta > 0 ? "up" : "down";
      const tip = rawWeight !== undefined ? ` title="此 ad 內 ${Math.round(rawWeight)}%"` : "";
      return `<span class="weight-delta-chip ${trendCls}"${tip}><span class="delta-arrow">${delta > 0 ? "▲" : "▼"}</span>${esc(name)} ${delta > 0 ? "+" : ""}${delta}%</span>`;
    }).join("")
    : `<span class="weight-delta-chip neutral">權重無變動</span>`;
  return `
    <div class="weight-history-row ${cls}" title="${esc(title)}">
      <span class="weight-history-label">${label}${record}${date ? ` ${date}` : ""}</span>
      <div class="weight-history-chips">${chips}</div>
    </div>
  `;
}

function renderWeightHistoryPanel(seg, products, opts = {}) {
  const scale = opts.familyScale && opts.familyScale > 0 && opts.familyScale < 1 ? opts.familyScale : null;
  const previous = opts.allSegs
    ? previousWeightSnapshotForReference(opts.allSegs, products, { referenceSeg: opts.referenceSeg || seg })
    : null;
  if (!previous) return "";
  const currentEntries = productWeightEntries(seg, products);
  return `
    <div class="tl-weight-history">
      ${renderWeightDeltaLine(currentEntries, previous, "較上筆", "delta", scale)}
    </div>
  `;
}

function weightSummary(seg, products, mode = "bar", opts = {}) {
  const details = (mode === "bar" && opts.allSegs)
    ? weightSnapshotDetails(opts.allSegs, products, { referenceSeg: opts.referenceSeg || seg })
    : { entries: productWeightEntries(seg, products), snapshotSegs: [seg], referenceSeg: seg };
  const rawEntries = details.entries;
  if (rawEntries.length === 0) return `<span class="ink-3">（無權重）</span>`;
  // 家族成員:weight × familyScale + largest-remainder round,讓加總精確 = round(scale × 100)
  const scale = opts.familyScale && opts.familyScale > 0 && opts.familyScale < 1 ? opts.familyScale : null;
  const entries = scale ? scaleWithLargestRemainder(rawEntries, scale) : rawEntries;

  if (mode === "inline") {
    return entries.map(({ pid, name, weight, rawWeight }) => {
      const tip = rawWeight !== undefined ? ` title="此 ad 內 ${Math.round(rawWeight)}%"` : "";
      return `<span class="pill" style="border-left:3px solid ${productColor(pid)};padding-left:6px"${tip}>${esc(name)} ${Math.round(weight)}%</span>`;
    }).join(" ");
  }

  return renderWeightPills(entries, {
    code: opts.code || seg.ad_code,
    open: opts.open,
    moreButton: true,
  });
}

function actionButtons(seg, compact, opts = {}) {
  const id = seg.id;
  const showLifecycle = opts.lifecycle !== false;
  const lockIcon = seg.lock_full
    ? `<span class="lock-icon" title="🚫 禁止挪動">🚫</span>`
    : (seg.lock_perf_adjust
      ? `<span class="lock-icon" title="🔒 鎖權重">🔒</span>`
      : "");
  // 2026-05 按鈕 layout 重整(§5.7):[編輯][權重調整][⋯]
  // 在 split_pair 配對內的廣告 → 「權重調整」按鈕完全不顯示,改用家族列整體視角入口(§5.7.2)
  const weightBtn = showLifecycle && !seg.split_pair_id
    ? `<button data-act="weight" data-id="${id}" title="權重調整">權重調整</button>`
    : "";
  const moreBtn = showLifecycle
    ? `<button data-act="more" data-id="${id}" title="更多動作(續費 / 結束 / 鎖定 / 淘汰)">⋯</button>`
    : "";
  return `
    ${lockIcon}
    <button data-edit="${id}">編輯</button>
    ${weightBtn}
    ${moreBtn}
  `;
}

function rangesOverlap(a, b) {
  return !!(a?.start_date && a?.end_date && b?.start_date && b?.end_date &&
    a.start_date < b.end_date && b.start_date < a.end_date);
}

function deleteTargetsForSegment(allAds, seg) {
  if (!seg) return [];
  const targets = [seg];
  if (seg.split_pair_id) {
    for (const ad of (allAds || [])) {
      if (ad.id === seg.id) continue;
      if (ad.split_pair_id === seg.split_pair_id && rangesOverlap(ad, seg)) targets.push(ad);
    }
  }
  const seen = new Set();
  return targets.filter((ad) => {
    const id = String(ad?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function deleteTargetDetails(targets) {
  return targets.map((ad) =>
    `${ad.ad_code} ${ad.ad_name}｜${ad.start_date} ~ ${ad.end_date}｜${Math.round(ad.amount_cny || 0).toLocaleString()} RMB`
  );
}

function deleteAdSegments(st, seg) {
  const liveSeg = st.ads.find((a) => a.id === seg?.id) || seg;
  const ids = new Set(deleteTargetsForSegment(st.ads, liveSeg).map((ad) => ad.id));
  st.ads = st.ads.filter((ad) => !ids.has(ad.id));
  return ids.size;
}

function bindHandlers(root, s) {
  root.querySelector("#btn-add").onclick = () => openEditor(null);

  // 同家族 link badge:點擊 scroll 到該 code 的卡
  root.querySelectorAll("[data-jump-code]").forEach((el) => {
    el.onclick = (e) => {
      e.preventDefault();
      const target = root.querySelector(`[data-anchor-code="${el.dataset.jumpCode.replace(/"/g, '\\"')}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("jump-highlight");
        setTimeout(() => target.classList.remove("jump-highlight"), 1500);
      }
    };
  });

  root.querySelectorAll("[data-tab]").forEach((el) => {
    el.onclick = () => {
      activeTab = el.dataset.tab;
      render(root);
    };
  });

  root.querySelector("#filt-apply").onclick = () => {
    filterStart = root.querySelector("#filt-start").value;
    filterEnd = root.querySelector("#filt-end").value;
    render(root);
  };

  // 搜尋：邊打邊重渲染（去抖 250ms），避免每個 keystroke 都跑完整渲染
  const searchInput = root.querySelector("#filt-search");
  if (searchInput) {
    let _searchT = null;
    searchInput.oninput = (e) => {
      const v = e.target.value;
      clearTimeout(_searchT);
      _searchT = setTimeout(() => {
        searchQuery = v;
        render(root);
        // 重渲染後焦點會掉，把焦點搶回來、游標放尾端
        const next = root.querySelector("#filt-search");
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }, 250);
    };
    // Enter 立即套用
    searchInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        clearTimeout(_searchT);
        searchQuery = e.target.value;
        render(root);
      }
    };
  }
  const searchClear = root.querySelector("#filt-search-clear");
  if (searchClear) searchClear.onclick = () => { searchQuery = ""; render(root); };
  root.querySelector("#filt-clear").onclick = () => {
    filterStart = ""; filterEnd = "";
    render(root);
  };
  root.querySelector("#filt-this-month").onclick = (e) => {
    const ym = e.currentTarget.dataset.month;
    if (!ym) return;
    const [y, m] = ym.split("-").map(Number);
    filterStart = `${ym}-01`;
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    filterEnd = addDays(next, -1);
    render(root);
  };

  root.querySelectorAll("[data-toggle]").forEach((el) => {
    el.onclick = () => {
      const code = el.dataset.toggle;
      if (expanded.has(code)) expanded.delete(code); else expanded.add(code);
      render(root);
    };
  });
  root.querySelectorAll("[data-weight-toggle]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const code = el.dataset.weightToggle;
      if (expandedWeights.has(code)) expandedWeights.delete(code); else expandedWeights.add(code);
      render(root);
    };
  });
  root.querySelectorAll("[data-timeline-toggle]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.dataset.timelineToggle;
      if (expandedTimelineNodes.has(id)) expandedTimelineNodes.delete(id); else expandedTimelineNodes.add(id);
      render(root);
    };
  });
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.edit);
  });
  root.querySelectorAll("[data-renew]").forEach((el) => {
    el.onclick = () => openEditor(null, el.dataset.renew);
  });
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = async () => {
      const seg = s.ads.find((a) => a.id === el.dataset.del);
      if (!seg) return;
      const targets = deleteTargetsForSegment(s.ads, seg);
      const isPairDelete = targets.length > 1;
      const ok = await confirmAsync({
        title: isPairDelete ? "刪除配對廣告段" : "刪除廣告段",
        body: isPairDelete
          ? `這是拆分廣告，會同時刪除同區間的 ${targets.length} 段。`
          : `確認刪除這一段？同代碼其他段不受影響。`,
        details: deleteTargetDetails(targets),
        okText: "刪除", danger: true,
      });
      if (!ok) return;
      update((st) => { deleteAdSegments(st, seg); }, isPairDelete ? "刪除配對廣告段" : "刪除廣告段");
      toast("已刪除", "ok");
    };
  });
  root.querySelectorAll("[data-act]").forEach((el) => {
    el.onclick = () => {
      const seg = s.ads.find((a) => a.id === el.dataset.id);
      if (!seg) return;
      const act = el.dataset.act;
      if (act === "weight") openWeightAdjust(seg);
      else if (act === "more") openMoreMenu(seg);
      else if (act === "eliminate") openEliminate(seg);
    };
  });
  // 家族列「權重調整」按鈕(2026-05,§5.7.2 整體合約視角編輯)
  root.querySelectorAll("[data-fam-weight-pair]").forEach((el) => {
    el.onclick = () => openFamilyWeightAdjust(el.dataset.famWeightPair);
  });

  // 即將到期清單：續費 / 淘汰
  root.querySelectorAll("[data-expiring-red-toggle]").forEach((el) => {
    el.onclick = () => {
      expiringThisWeekOpen = !expiringThisWeekOpen;
      render(root);
    };
  });
  // 「續費」走 wizard，獨立採買 N 個產品時逐步續費(§5.7 wizard)
  root.querySelectorAll("[data-exp-renew]").forEach((el) => {
    el.onclick = () => {
      const seg = s.ads.find((a) => a.id === el.dataset.expRenew);
      if (seg) openRenewalWizard(seg.ad_code);
    };
  });
  root.querySelectorAll("[data-exp-eliminate]").forEach((el) => {
    el.onclick = () => {
      const seg = s.ads.find((a) => a.id === el.dataset.expEliminate);
      if (seg) openEliminate(seg);
    };
  });
}

// 淘汰：標記為「不再投放、不再通知」。實際資料保留，警告停止追蹤，廣告頁本週清單可保留狀態
// 結束:把 end_date 改到提前結束日,不開新段(§5.7)
async function openEndAd(seg) {
  const today = todayTaipei();
  const defaultEnd = today < seg.end_date ? today : seg.end_date;
  const html = `
    <h2>結束廣告:${esc(seg.ad_code)} ${esc(seg.ad_name)}</h2>
    <p class="ink-2" style="font-size:13px">提前結束此段,不開新段。原期間 ${seg.start_date} ~ ${seg.end_date}。</p>
    <div class="field"><label>提前結束日(含當日後不再攤提)</label>
      <input id="end-at" type="date" value="${defaultEnd}" min="${seg.start_date}" max="${seg.end_date}" />
    </div>
    <div class="modal-actions">
      <button id="end-cancel">取消</button>
      <button class="primary danger" id="end-ok">確認結束</button>
    </div>
  `;
  const dlg = modal.open(html);
  dlg.querySelector("#end-cancel").onclick = () => modal.close();
  dlg.querySelector("#end-ok").onclick = () => {
    const newEnd = dlg.querySelector("#end-at").value;
    if (!newEnd || newEnd <= seg.start_date || newEnd > seg.end_date) {
      toast("結束日必須在原期間內", "bad"); return;
    }
    update((st) => {
      const ad_snapshots = captureUndoSnapshot(st, [seg.id]);
      const a = st.ads.find((x) => x.id === seg.id);
      if (a) a.end_date = newEnd;
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "備註",
        description: `${seg.ad_code} ${seg.ad_name}:提前結束到 ${newEnd}(原 ${seg.end_date})`,
        status: "pending",
        undo_payload: { ad_snapshots, added_ad_ids: [] },
      });
    }, "提前結束");
    modal.close();
    toast(`已結束於 ${newEnd}`, "ok");
  };
}

async function openEliminate(seg) {
  const ok = await confirmAsync({
    title: "淘汰廣告",
    body: "標記為「到期不再投放」— 廣告資料保留供查詢，警告會停止追蹤；若 6 天內到期，廣告頁會保留為「已淘汰」狀態列。可隨時取消淘汰恢復追蹤。",
    details: [
      `${seg.ad_code} ${seg.ad_name}`,
      `期間 ${seg.start_date} ~ ${seg.end_date}`,
      `每日攤提 ${Math.round(seg.daily_amort_twd || 0).toLocaleString()} TWD`,
    ],
    okText: "淘汰", danger: true,
  });
  if (!ok) return;
  update((st) => {
    const targetCode = seg.ad_code;
    const targetIds = st.ads.filter((a) => a.ad_code === targetCode).map((a) => a.id);
    const ad_snapshots = captureUndoSnapshot(st, targetIds);
    st.ads.forEach((a) => {
      if (a.ad_code === targetCode) a.eliminated = true;
    });
    st.todos.push({
      id: uid("todo"),
      created_at: nowTaipeiStamp(),
      action_type: "淘汰廣告",
      description: `${seg.ad_code} ${seg.ad_name}：到期不再續費，已標記為淘汰`,
      status: "pending",
      undo_payload: { ad_snapshots, added_ad_ids: [] },
    });
  }, "淘汰廣告");
  toast("已淘汰並建立待辦", "ok");
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── 續費 wizard (2026-05) ────────────────────────────────────────────
// 多產品獨立採買(例 st100 色狗导航 = AV9 / JK / HYC 各 100%)時，按一次「續費」
// 走 wizard 逐步續費所有產品線。每一步可勾選「淘汰」讓該產品線到期不續費。
// 共購廣告(weights 多個 < 100%)只有 1 條鏈尾，wizard 仍走 1 步流程，行為等同舊單一彈窗。
//
// findRenewalTails:回傳 ad_code 底下所有「沒被任何段 renewal_of 指到」且 !eliminated 的段
function findRenewalTails(state, adCode) {
  const sameCode = state.ads.filter((a) => a.ad_code === adCode && !a.eliminated);
  if (sameCode.length === 0) return [];
  const referenced = new Set(state.ads.map((a) => a.renewal_of).filter(Boolean));
  const tails = sameCode.filter((a) => !referenced.has(a.id));
  tails.sort((a, b) => (a.end_date || "").localeCompare(b.end_date || ""));
  return tails;
}

function productLabelOfWeights(weights, products) {
  const entries = Object.entries(weights || {}).filter(([, w]) => Number(w) > 0);
  if (entries.length === 0) return "（無產品）";
  const nameOf = Object.fromEntries(products.map((p) => [p.id, p.name]));
  return entries.map(([pid, w]) => `${nameOf[pid] || pid} ${w}%`).join(" / ");
}

function openRenewalWizard(adCode) {
  const s = getState();
  // 排除「結束超過 14 天」的斷檔鏈尾:同代碼可能有歷史的兄弟鏈早就停了
  // (例 st287 有 4/8-4/10 那條老鏈,跟現在 5/13-5/22 在跑的鏈無關),
  // 不該被續費 wizard 一起拉進來變成多步驟。
  const today = todayTaipei();
  const cutoff = addDays(today, -14);
  const allTails = findRenewalTails(s, adCode);
  const tails = allTails.filter((a) => (a.end_date || "") >= cutoff);
  if (tails.length === 0) {
    if (allTails.length > 0) {
      toast(`找不到 14 天內的可續費段(${adCode} 的合約都已斷檔 14+ 天,請改用「新增廣告」)`, "bad");
    } else {
      toast("找不到可續費的廣告段", "bad");
    }
    return;
  }

  const addDaysYmd = (ymd, n) => {
    const d = new Date(ymd + "T00:00:00");
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const steps = tails.map((src) => {
    const startDate = src.end_date;
    const days = src.amortize_days || 30;
    const startYm = (startDate || s.settings.current_month).slice(0, 7);
    const isUsdt = src.currency === "USDT";
    return {
      src,
      isUsdt,
      eliminate: false,
      form: {
        start_date: startDate,
        end_date: addDaysYmd(startDate, days),
        amount_orig: isUsdt ? (src.amount_orig || 0) : (src.amount_cny || 0),
        currency_rate: isUsdt ? (src.currency_rate || getUsdtToCnyRate(s, startYm)) : 1,
        amount_cny: src.amount_cny || 0,
        exchange_rate: getExpenseRate(s, startYm),
        amortize_days: days,
      },
    };
  });

  let cur = 0;
  let dlg = null;

  const readCurrentForm = () => {
    if (!dlg) return;
    const step = steps[cur];
    step.eliminate = !!dlg.querySelector("#f-eliminate")?.checked;
    if (!step.eliminate) {
      step.form.start_date = dlg.querySelector("#f-start").value || step.form.start_date;
      step.form.end_date = dlg.querySelector("#f-end").value || step.form.end_date;
      step.form.amortize_days = Number(dlg.querySelector("#f-days").value) || 0;
      step.form.exchange_rate = Number(dlg.querySelector("#f-rate").value) || 0;
      if (step.isUsdt) {
        step.form.amount_orig = Number(dlg.querySelector("#f-amount-orig").value) || 0;
        step.form.currency_rate = Number(dlg.querySelector("#f-cny-rate").value) || 0;
        step.form.amount_cny = step.form.amount_orig * step.form.currency_rate;
      } else {
        step.form.amount_cny = Number(dlg.querySelector("#f-cny").value) || 0;
        step.form.amount_orig = step.form.amount_cny;
      }
    }
  };

  const validateStep = (idx) => {
    const step = steps[idx];
    if (step.eliminate) return null;
    const f = step.form;
    if (!f.start_date || !f.end_date) return "起訖日期必填";
    if (f.end_date <= f.start_date) return "結束日需晚於開始日";
    if (!f.amortize_days || f.amortize_days <= 0) return "攤提天數必須大於 0";
    if (step.isUsdt) {
      if (!f.amount_orig || f.amount_orig <= 0) return "USDT 金額必須大於 0";
      if (!f.currency_rate || f.currency_rate <= 0) return "USDT→RMB 匯率必須大於 0";
    } else {
      if (!f.amount_cny || f.amount_cny <= 0) return "金額必須大於 0";
    }
    if (!f.exchange_rate || f.exchange_rate <= 0) return "匯率必須大於 0";
    return null;
  };

  const render = () => {
    const step = steps[cur];
    const src = step.src;
    const productLabel = productLabelOfWeights(src.weights, s.products);
    const adName = src.ad_name || src.ad_code;
    const isLast = cur === steps.length - 1;
    const isFirst = cur === 0;
    const stepBadges = steps.map((st, i) => {
      const tone = i === cur ? "background:#2a4d7a;color:#fff" : (st.eliminate ? "background:#fde3e3;color:var(--bad)" : "background:#e6ecf3;color:var(--ink-2)");
      const mark = st.eliminate ? "✕" : (i < cur ? "✓" : (i + 1));
      return `<span class="pill" style="${tone};font-weight:700;min-width:24px;text-align:center">${mark}</span>`;
    }).join('<span class="ink-3" style="font-size:10px">›</span>');

    const html = `
      <h2 style="display:flex;align-items:center;gap:10px">
        <span>續費廣告</span>
        <span class="pill" style="background:#dfe7f5;color:#2a4d7a;font-weight:700">(${cur + 1}/${steps.length}) ${esc(adName)}</span>
      </h2>
      <div style="display:flex;align-items:center;gap:6px;margin:6px 0 14px">${stepBadges}</div>
      <p class="ink-2" style="font-size:13px;margin:0 0 10px">
        本步驟產品:<strong>${esc(productLabel)}</strong>
        <span class="ink-3" style="margin-left:8px">(代碼 ${esc(src.ad_code)})</span>
      </p>
      <div style="padding:10px;background:#f7f8fa;border:1px solid var(--line);border-radius:6px;margin-bottom:14px;font-size:12px;line-height:1.7">
        <strong>原合約</strong> ·
        ${esc(src.start_date)} ~ ${esc(src.end_date)} ·
        ${step.isUsdt ? `${(src.amount_orig || 0).toLocaleString()} USDT × ${src.currency_rate || 0} = ` : ""}
        ${(src.amount_cny || 0).toLocaleString()} RMB × ${src.exchange_rate || 0} =
        ${Math.round((src.amount_cny || 0) * (src.exchange_rate || 0)).toLocaleString()} TWD ·
        攤提 ${src.amortize_days || 0} 天 · 每日 ${Math.round(src.daily_amort_twd || 0).toLocaleString()} TWD
      </div>

      <label style="display:flex;align-items:center;gap:8px;padding:10px;border:1px solid ${step.eliminate ? "#e88" : "var(--line)"};border-radius:6px;background:${step.eliminate ? "#fde3e3" : "#fff"};margin-bottom:14px;cursor:pointer">
        <input type="checkbox" id="f-eliminate" ${step.eliminate ? "checked" : ""} />
        <span>此產品到期不再續費（<strong style="color:var(--bad)">淘汰</strong>）— 勾選後不會建立新段，只把現有段標記為已淘汰</span>
      </label>

      <fieldset id="renew-fields" ${step.eliminate ? "disabled style=\"opacity:0.4\"" : ""} style="border:none;padding:0;margin:0">
        <div class="field-row">
          <div class="field"><label>開始日（含）</label><input id="f-start" type="date" value="${step.form.start_date}" /></div>
          <div class="field"><label>結束日（不含）</label><input id="f-end" type="date" value="${step.form.end_date}" /></div>
          <div class="field"><label>攤提天數（自動 = 起迄天數）</label><input id="f-days" type="number" value="${step.form.amortize_days}" /></div>
        </div>
        ${step.isUsdt ? `
          <div class="field-row">
            <div class="field"><label>USDT 金額</label><input id="f-amount-orig" type="number" step="any" value="${step.form.amount_orig}" /></div>
            <div class="field"><label>USDT→RMB 匯率</label>
              <input id="f-cny-rate" type="number" step="any" value="${step.form.currency_rate}" />
              <div class="hint">起始月匯率 ${getUsdtToCnyRate(s, (step.form.start_date || s.settings.current_month).slice(0, 7))}</div>
            </div>
            <div class="field"><label>RMB 金額（自動）</label><input id="f-cny" disabled value="0" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label>RMB→TWD 匯率</label>
              <input id="f-rate" type="number" step="any" value="${step.form.exchange_rate}" />
              <div class="hint">起始月匯率 ${getExpenseRate(s, (step.form.start_date || s.settings.current_month).slice(0, 7))}</div>
            </div>
            <div class="field"><label>台幣金額（自動）</label><input id="f-twd" disabled value="0" /></div>
            <div class="field"><label>每日攤提（台幣，自動）</label><input id="f-daily" disabled value="0" /></div>
          </div>
        ` : `
          <div class="field-row">
            <div class="field"><label>RMB 金額</label><input id="f-cny" type="number" step="any" value="${step.form.amount_cny}" /></div>
            <div class="field"><label>RMB→TWD 匯率</label>
              <input id="f-rate" type="number" step="any" value="${step.form.exchange_rate}" />
              <div class="hint">起始月匯率 ${getExpenseRate(s, (step.form.start_date || s.settings.current_month).slice(0, 7))}</div>
            </div>
            <div class="field"><label>台幣金額（自動）</label><input id="f-twd" disabled value="0" /></div>
          </div>
          <div class="field"><label>每日攤提（台幣，自動）</label><input id="f-daily" disabled value="0" /></div>
        `}
      </fieldset>

      <div class="modal-actions" style="margin-top:18px;display:flex;justify-content:space-between;align-items:center">
        <button id="cancel">取消</button>
        <div style="display:flex;gap:8px">
          ${isFirst ? "" : `<button id="prev">← 上一步</button>`}
          <button id="next" class="primary">${isLast ? "💾 儲存" : "下一步 →"}</button>
        </div>
      </div>
    `;

    dlg = modal.open(html);

    const recalc = () => {
      let cny;
      if (step.isUsdt) {
        const orig = Number(dlg.querySelector("#f-amount-orig").value) || 0;
        const cnyRate = Number(dlg.querySelector("#f-cny-rate").value) || 0;
        cny = orig * cnyRate;
        dlg.querySelector("#f-cny").value = Math.round(cny * 100) / 100;
      } else {
        cny = Number(dlg.querySelector("#f-cny").value) || 0;
      }
      const rate = Number(dlg.querySelector("#f-rate").value) || 0;
      const days = Number(dlg.querySelector("#f-days").value) || 0;
      const twd = cny * rate;
      dlg.querySelector("#f-twd").value = Math.round(twd).toLocaleString();
      dlg.querySelector("#f-daily").value = days > 0 ? Math.round(twd / days).toLocaleString() : "0";
    };
    const syncDays = () => {
      const start = dlg.querySelector("#f-start").value;
      const end = dlg.querySelector("#f-end").value;
      if (!start || !end) return;
      const span = (new Date(end) - new Date(start)) / 86400000;
      if (span > 0 && Number.isFinite(span)) {
        dlg.querySelector("#f-days").value = span;
        recalc();
      }
    };
    const recalcInputs = step.isUsdt
      ? ["f-amount-orig", "f-cny-rate", "f-rate", "f-days"]
      : ["f-cny", "f-rate", "f-days"];
    recalcInputs.forEach((id) => {
      const el = dlg.querySelector("#" + id);
      if (el) el.addEventListener("input", recalc);
    });
    dlg.querySelector("#f-start").addEventListener("change", syncDays);
    dlg.querySelector("#f-end").addEventListener("change", syncDays);
    recalc();

    dlg.querySelector("#f-eliminate").onchange = () => {
      readCurrentForm();
      render();
    };
    dlg.querySelector("#cancel").onclick = () => modal.close();
    if (!isFirst) {
      dlg.querySelector("#prev").onclick = () => {
        readCurrentForm();
        cur -= 1;
        render();
      };
    }
    dlg.querySelector("#next").onclick = () => {
      readCurrentForm();
      const err = validateStep(cur);
      if (err) { toast(err, "bad"); return; }
      if (isLast) commit();
      else { cur += 1; render(); }
    };
  };

  // commit:單一 update() 套用所有 steps,並建立 1 筆撤回 todo(僅當有淘汰時)
  const commit = () => {
    for (let i = 0; i < steps.length; i++) {
      const err = validateStep(i);
      if (err) { toast(`第 ${i + 1} 步：${err}`, "bad"); cur = i; render(); return; }
    }
    const renewSteps = steps.filter((st) => !st.eliminate);
    const elimSteps = steps.filter((st) => st.eliminate);

    update((state) => {
      const elimIds = elimSteps.map((st) => st.src.id);
      const ad_snapshots = captureUndoSnapshot(state, elimIds);
      const added_ad_ids = [];

      for (const step of steps) {
        const src = step.src;
        if (step.eliminate) {
          const a = state.ads.find((x) => x.id === src.id);
          if (a) a.eliminated = true;
          continue;
        }
        const f = step.form;
        const twd = f.amount_cny * f.exchange_rate;
        const newId = uid("ad");
        const newAd = structuredClone(src);
        newAd.id = newId;
        newAd.start_date = f.start_date;
        newAd.end_date = f.end_date;
        newAd.amortize_days = f.amortize_days;
        newAd.amount_cny = f.amount_cny;
        newAd.exchange_rate = f.exchange_rate;
        newAd.amount_twd = twd;
        newAd.daily_amort_twd = twd / f.amortize_days;
        newAd.renewal_of = src.id;
        newAd.renewal_reason = "續費";
        newAd.eliminated = false;
        // pair 欄位不沿用(新段是獨立新段,split 由日後權重調整再觸發)
        delete newAd.split_pair_id;
        delete newAd.split_role;
        newAd.code_at_creation = src.ad_code;
        // 幣別:跟 src 走(RMB 買 RMB 續、USDT 買 USDT 續,不會跨幣別)
        if (step.isUsdt) {
          newAd.currency = "USDT";
          newAd.currency_rate = f.currency_rate;
          newAd.amount_orig = f.amount_orig;
          newAd.amount_cny = f.amount_orig * f.currency_rate;
          newAd.amount_twd = newAd.amount_cny * f.exchange_rate;
          newAd.daily_amort_twd = newAd.amount_twd / f.amortize_days;
        } else {
          newAd.currency = "CNY";
          newAd.currency_rate = 1;
          newAd.amount_orig = f.amount_cny;
        }
        state.ads.push(newAd);
        added_ad_ids.push(newId);
      }

      // 待辦:有淘汰才建立(純續費維持舊行為 — 不建立 todo)
      if (elimSteps.length > 0) {
        const adName = tails[0].ad_name || adCode;
        const elimNames = elimSteps.map((st) => productLabelOfWeights(st.src.weights, state.products)).join("、");
        const renewNames = renewSteps.map((st) => productLabelOfWeights(st.src.weights, state.products)).join("、");
        const parts = [];
        if (elimNames) parts.push(`淘汰 ${elimNames}`);
        if (renewNames) parts.push(`續費 ${renewNames}`);
        state.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type: "淘汰廣告",
          description: `${adCode} ${adName}：${parts.join("、")}`,
          status: "pending",
          undo_payload: { ad_snapshots, added_ad_ids },
        });
      }
    }, "續費精靈");

    modal.close();
    const msgParts = [];
    if (renewSteps.length > 0) msgParts.push(`續費 ${renewSteps.length} 個`);
    if (elimSteps.length > 0) msgParts.push(`淘汰 ${elimSteps.length} 個`);
    toast(`已完成:${msgParts.join("、")}`, "ok");
  };

  render();
}

// ── 編輯器 / 新增 / 續費 ────────────────────────────────────────────
function openEditor(id, renewFrom = null, prefill = null) {
  const s = getState();
  let a;
  if (id) {
    a = structuredClone(s.ads.find((x) => x.id === id));
  } else if (renewFrom) {
    const src = s.ads.find((x) => x.id === renewFrom);
    // 續費：start_date = 上段結束日；新匯率取「該月份」的匯率（若有覆寫）
    const startYm = (src.end_date || s.settings.current_month).slice(0, 7);
    a = {
      ...structuredClone(src),
      id: undefined,
      renewal_of: src.id,
      renewal_reason: "續費",
      start_date: src.end_date,
      end_date: "",
      amount_cny: src.amount_cny,
      exchange_rate: getExpenseRate(s, startYm),
    };
  } else if (prefill) {
    const startYm = (prefill.start_date || `${s.settings.current_month}-01`).slice(0, 7);
    a = {
      ad_code: "", ad_name: "", group: "",
      amount_cny: prefill.amount_cny || 0,
      exchange_rate: prefill.exchange_rate || getExpenseRate(s, startYm),
      start_date: prefill.start_date || `${s.settings.current_month}-01`,
      end_date: prefill.end_date || "",
      amortize_days: prefill.amortize_days || 30,
      weights: prefill.weights || {},
      renewal_of: null,
      renewal_reason: "初始",
    };
  } else {
    // 預設:start = 今天,end = 下個月同一日(5/13 → 6/13)。
    // 月底日不存在則 clamp 到當月最後一天(例 1/31 → 2/28/29)。
    const today = todayTaipei();
    const [ty, tm, td] = today.split("-").map(Number);
    let ey = ty;
    let em = tm + 1;
    if (em > 12) { ey += 1; em = 1; }
    const lastDay = new Date(Date.UTC(ey, em, 0)).getUTCDate();
    const ed = Math.min(td, lastDay);
    const endDate = `${ey}-${String(em).padStart(2, "0")}-${String(ed).padStart(2, "0")}`;
    const amortizeDays = Math.round((Date.parse(endDate) - Date.parse(today)) / 86400000);
    const startYm = today.slice(0, 7);
    a = {
      ad_code: "", ad_name: "", group: "",
      amount_cny: 0, exchange_rate: getExpenseRate(s, startYm),
      start_date: today, end_date: endDate,
      amortize_days: amortizeDays,
      weights: {}, renewal_of: null, renewal_reason: "初始",
    };
  }

  // 既有廣告分組 — 給下拉選單用（取唯一值並排序）
  const existingGroups = [...new Set(s.ads.map((x) => x.group).filter((g) => g && g.trim()))].sort();
  // 若 a.group 不在既有清單裡（新建中且使用者尚未選），允許落到「新增」模式
  const groupInList = a.group && existingGroups.includes(a.group);
  const readonlyWeights = id && a?.split_pair_id
    ? displayWeightsForAd(a, s.ads)
    : (a.weights || {});
  const shortUrlSelection = parseShortUrlType(a.short_url_type);
  const selectedShortUrlSlot = shortUrlSelection.slot || "L1";

  const html = `
    <h2>${id ? "編輯廣告" : renewFrom ? "續費廣告" : "新增廣告"}</h2>
    <div class="field-row">
      <div class="field"><label>廣告代碼</label><input id="f-code" value="${esc(a.ad_code || "")}" /></div>
      <div class="field" style="flex:2"><label>廣告名稱</label><input id="f-name" value="${esc(a.ad_name || "")}" /></div>
      <div class="field">
        <label>廣告分組</label>
        <select id="f-group-select">
          <option value="" ${!a.group ? "selected" : ""}>（未分組）</option>
          ${existingGroups.map((g) => `<option value="${esc(g)}" ${groupInList && a.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}
          <option value="__new__" ${a.group && !groupInList ? "selected" : ""}>＋ 新增分組…</option>
        </select>
        <input id="f-group-new" type="text" placeholder="輸入新分組名稱" value="${esc(!groupInList ? (a.group || "") : "")}" style="margin-top:4px;display:${a.group && !groupInList ? "block" : "none"}" />
      </div>
    </div>
    <div class="amount-row">
      <div class="field" style="flex:0 0 110px">
        <label>幣別</label>
        <select id="f-currency">
          <option value="CNY" ${(a.currency || "CNY") === "CNY" ? "selected" : ""}>RMB</option>
          <option value="USDT" ${a.currency === "USDT" ? "selected" : ""}>USDT</option>
        </select>
      </div>
      <div class="field usdt-only">
        <label>USDT 金額</label>
        <input id="f-amount-orig" type="number" step="any" value="${a.currency === "USDT" ? (a.amount_orig || 0) : ""}" />
      </div>
      <span class="amount-op usdt-only">×</span>
      <div class="field usdt-only">
        <label>USDT→RMB</label>
        <input id="f-cny-rate" type="number" step="any" value="${a.currency_rate || getUsdtToCnyRate(s, (a.start_date || s.settings.current_month).slice(0,7))}" />
        <div class="hint">起始月匯率 ${getUsdtToCnyRate(s, (a.start_date || s.settings.current_month).slice(0,7))}</div>
      </div>
      <span class="amount-op usdt-only">=</span>
      <div class="field"><label>RMB 金額</label><input id="f-cny" type="number" step="any" value="${a.amount_cny || 0}" /></div>
      <span class="amount-op">×</span>
      <div class="field">
        <label>RMB→TWD</label>
        <input id="f-rate" type="number" step="any" value="${a.exchange_rate || 4.7}" />
        <div class="hint" id="f-rate-hint">起始月匯率 ${getExpenseRate(s, (a.start_date || s.settings.current_month).slice(0,7))}</div>
      </div>
      <span class="amount-op">=</span>
      <div class="field"><label>台幣金額（自動）</label><input id="f-twd" disabled value="${Math.round((a.amount_cny || 0) * (a.exchange_rate || 4.7))}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>開始日（含）</label><input id="f-start" type="date" value="${a.start_date || ""}" /></div>
      <div class="field"><label>結束日（不含）</label><input id="f-end" type="date" value="${a.end_date || ""}" /></div>
      <div class="field"><label>攤提天數${id ? "（編輯時不自動同步）" : "（自動 = 起迄天數）"}</label><input id="f-days" type="number" value="${a.amortize_days || 30}" /></div>
    </div>
    <div class="field">
      <label>每日攤提（台幣，自動）</label>
      <input id="f-daily" disabled value="0" />
      <div class="hint" id="f-daily-hint"></div>
    </div>

    ${id ? `
    <h3 class="mt-16">權重分配（唯讀）</h3>
    <div class="hint" style="padding:8px 10px;background:#fff4e6;border:1px solid #ffd9a8;border-radius:6px;font-size:12px;line-height:1.6;margin-bottom:8px">
      ⚠️ 編輯模式不能改權重 — 為了保留 traceability，所有 weights 變動一律走「<strong>權重調整</strong>」按鈕（自動建 todo + 撤回 + 切段紀錄）。
    </div>
    <div class="weights-readonly" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;background:#f7f7f7;border:1px solid #e1e1e1;border-radius:6px">
      ${Object.entries(readonlyWeights || {}).filter(([,w]) => Number(w) > 0).map(([pid, w]) => {
        const p = s.products.find((x) => x.id === pid);
        return `<span style="padding:3px 8px;background:#fff;border:1px solid #ddd;border-radius:4px;font-size:12px"><strong>${esc(p?.name || pid)}</strong> ${Number(w)}%</span>`;
      }).join("") || `<span class="ink-3" style="font-size:12px">（未分配權重）</span>`}
    </div>
    ` : `
    <h3 class="mt-16" style="display:flex;justify-content:space-between;align-items:center">
      <span>權重分配</span>
      <button id="btn-suggest" style="font-size:12px;padding:4px 10px">🤖 依剩餘預算自動建議</button>
    </h3>
    <div id="suggest-reasons" class="suggest-reasons"></div>
    <div id="weights"></div>
    <div class="weight-sum" id="weight-sum">合計：<span id="wsum-val">0</span>%</div>
    `}

    ${!id && !renewFrom && s.products.some((p) => p.is_poquan) ? `
    <div class="hint mt-8" style="padding:8px 10px;background:#f0f7ff;border:1px solid #cfe1f5;border-radius:6px;font-size:12px;line-height:1.5">
      💡 純破圈會自動存成 <code>stXXXt</code>；若上方權重同時含「一般 + 破圈」,儲存時系統會自動建立 <code>stXXX</code> + <code>stXXXt</code> 兩支廣告並關聯。
    </div>
    ` : ""}

    <div class="field-row mt-16">
      <div class="field" style="flex:1">
        <label>廣告文案<span class="ink-3" style="font-size:11px;font-weight:400;margin-left:6px">(最多 20 字)</span></label>
        <input id="f-ad-copy" type="text" maxlength="20" value="${esc(a.ad_copy || "")}" placeholder="例:免費下載" />
        <div class="hint"><span id="ad-copy-count">${(a.ad_copy || "").length}</span> / 20</div>
      </div>
      <div class="field" style="flex:1">
        <label>我方聯絡用 TG 號</label>
        <input id="f-contact-tg" type="text" value="${esc(a.contact_tg || "")}" placeholder="例:@abc123" />
      </div>
      <div class="field" style="flex:2">
        <label>站長聯繫資料(選填)</label>
        <input id="f-contact-info" type="text" value="${esc(a.contact_info || "")}" placeholder="例:微信 abc123、TG @xyz" />
      </div>
    </div>

    <div class="field-row">
      <div class="field" style="flex:1">
        <label>採用連結</label>
        <div class="radio-row" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding-top:6px">
          ${SHORT_URL_SLOT_OPTIONS.map((opt) => `<label style="font-weight:400;font-size:13px;cursor:pointer">
            <input type="radio" name="f-short-url-type" value="${esc(opt.value)}" ${selectedShortUrlSlot === opt.value ? "checked" : ""} /> ${esc(opt.label)}
          </label>`).join("")}
          <label style="font-weight:400;font-size:13px;cursor:pointer;color:#c02670;border-left:1px solid var(--line);padding-left:14px">
            <input type="checkbox" id="f-short-url-bag" ${shortUrlSelection.hasBag ? "checked" : ""} /> 提包
          </label>
        </div>
      </div>
      <div class="field" style="flex:1">
        <label>縮網址參數(選填)</label>
        <input id="f-short-url-param" type="text" value="${esc(a.short_url_param || "")}" placeholder="例:utm_source=st123" />
      </div>
    </div>

    <div class="field mt-16">
      <label>備註（選填，例：本次續費送 5 天）</label>
      <textarea id="f-notes" rows="2" style="width:100%;resize:vertical">${esc(a.notes || "")}</textarea>
    </div>

    ${id ? renderPerfSection(a, s) : ""}

    <div class="modal-actions">
      <button id="cancel">取消</button>
      <button class="primary" id="save">儲存</button>
    </div>
  `;
  const dlg = modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  const applyCurrencyMode = () => {
    const cur = q("#f-currency").value;
    const usdt = cur === "USDT";
    dlg.querySelectorAll(".usdt-only").forEach((el) => { el.style.display = usdt ? "" : "none"; });
    q("#f-cny").disabled = usdt;  // USDT 模式：人民幣金額由 USDT × USDT→RMB 自動算，不可手填
  };

  // 廣告分組：選「＋ 新增分組」時，把文字輸入框顯示出來並 focus
  const groupSelect = q("#f-group-select");
  const groupNew = q("#f-group-new");
  if (groupSelect && groupNew) {
    groupSelect.onchange = () => {
      if (groupSelect.value === "__new__") {
        groupNew.style.display = "block";
        groupNew.focus();
      } else {
        groupNew.style.display = "none";
        groupNew.value = "";
      }
    };
  }

  // 廣告文案字數即時計數
  const adCopyInput = q("#f-ad-copy");
  const adCopyCount = q("#ad-copy-count");
  if (adCopyInput && adCopyCount) {
    adCopyInput.oninput = () => {
      adCopyCount.textContent = String(adCopyInput.value.length);
    };
  }

  // 破圈分流 UI 已移除(2026-05),改用自動拆 t(§5.7.2)。
  // 保留以下空殼函式以最小化下方既有呼叫點變動;後續清理時可一併移除。
  const poquanSplit = null;
  const poquanDetail = null;
  const poquanProducts = [];
  const poquanNameOf = (pid) => s.products.find((x) => x.id === pid)?.name || pid;
  const readPoquanTargetWeights = () => ({});
  const refreshPoquanSum = () => {};
  const updatePoquanPreview = () => {
    return;  // 已停用(2026-05),保留空函式避免破壞既有呼叫點
    /* eslint-disable no-unreachable */
    if (!poquanSplit || !poquanSplit.checked) return;
    refreshPoquanSum();
    const cny = Number(q("#f-cny").value) || 0;
    const pct = Number(q("#f-poquan-pct").value) || 0;
    const tgtWeights = readPoquanTargetWeights();
    const codeBase = q("#f-code").value.trim();
    const normalCny = Math.round(cny * (100 - pct) / 100);
    const poquanCny = Math.round(cny * pct / 100);
    const lblPct = q("#poquan-pct-label");
    if (lblPct) lblPct.textContent = String(pct);
    const preview = q("#poquan-preview");
    if (!preview) return;
    // 讀目前 weights(form 上方輸入的「一般部分」權重)
    const liveWeights = {};
    document.querySelectorAll("#weights input[data-pid]").forEach((inp) => {
      const v = Number(inp.value) || 0;
      if (v > 0) liveWeights[inp.dataset.pid] = v;
    });
    const sumNormal = Object.values(liveWeights).reduce((a, b) => a + b, 0);
    const normalFactor = (100 - pct) / 100;  // 一般部分占整體 (1 - pct/100)
    const poquanFactor = pct / 100;
    const generalLines = Object.entries(liveWeights).map(([pid, w]) => {
      const p = s.products.find((x) => x.id === pid);
      const pname = p ? p.name : pid;
      const overall = (w * normalFactor).toFixed(1);
      return `<div style="margin-left:14px;font-size:11px;color:var(--ink-2)">└ ${esc(pname)}: ${w}%(整體 ${overall}%)</div>`;
    }).join("");
    const poquanLines = Object.entries(tgtWeights).map(([pid, w]) => {
      const pname = poquanNameOf(pid);
      const overall = (w * poquanFactor).toFixed(1);
      return `<div style="margin-left:14px;font-size:11px;color:var(--ink-2)">└ ${esc(pname)}: ${w}%(整體 ${overall}%)</div>`;
    }).join("");
    const sumWarn = sumNormal !== 100 ? `<span style="color:var(--warn)">(一般加總 ${sumNormal}%,請調為 100%)</span>` : "";
    const sumTgt = Object.values(tgtWeights).reduce((a, b) => a + b, 0);
    const sumPoqWarn = sumTgt !== 100 ? `<span style="color:var(--warn)">(破圈加總 ${sumTgt}%,請調為 100%)</span>` : "";
    // 整體分配 = 一般權重 × normalFactor + 破圈權重 × poquanFactor
    const overallEntries = [];
    Object.entries(liveWeights).forEach(([pid, w]) => {
      const p = s.products.find((x) => x.id === pid);
      overallEntries.push(`${(p ? p.name : pid)} ${(w * normalFactor).toFixed(1)}%`);
    });
    Object.entries(tgtWeights).forEach(([pid, w]) => {
      overallEntries.push(`${poquanNameOf(pid)} ${(w * poquanFactor).toFixed(1)}%`);
    });
    const overallTotal = sumNormal * normalFactor + sumTgt * poquanFactor;
    preview.innerHTML = `
      <div><strong>${esc(codeBase || "stXXX")}</strong> 一般 ${(100 - pct)}% · ${normalCny.toLocaleString()} RMB ${sumWarn}</div>
      ${generalLines || `<div style="margin-left:14px;font-size:11px;color:var(--ink-3)">└ (上方還沒填權重)</div>`}
      <div><strong>${esc(codeBase || "stXXX")}t</strong> 破圈 ${pct}% · ${poquanCny.toLocaleString()} RMB ${sumPoqWarn}</div>
      ${poquanLines || `<div style="margin-left:14px;font-size:11px;color:var(--ink-3)">└ (還沒分配破圈權重)</div>`}
      <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #d4d4d4;font-size:11px;color:var(--ink-2)">
        整體分配:${overallEntries.join(" / ")} = <strong>${overallTotal.toFixed(1)}%</strong>
      </div>
    `;
    /* eslint-enable no-unreachable */
  };

  const recalcDaily = () => {
    // USDT 模式：amount_cny = amount_orig × currency_rate
    const cur = q("#f-currency").value;
    if (cur === "USDT") {
      const orig = Number(q("#f-amount-orig").value) || 0;
      const cnyRate = Number(q("#f-cny-rate").value) || 0;
      q("#f-cny").value = (orig * cnyRate).toFixed(2);
    }
    const cny = Number(q("#f-cny").value) || 0;
    const rate = Number(q("#f-rate").value) || 0;
    const twd = cny * rate;
    const days = Number(q("#f-days").value) || 1;
    q("#f-twd").value = Math.round(twd);
    q("#f-daily").value = Math.round(twd / days);
    const start = q("#f-start").value, end = q("#f-end").value;
    if (start && end) {
      const spanDays = (new Date(end) - new Date(start)) / 86400000;
      let hint;
      if (spanDays === days) {
        hint = `起迄區間 ${spanDays} 天 vs 攤提天數 ${days} 天 ✓`;
      } else if (days > spanDays) {
        // 權重調整切段:am 沿用源段(>span)= 正常
        hint = `起迄區間 ${spanDays} 天 < 攤提天數 ${days} 天（這段是切出來的片段,am 沿用原合約 ${days} 天 — 正常)`;
      } else {
        // am < span:每日攤提 × 區間天數 > amount_twd → 雙倍計算!
        hint = `⚠️ 起迄區間 ${spanDays} 天 > 攤提天數 ${days} 天（這會讓本段重複計算 ${(spanDays / days).toFixed(2)}× 台幣金額,通常是錯誤資料)`;
      }
      q("#f-daily-hint").textContent = hint;
    } else {
      q("#f-daily-hint").textContent = "";
    }
    // 匯率提示：跟著 start_date 月份切換
    const rateHint = q("#f-rate-hint");
    if (rateHint && start) {
      const ym = start.slice(0, 7);
      const monthRate = getExpenseRate(s, ym);
      const userRate = Number(q("#f-rate").value) || 0;
      const diff = userRate && Math.abs(userRate - monthRate) > 1e-6;
      rateHint.innerHTML = `${ym} 設定匯率 <strong>${monthRate}</strong>${diff ? ` <span style="color:var(--warn)">（與你輸入的 ${userRate} 不同）</span>` : " ✓"}`;
    }
  };

  const weights = { ...(a.weights || {}) };
  const isSplitOn = () => false;  // 已停用(自動拆 t 取代)
  const renderWeights = () => {
    const host = q("#weights");
    const productsToShow = s.products;  // 永遠顯示全部產品(包含破圈),由 submit 時偵測碰撞自動拆
    host.innerHTML = productsToShow.map((p) => `
      <div class="weight-grid ad-weight-card ${Number(weights[p.id] || 0) > 0 ? "active" : ""}" style="--w:${Math.max(0, Math.min(100, Number(weights[p.id]) || 0))}">
        <div class="ad-weight-main">
          <span class="ad-weight-name">${esc(p.name)}</span>
          <span class="ad-weight-id mono">${esc(p.id)}</span>
        </div>
        <div class="ad-weight-control">
          <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${weights[p.id] ?? ""}" placeholder="0" />
          <span class="ad-weight-unit">%</span>
        </div>
        <div class="ad-weight-bar" aria-hidden="true"><span></span></div>
      </div>
    `).join("");
    host.querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) weights[inp.dataset.pid] = v;
        else delete weights[inp.dataset.pid];
        const card = inp.closest(".ad-weight-card");
        if (card) {
          const pct = Math.max(0, Math.min(100, Number(v) || 0));
          card.style.setProperty("--w", pct);
          card.classList.toggle("active", pct > 0);
        }
        recalcSum();
        updatePoquanPreview();
      };
    });
    recalcSum();
  };
  const recalcSum = () => {
    const sum = Object.values(weights).reduce((x, y) => x + Number(y || 0), 0);
    const sumEl = q("#weight-sum");
    const splitOn = isSplitOn();
    // 2 位小數的權重(由「依日期反向建議多選」帶入)可能因 IEEE 754 造成 99.999... / 100.000001
    // 用 0.01 容差判定 = 100
    const isExactly100 = Math.abs(sum - 100) < 0.01;
    sumEl.classList.toggle("ok", isExactly100);
    sumEl.classList.toggle("bad", sum - 100 > 0.01);
    sumEl.classList.toggle("warn", sum > 0 && 100 - sum > 0.01);
    const fmt = (n) => (Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2));
    let hint;
    if (sum === 0) hint = "（尚未填）";
    else if (isExactly100) hint = splitOn ? "✓ 一般部分 100%" : "✓ 共購 100%";
    else if (sum < 100) hint = `還需 ${fmt(100 - sum)}% 才到 100`;
    else hint = `已超過 100%（${fmt(sum - 100)}%）`;
    const label = splitOn ? "一般部分合計" : "合計";
    sumEl.innerHTML = `${label}：<strong>${fmt(sum)}%</strong> <span class="ink-3">${hint}</span>`;
  };

  ["f-cny","f-rate","f-days","f-start","f-end","f-amount-orig","f-cny-rate"].forEach((id2) => {
    const el = q("#"+id2);
    if (el) el.oninput = () => { recalcDaily(); updatePoquanPreview(); };
  });
  // code / name 改動也更新破圈預覽
  ["f-code", "f-name"].forEach((id2) => {
    const el = q("#"+id2);
    if (el) el.addEventListener("input", updatePoquanPreview);
  });
  // 改起迄日 → 自動把攤提天數帶成 (end - start)。使用者最後可以再手改 #f-days 蓋掉
  // ★ 只在「新增 / 續費」模式觸發,編輯既有廣告(id 有值)時不自動同步 — 避免覆蓋
  // 「權重調整切段」這類 am 沿用源段的場景(例:30 天合約被切成 11+19 兩段,
  //   兩段 am 都應該保持 30,不該被改成 11/19,否則會雙倍計算)
  if (!id) {
    const syncDaysFromSpan = () => {
      const start = q("#f-start").value;
      const end = q("#f-end").value;
      if (!start || !end) return;
      const span = (new Date(end) - new Date(start)) / 86400000;
      if (span > 0 && Number.isFinite(span)) {
        q("#f-days").value = span;
        recalcDaily();
      }
    };
    q("#f-start").addEventListener("change", syncDaysFromSpan);
    q("#f-end").addEventListener("change", syncDaysFromSpan);
  }
  q("#f-currency").onchange = () => { applyCurrencyMode(); recalcDaily(); };
  applyCurrencyMode();
  recalcDaily();
  // 編輯模式下 weights 區塊改為唯讀(HTML 內 inline 顯示),不 render 編輯 UI、不綁建議按鈕
  if (!id) {
    renderWeights();

    q("#btn-suggest").onclick = (e) => {
      e.preventDefault();
      const start = q("#f-start").value;
      const end = q("#f-end").value;
      const days = Number(q("#f-days").value) || 0;
      const cny = Number(q("#f-cny").value) || 0;
      const rate = Number(q("#f-rate").value) || 0;
      const twd = cny * rate;
      if (!start || !end || days <= 0 || twd <= 0) {
        toast("先填起訖日、攤提天數、金額", "bad");
        return;
      }
      const newAd = { start_date: start, end_date: end, amortize_days: days, daily_amort_twd: twd / days };
      const otherAds = s.ads;
      const { weights: suggested, reasons } = suggestWeights(s, s.products, otherAds, s.settings.current_month, newAd);
      for (const k of Object.keys(weights)) delete weights[k];
      Object.assign(weights, suggested);
      renderWeights();
      const rbox = q("#suggest-reasons");
      if (Object.keys(suggested).length === 0) {
        rbox.innerHTML = `<div class="hint" style="color:var(--bad)">無法建議：${reasons.join("；") || "查無可分配產品"}</div>`;
      } else if (reasons.length) {
        rbox.innerHTML = `<div class="hint">建議已套用。備註：${reasons.join("；")}</div>`;
      } else {
        rbox.innerHTML = `<div class="hint" style="color:var(--ok)">建議已套用（依各產品剩餘預算比例）</div>`;
      }
    };
  }

  q("#cancel").onclick = () => modal.close();
  q("#save").onclick = () => {
    const code = q("#f-code").value.trim();
    const name = q("#f-name").value.trim();
    const start = q("#f-start").value;
    const end = q("#f-end").value;
    const days = Number(q("#f-days").value) || 0;
    if (!code || !name) { toast("代碼與名稱必填", "bad"); return; }
    if (!start || !end) { toast("起訖日期必填", "bad"); return; }
    if (end <= start) { toast("結束日需晚於開始日", "bad"); return; }
    if (days <= 0) { toast("攤提天數必須大於 0", "bad"); return; }
    if (Object.keys(weights).length === 0) { toast("至少需設定一個產品權重", "bad"); return; }

    const cny = Number(q("#f-cny").value) || 0;
    const rate = Number(q("#f-rate").value) || 0;

    // 權重加總(只在新建/續費需要 = 100;編輯則維持舊邏輯讓使用者自己負責)
    const wSum = Object.values(weights).reduce((sum, v) => sum + (Number(v) || 0), 0);
    if (!id && Math.abs(wSum - 100) > 0.01) {
      toast(`權重合計 ${wSum.toFixed(2)}% 必須 = 100%`, "bad"); return;
    }

    // 自動拆 t 偵測(只在新增 / 續費 觸發;§5.7.2)
    // 編輯模式 weights 改為唯讀,不會產生新碰撞 → 跳過 detect
    const weightSides = !id ? splitWeightsByFamily(weights, s.products) : null;
    const collision = !id
      ? detectFamilyCollision(weights, s.products)
      : { collision: false };
    const splitWeights = collision.collision && weightSides?.normalSum > 0 && weightSides?.poquanSum > 0
      ? weightSides
      : null;
    const splitCodes = !id ? deriveSplitCodes(code) : null;
    const normalizedSingleCode = (() => {
      if (id || splitWeights || !weightSides || !splitCodes) return code;
      if (weightSides.poquanSum > 0 && weightSides.normalSum <= 0) return splitCodes.tVariantCode;
      if (weightSides.normalSum > 0 && weightSides.poquanSum <= 0 && /[tT]$/.test(code)) return splitCodes.parentCode;
      return code;
    })();

    const twd = cny * rate;
    const wKeys = Object.keys(weights);
    const purchaseMode = (wKeys.length === 1 && weights[wKeys[0]] === 100) ? "independent" : "shared";
    const notes = q("#f-notes").value.trim();
    // 幣別 / 原幣金額 / USDT→CNY 匯率
    const currency = q("#f-currency").value === "USDT" ? "USDT" : "CNY";
    const amount_orig = currency === "USDT" ? (Number(q("#f-amount-orig").value) || 0) : cny;
    const currency_rate = currency === "USDT" ? (Number(q("#f-cny-rate").value) || 0) : 1;
    // 廣告分組：select 模式取下拉值；若選「新增」則改讀文字輸入
    const groupSelectVal = q("#f-group-select").value;
    const groupValue = groupSelectVal === "__new__"
      ? (q("#f-group-new").value || "").trim()
      : groupSelectVal;
    // 自動拆 t:按一般 / 破圈權重 sum 切 cny / twd
    const totalWSum = splitWeights ? (splitWeights.normalSum + splitWeights.poquanSum) : wSum;
    const generalRatio = splitWeights ? splitWeights.normalSum / totalWSum : 1;
    const poquanRatio = splitWeights ? splitWeights.poquanSum / totalWSum : 0;
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const normalCny = splitWeights ? round2(cny * generalRatio) : cny;
    const poquanCny = splitWeights ? round2(cny * poquanRatio) : 0;
    const normalTwd = normalCny * rate;
    const poquanTwd = poquanCny * rate;

    // 廣告文案 / 站長聯繫 / 縮網址類型 / 縮網址參數
    const adCopy = (q("#f-ad-copy").value || "").trim();
    const contactTg = (q("#f-contact-tg").value || "").trim();
    const contactInfo = (q("#f-contact-info").value || "").trim();
    const shortUrlTypeRadio = dlg.querySelector('input[name="f-short-url-type"]:checked');
    const shortUrlSlot = shortUrlTypeRadio ? shortUrlTypeRadio.value : "L1";
    const shortUrlType = buildShortUrlType(shortUrlSlot, !!q("#f-short-url-bag")?.checked);
    const shortUrlParam = (q("#f-short-url-param").value || "").trim();

    const patch = {
      ad_code: normalizedSingleCode,
      ad_name: name,
      group: groupValue,
      currency,
      amount_orig,
      currency_rate,
      amount_cny: normalCny,
      exchange_rate: rate,
      amount_twd: normalTwd,
      start_date: start,
      end_date: end,
      amortize_days: days,
      daily_amort_twd: normalTwd / days,
      weights,
      purchase_mode: purchaseMode,
      ad_copy: adCopy,
      contact_tg: contactTg,
      contact_info: contactInfo,
      short_url_type: shortUrlType,
      short_url_param: shortUrlParam,
      renewal_of: a.renewal_of || null,
      renewal_reason: a.renewal_reason || (a.renewal_of ? "續費" : "初始"),
      notes,
    };

    const origWeights = id ? (s.ads.find((x) => x.id === id)?.weights || {}) : {};
    const weightsChanged = !id || weightsDiff(origWeights, weights);
    // 續費不進待辦(連結分流通常不需要動);新增 / 編輯-改權重才進
    const isRenewal = !id && !!a.renewal_of;
    const shouldCreateTodo = weightsChanged && !isRenewal;
    if (shouldCreateTodo && shortUrlSlot === "L1" && !shortUrlParam) {
      toast("L1 廣告要走 Yourls 批准，請先填縮網址參數", "bad");
      return;
    }

    update((st) => {
      // 撤回快照
      const ad_snapshots = id ? captureUndoSnapshot(st, [id]) : [];
      const added_ad_ids = [];
      const newAdId = uid("ad");
      // 自動拆 t 配對(2026-05,§5.7.2):依 collision 偵測決定是否建 pair
      const pairId = splitWeights ? `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}` : null;
      // 拆 t 時 parent 承接「一般側」,代碼 = splitCodes.parentCode(strip 掉使用者輸入的 t,若有)
      // 拆 t 時 patch 也要相應改:weights → 一般側、金額 → 一般側比例、ad_code → parentCode
      const finalPatch = splitWeights ? {
        ...patch,
        ad_code: splitCodes.parentCode,
        weights: splitWeights.normalInternal,
        amount_cny: normalCny,
        amount_orig: currency === "USDT" ? round2(amount_orig * generalRatio) : normalCny,
        amount_twd: normalTwd,
        daily_amort_twd: normalTwd / days,
        purchase_mode: (Object.keys(splitWeights.normalInternal).length === 1 && Object.values(splitWeights.normalInternal)[0] === 100) ? "independent" : "shared",
        code_at_creation: splitCodes.parentCode,
      } : { ...patch, code_at_creation: normalizedSingleCode };
      if (id) {
        const idx = st.ads.findIndex((x) => x.id === id);
        st.ads[idx] = { ...st.ads[idx], ...finalPatch };
        if (pairId) {
          st.ads[idx].split_pair_id = pairId;
          st.ads[idx].split_role = "parent";
        }
      } else {
        st.ads.push({
          id: newAdId,
          ...finalPatch,
          ...(pairId ? { split_pair_id: pairId, split_role: "parent" } : {}),
        });
        added_ad_ids.push(newAdId);
      }
      // 拆 t 時同時建破圈側 t-variant ad
      const appliedAd = id
        ? st.ads.find((x) => x.id === id) || finalPatch
        : { id: newAdId, ...finalPatch, ...(pairId ? { split_pair_id: pairId, split_role: "parent" } : {}) };
      if (splitWeights) {
        const tvAdId = uid("ad");
        const tvKeys = Object.keys(splitWeights.poquanInternal);
        const tvPurchaseMode = (tvKeys.length === 1 && splitWeights.poquanInternal[tvKeys[0]] === 100) ? "independent" : "shared";
        st.ads.push({
          id: tvAdId,
          ad_code: splitCodes.tVariantCode,
          ad_name: name,
          group: groupValue,
          currency,
          amount_orig: currency === "USDT" ? round2(amount_orig * poquanRatio) : poquanCny,
          currency_rate,
          amount_cny: poquanCny,
          exchange_rate: rate,
          amount_twd: poquanTwd,
          start_date: start,
          end_date: end,
          amortize_days: days,
          daily_amort_twd: poquanTwd / days,
          weights: { ...splitWeights.poquanInternal },
          purchase_mode: tvPurchaseMode,
          ad_copy: adCopy,
          contact_tg: contactTg,
          contact_info: contactInfo,
          short_url_type: shortUrlType,
          short_url_param: shortUrlParam,
          renewal_of: null,
          renewal_reason: "初始",
          notes: `自動拆 t 配對(由 ${splitCodes.parentCode} 觸發,新增當下偵測到同家族碰撞)`,
          lock_perf_adjust: false,
          lock_full: false,
          eliminated: false,
          split_pair_id: pairId,
          split_role: "t_variant",
          code_at_creation: splitCodes.tVariantCode,
        });
        added_ad_ids.push(tvAdId);
      }
      if (shouldCreateTodo) {
        const splitSummary = splitWeights
          ? Object.entries(splitWeights.poquan)
              .map(([pid, w]) => `${(st.products.find((p) => p.id === pid)?.name || pid)} ${w}%`)
              .join(" / ")
          : "";
        const yourlsAction = buildYourlsActionPayload({
          kind: id ? "update_weights" : "create_channel",
          ad: appliedAd,
          weights,
          products: st.products,
          actionType: id ? "手動改權重" : "新增廣告",
          effectiveDate: appliedAd.start_date,
          previousWeights: id ? origWeights : null,
        });
        st.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type: id ? "手動改權重" : "新增廣告",
          description: buildTodoDesc(appliedAd, splitWeights ? splitWeights.normal : weights, st.products, id ? origWeights : null, appliedAd.start_date)
            + (splitWeights ? `\n\n自動拆 t:建立 ${splitCodes.tVariantCode} ${poquanCny.toLocaleString()} RMB / ${splitSummary}` : ""),
          status: "pending",
          undo_payload: buildAdUndoPayload(st, ad_snapshots, added_ad_ids, [...(id ? [id] : []), ...added_ad_ids]),
          ...(yourlsAction ? { yourls_action: yourlsAction } : {}),
        });
      }
    });
    modal.close();
    const successMsg = splitWeights
      ? `已儲存 2 支廣告(${splitCodes.parentCode} + ${splitCodes.tVariantCode}),已自動拆 t 配對,已建立待辦`
      : (weightsChanged ? "已儲存,已建立待辦" : "已儲存");
    toast(successMsg, "ok");
  };
}

function renderPerfSection(ad, state) {
  // 配對成效：用 ad_code（最穩定）+ 該產品有權重；fallback 到 ad_name 以相容舊資料
  const records = (state.performance_data || [])
    .filter((r) =>
      ad.weights && Number(ad.weights[r.product_id]) > 0 &&
      (r.ad_code === ad.ad_code || r.ad_name === ad.ad_name)
    )
    .sort((a, b) => (a.product_id + a.period_end).localeCompare(b.product_id + b.period_end));

  if (records.length === 0) {
    return `
      <h3 class="mt-16">成效資料</h3>
      <div class="hint">尚無此廣告（以「廣告名稱 + 對應產品」比對）的成效資料。可到「成效報表」分頁按「📥 匯入本週成效」匯入。</div>
    `;
  }

  const nameOf = Object.fromEntries(state.products.map((p) => [p.id, p.name]));
  const targetsOf = Object.fromEntries(state.products.map((p) => [p.id, p.performance_targets || []]));
  const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString() : "—");
  const fmt2 = (n) => (Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString() : "—");

  const cards = records.map((r) => {
    const targets = targetsOf[r.product_id] || [];
    const tHtml = targets.length ? targets.map((t) => {
      let actual = null;
      try { actual = evalFormula(t.formula, r); } catch { actual = null; }
      if (actual == null) {
        return `<div class="perf-target">${esc(t.name)} <span class="ink-3">(${esc(t.formula)})</span>：<span class="ink-3">—</span> / 目標 ${fmt2(t.goal_value)}</div>`;
      }
      const met = t.direction === "lower_better" ? actual <= t.goal_value : actual >= t.goal_value;
      return `<div class="perf-target ${met ? "ok" : "bad"}">${esc(t.name)}：<strong>${fmt2(actual)}</strong> / 目標 ${fmt2(t.goal_value)} ${met ? "✓" : "✗"}</div>`;
    }).join("") : `<div class="hint">此產品尚無成效目標</div>`;

    return `
      <div class="perf-card">
        <div class="perf-card-head">
          <strong>${esc(nameOf[r.product_id] || r.product_id)}</strong>
          <span class="mono ink-3" style="font-size:12px">${r.period_start} ~ ${r.period_end}</span>
        </div>
        <div class="perf-metrics">
          <span>花費 <strong>${fmt(r["花費"])}</strong></span>
          <span>安裝 <strong>${fmt(r["不重複安裝數"])}</strong></span>
          <span>活躍 <strong>${fmt(r["不重複活躍用戶數"])}</strong></span>
          <span>首儲 <strong>${fmt(r["首儲訂單數"])}</strong></span>
          <span>加總購買金額 <strong>${fmt(r["加總購買金額"])}</strong></span>
        </div>
        <div class="perf-targets">${tHtml}</div>
      </div>
    `;
  }).join("");

  return `
    <h3 class="mt-16">成效資料 <span class="ink-3" style="font-size:12px;font-weight:400">（${records.length} 筆，依名稱+產品比對）</span></h3>
    <div class="perf-list">${cards}</div>
  `;
}

function weightsDiff(a, b) {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return true;
  for (const k of ak) if (Number(a[k]) !== Number(b[k])) return true;
  return false;
}

function formatTodoWeightSummary(weights, products) {
  const nameOf = (pid) => products.find((p) => p.id === pid)?.name || pid;
  return Object.entries(weights || {})
    .filter(([, w]) => Math.round(Number(w) || 0) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .map(([pid, w]) => `${nameOf(pid)} ${Math.round(Number(w) || 0)}%`)
    .join("、") || "（無）";
}

// 給待辦的描述：統一成「舊權重 → 新權重」摘要,讓待辦頁高亮新權重。
function buildTodoDesc(ad, weights, products, oldWeights = null, effectiveDate = "") {
  const prefix = formatTodoDate(effectiveDate || ad.start_date);
  const label = `${prefix ? `${prefix} ` : ""}${ad.ad_code} ${ad.ad_name}`;
  const newSummary = formatTodoWeightSummary(weights, products);
  if (oldWeights !== null) {
    return `${label}｜${formatTodoWeightSummary(oldWeights, products)} → ${newSummary}\n（請至隨機縮網址後台確認）`;
  }
  return `${label}｜${newSummary}\n（請至隨機縮網址後台確認）`;
}

function captureAppliedAdSnapshots(state, ids) {
  const seen = new Set();
  const snapshots = [];
  for (const id of ids || []) {
    const key = String(id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ad = state.ads.find((a) => String(a.id || "") === key);
    if (ad) snapshots.push(JSON.parse(JSON.stringify(ad)));
  }
  return snapshots;
}

function buildAdUndoPayload(state, adSnapshots, addedAdIds, appliedIds) {
  return {
    ad_snapshots: adSnapshots,
    added_ad_ids: addedAdIds,
    applied_ad_snapshots: captureAppliedAdSnapshots(state, appliedIds),
  };
}

function formatTodoDate(ymd) {
  const m = String(ymd || "").match(/^\d{4}-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${Number(m[1])}/${Number(m[2])}`;
}

// ── 生命週期動作：權重調整 ─────────────────────────────────────────
function openWeightAdjust(seg) {
  const s = getState();
  const today = todayTaipei();
  const defEff = today > seg.start_date && today < seg.end_date ? today : seg.start_date;
  const newWeights = { ...(seg.weights || {}) };

  const html = `
    <h2>權重調整：${esc(seg.ad_code)} ${esc(seg.ad_name)}</h2>
    <p class="ink-2" style="font-size:13px">原段 ${seg.start_date} ~ ${seg.end_date}，金額／攤提天數沿用，僅生效日後權重變動。</p>
    <div class="field"><label>生效日（新段起日）</label><input id="eff" type="date" value="${defEff}" min="${seg.start_date}" max="${seg.end_date}" /></div>

    <h3 class="mt-16">新權重</h3>
    <div id="weights"></div>
    <div class="weight-sum" id="weight-sum">合計：<span id="wsum-val">0</span>%</div>

    <div class="field mt-16">
      <label>備註（選填，例：成效改善後加 AV9）</label>
      <textarea id="f-notes" rows="2" style="width:100%;resize:vertical"></textarea>
    </div>

    <div class="modal-actions">
      <button id="cancel">取消</button>
      <button class="primary" id="save">套用</button>
    </div>
  `;
  const dlg = modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  const renderWeights = () => {
    q("#weights").innerHTML = s.products.map((p) => `
      <div class="weight-grid ad-weight-card ${Number(newWeights[p.id] || 0) > 0 ? "active" : ""}" style="--w:${Math.max(0, Math.min(100, Number(newWeights[p.id]) || 0))}">
        <div class="ad-weight-main">
          <span class="ad-weight-name">${esc(p.name)}</span>
          <span class="ad-weight-id mono">${esc(p.id)}</span>
        </div>
        <div class="ad-weight-control">
          <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${newWeights[p.id] ?? ""}" placeholder="0" />
          <span class="ad-weight-unit">%</span>
        </div>
        <div class="ad-weight-bar" aria-hidden="true"><span></span></div>
      </div>
    `).join("");
    q("#weights").querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) newWeights[inp.dataset.pid] = v;
        else delete newWeights[inp.dataset.pid];
        const card = inp.closest(".ad-weight-card");
        if (card) {
          const pct = Math.max(0, Math.min(100, Number(v) || 0));
          card.style.setProperty("--w", pct);
          card.classList.toggle("active", pct > 0);
        }
        recalcSum();
      };
    });
    recalcSum();
  };
  const recalcSum = () => {
    const sum = Object.values(newWeights).reduce((x, y) => x + Number(y || 0), 0);
    const sumEl = q("#weight-sum");
    sumEl.classList.toggle("ok", sum === 100);
    sumEl.classList.toggle("bad", sum !== 100 && sum > 0);
    sumEl.innerHTML = `合計：<span>${sum}</span>%`;
  };
  renderWeights();

  q("#cancel").onclick = () => modal.close();
  q("#save").onclick = async () => {
    const eff = q("#eff").value;
    if (!eff) { toast("請選生效日", "bad"); return; }
    if (Object.keys(newWeights).length === 0) { toast("至少一個產品權重 > 0", "bad"); return; }
    const weightSum = Object.values(newWeights).reduce((sum, v) => sum + (Number(v) || 0), 0);
    if (Math.abs(weightSum - 100) > 0.01) {
      toast(`權重合計 ${weightSum}% 必須 = 100%`, "bad");
      return;
    }
    const notes = q("#f-notes").value.trim();

    // 自動拆 t 偵測(§5.7.2):非 pair + 同家族碰撞 → 觸發拆 pair
    const collision = !seg.split_pair_id
      ? detectFamilyCollision(newWeights, s.products)
      : { collision: false };

    // 鎖定狀態 + 觸發自動拆 t → 跳確認框(§5.7.2)
    if (collision.collision && (seg.lock_perf_adjust || seg.lock_full)) {
      const lockLabel = seg.lock_full ? "🚫 禁止挪動" : "🔒 鎖權重";
      const ok = await confirmAsync({
        title: `${lockLabel} + 手動拆 t`,
        body: `此廣告為${lockLabel}狀態,您手動把權重改成「一般 + 破圈混合」,系統將自動建立 ${seg.ad_code.replace(/[tT]$/, "")}t 配對(分流到 t-variant)。確定嗎?`,
        details: [`生效日 ${eff}`, `家族碰撞:${collision.families.join(" / ")}`],
        okText: "確定拆分",
      });
      if (!ok) return;
    }

    // 找同 chain 的所有段(改名 + 標 split_pair_id 用)
    const sAll = getState();
    const sameChain = collectChainSegments(sAll.ads || [], seg);

    let result;
    try {
      result = buildWeightAdjustWithAutoSplit(
        sAll, seg, eff, newWeights, { notes, allSegsOfSource: sameChain }
      );
    } catch (e) { toast(e.message, "bad"); return; }

    update((st) => {
      const snapshotIds = result.mode === "split"
        ? [...new Set(result.snapshotIds || [seg.id])]
        : [seg.id];
      const ad_snapshots = captureUndoSnapshot(st, snapshotIds);
      const added_ad_ids = [];

      if (result.mode === "split") {
        // 非配對舊資料第一次拆 t 時,也要維持 canonical:
        // parent 只承載一般產品,t-variant 只承載破圈產品。
        const sourceIdx = st.ads.findIndex((a) => a.id === seg.id);
        if (sourceIdx >= 0 && result.sourceReplacement) {
          st.ads[sourceIdx] = { ...st.ads[sourceIdx], ...result.sourceReplacement };
        }
        for (const added of result.addedSegments || []) {
          st.ads.push(added);
          added_ad_ids.push(added.id);
        }
      } else {
        // 一般 / 已 in_pair 路徑
        const i = st.ads.findIndex((a) => a.id === seg.id);
        if (i >= 0) st.ads[i] = result.closed;
        st.ads.push(...result.segments);
        for (const ns of result.segments) added_ad_ids.push(ns.id);
        // 若 in_pair,對 linked 同步 rebalance
        if (result.mode === "in_pair") {
          for (const ns of result.segments) {
            const inAds = st.ads.find((a) => a.id === ns.id);
            const rebal = inAds ? rebalanceSplitPair(st, inAds) : null;
            if (rebal?.newLinkedSegId) added_ad_ids.push(rebal.newLinkedSegId);
          }
          // 邊界 case (effective == start_date):buildWeightAdjust 走 in-place,segments 為空,
          // 改的是 source 本身 → 對 source 直接 rebalance,讓配對另一側同步更新
          if (result.segments.length === 0) {
            const inAds = st.ads.find((a) => a.id === seg.id);
            const rebal = inAds ? rebalanceSplitPair(st, inAds) : null;
            if (rebal?.newLinkedSegId) added_ad_ids.push(rebal.newLinkedSegId);
          }
        }
      }

      const yourlsAction = buildYourlsActionPayload({
        kind: "update_weights",
        ad: seg,
        weights: newWeights,
        products: st.products,
        actionType: "手動改權重",
        effectiveDate: eff,
        previousWeights: seg.weights,
      });
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "手動改權重",
        description: buildTodoDesc(seg, newWeights, st.products, seg.weights, eff)
          + (result.mode === "split"
            ? `\n\n⚙️ 自動拆 t:${result.sourceRename.parentCode} + ${result.sourceRename.tVariantCode}(同家族碰撞觸發)`
            : ""),
        status: "pending",
        undo_payload: buildAdUndoPayload(st, ad_snapshots, added_ad_ids, [...snapshotIds, ...added_ad_ids]),
        ...(yourlsAction ? { yourls_action: yourlsAction } : {}),
      });
    });
    modal.close();
    toast(
      result.mode === "split"
        ? `已套用權重調整 + 自動拆 t(${result.sourceRename.parentCode} + ${result.sourceRename.tVariantCode})`
        : "已產生新段(權重調整),已建立待辦",
      "ok"
    );
  };
}

// 家族視角權重調整(§5.7.2):對 split_pair 的 parent + t-variant 一次編輯
// 使用者以「整體合約 %」視角填權重(加總 = 100,跨 parent + t-variant);
// 系統自動拆 normal/poquan、重算雙方 amount + 內部 weights(canonical form)。
function openFamilyWeightAdjust(pairId) {
  const s = getState();
  // 找出 pair 兩支廣告的最新段(latest by start_date)
  const pairAds = (s.ads || []).filter((a) => a.split_pair_id === pairId);
  if (pairAds.length === 0) { toast("找不到此配對", "bad"); return; }
  const byCode = new Map();
  for (const a of pairAds) {
    if (!byCode.has(a.ad_code)) byCode.set(a.ad_code, []);
    byCode.get(a.ad_code).push(a);
  }
  const latestOf = (segs) => latestFirst(segs)[0];
  const parentSeg = [...byCode.values()]
    .map((segs) => latestOf(segs))
    .find((seg) => seg.split_role === "parent");
  const tVariantSeg = [...byCode.values()]
    .map((segs) => latestOf(segs))
    .find((seg) => seg.split_role === "t_variant");
  if (!parentSeg || !tVariantSeg) { toast("配對結構不完整(找不到 parent 或 t-variant)", "bad"); return; }

  const parentAmt = Number(parentSeg.amount_cny) || 0;
  const tvAmt = Number(tVariantSeg.amount_cny) || 0;
  const totalAmt = parentAmt + tvAmt;
  if (totalAmt <= 0) { toast("合約總額為 0,無法調整", "bad"); return; }

  // 計算「整體合約視角」當前權重 = parent.weights × (parentAmt/total) + tvariant.weights × (tvAmt/total)
  // parent 內部 weights sum=100 對應 parentShare%;同理 t-variant
  const integralWeights = {};
  const parentShare = parentAmt / totalAmt;
  const tvShare = tvAmt / totalAmt;
  for (const [pid, w] of Object.entries(parentSeg.weights || {})) {
    integralWeights[pid] = (integralWeights[pid] || 0) + Number(w) * parentShare;
  }
  for (const [pid, w] of Object.entries(tVariantSeg.weights || {})) {
    integralWeights[pid] = (integralWeights[pid] || 0) + Number(w) * tvShare;
  }
  // 四捨五入到整數 %(largest-remainder 避免漂移)
  const roundedIntegral = (() => {
    const entries = Object.entries(integralWeights)
      .filter(([, v]) => v > 0)
      .map(([pid, v]) => ({ pid, val: v, floor: Math.floor(v), rem: v - Math.floor(v) }));
    if (entries.length === 0) return {};
    let assigned = entries.reduce((sum, e) => sum + e.floor, 0);
    let deficit = 100 - assigned;
    entries.sort((a, b) => b.rem - a.rem);
    for (let i = 0; i < entries.length && deficit > 0; i++) { entries[i].floor += 1; deficit--; }
    const out = {};
    for (const e of entries) if (e.floor > 0) out[e.pid] = e.floor;
    return out;
  })();

  const today = todayTaipei();
  const defEff = today > parentSeg.start_date && today < parentSeg.end_date ? today : parentSeg.start_date;
  const newWeights = { ...roundedIntegral };
  const isPoquanPid = (pid) => !!s.products.find((p) => p.id === pid)?.is_poquan;

  const html = `
    <h2>權重調整:${esc(parentSeg.ad_code)} / ${esc(tVariantSeg.ad_code)}</h2>
    <div class="field"><label>生效日</label><input id="eff" type="date" value="${defEff}" min="${parentSeg.start_date}" max="${parentSeg.end_date}" /></div>

    <h3 class="mt-16">各產品在整體合約的權重</h3>
    <div id="weights"></div>
    <div class="weight-sum" id="weight-sum">合計：<span id="wsum-val">0</span>%</div>

    <div id="fam-preview" class="ink-2" style="font-size:12px;padding:8px 10px;margin-top:8px;background:#f7f9fc;border-radius:6px"></div>

    <div class="field mt-16">
      <label>備註(選填)</label>
      <textarea id="f-notes" rows="2" style="width:100%;resize:vertical"></textarea>
    </div>

    <div class="modal-actions">
      <button id="cancel">取消</button>
      <button class="primary" id="save">套用</button>
    </div>
  `;
  const dlg = modal.open(html);
  const q = (sel) => dlg.querySelector(sel);

  const renderWeights = () => {
    q("#weights").innerHTML = s.products.map((p) => `
      <div class="weight-grid ad-weight-card ${Number(newWeights[p.id] || 0) > 0 ? "active" : ""}" style="--w:${Math.max(0, Math.min(100, Number(newWeights[p.id]) || 0))}">
        <div class="ad-weight-main">
          <span class="ad-weight-name">${esc(p.name)}${p.is_poquan ? ` <span class="ink-3" style="font-size:11px;font-weight:400">· 破圈</span>` : ""}</span>
          <span class="ad-weight-id mono">${esc(p.id)}</span>
        </div>
        <div class="ad-weight-control">
          <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${newWeights[p.id] ?? ""}" placeholder="0" />
          <span class="ad-weight-unit">%</span>
        </div>
        <div class="ad-weight-bar" aria-hidden="true"><span></span></div>
      </div>
    `).join("");
    q("#weights").querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) newWeights[inp.dataset.pid] = v;
        else delete newWeights[inp.dataset.pid];
        const card = inp.closest(".ad-weight-card");
        if (card) {
          const pct = Math.max(0, Math.min(100, Number(v) || 0));
          card.style.setProperty("--w", pct);
          card.classList.toggle("active", pct > 0);
        }
        recalcSum();
      };
    });
    recalcSum();
  };
  const recalcSum = () => {
    const sum = Object.values(newWeights).reduce((x, y) => x + Number(y || 0), 0);
    const sumEl = q("#weight-sum");
    const ok = Math.abs(sum - 100) < 0.01;
    sumEl.classList.toggle("ok", ok);
    sumEl.classList.toggle("bad", !ok && sum > 0);
    sumEl.innerHTML = `合計:<strong>${sum}</strong>%${ok ? " ✓" : ""}`;
    // 預覽:依當前 weights 算 parent / t-variant 結構
    let normalSum = 0, poquanSum = 0;
    for (const [pid, w] of Object.entries(newWeights)) {
      if (isPoquanPid(pid)) poquanSum += Number(w);
      else normalSum += Number(w);
    }
    const newParentAmt = Math.round(totalAmt * normalSum / 100);
    const newTvAmt = Math.round(totalAmt * poquanSum / 100);
    q("#fam-preview").innerHTML = `
      預覽結構:<br>
      <code>${esc(parentSeg.ad_code)}</code> 一般 ${normalSum}% · ${newParentAmt.toLocaleString()} RMB<br>
      <code>${esc(tVariantSeg.ad_code)}</code> 破圈 ${poquanSum}% · ${newTvAmt.toLocaleString()} RMB
    `;
  };
  renderWeights();

  q("#cancel").onclick = () => modal.close();
  q("#save").onclick = () => {
    const eff = q("#eff").value;
    if (!eff) { toast("請選生效日", "bad"); return; }
    const sum = Object.values(newWeights).reduce((x, y) => x + Number(y || 0), 0);
    if (Math.abs(sum - 100) > 0.01) { toast(`整體權重加總須 = 100%,目前 ${sum}%`, "bad"); return; }
    const notes = q("#f-notes").value.trim();

    // 拆 normal / poquan
    const normalW = {}, poquanW = {};
    for (const [pid, w] of Object.entries(newWeights)) {
      if (isPoquanPid(pid)) poquanW[pid] = Number(w);
      else normalW[pid] = Number(w);
    }
    const normalSum = Object.values(normalW).reduce((s, v) => s + v, 0);
    const poquanSum = Object.values(poquanW).reduce((s, v) => s + v, 0);

    // 重算雙方 amount + 內部 weights(canonical form,各側內部歸一到 100)。
    // 任一側為 0 時代表該側從生效日起結束,不是錯誤。
    const newParentAmount = Math.round(totalAmt * normalSum / 100 * 100) / 100;
    const newTvAmount = Math.round(totalAmt * poquanSum / 100 * 100) / 100;
    const newParentInternal = normalSum > 0 ? normalizeWeightsToTotal(normalW, 100) : {};
    const newTvInternal = poquanSum > 0 ? normalizeWeightsToTotal(poquanW, 100) : {};
    const remainsPair = normalSum > 0 && poquanSum > 0;

    if (eff < parentSeg.start_date || eff >= parentSeg.end_date) {
      toast(`生效日 ${eff} 必須落在 parent 段區間 (${parentSeg.start_date} ~ ${parentSeg.end_date}) 之間`, "bad");
      return;
    }
    if (eff < tVariantSeg.start_date || eff >= tVariantSeg.end_date) {
      toast(`生效日 ${eff} 必須落在 t-variant 段區間 (${tVariantSeg.start_date} ~ ${tVariantSeg.end_date}) 之間`, "bad");
      return;
    }

    update((st) => {
      const ad_snapshots = captureUndoSnapshot(st, [parentSeg.id, tVariantSeg.id]);
      const added_ad_ids = [];
      const rate = Number(parentSeg.exchange_rate) || Number(tVariantSeg.exchange_rate) || 1;
      const appendNote = (current, note) => {
        const cur = String(current || "").trim();
        return cur ? `${cur}\n${note}` : note;
      };
      const retireSeg = (live, note) => {
        if (!live) return;
        if (eff === live.start_date) {
          st.ads = st.ads.filter((a) => a.id !== live.id);
        } else {
          live.end_date = eff;
          live.notes = appendNote(live.notes, note);
        }
      };

      // parent 開新段
      const pIdx = st.ads.findIndex((a) => a.id === parentSeg.id);
      if (pIdx >= 0) {
        const liveParent = st.ads[pIdx];
        const parentPurchaseMode = (Object.keys(newParentInternal).length === 1 && Object.values(newParentInternal)[0] === 100)
          ? "independent" : "shared";
        const parentNote = notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整";
        if (normalSum <= 0) {
          retireSeg(liveParent, notes ? `${notes}(一般側歸 0,自動結束)` : "一般側歸 0,自動結束");
        } else if (eff === liveParent.start_date) {
          liveParent.amount_orig = liveParent.amount_orig != null && parentAmt > 0
            ? Math.round((liveParent.amount_orig / parentAmt) * newParentAmount * 100) / 100
            : newParentAmount;
          liveParent.amount_cny = newParentAmount;
          liveParent.amount_twd = newParentAmount * rate;
          liveParent.daily_amort_twd = (Number(liveParent.amortize_days) > 0)
            ? (newParentAmount * rate / liveParent.amortize_days) : 0;
          liveParent.purchase_mode = parentPurchaseMode;
          liveParent.weights = newParentInternal;
          if (!remainsPair) {
            delete liveParent.split_pair_id;
            delete liveParent.split_role;
          }
          liveParent.notes = appendNote(liveParent.notes, parentNote);
        } else {
          liveParent.end_date = eff;  // trim
          const pNew = {
            id: uid("ad"),
            ad_code: liveParent.ad_code,
            ad_name: liveParent.ad_name,
            group: liveParent.group || "",
            currency: liveParent.currency || "CNY",
            amount_orig: liveParent.amount_orig != null && parentAmt > 0
              ? Math.round((liveParent.amount_orig / parentAmt) * newParentAmount * 100) / 100
              : newParentAmount,
            currency_rate: liveParent.currency_rate || 1,
            amount_cny: newParentAmount,
            exchange_rate: liveParent.exchange_rate,
            amount_twd: newParentAmount * rate,
            start_date: eff,
            end_date: parentSeg.end_date,
            amortize_days: liveParent.amortize_days,
            daily_amort_twd: (Number(liveParent.amortize_days) > 0)
              ? (newParentAmount * rate / liveParent.amortize_days) : 0,
            purchase_mode: parentPurchaseMode,
            weights: newParentInternal,
            lock_perf_adjust: !!liveParent.lock_perf_adjust,
            lock_full: !!liveParent.lock_full,
            ad_copy: liveParent.ad_copy || "",
            contact_tg: liveParent.contact_tg || "",
            contact_info: liveParent.contact_info || "",
            short_url_type: liveParent.short_url_type || "",
            short_url_param: liveParent.short_url_param || "",
            short_url_old_override: liveParent.short_url_old_override || "",
            short_url_new_override: liveParent.short_url_new_override || "",
            short_url_old_prefix: liveParent.short_url_old_prefix || "",
            short_url_notified: !!liveParent.short_url_notified,
            eliminated: !!liveParent.eliminated,
            ...(remainsPair ? { split_pair_id: pairId, split_role: "parent" } : {}),
            code_at_creation: liveParent.ad_code,
            renewal_of: liveParent.id,
            renewal_reason: "權重調整",
            notes: notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整",
          };
          st.ads.push(pNew);
          added_ad_ids.push(pNew.id);
        }
      }

      // t-variant 開新段
      const tIdx = st.ads.findIndex((a) => a.id === tVariantSeg.id);
      if (tIdx >= 0) {
        const liveTv = st.ads[tIdx];
        const tvPurchaseMode = (Object.keys(newTvInternal).length === 1 && Object.values(newTvInternal)[0] === 100)
          ? "independent" : "shared";
        const tvNote = notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整";
        if (poquanSum <= 0) {
          retireSeg(liveTv, notes ? `${notes}(破圈側歸 0,自動結束)` : "破圈側歸 0,自動結束");
        } else if (eff === liveTv.start_date) {
          liveTv.amount_orig = liveTv.amount_orig != null && tvAmt > 0
            ? Math.round((liveTv.amount_orig / tvAmt) * newTvAmount * 100) / 100
            : newTvAmount;
          liveTv.amount_cny = newTvAmount;
          liveTv.amount_twd = newTvAmount * rate;
          liveTv.daily_amort_twd = (Number(liveTv.amortize_days) > 0)
            ? (newTvAmount * rate / liveTv.amortize_days) : 0;
          liveTv.purchase_mode = tvPurchaseMode;
          liveTv.weights = newTvInternal;
          if (!remainsPair) {
            delete liveTv.split_pair_id;
            delete liveTv.split_role;
          }
          liveTv.notes = appendNote(liveTv.notes, tvNote);
        } else {
          liveTv.end_date = eff;
          const tNew = {
            id: uid("ad"),
            ad_code: liveTv.ad_code,
            ad_name: liveTv.ad_name,
            group: liveTv.group || "",
            currency: liveTv.currency || "CNY",
            amount_orig: liveTv.amount_orig != null && tvAmt > 0
              ? Math.round((liveTv.amount_orig / tvAmt) * newTvAmount * 100) / 100
              : newTvAmount,
            currency_rate: liveTv.currency_rate || 1,
            amount_cny: newTvAmount,
            exchange_rate: liveTv.exchange_rate,
            amount_twd: newTvAmount * rate,
            start_date: eff,
            end_date: tVariantSeg.end_date,
            amortize_days: liveTv.amortize_days,
            daily_amort_twd: (Number(liveTv.amortize_days) > 0)
              ? (newTvAmount * rate / liveTv.amortize_days) : 0,
            purchase_mode: tvPurchaseMode,
            weights: newTvInternal,
            lock_perf_adjust: !!liveTv.lock_perf_adjust,
            lock_full: !!liveTv.lock_full,
            ad_copy: liveTv.ad_copy || "",
            contact_tg: liveTv.contact_tg || "",
            contact_info: liveTv.contact_info || "",
            short_url_type: liveTv.short_url_type || "",
            short_url_param: liveTv.short_url_param || "",
            short_url_old_override: liveTv.short_url_old_override || "",
            short_url_new_override: liveTv.short_url_new_override || "",
            short_url_old_prefix: liveTv.short_url_old_prefix || "",
            short_url_notified: !!liveTv.short_url_notified,
            eliminated: !!liveTv.eliminated,
            ...(remainsPair ? { split_pair_id: pairId, split_role: "t_variant" } : {}),
            code_at_creation: liveTv.ad_code,
            renewal_of: liveTv.id,
            renewal_reason: "權重調整",
            notes: notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整",
          };
          st.ads.push(tNew);
          added_ad_ids.push(tNew.id);
        }
      }

      const yourlsAction = buildYourlsActionPayload({
        kind: "update_weights",
        ad: parentSeg,
        weights: newWeights,
        products: st.products,
        actionType: "手動改權重",
        effectiveDate: eff,
        previousWeights: roundedIntegral,
      });
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "手動改權重",
        description: buildTodoDesc(parentSeg, newWeights, st.products, roundedIntegral, eff)
          + `\n（${parentSeg.ad_code} / ${tVariantSeg.ad_code} 整體視角調整）`,
        status: "pending",
        undo_payload: buildAdUndoPayload(st, ad_snapshots, added_ad_ids, [parentSeg.id, tVariantSeg.id, ...added_ad_ids]),
        ...(yourlsAction ? { yourls_action: yourlsAction } : {}),
      });
    });
    modal.close();
    toast(`已套用整體視角調整(${parentSeg.ad_code} + ${tVariantSeg.ad_code})`, "ok");
  };
}

// 取得「同一條 renewal chain」的所有段(往上 + 往下追 renewal_of)
function collectChainSegments(allAds, seedSeg) {
  if (!seedSeg) return [];
  const byId = new Map(allAds.map((a) => [a.id, a]));
  const visited = new Set();
  const out = [];
  // 往上爬
  let cur = seedSeg;
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    out.push(cur);
    cur = cur.renewal_of ? byId.get(cur.renewal_of) : null;
  }
  // 往下找(誰 renewal_of = 已收集的 id)
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of allAds) {
      if (visited.has(a.id)) continue;
      if (a.renewal_of && visited.has(a.renewal_of)) {
        visited.add(a.id);
        out.push(a);
        changed = true;
      }
    }
  }
  return out;
}


// 摺疊列上的 "⋯" 按鈕：展開更多動作(2026-05 重整,§5.7)
// 內含 續費 / 結束 / 鎖定狀態 / 淘汰;不再含「轉移到新代碼」與「拆出X分流」(後者已由自動拆 t 取代,§5.7.2)
function openMoreMenu(seg) {
  const lockState = seg.lock_full ? "full" : (seg.lock_perf_adjust ? "weight" : "free");
  const eliminated = !!seg.eliminated;
  const lockBtn = (id, icon, label, hint, isCurrent) => `
    <button data-pick="lock-${id}" ${isCurrent ? 'disabled style="opacity:0.4"' : ""}>
      ${icon} ${label}${isCurrent ? "（目前狀態）" : ""}
      <div class="ink-3" style="font-size:11px;font-weight:400;margin-top:2px">${hint}</div>
    </button>`;
  const html = `
    <h2>更多動作：${esc(seg.ad_code)} ${esc(seg.ad_name)}</h2>
    <p class="ink-2" style="font-size:13px">選擇要對此段執行的動作。</p>
    <div class="more-actions">
      <button data-pick="renew">續費(開新段)</button>
      <button data-pick="end" class="danger">結束(提前 end_date,不開新段)</button>
    </div>
    <h3 style="margin-top:16px;font-size:13px">🔒 自動建議的鎖定設定</h3>
    <p class="ink-3" style="font-size:11px;margin:0 0 8px">手動編輯權重永遠可用,這個設定只影響系統自動建議。</p>
    <div class="more-actions" style="display:flex;flex-direction:column;gap:6px">
      ${lockBtn("free",   "🔓", "自由",       "成效驅動 / 補空檔 都可動權重",            lockState === "free")}
      ${lockBtn("weight", "🔒", "鎖權重",     "權重比例不變,但仍可被建議「整桶搬到別產品」",  lockState === "weight")}
      ${lockBtn("full",   "🚫", "禁止挪動",   "完全不納入自動建議,成效爛只會建議淘汰",       lockState === "full")}
    </div>
    <div class="more-actions" style="margin-top:12px">
      <button data-pick="eliminate" ${eliminated ? "" : 'class="danger"'}>${eliminated ? "↺ 取消淘汰（恢復追蹤）" : "❌ 淘汰（不再通知）"}</button>
      <button data-pick="del" class="danger">刪除此段</button>
    </div>
    <div class="modal-actions"><button id="cancel">取消</button></div>
  `;
  const dlg = modal.open(html);
  dlg.querySelector("#cancel").onclick = () => modal.close();
  dlg.querySelectorAll("[data-pick]").forEach((b) => {
    b.onclick = async () => {
      const pick = b.dataset.pick;
      modal.close();
      if (pick === "renew") openRenewalWizard(seg.ad_code);
      else if (pick === "end") openEndAd(seg);
      else if (pick === "lock-free" || pick === "lock-weight" || pick === "lock-full") {
        const newState = pick.split("-")[1];
        const labels = { free: "自由", weight: "鎖權重", full: "禁止挪動" };
        update((st) => {
          const a = st.ads.find((x) => x.id === seg.id);
          if (!a) return;
          a.lock_perf_adjust = (newState === "weight" || newState === "full");
          a.lock_full = (newState === "full");
        }, `鎖定狀態: ${labels[newState]}`);
        toast(`已設為「${labels[newState]}」`, "ok");
      } else if (pick === "eliminate") {
        if (eliminated) {
          // 取消淘汰：清掉同代碼所有段的 eliminated
          update((st) => {
            st.ads.forEach((a) => { if (a.ad_code === seg.ad_code) a.eliminated = false; });
          }, "取消淘汰");
          toast("已恢復追蹤", "ok");
        } else {
          openEliminate(seg);
        }
      } else if (pick === "del") {
        const targets = deleteTargetsForSegment(getState().ads || [], seg);
        const isPairDelete = targets.length > 1;
        const ok = await confirmAsync({
          title: isPairDelete ? "刪除配對廣告段" : "刪除廣告段",
          body: isPairDelete
            ? `這是拆分廣告，會同時刪除同區間的 ${targets.length} 段。`
            : "確認刪除這一段？同代碼其他段不受影響。",
          details: deleteTargetDetails(targets),
          okText: "刪除", danger: true,
        });
        if (!ok) return;
        update((st) => { deleteAdSegments(st, seg); }, isPairDelete ? "刪除配對廣告段" : "刪除廣告段");
        toast("已刪除", "ok");
      }
    };
  });
}


// 兩日期之間天數(end - start,以日為單位)
function daysBetween(startStr, endStr) {
  if (!startStr || !endStr) return 0;
  const s = new Date(startStr + "T00:00:00Z");
  const e = new Date(endStr + "T00:00:00Z");
  return Math.round((e - s) / 86400000);
}
