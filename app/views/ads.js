import { getState, update, uid } from "../state.js";
import { suggestWeights } from "../domain/suggest.js";
import { evalFormula } from "../lib/formula.js";
import { getExpenseRate, getUsdtToCnyRate } from "../schema.js";
import { expiringAds } from "../domain/alerts.js";
import { renderGiftDayInfo } from "./dashboard.js";
import { todayTaipei, nowTaipeiStamp, addDays } from "../lib/dates.js";
import { buildWeightAdjust, buildWeightAdjustWithAutoSplit } from "../domain/lifecycle.js";
import { rebalanceSplitPair } from "../domain/split-pair.js";
import { detectFamilyCollision, splitWeightsByFamily, deriveSplitCodes } from "../domain/auto-split.js";
import { normalizeForSearch, adMatchesQuery } from "../lib/search.js";
import { captureUndoSnapshot } from "../domain/undo.js";

// 模組級展開狀態（記住使用者點開的 ad_code，重渲染後不重置）
const expanded = new Set();
const expandedWeights = new Set();
// 模組級分頁（"all" 或 product.id）
let activeTab = "all";
// 模組級日期區間過濾（皆 inclusive 視覺意義，內部用 overlaps 比對）
// 預設 = 「昨天」一天:start = 昨天, end = 今天(exclusive,= 包含昨天當天有效的廣告)
function _defaultYesterdayRange() {
  const today = todayTaipei();              // "YYYY-MM-DD"
  const yesterday = addDays(today, -1);
  return { start: yesterday, end: today };  // [yesterday, today) — 半開區間 = 昨天一天
}
const _initialRange = _defaultYesterdayRange();
let filterStart = _initialRange.start;  // YYYY-MM-DD
let filterEnd = _initialRange.end;      // YYYY-MM-DD (今天,exclusive)
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

  // 停損：只顯示「起始日 >= 當月前 2 個月 1 日」的段（避免續費多年累積資料無限滾動）
  // 例：當月 2026-05 → 起始日 >= 2026-03-01 才顯示；未來續費（如 6 月）也會顯示
  const cutoffDate = monthCutoffDate(ym);
  const recentAds = s.ads.filter((a) => (a.start_date || "") >= cutoffDate);
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
      (!filterEnd || s.start_date < filterEnd) &&
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
      const latest = pool.slice().sort((a, b) =>
        (b.start_date || "").localeCompare(a.start_date || ""))[0];
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
      const latest = pool.slice().sort((a, b) =>
        (b.start_date || "").localeCompare(a.start_date || ""))[0];
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

  const expiring = expiringAds(s, 13);  // 14 天視窗 (0~13 天)

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
    ${hiddenOldCount > 0 ? `<div class="ink-3" style="font-size:11px;margin:-4px 0 8px 4px">僅顯示起始日 ≥ ${cutoffDate} 的段（隱藏 ${hiddenOldCount} 段歷史資料；停損僅前 2 個月起算）</div>` : ""}

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

// 即將到期清單（10 天內，已淘汰的不顯示）
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

