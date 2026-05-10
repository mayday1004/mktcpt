import { getMonthlyBudget, getMonthlyBudgetWithFallback } from "../schema.js";
import { bandFor, bandsForMonth } from "./budget.js";
import { dailySpendGrid, monthlyTotals } from "./spending.js";
import { monthOf, daysInMonth, addDays } from "../lib/dates.js";
import { evaluatePoorPerf } from "./alerts.js";

// 給定一個目標日期 ymd 與攤提天數 amortizeDays，算出每個產品「這筆廣告每天能加多少」：
//   - 月剩餘預算（budget - already_spent_in_month）
//   - 月剩餘平均到「目標日到月底」的剩餘天數 = monthRemaining / daysFromTargetToEnd
//   - 攤提區間 [ymd, ymd + amortizeDays) 內每天的 band headroom（band.upper - 該天 baseline），取最小
//     —— 因為這筆廣告會連 amortizeDays 天都 +daily，最緊的那一天決定上限
//   - 取「月剩餘 / 剩餘天數」與「攤提區間最緊那天的 headroom」較小者作為該日可加 TWD 上限
// 回傳 [{ product, budget, monthSpent, monthRemaining, daysToMonthEnd, monthRemainPerDay,
//        todaySpent, todayHeadroom,
//        minHeadroomInPeriod, minHeadroomDay, amortizeDaysUsed,
//        suggestTwd, suggestCny }]
export function suggestForDate(state, ymd, exchangeRate, amortizeDays = 1) {
  const ym = monthOf(ymd);

  // 與「依金額」對齊:baseline 排除「成效全爛」廣告(理論上不會續費),避免低估剩餘空間
  const excludedPoorPerf = [];
  const adsForBaseline = (state.ads || []).filter((ad) => {
    if (evaluatePoorPerf(state, ad)) {
      excludedPoorPerf.push(ad);
      return false;
    }
    return true;
  });

  const totals = monthlyTotals(adsForBaseline, ym);
  // 「目標日到月底」的剩餘天數（含目標日）
  const dim = daysInMonth(ym);
  const dayNum = Number(ymd.slice(8, 10));
  const daysToMonthEnd = Math.max(1, dim - dayNum + 1);
  const amDays = Math.max(1, Number(amortizeDays) || 1);

  // 跨月攤提時 grid / bands 要按月 cache（避免每個產品每天都重算）
  const gridCache = {};
  const bandsCache = {};  // key = "pid|ym"
  const getGrid = (m) => gridCache[m] || (gridCache[m] = dailySpendGrid(adsForBaseline, m));
  const getBands = (p, m) => {
    const k = `${p.id}|${m}`;
    return bandsCache[k] || (bandsCache[k] = bandsForMonth(state, p, m));
  };

  const cards = state.products.map((p) => {
    const directBudget = getMonthlyBudget(state, p.id, ym);
    // 該月沒手動設預算時，沿用最近一個有設定的月份（避免下個月跨月採買建議無法顯示）
    const budget = directBudget != null ? directBudget : getMonthlyBudgetWithFallback(state, p.id, ym);
    const budgetIsFallback = directBudget == null && budget != null;
    // 採買日當天 band（顯示用）
    const dayBand0 = getBands(p, ym)[ymd];
    const band0 = (dayBand0 && dayBand0.budget_set) ? dayBand0 : bandFor(p, ym, budget);
    const monthSpent = totals[p.id] || 0;
    const monthRemaining = budget != null ? Math.max(0, budget - monthSpent) : null;
    // Bug fix:新廣告只攤提 amortizeDays 天,所以「本月攤提天數」= min(攤提天數, 目標日到月底天數)
    // 之前一律用 daysToMonthEnd 在 amortizeDays < daysToMonthEnd 時會過度保守
    const effectiveDaysInMonth = Math.min(amDays, daysToMonthEnd);
    const monthRemainPerDay = monthRemaining != null ? monthRemaining / effectiveDaysInMonth : null;
    const todaySpent = (getGrid(ym)[ymd]?.[p.id]) || 0;
    const todayHeadroom = Math.max(0, band0.upper - todaySpent);

    // 攤提區間 [ymd, ymd + amDays) 每天的 headroom，取最小
    // 同時記錄區間跨入的「沒設預算的月份」— 這些月的 upper=0 會被誤當成「已達上限」
    let minHeadroomInPeriod = Infinity;
    let minHeadroomDay = ymd;
    let minBandUpper = band0.upper;
    const unsetMonths = new Set();
    for (let i = 0; i < amDays; i++) {
      const d = addDays(ymd, i);
      const dym = monthOf(d);
      const dDirect = getMonthlyBudget(state, p.id, dym);
      // 跨月落入「未設預算」的月份時，沿用最近月份預算給 band 計算
      const dBudget = dDirect != null ? dDirect : getMonthlyBudgetWithFallback(state, p.id, dym);
      if (dDirect == null && dBudget == null) unsetMonths.add(dym);
      const dBand0 = getBands(p, dym)[d];
      const dBand = (dBand0 && dBand0.budget_set) ? dBand0 : bandFor(p, dym, dBudget);
      const dBaseline = (getGrid(dym)[d]?.[p.id]) || 0;
      const dHeadroom = Math.max(0, dBand.upper - dBaseline);
      if (dHeadroom < minHeadroomInPeriod) {
        minHeadroomInPeriod = dHeadroom;
        minHeadroomDay = d;
        minBandUpper = dBand.upper;
      }
    }
    if (!Number.isFinite(minHeadroomInPeriod)) minHeadroomInPeriod = 0;

    let suggestTwd = 0;
    let kind = "ok";
    let note = "";
    if (budget == null) {
      kind = "empty"; note = "尚未設定月預算";
    } else if (monthRemaining <= 0) {
      kind = "full"; note = "月預算已用罄";
    } else if (minHeadroomInPeriod <= 0) {
      kind = "full";
      // 卡點落在「沒設預算的月份」→ 明說那個月還沒設預算，不要寫「已達上限」誤導
      const minDayMonth = monthOf(minHeadroomDay);
      if (unsetMonths.has(minDayMonth)) {
        note = `攤提區間跨入 ${minDayMonth} 但該月預算未設，請先到「產品」頁設定`;
      } else {
        note = `攤提區間內 ${minHeadroomDay.slice(5)} 已達建議日花費上限`;
      }
    } else {
      // 取「月剩餘÷剩餘天數」「攤提區間最緊那天的 headroom」較小者
      suggestTwd = Math.min(minHeadroomInPeriod, monthRemainPerDay);
      kind = "ok";
      if (budgetIsFallback) note = `${ym} 月預算未手動設定，沿用最近月份`;
    }

    // 偵測「短攤提替代方案」:當 suggestTwd + baseline 仍 < lower(補不到下限),
    // 且 minHeadroomDay 落在攤提期裡(代表是 period binding,跨進 baseline 突增日)→
    // 算「攤提到 minHeadroomDay 前一天結束」會讓建議值變多少。
    // 給 UI 用「→ 改用 N 天攤提」一鍵套用,避開 baseline 突增日。
    let shortAmortize = null;
    let shortSuggestTwd = 0;
    let shortMinHeadroom = 0;
    const newDailyAfter = todaySpent + suggestTwd;
    const cantFillToLower = kind === "ok" && band0.lower > 0 && newDailyAfter < band0.lower;
    const periodBindingFirst = (monthRemainPerDay ?? Infinity) > (minHeadroomInPeriod ?? Infinity);
    if (cantFillToLower && periodBindingFirst && minHeadroomDay && minHeadroomDay > ymd) {
      const daysToTight = Math.round((Date.parse(minHeadroomDay) - Date.parse(ymd)) / 86400000);
      if (daysToTight >= 1 && daysToTight < amDays) {
        // 重算短攤提區間 [ymd, minHeadroomDay) 的 minHeadroom
        let shMin = Infinity;
        for (let i = 0; i < daysToTight; i++) {
          const d = addDays(ymd, i);
          const dym = monthOf(d);
          const dDirect = getMonthlyBudget(state, p.id, dym);
          const dBudget = dDirect != null ? dDirect : getMonthlyBudgetWithFallback(state, p.id, dym);
          const dBand0 = getBands(p, dym)[d];
          const dBand = (dBand0 && dBand0.budget_set) ? dBand0 : bandFor(p, dym, dBudget);
          const dBaseline = (getGrid(dym)[d]?.[p.id]) || 0;
          const dHeadroom = Math.max(0, dBand.upper - dBaseline);
          if (dHeadroom < shMin) shMin = dHeadroom;
        }
        if (!Number.isFinite(shMin)) shMin = 0;
        // 短攤提的「月可加」上限要用實際短攤提天數重算
        const shEffectiveDays = Math.min(daysToTight, daysToMonthEnd);
        const shMonthRemainPerDay = shEffectiveDays > 0 ? monthRemaining / shEffectiveDays : 0;
        const sh = Math.min(shMin, shMonthRemainPerDay);
        if (sh > suggestTwd) {
          shortAmortize = daysToTight;
          shortSuggestTwd = sh;
          shortMinHeadroom = shMin;
        }
      }
    }

    const suggestCny = exchangeRate > 0 ? Math.round(suggestTwd / exchangeRate) : 0;
    return {
      product: p,
      budget,
      budgetIsFallback,
      band: band0,
      monthSpent,
      monthRemaining,
      daysToMonthEnd,
      monthRemainPerDay,
      todaySpent,
      todayHeadroom,
      minHeadroomInPeriod,
      minHeadroomDay,
      minBandUpper,
      amortizeDaysUsed: amDays,
      suggestTwd,
      suggestCny,
      kind,
      note,
      // 短攤提替代方案(沒有則 shortAmortize 為 null)
      shortAmortize,
      shortSuggestTwd,
      shortMinHeadroom,
    };
  });
  // 把排除的成效全爛廣告當作 metadata 掛在陣列上,view 想顯示時可以讀
  cards.excludedPoorPerf = excludedPoorPerf;
  return cards;
}
