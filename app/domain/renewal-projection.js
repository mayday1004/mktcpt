import { addDays, daysInMonth, diffDays, nextDay, todayTaipei } from "../lib/dates.js";
import { evaluatePoorPerf } from "./alerts.js";

function terminalSegments(ads) {
  const referenced = new Set(ads.map((a) => a.renewal_of).filter(Boolean));
  const latestByCode = new Map();

  for (const ad of ads) {
    if (!ad?.ad_code || !ad.start_date || !ad.end_date) continue;
    if (referenced.has(ad.id)) continue;
    const cur = latestByCode.get(ad.ad_code);
    if (!cur || ad.end_date > cur.end_date || (ad.end_date === cur.end_date && ad.start_date > cur.start_date)) {
      latestByCode.set(ad.ad_code, ad);
    }
  }

  return [...latestByCode.values()];
}

function cloneRenewal(ad, start, end, index) {
  return {
    ...ad,
    id: `${ad.id}__projected_renewal_${index}`,
    start_date: start,
    end_date: end,
    renewal_of: ad.id,
    renewal_reason: "續費",
    notes: [ad.notes, "系統預估續費段，不寫入資料"].filter(Boolean).join(" / "),
    projected_renewal: true,
  };
}

// 給 detect / plan 等「決策層」函式用的 state — 預設套用續費 projection,
// 並排除「全爛廣告」(成效全部 < 0.3,視同預設淘汰,不會被預估續費)。
// settings.current_month 沒設或 fromDate 無效時退回原 state。
export function projectedDecisionState(state) {
  const ym = state?.settings?.current_month;
  if (!ym) return state;
  const projection = projectAdsWithRenewals(state, ym, {
    fromDate: todayTaipei(),
    excludePoorPerf: true,
  });
  return { ...state, ads: projection.ads };
}

export function projectAdsWithRenewals(state, ym, options = {}) {
  const fromDate = options.fromDate || todayTaipei();
  const monthEndExclusive = nextDay(`${ym}-${String(daysInMonth(ym)).padStart(2, "0")}`);
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

    const span = Math.max(1, Number(ad.amortize_days) || diffDays(ad.start_date, ad.end_date) || 30);
    let start = ad.end_date;
    let index = 1;
    while (start < monthEndExclusive) {
      const end = addDays(start, span);
      if (end > `${ym}-01` && start < monthEndExclusive) {
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
