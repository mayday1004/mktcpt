import { addDays, daysInMonth, diffDays, nextDay, todayTaipei } from "../lib/dates.js";
import { evaluatePoorPerf } from "./alerts.js";

function fmtYmd(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonthsClamped(ymd, months) {
  const [year, month, day] = String(ymd || "").split("-").map(Number);
  if (!year || !month || !day || !Number.isFinite(months)) return ymd;
  const targetZeroMonth = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(targetZeroMonth / 12);
  const targetMonth = (targetZeroMonth % 12) + 1;
  const ym = `${targetYear}-${String(targetMonth).padStart(2, "0")}`;
  return fmtYmd(targetYear, targetMonth, Math.min(day, daysInMonth(ym)));
}

function inferRenewalMonths(ad) {
  const duration = Math.max(0, Number(ad?.amortize_days) || diffDays(ad?.start_date || "", ad?.end_date || "") || 0);
  if (!ad?.start_date || !ad?.end_date || duration <= 0) return null;

  for (let months = 1; months <= 24; months += 1) {
    if (addMonthsClamped(ad.start_date, months) === ad.end_date) return months;
  }

  let best = null;
  for (let months = 1; months <= 24; months += 1) {
    const end = addMonthsClamped(ad.end_date, months);
    const days = diffDays(ad.end_date, end);
    const error = Math.abs(days - duration);
    if (!best || error < best.error) best = { months, error };
  }

  return best && best.error <= Math.max(2, best.months) ? best.months : null;
}

function renewalEndDate(ad, start) {
  const months = inferRenewalMonths(ad);
  if (months) return addMonthsClamped(start, months);
  const span = Math.max(1, Number(ad.amortize_days) || diffDays(ad.start_date, ad.end_date) || 30);
  return addDays(start, span);
}

function terminalSegments(ads) {
  const referenced = new Set(ads.map((a) => a.renewal_of).filter(Boolean));
  return ads.filter((ad) =>
    ad?.ad_code &&
    ad.start_date &&
    ad.end_date &&
    !referenced.has(ad.id)
  );
}

function cloneRenewal(ad, start, end, index) {
  const amortizeDays = Math.max(1, diffDays(start, end));
  const amountTwd = Number(ad.amount_twd) || 0;
  return {
    ...ad,
    id: `${ad.id}__projected_renewal_${index}`,
    start_date: start,
    end_date: end,
    amortize_days: amortizeDays,
    daily_amort_twd: amountTwd > 0 ? amountTwd / amortizeDays : ad.daily_amort_twd,
    renewal_of: ad.id,
    renewal_reason: "續費",
    notes: [ad.notes, "系統預估續費段，不寫入資料"].filter(Boolean).join(" / "),
    projected_renewal: true,
  };
}

// 給 detect / plan 等「決策層」函式用的 state — 預設套用續費 projection。
// 2026-05 改:不再排除「成效全爛」廣告,沒按淘汰的一律當會續費(跟畫面顯示一致)。
// settings.current_month 沒設或 fromDate 無效時退回原 state。
export function projectedDecisionState(state) {
  const ym = state?.settings?.current_month;
  if (!ym) return state;
  const projection = projectAdsWithRenewals(state, ym, {
    fromDate: todayTaipei(),
    excludePoorPerf: false,
  });
  return { ...state, ads: projection.ads };
}

// options:
//   fromDate          — 只續還沒到期的廣告(end_date >= fromDate)
//   toMonth           — 預估上限月份(YYYY-MM),預設 = ym。傳更晚的月份可以把預估延長到後續月份
//   excludePoorPerf   — 是否排除「成效全爛」廣告(視同預設淘汰)。預設 true(歷史行為);
//                       2026-05 起 view + 決策層都改 false,沒按淘汰的一律當會續費
export function projectAdsWithRenewals(state, ym, options = {}) {
  const fromDate = options.fromDate || todayTaipei();
  const toMonth = options.toMonth || ym;
  const monthEndExclusive = nextDay(`${toMonth}-${String(daysInMonth(toMonth)).padStart(2, "0")}`);
  const projectionWindowStart = `${ym}-01`;
  const ads = state.ads || [];
  const projected = [];
  const excludedPoorPerf = [];

  for (const ad of terminalSegments(ads)) {
    if (ad.eliminated) continue;
    if (ad.end_date < fromDate) continue;
    if ((Number(ad.daily_amort_twd) || 0) <= 0) continue;
    if (!ad.weights || Object.keys(ad.weights).length === 0) continue;

    if (options.excludePoorPerf !== false && evaluatePoorPerf(state, ad)) {
      excludedPoorPerf.push(ad);
      continue;
    }

    let start = ad.end_date;
    let index = 1;
    while (start < monthEndExclusive) {
      const end = renewalEndDate(ad, start);
      if (end > projectionWindowStart && start < monthEndExclusive) {
        projected.push(cloneRenewal(ad, start, end, index));
      }
      start = end;
      index += 1;
      if (index > 24) break;
    }
  }

  return {
    ads: [...ads, ...projected],
    virtualRenewals: projected,
    excludedPoorPerf,
  };
}
