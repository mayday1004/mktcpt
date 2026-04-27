import { isInRange, daysOfMonth, monthOf } from "../lib/dates.js";

export function dailySpendForAd(ad, ymd) {
  if (!isInRange(ymd, ad.start_date, ad.end_date)) return {};
  const totalDaily = ad.daily_amort_twd || ad.amount_twd / ad.amortize_days;
  const result = {};
  for (const [pid, w] of Object.entries(ad.weights || {})) {
    result[pid] = totalDaily * (Number(w) / 100);
  }
  return result;
}

export function dailySpendGrid(ads, ym) {
  const grid = {};
  for (const day of daysOfMonth(ym)) {
    grid[day] = {};
    for (const ad of ads) {
      const per = dailySpendForAd(ad, day);
      for (const [pid, amt] of Object.entries(per)) {
        grid[day][pid] = (grid[day][pid] || 0) + amt;
      }
    }
  }
  return grid;
}

export function monthlyTotals(ads, ym) {
  const totals = {};
  const grid = dailySpendGrid(ads, ym);
  for (const day of Object.keys(grid)) {
    for (const [pid, amt] of Object.entries(grid[day])) {
      totals[pid] = (totals[pid] || 0) + amt;
    }
  }
  return totals;
}

export function activeAdsOn(ads, ymd) {
  return ads.filter((ad) => isInRange(ymd, ad.start_date, ad.end_date));
}

export function dailyTotalsByProduct(ads, ym, productId) {
  const grid = dailySpendGrid(ads, ym);
  const arr = [];
  for (const day of Object.keys(grid)) {
    arr.push({ date: day, amount: grid[day][productId] || 0 });
  }
  return arr;
}

export function adContributionPerMonth(ad, ym) {
  const contrib = {};
  for (const day of daysOfMonth(ym)) {
    const per = dailySpendForAd(ad, day);
    for (const [pid, amt] of Object.entries(per)) {
      contrib[pid] = (contrib[pid] || 0) + amt;
    }
  }
  return contrib;
}
