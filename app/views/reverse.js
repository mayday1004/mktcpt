import { getState } from "../state.js";
import { suggestWeights } from "../domain/suggest.js";
import { dailySpendGrid, dailySpendForAd, monthlyTotals } from "../domain/spending.js";
import { addDays, monthOf, todayTaipei, diffDays, daysOfMonth, daysInMonth } from "../lib/dates.js";
import { getMonthlyBudget, getDailyBudget, getLatestBudget, isNoBand, getTargetDailyBudget } from "../schema.js";
import { bandsForMonth, bandFor } from "../domain/budget.js";
import { projectAdsWithRenewals } from "../domain/renewal-projection.js";

// ── 模組層狀態 ────────────────────────────────────────────────────
// rows: 各筆採買的暫存資料 — { id, amount_cny|null, start, end, rate, days, weights }
let rows = [];
let rowSeq = 1;
let initialized = false;
let spendScenario = "renewal";  // "renewal" | "actual"
let viewMonth = "current";       // "current" | "next"

function defaultRow(today, expRate, offsetDays) {
  const start = addDays(today, offsetDays);
  return {
    id: rowSeq++,
    amount_cny: null,
    start,
    end: addDays(start, 30),
    rate: expRate,
    days: 30,
    weights: {},
  };
}

function ensureInit(state) {
  const today = todayTaipei();
  const rate = state.settings.expense_rate || 4.7;
  if (!initialized) {
    initialized = true;
    rows = [defaultRow(today, rate, 0)];
  }
  // 確保日期不在過去
  for (const r of rows) {
    if (r.start < today) r.start = today;
    if (!r.end || r.end <= r.start) r.end = addDays(r.start, r.days || 30);
    if (!r.rate) r.rate = rate;
    if (!r.days || r.days <= 0) {
      r.days = Math.max(1, diffDays(r.start, r.end));
    }
  }
}

