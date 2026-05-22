import { getState } from "../state.js";
import { bandFor, bandsForMonth, checkMonthlyTotal } from "../domain/budget.js";
import { monthlyTotals, dailySpendGrid, adContributionPerMonth, dailySpendForAd } from "../domain/spending.js";
import { daysOfMonth, daysInMonth, isInRange, todayTaipei } from "../lib/dates.js";
import { getMonthlyBudget, getDailyBudget, getBudgetSource, isNoBand, isNoBandPid, getReportVars, getTargetDailyBudget } from "../schema.js";
import { scoreRecord } from "../domain/perf-adjust.js";
import { expiringAds } from "../domain/alerts.js";
import { detectFutureGaps, detectShortfalls, detectAppMonthlyUnderspend } from "../domain/gift-days.js";
import { projectAdsWithRenewals, projectedDecisionState } from "../domain/renewal-projection.js";
import { openGiftDayFixModal } from "./gift-day-fix-modal.js";

// 概覽 KPI 群組:依 state.products 自動計算,不再 hardcode。規則:
//   - 非破圈的 APP 產品各自成一卡;若有 is_poquan=true 且 parent_product_id 指向它的破圈
//     子產品,顯示為「(含破圈)」並把子產品 pids 合進來
//   - 找不到母產品的破圈(parent_product_id 為空或指向不存在的產品)→ 單獨成卡
//   - 所有小島型產品集合為一張「小島(N 產品)」卡
function buildKpiGroups(state) {
  const products = state.products || [];
  const groups = [];
  const appParents = products.filter((p) => p.type === "app" && !p.is_poquan);
  for (const parent of appParents) {
    const children = products.filter((p) => p.is_poquan && p.parent_product_id === parent.id);
    const pids = [parent.id, ...children.map((c) => c.id)];
    const label = children.length > 0 ? `${parent.name}（含破圈）` : parent.name;
    groups.push({ id: parent.id, label, pids });
  }
  const orphanPoquan = products.filter((p) =>
    p.is_poquan && !appParents.find((ap) => ap.id === p.parent_product_id)
  );
  for (const orphan of orphanPoquan) {
    groups.push({ id: orphan.id, label: orphan.name, pids: [orphan.id] });
  }
  const islands = products.filter((p) => p.type === "island");
  if (islands.length > 0) {
    groups.push({
      id: "islands",
      label: `小島（${islands.length} 產品）`,
      pids: islands.map((p) => p.id),
    });
  }
  return groups;
}

// 模組級狀態：使用者選的概覽月份 + 詳細檢視選的產品 + 日期
let viewYm = null;
let detailPid = null;
let detailDate = null;
// 「產品 × 廣告分組」卡片視圖：'monthly'（月度摘要）/ 'daily'（每日摘要）
let groupView = "daily";
let dailyProjectionMode = "renewal";
// 每日攤提 grid 看哪個月:'current'(當月)/ 'next'(下月)
let dailyGridMonth = "current";
// 每日摘要選的產品（'all' = 全部產品合計；其他 = 特定產品 id）
let groupDailyPid = "all";

