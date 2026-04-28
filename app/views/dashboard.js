import { getState } from "../state.js";
import { bandFor, bandsForMonth, checkMonthlyTotal } from "../domain/budget.js";
import { monthlyTotals, dailySpendGrid, adContributionPerMonth, dailySpendForAd } from "../domain/spending.js";
import { daysOfMonth, daysInMonth, isInRange, todayTaipei } from "../lib/dates.js";
import { getMonthlyBudget, getDailyBudget, getBudgetSource, NO_BAND_PIDS } from "../schema.js";
import { scoreRecord } from "../domain/perf-adjust.js";
import { computeAlerts, expiringAds } from "../domain/alerts.js";

// 概覽 KPI 群組（依使用者要求合併）
const KPI_GROUPS = [
  { id: "av9",     label: "AV9（含破圈）", pids: ["AV9", "av9_poquan"] },
  { id: "jk",      label: "JK（含破圈）",  pids: ["JK", "jk_poquan"] },
  { id: "hyc",     label: "黃油圈",        pids: ["HYC"] },
  { id: "islands", label: "小島（6 產品）", pids: ["PJ8", "ZFB", "OJI", "MYS", "XRK", "BS"] },
];

// 模組級狀態：使用者選的概覽月份 + 詳細檢視選的產品 + 日期
let viewYm = null;
let detailPid = null;
let detailDate = null;
// 「產品 × 廣告分組」卡片視圖：'monthly'（月度摘要）/ 'daily'（每日摘要）
let groupView = "daily";
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

  const totals = monthTotalsPreferOverride(s, ym);

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

    ${renderGroupBreakdown(s, ym)}

    ${renderDailyGrid(s, ym)}
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


  // 產品 × 廣告分組視圖切換
  root.querySelectorAll("[data-group-view]").forEach((el) => {
    el.onclick = () => { groupView = el.dataset.groupView; render(root); };
  });
  // 每日摘要的產品分頁切換
  root.querySelectorAll("[data-group-pid]").forEach((el) => {
    el.onclick = () => { groupDailyPid = el.dataset.groupPid; render(root); };
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
    const score = scoreRecord(aggregated, targets);
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
// 把「需要採取行動」的訊號集中：即將到期（含成效全爛）+ 預算/建議花費值/待辦警告。
// APP 產品的容差比小島寬：少花 ≤ 60K、超花 ≤ 20K 視為容許範圍，不出現在這區
//   （產品預算表的「狀態」欄仍會顯示）。
// 沒事時整個區塊不渲染。
function strictBudgetAlerts(state) {
  const ym = state.settings.current_month;
  const totalsToUse = monthTotalsPreferOverride(state, ym);
  const out = [];
  for (const p of state.products) {
    const budget = getMonthlyBudget(state, p.id, ym);
    if (budget == null) continue;
    const total = totalsToUse[p.id] || 0;
    const diff = total - budget;
    const isApp = p.type === "app";
    const overHard = isApp ? 20000 : 10000;
    const underWarn = isApp ? 60000 : 20000;
    if (diff > overHard) {
      out.push({ kind: "budget", severity: "bad", msg: `${p.name} 超花 ${Math.round(diff).toLocaleString()} TWD（容許上限 ${overHard.toLocaleString()}）`, link: "#dashboard" });
    } else if (-diff > underWarn) {
      out.push({ kind: "budget", severity: "warn", msg: `${p.name} 少花 ${Math.round(-diff).toLocaleString()} TWD（容許下限 ${underWarn.toLocaleString()}）`, link: "#dashboard" });
    }
  }
  return out;
}

function renderActionRequired(state) {
  const expiring = expiringAds(state, 10);
  const allAlerts = computeAlerts(state);
  // budget 用 strict 版（APP 容差更寬）；band/todo 用通用版
  const alerts = [
    ...strictBudgetAlerts(state),
    ...allAlerts.filter((a) => a.kind === "band" || a.kind === "todo"),
  ];
  if (expiring.length === 0 && alerts.length === 0) return "";

  // 即將到期：成效全爛優先排前；同名廣告去重（同 ads 頁邏輯）
  const byName = new Map();
  for (const { ad, daysLeft, poorPerf } of expiring) {
    const key = ad.ad_name || ad.ad_code;
    if (!byName.has(key)) {
      byName.set(key, { adName: ad.ad_name, latestAd: ad, codes: new Set(), earliestDays: daysLeft, poorPerf: null });
    }
    const g = byName.get(key);
    g.codes.add(ad.ad_code);
    if (ad.end_date < g.latestAd.end_date) {
      g.latestAd = ad;
      g.earliestDays = daysLeft;
    }
    if (poorPerf) g.poorPerf = poorPerf;
  }
  const expGroups = [...byName.values()].sort((a, b) => {
    if (!!a.poorPerf !== !!b.poorPerf) return a.poorPerf ? -1 : 1;
    return a.earliestDays - b.earliestDays;
  });

  const expiringHtml = expGroups.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>📅 即將到期 (${expGroups.length} 支)</strong>
        <a class="ar-link" href="#ads">→ 廣告頁處理</a>
      </div>
      <ul class="ar-list">
        ${expGroups.slice(0, 5).map((g) => {
          const sev = g.poorPerf ? "bad" : g.earliestDays <= 3 ? "bad" : g.earliestDays <= 7 ? "warn" : "info";
          const tag = g.poorPerf
            ? `<span class="pill" style="background:#fde3e3;color:var(--bad);font-weight:600">🚨 成效全爛</span>`
            : "";
          return `<li class="ar-item ar-${sev}">
            <span class="ar-days">${g.earliestDays} 天</span>
            <span><strong>${escape(g.adName || "—")}</strong> <span class="ink-3 mono" style="font-size:11px">${[...g.codes].join("/")}</span></span>
            ${tag}
          </li>`;
        }).join("")}
        ${expGroups.length > 5 ? `<li class="ink-3" style="font-size:12px">…還有 ${expGroups.length - 5} 支</li>` : ""}
      </ul>
    </div>
  `;

  const alertGroups = { budget: [], band: [], todo: [] };
  for (const a of alerts) alertGroups[a.kind].push(a);
  const alertsHtml = alerts.length === 0 ? "" : `
    <div class="ar-block">
      <div class="ar-block-head">
        <strong>⚠️ 預算 / 建議花費值 / 待辦 (${alerts.length})</strong>
      </div>
      <ul class="ar-list">
        ${alerts.slice(0, 8).map((a) => `
          <li class="ar-item ar-${a.severity}">
            <span class="ar-icon">${a.kind === "budget" ? "💰" : a.kind === "band" ? "📊" : "📋"}</span>
            <span>${escape(a.msg)}</span>
            ${a.link ? `<a class="ar-link" href="${escape(a.link)}">→</a>` : ""}
          </li>
        `).join("")}
        ${alerts.length > 8 ? `<li class="ink-3" style="font-size:12px">…還有 ${alerts.length - 8} 條</li>` : ""}
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
      ${alertsHtml}
    </div>
  `;
}

function renderKpiGroups(state, ym, totals) {
  const dim = daysInMonth(ym);
  return `
    <div class="kpi-hero kpi-groups">
      ${KPI_GROUPS.map((g) => {
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

  // 該日該產品的攤提（優先取 override）
  const ov = s.daily_amort_override?.[date];
  const grid = dailySpendGrid(s.ads, ym);
  const dayProductSpent = ov?.[pid] != null ? ov[pid] : (grid[date]?.[pid] || 0);

  const budget = getMonthlyBudget(s, pid, ym);
  // 用 forward-only 帶寬：取該日當天的段內帶寬，而不是整月平均
  const dayBands = bandsForMonth(s, product, ym);
  const band = dayBands[date] || bandFor(product, ym, budget);
  const monthSpent = monthTotalsPreferOverride(s, ym)[pid] || 0;
  const monthRemain = budget != null ? budget - monthSpent : null;
  const checkBand = !NO_BAND_PIDS.has(pid);
  const today = todayStr();
  const isPast = date < today;
  const peakOut = checkBand && !isPast && dayProductSpent > 0 && (dayProductSpent < band.lower || dayProductSpent > band.upper);

  // 成效目標達成：把該產品「每支廣告最新一筆」加總後對 targets 跑分
  // （CPC = 合計花費 / 合計事件計數，不是單一廣告的數字）
  const targets = product.performance_targets || [];
  const aggregatedRec = aggregateProductRecord(s, pid);
  const score = aggregatedRec && targets.length ? scoreRecord(aggregatedRec, targets) : null;

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
        <h3>載入範例 / 新增首筆廣告</h3>
        <p>想看完整資料長什麼樣，可在「設定」頁載入 2026-04 範例。或直接到「廣告」頁按「＋ 新增廣告」開始。</p>
        <div class="onboard-actions">
          <a class="btn" href="#settings">載入範例 →</a>
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

  const bodyRows = days.map((d) => {
    let dayTotal = 0;
    const cells = groups.map((g) => {
      const v = matrix[d]?.[g] || 0;
      dayTotal += v;
      return `<td class="num">${v ? Math.round(v).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    return `<tr>
      <td class="mono">${d.slice(5)}</td>
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

function monthTotalsPreferOverride(s, ym) {
  const override = s.daily_amort_override || {};
  const days = Object.keys(override).filter((d) => d.startsWith(ym));
  if (days.length === 0) return monthlyTotals(s.ads, ym);
  const totals = {};
  for (const d of days) {
    for (const [pid, amt] of Object.entries(override[d])) {
      totals[pid] = (totals[pid] || 0) + amt;
    }
  }
  return totals;
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
  const bandCell = NO_BAND_PIDS.has(product.id)
    ? `<span class="ink-3" title="破圈系列不檢查建議日花費">不限</span>`
    : `<span class="ink-2">${Math.round(band.lower).toLocaleString()} ~ ${Math.round(band.upper).toLocaleString()}</span> <span class="ink-3">(${band.pct_label})</span>${segNote}`;
  // 預算來源：daily 設定時，補一行小字說明推演
  const source = getBudgetSource(state, product.id, ym);
  const daily = getDailyBudget(state, product.id, ym);
  const budgetCell = source === "daily"
    ? `<strong>${budget.toLocaleString()}</strong>
       <div class="ink-3 mono" style="font-size:11px">= ${daily.toLocaleString()}/日 × ${daysInMonth(ym)}</div>`
    : budget.toLocaleString();
  return `
    <tr>
      <td><strong>${product.name}</strong></td>
      <td><span class="pill ${product.type}">${product.type === "app" ? "APP" : "小島"}</span></td>
      <td class="num">${budgetCell}</td>
      <td class="num">${Math.round(spent).toLocaleString()}</td>
      <td class="num">${(spent - budget >= 0 ? "+" : "") + Math.round(spent - budget).toLocaleString()}</td>
      <td><span class="pill ${check.kind}">${check.msg}</span></td>
      <td class="num">${bandCell}</td>
    </tr>
  `;
}

function renderDailyGrid(s, ym) {
  const computedGrid = dailySpendGrid(s.ads, ym);
  const override = s.daily_amort_override || {};
  const hasOverride = Object.keys(override).some((d) => d.startsWith(ym));
  const products = s.products;
  // 每個產品的「每一日」帶寬（forward-only 分段）
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(s, p, ym)]));

  const days = [...daysOfMonth(ym)];
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
      if (ca && ca !== `${ym}-01` && ca !== prev) set.add(ca);
      prev = ca;
    }
    return [p.id, set];
  }));

  const today = todayStr();
  const bodyRows = days.map((d) => {
    const overrideRow = override[d];
    const row = overrideRow || computedGrid[d] || {};
    let dayTotal = 0;
    const cells = products.map((p) => {
      const amt = row[p.id] || 0;
      dayTotal += amt;
      monthTotals[p.id] += amt;
      const b = dayBandsByPid[p.id]?.[d];
      // 只在「當日及未來」標紅 — 過去日已花掉，無法調整，標紅只會徒增噪音
      const isFuture = d >= today;
      const out = isFuture && b && b.budget_set && !NO_BAND_PIDS.has(p.id) && amt > 0 && (amt < b.lower || amt > b.upper);
      const isSegStart = segChangeDays[p.id].has(d);
      const cls = `num ${out ? "dg-out-of-band" : ""} ${isSegStart ? "dg-seg-start" : ""} ${d < today ? "dg-past" : ""}`;
      const title = b && b.budget_set
        ? `建議日花費 ${Math.round(b.avg).toLocaleString()} (${Math.round(b.lower).toLocaleString()}~${Math.round(b.upper).toLocaleString()})${b.change_at && b.change_at !== `${ym}-01` ? ` · 段起 ${b.change_at}` : ""}${d < today ? " · 已過（不警示）" : ""}`
        : "";
      return `<td class="${cls}" title="${title}">${amt ? Math.round(amt).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    grandTotal += dayTotal;
    return `<tr>
      <td class="mono">${d.slice(5)}</td>
      ${cells}
      <td class="num"><strong>${Math.round(dayTotal).toLocaleString()}</strong></td>
    </tr>`;
  }).join("");

  const footerCells = products.map((p) => {
    const total = monthTotals[p.id];
    const budget = getMonthlyBudget(s, p.id, ym) || 0;
    const diff = total - budget;
    const diffClass = !budget ? "ink-3" : diff > 10000 ? "bad" : diff > 0 ? "warn" : -diff > 20000 ? "warn" : "ok";
    return `<td class="num dg-foot">
      <strong>${Math.round(total).toLocaleString()}</strong>
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const headerCells = products.map((p) => `<th class="num">${esc(p.name)}</th>`).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>每日攤提（台幣）${hasOverride ? '<span class="pill" style="margin-left:8px">來源：預估費用分頁</span>' : ''}</h2>
        <div class="ink-3">紅色格 = 當日及未來日超出建議日花費（過去日不警示）</div>
      </div>
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