function nextMonthYM(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function scenarioFor(state, ym) {
  if (spendScenario !== "renewal") {
    return { state, virtualRenewals: [], excludedPoorPerf: [] };
  }
  const projection = projectAdsWithRenewals(state, ym, { fromDate: todayTaipei(), excludePoorPerf: true });
  return {
    state: { ...state, ads: projection.ads },
    virtualRenewals: projection.virtualRenewals,
    excludedPoorPerf: projection.excludedPoorPerf,
  };
}

// 把一筆 row 轉成預覽用的 fake ad,丟給 dailySpendGrid / suggestWeights 用
function makePreviewAd(row) {
  if (!row || !row.amount_cny || !row.days || row.days <= 0) return null;
  const totalTwd = row.amount_cny * row.rate;
  const dailyTwd = totalTwd / row.days;
  return {
    id: `__preview_row_${row.id}`,
    ad_code: `__preview_row_${row.id}`,
    ad_name: `(預覽:第 ${rows.indexOf(row) + 1} 筆)`,
    group: "preview",
    amount_cny: row.amount_cny,
    exchange_rate: row.rate,
    amount_twd: totalTwd,
    start_date: row.start,
    end_date: row.end,
    amortize_days: row.days,
    daily_amort_twd: dailyTwd,
    purchase_mode: "shared",
    weights: { ...(row.weights || {}) },
  };
}

// 算「第 idx 筆採買」在 row.start 當天的累積花費(該筆 + 前面已加的筆 + 既有廣告)
function spendAtRowStart(scenarioAds, idx) {
  const row = rows[idx];
  const ym = monthOf(row.start);
  const baseAds = [...scenarioAds];
  // 把 0..idx 的所有筆當預覽 ad 一起算
  for (let i = 0; i <= idx; i++) {
    const ad = makePreviewAd(rows[i]);
    if (ad) baseAds.push(ad);
  }
  const grid = dailySpendGrid(baseAds, ym);
  return grid[row.start] || {};
}

// 該筆當天的「貢獻 delta」=  daily_twd × weight%
function contribForRow(row, day) {
  if (!row.amount_cny || !row.days || row.days <= 0) return {};
  if (day < row.start || day >= row.end) return {};
  const dailyTwd = (row.amount_cny * row.rate) / row.days;
  const out = {};
  for (const [pid, w] of Object.entries(row.weights || {})) {
    out[pid] = dailyTwd * (Number(w) / 100);
  }
  return out;
}

// 對某一筆 row 算「建議」:
//   - 若 amount_cny 為空 → 算「把當天每個產品補到 月預算/月天數 目標」需要多少 RMB
//     並用 suggestWeights 算建議權重(把該筆需要的 daily 當 virtual ad)
//   - 若 amount_cny 已填 → 用 suggestWeights 算建議權重
// 累積:把前 0..idx-1 的所有筆當預覽 ad 加進 scenarioAds,確保不重複塞同個產品
function computeRowSuggestion(state, products, scenarioAds, idx) {
  const row = rows[idx];
  const ym = monthOf(row.start);

  // 把前面的筆當虛擬 ad 一起送進去
  const priorAds = [];
  for (let i = 0; i < idx; i++) {
    const ad = makePreviewAd(rows[i]);
    if (ad) priorAds.push(ad);
  }
  const adsForSuggest = [...scenarioAds, ...priorAds];
  const stateForSuggest = { ...state, ads: adsForSuggest };

  const isEmpty = !row.amount_cny;
  if (isEmpty) {
    // 算每個產品「離目標還差多少」,加總得到該筆需要的 daily TWD
    const grid = dailySpendGrid(adsForSuggest, ym);
    const startDay = grid[row.start] || {};
    const monthDays = daysInMonth(ym);
    let totalDaily = 0;
    const gaps = {};
    for (const p of products) {
      // APP 取 月預算 ÷ 月天數;島取最新一段的日預算
      let target;
      if (p.type === "island") {
        const latest = getLatestBudget(state, p.id, ym);
        if (latest != null) target = latest;
        else {
          const monthly = getMonthlyBudget(state, p.id, ym);
          target = monthly ? monthly / monthDays : 0;
        }
      } else {
        const monthly = getMonthlyBudget(state, p.id, ym);
        target = monthly ? monthly / monthDays : 0;
      }
      if (!target) continue;
      const current = startDay[p.id] || 0;
      const gap = Math.max(0, target - current);
      if (gap > 0) gaps[p.id] = gap;
      totalDaily += gap;
    }
    if (totalDaily <= 0) {
      return { amount_cny_suggest: 0, daily_twd: 0, weights: {}, reasons: ["所有產品都已達日目標,無需再採買"] };
    }
    const totalTwd = totalDaily * row.days;
    const cny = row.rate > 0 ? Math.round(totalTwd / row.rate) : 0;
    const r = suggestWeights(stateForSuggest, products, adsForSuggest, ym, {
      start_date: row.start,
      end_date: row.end,
      amortize_days: row.days,
      daily_amort_twd: totalDaily,
    });
    // suggestWeights 沒給有效 weights 時降級用 gap 比例
    let weights = r.weights;
    if (!weights || Object.keys(weights).length === 0) {
      weights = {};
      const keys = Object.keys(gaps);
      let acc = 0;
      for (let i = 0; i < keys.length - 1; i++) {
        weights[keys[i]] = Math.round((gaps[keys[i]] / totalDaily) * 100);
        acc += weights[keys[i]];
      }
      if (keys.length > 0) weights[keys[keys.length - 1]] = 100 - acc;
    }
    return { amount_cny_suggest: cny, daily_twd: totalDaily, weights, reasons: r.reasons };
  }

  // 有金額 → 直接算建議權重
  const dailyTwd = (row.amount_cny * row.rate) / row.days;
  const r = suggestWeights(stateForSuggest, products, adsForSuggest, ym, {
    start_date: row.start,
    end_date: row.end,
    amortize_days: row.days,
    daily_amort_twd: dailyTwd,
  });
  return { amount_cny_suggest: row.amount_cny, daily_twd: dailyTwd, weights: r.weights, reasons: r.reasons };
}

// ── render entry ──────────────────────────────────────────────────
export function render(root) {
  const state = getState();
  ensureInit(state);

  // 從 sessionStorage 接收外部頁面的預填日期(例:廣告調整建議 → 前往採買建議)
  const prefillDate = sessionStorage.getItem("buyads_reverse_prefill_date");
  if (prefillDate) {
    sessionStorage.removeItem("buyads_reverse_prefill_date");
    const today = todayTaipei();
    if (prefillDate >= today && rows[0]) {
      rows[0].start = prefillDate;
      rows[0].end = addDays(prefillDate, rows[0].days || 30);
    }
  }

  doRender(root);
}

function doRender(root) {
  const state = getState();
  const products = state.products;
  const today = todayTaipei();
  // 採買筆通常落在當月 — 用「第一筆的 start 月份」當主 ym
  const primaryYM = rows[0] ? monthOf(rows[0].start) : state.settings.current_month;
  const scenario = scenarioFor(state, primaryYM);
  const scenarioAds = scenario.state.ads;

  // 為每一筆預先算建議(畫面要用)
  const suggestions = rows.map((_, idx) => computeRowSuggestion(state, products, scenarioAds, idx));

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>採買建議</h1>
        <div class="desc">建立多筆採買 → 上方累積看每個產品日花費怎麼變;中段卡片可改權重與金額;留空的筆會自動算出建議 RMB;下方 tab 切「當月 / 下月」看模擬攤提。</div>
      </div>
    </div>

    ${renderSummaryTable(state, products, scenarioAds, today)}

    <div class="card">
      <div class="card-head">
        <h2>採買筆數(可任意增減)</h2>
        <div style="display:flex;gap:8px">
          <button class="link-btn" id="rev-add-row">⊕ 新增一筆</button>
        </div>
      </div>
      <div id="rev-rows">
        ${rows.map((_, idx) => renderRowCard(state, products, idx, suggestions[idx])).join("")}
      </div>
      <div class="hint" style="margin-top:8px">
        <strong>運作邏輯:</strong>
        ① 金額 / 起迄 / 匯率 / 攤提天數 = 這支廣告的基本資料(改起迄會自動帶攤提天數);
        ② 權重 = 該筆要分給哪些產品(可自由改);
        ③ 留空的金額會自動算「補上多少 RMB 能讓所有產品都到達日目標」,按「採用建議」就帶入。
      </div>
    </div>

    ${renderAmortGridCard(state, products, scenarioAds, today)}
  `;

  bindHandlers(root);
}

// ── Summary table ──────────────────────────────────────────────────
function renderSummaryTable(state, products, scenarioAds, today) {
  const primaryYM = rows[0] ? monthOf(rows[0].start) : state.settings.current_month;
  const monthDays = daysInMonth(primaryYM);

  // 目標 = 每日目標
  //   APP:月預算 ÷ 當月天數
  //   小島:本月最新一段的日預算(多段時不平均,直接取最後 — 例 5/1=5000,5/6=6000 → 6000)
  const targets = {};
  for (const p of products) {
    if (p.type === "island") {
      const latest = getLatestBudget(state, p.id, primaryYM);  // 島:amount 即日預算
      if (latest != null) {
        targets[p.id] = latest;
      } else {
        // legacy fallback:沒任何預算紀錄
        const monthly = getMonthlyBudget(state, p.id, primaryYM);
        targets[p.id] = monthly ? monthly / monthDays : null;
      }
    } else {
      const monthly = getMonthlyBudget(state, p.id, primaryYM);
      targets[p.id] = monthly ? monthly / monthDays : null;
    }
  }

  // 每一筆的「該筆 start 當天累積花費」(含該筆 + 之前所有筆 + 既有)
  const accSpendByRow = rows.map((_, idx) => spendAtRowStart(scenarioAds, idx));

  const productHeaders = products.map((p) => `
    <th class="num">${esc(p.name)} <span class="pill ${p.type === "app" ? "app" : "island"}" style="font-weight:400;font-size:10px">${p.type === "app" ? "APP" : "島"}</span></th>
  `).join("");

  const targetCells = products.map((p) => {
    const t = targets[p.id];
    if (!t) return `<td class="num ink-3">—</td>`;
    let sub;
    if (p.type === "island") {
      sub = `日預算`;
    } else {
      const monthly = getMonthlyBudget(state, p.id, primaryYM);
      sub = `月 ${Math.round((monthly || 0) / 1000)}k`;
    }
    return `<td class="num">${Math.round(t).toLocaleString()}<div class="target-sub">${sub}</div></td>`;
  }).join("");

  const rowCells = rows.map((row, idx) => {
    const spend = accSpendByRow[idx];
    const isEmpty = !row.amount_cny;
    const cells = products.map((p) => {
      const v = spend[p.id] || 0;
      const target = targets[p.id] || 0;
      const contrib = contribForRow(row, row.start)[p.id] || 0;
      const cls = isEmpty || !target ? "" :
        (v < target * 0.85 ? "cell-under" : v > target * 1.15 ? "cell-over" : v >= target * 0.95 ? "cell-ok" : "");
      const cellFinal = idx === rows.length - 1 ? "cell-final" : "";
      const delta = (!isEmpty && contrib > 0.5) ? `<div class="delta-mini">+${Math.round(contrib).toLocaleString()}</div>` : "";
      const cellContent = isEmpty ? "—" : Math.round(v).toLocaleString();
      return `<td class="num ${cls} ${cellFinal}">${cellContent}${delta}</td>`;
    }).join("");
    const tag = isEmpty ? '<span class="pill warn" style="font-size:10px;margin-left:4px">留空</span>' : "";
    return `<tr><td><strong>+ 第 ${idx + 1} 筆</strong><div class="ink-3" style="font-size:10.5px">${row.start.slice(5)} 當天</div>${tag}</td>${cells}</tr>`;
  }).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>各產品日花費 — 累積每一筆後的影響</h2>
        <div class="ink-3" style="font-size:12px">每格 = 該筆 start_date 當天加入後的日花費;小綠字 = 該筆貢獻</div>
      </div>
      <div class="table-wrap">
        <table class="rev-summary-table">
          <thead>
            <tr>
              <th class="step-col">步驟</th>
              ${productHeaders}
            </tr>
          </thead>
          <tbody>
            <tr class="row-target">
              <td>每日目標<div class="ink-3" style="font-size:10.5px;font-weight:400">${primaryYM} · APP=月預算÷${monthDays}天、島=日預算</div></td>
              ${targetCells}
            </tr>
            ${rowCells}
          </tbody>
        </table>
      </div>
      <div class="ink-3" style="font-size:11px;margin-top:8px">
        <span class="cell-under" style="font-family:var(--mono)">紅</span> 低於目標 ·
        <span class="cell-ok" style="font-family:var(--mono)">綠</span> 接近 / 達標 ·
        <span class="cell-over" style="font-family:var(--mono)">橘</span> 超過目標。
      </div>
    </div>
  `;
}

// ── Row card ──────────────────────────────────────────────────────
function renderRowCard(state, products, idx, suggestion) {
  const row = rows[idx];
  const isEmpty = !row.amount_cny;
  const totalTwd = (row.amount_cny || 0) * row.rate;
  const dailyTwd = isEmpty ? (suggestion.daily_twd || 0) : (totalTwd / row.days);
  const wSum = Object.values(row.weights || {}).reduce((a, b) => a + Number(b || 0), 0);
  const wSumOk = Math.abs(wSum - 100) < 0.5;

  // 權重展示來源:有金額時用使用者編輯的 weights;沒金額時用 suggestion.weights(預覽,不可改)
  const displayWeights = isEmpty ? (suggestion.weights || {}) : (row.weights || {});

  return `
    <div class="row-card ${isEmpty ? "empty-amount" : ""}">
      <div class="row-card-top">
        <div class="row-card-title">
          <span class="row-no">${idx + 1}</span>
          <span>第 ${idx + 1} 筆採買</span>
          ${isEmpty ? '<span class="pill warn">金額留空</span>' : ''}
        </div>
        <button class="remove-btn" data-remove="${idx}" title="刪除這筆">✕</button>
      </div>
      <div class="row-card-body">
        <div class="row-card-inputs">
          <div class="field">
            <label>金額 (RMB)</label>
            <input type="number" step="any" value="${row.amount_cny ?? ""}" placeholder="留空 = 建議" data-row="${idx}" data-key="amount_cny" />
          </div>
          <div class="field">
            <label>開始日</label>
            <input type="date" value="${row.start}" data-row="${idx}" data-key="start" min="${todayTaipei()}" />
          </div>
          <div class="field">
            <label>結束日(不含)</label>
            <input type="date" value="${row.end}" data-row="${idx}" data-key="end" min="${todayTaipei()}" />
          </div>
          <div class="field">
            <label>匯率</label>
            <input type="number" step="0.01" value="${row.rate}" data-row="${idx}" data-key="rate" />
          </div>
          <div class="field">
            <label>攤提天數</label>
            <input type="number" value="${row.days}" data-row="${idx}" data-key="days" min="1" max="365" />
          </div>
        </div>
        <div class="compute-line">
          ${isEmpty
            ? '<span class="ink-3">金額留空,見下方系統建議</span>'
            : `總額 <strong>${Math.round(totalTwd).toLocaleString()}</strong> TWD <span class="ink-3">·</span> 每日攤提 <strong>${Math.round(dailyTwd).toLocaleString()}</strong> TWD/日`
          }
        </div>

        ${isEmpty && suggestion.amount_cny_suggest > 0 ? `
          <div class="rev-empty-suggest">
            <span class="suggest-tag">💡 系統建議</span>
            <span class="suggest-desc">把所有產品補到日目標需要 <span class="suggest-num">${suggestion.amount_cny_suggest.toLocaleString()} RMB</span>(每日攤提約 ${Math.round(suggestion.daily_twd).toLocaleString()} TWD)</span>
            <button class="primary" data-adopt="${idx}">採用建議</button>
          </div>
        ` : isEmpty ? `
          <div class="rev-empty-suggest" style="border-color:#cfd5e0;background:#f7f9fc">
            <span class="ink-3">${suggestion.reasons && suggestion.reasons[0] ? esc(suggestion.reasons[0]) : "目前無建議"}</span>
          </div>
        ` : ""}

        <div class="weights-section">
          <div class="weights-head">
            <span class="weights-title">權重分配</span>
            ${!isEmpty ? `
              <span class="weights-sum-inline">加總 <span class="sum-val ${wSumOk ? "ok" : "bad"}">${Math.round(wSum * 10) / 10}%</span></span>
            ` : `
              <span class="ink-3" style="font-size:12px">(系統預估,採用建議後可編輯)</span>
            `}
            <span class="spacer"></span>
            ${!isEmpty ? `<button class="link-btn" data-rebalance="${idx}">⚖ 重新建議</button>` : ""}
            ${!isEmpty ? `<button class="primary" data-create-row="${idx}" style="margin-left:8px">📋 建立廣告</button>` : ""}
          </div>
          <div class="weights-grid">
            ${products.map((p) => {
              const w = Number(displayWeights[p.id] || 0);
              const shareTwd = dailyTwd * (w / 100);
              return `
                <div class="weight-cell ${w === 0 ? "zero" : ""}">
                  <span class="pname" title="${esc(p.name)}">${esc(p.name)}</span>
                  <div class="input-wrap">
                    <input type="number" step="0.1" value="${w}" data-row="${idx}" data-w-pid="${esc(p.id)}" ${isEmpty ? "disabled" : ""} />
                    <span class="pct">%</span>
                  </div>
                  <div class="share-twd">${shareTwd > 0.5 ? Math.round(shareTwd).toLocaleString() + " TWD/日" : "—"}</div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Amort grid card ────────────────────────────────────────────────
function renderAmortGridCard(state, products, scenarioAds, today) {
  const primaryYM = rows[0] ? monthOf(rows[0].start) : state.settings.current_month;
  const ymNext = nextMonthYM(primaryYM);
  const ym = viewMonth === "next" ? ymNext : primaryYM;

  const fakeAds = rows.map((r) => makePreviewAd(r)).filter(Boolean);

  // 月份 grid 計算
  // renewal 模式時 scenarioAds 已經有續費 projection。若切到「next month」,需要對 next month 也跑一次 projection。
  let monthAds = scenarioAds;
  if (viewMonth === "next" && spendScenario === "renewal") {
    const nextProj = projectAdsWithRenewals(state, ymNext, { fromDate: today, excludePoorPerf: true });
    monthAds = nextProj.ads;
  } else if (viewMonth === "next") {
    monthAds = state.ads;
  }

  const grid = dailySpendGrid([...monthAds, ...fakeAds], ym);
  const monthDays = [...daysOfMonth(ym)];
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(state, p, ym)]));

  const monthTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  let grandTotal = 0;

  const headerCells = products.map((p) => {
    const target = getTargetDailyBudget(state, p.id, ym);
    const sub = target != null
      ? `<div class="ink-3" style="font-size:10px;font-weight:400">${Math.round(target).toLocaleString()}/日</div>`
      : "";
    return `<th class="num">${esc(p.name)}${sub}</th>`;
  }).join("");

  const bodyRows = monthDays.map((d) => {
    const row = grid[d] || {};
    // 新採買貢獻明細
    const newContrib = {};
    for (const fad of fakeAds) {
      const per = dailySpendForAd(fad, d);
      for (const [pid, v] of Object.entries(per)) newContrib[pid] = (newContrib[pid] || 0) + v;
    }
    const isInBuyPeriod = fakeAds.some((fad) => d >= fad.start_date && d < fad.end_date);
    let dayTotal = 0;
    const cells = products.map((p) => {
      const amt = row[p.id] || 0;
      dayTotal += amt;
      monthTotals[p.id] += amt;
      const b = dayBandsByPid[p.id]?.[d];
      const isFuture = d >= today;
      const checkBand = isFuture && b && b.budget_set && !isNoBand(p) && amt > 0;
      const amtRounded = Math.round(amt);
      const isUnder = checkBand && amtRounded < Math.round(b.lower);
      const isOver = checkBand && amtRounded > Math.round(b.upper);
      const newAmt = newContrib[p.id] || 0;
      const cls = `num ${isUnder ? "dg-under-band" : ""} ${isOver ? "dg-over-band" : ""} ${d < today ? "dg-past" : ""} ${newAmt > 0 ? "dg-new-contrib" : ""}`;
      const deltaBadge = newAmt > 0
        ? `<div style="font-size:10px;color:var(--ok);font-weight:600">+${Math.round(newAmt).toLocaleString()}</div>`
        : "";
      return `<td class="${cls}">${amt ? Math.round(amt).toLocaleString() : '<span class="ink-3">—</span>'}${deltaBadge}</td>`;
    }).join("");
    grandTotal += dayTotal;
    const todayCls = d === today ? " dg-today" : "";
    const buyPeriodCls = isInBuyPeriod ? " dg-in-buy-period" : "";
    return `<tr class="${(todayCls + buyPeriodCls).trim()}">
      <td class="mono">${d.slice(5)}${d === today ? " <span class='pill' style='font-size:10px;padding:0 4px;margin-left:2px;background:#111;color:#fff'>今天</span>" : ""}${isInBuyPeriod ? " <span class='ink-3' style='font-size:10px'>·新</span>" : ""}</td>
      ${cells}
      <td class="num"><strong>${Math.round(dayTotal).toLocaleString()}</strong></td>
    </tr>`;
  }).join("");

  const footerCells = products.map((p) => {
    const total = monthTotals[p.id];
    const budget = getMonthlyBudget(state, p.id, ym) || 0;
    const diff = total - budget;
    const diffClass = !budget ? "ink-3" : diff > 10000 ? "bad" : diff > 0 ? "warn" : -diff > 20000 ? "warn" : "ok";
    return `<td class="num dg-foot">
      <strong>${Math.round(total).toLocaleString()}</strong>
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const heading = `採買後每日攤提(${ym},台幣)`;
  const scenarioLabel = spendScenario === "renewal" ? "續費預估" : "實際資料";
  const subhint = fakeAds.length > 0
    ? `淡綠底 = 採買筆攤提區間;綠 +N = 當日新增貢獻;紅字 = 低於下限;橘字 = 超過上限。${scenarioLabel}模式。`
    : `沒有有效採買筆,下表只顯示${scenarioLabel}的既有攤提分布。`;

  return `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>${heading}</h2>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="ink-3" style="font-size:12px">攤提模式:</span>
          <button class="filter-chip ${spendScenario === "renewal" ? "active" : ""}" data-spend-scenario="renewal">續費預估</button>
          <button class="filter-chip ${spendScenario === "actual" ? "active" : ""}" data-spend-scenario="actual">實際資料</button>
        </div>
      </div>
      <div class="tabs" style="margin-bottom:10px">
        <button class="tab ${viewMonth === "current" ? "active" : ""}" data-view-month="current">當月(${primaryYM})</button>
        <button class="tab ${viewMonth === "next" ? "active" : ""}" data-view-month="next">下月(${ymNext})</button>
      </div>
      <div class="ink-3" style="font-size:12px;margin-bottom:6px">${subhint}</div>
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

// ── 事件 ──────────────────────────────────────────────────────────
function bindHandlers(root) {
  // 採買模式 chip
  root.querySelectorAll("[data-spend-scenario]").forEach((el) => {
    el.onclick = () => { spendScenario = el.dataset.spendScenario; doRender(root); };
  });
  // 月份 tab
  root.querySelectorAll("[data-view-month]").forEach((el) => {
    el.onclick = () => { viewMonth = el.dataset.viewMonth; doRender(root); };
  });
  // 輸入欄(amount/start/end/rate/days)
  root.querySelectorAll("[data-row][data-key]").forEach((el) => {
    el.onchange = () => {
      const i = Number(el.dataset.row);
      const k = el.dataset.key;
      if (!rows[i]) return;
      const today = todayTaipei();
      let v = el.value;
      if (k === "amount_cny") {
        v = v === "" || v == null ? null : Number(v);
        if (Number.isNaN(v)) v = null;
        const wasEmpty = !rows[i].amount_cny;
        rows[i].amount_cny = v;
        // 從空→有金額:若 weights 為空就用建議自動填
        if (wasEmpty && v && Object.keys(rows[i].weights || {}).length === 0) {
          const state = getState();
          const primaryYM = monthOf(rows[i].start);
          const scenario = scenarioFor(state, primaryYM);
          const sug = computeRowSuggestion(state, state.products, scenario.state.ads, i);
          rows[i].weights = { ...(sug.weights || {}) };
        }
      } else if (k === "rate" || k === "days") {
        v = Number(v) || 0;
        rows[i][k] = v;
      } else {
        rows[i][k] = v;
      }
      // 起迄變動 → 自動算攤提天數
      if (k === "start" || k === "end") {
        if (rows[i].start < today) rows[i].start = today;
        if (rows[i].end <= rows[i].start) rows[i].end = addDays(rows[i].start, rows[i].days || 30);
        rows[i].days = Math.max(1, diffDays(rows[i].start, rows[i].end));
      }
      doRender(root);
    };
  });
  // 權重 input
  root.querySelectorAll("[data-w-pid]").forEach((el) => {
    el.onchange = () => {
      const i = Number(el.dataset.row);
      const pid = el.dataset.wPid;
      if (!rows[i]) return;
      const v = Number(el.value) || 0;
      if (v === 0) delete rows[i].weights[pid];
      else rows[i].weights[pid] = v;
      doRender(root);
    };
  });
  // 移除筆
  root.querySelectorAll("[data-remove]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.remove);
      if (rows.length <= 1) {
        // 至少保留一筆
        const today = todayTaipei();
        const rate = getState().settings.expense_rate || 4.7;
        rows = [defaultRow(today, rate, 1)];
      } else {
        rows.splice(i, 1);
      }
      doRender(root);
    };
  });
  // 採用建議(empty row)
  root.querySelectorAll("[data-adopt]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.adopt);
      if (!rows[i]) return;
      const state = getState();
      const primaryYM = monthOf(rows[i].start);
      const scenario = scenarioFor(state, primaryYM);
      const sug = computeRowSuggestion(state, state.products, scenario.state.ads, i);
      if (sug.amount_cny_suggest > 0) {
        rows[i].amount_cny = sug.amount_cny_suggest;
        rows[i].weights = { ...(sug.weights || {}) };
      }
      doRender(root);
    };
  });
  // 重新建議權重
  root.querySelectorAll("[data-rebalance]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.rebalance);
      if (!rows[i]) return;
      const state = getState();
      const primaryYM = monthOf(rows[i].start);
      const scenario = scenarioFor(state, primaryYM);
      const sug = computeRowSuggestion(state, state.products, scenario.state.ads, i);
      rows[i].weights = { ...(sug.weights || {}) };
      doRender(root);
    };
  });
  // 新增筆
  const addBtn = root.querySelector("#rev-add-row");
  if (addBtn) {
    addBtn.onclick = () => {
      const today = todayTaipei();
      const rate = getState().settings.expense_rate || 4.7;
      rows.push(defaultRow(today, rate, rows.length));
      doRender(root);
    };
  }
  // 用這筆參數建立廣告
  root.querySelectorAll("[data-create-row]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.createRow);
      const row = rows[i];
      if (!row || !row.amount_cny) return;
      sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
        amount_cny: row.amount_cny,
        exchange_rate: row.rate,
        start_date: row.start,
        end_date: row.end,
        amortize_days: row.days,
        weights: { ...row.weights },
      }));
      location.hash = "#ads";
    };
  });
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