// 每筆有兩個動作：續費（開新段）/ 淘汰（標 eliminated 跳過後續通知）
function renderExpiringCard(expiring, products, allAds) {
  if (!expiring || expiring.length === 0) return "";
  const nameOf = Object.fromEntries((products || []).map((p) => [p.id, p.name]));

  // 依「廣告名稱」分組（同名 = 同一支廣告）
  const byName = new Map();
  for (const { ad, daysLeft, poorPerf } of expiring) {
    const key = ad.ad_name || ad.ad_code;
    if (!byName.has(key)) {
      byName.set(key, {
        adName: ad.ad_name,
        latestAd: ad,
        codes: new Set(),
        productIds: new Set(),
        earliestEnd: ad.end_date,
        earliestDays: daysLeft,
        amountCny: 0,
        amountOrig: 0,
        currency: ad.currency || "CNY",
        segments: 0,
        poorPerf: null,
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
  }

  // 按剩餘天數排序(近到遠);成效全爛只當 badge 顯示,不影響順序。
  const grouped = [...byName.values()].sort((a, b) => a.earliestDays - b.earliestDays);

  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const fmtEnd = (ymd) => {
    if (!ymd) return "";
    const d = new Date(ymd + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };

  return `
    <div class="card expiring-card">
      <div class="card-head">
        <h2>即將到期 <span class="ink-3" style="font-size:12px;font-weight:400">（14 天內,${grouped.length} 支廣告）</span></h2>
        <div class="ink-3" style="font-size:12px">
          <span class="exp-legend exp-red"></span>本週(6 天內)到期 ·
          <span class="exp-legend exp-blue"></span>下週(7~13 天)到期 ·
          🚨 = 所有產品成效 < 30% 建議淘汰
        </div>
      </div>
      <div class="expiring-list">
        ${grouped.map((g) => {
          const isUrgent = g.earliestDays <= 6;
          const tone = isUrgent ? "exp-row-red" : "exp-row-blue";
          const productPills = [...g.productIds].map((pid) =>
            `<span class="pill exp-product-pill">${esc(nameOf[pid] || pid)}</span>`).join("");
          const codeStr = [...g.codes].join(" / ");
          const poorBadge = g.poorPerf
            ? `<span class="pill exp-perf-bad" title="${esc(g.poorPerf.map((p) => `${p.productName} ${(p.ratio * 100).toFixed(0)}%`).join("、"))}">🚨 成效全爛</span>`
            : "";
          const isUsdt = g.currency === "USDT";
          // 家族總額(若該 ad 有破圈/兄弟成員)— 用 carve-out / 兄弟合計 算總額,跟家族卡頭一致
          const famBase = familyBaseOf(g.latestAd.ad_code);
          const famAds = (allAds || []).filter((a) => familyBaseOf(a.ad_code) === famBase);
          const hasFamily = new Set(famAds.map((a) => a.ad_code)).size > 1;
          const famTotal = hasFamily ? computeFamilyTotal(allAds, famBase) : (isUsdt ? g.amountOrig : g.amountCny);
          const amountStr = isUsdt
            ? `${Math.round(famTotal).toLocaleString()} USDT`
            : `${Math.round(famTotal).toLocaleString()} RMB`;
          const amountTitle = hasFamily ? `家族(${famBase})總額` : "";
          return `
            <div class="expiring-item ${tone}">
              <span class="exp-days">${g.earliestDays}天</span>
              <span class="exp-end mono">${fmtEnd(g.earliestEnd)}</span>
              <span class="exp-code mono">${esc(codeStr)}</span>
              <strong class="exp-name">${esc(g.adName || "—")}</strong>
              ${poorBadge}
              <span class="exp-products">${productPills}</span>
              <span class="exp-amount mono"${amountTitle ? ` title="${esc(amountTitle)}"` : ""}>${amountStr}</span>
              <span class="exp-actions">
                <button class="primary" data-exp-renew="${esc(g.latestAd.id)}">續費</button>
                <button data-exp-eliminate="${esc(g.latestAd.id)}" title="標記為到期不再投放,從清單移除">淘汰</button>
              </span>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function groupByCode(ads) {
  const map = new Map();
  for (const a of ads) {
    if (!map.has(a.ad_code)) map.set(a.ad_code, []);
    map.get(a.ad_code).push(a);
  }
  // 段內依 start_date 排序；group 之間依「最早 start」排序穩定
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
        (!filterEnd || s.start_date < filterEnd) &&
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
        const last = g.segs[g.segs.length - 1];
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
  const baseName = generalMember.segs[generalMember.segs.length - 1].ad_name || "";
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
      const lastAmt = Number(m.segs[m.segs.length - 1].amount_cny) || 0;
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
  // 「最新一段」優先選 filter 內 active 的最新段(以 start_date 排序),
  // filter 內沒有 active 段才 fallback 取全段最新
  const inFilterForRender = (s) =>
    (!filterStart && !filterEnd) ||
    (s.start_date && s.end_date &&
      (!filterEnd || s.start_date < filterEnd) &&
      (!filterStart || s.end_date > filterStart));
  const inFilterSegs = segs.filter(inFilterForRender);
  const latest = inFilterSegs.length > 0
    ? inFilterSegs[inFilterSegs.length - 1]
    : segs[segs.length - 1];
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
      <td>${weightSummary(latest, products, "bar", { code, open: weightsOpen, allSegs: segs, filterStart, filterEnd, familyScale: opts.familyScale })}</td>
      <td class="actions-cell right nowrap">
        ${actionButtons(latest, /*compact=*/true)}
      </td>
    </tr>
  `;

  const weightDetailRow = weightsOpen ? renderWeightDetailRow(latest, products, { allSegs: segs, filterStart, filterEnd, familyScale: opts.familyScale }) : "";

  if (!isOpen) return headRow + weightDetailRow;

  // 展開時:即使單段也顯示 timeline node(讓備註 / 廣告文案 / 站長 / 短網址資訊有地方看)
  return headRow + weightDetailRow + `
    <tr class="seg-timeline-row">
      <td></td>
      <td colspan="8">
        <div class="seg-timeline">
          ${segs.map((seg, i) => renderTimelineNode(seg, i, segs, products, { familyScale: opts.familyScale })).join("")}
        </div>
      </td>
    </tr>
  `;
}

function renderWeightDetailRow(seg, products, opts = {}) {
  const rawEntries = opts.allSegs
    ? aggregateGroupWeights(opts.allSegs, products, { filterStart: opts.filterStart, filterEnd: opts.filterEnd })
    : productWeightEntries(seg, products);
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
  const prev = idx > 0 ? segs[idx - 1] : null;
  const delta = prev ? segDelta(prev, seg, products) : "";
  const reasonCls = reasonClass(seg.renewal_reason);
  // 廣告文案 / 站長 / 短網址 等資訊只在最新段(段落鏈的 latest)顯示 — 這些是「廣告層級」資料,
  // 多段都同步,顯示在最新段避免重複
  const isLatest = idx === segs.length - 1;
  const extraInfo = isLatest ? renderAdExtras(seg) : "";
  return `
    <div class="tl-node">
      <div class="tl-rail"></div>
      <div class="tl-dot ${reasonCls.includes("warn") ? "warn" : ""}"></div>
      <div class="tl-content">
        <div class="tl-title">
          <span class="${reasonCls}" style="font-size:11px">${esc(seg.renewal_reason || "—")}</span>
          <span class="mono ink-2" style="font-size:12px;margin-left:8px">#${idx + 1} ${seg.start_date} → ${seg.end_date}</span>
          ${delta ? `<span class="ink-3" style="font-size:11px;margin-left:8px">Δ ${esc(delta)}</span>` : ""}
        </div>
        <div class="tl-meta">
          <span>${seg.amortize_days} 天 @ ${seg.exchange_rate}</span>
          <span>${seg.currency === "USDT" ? `${Math.round(seg.amount_orig || 0).toLocaleString()} USDT × ${seg.currency_rate} = ${Math.round(seg.amount_cny || 0).toLocaleString()} RMB` : `${Math.round(seg.amount_cny || 0).toLocaleString()} RMB`}</span>
          <span>每日攤提 ${Math.round(seg.daily_amort_twd || 0).toLocaleString()}</span>
          <span>${weightSummary(seg, products, "inline", { familyScale: opts.familyScale })}</span>
        </div>
        ${(seg.notes && !/^V2 /.test(seg.notes.trim())) ? `<div class="tl-notes ink-2" style="font-size:12px;margin-top:4px;padding:4px 8px;background:#f7f9fc;border-radius:4px">📝 ${esc(seg.notes)}</div>` : ""}
        ${extraInfo}
        <div class="tl-actions">
          ${actionButtons(seg, /*compact=*/false)}
        </div>
      </div>
    </div>
  `;
}

// 廣告層級的附加資訊(只顯示廣告文案;站長 / 連結 / 縮網址參數移到「🔗 縮網址」頁集中管理)
function renderAdExtras(ad) {
  const items = [];
  if (ad.ad_copy) items.push(`<span><strong>文案:</strong> ${esc(ad.ad_copy)}</span>`);
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

// 整個 group 的權重彙總:對每個產品,取「以 asOf 為基準仍 active 的段」中最新一段的權重
// asOf = 濾器結束日 || 濾器開始日 || 今天。沒設濾器時用「今天」當基準。
// 解決兩個問題:
//   (a) INDEPENDENT 廣告同代碼多產品各自 100%,但只看 latest 段時其他產品看不到
//   (b) 已被移出的產品(舊段有,新段沒有)不該再出現
// fallback:若 asOf 完全沒命中任何段(整支廣告已結束),退回「整體 latest seg」避免空白
function aggregateGroupWeights(segs, products, opts = {}) {
  const today = todayTaipei();
  // asOf:過濾期間內的「今天」或期間最後一天,避免用 filterEnd(exclusive 次月 1 號)
  // 落在所有段之外造成主路徑都 fail
  let asOf = today;
  if (opts.filterEnd) {
    const fe = new Date(opts.filterEnd);
    fe.setUTCDate(fe.getUTCDate() - 1);
    const feInclusive = fe.toISOString().slice(0, 10);
    asOf = feInclusive < today ? feInclusive : today;
  } else if (opts.filterStart) {
    asOf = opts.filterStart > today ? opts.filterStart : today;
  }

  const collectFrom = (segList) => {
    const m = new Map();
    for (const seg of segList) {
      for (const [pid, w] of Object.entries(seg.weights || {})) {
        const wn = Number(w) || 0;
        if (wn <= 0) continue;
        const cur = m.get(pid);
        const sd = seg.start_date || "";
        if (!cur || sd >= cur.startDate) {
          m.set(pid, { weight: wn, startDate: sd });
        }
      }
    }
    return m;
  };

  // 主路徑:只取 asOf 那天 active 的段(理論上至多 1 段,因段不重疊)
  const activeSegs = segs.filter((seg) =>
    (!seg.end_date || seg.end_date > asOf) &&
    (!seg.start_date || seg.start_date <= asOf)
  );
  let byPid = collectFrom(activeSegs);
  // fallback:asOf 落在所有段之外(廣告已結束/未開始)→ 用「最後一段」單獨顯示
  if (byPid.size === 0) {
    const sorted = [...segs].sort((a, b) => (b.end_date || "").localeCompare(a.end_date || ""));
    const lastSeg = sorted[0];
    if (lastSeg) byPid = collectFrom([lastSeg]);
  }

  return [...byPid.entries()]
    .map(([pid, info]) => ({
      pid,
      name: products.find((p) => p.id === pid)?.name || pid,
      weight: info.weight,
    }))
    .sort((a, b) => b.weight - a.weight);
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

function weightSummary(seg, products, mode = "bar", opts = {}) {
  const rawEntries = (mode === "bar" && opts.allSegs)
    ? aggregateGroupWeights(opts.allSegs, products, { filterStart: opts.filterStart, filterEnd: opts.filterEnd })
    : productWeightEntries(seg, products);
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

  const TOP_N = 3;
  const top = entries.slice(0, TOP_N).map(({ pid, name, weight, rawWeight }, i) => {
    const pct = `${Math.round(weight)}%`;
    const tip = rawWeight !== undefined ? ` title="此 ad 內 ${Math.round(rawWeight)}%"` : "";
    return `<span class="weight-top-item ${i === 0 ? "lead" : ""}" style="border-left:3px solid ${productColor(pid)};padding-left:6px"${tip}>${esc(name)} ${pct}</span>`;
  }).join("<span class=\"sep\"> · </span>");
  const moreCount = entries.length - TOP_N;
  const moreButton = moreCount > 0
    ? `<button class="weight-more ${opts.open ? "active" : ""}" data-weight-toggle="${esc(opts.code || seg.ad_code)}" title="查看完整權重">+${moreCount} 個</button>`
    : "";
  return `<div class="weights-summary">${top}${moreButton}</div>`;
}

function actionButtons(seg, compact) {
  const id = seg.id;
  const lockIcon = seg.lock_full
    ? `<span class="lock-icon" title="🚫 禁止挪動">🚫</span>`
    : (seg.lock_perf_adjust
      ? `<span class="lock-icon" title="🔒 鎖權重">🔒</span>`
      : "");
  // 2026-05 按鈕 layout 重整(§5.7):[編輯][權重調整][⋯]
  // 在 split_pair 配對內的廣告 → 「權重調整」按鈕完全不顯示,改用家族列整體視角入口(§5.7.2)
  const weightBtn = seg.split_pair_id
    ? ""
    : `<button data-act="weight" data-id="${id}" title="權重調整">權重調整</button>`;
  return `
    ${lockIcon}
    <button data-edit="${id}">編輯</button>
    ${weightBtn}
    <button data-act="more" data-id="${id}" title="更多動作(續費 / 結束 / 鎖定 / 淘汰)">⋯</button>
  `;
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
    filterEnd = next;
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
      const ok = await confirmAsync({
        title: "刪除廣告段",
        body: `確認刪除這一段？同代碼其他段不受影響。`,
        details: [`${seg.ad_code} ${seg.ad_name}`, `${seg.start_date} ~ ${seg.end_date}`, `每日攤提 ${Math.round(seg.daily_amort_twd || 0).toLocaleString()} TWD`],
        okText: "刪除", danger: true,
      });
      if (!ok) return;
      update((st) => { st.ads = st.ads.filter((a) => a.id !== el.dataset.del); });
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
  root.querySelectorAll("[data-exp-renew]").forEach((el) => {
    el.onclick = () => openEditor(null, el.dataset.expRenew);
  });
  root.querySelectorAll("[data-exp-eliminate]").forEach((el) => {
    el.onclick = () => {
      const seg = s.ads.find((a) => a.id === el.dataset.expEliminate);
      if (seg) openEliminate(seg);
    };
  });
}

// 淘汰：標記為「不再投放、不再通知」。實際資料保留，只是不會再出現在到期清單與警告
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
        action_type: "手動",
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
    body: "標記為「到期不再投放」— 廣告資料保留供查詢，但會從即將到期清單與警告移除。可隨時取消淘汰恢復追蹤。",
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
      description: `${seg.ad_code} ${seg.ad_name}：到期不再續費，已從即將到期清單移除`,
      status: "pending",
      undo_payload: { ad_snapshots, added_ad_ids: [] },
    });
  }, "淘汰廣告");
  toast("已淘汰並建立待辦", "ok");
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

    <h3 class="mt-16" style="display:flex;justify-content:space-between;align-items:center">
      <span>權重分配</span>
      <button id="btn-suggest" style="font-size:12px;padding:4px 10px">🤖 依剩餘預算自動建議</button>
    </h3>
    <div id="suggest-reasons" class="suggest-reasons"></div>
    <div id="weights"></div>
    <div class="weight-sum" id="weight-sum">合計：<span id="wsum-val">0</span>%</div>

    ${!id && !renewFrom && s.products.some((p) => p.is_poquan) ? `
    <div class="hint mt-8" style="padding:8px 10px;background:#f0f7ff;border:1px solid #cfe1f5;border-radius:6px;font-size:12px;line-height:1.5">
      💡 若上方權重同時含「一般 + 破圈」,儲存時系統會自動建立 <code>stXXX</code> + <code>stXXXt</code> 兩支廣告並關聯。純破圈 / 跨產品不撞一般則維持單支不加 t(例 <code>stXXX 愛威奶破圈 100% → stXXX 健康破圈 100%</code>)。
    </div>
    ` : ""}

    <div class="field-row mt-16">
      <div class="field" style="flex:1">
        <label>廣告文案<span class="ink-3" style="font-size:11px;font-weight:400;margin-left:6px">(最多 10 字)</span></label>
        <input id="f-ad-copy" type="text" maxlength="10" value="${esc(a.ad_copy || "")}" placeholder="例:免費下載" />
        <div class="hint"><span id="ad-copy-count">${(a.ad_copy || "").length}</span> / 10</div>
      </div>
      <div class="field" style="flex:2">
        <label>站長聯繫資料(選填)</label>
        <input id="f-contact-info" type="text" value="${esc(a.contact_info || "")}" placeholder="例:微信 abc123、TG @xyz" />
      </div>
    </div>

    <div class="field-row">
      <div class="field" style="flex:1">
        <label>採用連結</label>
        <div class="radio-row" style="display:flex;gap:14px;padding-top:6px">
          ${["L1", "L3", "L5"].map((t) => {
            const lbl = t === "L1" ? "權重" : (t === "L3" ? "APK" : "小島");
            return `<label style="font-weight:400;font-size:13px;cursor:pointer">
              <input type="radio" name="f-short-url-type" value="${t}" ${(a.short_url_type === t) ? "checked" : ""} /> ${t}(${lbl})
            </label>`;
          }).join("")}
          <label style="font-weight:400;font-size:13px;cursor:pointer;color:var(--ink-3)">
            <input type="radio" name="f-short-url-type" value="" ${!a.short_url_type ? "checked" : ""} /> 不採用
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
      <div class="weight-grid">
        <div>${esc(p.name)} <span class="ink-3 mono" style="font-size:11px">${esc(p.id)}</span></div>
        <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${weights[p.id] ?? ""}" placeholder="0" />
      </div>
    `).join("");
    host.querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) weights[inp.dataset.pid] = v;
        else delete weights[inp.dataset.pid];
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
    const otherAds = id ? s.ads.filter((x) => x.id !== id) : s.ads;
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

    // 自動拆 t 偵測(只在新增 / 續費 / 編輯沒在 pair 內時觸發;§5.7.2)
    // detect 引用 auto-split.js
    const collision = (!id || !(s.ads.find((x) => x.id === id)?.split_pair_id))
      ? detectFamilyCollision(weights, s.products)
      : { collision: false };
    const splitWeights = collision.collision
      ? splitWeightsByFamily(weights, s.products)
      : null;
    const splitCodes = collision.collision
      ? deriveSplitCodes(code)
      : null;

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
    const contactInfo = (q("#f-contact-info").value || "").trim();
    const shortUrlTypeRadio = dlg.querySelector('input[name="f-short-url-type"]:checked');
    const shortUrlType = shortUrlTypeRadio ? shortUrlTypeRadio.value : "";
    const shortUrlParam = (q("#f-short-url-param").value || "").trim();

    const patch = {
      ad_code: code,
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
        weights: splitWeights.normal,
        amount_cny: normalCny,
        amount_orig: currency === "USDT" ? round2(amount_orig * generalRatio) : normalCny,
        amount_twd: normalTwd,
        daily_amort_twd: normalTwd / days,
        purchase_mode: (Object.keys(splitWeights.normal).length === 1 && Object.values(splitWeights.normal)[0] === 100) ? "independent" : "shared",
        code_at_creation: splitCodes.parentCode,
      } : { ...patch, code_at_creation: code };
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
      if (splitWeights) {
        const tvAdId = uid("ad");
        const tvKeys = Object.keys(splitWeights.poquan);
        const tvPurchaseMode = (tvKeys.length === 1 && splitWeights.poquan[tvKeys[0]] === 100) ? "independent" : "shared";
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
          weights: { ...splitWeights.poquan },
          purchase_mode: tvPurchaseMode,
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
        st.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type: id ? "手動改權重" : "新增廣告",
          description: buildTodoDesc(finalPatch, splitWeights ? splitWeights.normal : weights, st.products, id ? origWeights : null)
            + (splitWeights ? `\n\n自動拆 t:建立 ${splitCodes.tVariantCode} ${poquanCny.toLocaleString()} RMB / ${splitSummary}` : ""),
          status: "pending",
          undo_payload: { ad_snapshots, added_ad_ids },
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

// 給待辦的描述：列出 ad code + name + 權重變化（有 oldWeights 就顯示 old→new diff）
function buildTodoDesc(ad, weights, products, oldWeights = null) {
  const nameOf = (pid) => products.find((p) => p.id === pid)?.name || pid;

  if (!oldWeights || Object.keys(oldWeights).length === 0) {
    // 新增廣告 / 沒舊權重 → 直接列新權重
    const parts = Object.entries(weights)
      .filter(([, w]) => Math.round(Number(w) || 0) > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a))
      .map(([pid, w]) => `${nameOf(pid)} ${Math.round(Number(w) || 0)}%`)
      .join("、");
    return `${ad.ad_code} ${ad.ad_name}｜${parts}｜請至連結隨機縮網址後台調整權重`;
  }

  // 有舊權重 → 列出每個產品的 old→new；只顯示有變動的
  const allPids = new Set([...Object.keys(oldWeights), ...Object.keys(weights)]);
  const changes = [];
  for (const pid of allPids) {
    const oldW = Math.round(Number(oldWeights[pid]) || 0);
    const newW = Math.round(Number(weights[pid]) || 0);
    if (oldW === newW) continue;
    if (oldW === 0 && newW > 0) changes.push(`${nameOf(pid)} 新加 ${newW}%`);
    else if (newW === 0 && oldW > 0) changes.push(`${nameOf(pid)} 移除（原 ${oldW}%）`);
    else changes.push(`${nameOf(pid)} ${oldW}%→${newW}%`);
  }
  if (changes.length === 0) {
    // 權重沒變但仍呼叫（例如續費沿用權重）→ 列出維持的權重
    const parts = Object.entries(weights)
      .filter(([, w]) => Math.round(Number(w) || 0) > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a))
      .map(([pid, w]) => `${nameOf(pid)} ${Math.round(Number(w) || 0)}%（沿用）`)
      .join("、");
    return `${ad.ad_code} ${ad.ad_name}｜${parts}｜請至連結隨機縮網址後台調整權重`;
  }
  return `${ad.ad_code} ${ad.ad_name}｜權重變化：${changes.join("、")}｜請至連結隨機縮網址後台調整權重`;
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
      <div class="weight-grid">
        <div>${esc(p.name)} <span class="ink-3 mono" style="font-size:11px">${esc(p.id)}</span></div>
        <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${newWeights[p.id] ?? ""}" placeholder="0" />
      </div>
    `).join("");
    q("#weights").querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) newWeights[inp.dataset.pid] = v;
        else delete newWeights[inp.dataset.pid];
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
      const ad_snapshots = captureUndoSnapshot(st, [seg.id]);
      const added_ad_ids = [];

      if (result.mode === "split") {
        // 拆 t 流程:
        // 1) 把 source 同 chain 所有段改名 → tVariantCode + 補 split_pair_id/role + code_at_creation
        const renameTo = result.sourceRename.to;
        const fromCode = result.sourceRename.from;
        for (const oldSeg of result.segsToRename) {
          const live = st.ads.find((a) => a.id === oldSeg.id);
          if (!live) continue;
          if (!live.code_at_creation) live.code_at_creation = live.ad_code;
          live.ad_code = renameTo;
          live.split_pair_id = result.pairId;
          live.split_role = "t_variant";
        }
        // 2) 把 source 段(剛剛 trim 過的 closed 物件)寫回 state(已包含於 segsToRename,改名生效)
        //    closed 物件在 result.closed 中,但 segsToRename 已涵蓋
        // 3) push 破圈側新段 + 一般側新 ad
        st.ads.push(result.sourceNewSeg);
        added_ad_ids.push(result.sourceNewSeg.id);
        st.ads.push(result.newGeneralAd);
        added_ad_ids.push(result.newGeneralAd.id);
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
        }
      }

      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "手動改權重",
        description: buildTodoDesc(seg, newWeights, st.products, seg.weights)
          + (result.mode === "split"
            ? `\n\n⚙️ 自動拆 t:${result.sourceRename.from} → ${result.sourceRename.to}(同家族碰撞觸發)`
            : ""),
        status: "pending",
        undo_payload: { ad_snapshots, added_ad_ids },
      });
    });
    modal.close();
    toast(
      result.mode === "split"
        ? `已套用權重調整 + 自動拆 t(${result.sourceRename.from} → ${result.sourceRename.to})`
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
  const latestOf = (segs) =>
    segs.slice().sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""))[0];
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
      <div class="weight-grid">
        <div>${esc(p.name)} <span class="ink-3 mono" style="font-size:11px">${esc(p.id)}${p.is_poquan ? " · 破圈" : ""}</span></div>
        <input type="number" min="0" max="100" step="1" data-pid="${esc(p.id)}" value="${newWeights[p.id] ?? ""}" placeholder="0" />
      </div>
    `).join("");
    q("#weights").querySelectorAll("input[data-pid]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value === "" ? 0 : Number(inp.value);
        if (v > 0) newWeights[inp.dataset.pid] = v;
        else delete newWeights[inp.dataset.pid];
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

    // 邊角:一側 = 0%(全在另一側)→ 這超出本 modal 設計範圍,提示使用者用 per-ad
    if (normalSum === 0 || poquanSum === 0) {
      toast("整體權重全在一側時,請從 per-ad 編輯該支廣告(本 modal 用於 split pair 兩側都有權重的情境)", "bad");
      return;
    }

    // 重算雙方 amount + 內部 weights(canonical form,各側內部歸一到 100)
    const newParentAmount = Math.round(totalAmt * normalSum / 100 * 100) / 100;
    const newTvAmount = Math.round(totalAmt * poquanSum / 100 * 100) / 100;
    const normalize = (w, totalPct) => {
      const out = {};
      for (const [pid, v] of Object.entries(w)) out[pid] = Math.round(v / totalPct * 100);
      // largest-remainder fix 加總 = 100
      const sumOut = Object.values(out).reduce((s, v) => s + v, 0);
      if (sumOut !== 100 && Object.keys(out).length > 0) {
        const fixPid = Object.entries(w).sort((a, b) => Number(b[1]) - Number(a[1]))[0][0];
        out[fixPid] += (100 - sumOut);
      }
      return out;
    };
    const newParentInternal = normalize(normalW, normalSum);
    const newTvInternal = normalize(poquanW, poquanSum);

    if (eff <= parentSeg.start_date || eff >= parentSeg.end_date) {
      toast(`生效日 ${eff} 必須落在 parent 段區間 (${parentSeg.start_date} ~ ${parentSeg.end_date}) 之間`, "bad");
      return;
    }
    if (eff <= tVariantSeg.start_date || eff >= tVariantSeg.end_date) {
      toast(`生效日 ${eff} 必須落在 t-variant 段區間 (${tVariantSeg.start_date} ~ ${tVariantSeg.end_date}) 之間`, "bad");
      return;
    }

    update((st) => {
      const ad_snapshots = captureUndoSnapshot(st, [parentSeg.id, tVariantSeg.id]);
      const added_ad_ids = [];
      const rate = Number(parentSeg.exchange_rate) || Number(tVariantSeg.exchange_rate) || 1;

      // parent 開新段
      const pIdx = st.ads.findIndex((a) => a.id === parentSeg.id);
      if (pIdx >= 0) {
        const liveParent = st.ads[pIdx];
        liveParent.end_date = eff;  // trim
        const pNew = {
          id: uid("ad"),
          ad_code: liveParent.ad_code,
          ad_name: liveParent.ad_name,
          group: liveParent.group || "",
          currency: liveParent.currency || "CNY",
          amount_orig: liveParent.amount_orig != null
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
          purchase_mode: (Object.keys(newParentInternal).length === 1 && Object.values(newParentInternal)[0] === 100)
            ? "independent" : "shared",
          weights: newParentInternal,
          lock_perf_adjust: !!liveParent.lock_perf_adjust,
          lock_full: !!liveParent.lock_full,
          eliminated: !!liveParent.eliminated,
          split_pair_id: pairId,
          split_role: "parent",
          code_at_creation: liveParent.ad_code,
          renewal_of: liveParent.id,
          renewal_reason: "權重調整",
          notes: notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整",
        };
        st.ads.push(pNew);
        added_ad_ids.push(pNew.id);
      }

      // t-variant 開新段
      const tIdx = st.ads.findIndex((a) => a.id === tVariantSeg.id);
      if (tIdx >= 0) {
        const liveTv = st.ads[tIdx];
        liveTv.end_date = eff;
        const tNew = {
          id: uid("ad"),
          ad_code: liveTv.ad_code,
          ad_name: liveTv.ad_name,
          group: liveTv.group || "",
          currency: liveTv.currency || "CNY",
          amount_orig: liveTv.amount_orig != null
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
          purchase_mode: (Object.keys(newTvInternal).length === 1 && Object.values(newTvInternal)[0] === 100)
            ? "independent" : "shared",
          weights: newTvInternal,
          lock_perf_adjust: !!liveTv.lock_perf_adjust,
          lock_full: !!liveTv.lock_full,
          eliminated: !!liveTv.eliminated,
          split_pair_id: pairId,
          split_role: "t_variant",
          code_at_creation: liveTv.ad_code,
          renewal_of: liveTv.id,
          renewal_reason: "權重調整",
          notes: notes ? `${notes}(家族整體視角調整)` : "家族整體視角權重調整",
        };
        st.ads.push(tNew);
        added_ad_ids.push(tNew.id);
      }

      const nameOf = (pid) => st.products.find((p) => p.id === pid)?.name || pid;
      const desc = Object.entries(newWeights)
        .sort(([, a], [, b]) => Number(b) - Number(a))
        .map(([pid, w]) => `${nameOf(pid)} ${w}%`)
        .join("、");
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "手動改權重",
        description: `${parentSeg.ad_code} / ${tVariantSeg.ad_code} 整體視角調整｜${desc}｜請至連結後台調整權重`,
        status: "pending",
        undo_payload: { ad_snapshots, added_ad_ids },
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
      if (pick === "renew") openEditor(null, seg.id);
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
        const ok = await confirmAsync({
          title: "刪除廣告段",
          body: "確認刪除這一段？同代碼其他段不受影響。",
          details: [`${seg.ad_code} ${seg.ad_name}`, `${seg.start_date} ~ ${seg.end_date}`],
          okText: "刪除", danger: true,
        });
        if (!ok) return;
        update((st) => { st.ads = st.ads.filter((a) => a.id !== seg.id); });
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
