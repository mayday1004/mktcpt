import { getState } from "../state.js";
import { suggestForDate, computeOverflowRangesForProduct } from "../domain/reverse.js";
import { suggestWeights } from "../domain/suggest.js";
import { dailySpendGrid, dailySpendForAd } from "../domain/spending.js";
import { addDays, monthOf, monthEnd, daysOfMonth, todayTaipei } from "../lib/dates.js";
import { getMonthlyBudget, isNoBand } from "../schema.js";
import { bandsForMonth } from "../domain/budget.js";
import { detectShortfalls } from "../domain/gift-days.js";
import { projectAdsWithRenewals, projectedDecisionState } from "../domain/renewal-projection.js";
import { openGiftDayFixModal } from "./gift-day-fix-modal.js";

let mode = "date";  // "date" | "amount"
let pickedDate = "";
let pickedPids = new Set();  // date-mode 多選產品 id
let amortizeDays = 30;

// amount-mode 表單值
let amtStart = "";
let amtEnd = "";
let amtDays = 30;
let amtCny = 0;
let spendScenario = "renewal";

const todayStr = todayTaipei;

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;
  const today = todayStr();

  // 從 sessionStorage 接收外部頁面的預填日期(例如「廣告調整建議」modal 點擊「前往採買建議」)
  const prefillDate = sessionStorage.getItem("buyads_reverse_prefill_date");
  if (prefillDate) {
    sessionStorage.removeItem("buyads_reverse_prefill_date");
    if (prefillDate >= today) {
      mode = "date";
      pickedDate = prefillDate;
    }
  }

  // 預設目標日 = 今天（若今日已過當月，仍以今日為準，使用者可自行往後挑）
  if (!pickedDate || pickedDate < today) pickedDate = today;
  if (!amtStart || amtStart < today) amtStart = today;
  if (!amtEnd || amtEnd <= amtStart) {
    amtEnd = addDays(amtStart, 30);
  }

  // 產品選擇器預設：第一個產品；同時清掉不存在的 pid
  for (const pid of [...pickedPids]) {
    if (!s.products.find((p) => p.id === pid)) pickedPids.delete(pid);
  }
  if (pickedPids.size === 0 && s.products[0]) {
    pickedPids = new Set([s.products[0].id]);
  }

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>採買建議</h1>
        <div class="desc">兩種模式:① 選日期 + 產品 → 算出該產品這天要補多少才補到位;② 給定一筆 RMB 金額與起迄 → 系統建議怎麼分產品權重</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab ${mode === "date" ? "active" : ""}" data-mode="date">依日期看可加空間</button>
      <button class="tab ${mode === "amount" ? "active" : ""}" data-mode="amount">依金額分配權重</button>
    </div>

    ${mode === "date" ? renderDateMode(s, ym) : renderAmountMode(s, ym)}
  `;

  bindHandlers(root);
}

function scenarioFor(state, ym) {
  if (spendScenario !== "renewal") {
    return { state, virtualRenewals: [], excludedPoorPerf: [] };
  }
  const projection = projectAdsWithRenewals(state, ym, { fromDate: todayStr(), excludePoorPerf: true });
  return {
    state: { ...state, ads: projection.ads },
    virtualRenewals: projection.virtualRenewals,
    excludedPoorPerf: projection.excludedPoorPerf,
  };
}

function renderScenarioChips() {
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <span class="ink-3" style="font-size:12px">攤提模式：</span>
      <button class="filter-chip ${spendScenario === "renewal" ? "active" : ""}" data-spend-scenario="renewal">續費預估</button>
      <button class="filter-chip ${spendScenario === "actual" ? "active" : ""}" data-spend-scenario="actual">實際資料</button>
    </div>
  `;
}

function renderScenarioHint(scenario, excludedUnique = []) {
  const parts = [];
  if (spendScenario === "renewal") {
    parts.push(`已把今日後到期、且未淘汰/非成效全爛的廣告當作會續費計算;預估續費段 ${uniqueByCode(scenario.virtualRenewals).length} 支`);
  } else {
    parts.push("只用已存在廣告段計算;未手動續費的廣告到期後停止攤提");
  }
  if (excludedUnique.length > 0) {
    parts.push(`排除成效全爛 ${excludedUnique.length} 支:${esc(excludedUnique.map((a) => a.ad_name || a.ad_code).slice(0, 3).join("、"))}${excludedUnique.length > 3 ? `…等 ${excludedUnique.length} 支` : ""}`);
  }
  return `<div class="hint" style="margin-bottom:12px">${parts.join("；")}</div>`;
}

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

// ── Mode 1: 依日期看可加空間 ───────────────────────────────────────
function renderDateMode(s, ym) {
  const rate = s.settings.expense_rate;
  const today = todayStr();
  if (pickedDate < today) pickedDate = today;
  const scenario = scenarioFor(s, monthOf(pickedDate));
  const cards = suggestForDate(scenario.state, pickedDate, rate, amortizeDays);
  const selected = cards.filter((c) => pickedPids.has(c.product.id));

  // 產品 chip 列：多選；每個 chip 旁顯示該產品當日可加的簡短摘要
  const chips = s.products.map((p) => {
    const c = cards.find((x) => x.product.id === p.id);
    const isActive = pickedPids.has(p.id);
    let badge = "";
    if (c) {
      if (c.kind === "ok" && c.suggestTwd > 0) badge = `<span class="ink-3" style="margin-left:4px">+${Math.round(c.suggestTwd).toLocaleString()}</span>`;
      else if (c.kind === "full") badge = `<span class="ink-3" style="margin-left:4px">滿</span>`;
      else if (c.kind === "empty") badge = `<span class="ink-3" style="margin-left:4px">—</span>`;
    }
    return `<button class="filter-chip ${isActive ? "active" : ""}" data-rev-pid="${esc(p.id)}">${esc(p.name)}${badge}</button>`;
  }).join("");

  // 與「依金額」對齊:baseline 已排除成效全爛廣告(不會續費)。同支廣告不分產品視為一組。
  const excludedSeen = new Set();
  const excludedUnique = [];
  for (const a of [...(cards.excludedPoorPerf || []), ...(scenario.excludedPoorPerf || [])]) {
    const key = a.ad_code || a.id;
    if (excludedSeen.has(key)) continue;
    excludedSeen.add(key);
    excludedUnique.push(a);
  }
  const excludedHint = renderScenarioHint(scenario, excludedUnique);

  let cardHtml;
  if (selected.length === 0) {
    cardHtml = `<div class="card"><p class="ink-2">請至少選一個產品（可多選）。</p></div>`;
  } else if (selected.length === 1) {
    cardHtml = renderDateCardLarge(selected[0], amortizeDays, rate);
  } else {
    cardHtml = renderDateCombinedCard(selected, amortizeDays, rate, scenario.state);
  }

  return `
    <div class="rev-controls">
      <div class="field" style="min-width:160px">
        <label>目標日期（當日或未來）</label>
        <input id="rev-date" type="date" value="${pickedDate}" min="${today}" />
      </div>
      <div class="field" style="min-width:140px">
        <label>支出匯率</label>
        <input id="rev-rate" type="number" step="0.01" value="${rate}" disabled />
        <div class="hint">在「設定」頁修改</div>
      </div>
      <div class="field" style="min-width:120px">
        <label>預期攤提天數</label>
        <input id="rev-days" type="number" value="${amortizeDays}" min="1" max="180" />
        <div class="hint">用於估算 RMB 採買額（單日 × 攤提天）</div>
      </div>
    </div>

    ${renderGapWarningForDate(s, pickedDate)}
    ${excludedHint}

    <div class="filter-row" style="margin-bottom:12px">
      <span class="ink-3" style="font-size:12px">產品（可多選）：</span>
      ${chips}
      ${pickedPids.size > 0 ? `<button class="link-btn" id="rev-clear-pids" style="margin-left:auto">清除選擇</button>` : ""}
    </div>

    ${cardHtml}
  `;
}

