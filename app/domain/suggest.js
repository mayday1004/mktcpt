import { bandFor } from "./budget.js";
import { monthlyTotals, dailySpendGrid } from "./spending.js";
import { daysOfMonth, isInRange, nextDay } from "../lib/dates.js";
import { getMonthlyBudget } from "../schema.js";
import { evaluatePoorPerf } from "./alerts.js";

// "2026-04" → "2026-05"；12 月跳年
function nextMonthYM(ym) {
  if (!ym) return "";
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * 給定新廣告（start_date / end_date / daily_amort_twd），提出權重建議。
 * 演算法：
 *   1. 對每個產品，算當月剩餘預算（monthly_budget - already_spent）
 *   2. 依剩餘預算做比例分配（剩多的拿多）
 *   3. 檢查每個產品分到的每日攤提是否超過建議日花費上限，超過就削到上限，把溢出的餘額重新分給其他人
 *   4. 轉成整數 %（最後一個產品用 100 - 其他產品累計值修正）
 *   5. 排除 0%，回傳 { product_id: weight }
 *
 * 「已補到位」（remaining=0 或 headroom=0）的產品自動排除分配，並在 candidates 標記原因。
 *
 * 返回：
 *   weights         — { product_id: weight % }
 *   reasons         — 整體說明訊息（容量不足、削減等）
 *   candidates      — 所有產品的明細（含本月、下月預算 / 已花 / 排除原因），給 UI 顯示用
 *   inMonthDays     — 新廣告落在 ym 內的天數
 *   inNextMonthDays — 新廣告攤提期跨入下個月的天數（讓 UI 估「下月會不會也爆預算」）
 *   ymNext          — 下個月 YYYY-MM
 */
export function suggestWeights(state, products, existingAds, ym, newAd) {
  const reasons = [];
  const totals = monthlyTotals(existingAds, ym);
  const grid = dailySpendGrid(existingAds, ym);
  const activeDays = countActiveDays(newAd, ym);
  if (activeDays === 0) {
    reasons.push("新廣告在本月無任何攤提日");
    return { weights: {}, reasons, candidates: [], inMonthDays: 0, inNextMonthDays: 0, ymNext: "" };
  }

  // 下個月預算檢查：實際還沒設下月預算時，先假設＝本月，避免使用者買進一筆會把下月預算撐爆的廣告
  // baseline 排除「成效全爛」廣告(所有有權重產品 ratio < 0.3),這些理論上不會續費
  const ymNext = nextMonthYM(ym);
  const inNextMonthDays = ymNext ? countActiveDays(newAd, ymNext) : 0;
  const nextBaselineResult = ymNext ? projectNextMonthBaseline(state, existingAds, ym, ymNext) : { baseline: {}, excludedPoorPerf: [] };
  const nextRenewalBaseline = nextBaselineResult.baseline;
  if (nextBaselineResult.excludedPoorPerf.length > 0) {
    // 同一支廣告不分產品視為一組,以 ad_code 去重
    const seen = new Set();
    const uniqueAds = [];
    for (const a of nextBaselineResult.excludedPoorPerf) {
      const key = a.ad_code || a.id;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueAds.push(a);
    }
    const names = uniqueAds.map((a) => a.ad_name || a.ad_code).slice(0, 3).join("、");
    const more = uniqueAds.length > 3 ? `…等 ${uniqueAds.length} 支` : "";
    reasons.push(`下月建議日花費已排除計算 ${uniqueAds.length} 支成效全爛廣告(理論上不會續費):${names}${more}`);
  }

  const daily = Number(newAd.daily_amort_twd) || 0;

  const candidates = products.map((p) => {
    const spent = totals[p.id] || 0;
    const budget = getMonthlyBudget(state, p.id, ym);
    const nextSpent = nextRenewalBaseline[p.id] || 0;  // 假設所有當月廣告都續費的下月攤提合計
    const nextBudgetActual = ymNext ? getMonthlyBudget(state, p.id, ymNext) : null;
    // 下月預算未設 → 用本月預算當假設值（讓 UI 標記「假設」）
    const nextBudgetAssumed = nextBudgetActual != null ? nextBudgetActual : budget;
    const nextBudgetIsAssumed = nextBudgetActual == null && budget != null;

    if (budget == null) {
      return {
        p, budget: null, spent, remaining: 0,
        band: bandFor(p, ym, 0), peakCurrent: 0, headroom: 0,
        excludeReason: "未設月預算",
        nextSpent, nextBudgetActual, nextBudgetAssumed, nextBudgetIsAssumed,
      };
    }
    const remaining = Math.max(0, budget - spent);
    const band = bandFor(p, ym, budget);
    const peakCurrent = maxDailyInPeriod(grid, p.id, newAd.start_date, newAd.end_date);
    const headroom = Math.max(0, band.upper - peakCurrent);
    let excludeReason = null;
    if (remaining <= 0) excludeReason = "月預算已用罄";
    else if (headroom <= 0) excludeReason = "已達建議花費上限（補到位）";
    return {
      p, budget, spent, remaining, band, peakCurrent, headroom, excludeReason,
      nextSpent, nextBudgetActual, nextBudgetAssumed, nextBudgetIsAssumed,
    };
  });

  // 把排除原因彙整到全域 reasons（UI 也可從 candidates 直接讀）
  for (const c of candidates) {
    if (c.excludeReason) reasons.push(`${c.p.name}：${c.excludeReason}，不加入分配`);
  }

  const usable = candidates.filter((c) => !c.excludeReason);
  if (usable.length === 0) {
    reasons.push("所有產品都沒有剩餘預算或每日建議花費值空間");
    return { weights: {}, reasons, candidates, inMonthDays: activeDays, inNextMonthDays, ymNext };
  }

  const totalRemaining = usable.reduce((s, c) => s + c.remaining, 0);
  const raw = {};
  for (const c of usable) raw[c.p.id] = (c.remaining / totalRemaining) * daily;

  for (const c of usable) {
    const hr = c.headroom;
    if (raw[c.p.id] > hr) {
      reasons.push(`${c.p.name} 被削到建議花費上限 ${Math.round(c.band.upper).toLocaleString()}`);
      const overflow = raw[c.p.id] - hr;
      raw[c.p.id] = hr;
      const others = usable.filter((x) => x.p.id !== c.p.id && raw[x.p.id] < x.headroom);
      const otherTotal = others.reduce((s, x) => s + x.remaining, 0);
      if (otherTotal > 0) {
        for (const x of others) raw[x.p.id] += (overflow * x.remaining) / otherTotal;
      }
    }
  }

  const totalAssigned = Object.values(raw).reduce((s, x) => s + x, 0);
  if (totalAssigned < daily - 0.01) {
    reasons.push(`容量不足：可配置 ${Math.round(totalAssigned).toLocaleString()} / 需要 ${Math.round(daily).toLocaleString()}，剩餘 ${Math.round(daily - totalAssigned).toLocaleString()} 無處可放`);
  }

  const pct = {};
  const keys = Object.keys(raw).filter((k) => raw[k] > 0);
  if (keys.length === 0) return { weights: {}, reasons, candidates, inMonthDays: activeDays, inNextMonthDays, ymNext };

  const actualTotal = Object.values(raw).reduce((s, x) => s + x, 0);
  if (actualTotal <= 0) return { weights: {}, reasons, candidates, inMonthDays: activeDays, inNextMonthDays, ymNext };

  let acc = 0;
  for (let i = 0; i < keys.length - 1; i++) {
    pct[keys[i]] = Math.round((raw[keys[i]] / actualTotal) * 100);
    acc += pct[keys[i]];
  }
  pct[keys[keys.length - 1]] = 100 - acc;

  const weights = Object.fromEntries(Object.entries(pct).filter(([, v]) => v > 0));
  return { weights, reasons, candidates, inMonthDays: activeDays, inNextMonthDays, ymNext };
}

// 估算「下個月所有現有廣告（假設續費）」的攤提合計：
//   - 把 state.ads 依 ad_code 分組，挑「終端段」（沒有其他段的 renewal_of 指向它的）
//     這樣同代碼的多段續費鏈只會被算一次（取最後那段的 daily 與 weights）
//   - 平行買（同 code 不同 pid 同時跑）每條鏈各自算一份
//   - 終端段視為「會繼續續費」→ 用該段 daily × weights × 下月天數
//   - 已在更早月份結束的（end_date <= ym 月初）不納入（不會續費了)
//   - **排除「成效全爛」廣告**(每個有權重產品的 ratio 都 < 0.3 + 有完整成效資料 + 有設目標)
//     這類廣告理論上不會續費,把它們算進 baseline 會誤判下月預算超支
//
// 回 { baseline: {pid: TWD}, excludedPoorPerf: [ad,...] }
function projectNextMonthBaseline(state, existingAds, ym, ymNext) {
  const ymFirst = `${ym}-01`;
  const nextDays = [...daysOfMonth(ymNext)].length;
  if (nextDays === 0) return { baseline: {}, excludedPoorPerf: [] };

  // 每個 ad_code 分組
  const byCode = new Map();
  for (const ad of existingAds) {
    if (!ad || !ad.ad_code || !ad.start_date || !ad.end_date) continue;
    if (ad.end_date <= ymFirst) continue;  // 早於本月就結束 → 視為已停，不續費
    if (!byCode.has(ad.ad_code)) byCode.set(ad.ad_code, []);
    byCode.get(ad.ad_code).push(ad);
  }

  // 每組挑「終端段」（不被任何其他段的 renewal_of 指到）
  const terminals = [];
  for (const segs of byCode.values()) {
    const referenced = new Set(segs.map((s) => s.renewal_of).filter(Boolean));
    for (const s of segs) {
      if (!referenced.has(s.id)) terminals.push(s);
    }
  }

  // 每個終端段攤到下月：daily × weights/100 × 下月天數
  const baseline = {};
  const excludedPoorPerf = [];
  for (const ad of terminals) {
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) continue;
    if (ad.eliminated) continue;
    // 成效全爛 → 跳過(這類廣告理論上不會續費)
    if (evaluatePoorPerf(state, ad)) {
      excludedPoorPerf.push(ad);
      continue;
    }
    for (const [pid, w] of Object.entries(ad.weights || {})) {
      const wn = Number(w) || 0;
      if (wn <= 0) continue;
      const monthly = daily * (wn / 100) * nextDays;
      baseline[pid] = (baseline[pid] || 0) + monthly;
    }
  }
  return { baseline, excludedPoorPerf };
}

function countActiveDays(ad, ym) {
  let n = 0;
  for (const d of daysOfMonth(ym)) {
    if (isInRange(d, ad.start_date, ad.end_date)) n++;
  }
  return n;
}

function maxDailyInPeriod(grid, pid, start, end) {
  let peak = 0;
  let cur = start;
  while (cur < end) {
    const v = (grid[cur] && grid[cur][pid]) || 0;
    if (v > peak) peak = v;
    cur = nextDay(cur);
  }
  return peak;
}