export function render(root) {
  const s = getState();
  // 第一次使用：沒廣告 → onboarding（用 settings.current_month）
  if (s.ads.length === 0) {
    root.innerHTML = renderOnboarding(s, s.settings.current_month);
    return;
  }

  // viewYm 預設 settings.current_month；使用者改後保留
  if (!viewYm) viewYm = s.settings.current_month;
  const ym = viewYm;

  const totals = monthlyTotals(s.ads, ym);

  // 詳細檢視預設值
  if (!detailPid || !s.products.find((p) => p.id === detailPid)) detailPid = s.products[0]?.id;
  if (!detailDate || detailDate < `${ym}-01` || detailDate >= `${nextMonthYm(ym)}-01`) {
    detailDate = todayStr() >= `${ym}-01` && todayStr() < `${nextMonthYm(ym)}-01` ? todayStr() : `${ym}-01`;
  }

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>
          <input type="month" id="view-ym" value="${ym}" class="view-ym-input" />
          概覽
        </h1>
        <div class="desc">選月份檢視該月攤提達成狀況；預設為設定中的當月。</div>
      </div>
      <div class="view-actions">
        <a class="btn" href="#ads">新增廣告 →</a>
      </div>
    </div>

    ${renderActionRequired(s)}

    ${renderKpiGroups(s, ym, totals)}

    ${renderGroupBreakdown(s, ym)}

    ${renderDailyGrid(s, ym)}

    <div class="card">
      <div class="card-head"><h2>產品預算</h2></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>產品</th>
              <th>類型</th>
              <th class="num">月預算</th>
              <th class="num">當月攤提</th>
              <th class="num">差額</th>
              <th>狀態</th>
              <th class="num">建議日花費</th>
            </tr>
          </thead>
          <tbody>
            ${s.products.map((p) => productRow(s, p, ym, totals[p.id] || 0)).join("")}
          </tbody>
        </table>
      </div>
    </div>

    ${renderDetailPanel(s, ym, detailPid, detailDate)}
  `;

  bindDetailHandlers(root);
}

const todayStr = todayTaipei;

function nextMonthYm(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function bindDetailHandlers(root) {
  const ymInput = root.querySelector("#view-ym");
  if (ymInput) ymInput.onchange = (e) => {
    const v = e.target.value;
    if (/^\d{4}-\d{2}$/.test(v)) {
      viewYm = v;
      detailDate = null;  // 月份切換時，詳細檢視日期一起重置
      render(root);
    }
  };

  const pidSel = root.querySelector("#detail-pid");
  const dateSel = root.querySelector("#detail-date");
  if (pidSel) pidSel.onchange = (e) => { detailPid = e.target.value; render(root); };
  if (dateSel) dateSel.onchange = (e) => { detailDate = e.target.value; render(root); };

  root.querySelectorAll("[data-quick-day]").forEach((el) => {
    el.onclick = () => { detailDate = el.dataset.quickDay; render(root); };
  });
  root.querySelectorAll("[data-quick-pid]").forEach((el) => {
    el.onclick = () => { detailPid = el.dataset.quickPid; render(root); };
  });

  // KPI 卡片點擊 → 切詳細檢視到該組第一個 pid，並捲到詳細面板
  root.querySelectorAll("[data-kpi-pid]").forEach((el) => {
    el.onclick = () => {
      const pid = el.dataset.kpiPid;
      if (!pid) return;
      detailPid = pid;
      render(root);
      // 等下一個 frame 找到面板再捲
      requestAnimationFrame(() => {
        const panel = root.querySelector(".detail-panel");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };
  });


  // 廣告調整建議 modal 觸發按鈕(三個位置:日花費低於下限、APP 月攤提少花、未採買空檔資訊卡)
  ["#gd-fix-open", "#gd-fix-open-2", "#gd-info-fix-open"].forEach((sel) => {
    const btn = root.querySelector(sel);
    if (btn) btn.onclick = () => openGiftDayFixModal(() => render(root));
  });

  // 產品 × 廣告分組視圖切換
  root.querySelectorAll("[data-group-view]").forEach((el) => {
    el.onclick = () => { groupView = el.dataset.groupView; render(root); };
  });
  // 每日摘要的產品分頁切換
  root.querySelectorAll("[data-group-pid]").forEach((el) => {
    el.onclick = () => { groupDailyPid = el.dataset.groupPid; render(root); };
  });
  root.querySelectorAll("[data-daily-mode]").forEach((el) => {
    el.onclick = () => { dailyProjectionMode = el.dataset.dailyMode; render(root); };
  });
  root.querySelectorAll("[data-daily-grid-month]").forEach((el) => {
    el.onclick = () => { dailyGridMonth = el.dataset.dailyGridMonth; render(root); };
  });
}

// 取某產品的「整體最新成效」— 對該產品每支廣告各取最新一筆 record，所有 metric 加總成單筆。
// 例如「破解吧」有 15 支廣告各自 4/12-4/25 一筆 record → 合併成「花費 = 全部加總、事件計數 = 全部加總」，
// CPC = 合計花費 / 合計事件計數（產品級指標，不是某支廣告的 CPC）。
// 回傳 null 代表該產品完全沒成效資料。
function aggregateProductRecord(state, pid) {
  const recs = (state.performance_data || []).filter((r) => r.product_id === pid);
  if (recs.length === 0) return null;
  // 對每支廣告取「最新 period_end」的那筆
  const byAd = new Map();
  for (const r of recs) {
    const key = r.ad_id || r.ad_code;
    if (!key) continue;
    const cur = byAd.get(key);
    if (!cur || (r.period_end || "").localeCompare(cur.period_end || "") > 0) byAd.set(key, r);
  }
  if (byAd.size === 0) return null;
  const list = [...byAd.values()];
  const aggregated = {
    ad_id: "_aggregated", product_id: pid,
    period_start: list.reduce((min, r) => (!min || (r.period_start && r.period_start < min)) ? r.period_start : min, null),
    period_end:   list.reduce((max, r) => (!max || (r.period_end   && r.period_end   > max)) ? r.period_end   : max, null),
  };
  for (const r of list) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === "number") aggregated[k] = (aggregated[k] || 0) + v;
    }
  }
  return aggregated;
}

// 計算某 group 的「最近一週成效達標」— 按「目標名稱」聚合 met/total，並記住每產品狀態。
// 每產品用「該產品所有廣告加總」的合計 record 算分（CPC = 合計花費 / 合計事件計數），
// 不是某單一廣告的數字。
function kpiPerfStats(state, pids) {
  const agg = new Map();
  for (const pid of pids) {
    const product = state.products.find((p) => p.id === pid);
    const targets = product?.performance_targets || [];
    if (targets.length === 0) continue;
    const aggregated = aggregateProductRecord(state, pid);
    if (!aggregated) {
      for (const t of targets) {
        if (!agg.has(t.name)) agg.set(t.name, { products: [], met: 0, total: 0, missing: 0 });
        const a = agg.get(t.name);
        a.products.push({ name: product.name, status: "missing", goal: t.goal_value, direction: t.direction });
        a.total += 1; a.missing += 1;
      }
      continue;
    }
    const score = scoreRecord(aggregated, targets, getReportVars(state));
    for (const d of score.details) {
      if (!agg.has(d.name)) agg.set(d.name, { products: [], met: 0, total: 0, missing: 0 });
      const a = agg.get(d.name);
      const status = d.actual == null ? "missing" : (d.met ? "met" : "miss");
      a.products.push({ name: product.name, status, actual: d.actual, goal: d.goal, direction: d.direction });
      a.total += 1;
      if (d.actual == null) a.missing += 1;
      else if (d.met) a.met += 1;
    }
  }
  const byName = [...agg.entries()].map(([name, v]) => ({ name, ...v }));
  if (byName.length === 0) return null;
  const totalMet = byName.reduce((s, x) => s + x.met, 0);
  const totalTotal = byName.reduce((s, x) => s + x.total, 0);
  return { byName, totalMet, totalTotal };
}

// ============ 決策優先區（Top）============
// 把「需要採取行動」的訊號集中:即將到期(含成效全爛)+ 即將上架 + 任一產品日花費低於下限 + APP 月攤提少花 > 6 萬。
// 沒事時整個區塊不渲染。
function renderActionRequired(state) {
  const today = todayStr();
  const expiring = expiringAds(state, 13);  // 14 天視窗
  const upcoming = upcomingAds(state, 10);
  // detect 用 projection state:預設「成效還行的廣告會續費」、「全爛廣告」視同預設淘汰
  const decisionState = projectedDecisionState(state);
  const shortfalls = detectShortfalls(decisionState, today);
  const underspends = detectAppMonthlyUnderspend(decisionState, today);
  const gaps = detectFutureGaps(decisionState, today);
  if (expiring.length === 0 && upcoming.length === 0 && shortfalls.length === 0 && underspends.length === 0 && gaps.length === 0) return "";

  // 即將到期：按剩餘天數排序(近到遠);同名廣告去重(同 ads 頁邏輯)。
  // 成效全爛只當作 badge 顯示,不影響排序順序。
  const byName = new Map();
  for (const { ad, daysLeft, poorPerf } of expiring) {
    const key = ad.ad_name || ad.ad_code;
    if (!byName.has(key)) {
      byName.set(key, { adName: ad.ad_name, latestAd: ad, codes: new Set(), earliestEnd: ad.end_date, earliestDays: daysLeft, poorPerf: null });
    }
    const g = byName.get(key);
    g.codes.add(ad.ad_code);
    if (ad.end_date < g.latestAd.end_date) {
      g.latestAd = ad;
      g.earliestEnd = ad.end_date;
      g.earliestDays = daysLeft;
    }
    if (poorPerf) g.poorPerf = poorPerf;
  }
  const expGroups = [...byName.values()].sort((a, b) => a.earliestDays - b.earliestDays);

  const WD = ["日", "一", "二", "三", "四", "五", "六"];
  const fmtEnd = (ymd) => {
    if (!ymd) return "";
    const d = new Date(ymd + "T00:00:00");
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  };

  const renderExpItem = (g) => {
    const tone = g.earliestDays <= 6 ? "exp-row-red" : "exp-row-blue";
    const poorBadge = g.poorPerf
      ? `<span class="pill exp-perf-bad" title="${escape(g.poorPerf.map((p) => `${p.productName} ${(p.ratio * 100).toFixed(0)}%`).join("、"))}">🚨 成效全爛</span>`
      : "";
    return `<div class="expiring-item ${tone}">
      <span class="exp-days">${g.earliestDays}天</span>
      <span class="exp-end mono">${fmtEnd(g.earliestEnd)}</span>
      <span class="exp-code mono">${[...g.codes].join("/")}</span>
      <strong class="exp-name">${escape(g.adName || "—")}</strong>
      ${poorBadge}
    </div>`;
  };
  const reds = expGroups.filter((g) => g.earliestDays <= 6);
  const blues = expGroups.filter((g) => g.earliestDays > 6);
  const expiringHtml = expGroups.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>📅 即將到期 (${expGroups.length} 支)</strong>
        <a class="ar-link" href="#ads">→ 廣告頁處理</a>
      </div>
      <div class="expiring-split" style="margin-top:6px">
        <div class="expiring-list">
          ${reds.length > 0
            ? reds.map(renderExpItem).join("")
            : `<div class="ink-3" style="font-size:12px;padding:8px">本週(6 天內)無到期</div>`}
        </div>
        <div class="expiring-list">
          ${blues.length > 0
            ? blues.map(renderExpItem).join("")
            : `<div class="ink-3" style="font-size:12px;padding:8px">下週(7~13 天)無到期</div>`}
        </div>
      </div>
    </div>
  `;

  const upcomingHtml = upcoming.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>🚀 即將上架 (${upcoming.length} 支)</strong>
        <a class="ar-link" href="#ads">→ 廣告頁查看</a>
      </div>
      <ul class="ar-list">
        ${upcoming.slice(0, 8).map((u) => {
          const sev = u.daysToStart <= 3 ? "warn" : "info";
          const md = u.ad.start_date.slice(5).replace("-", "/");
          const kind = upcomingAdKind(u.ad, state.ads);
          const verb = kind.id === "weight" ? "生效" : "上架";
          const note = kind.id === "weight" ? "請至連結後台調整權重"
            : kind.id === "gift" ? "上一段結束後有空檔,確認站長那邊的安排"
            : "注意聯繫站長、確認花費";
          return `<li class="ar-item ar-${sev}">
            <span class="ar-days">${u.daysToStart} 天後</span>
            <span>
              <span class="pill ${kind.cls}" style="font-size:10px;margin-right:4px">${kind.label}</span>
              廣告 <strong>${escape(u.ad.ad_name || u.ad.ad_code)}</strong>
              <span class="ink-3 mono" style="font-size:11px">${escape(u.ad.ad_code)}</span>
              即將在 <strong>${md}</strong> ${verb}，${note}
            </span>
          </li>`;
        }).join("")}
        ${upcoming.length > 8 ? `<li class="ink-3" style="font-size:12px">…還有 ${upcoming.length - 8} 支</li>` : ""}
      </ul>
    </div>
  `;

  // 日花費低於下限警示(任何成因 — 未採買空檔、月初分配偏低、其他廣告到期未續等)
  const shortfallHtml = shortfalls.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>⚠️ 產品日花費低於下限 (${shortfalls.length} 個產品)</strong>
        <button class="ar-link" id="gd-fix-open" style="background:none;border:0;color:var(--accent);cursor:pointer;text-decoration:underline">→ 一鍵調整</button>
      </div>
      <ul class="ar-list">
        ${shortfalls.slice(0, 5).map((sf) => {
          const totalK = Math.round(sf.totalShortfall / 1000);
          const days = sf.days.length;
          const typeBadge = sf.productType === "island"
            ? `<span class="pill bad" style="font-size:10px;margin-left:4px">小島</span>`
            : `<span class="pill warn" style="font-size:10px;margin-left:4px">APP</span>`;
          const sev = sf.productType === "island" ? "bad" : "warn";
          return `<li class="ar-item ar-${sev}">
            <span><strong>${escape(sf.productName)}</strong>${typeBadge} 未來 ${days} 天合計缺 <strong>${totalK}k</strong> TWD</span>
          </li>`;
        }).join("")}
        ${shortfalls.length > 5 ? `<li class="ink-3" style="font-size:12px">…還有 ${shortfalls.length - 5} 個</li>` : ""}
      </ul>
    </div>
  `;

  // APP 月攤提少花 > 6 萬警示
  const underspendHtml = underspends.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>💰 APP 月攤提少花 > 6 萬 (${underspends.length} 個產品)</strong>
        <button class="ar-link" id="gd-fix-open-2" style="background:none;border:0;color:var(--accent);cursor:pointer;text-decoration:underline">→ 一鍵調整</button>
      </div>
      <ul class="ar-list">
        ${underspends.slice(0, 5).map((u) => {
          const k = Math.round(u.underspend / 1000);
          return `<li class="ar-item ar-warn">
            <span><strong>${escape(u.productName)}</strong> 預估月攤提 ${Math.round(u.monthlyTotal).toLocaleString()} / 預算 ${Math.round(u.budget).toLocaleString()},少花 <strong>${k}k</strong> TWD</span>
          </li>`;
        }).join("")}
        ${underspends.length > 5 ? `<li class="ink-3" style="font-size:12px">…還有 ${underspends.length - 5} 個</li>` : ""}
      </ul>
    </div>
  `;

  // 📅 未採買空檔(原獨立卡片,合併進此區)
  const md = (s) => s.slice(5).replace("-", "/");
  const gapsHtml = gaps.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>📍 廣告送天數 (${gaps.length} 段)</strong>
        ${shortfalls.length > 0
          ? `<button class="ar-link" id="gd-info-fix-open" style="background:none;border:0;color:var(--accent);cursor:pointer;text-decoration:underline">→ 一鍵調整</button>`
          : `<span class="ink-3" style="font-size:12px">無需調整</span>`}
      </div>
      <ul class="ar-list">
        ${gaps.slice(0, 5).map((g) => {
          const lastDay = prevDayStr(g.gapEnd);
          const pidNames = [...g.affectedPids].map((pid) =>
            state.products.find((p) => p.id === pid)?.name || pid
          ).join("、");
          return `<li class="ar-item ar-info">
            <span><strong>${escape(g.adName || g.adCode)}</strong> <span class="ink-3 mono" style="font-size:11px">${escape(g.adCode)}</span> ${md(g.gapStart)}~${md(lastDay)} (${g.gapDays} 天) 影響: ${escape(pidNames)}</span>
          </li>`;
        }).join("")}
        ${gaps.length > 5 ? `<li class="ink-3" style="font-size:12px">…還有 ${gaps.length - 5} 段</li>` : ""}
      </ul>
    </div>
  `;

  return `
    <div class="card ar-card">
      <div class="card-head">
        <h2>🔥 需要決策</h2>
        <div class="ink-3" style="font-size:12px">沒事時這區會自動隱藏</div>
      </div>
      ${expiringHtml}
      ${upcomingHtml}
      ${shortfallHtml}
      ${underspendHtml}
      ${gapsHtml}
    </div>
  `;
}