// 多選產品：合計可加空間 + 自動分權重（依 suggestTwd 比例）
// 「已補到位」(kind != ok 或 suggestTwd <= 0) 的產品自動排除分配，但仍列出原因。
function renderDateCombinedCard(cards, days, rate, state) {
  const usable = cards.filter((c) => c.kind === "ok" && c.suggestTwd > 0);
  const skipped = cards.filter((c) => !(c.kind === "ok" && c.suggestTwd > 0));

  if (usable.length === 0) {
    return `
      <div class="card">
        <h2>合計可加空間</h2>
        <p class="ink-2">所選產品都沒有可加空間。</p>
        ${renderSkippedList(skipped)}
      </div>
      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: 0,
        weights: {},
      })}
    `;
  }

  const totalDailyTwd = usable.reduce((s, c) => s + c.suggestTwd, 0);
  const totalTwd = totalDailyTwd * days;
  const totalCny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  // 用 2 位小數權重避免「APP uncapped 大、小島 capped 小」混選時整數四捨五入
  // 把小島權重向上推、dailyShare 因而超過小島自己的 suggestTwd / upper
  const weights = computeIntegerWeights(usable.map((c) => ({ id: c.product.id, value: c.suggestTwd })), 2);

  // 偵測:被分配權重後仍補不到下限的產品(可能是 period binding 卡到 baseline 突增日)
  // APP / no_band 不檢查日帶寬,跳過此偵測
  const cantFillCards = usable.filter((c) => {
    if (!!c.skipBand || !c.band || c.band.lower <= 0) return false;
    const w = weights[c.product.id] || 0;
    const dailyShare = totalDailyTwd * (w / 100);
    return (c.todaySpent || 0) + dailyShare < c.band.lower;
  });

  // 偵測:APP / no_band 加完 dailyShare 後攤提期內哪些天會超過 upper
  // 用 dailyShare 重算(suggestTwd 是「該產品 100% 採買」的值,跟多選分權後不一樣)
  const overflowItems = state
    ? usable
        .filter((c) => !!c.skipBand)
        .map((c) => {
          const w = weights[c.product.id] || 0;
          const dailyShare = totalDailyTwd * (w / 100);
          return {
            product: c.product,
            ranges: computeOverflowRangesForProduct(state, c.product, pickedDate, days, dailyShare),
          };
        })
        .filter((it) => it.ranges.length > 0)
    : [];

  return `
    <div class="card">
      <div class="card-head">
        <h2>${usable.length} 個產品 — 合計可加空間</h2>
        <button class="primary" id="date-create-multi">📋 用此參數建立廣告</button>
      </div>

      <div class="rev-hero">
        <div class="rev-hero-num">${Math.round(totalDailyTwd).toLocaleString()} <span class="rev-hero-unit">TWD/日</span></div>
        <div class="rev-hero-sub">
          ${pickedDate} 起，買 ${days} 天廣告 → <strong>${totalCny.toLocaleString()}</strong> RMB（${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
        </div>
        <div class="rev-hero-limits">
          ${usable.map((c) => {
            const w = weights[c.product.id] || 0;
            const dailyShare = totalDailyTwd * (w / 100);
            const hint = c.skipBand
              ? `<span class="ink-3" style="font-size:11px">(不檢查日帶寬)</span>`
              : `<span class="ink-3" style="font-size:11px">(最緊 ${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span>`;
            return `<div><strong>${esc(c.product.name)} ${w}%</strong> — ${Math.round(dailyShare).toLocaleString()} TWD/日 ${hint}</div>`;
          }).join("")}
        </div>
      </div>

      ${renderOverflowCallout(overflowItems)}

      ${cantFillCards.length > 0 ? `
        <div class="rev-callout-perf-adjust">
          <div style="font-weight:600;color:var(--warn)">⚠️ 有 ${cantFillCards.length} 個產品補不到建議下限</div>
          <div class="ink-2" style="font-size:13px;margin-top:6px;line-height:1.6">
            ${cantFillCards.map((c) => {
              const w = weights[c.product.id] || 0;
              const dailyShare = totalDailyTwd * (w / 100);
              const stillShort = Math.round(c.band.lower - (c.todaySpent + dailyShare));
              return `<div>• <strong>${esc(c.product.name)}</strong>:分到 ${Math.round(dailyShare).toLocaleString()} TWD/日,加完仍缺 ${stillShort.toLocaleString()} TWD/日(攤提區間最緊在 ${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "?"})</div>`;
            }).join("")}
            <br>
            <strong>實務上能做的:</strong>
            <ul style="margin:4px 0 0;padding-left:20px">
              <li>找願意做短期(一個月以內)的廣告主直接採買 — 這種廣告要碰運氣</li>
              <li>接受這幾天少花 — 如果是空檔期(舊廣告剛結束、新廣告還沒上),這就是市場限制造成的少花</li>
              <li>在最緊那天起做權重調整,把佔住 baseline 的廣告分一些給其他短缺產品</li>
            </ul>
          </div>
        </div>
      ` : ""}

      <details class="rev-details">
        <summary>各產品限制細節</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          ${usable.map((c) => {
            const w = weights[c.product.id] || 0;
            const dailyShare = totalDailyTwd * (w / 100);
            return `
              <div class="rev-card">
                <h3>
                  <span>${esc(c.product.name)}</span>
                  <span class="pill ${c.product.type}" style="font-weight:400;font-size:11px;margin-left:4px">${c.product.type === "app" ? "APP" : "小島"}</span>
                  <span class="pill" style="font-size:14px;margin-left:auto">${w}%</span>
                </h3>
                <div class="rev-row"><span class="label">月剩餘 / ${c.daysToMonthEnd} 天</span><span class="val">${Math.round(c.monthRemainPerDay || 0).toLocaleString()}/日</span></div>
                ${c.skipBand
                  ? `<div class="rev-row"><span class="label">攤提區間最緊</span><span class="val ink-3" style="font-size:11px">不檢查日帶寬</span></div>`
                  : `<div class="rev-row"><span class="label">攤提區間最緊</span><span class="val">${Math.round(c.minHeadroomInPeriod || 0).toLocaleString()}<span class="ink-3" style="font-size:11px"> (${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span></span></div>`
                }
                <div class="rev-row"><span class="label">分到 daily</span><span class="val"><strong>${Math.round(dailyShare).toLocaleString()}</strong></span></div>
              </div>
            `;
          }).join("")}
        </div>
      </details>

      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: totalDailyTwd,
        weights,
      })}

      ${renderSkippedList(skipped)}
    </div>
  `;
}

// APP / no_band 因不檢查日帶寬,suggest 可能造成攤提期某些天超過 upper。
// 列出超過區間,讓使用者決定要不要改採買日(提早 / 延後)避開。
// items: [{ product, ranges: [{ start, end, days, minDaily, maxDaily, upper }, ...] }, ...]
function renderOverflowCallout(items) {
  const filtered = items.filter((it) => it.ranges && it.ranges.length > 0);
  if (filtered.length === 0) return "";
  const showProductName = filtered.length > 1;
  const lines = filtered.flatMap((it) => it.ranges.map((r) => {
    const prefix = showProductName ? `<strong>${esc(it.product.name)}</strong>:` : "";
    const dateRange = r.start === r.end ? r.start.slice(5) : `${r.start.slice(5)} ~ ${r.end.slice(5)}`;
    const amountRange = r.minDaily === r.maxDaily
      ? `約 ${Math.round(r.minDaily).toLocaleString()} TWD/日`
      : `約 ${Math.round(r.minDaily).toLocaleString()} ~ ${Math.round(r.maxDaily).toLocaleString()} TWD/日`;
    return `<div>• ${prefix}${dateRange}(${r.days} 天)${amountRange}(上限 ${Math.round(r.upper).toLocaleString()})</div>`;
  })).join("");
  return `
    <div class="rev-callout-perf-adjust">
      <div style="font-weight:600;color:var(--warn)">⚠️ 預估會超過建議日花費上限</div>
      <div class="ink-2" style="font-size:13px;margin-top:6px;line-height:1.7">
        ${lines}
        <br>
        <strong>想避開的話可以:</strong>
        <ul style="margin:4px 0 0;padding-left:20px">
          <li>提早幾天買 → 攤提期更早結束,跨月那段變短</li>
          <li>延後到下月初再買 → 攤提整個落在下月</li>
        </ul>
      </div>
    </div>
  `;
}

function renderSkippedList(skipped) {
  if (!skipped || skipped.length === 0) return "";
  const items = skipped.map((c) => {
    const note = c.note || (c.kind === "full" ? "已補到位" : c.kind === "empty" ? "未設預算" : "無可加空間");
    return `<li><strong>${esc(c.product.name)}</strong> — ${esc(note)}</li>`;
  }).join("");
  return `
    <div class="hint" style="margin-top:14px;padding:10px 12px;background:#f7f9fc;border-radius:6px;font-size:12px">
      <strong>未納入分配的產品（${skipped.length}）：</strong>
      <ul style="margin:4px 0 0;padding-left:20px">${items}</ul>
    </div>
  `;
}

// 依 value 比例算權重，最後一筆收尾補到 100。
// decimals=0 → 整數%(舊行為);decimals=2 → 2 位小數,避免「APP 大、小島小」混選時整數
// 四捨五入讓小島 weight 略高於真實比例,造成 dailyShare 超過 upper。
function computeIntegerWeights(items, decimals = 0) {
  const total = items.reduce((s, x) => s + (Number(x.value) || 0), 0);
  const out = {};
  if (total <= 0 || items.length === 0) return out;
  const factor = Math.pow(10, decimals);
  const roundTo = (v) => Math.round(v * factor) / factor;
  let acc = 0;
  for (let i = 0; i < items.length - 1; i++) {
    out[items[i].id] = roundTo((Number(items[i].value) || 0) / total * 100);
    acc += out[items[i].id];
  }
  out[items[items.length - 1].id] = roundTo(100 - acc);
  return out;
}

// 大張卡片:選定產品 + 日期後顯示該產品的補貨建議
// 警示卡(CLAUDE.md §5.8.1 v2):
// 若 pickedDate 當天有任何產品的日花費 < 建議下限 → 顯示警示 + 一鍵調整按鈕
function renderGapWarningForDate(state, pickedDate) {
  const today = todayTaipei();
  // 用 projection state:跟概覽 / 權重調整頁的偵測對齊,只警示真實缺口
  const shortfalls = detectShortfalls(projectedDecisionState(state), today);
  const relevant = shortfalls.filter((sf) => sf.days.some((d) => d.date === pickedDate));
  if (relevant.length === 0) return "";
  const items = relevant.map((sf) => {
    const dayInfo = sf.days.find((d) => d.date === pickedDate);
    const typeBadge = sf.productType === "island"
      ? `<span class="pill bad" style="font-size:10px;margin-left:4px">小島</span>`
      : `<span class="pill warn" style="font-size:10px;margin-left:4px">APP</span>`;
    return `<li><strong>${esc(sf.productName)}</strong>${typeBadge} 當日缺 <strong>${Math.round(dayInfo.shortfall).toLocaleString()}</strong> TWD/日 <span class="ink-3" style="font-size:11px">(下限 ${Math.round(dayInfo.lower).toLocaleString()})</span></li>`;
  }).join("");
  return `
    <div class="card" style="border-left:3px solid var(--warn);background:#fffbf0;margin-bottom:12px">
      <div class="card-head">
        <h3 style="margin:0;font-size:14px">⚠️ 此日有產品日花費低於下限</h3>
        <button class="primary" id="rev-gd-fix-open">→ 一鍵調整</button>
      </div>
      <ul style="margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.7">${items}</ul>
    </div>
  `;
}

function renderDateCardLarge(c, days, rate) {
  if (c.budget == null) {
    return `
      <div class="card">
        <h2>${esc(c.product.name)} <span class="pill ${c.product.type}" style="font-weight:400">${c.product.type === "app" ? "APP" : "小島"}</span></h2>
        <p class="ink-2">尚未設定月預算 — 請到「產品」頁設定後再回來查看。</p>
      </div>
    `;
  }
  const usable = c.kind === "ok" && c.suggestTwd > 0;
  const totalTwd = c.suggestTwd * days;
  const totalCny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  // APP / no_band 不檢查日帶寬,只剩「月剩餘÷剩餘天數」一個 binding,不顯示較緊標籤
  const skipBand = !!c.skipBand;
  // 哪個是 binding constraint：月剩餘÷剩餘天數 vs 攤提區間最緊(只有小島才有意義)
  const monthBindingFirst = (c.monthRemainPerDay ?? Infinity) <= (c.minHeadroomInPeriod ?? Infinity);
  const monthBindingTag = (!skipBand && monthBindingFirst) ? `<span class="pill warn" style="font-size:10px;margin-left:4px">較緊</span>` : "";
  const periodBindingTag = (!skipBand && !monthBindingFirst) ? `<span class="pill warn" style="font-size:10px;margin-left:4px">較緊</span>` : "";

  // 偵測「採買建議仍補不到下限」(加完建議值後當日仍 < lower)
  // APP / no_band 不檢查日帶寬,跳過此提示
  const newDailyAfter = (c.todaySpent || 0) + (c.suggestTwd || 0);
  const cantFillToLower = usable && !skipBand && c.band && c.band.lower > 0 && newDailyAfter < c.band.lower;
  const shortfallToLower = cantFillToLower ? Math.round(c.band.lower - newDailyAfter) : 0;
  const calloutPeriodBinding = cantFillToLower && !monthBindingFirst;
  // 有短攤提方案可一鍵套用(避開 baseline 突增日)
  const hasShortFix = cantFillToLower && c.shortAmortize && c.shortSuggestTwd > c.suggestTwd;
  const shortNewDaily = hasShortFix ? (c.todaySpent + c.shortSuggestTwd) : 0;
  const shortFillsLower = hasShortFix && shortNewDaily >= c.band.lower;

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(c.product.name)} <span class="pill ${c.product.type}" style="font-weight:400">${c.product.type === "app" ? "APP" : "小島"}</span></h2>
        ${usable ? `<button class="primary" id="date-create">📋 用此參數建立廣告</button>` : ""}
      </div>

      ${usable ? `
        <div class="rev-hero">
          <div class="rev-hero-num">${Math.round(c.suggestTwd).toLocaleString()} <span class="rev-hero-unit">TWD/日</span></div>
          <div class="rev-hero-sub">
            買 ${days} 天廣告，本產品 100% 採買 → <strong>${totalCny.toLocaleString()}</strong> RMB（${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
          </div>
          <div class="rev-hero-limits">
            <div>月剩餘 ÷ 剩餘 ${c.daysToMonthEnd} 天 = <strong>${Math.round(c.monthRemainPerDay || 0).toLocaleString()}</strong>/日${monthBindingTag}</div>
            ${skipBand
              ? `<div class="ink-3" style="font-size:11px">${c.product.type === "app" ? "APP" : "破圈"} 不檢查日帶寬,只看月預算</div>`
              : `<div>攤提區間 ${c.amortizeDaysUsed} 天最緊 = <strong>${Math.round(c.minHeadroomInPeriod || 0).toLocaleString()}</strong>/日 <span class="ink-3">(${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span>${periodBindingTag}</div>`
            }
          </div>
        </div>
      ` : `
        <div class="rev-hero rev-hero-bad">
          <div class="rev-hero-num" style="color:var(--bad);font-size:18px">無可加空間</div>
          <div class="rev-hero-sub" style="color:var(--bad)">${esc(c.note || "—")}</div>
        </div>
      `}

      ${cantFillToLower ? `
        <div class="rev-callout-perf-adjust">
          <div style="font-weight:600;color:var(--warn)">⚠️ ${pickedDate.slice(5)} 補不到建議下限 — 還缺 ${shortfallToLower.toLocaleString()} TWD/日</div>
          <div class="ink-2" style="font-size:13px;margin-top:6px;line-height:1.6">
            ${calloutPeriodBinding ? `
              原因:你的 ${c.amortizeDaysUsed} 天攤提會跨進 <strong>${c.minHeadroomDay.slice(5)}</strong>,而那天的 ${esc(c.product.name)} baseline 已逼近建議花費上限(其他既有廣告佔住了)。新廣告每多加 1 元都會害 ${c.minHeadroomDay.slice(5)} 那天爆上限,所以建議值被壓到只剩 ${Math.round(c.suggestTwd).toLocaleString()} TWD/日。
              <br><br>
              <strong>實務上能做的:</strong>
              <ul style="margin:4px 0 0;padding-left:20px">
                <li>找到願意做短期(${c.shortAmortize ? c.shortAmortize : "<" + c.amortizeDaysUsed} 天以下)的廣告主直接採買 — 但這種短攤提廣告多半要碰運氣,不是常態</li>
                <li>接受 ${pickedDate.slice(5)} ~ ${c.minHeadroomDay.slice(5)} 前一天會略低於下限。如果這段是空檔(舊廣告剛結束、新廣告 ${c.minHeadroomDay.slice(5)} 才上),這就是市場限制造成的少花</li>
                <li>在 ${c.minHeadroomDay.slice(5)} 起做權重調整,把佔住 baseline 的那支廣告分一些給其他短缺產品(視具體 case)</li>
              </ul>
            ` : `
              原因:${esc(c.product.name)} 月預算所剩有限,平均到剩餘 ${c.daysToMonthEnd} 天只夠每日加 ${Math.round(c.suggestTwd).toLocaleString()} TWD。
              <br><br>
              <strong>實務上能做的:</strong>
              <ul style="margin:4px 0 0;padding-left:20px">
                <li>提高 ${esc(c.product.name)} 的月預算</li>
                <li>淘汰本月其他既有 ${esc(c.product.name)} 廣告以釋放預算</li>
                <li>接受月預算範圍內的少花</li>
              </ul>
            `}
          </div>
        </div>
      ` : ""}

      ${(usable && skipBand && c.overflowRanges && c.overflowRanges.length > 0) ? renderOverflowCallout([{ product: c.product, ranges: c.overflowRanges }]) : ""}

      <details class="rev-details">
        <summary>細節（月度／當日／建議花費值）</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          <div class="rev-card">
            <h3 style="margin-bottom:8px">月度</h3>
            <div class="rev-row"><span class="label">月預算</span><span class="val">${Math.round(c.budget).toLocaleString()}${c.budgetIsFallback ? `<div class="ink-3" style="font-size:11px">沿用最近月份（本月未設）</div>` : ""}</span></div>
            <div class="rev-row"><span class="label">月已花</span><span class="val">${Math.round(c.monthSpent).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">月剩餘</span><span class="val">${Math.round(c.monthRemaining).toLocaleString()}</span></div>
          </div>
          <div class="rev-card">
            <h3 style="margin-bottom:8px">${pickedDate} 當日</h3>
            <div class="rev-row"><span class="label">建議日花費上限</span><span class="val">${Math.round(c.band.upper).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">已配置</span><span class="val">${Math.round(c.todaySpent).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">當日尚可加</span><span class="val">${Math.round(c.todayHeadroom).toLocaleString()}</span></div>
          </div>
        </div>
      </details>

      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: c.suggestTwd,
        weights: { [c.product.id]: 100 },
      })}
    </div>
  `;
}

// 模擬「假設這筆新廣告買下去 + 所有現有廣告到期都續費」之後的整月每日攤提表。
//   - 對每個 ad_code 的最後一段，把 end_date 推到月底+1（沒淘汰才推）
//   - 加上代表新採買的 fakeAd（caller 提供 weights，可單產品 100% 或多產品分權重）
//   - 即使新採買無法成立（daily_amort_twd <= 0），仍顯示「續費後 baseline」表格，標題改寫
// 表格格式跟概覽頁的「每日攤提（台幣）」一致。
function renderSimulatedMonthGrid(fakeAdInput, scenario = null) {
  const s = getState();
  if (!fakeAdInput || !fakeAdInput.start_date) return "";

  const hasNewBuy = (fakeAdInput.daily_amort_twd || 0) > 0;
  const ym = monthOf(fakeAdInput.start_date);
  const today = todayTaipei();
  if (!scenario) scenario = scenarioFor(s, ym);

  // 不做 auto-renewal:跟「概覽 → 每日攤提」用同一份 state.ads,顯示「現有廣告 + 此筆新採買」
  // 的真實未來分布。如果某個廣告在月中就到期不續費,該日期之後就沒貢獻 — 這跟概覽一致。
  // (舊版會自動把每個 code 最新段的 end_date 推到月底,造成兩邊數字對不起來。)
  // 注意:「排除成效全爛廣告」只用在【建議金額】演算法(suggestForDate / suggestWeights),
  // 因為那是預測未來空間。但這個 grid 是【顯示實際分布】,要跟概覽 / 權重調整影響預覽一致,
  // 所以不能過濾 — 用全部 state.ads。
  const fakeAd = hasNewBuy
    ? { id: "preview_new_ad", ad_code: "_PREVIEW_", ad_name: "(預覽:新採買)", group: "preview", ...fakeAdInput }
    : null;
  const baseAds = scenario?.state?.ads || s.ads || [];
  const ads = hasNewBuy ? [...baseAds, fakeAd] : baseAds;
  const grid = dailySpendGrid(ads, ym);
  const products = s.products;
  const monthDays = [...daysOfMonth(ym)];
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(s, p, ym)]));

  const monthTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  let grandTotal = 0;

  const bodyRows = monthDays.map((d) => {
    const row = grid[d] || {};
    // 該日「新採買」貢獻明細(用來在格子顯示 +delta)
    const newContrib = fakeAd ? dailySpendForAd(fakeAd, d) : {};
    const isInBuyPeriod = fakeAd && d >= fakeAd.start_date && d < fakeAd.end_date;
    let dayTotal = 0;
    const cells = products.map((p) => {
      const amt = row[p.id] || 0;
      dayTotal += amt;
      monthTotals[p.id] += amt;
      const b = dayBandsByPid[p.id]?.[d];
      const isFuture = d >= today;
      const checkBand = isFuture && b && b.budget_set && !isNoBand(p) && amt > 0;
      // 比較用四捨五入後的整數,跟格子顯示對齊。否則 5025.0000001 > 5025 會把顯示「5025」標紅,讓使用者以為超過
      const amtRounded = Math.round(amt);
      const isUnder = checkBand && amtRounded < Math.round(b.lower);
      const isOver = checkBand && amtRounded > Math.round(b.upper);
      const newAmt = newContrib[p.id] || 0;
      const cls = `num ${isUnder ? "dg-under-band" : ""} ${isOver ? "dg-over-band" : ""} ${d < today ? "dg-past" : ""} ${newAmt > 0 ? "dg-new-contrib" : ""}`;
      const deltaBadge = newAmt > 0
        ? `<div style="font-size:10px;color:var(--ok);font-weight:600">+${Math.round(newAmt).toLocaleString()}</div>`
        : "";
      return `<td class="${cls}">${amt ? Math.round(amt).toLocaleString() : "<span class='ink-3'>—</span>"}${deltaBadge}</td>`;
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
    const budget = getMonthlyBudget(s, p.id, ym) || 0;
    const diff = total - budget;
    const diffClass = !budget ? "ink-3" : diff > 10000 ? "bad" : diff > 0 ? "warn" : -diff > 20000 ? "warn" : "ok";
    return `<td class="num dg-foot">
      <strong>${Math.round(total).toLocaleString()}</strong>
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const headerCells = products.map((p) => `<th class="num">${esc(p.name)}</th>`).join("");

  const heading = hasNewBuy
    ? `採買後每日攤提(${ym},台幣)`
    : `現有廣告每日攤提(${ym},台幣)`;
  const scenarioLabel = spendScenario === "renewal" ? "續費預估" : "實際資料";
  const subhint = hasNewBuy
    ? `假設此筆新廣告買下,加上${scenarioLabel}的既有攤提分布。淡綠底 = 此筆新採買的攤提區間,綠色 +N = 該日新增貢獻。紅色格 = 超出建議日花費上限。`
    : `這筆新採買沒有可加空間,下表只顯示${scenarioLabel}的既有攤提分布。`;

  return `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>${heading}</h2>
        ${renderScenarioChips()}
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


// ── Mode 2: 依金額分配權重 ─────────────────────────────────────────
function renderAmountMode(s, ym) {
  const rate = s.settings.expense_rate;
  const today = todayStr();
  const scenario = scenarioFor(s, monthOf(amtStart || today));
  // 採買只能往未來；amtStart 落在過去就強拉到今日
  if (amtStart && amtStart < today) amtStart = today;
  if (amtEnd && amtEnd <= amtStart) {
    amtEnd = addDays(amtStart, amtDays);
  }
  const amountTwd = (Number(amtCny) || 0) * rate;
  const dailyTwd = amtDays > 0 ? amountTwd / amtDays : 0;

  let suggested = null;
  let reasons = [];
  let candidates = [];
  let inMonthDays = 0;
  let inNextMonthDays = 0;
  let ymNext = "";
  if (amtCny > 0 && amtStart && amtEnd && amtDays > 0 && amtEnd > amtStart) {
    const fakeAd = {
      start_date: amtStart,
      end_date: amtEnd,
      amortize_days: amtDays,
      daily_amort_twd: dailyTwd,
    };
    const r = suggestWeights(scenario.state, s.products, scenario.state.ads, ym, fakeAd);
    suggested = r.weights;
    reasons = r.reasons;
    candidates = r.candidates || [];
    inMonthDays = r.inMonthDays || 0;
    inNextMonthDays = r.inNextMonthDays || 0;
    ymNext = r.ymNext || "";
  }

  const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
  const productOf = Object.fromEntries(s.products.map((p) => [p.id, p]));
  const candById = Object.fromEntries(candidates.map((c) => [c.p.id, c]));
  const excluded = candidates.filter((c) => c.excludeReason);
  const totalW = suggested ? Object.values(suggested).reduce((a, b) => a + b, 0) : 0;

  return `
    <div class="rev-controls">
      <div class="field" style="min-width:140px">
        <label>金額（RMB）</label>
        <input id="amt-cny" type="number" step="any" value="${amtCny || ""}" placeholder="例 90000" />
      </div>
      <div class="field" style="min-width:140px">
        <label>支出匯率</label>
        <input id="amt-rate" type="number" step="0.01" value="${rate}" disabled />
        <div class="hint">= ${Math.round(amountTwd).toLocaleString()} TWD</div>
      </div>
      <div class="field" style="min-width:140px">
        <label>開始日（當日或未來）</label>
        <input id="amt-start" type="date" value="${amtStart}" min="${today}" />
      </div>
      <div class="field" style="min-width:140px">
        <label>結束日（不含）</label>
        <input id="amt-end" type="date" value="${amtEnd}" min="${today}" />
      </div>
      <div class="field" style="min-width:120px">
        <label>攤提天數</label>
        <input id="amt-days" type="number" value="${amtDays}" min="1" max="180" />
        <div class="hint">每日攤提 = ${Math.round(dailyTwd).toLocaleString()} TWD</div>
      </div>
    </div>

    ${suggested == null ? `
      <div class="card"><p class="ink-2">填入金額、起訖、攤提天數後，系統會依各產品「剩餘預算」與「當日建議日花費剩餘空間」算出建議權重。</p></div>
    ` : Object.keys(suggested).length === 0 ? `
      <div class="card">
        <p class="ink-2" style="color:var(--bad)">無法給出建議：</p>
        <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </div>
      ${renderSimulatedMonthGrid({
        start_date: amtStart,
        end_date: amtEnd,
        amortize_days: amtDays,
        daily_amort_twd: 0,
        weights: {},
      }, scenario)}
    ` : `
      <div class="card">
        <div class="card-head">
          <h2>建議權重分配</h2>
          <button class="primary" id="amt-create">📋 用此參數建立廣告</button>
        </div>

        <div class="rev-hero">
          <div class="rev-hero-num">${Math.round(amountTwd).toLocaleString()} <span class="rev-hero-unit">TWD（${amtCny.toLocaleString()} RMB）</span></div>
          <div class="rev-hero-sub">
            ${amtStart} ~ ${amtEnd}（${amtDays} 天）→ 每日攤提 <strong>${Math.round(dailyTwd).toLocaleString()}</strong> TWD
          </div>
          <div class="rev-hero-limits">
            ${Object.entries(suggested).sort(([, a], [, b]) => b - a).map(([pid, w]) => {
              const dailyShare = dailyTwd * (w / 100);
              return `<div><strong>${esc(nameOf[pid] || pid)} ${w}%</strong> — ${Math.round(dailyShare).toLocaleString()} TWD/日</div>`;
            }).join("")}
          </div>
        </div>

        ${reasons.length ? `<div class="hint" style="margin-top:8px">${reasons.map((r) => esc(r)).join("；")}</div>` : ""}

        <details class="rev-details">
          <summary>各產品預算 / 建議花費值 細節</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          ${Object.entries(suggested)
            .sort(([, a], [, b]) => b - a)
            .map(([pid, w]) => {
              const dailyShare = dailyTwd * (w / 100);
              const totalShare = amountTwd * (w / 100);
              const cand = candById[pid];
              const monthContrib = dailyShare * inMonthDays;
              const monthSpent = cand?.spent || 0;
              const budget = cand?.budget;
              const projTotal = monthSpent + monthContrib;
              const fmt = (n) => Math.round(n).toLocaleString();

              // 本月：projTotal vs budget
              let thisMonthLine = "";
              if (budget != null && budget > 0) {
                const over = projTotal - budget;
                const cls = over > 0.5 ? "bad" : "ok";
                const sign = over > 0.5 ? `✗ +${fmt(over)}` : "✓";
                thisMonthLine = `<div class="rev-line"><span class="rev-k">本月</span><span class="rev-v ${cls}">${fmt(projTotal)} / ${fmt(budget)} ${sign}</span></div>`;
              }

              // 下月：baseline + nextContrib vs nextBudget
              let nextMonthLine = "";
              let cutLine = "";
              if (inNextMonthDays > 0 && cand?.nextBudgetAssumed != null && cand.nextBudgetAssumed > 0) {
                const nextContrib = dailyShare * inNextMonthDays;
                const baseline = cand.nextSpent || 0;
                const nextProj = baseline + nextContrib;
                const nextBudget = cand.nextBudgetAssumed;
                const nextOver = nextProj - nextBudget;
                const baselineOver = Math.max(0, baseline - nextBudget);
                const newOnlyOver = Math.max(0, nextOver) - baselineOver;
                const cls = nextOver > 0.5 ? "bad" : "ok";
                const sign = nextOver > 0.5 ? `✗ +${fmt(nextOver)}` : "✓";
                const tipText = `${cand.nextBudgetIsAssumed ? "下月預算未設，以本月為假設；" : ""}已含現廣告續費`;
                nextMonthLine = `<div class="rev-line"><span class="rev-k" title="${tipText}">下月</span><span class="rev-v ${cls}">${fmt(nextProj)} / ${fmt(nextBudget)} ${sign}</span></div>`;
                if (nextOver > 0.5) {
                  if (newOnlyOver > 0.5 && rate > 0) {
                    const cutRmb = Math.ceil(newOnlyOver / rate);
                    const note = baselineOver > 0.5
                      ? `<div class="rev-note">光現有廣告續費就會超 ${Math.ceil(baselineOver / rate).toLocaleString()} RMB（與這筆採買無關）</div>`
                      : "";
                    cutLine = `<div class="rev-line"><span class="rev-k">需砍</span><span class="rev-v bad">≈ ${cutRmb.toLocaleString()} RMB</span></div>${note}`;
                  } else if (baselineOver > 0.5) {
                    cutLine = `<div class="rev-note">超出全來自「現有廣告續費」（與這筆採買無關）</div>`;
                  }
                }
              }

              return `
                <div class="rev-card">
                  <h3>
                    <span>${esc(nameOf[pid] || pid)}</span>
                    <span class="pill ${productOf[pid]?.type || ""}" style="font-weight:400;font-size:11px;margin-left:4px">${productOf[pid]?.type === "app" ? "APP" : "小島"}</span>
                    <span class="pill" style="font-size:14px;margin-left:auto">${w}%</span>
                  </h3>
                  <div class="rev-line"><span class="rev-k">日／月</span><span class="rev-v">${fmt(dailyShare)}／${fmt(totalShare)} <span class="ink-3">(${fmt(totalShare / rate)} RMB)</span></span></div>
                  ${thisMonthLine}
                  ${nextMonthLine}
                  ${cutLine}
                </div>
              `;
            }).join("")}
        </div>
        <div class="hint" style="margin-top:8px">
          合計：<strong>${totalW}%</strong>
          ${inMonthDays ? `；本月攤提天 <strong>${inMonthDays}</strong>` : ""}
          ${inNextMonthDays ? `；下月（${ymNext}）攤提天 <strong>${inNextMonthDays}</strong>` : ""}
        </div>
        </details>
        ${(() => {
          // 全局淘汰建議：彙總所有產品的下月超支
          // 只算「新廣告造成的額外超出」（newOnlyOver），不把 baseline 已超的部分推給這筆新廣告
          if (!inNextMonthDays || rate <= 0) return "";
          let newOnlyOverTotal = 0;     // 純粹由新廣告引發的超支總額
          let baselineOverTotal = 0;     // baseline 已超的總額（提示用）
          const overByProd = [];
          for (const [pid, w] of Object.entries(suggested)) {
            const cand = candById[pid];
            if (!cand?.nextBudgetAssumed || cand.nextBudgetAssumed <= 0) continue;
            const dailyShare = dailyTwd * (w / 100);
            const nextContrib = dailyShare * inNextMonthDays;
            const baseline = cand.nextSpent || 0;
            const nextBudget = cand.nextBudgetAssumed;
            const totalOver = Math.max(0, baseline + nextContrib - nextBudget);
            const baselineOver = Math.max(0, baseline - nextBudget);
            const newOnly = Math.max(0, totalOver - baselineOver);
            if (newOnly > 0.5) {
              newOnlyOverTotal += newOnly;
              overByProd.push({ name: nameOf[pid] || pid, over: newOnly });
            }
            if (baselineOver > 0.5) baselineOverTotal += baselineOver;
          }
          if (newOnlyOverTotal <= 0 && baselineOverTotal <= 0) return "";
          if (newOnlyOverTotal <= 0) {
            return `
              <div class="hint rev-summary rev-summary-info">
                ℹ️ 光現有廣告續費就會超 ${Math.ceil(baselineOverTotal / rate).toLocaleString()} RMB（與這筆採買無關）
              </div>
            `;
          }
          const totalEliminateRmb = Math.ceil(newOnlyOverTotal / rate);
          const detail = overByProd.map((x) => `${esc(x.name)} ${Math.ceil(x.over / rate).toLocaleString()}`).join("、");
          const baselineNote = baselineOverTotal > 0.5
            ? `<div class="rev-note">另外，光現有廣告續費就會超 ${Math.ceil(baselineOverTotal / rate).toLocaleString()} RMB（與這筆採買無關）</div>`
            : "";
          return `
            <div class="hint rev-summary rev-summary-bad">
              <strong>⚠️ 需先砍 ≈ ${totalEliminateRmb.toLocaleString()} RMB</strong>
              <div class="rev-note" style="margin-left:0">明細：${detail} RMB</div>
              ${baselineNote}
            </div>
          `;
        })()}
        ${excluded.length ? `
          <div class="hint" style="margin-top:12px;padding:10px 12px;background:#f7f9fc;border-radius:6px;font-size:12px">
            <strong>未納入分配的產品（${excluded.length}）：</strong>
            <ul style="margin:4px 0 0;padding-left:20px">
              ${excluded.map((c) => `<li><strong>${esc(c.p.name)}</strong> — ${esc(c.excludeReason)}</li>`).join("")}
            </ul>
          </div>
        ` : ""}
      </div>

      ${renderSimulatedMonthGrid({
        start_date: amtStart,
        end_date: amtEnd,
        amortize_days: amtDays,
        daily_amort_twd: dailyTwd,
        weights: suggested,
      }, scenario)}
    `}
  `;
}

function bindHandlers(root) {
  root.querySelectorAll("[data-mode]").forEach((el) => {
    el.onclick = () => {
      mode = el.dataset.mode;
      render(root);
    };
  });
  root.querySelectorAll("[data-spend-scenario]").forEach((el) => {
    el.onclick = () => {
      spendScenario = el.dataset.spendScenario;
      render(root);
    };
  });

  if (mode === "date") {
    root.querySelector("#rev-date").onchange = (e) => { pickedDate = e.target.value; render(root); };
    root.querySelector("#rev-days").oninput = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0 && v <= 365) { amortizeDays = v; render(root); }
    };
    // 日花費低於下限警示「→ 一鍵調整」
    const gdBtn = root.querySelector("#rev-gd-fix-open");
    if (gdBtn) gdBtn.onclick = () => openGiftDayFixModal(() => render(root));
    root.querySelectorAll("[data-rev-pid]").forEach((el) => {
      el.onclick = () => {
        const pid = el.dataset.revPid;
        if (pickedPids.has(pid)) pickedPids.delete(pid);
        else pickedPids.add(pid);
        render(root);
      };
    });
    const clearBtn = root.querySelector("#rev-clear-pids");
    if (clearBtn) clearBtn.onclick = () => { pickedPids.clear(); render(root); };
    const dc = root.querySelector("#date-create");
    if (dc) dc.onclick = () => createFromDateMode();
    const dcm = root.querySelector("#date-create-multi");
    if (dcm) dcm.onclick = () => createFromDateMultiMode();
  } else {
    const apply = () => render(root);
    const q = (sel) => root.querySelector(sel);
    q("#amt-cny").onchange = (e) => { amtCny = Number(e.target.value) || 0; apply(); };
    // 起訖任一變動 → 自動把攤提天數帶成 (end - start)(end 不含當天 = 不 +1),使用者改攤提天數會覆寫
    const syncDaysFromDates = () => {
      if (amtStart && amtEnd && amtEnd > amtStart) {
        const d = Math.round((Date.parse(amtEnd) - Date.parse(amtStart)) / 86400000);
        if (Number.isFinite(d) && d > 0 && d <= 365) amtDays = d;
      }
    };
    q("#amt-start").onchange = (e) => { amtStart = e.target.value; syncDaysFromDates(); apply(); };
    q("#amt-end").onchange = (e) => { amtEnd = e.target.value; syncDaysFromDates(); apply(); };
    q("#amt-days").onchange = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0 && v <= 365) { amtDays = v; apply(); }
    };
    const create = q("#amt-create");
    if (create) create.onclick = () => createFromAmountMode();
  }
}

function createFromAmountMode() {
  const s = getState();
  const ym = s.settings.current_month;
  const rate = s.settings.expense_rate;
  const dailyTwd = amtDays > 0 ? (amtCny * rate) / amtDays : 0;
  const fakeAd = {
    start_date: amtStart, end_date: amtEnd,
    amortize_days: amtDays, daily_amort_twd: dailyTwd,
  };
  const scenario = scenarioFor(s, monthOf(amtStart || todayTaipei()));
  const r = suggestWeights(scenario.state, s.products, scenario.state.ads, ym, fakeAd);
  // 暫存 prefill 給 ads 編輯彈窗
  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: amtCny,
    exchange_rate: rate,
    start_date: amtStart,
    end_date: amtEnd,
    amortize_days: amtDays,
    weights: r.weights,
  }));
  location.hash = "#ads";
}

// date mode「用此參數建立廣告」：單一產品時 100%；多選時用合計 daily + 比例權重
function createFromDateMode() {
  const s = getState();
  const rate = s.settings.expense_rate;
  const scenario = scenarioFor(s, monthOf(pickedDate));
  const cards = suggestForDate(scenario.state, pickedDate, rate, amortizeDays);
  const onlyPid = pickedPids.size === 1 ? [...pickedPids][0] : null;
  const card = cards.find((c) => c.product.id === onlyPid);
  if (!card || card.kind !== "ok" || card.suggestTwd <= 0) {
    toast("該產品這天沒有可加空間", "bad");
    return;
  }

  const totalTwd = card.suggestTwd * amortizeDays;
  const cny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const startDate = pickedDate;
  const endDate = addDays(startDate, amortizeDays);

  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: cny,
    exchange_rate: rate,
    start_date: startDate,
    end_date: endDate,
    amortize_days: amortizeDays,
    weights: { [onlyPid]: 100 },
  }));
  location.hash = "#ads";
}

// date mode 多選：合計 daily 為廣告 daily，依各產品 suggestTwd 比例分權
function createFromDateMultiMode() {
  const s = getState();
  const rate = s.settings.expense_rate;
  const scenario = scenarioFor(s, monthOf(pickedDate));
  const cards = suggestForDate(scenario.state, pickedDate, rate, amortizeDays);
  const usable = cards.filter((c) => pickedPids.has(c.product.id) && c.kind === "ok" && c.suggestTwd > 0);
  if (usable.length === 0) {
    toast("選中的產品都沒有可加空間", "bad");
    return;
  }
  const totalDailyTwd = usable.reduce((s, c) => s + c.suggestTwd, 0);
  const weights = computeIntegerWeights(usable.map((c) => ({ id: c.product.id, value: c.suggestTwd })), 2);
  const totalTwd = totalDailyTwd * amortizeDays;
  const cny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const startDate = pickedDate;
  const endDate = addDays(startDate, amortizeDays);
  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: cny,
    exchange_rate: rate,
    start_date: startDate,
    end_date: endDate,
    amortize_days: amortizeDays,
    weights,
  }));
  location.hash = "#ads";
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
