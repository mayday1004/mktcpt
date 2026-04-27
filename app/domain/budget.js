import { PRODUCT_TYPES, getBudgetChanges, getMonthlyBudget } from "../schema.js";
import { daysInMonth, daysOfMonth } from "../lib/dates.js";
import { dailySpendGrid } from "./spending.js";

// bandFor — 舊版「整月平均」帶寬公式（保留給「不需要分段」的場合用，例如 KPI 摘要）。
// 新代碼應該優先用 bandsForMonth(state, product, ym) 取得每日的精確帶寬。
export function bandFor(product, ym, budget) {
  const days = daysInMonth(ym);
  const b = Number.isFinite(budget) && budget > 0 ? budget : 0;
  const avg = b / days;
  const pct = PRODUCT_TYPES[product.type].band_pct / 100;
  return {
    avg,
    lower: Math.max(0, avg * (1 - pct)),
    upper: avg * (1 + pct),
    pct_label: `±${PRODUCT_TYPES[product.type].band_pct}%`,
    budget_set: b > 0,
  };
}

export function checkMonthlyTotal(spentTwd, budgetTwd) {
  const diff = spentTwd - budgetTwd;
  if (diff > 10000) return { kind: "bad", msg: `超花 ${Math.round(diff).toLocaleString()} 元（上限 1 萬）` };
  if (diff > 0)     return { kind: "warn", msg: `超花 ${Math.round(diff).toLocaleString()} 元（容許 1 萬內）` };
  if (-diff > 20000) return { kind: "warn", msg: `少花 ${Math.round(-diff).toLocaleString()} 元（上限 2 萬）` };
  return { kind: "ok", msg: `差額 ${Math.round(diff).toLocaleString()} 元` };
}

// ── Forward-only 分段帶寬（建議日花費）────────────────────────────────
//
// 兩種模式（依產品類型決定，存在 budget_changes[pid][ym] 的 mode 欄位）：
//
// (A) APP / monthly mode：amount 是「月度目標總額」
//     段內 daily target = (新預算 - 段前已花) / 段內剩餘天數
//     例：4 月初 50 萬，4/16 加到 80 萬（前 15 天已花 25 萬）
//        4/1~4/15: daily = 500000/30 = 16666，帶寬 ±30% = 11666~21666
//        4/16~4/30: daily = (800000-250000)/15 = 36666，帶寬 25666~47666
//
// (B) 小島 / daily mode：amount 是「每日預算」（恆定）
//     段內 daily target = amount（與已花無關）
//     例：日預算 4000，4/22 改 6000
//        4/1~4/21: target = 4000，帶寬 ±0.5% = 3980~4020
//        4/22~4/30: target = 6000，帶寬 5970~6030
//
// 過去日仍按所屬段的帶寬評估（紅字判定看當段，不會被新段帶寬誤判）。
//
// 回傳 { [day]: { avg, lower, upper, pct_label, budget_set, change_at, seg_mode } }
export function bandsForMonth(state, product, ym) {
  const result = {};
  const days = [...daysOfMonth(ym)];
  const pct = PRODUCT_TYPES[product.type].band_pct / 100;
  const pctLabel = `±${PRODUCT_TYPES[product.type].band_pct}%`;

  const changes = getBudgetChanges(state, product.id, ym);
  if (changes.length === 0 || days.length === 0) {
    for (const d of days) {
      result[d] = { avg: 0, lower: 0, upper: 0, pct_label: pctLabel, budget_set: false, change_at: null };
    }
    return result;
  }

  // monthly mode 才需要計算段前累計（daily mode 直接用 amount）
  const grid = dailySpendGrid(state.ads, ym);
  const cumSpent = {};
  let cum = 0;
  for (const d of days) {
    cum += (grid[d]?.[product.id] || 0);
    cumSpent[d] = cum;
  }
  const cumBefore = (day) => {
    const idx = days.indexOf(day);
    if (idx <= 0) return 0;
    return cumSpent[days[idx - 1]] || 0;
  };

  const monthFirst = days[0];
  const monthLast = days[days.length - 1];

  for (const d of days) {
    let applicable = null;
    for (let i = changes.length - 1; i >= 0; i--) {
      const at = changes[i].at_date < monthFirst ? monthFirst : changes[i].at_date;
      if (at <= d) {
        applicable = { ...changes[i], at_date: at };
        break;
      }
    }
    if (!applicable) {
      result[d] = { avg: 0, lower: 0, upper: 0, pct_label: pctLabel, budget_set: false, change_at: null };
      continue;
    }
    const segStart = applicable.at_date;
    const mode = applicable.mode || "monthly";
    let target;
    let extras = {};
    if (mode === "daily") {
      // 小島：amount 是該段的每日預算，恆定
      target = applicable.amount;
      extras = { seg_amount: applicable.amount, seg_mode: "daily" };
    } else {
      // APP：amount 是月度目標，daily = (amount - 段前已花) / 段內剩餘天數
      const spentBeforeSeg = cumBefore(segStart);
      const remainAmount = applicable.amount - spentBeforeSeg;
      const segDays = Math.max(1, daysBetweenInclusive(segStart, monthLast));
      target = remainAmount / segDays;
      extras = { seg_amount: applicable.amount, seg_remain: remainAmount, seg_days: segDays, seg_mode: "monthly" };
    }
    result[d] = {
      avg: target,
      lower: Math.max(0, target * (1 - pct)),
      upper: Math.max(0, target * (1 + pct)),
      pct_label: pctLabel,
      budget_set: true,
      change_at: segStart,
      ...extras,
    };
  }
  return result;
}

// 取單日帶寬（封裝 bandsForMonth 的便利版）
export function bandForDay(state, product, ym, day) {
  return bandsForMonth(state, product, ym)[day] || null;
}

function daysBetweenInclusive(start, end) {
  const a = Date.parse(start), b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000) + 1;
}