// 「📅 未來未採買空檔」資訊卡(CLAUDE.md §5.8.1)
// 顯示所有未來空檔純資訊,不論有沒有造成日花費低於下限。
// 「未採買空檔」涵蓋:廠商送天數造成的、到期沒續費後再採買造成的、其他原因兩段間 gap 的。
// opts.withFixButton:是否顯示「→ 一鍵調整」按鈕(預設 true)
//   - dashboard / perf-adjust:true(可直接調整)
//   - 廣告列表:false(只通知,使用者自行到權重調整頁處理)
export function renderGiftDayInfo(state, opts = {}) {
  const { withFixButton = true } = opts;
  const today = todayTaipei();
  const decisionState = projectedDecisionState(state);
  const gaps = detectFutureGaps(decisionState, today);
  if (gaps.length === 0) return "";
  const md = (s) => s.slice(5).replace("-", "/");
  const items = gaps.slice(0, 12).map((g) => {
    const lastDay = prevDayStr(g.gapEnd);
    const pidNames = [...g.affectedPids].map((pid) =>
      state.products.find((p) => p.id === pid)?.name || pid
    ).join("、");
    return `<li class="gift-day-item">
      <span class="gift-day-icon">📅</span>
      <strong>${escape(g.adName || g.adCode)}</strong>
      <span class="ink-3 mono" style="font-size:11px">${escape(g.adCode)}</span>
      <span class="ink-2">${md(g.gapStart)}~${md(lastDay)}(${g.gapDays} 天)未採買</span>
      <span class="ink-3" style="font-size:11px">影響:${escape(pidNames)}</span>
    </li>`;
  }).join("");
  const hasShortfall = detectShortfalls(decisionState, today).length > 0;
  let actionHtml;
  if (!withFixButton) {
    actionHtml = hasShortfall
      ? `<a class="ink-3" style="font-size:12px;text-decoration:underline" href="#perf-adjust">→ 有產品日花費低於下限,可到「權重調整」頁一鍵調整</a>`
      : `<span class="ink-3" style="font-size:12px">沒造成日花費低於下限,無需調整</span>`;
  } else {
    actionHtml = hasShortfall
      ? `<button class="primary" id="gd-info-fix-open">→ 有產品日花費低於下限,一鍵調整</button>`
      : `<span class="ink-3" style="font-size:12px">沒造成日花費低於下限,無需調整</span>`;
  }
  return `
    <div class="card gift-day-card">
      <div class="card-head">
        <h2>📍 廣告送天數 <span class="ink-3" style="font-size:12px;font-weight:400">(${gaps.length} 段)</span></h2>
        ${actionHtml}
      </div>
      <ul class="gift-day-list">${items}${gaps.length > 12 ? `<li class="ink-3" style="font-size:12px">…還有 ${gaps.length - 12} 段</li>` : ""}</ul>
    </div>
  `;
}

