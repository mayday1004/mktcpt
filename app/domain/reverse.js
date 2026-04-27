import { getMonthlyBudget } from "../schema.js";
import { bandFor, bandsForMonth } from "./budget.js";
import { dailySpendGrid, monthlyTotals } from "./spending.js";
import { monthOf } from "../lib/dates.js";

// 給定一個目標日期 ymd（例：2026-04-25），算出每個產品「當天還能買多少」：
//   - 月剩餘預算（budget - already_spent_in_month）
//   - 當日帶寬剩餘（band.upper - 當日已配置）
//   - 取兩者較小者作為「該日可加 TWD」上限
//   - 加上 RMB 換算（用支出匯率）
// 回傳 [{ product, budget, monthSpent, monthRemaining, todaySpent, todayHeadroom, suggestTwd, suggestCny }]
export function suggestForDate(state, ymd, exchangeRate) {
  const ym = monthOf(ymd);
  const grid = dailySpendGrid(state.ads, ym);
  const totals = monthlyTotals(state.ads, ym);
  const dayRow = grid[ymd] || {};

  return state.products.map((p) => {
    const budget = getMonthlyBudget(state, p.id, ym);
    // 用 forward-only 的「當日」帶寬，對加預算後的小島才準
    const dayBand = bandsForMonth(state, p, ym)[ymd];
    const band = (dayBand && dayBand.budget_set) ? dayBand : bandFor(p, ym, budget);
    const monthSpent = totals[p.id] || 0;
    const monthRemaining = budget != null ? Math.max(0, budget - monthSpent) : null;
    const todaySpent = dayRow[p.id] || 0;
    const todayHeadroom = Math.max(0, band.upper - todaySpent);

    let suggestTwd = 0;
    let kind = "ok";
    let note = "";
    if (budget == null) {
      kind = "empty"; note = "尚未設定月預算";
    } else if (monthRemaining <= 0) {
      kind = "full"; note = "月預算已用罄";
    } else if (todayHeadroom <= 0) {
      kind = "full"; note = "當日已達帶寬上緣";
    } else {
      // 假設一支廣告攤提 30 天，其中當天落在 ymd
      // 我們關心的是「當天的攤提額」上限 → 取 todayHeadroom
      // 月剩餘也要能接住未來日數的攤提（保守版本：不超過 monthRemaining）
      suggestTwd = Math.min(todayHeadroom, monthRemaining);
      kind = "ok";
    }

    const suggestCny = exchangeRate > 0 ? Math.round(suggestTwd / exchangeRate) : 0;
    return {
      product: p,
      budget,
      band,
      monthSpent,
      monthRemaining,
      todaySpent,
      todayHeadroom,
      suggestTwd,
      suggestCny,
      kind,
      note,
    };
  });
}
