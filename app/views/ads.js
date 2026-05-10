import { getState, update, uid } from "../state.js";
import { suggestWeights } from "../domain/suggest.js";
import { evalFormula } from "../lib/formula.js";
import { getExpenseRate, getUsdtToCnyRate } from "../schema.js";
import { expiringAds } from "../domain/alerts.js";
import { renderGiftDayInfo } from "./dashboard.js";
import { todayTaipei, nowTaipeiStamp, addDays } from "../lib/dates.js";
import { buildWeightAdjust } from "../domain/lifecycle.js";
import { normalizeForSearch, adMatchesQuery } from "../lib/search.js";
import { captureUndoSnapshot } from "../domain/undo.js";

// 模組級展開狀態（記住使用者點開的 ad_code，重渲染後不重置）
const expanded = new Set();
const expandedWeights = new Set();
// 模組級分頁（"all" 或 product.id）
let activeTab = "all";
// 模組級日期區間過濾（皆 inclusive 視覺意義，內部用 overlaps 比對）
// 預設 = 昨天(只看「截至昨天還活著」的廣告,避免已淘汰段湧出來);要看當月按「於當月」按鈕。
const _defaultFilterDay = addDays(todayTaipei(), -1);
let filterStart = _defaultFilterDay;  // YYYY-MM-DD
let filterEnd = _defaultFilterDay;    // YYYY-MM-DD
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

  const filtered = activeTab === "all"
    ? searchFiltered
    : searchFiltered.filter((a) => Number(a.weights?.[activeTab]) > 0);
  const groups = groupByCode(filtered);

  // 各 tab 的廣告數，當作 badge（套用日期 + 搜尋過濾後的數量）
  const counts = { all: groupByCode(searchFiltered).length };
  for (const p of s.products) {
    const adsForP = searchFiltered.filter((a) => Number(a.weights?.[p.id]) > 0);
    counts[p.id] = groupByCode(adsForP).length;
  }

  const expiring = expiringAds(s, 10);

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

    ${renderExpiringCard(expiring, s.products)}

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
            ${groups.length ? groups.map((g) => renderGroup(g, s.products)).join("") :
              `<tr><td colspan="9"><div class="empty">尚無廣告。點右上「＋ 新增廣告」開始</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bindHandlers(root, s);
}

// 即將到期清單（10 天內，已淘汰的不顯示）
// 每筆有兩個動作：續費（開新段）/ 淘汰（標 eliminated 跳過後續通知）
function renderExpiringCard(expiring, products) {
  if (!expiring || expiring.length === 0) return "";
  const nameOf = Object.fromEntries((products || []).map((p) => [p.id, p.name]));

  // 依「廣告名稱」分組（同名 = 同一支廣告）
  const byName = new Map();
  for (const { ad, daysLeft, poorPerf } of expiring) {
    const key = ad.ad_name || ad.ad_code;
    if (!byName.has(key)) {
      byName.set(key, {
        adName: ad.ad_name,
        latestAd: ad,           // 用於「續費」與「淘汰」的目標段
        codes: new Set(),
        productIds: new Set(),
        earliestEnd: ad.end_date,
        earliestDays: daysLeft,
        dailyTotal: 0,
        segments: 0,
        poorPerf: null,         // 同名只取一筆 poorPerf（最後出現的）
      });
    }
    const g = byName.get(key);
    g.codes.add(ad.ad_code);
    Object.entries(ad.weights || {}).forEach(([pid, w]) => { if (Number(w) > 0) g.productIds.add(pid); });
    if (ad.end_date < g.earliestEnd) {
      g.earliestEnd = ad.end_date;
      g.earliestDays = daysLeft;
      g.latestAd = ad;
    }
    g.dailyTotal += Number(ad.daily_amort_twd) || 0;
    g.segments += 1;
    if (poorPerf) g.poorPerf = poorPerf;  // 任一段判定全爛就保留
  }

  const grouped = [...byName.values()].sort((a, b) => {
    // 先排「成效全爛」優先（建議不續費的最該優先處理）
    if (!!a.poorPerf !== !!b.poorPerf) return a.poorPerf ? -1 : 1;
    return a.earliestDays - b.earliestDays;
  });

  return `
    <div class="card expiring-card">
      <div class="card-head">
        <h2>即將到期 <span class="ink-3" style="font-size:12px;font-weight:400">（10 天內，${grouped.length} 支廣告）</span></h2>
        <div class="ink-3" style="font-size:12px">每筆需做決定：續費（開新段繼續投）或淘汰（不再通知）；🚨 = 所有產品成效皆 < 30%，建議淘汰</div>
      </div>
      <div class="expiring-list">
        ${grouped.map((g) => {
          // 成效全爛 → 強制 bad（不論天數）
          const sev = g.poorPerf ? "bad" : g.earliestDays <= 3 ? "bad" : g.earliestDays <= 7 ? "warn" : "info";
          const productPills = [...g.productIds].map((pid) =>
            `<span class="pill">${esc(nameOf[pid] || pid)}</span>`).join(" ");
          const codeStr = [...g.codes].join(" / ");
          const poorBadge = g.poorPerf ? `<span class="pill" style="background:#fde3e3;color:var(--bad);font-weight:600" title="${esc(g.poorPerf.map((p) => `${p.productName} ${(p.ratio * 100).toFixed(0)}%`).join("、"))}">🚨 成效全爛</span>` : "";
          return `
            <div class="expiring-item alert-${sev}">
              <span class="expiring-days">${g.earliestDays} 天</span>
              <strong>${esc(g.adName)}</strong>
              ${poorBadge}
              <span class="expiring-products">${productPills}</span>
              <span class="ink-3" style="margin-left:auto;margin-right:8px">${esc(codeStr)} · ${g.earliestEnd}${g.segments > 1 ? ` · ${g.segments} 段` : ""} · 每日 ${Math.round(g.dailyTotal).toLocaleString()}</span>
              <button class="primary" data-exp-renew="${esc(g.latestAd.id)}">續費</button>
              <button data-exp-eliminate="${esc(g.latestAd.id)}" title="標記為到期不再投放，從清單移除">淘汰</button>
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

function renderGroup(group, products) {
  const { code, segs } = group;
  const latest = segs[segs.length - 1];
  const latestRmb = Number(latest.amount_cny) || 0;
  const isOpen = expanded.has(code);
  const weightsOpen = expandedWeights.has(code);
  const isMulti = segs.length > 1;
  const eliminated = segs.some((s) => s.eliminated);

  const headRow = `
    <tr class="group-head ${isOpen ? "open" : ""} ${eliminated ? "ad-eliminated" : ""}">
      <td class="toggle">${isMulti ? `<button class="icon-btn" data-toggle="${esc(code)}">${isOpen ? "▾" : "▸"}</button>` : ""}</td>
      <td class="code-cell mono">${esc(code)}</td>
      <td>
        <strong>${esc(latest.ad_name)}</strong>
        ${isMulti ? `<span class="seg-badge">${segs.length} 段</span>` : ""}
        ${eliminated ? `<span class="seg-badge" style="background:#fde3e3;color:var(--bad)">已淘汰</span>` : ""}
      </td>
      <td>${esc(latest.group || "—")}</td>
      <td class="num">${Math.round(latestRmb).toLocaleString()}</td>
      <td class="date-compact mono nowrap">${formatCompactDateRange(latest.start_date, latest.end_date)}</td>
      <td class="num">${Math.round(latest.daily_amort_twd || 0).toLocaleString()}</td>
      <td>${weightSummary(latest, products, "bar", { code, open: weightsOpen, allSegs: segs, filterStart, filterEnd })}</td>
      <td class="actions-cell right nowrap">
        ${actionButtons(latest, /*compact=*/true)}
      </td>
    </tr>
  `;

  const weightDetailRow = weightsOpen ? renderWeightDetailRow(latest, products, { allSegs: segs, filterStart, filterEnd }) : "";

  if (!isOpen || !isMulti) return headRow + weightDetailRow;

  // 展開時：用一列容納整個 vertical timeline
  return headRow + weightDetailRow + `
    <tr class="seg-timeline-row">
      <td></td>
      <td colspan="8">
        <div class="seg-timeline">
          ${segs.map((seg, i) => renderTimelineNode(seg, i, segs, products)).join("")}
        </div>
      </td>
    </tr>
  `;
}

function renderWeightDetailRow(seg, products, opts = {}) {
  const entries = opts.allSegs
    ? aggregateGroupWeights(opts.allSegs, products, { filterStart: opts.filterStart, filterEnd: opts.filterEnd })
    : productWeightEntries(seg, products);
  if (entries.length <= 3) return "";
  return `
    <tr class="weight-detail-row">
      <td></td>
      <td colspan="8">
        <div class="weight-detail-panel">
          <div class="weight-detail-title">完整權重產品</div>
          <div class="weight-detail-grid">
            ${entries.map(({ pid, name, weight }) => `
              <div class="weight-detail-item" style="--w-color:${productColor(pid)}">
                <span class="weight-dot"></span>
                <span class="weight-detail-name">${esc(name)}</span>
                <strong>${Math.round(weight)}%</strong>
              </div>
            `).join("")}
          </div>
        </div>
      </td>
    </tr>
  `;
}

function renderTimelineNode(seg, idx, segs, products) {
  const prev = idx > 0 ? segs[idx - 1] : null;
  const delta = prev ? segDelta(prev, seg, products) : "";
  const reasonCls = reasonClass(seg.renewal_reason);
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
          <span>${weightSummary(seg, products, "inline")}</span>
        </div>
        ${(seg.notes && !/^V2 /.test(seg.notes.trim())) ? `<div class="tl-notes ink-2" style="font-size:12px;margin-top:4px;padding:4px 8px;background:#f7f9fc;border-radius:4px">📝 ${esc(seg.notes)}</div>` : ""}
        <div class="tl-actions">
          ${actionButtons(seg, /*compact=*/false)}
        </div>
      </div>
    </div>
  `;
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
  const asOf = opts.filterEnd || opts.filterStart || today;

  const collect = (filterFn) => {
    const m = new Map();
    for (const seg of segs) {
      if (!filterFn(seg)) continue;
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

  // 主路徑:只看「以 asOf 為基準仍 active」的段(start_date <= asOf < end_date)
  let byPid = collect((seg) =>
    (!seg.end_date || seg.end_date > asOf) &&
    (!seg.start_date || seg.start_date <= asOf)
  );
  // fallback:整支廣告已結束 → 退回所有段 latest
  if (byPid.size === 0) byPid = collect(() => true);

  return [...byPid.entries()]
    .map(([pid, info]) => ({
      pid,
      name: products.find((p) => p.id === pid)?.name || pid,
      weight: info.weight,
    }))
    .sort((a, b) => b.weight - a.weight);
}

function weightSummary(seg, products, mode = "bar", opts = {}) {
  const entries = (mode === "bar" && opts.allSegs)
    ? aggregateGroupWeights(opts.allSegs, products, { filterStart: opts.filterStart, filterEnd: opts.filterEnd })
    : productWeightEntries(seg, products);
  if (entries.length === 0) return `<span class="ink-3">（無權重）</span>`;

  if (mode === "inline") {
    return entries.map(({ pid, name, weight }) => {
      return `<span class="pill" style="border-left:3px solid ${productColor(pid)};padding-left:6px">${esc(name)} ${Math.round(weight)}%</span>`;
    }).join(" ");
  }

  const TOP_N = 3;
  const top = entries.slice(0, TOP_N).map(({ pid, name, weight }, i) => {
    const pct = `${Math.round(weight)}%`;
    return `<span class="weight-top-item ${i === 0 ? "lead" : ""}" style="border-left:3px solid ${productColor(pid)};padding-left:6px">${esc(name)} ${pct}</span>`;
  }).join("<span class=\"sep\"> · </span>");
  const moreCount = entries.length - TOP_N;
  const moreButton = moreCount > 0
    ? `<button class="weight-more ${opts.open ? "active" : ""}" data-weight-toggle="${esc(opts.code || seg.ad_code)}" title="查看完整權重">+${moreCount} 個</button>`
    : "";
  return `<div class="weights-summary">${top}${moreButton}</div>`;
}

function actionButtons(seg, compact) {
  const id = seg.id;
  const lockIcon = seg.lock_perf_adjust
    ? `<span class="lock-icon" title="已鎖定不被成效自動調整">🔒</span>`
    : "";
  if (compact) {
    return `
      ${lockIcon}
      <button data-edit="${id}">編輯</button>
      <button data-renew="${id}">續費</button>
      <button data-act="more" data-id="${id}" title="更多動作">⋯</button>
    `;
  }
  return `
    ${lockIcon}
    <button data-edit="${id}">編輯</button>
    <button data-renew="${id}">續費</button>
    <button data-act="weight" data-id="${id}">權重</button>
    <button data-act="more" data-id="${id}" title="更多動作">⋯</button>
  `;
}

function bindHandlers(root, s) {
  root.querySelector("#btn-add").onclick = () => openEditor(null);

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
    const ym = s.settings.current_month;
    a = {
      ad_code: "", ad_name: "", group: "",
      amount_cny: 0, exchange_rate: getExpenseRate(s, ym),
      start_date: `${ym}-01`, end_date: "",
      amortize_days: 30,
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
  const renderWeights = () => {
    const host = q("#weights");
    host.innerHTML = s.products.map((p) => `
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
      };
    });
    recalcSum();
  };
  const recalcSum = () => {
    const sum = Object.values(weights).reduce((x, y) => x + Number(y || 0), 0);
    const sumEl = q("#weight-sum");
    sumEl.classList.toggle("ok", sum === 100);
    sumEl.classList.toggle("bad", sum > 100);
    sumEl.classList.toggle("warn", sum > 0 && sum < 100);
    let hint;
    if (sum === 0) hint = "（尚未填）";
    else if (sum === 100) hint = "✓ 共購 100%";
    else if (sum < 100) hint = `還需 ${100 - sum}% 才到 100`;
    else hint = `已超過 100%（${sum - 100}%）`;
    sumEl.innerHTML = `合計：<strong>${sum}%</strong> <span class="ink-3">${hint}</span>`;
  };

  ["f-cny","f-rate","f-days","f-start","f-end","f-amount-orig","f-cny-rate"].forEach((id2) => {
    const el = q("#"+id2);
    if (el) el.oninput = recalcDaily;
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
    const patch = {
      ad_code: code,
      ad_name: name,
      group: groupValue,
      currency,
      amount_orig,
      currency_rate,
      amount_cny: cny,
      exchange_rate: rate,
      amount_twd: twd,
      start_date: start,
      end_date: end,
      amortize_days: days,
      daily_amort_twd: twd / days,
      weights,
      purchase_mode: purchaseMode,
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
      if (id) {
        const idx = st.ads.findIndex((x) => x.id === id);
        st.ads[idx] = { ...st.ads[idx], ...patch };
      } else {
        st.ads.push({ id: newAdId, ...patch });
        added_ad_ids.push(newAdId);
      }
      if (shouldCreateTodo) {
        st.todos.push({
          id: uid("todo"),
          created_at: nowTaipeiStamp(),
          action_type: id ? "手動改權重" : "新增廣告",
          description: buildTodoDesc(patch, weights, st.products, id ? origWeights : null),
          status: "pending",
          undo_payload: { ad_snapshots, added_ad_ids },
        });
      }
    });
    modal.close();
    toast(weightsChanged ? "已儲存，已建立待辦" : "已儲存", "ok");
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
  q("#save").onclick = () => {
    const eff = q("#eff").value;
    if (!eff) { toast("請選生效日", "bad"); return; }
    if (Object.keys(newWeights).length === 0) { toast("至少一個產品權重 > 0", "bad"); return; }
    const notes = q("#f-notes").value.trim();
    let result;
    try { result = buildWeightAdjust(seg, eff, newWeights, notes); }
    catch (e) { toast(e.message, "bad"); return; }
    update((st) => {
      const ad_snapshots = captureUndoSnapshot(st, [seg.id]);
      const i = st.ads.findIndex((a) => a.id === seg.id);
      if (i >= 0) st.ads[i] = result.closed;
      st.ads.push(...result.segments);
      const added_ad_ids = result.segments.map((s) => s.id);
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "手動改權重",
        description: buildTodoDesc(seg, newWeights, st.products, seg.weights),
        status: "pending",
        undo_payload: { ad_snapshots, added_ad_ids },
      });
    });
    modal.close();
    toast("已產生新段（權重調整），已建立待辦", "ok");
  };
}


// 摺疊列上的 "⋯" 按鈕：展開更多動作
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
      <button data-pick="weight">權重調整</button>
    </div>
    <h3 style="margin-top:16px;font-size:13px">自動建議調整的鎖定設定</h3>
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
      if (pick === "weight") openWeightAdjust(seg);
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