// helper: gapEnd 是 exclusive,顯示時要往前一天
function prevDayStr(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// 列出 N 天內 start_date 將到（仍未開始）的廣告（給概覽「即將上架」用）
// 規則：start_date > today 且 start_date <= today+N；以 ad_code 去重，取最早 start_date 那段。
function upcomingAds(state, days = 10) {
  const today = todayStr();
  const horizon = (() => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  })();
  const earliestByCode = new Map();
  for (const a of state.ads) {
    if (a.eliminated) continue;
    // start_date == today 也算「即將上架」(仍未跑、需要關注),只排除過去日
    if (!a.start_date || a.start_date < today || a.start_date > horizon) continue;
    const cur = earliestByCode.get(a.ad_code);
    if (!cur || a.start_date < cur.start_date) earliestByCode.set(a.ad_code, a);
  }
  const out = [];
  for (const a of earliestByCode.values()) {
    out.push({
      ad: a,
      daysToStart: Math.max(0, Math.round((Date.parse(a.start_date) - Date.parse(today)) / 86400000)),
    });
  }
  return out.sort((a, b) => a.daysToStart - b.daysToStart);
}

function upcomingAdKind(ad, allAds = []) {
  // 1. 明確標 renewal_reason 的優先(權重調整 / 拆t改名 等)
  if ((ad.renewal_reason || "") === "權重調整") return { id: "weight", label: "改權重", cls: "warn" };
  if ((ad.renewal_reason || "") === "拆t改名") return { id: "split", label: "拆 t", cls: "warn" };

  if (ad.renewal_of) {
    // 從 ad.renewal_of 找上一段,比對權重 + 日期 gap
    const prev = allAds.find((x) => x.id === ad.renewal_of);
    if (prev) {
      // (a) 權重不一樣 → 「改權重」(覆蓋 renewal_reason='續費' 的舊資料)
      if (weightsDifferent(prev.weights, ad.weights)) {
        return { id: "weight", label: "改權重", cls: "warn" };
      }
      // (b) 兩段中間有空檔(新段 start > 上段 end)→ 「送天數」
      if (prev.end_date && ad.start_date && ad.start_date > prev.end_date) {
        return { id: "gift", label: "送天數", cls: "warn" };
      }
    }
    return { id: "renew", label: ad.renewal_reason || "續費", cls: "" };
  }

  return { id: "new", label: "新上廣告", cls: "ok" };
}

function weightsDifferent(a, b) {
  const wa = a || {}, wb = b || {};
  const keys = new Set([...Object.keys(wa), ...Object.keys(wb)]);
  for (const k of keys) {
    if (Math.round((Number(wa[k]) || 0) * 100) !== Math.round((Number(wb[k]) || 0) * 100)) return true;
  }
  return false;
}

function renderKpiGroups(state, ym, totals) {
  const dim = daysInMonth(ym);
  const groups = buildKpiGroups(state);
  return `
    <div class="kpi-hero kpi-groups">
      ${groups.map((g) => {
        const spent = g.pids.reduce((sum, pid) => sum + (totals[pid] || 0), 0);
        const budget = g.pids.reduce((sum, pid) => sum + (getMonthlyBudget(state, pid, ym) || 0), 0);
        const dailySum = g.pids.reduce((sum, pid) => sum + (getDailyBudget(state, pid, ym) || 0), 0);
        const allDaily = dailySum > 0 && g.pids.every((pid) => getDailyBudget(state, pid, ym) != null || getMonthlyBudget(state, pid, ym) == null);
        const pct = budget > 0 ? Math.round((spent / budget) * 100) : null;
        const pctCls = pct == null ? "" : pct > 110 ? "kpi-bad" : pct > 100 ? "kpi-warn" : pct >= 80 ? "kpi-ok" : "kpi-warn";
        const barWidth = pct == null ? 0 : Math.max(0, Math.min(120, pct));
        const perf = kpiPerfStats(state, g.pids);
        let perfBadge = "";
        if (perf) {
          const ratio = perf.totalTotal > 0 ? perf.totalMet / perf.totalTotal : 0;
          const cls = ratio >= 0.8 ? "kpi-perf-ok" : ratio >= 0.5 ? "kpi-perf-warn" : "kpi-perf-bad";
          // badge 顯示按目標聚合的 "name X/Y"；點擊展開 popover 看每產品狀態
          const labels = perf.byName.map((t) => `${esc(t.name)} ${t.met}/${t.total}`).join("、");
          const popContent = perf.byName.map((t) => {
            const op = t.products[0]?.direction === "lower_better" ? "≤" : "≥";
            const items = t.products.map((p) => {
              const fmtN = (n) => Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString() : "—";
              const goalText = `${op} ${fmtN(p.goal)}`;
              if (p.status === "met") return `<div class="kpi-pop-item ok"><span>✓</span><strong>${esc(p.name)}</strong><span class="kpi-pop-num">${fmtN(p.actual)} <span class="ink-3">/ ${goalText}</span></span></div>`;
              if (p.status === "miss") return `<div class="kpi-pop-item bad"><span>✗</span><strong>${esc(p.name)}</strong><span class="kpi-pop-num">${fmtN(p.actual)} <span class="ink-3">/ ${goalText}</span></span></div>`;
              return `<div class="kpi-pop-item ink-3"><span>—</span><strong>${esc(p.name)}</strong><span class="kpi-pop-num ink-3">無資料 / ${goalText}</span></div>`;
            }).join("");
            return `<div class="kpi-pop-target"><div class="kpi-pop-target-name">${esc(t.name)} <span class="ink-3">${t.met}/${t.total}</span></div>${items}</div>`;
          }).join("");
          perfBadge = `
            <div class="kpi-perf-wrap">
              <div class="kpi-perf ${cls}" tabindex="0">🎯 ${labels}</div>
              <div class="kpi-perf-pop">${popContent}</div>
            </div>
          `;
        } else {
          perfBadge = `<div class="kpi-perf kpi-perf-none" title="本組產品尚未設定成效目標（到「產品」頁設定 CPI / CPC 等指標）">🎯 未設目標</div>`;
        }
        // 點擊：把詳細檢視切到此組第一個 pid
        const firstPid = g.pids[0] || "";
        return `
          <button class="kpi-card kpi-group ${pctCls}" data-kpi-pid="${firstPid}" title="點擊查看 ${esc(g.label)} 詳細攤提">
            <div class="kpi-label">${g.label}</div>
            <div class="kpi-num">${Math.round(spent).toLocaleString()} <span class="kpi-unit">TWD</span></div>
            <div class="kpi-progress">
              <div class="kpi-bar"><div class="kpi-bar-fill" style="width:${barWidth}%"></div></div>
              <div class="kpi-pct">${pct == null ? "—" : pct + "%"}<span class="ink-3 mono" style="font-size:11px;font-weight:400;margin-left:4px">${pct == null ? "（無預算）" : "完成"}</span></div>
            </div>
            ${perfBadge}
            <div class="kpi-sub">
              月預算 ${budget.toLocaleString()} · ${g.pids.length} 個產品
              ${allDaily ? `<div class="ink-3" style="font-size:10px">= ${Math.round(dailySum).toLocaleString()}/日 × ${dim} 天</div>` : ""}
            </div>
          </button>
        `;
      }).join("")}
    </div>
  `;
}



