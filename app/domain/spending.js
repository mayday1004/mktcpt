import { isInRange, daysOfMonth, monthOf } from "../lib/dates.js";

function dailyAmount(ad) {
  const direct = Number(ad?.daily_amort_twd) || 0;
  if (direct > 0) return direct;
  const total = Number(ad?.amount_twd) || 0;
  const days = Number(ad?.amortize_days) || 0;
  return days > 0 ? total / days : 0;
}

function latestSegment(segs) {
  return (segs || [])
    .filter((a) => a.start_date && a.end_date)
    .slice()
    .sort((a, b) =>
      (b.end_date || "").localeCompare(a.end_date || "") ||
      (b.start_date || "").localeCompare(a.start_date || "")
    )[0] || null;
}

function overlaps(a, b) {
  return !!(a && b && a.start_date < b.end_date && a.end_date > b.start_date);
}

function pairSegmentsFor(ad, allAds) {
  if (!ad?.split_pair_id || !Array.isArray(allAds)) return [];
  return allAds.filter((a) => a.split_pair_id === ad.split_pair_id);
}

function activePairSegments(ad, ymd, allAds) {
  return pairSegmentsFor(ad, allAds).filter((a) => isInRange(ymd, a.start_date, a.end_date));
}

function splitPairDisplayScale(ad, allAds, ymd = null) {
  const pairSegs = ymd ? activePairSegments(ad, ymd, allAds) : pairSegmentsFor(ad, allAds);
  if (pairSegs.length <= 1) return null;

  if (ymd) {
    const total = pairSegs.reduce((sum, seg) => sum + (Number(seg.amount_cny) || 0), 0);
    const own = pairSegs.find((seg) => seg.id === ad.id) ||
      pairSegs.find((seg) => seg.ad_code === ad.ad_code && seg.start_date === ad.start_date && seg.end_date === ad.end_date) ||
      pairSegs.find((seg) => seg.ad_code === ad.ad_code);
    const ownAmt = Number(own?.amount_cny) || 0;
    return total > 0 && ownAmt > 0 ? ownAmt / total : null;
  }

  const parentLast = latestSegment(pairSegs.filter((a) => a.split_role === "parent")) ||
    latestSegment(pairSegs.filter((a) => !String(a.ad_code || "").toLowerCase().endsWith("t")));
  if (!parentLast) return null;

  const scaleByCode = new Map();
  let total = Number(parentLast.amount_cny) || 0;
  scaleByCode.set(parentLast.ad_code, total);

  const otherCodes = new Set(pairSegs.filter((a) => a.ad_code !== parentLast.ad_code).map((a) => a.ad_code));
  for (const code of otherCodes) {
    const seg = latestSegment(pairSegs.filter((a) => a.ad_code === code));
    if (!seg || !overlaps(seg, parentLast)) continue;
    const amt = Number(seg.amount_cny) || 0;
    total += amt;
    scaleByCode.set(code, amt);
  }

  const ownAmt = scaleByCode.get(ad.ad_code);
  return total > 0 && ownAmt != null ? ownAmt / total : null;
}

function roundScaledWeights(weights, scale) {
  const entries = Object.entries(weights || {})
    .map(([pid, w]) => ({ pid, weight: Number(w) || 0 }))
    .filter((e) => e.weight > 0);
  const raw = Object.fromEntries(entries.map((e) => [e.pid, e.weight]));
  if (!scale || scale <= 0 || scale >= 1 || entries.length === 0) return raw;

  const rawSum = entries.reduce((sum, e) => sum + e.weight, 0);
  const target = Math.round(rawSum * scale);
  const scaled = entries.map((e, i) => {
    const value = e.weight * scale;
    return { ...e, i, floor: Math.floor(value), frac: value - Math.floor(value) };
  });
  const result = scaled.map((e) => e.floor);
  let diff = target - result.reduce((sum, v) => sum + v, 0);
  scaled
    .slice()
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .forEach((e) => {
      if (diff <= 0) return;
      result[e.i] += 1;
      diff -= 1;
    });
  return Object.fromEntries(scaled.map((e) => [e.pid, result[e.i]]));
}

export function displayWeightsForAd(ad, allAds, ymd = null) {
  if (ymd && activePairSegments(ad, ymd, allAds).length <= 1) return roundScaledWeights(ad.weights, null);
  const scale = splitPairDisplayScale(ad, allAds, ymd);
  return roundScaledWeights(ad.weights, scale);
}

export function dailySpendForAd(ad, ymd, allAds = null) {
  if (!isInRange(ymd, ad.start_date, ad.end_date)) return {};
  const activePair = activePairSegments(ad, ymd, allAds);
  const isActiveSplitPair = activePair.length > 1;
  const totalDaily = isActiveSplitPair
    ? activePair.reduce((sum, seg) => sum + dailyAmount(seg), 0)
    : dailyAmount(ad);
  const weights = isActiveSplitPair ? displayWeightsForAd(ad, allAds, ymd) : (ad.weights || {});
  const result = {};
  for (const [pid, w] of Object.entries(weights || {})) {
    result[pid] = totalDaily * (Number(w) / 100);
  }
  return result;
}

export function dailySpendGrid(ads, ym) {
  const grid = {};
  for (const day of daysOfMonth(ym)) {
    grid[day] = {};
    for (const ad of ads) {
      const per = dailySpendForAd(ad, day, ads);
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

export function adContributionPerMonth(ad, ym, allAds = null) {
  const contrib = {};
  for (const day of daysOfMonth(ym)) {
    const per = dailySpendForAd(ad, day, allAds);
    for (const [pid, amt] of Object.entries(per)) {
      contrib[pid] = (contrib[pid] || 0) + amt;
    }
  }
  return contrib;
}
