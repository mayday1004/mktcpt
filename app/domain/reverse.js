import { getMonthlyBudget } from "../schema.js";
import { bandFor, bandsForMonth } from "./budget.js";
import { dailySpendGrid, monthlyTotals } from "./spending.js";
import { monthOf, daysInMonth, addDays } from "../lib/dates.js";

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
  const totals = monthlyTotals(state.ads, ym);
  // 「目標日到月底」的剩餘天數（含目標日）
  const dim = daysInMonth(ym);
  const dayNum = Number(ymd.slice(8, 10));
  const daysToMonthEnd = Math.max(1, dim - dayNum + 1);
  const amDays = Math.max(1, Number(amortizeDays) || 1);

  // 跨月攤提時 grid / bands 要按月 cache（避免每個產品每天都重算）
  const gridCache = {};
  const bandsCache = {};  // key = "pid|ym"
  const getGrid = (m) => gridCache[m] || (gridCache[m] = dailySpendGrid(state.ads, m));
  const getBands = (p, m) => {
    const k = `${p.id}|${m}`;
    return bandsCache[k] || (bandsCache[k] = bandsForMonth(state, p, m));
  };

  return state.products.map((p) => {
    const budget = getMonthlyBudget(state, p.id, ym);
    // 採買日當天 band（顯示用）
    const dayBand0 = getBands(p, ym)[ymd];
    const band0 = (dayBand0 && dayBand0.budget_set) ? dayBand0 : bandFor(p, ym, budget);
    const monthSpent = totals[p.id] || 0;
    const monthRemaining = budget != null ? Math.max(0, budget - monthSpent) : null;
    const monthRemainPerDay = monthRemaining != null ? monthRemaining / daysToMonthEnd : null;
    const todaySpent = (getGrid(ym)[ymd]?.[p.id]) || 0;
    const todayHeadroom = Math.max(0, band0.upper - todaySpent);

    // 攤提區間 [ymd, ymd + amDays) 每天的 headroom，取最小
    // 同時記錄區間跨入的「沒設預算的月份」— 這些月的 upper=0 會被誤當成「已達上緣」
    let minHeadroomInPeriod = Infinity;
    let minHeadroomDay = ymd;
    let minBandUpper = band0.upper;
    const unsetMonths = new Set();
    for (let i = 0; i < amDays; i++) {
      const d = addDays(ymd, i);
      const dym = monthOf(d);
      const dBudget = getMonthlyBudget(state, p.id, dym);
      if (dBudget == null) unsetMonths.add(dym);
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
      // 卡點落在「沒設預算的月份」→ 明說那個月還沒設預算，不要寫「已達上緣」誤導
      const minDayMonth = monthOf(minHeadroomDay);
      if (unsetMonths.has(minDayMonth)) {
        note = `攤提區間跨入 ${minDayMonth} 但該月預算未設，請先到「產品」頁設定`;
      } else {
        note = `攤提區間內 ${minHeadroomDay.slice(5)} 已達建議日花費上緣`;
      }
    } else {
      // 取「月剩餘÷剩餘天數」「攤提區間最緊那天的 headroom」較小者
      suggestTwd = Math.min(minHeadroomInPeriod, monthRemainPerDay);
      kind = "ok";
    }

    const suggestCny = exchangeRate > 0 ? Math.round(suggestTwd / exchangeRate) : 0;
    return {
      product: p,
      budget,
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
    };
  });
}