function renderDetailPanel(s, ym, pid, date) {
  const product = s.products.find((p) => p.id === pid);
  if (!product) return "";

  // 該日該產品的攤提
  const grid = dailySpendGrid(s.ads, ym);
  const dayProductSpent = grid[date]?.[pid] || 0;

  const budget = getMonthlyBudget(s, pid, ym);
  // 用 forward-only 帶寬：取該日當天的段內帶寬，而不是整月平均
  const dayBands = bandsForMonth(s, product, ym);
  const band = dayBands[date] || bandFor(product, ym, budget);
  const monthSpent = monthlyTotals(s.ads, ym)[pid] || 0;
  const monthRemain = budget != null ? budget - monthSpent : null;
  const checkBand = !isNoBand(product);
  const today = todayStr();
  const isPast = date < today;
  // 用四捨五入後比較,避免 IEEE 754 微差讓「剛好頂到 upper」被誤判為超過
  const dpsRounded = Math.round(dayProductSpent);
  const peakOut = checkBand && !isPast && dayProductSpent > 0 && (dpsRounded < Math.round(band.lower) || dpsRounded > Math.round(band.upper));

  // 成效目標達成：把該產品「每支廣告最新一筆」加總後對 targets 跑分
  // （CPC = 合計花費 / 合計事件計數，不是單一廣告的數字）
  const targets = product.performance_targets || [];
  const aggregatedRec = aggregateProductRecord(s, pid);
  const score = aggregatedRec && targets.length ? scoreRecord(aggregatedRec, targets, getReportVars(s)) : null;

  // 該日攤提到該產品的所有廣告
  const contributors = [];
  for (const a of s.ads) {
    if (!isInRange(date, a.start_date, a.end_date)) continue;
    const w = Number(a.weights?.[pid]) || 0;
    if (w <= 0) continue;
    const per = (a.daily_amort_twd || 0) * (w / 100);
    if (per > 0) contributors.push({ ad: a, weight: w, amount: per });
  }
  contributors.sort((a, b) => b.amount - a.amount);

  // 快捷：跳到下一個 / 前一個有攤提的日子
  const monthDays = [...daysOfMonth(ym)];
  const idx = monthDays.indexOf(date);
  const prevDay = idx > 0 ? monthDays[idx - 1] : null;
  const nextDay2 = idx >= 0 && idx < monthDays.length - 1 ? monthDays[idx + 1] : null;

  return `
    <div class="card detail-panel">
      <div class="card-head">
        <h2>詳細檢視</h2>
        <div class="ink-3" style="font-size:12px">選產品 + 日期，看該日該產品實際攤提了什麼</div>
      </div>

      <div class="detail-controls">
        <div class="field">
          <label>產品</label>
          <select id="detail-pid">
            ${s.products.map((p) => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${p.name}（${p.type === "app" ? "APP" : "小島"}）</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>日期</label>
          <input type="date" id="detail-date" value="${date}" min="${ym}-01" />
        </div>
        <div class="quick-day">
          ${prevDay ? `<button data-quick-day="${prevDay}">← ${prevDay.slice(5)}</button>` : ""}
          <button data-quick-day="${todayStr()}">今天</button>
          ${nextDay2 ? `<button data-quick-day="${nextDay2}">${nextDay2.slice(5)} →</button>` : ""}
        </div>
      </div>

      <div class="detail-body">
        <div class="detail-summary">
          <div class="detail-row">
            <div class="detail-label">產品</div>
            <div class="detail-val"><strong>${product.name}</strong> <span class="pill ${product.type}">${product.type === "app" ? "APP" : "小島"}</span></div>
          </div>
          <div class="detail-row">
            <div class="detail-label">月預算</div>
            <div class="detail-val">${budget != null ? budget.toLocaleString() : "<span class='ink-3'>未設定</span>"}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">月已花</div>
            <div class="detail-val">${Math.round(monthSpent).toLocaleString()}${budget != null ? `<span class="ink-3"> · 剩 ${Math.round(monthRemain).toLocaleString()}</span>` : ""}</div>
          </div>
          <div class="detail-row">
            <div class="detail-label">建議日花費</div>
            <div class="detail-val mono">${checkBand
              ? `${Math.round(band.lower).toLocaleString()} ~ ${Math.round(band.upper).toLocaleString()} <span class="ink-3">(${band.pct_label})</span>`
              : `<span class="ink-3">不限（破圈）</span>`}</div>
          </div>
          <div class="detail-row hero">
            <div class="detail-label">${date} 攤提</div>
            <div class="detail-val ${peakOut ? "bad" : "ok"}">
              <strong style="font-size:24px">${Math.round(dayProductSpent).toLocaleString()}</strong>
              <span style="font-size:12px;margin-left:6px">${isPast ? "（已過 — 不警示）" : peakOut ? "✗ 超出建議日花費" : "✓ 在建議日花費內"}</span>
            </div>
          </div>
          <div class="detail-row">
            <div class="detail-label">最新成效目標</div>
            <div class="detail-val" style="font-size:13px">
              ${targets.length === 0
                ? `<span class="ink-3">尚未設定目標 — 到「產品」頁加 CPI / CPC 等指標</span>`
                : !aggregatedRec
                ? `<span class="ink-3">共 ${targets.length} 個目標、無成效資料</span>`
                : (() => {
                    const fmtN = (n) => Number.isFinite(n) ? (Math.round(n * 100) / 100).toLocaleString() : "—";
                    const lines = score.details.map((d) => {
                      const t = targets.find((x) => x.name === d.name);
                      const dirOp = t ? (t.direction === "lower_better" ? "≤" : "≥") : "?";
                      const status = d.actual == null ? `<span class="ink-3">無資料</span>`
                        : d.met ? `<span style="color:var(--ok)">✓</span>` : `<span style="color:var(--bad)">✗</span>`;
                      return `<div style="padding:2px 0"><strong>${escape(d.name)}</strong> ${status} <span class="mono ink-2">${fmtN(d.actual)}</span> <span class="ink-3">/ ${dirOp} ${fmtN(d.goal)}</span></div>`;
                    }).join("");
                    return `<div class="ink-3 mono" style="font-size:11px;margin-bottom:4px">資料期間 ${aggregatedRec.period_start} ~ ${aggregatedRec.period_end} · 達標 ${score.metCount}/${score.totalCount}（產品內所有廣告加總）</div>${lines}`;
                  })()
              }
            </div>
          </div>
        </div>
        <div class="detail-contributors">
          <h3 style="margin-bottom:8px">${date} 貢獻廣告（${contributors.length}）</h3>
          ${contributors.length === 0 ? `<div class="ink-3">該日無廣告攤提至 ${product.name}</div>` : `
            <table class="contrib-table">
              <thead><tr><th>代碼</th><th>名稱</th><th class="num">權重</th><th class="num">攤提 TWD</th></tr></thead>
              <tbody>
                ${contributors.map((c) => `
                  <tr>
                    <td class="mono">${c.ad.ad_code}</td>
                    <td>${c.ad.ad_name}</td>
                    <td class="num">${c.weight}%</td>
                    <td class="num"><strong>${Math.round(c.amount).toLocaleString()}</strong></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          `}
        </div>
      </div>

      <div class="quick-pid">
        <span class="ink-3" style="font-size:12px">快速切換產品：</span>
        ${s.products.map((p) => `<button data-quick-pid="${p.id}" class="${p.id === pid ? "active" : ""}">${p.name}</button>`).join("")}
      </div>
    </div>
  `;
}

function renderOnboarding(s, ym) {
  const hasBudget = Object.keys(s.monthly_budgets || {}).length > 0;
  const hasUrl = !!s.settings.sheets_webapp_url;
  return `
    <div class="view-head">
      <div>
        <h1>歡迎使用廣告投放管理</h1>
        <div class="desc">幾個簡單步驟讓你開始</div>
      </div>
    </div>
    <div class="onboard-grid">
      <div class="onboard-step ${hasBudget ? "done" : ""}">
        <div class="onboard-num">1</div>
        <h3>設月份匯率與月預算</h3>
        <p>先到「設定」頁確認當月（目前 ${ym}）與支出/收入匯率，再到「產品」頁為每個產品設月預算。</p>
        <div class="onboard-actions">
          <a class="btn" href="#settings">前往設定 →</a>
          <a class="btn" href="#products">前往產品 →</a>
        </div>
      </div>
      <div class="onboard-step">
        <div class="onboard-num">2</div>
        <h3>新增首筆廣告</h3>
        <p>到「廣告」頁按「＋ 新增廣告」建立第一筆,輸入廣告代碼/名稱、人民幣金額、攤提天數、起迄日,並設定各產品的權重比例。</p>
        <div class="onboard-actions">
          <a class="btn primary" href="#ads">新增廣告 →</a>
        </div>
      </div>
      <div class="onboard-step ${hasUrl ? "done" : ""}">
        <div class="onboard-num">3</div>
        <h3>（選配）連 Google Sheets</h3>
        <p>同步到雲端方便團隊查看 / 從外部平台貼成效資料。在「設定」頁照步驟做一次性 Apps Script 部署即可。</p>
        <div class="onboard-actions">
          <a class="btn" href="#settings">設定 Sheets →</a>
        </div>
      </div>
    </div>
  `;
}

// 產品 × 廣告分組的攤提花費 — 兩種視圖：
//   - monthly：月度摘要（產品 × 分組 矩陣 + 各方向合計）
//   - daily：每日摘要（依產品分頁，每頁顯示 日期 × 分組，每格 = 該產品該日該分組的攤提）
function renderGroupBreakdown(s, ym) {
  // 共用：先收集出現過的所有分組（依月度合計排序）
  const groupTotals = {};       // groupTotals[group] = total TWD（全產品全月）
  const monthly = {};           // monthly[pid][group] = TWD（per-product × group）
  const productTotals = {};
  const daily = {};             // daily[pid][date][group] = TWD（per-product × date × group）
  const dailyAll = {};          // dailyAll[date][group] = TWD（全產品合計，給「全部產品」用）
  let grandTotal = 0;

  for (const day of daysOfMonth(ym)) {
    dailyAll[day] = {};
  }
  for (const p of s.products) {
    daily[p.id] = {};
    for (const day of daysOfMonth(ym)) daily[p.id][day] = {};
  }

  for (const ad of s.ads) {
    const grp = ad.group || "—";
    // 月度合計（per pid × group）
    const contrib = adContributionPerMonth(ad, ym);
    for (const [pid, amt] of Object.entries(contrib)) {
      if (!amt) continue;
      monthly[pid] = monthly[pid] || {};
      monthly[pid][grp] = (monthly[pid][grp] || 0) + amt;
      productTotals[pid] = (productTotals[pid] || 0) + amt;
      groupTotals[grp] = (groupTotals[grp] || 0) + amt;
      grandTotal += amt;
    }
    // 每日（per pid × date × group）
    for (const day of daysOfMonth(ym)) {
      const per = dailySpendForAd(ad, day);
      for (const [pid, amt] of Object.entries(per)) {
        if (!amt) continue;
        if (!daily[pid]) continue;  // 略過不存在的產品（資料不一致時）
        daily[pid][day][grp] = (daily[pid][day][grp] || 0) + amt;
        dailyAll[day][grp] = (dailyAll[day][grp] || 0) + amt;
      }
    }
  }

  const groups = Object.keys(groupTotals).sort((a, b) => groupTotals[b] - groupTotals[a]);
  if (groups.length === 0) return "";

  const tabs = `
    <div class="filter-row" style="margin-bottom:0;background:transparent;padding:0">
      <button class="filter-chip ${groupView === "daily" ? "active" : ""}" data-group-view="daily">每日摘要</button>
      <button class="filter-chip ${groupView === "monthly" ? "active" : ""}" data-group-view="monthly">月度摘要</button>
    </div>
  `;

  const body = groupView === "monthly"
    ? renderGroupMonthly(s, groups, monthly, productTotals, groupTotals, grandTotal)
    : renderGroupDailyByProduct(s, ym, groups, daily, dailyAll, groupTotals, grandTotal, productTotals);

  return `
    <div class="card">
      <div class="card-head">
        <h2>產品 × 廣告分組（當月攤提，台幣）</h2>
        ${tabs}
      </div>
      ${body}
    </div>
  `;
}

function renderGroupMonthly(s, groups, cell, productTotals, groupTotals, grandTotal) {
  const rows = s.products.map((p) => {
    const cells = groups.map((g) => {
      const v = cell[p.id]?.[g] || 0;
      return `<td class="num">${v ? Math.round(v).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    const total = productTotals[p.id] || 0;
    return `<tr>
      <td><strong>${escape(p.name)}</strong></td>
      ${cells}
      <td class="num"><strong>${total ? Math.round(total).toLocaleString() : "—"}</strong></td>
    </tr>`;
  }).join("");

  const footer = `<tr class="dg-foot-row">
    <td><strong>分組合計</strong></td>
    ${groups.map((g) => `<td class="num dg-foot"><strong>${Math.round(groupTotals[g] || 0).toLocaleString()}</strong></td>`).join("")}
    <td class="num dg-foot"><strong>${Math.round(grandTotal).toLocaleString()}</strong></td>
  </tr>`;

  return `
    <div class="ink-3" style="margin-bottom:8px;font-size:12px">產品（列） × 廣告分組（欄），每格 = 該產品來自該分組的當月攤提</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>產品</th>
            ${groups.map((g) => `<th class="num">${escape(g)}</th>`).join("")}
            <th class="num">產品合計</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>${footer}</tfoot>
      </table>
    </div>
  `;
}

// 每日摘要：依產品分頁。預設「全部產品」= 該日該分組的全產品合計。
// 切某產品 → 只看該產品在該日來自該分組的攤提。
function renderGroupDailyByProduct(s, ym, groups, daily, dailyAll, groupTotals, grandTotal, productTotals) {
  const days = [...daysOfMonth(ym)];
  if (days.length === 0) return "";

  // 確認 groupDailyPid 還合法
  if (groupDailyPid !== "all" && !s.products.find((p) => p.id === groupDailyPid)) {
    groupDailyPid = "all";
  }

  // 產品分頁 chips
  const productTabs = `
    <div class="filter-row" style="margin-bottom:8px">
      <span class="ink-3" style="font-size:12px">產品：</span>
      <button class="filter-chip ${groupDailyPid === "all" ? "active" : ""}" data-group-pid="all">全部 (${Math.round(grandTotal).toLocaleString()})</button>
      ${s.products.map((p) => {
        const t = productTotals[p.id] || 0;
        return `<button class="filter-chip ${groupDailyPid === p.id ? "active" : ""}" data-group-pid="${escape(p.id)}">${escape(p.name)}${t ? ` <span class="ink-3">${Math.round(t).toLocaleString()}</span>` : ""}</button>`;
      }).join("")}
    </div>
  `;

  // 該產品的 daily × group 矩陣
  const matrix = groupDailyPid === "all" ? dailyAll : (daily[groupDailyPid] || {});
  // 該產品該分組合計（footer 用）
  const colTotals = {};
  let gTotal = 0;
  for (const day of days) {
    for (const g of groups) {
      const v = matrix[day]?.[g] || 0;
      colTotals[g] = (colTotals[g] || 0) + v;
      gTotal += v;
    }
  }

  const today = todayStr();
  const bodyRows = days.map((d) => {
    let dayTotal = 0;
    const cells = groups.map((g) => {
      const v = matrix[d]?.[g] || 0;
      dayTotal += v;
      return `<td class="num">${v ? Math.round(v).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    const todayCls = d === today ? " dg-today" : "";
    return `<tr class="${todayCls.trim()}">
      <td class="mono">${d.slice(5)}${d === today ? " <span class='pill' style='font-size:10px;padding:0 4px;margin-left:2px;background:#111;color:#fff'>今天</span>" : ""}</td>
      ${cells}
      <td class="num"><strong>${dayTotal ? Math.round(dayTotal).toLocaleString() : "—"}</strong></td>
    </tr>`;
  }).join("");

  const footer = `<tr class="dg-foot-row">
    <td><strong>月合計</strong></td>
    ${groups.map((g) => `<td class="num dg-foot"><strong>${Math.round(colTotals[g] || 0).toLocaleString()}</strong></td>`).join("")}
    <td class="num dg-foot"><strong>${Math.round(gTotal).toLocaleString()}</strong></td>
  </tr>`;

  const productLabel = groupDailyPid === "all"
    ? "全部產品"
    : (s.products.find((p) => p.id === groupDailyPid)?.name || groupDailyPid);

  return `
    ${productTabs}
    <div class="ink-3" style="margin-bottom:8px;font-size:12px">${escape(productLabel)} 每日來自各分組的攤提</div>
    <div class="table-wrap" style="max-height:480px;overflow:auto">
      <table>
        <thead>
          <tr>
            <th>日期</th>
            ${groups.map((g) => `<th class="num">${escape(g)}</th>`).join("")}
            <th class="num">當日合計</th>
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
        <tfoot>${footer}</tfoot>
      </table>
    </div>
  `;
}

function escape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const esc = escape;

function uniqueByCode(ads) {
  const seen = new Set();
  const out = [];
  for (const ad of ads || []) {
    const key = ad.ad_code || ad.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ad);
  }
  return out;
}

function productRow(state, product, ym, spent) {
  const budget = getMonthlyBudget(state, product.id, ym);
  if (budget == null) {
    return `
      <tr>
        <td><strong>${product.name}</strong></td>
        <td><span class="pill ${product.type}">${product.type === "app" ? "APP" : "小島"}</span></td>
        <td class="num"><span class="pill warn">${ym} 未設定</span></td>
        <td class="num">${Math.round(spent).toLocaleString()}</td>
        <td class="num ink-3">—</td>
        <td><span class="ink-3">到「產品」頁設定月預算</span></td>
        <td class="num ink-3">—</td>
      </tr>
    `;
  }
  // 取「今天的有效帶寬」（forward-only 段內）；超出當月時退用整月平均
  const today = todayTaipei();
  const refDay = today >= `${ym}-01` && today < `${nextMonthYm(ym)}-01` ? today : `${ym}-01`;
  const dayBands = bandsForMonth(state, product, ym);
  const band = dayBands[refDay] || bandFor(product, ym, budget);
  const check = checkMonthlyTotal(spent, budget, product.type);
  const segNote = band.change_at && band.change_at !== `${ym}-01`
    ? ` <span class="ink-3 mono" style="font-size:11px" title="此產品在 ${band.change_at} 起換段（預算或日預算改變）">· 段起 ${band.change_at.slice(5)} 剩 ${band.seg_days} 天</span>`
    : "";
  const bandCell = isNoBand(product)
    ? `<span class="ink-3" title="此產品設為「不檢查每日帶寬」">不限</span>`
    : `<span class="ink-2">${Math.round(band.lower).toLocaleString()} ~ ${Math.round(band.upper).toLocaleString()}</span> <span class="ink-3">(${band.pct_label})</span>${segNote}`;
  // 預算來源：daily 設定時，補一行小字說明推演
  const source = getBudgetSource(state, product.id, ym);
  const daily = getDailyBudget(state, product.id, ym);
  const budgetCell = source === "daily"
    ? `<strong>${budget.toLocaleString()}</strong>
       <div class="ink-3 mono" style="font-size:11px">= ${daily.toLocaleString()}/日 × ${daysInMonth(ym)}</div>`
    : budget.toLocaleString();
  // 狀態徽章:用 icon + 顏色一眼分辨「容許內 / 少花太多 / 超花太多」
  const kindIcon = check.kind === "ok" ? "✓" : check.kind === "warn" ? "⚠" : "✗";
  const diff = spent - budget;
  const diffStr = (diff >= 0 ? "+" : "") + Math.round(diff).toLocaleString();
  return `
    <tr class="prod-row prod-row-${check.kind}">
      <td><strong>${product.name}</strong></td>
      <td><span class="pill ${product.type}">${product.type === "app" ? "APP" : "小島"}</span></td>
      <td class="num">${budgetCell}</td>
      <td class="num">${Math.round(spent).toLocaleString()}</td>
      <td class="num ${check.kind}">${diffStr}</td>
      <td><span class="pill ${check.kind}" style="font-size:12px">${kindIcon} ${check.msg}</span></td>
      <td class="num">${bandCell}</td>
    </tr>
  `;
}

function renderDailyGrid(s, ym) {
  const nextYm = nextMonthYm(ym);
  const showYm = dailyGridMonth === "next" ? nextYm : ym;
  // projection 一律跑到下月,確保跨月續費段在下月也存在(grid 只用 showYm 切片)
  const projection = dailyProjectionMode === "renewal"
    ? projectAdsWithRenewals(s, ym, { fromDate: todayStr(), toMonth: nextYm, excludePoorPerf: false })
    : { ads: s.ads, virtualRenewals: [], excludedPoorPerf: [] };
  const computedGrid = dailySpendGrid(projection.ads, showYm);
  const products = s.products;
  // 每個產品的「每一日」帶寬(forward-only 分段)
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(s, p, showYm)]));

  const days = [...daysOfMonth(showYm)];
  if (days.length === 0) return "";

  const monthTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  let grandTotal = 0;

  // 紀錄每個 pid 的「段切換日」(用於 daily grid 在切換日加分隔線)
  const segChangeDays = Object.fromEntries(products.map((p) => {
    const dbands = dayBandsByPid[p.id];
    const set = new Set();
    let prev = null;
    for (const d of days) {
      const ca = dbands?.[d]?.change_at;
      if (ca && ca !== `${showYm}-01` && ca !== prev) set.add(ca);
      prev = ca;
    }
    return [p.id, set];
  }));

  const today = todayStr();
  const bodyRows = days.map((d) => {
    const row = computedGrid[d] || {};
    let dayTotal = 0;
    const cells = products.map((p) => {
      const amt = row[p.id] || 0;
      dayTotal += amt;
      monthTotals[p.id] += amt;
      const b = dayBandsByPid[p.id]?.[d];
      // 只在「當日及未來」標色 — 過去日已花掉,無法調整,標色只會徒增噪音
      const isFuture = d >= today;
      const checkBand = isFuture && b && b.budget_set && !isNoBand(p) && amt > 0;
      const amtRounded = Math.round(amt);
      const isUnder = checkBand && amtRounded < Math.round(b.lower);
      const isOver = checkBand && amtRounded > Math.round(b.upper);
      const isSegStart = segChangeDays[p.id].has(d);
      const cls = `num ${isUnder ? "dg-under-band" : ""} ${isOver ? "dg-over-band" : ""} ${isSegStart ? "dg-seg-start" : ""} ${d < today ? "dg-past" : ""}`;
      const title = b && b.budget_set
        ? `建議日花費 ${Math.round(b.avg).toLocaleString()} (${Math.round(b.lower).toLocaleString()}~${Math.round(b.upper).toLocaleString()})${b.change_at && b.change_at !== `${showYm}-01` ? ` · 段起 ${b.change_at}` : ""}${d < today ? " · 已過(不警示)" : ""}`
        : "";
      return `<td class="${cls}" title="${title}">${amt ? Math.round(amt).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    grandTotal += dayTotal;
    const todayCls = d === today ? " dg-today" : "";
    return `<tr class="${todayCls.trim()}">
      <td class="mono">${d.slice(5)}${d === today ? " <span class='pill' style='font-size:10px;padding:0 4px;margin-left:2px;background:#111;color:#fff'>今天</span>" : ""}</td>
      ${cells}
      <td class="num"><strong>${Math.round(dayTotal).toLocaleString()}</strong></td>
    </tr>`;
  }).join("");

  const footerCells = products.map((p) => {
    const total = monthTotals[p.id];
    const budget = getMonthlyBudget(s, p.id, showYm) || 0;
    const diff = total - budget;
    const diffClass = !budget ? "ink-3" : checkMonthlyTotal(total, budget, p.type).kind;
    return `<td class="num dg-foot">
      <strong>${Math.round(total).toLocaleString()}</strong>
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const headerCells = products.map((p) => {
    const target = getTargetDailyBudget(s, p.id, showYm);
    const sub = target != null
      ? `<div class="ink-3" style="font-size:10px;font-weight:400">${Math.round(target).toLocaleString()}/日</div>`
      : "";
    return `<th class="num">${esc(p.name)}${sub}</th>`;
  }).join("");
  const projectedCodes = uniqueByCode(projection.virtualRenewals);
  const modeTabs = `
    <div class="filter-row" style="margin-bottom:0;background:transparent;padding:0">
      <button class="filter-chip ${dailyProjectionMode === "renewal" ? "active" : ""}" data-daily-mode="renewal">續費預估</button>
      <button class="filter-chip ${dailyProjectionMode === "actual" ? "active" : ""}" data-daily-mode="actual">實際資料</button>
    </div>
  `;
  const monthTabs = `
    <div class="tabs" style="margin-bottom:10px">
      <button class="tab ${dailyGridMonth === "current" ? "active" : ""}" data-daily-grid-month="current">當月(${ym})</button>
      <button class="tab ${dailyGridMonth === "next" ? "active" : ""}" data-daily-grid-month="next">下月(${nextYm})</button>
    </div>
  `;
  const modeNote = dailyProjectionMode === "renewal"
    ? `假設今日後到期的終端廣告會持續續費(僅跳過已淘汰)。已加入 ${projectedCodes.length} 支預估續費。`
    : "只計算已存在的廣告段;未手動續費的廣告到期後停止攤提。";

  return `
    <div class="card">
      <div class="card-head">
        <h2>每日攤提(${showYm},台幣)</h2>
        ${modeTabs}
      </div>
      <div class="ink-3" style="margin-bottom:8px;font-size:12px">${modeNote}</div>
      ${monthTabs}
      <div class="ink-3" style="margin-bottom:8px;font-size:12px">橘 = 少花太多(低於建議日花費下限);紅 = 多花太多(超出上限);過去日不警示。</div>
      <div class="table-wrap" style="max-height:560px;overflow:auto">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              ${headerCells}
              <th class="num">當日合計</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
          <tfoot>
            <tr class="dg-foot-row">
              <td><strong>月合計</strong><div class="ink-3" style="font-size:11px">vs 預算</div></td>
              ${footerCells}
              <td class="num dg-foot"><strong>${Math.round(grandTotal).toLocaleString()}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}
