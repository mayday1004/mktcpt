// 廣告調整建議(CLAUDE.md §5.8 v2 — 重寫版)
//
// 用詞:
//   - 「未採買空檔」(舊稱「送天數空窗」)= 同一 ad_code 連續兩段間「s2.start_date > s1.end_date」的 gap。
//     原因可能是廠商送天數,也可能是「到期沒續費後來再採買」,系統用同一套邏輯處理。
//   - 「shortfall」= 任一未來日,某產品的有效日花費 < 該產品該日的建議日花費下限。
//   - 「monthly underspend」= APP 產品本月預估月攤提 < 月預算 - 6 萬。
//
// 對外函式:
//   - detectFutureGaps(state, today): 列所有未來空檔(資訊用,不論有無 shortfall)。
//   - detectShortfalls(state, today): 列所有未來日 shortfall(不限是否在空檔內,baseline=0 也列出並導向採買)。
//   - detectAppMonthlyUnderspend(state, today): 列 APP 月攤提少花 > 6 萬的產品。
//   - planAdjustments(state, today): 按優先序產出調整建議。
//
// planAdjustments 規則(CLAUDE.md §5.8.2 v2):
//   優先 1 — 小島 daily shortfall: 必補,§3.2 ±0.5% 嚴格,雙邊不破。
//   優先 2 — APP monthly underspend > 6 萬: 把該產品日花費推到 band.upper 範圍內,
//             仍不足以收斂 underspend ≤ 6 萬則允許突破 upper。
//   優先 3 — APP daily shortfall: 軟性補下限,§3.2 ±30% 嚴格,雙邊不破。
//   候選來源廣告: 沒被鎖 (`!lock_perf_adjust`) + 該日 active。
//   候選來源產品: 來源廣告上現有 weight > 0 的非目標產品,排序「多花最嚴重 > 其他」。
//   目標產品可從 0% 加進廣告(規則 #4 — 不限有權重的產品互相調整)。

import { getMonthlyBudget, isNoBand } from "../schema.js";
import { bandsForMonth, checkMonthlyTotal } from "./budget.js";
import { dailySpendGrid, monthlyTotals } from "./spending.js";
import {
  todayTaipei, monthEnd, monthOf, nextDay, daysBetween, isInRange, diffDays,
} from "../lib/dates.js";

// APP 月攤提少花門檻(超過這個值就主動處理,沿用 §3.1 的 APP 容差)
const APP_UNDERSPEND_THRESHOLD = 60000;

// ========== 1. 偵測未來空檔(資訊用,不檢查 shortfall) ==========
// 回傳 [{ adCode, adName, gapStart(含), gapEnd(不含), gapDays, prevSeg, nextSeg, affectedPids:Set }]
export function detectFutureGaps(state, today) {
  if (!today) today = todayTaipei();
  const byCode = new Map();
  for (const a of state.ads || []) {
    if (a.eliminated) continue;
    if (!byCode.has(a.ad_code)) byCode.set(a.ad_code, []);
    byCode.get(a.ad_code).push(a);
  }

  const gaps = [];
  for (const [adCode, segs] of byCode) {
    segs.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
    for (let i = 0; i < segs.length - 1; i++) {
      const s1 = segs[i], s2 = segs[i + 1];
      if (!s1.end_date || !s2.start_date) continue;
      if (s2.start_date <= s1.end_date) continue;  // 沒空檔
      if (s2.start_date <= today) continue;        // 整段空檔已過

      const gapStart = s1.end_date >= today ? s1.end_date : today;
      const gapEnd = s2.start_date;
      if (gapEnd <= gapStart) continue;

      const affectedPids = new Set();
      for (const k of Object.keys(s1.weights || {})) {
        if (Number(s1.weights[k]) > 0) affectedPids.add(k);
      }
      for (const k of Object.keys(s2.weights || {})) {
        if (Number(s2.weights[k]) > 0) affectedPids.add(k);
      }

      gaps.push({
        adCode,
        adName: s2.ad_name || s1.ad_name,
        gapStart,
        gapEnd,
        gapDays: diffDays(gapStart, gapEnd),
        prevSeg: s1,
        nextSeg: s2,
        affectedPids,
      });
    }
  }
  return gaps;
}

// ========== 2. 偵測 shortfall(不限是否在空檔內)==========
// 回傳 [{ pid, productName, productType, days:[{date, baseline, lower, shortfall, noBaseline}], totalShortfall }]
export function detectShortfalls(state, today) {
  if (!today) today = todayTaipei();
  const ym = monthOf(today);
  const lastDay = monthEnd(ym);
  const scanEnd = nextDay(lastDay);

  const grid = dailySpendGrid(state.ads, ym);
  const out = [];

  for (const product of state.products || []) {
    if (isNoBand(product)) continue;
    const bands = bandsForMonth(state, product, ym);

    const days = [];
    for (const d of daysBetween(today, scanEnd)) {
      const band = bands[d];
      if (!band || !band.budget_set) continue;
      const baseline = grid[d]?.[product.id] || 0;
      if (baseline < band.lower) {
        days.push({ date: d, baseline, lower: band.lower, shortfall: band.lower - baseline, noBaseline: baseline <= 0 });
      }
    }

    if (days.length > 0) {
      out.push({
        pid: product.id,
        productName: product.name,
        productType: product.type,
        days,
        totalShortfall: days.reduce((s, x) => s + x.shortfall, 0),
      });
    }
  }
  return out;
}

// ========== 3. 偵測 APP 月攤提 underspend > 6 萬 ==========
// 回傳 [{ pid, productName, monthlyTotal, budget, underspend }]
export function detectAppMonthlyUnderspend(state, today, threshold = APP_UNDERSPEND_THRESHOLD) {
  if (!today) today = todayTaipei();
  const ym = monthOf(today);
  const totals = monthlyTotals(state.ads, ym);
  const out = [];
  for (const p of state.products || []) {
    if (p.type !== "app") continue;
    if (isNoBand(p)) continue;
    const budget = getMonthlyBudget(state, p.id, ym);
    if (budget == null) continue;
    const total = totals[p.id] || 0;
    const underspend = budget - total;
    if (underspend > threshold) {
      out.push({ pid: p.id, productName: p.name, monthlyTotal: total, budget, underspend });
    }
  }
  return out;
}

// ========== 4. planAdjustments — 按優先序產出建議 ==========
// 回傳 [{ ad, effective, sourcePid, targetPid, deltaW, kind:"fix", priority, reasonNote }]
export function planAdjustments(state, today) {
  if (!today) today = todayTaipei();

  const ym = monthOf(today);
  const lastDay = monthEnd(ym);
  const scanEnd = nextDay(lastDay);

  const productsById = Object.fromEntries((state.products || []).map((p) => [p.id, p]));

  // 已 schedule 的 fix(在 fromDate 之後該 ad 上 source 減 deltaW、target 加 deltaW)
  const activeFixes = [];
  const planned = [];

  // 月內 grid / band 快取(原始,不含 activeFixes)
  const gridCache = {};
  const getGrid = (mYm) => gridCache[mYm] || (gridCache[mYm] = dailySpendGrid(state.ads, mYm));
  const bandsCache = {};
  const getBands = (product, mYm) => {
    const k = `${product.id}|${mYm}`;
    return bandsCache[k] || (bandsCache[k] = bandsForMonth(state, product, mYm));
  };

  // 計算某產品 X 在 day 的有效日花費(原始 grid + 已 schedule 的 activeFixes 累積)
  const effectiveBaseline = (pid, day) => {
    const dayYm = monthOf(day);
    const grid = getGrid(dayYm);
    let s = grid[day]?.[pid] || 0;
    for (const fix of activeFixes) {
      if (fix.fromDate > day) continue;
      const ad = fix.ad;
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      const dailyTwd = Number(ad.daily_amort_twd) || 0;
      if (fix.targetPid === pid) s += dailyTwd * fix.deltaW / 100;
      if (fix.sourcePid === pid) s -= dailyTwd * fix.deltaW / 100;
    }
    return s;
  };

  // 該廣告在 day 的當前 weights(原始 + activeFixes 累積)
  const effectiveWeights = (ad, day) => {
    const w = { ...(ad.weights || {}) };
    for (const fix of activeFixes) {
      if (fix.ad.id !== ad.id) continue;
      if (fix.fromDate > day) continue;
      w[fix.sourcePid] = (Number(w[fix.sourcePid]) || 0) - fix.deltaW;
      w[fix.targetPid] = (Number(w[fix.targetPid]) || 0) + fix.deltaW;
    }
    return w;
  };

  // 來源產品的優先序計算(多花最嚴重 = priority 1,其他 = priority 3)
  function computeSourcePriority(state, sourceProduct, pid, dayYm, getGrid) {
    let priority = 3, score = 0;
    const budget = getMonthlyBudget(state, pid, dayYm);
    if (budget != null) {
      const grid = getGrid(dayYm);
      let monthSpent = 0;
      for (const d2 of daysBetween(`${dayYm}-01`, nextDay(monthEnd(dayYm)))) {
        monthSpent += grid[d2]?.[pid] || 0;
      }
      const check = checkMonthlyTotal(monthSpent, budget, sourceProduct.type);
      if (check.kind === "bad") {
        priority = 1;
        score = monthSpent - budget;
      }
    }
    return { priority, score };
  }

  // reasonNote 產生器
  const reasonOf = (candidate, product, sourceProduct, day, label) => {
    const sName = sourceProduct?.name || candidate.sourcePid;
    if (candidate.mode === "transfer") {
      return `${label} ${product.name} — ${sName} 整桶搬給 ${product.name}(${day} 起)`;
    }
    return `${label} ${product.name} — 從 ${sName} 借(${day} 起)`;
  };

  // 找最佳來源廣告 + 來源產品
  // 排序:多花的 source 優先(按 monthSpent - budget - tolerance 大者),其他平 priority
  // 候選分兩種:
  //   mode "split":自由 ad 上的某產品借部分(deltaW < 100)
  //   mode "transfer":🔒 鎖權重 ad 整桶搬(deltaW = 100,要求 ad 必須是「單一產品 100%」)
  // 🚫 禁止挪動:完全跳過
  // pickOpts.preferAppSource:補小島時用,讓 APP source 排在小島 source 前面
  //   理由:小島自己嚴格不能破 lower,所以小島之間互借常常會卡住;
  //         APP 是優先 3-4(不超月預算 / 平均日花費),為了補小島(優先 1)可以軟性犧牲 APP 下限
  const pickBestSource = (targetPid, day, pickOpts = {}) => {
    const dayYm = monthOf(day);
    const candidates = [];
    for (const ad of state.ads || []) {
      if (ad.eliminated) continue;
      if (ad.lock_full) continue;                 // 🚫 禁止挪動:跳過
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      const dailyTwd = Number(ad.daily_amort_twd) || 0;
      if (dailyTwd <= 0) continue;
      const w = effectiveWeights(ad, day);
      const isWeightLocked = !!ad.lock_perf_adjust;

      const nonZeroPids = Object.keys(w).filter((k) => Number(w[k]) > 0);
      const isSinglePid100 =
        nonZeroPids.length === 1 && Math.round(Number(w[nonZeroPids[0]])) === 100;

      const pushCandidate = (sourcePid, mode) => {
        const sourceProduct = productsById[sourcePid];
        if (!sourceProduct) return;
        const pri = computeSourcePriority(state, sourceProduct, sourcePid, dayYm, getGrid);
        // preferAppSource:APP source 比小島 source 優先(在補小島場景)
        const appPreferenceBonus = pickOpts.preferAppSource && sourceProduct.type === "app" ? 1 : 0;
        candidates.push({ ad, sourcePid, mode, sourceType: sourceProduct.type, appPreferenceBonus, ...pri });
      };

      if (isWeightLocked) {
        // 🔒 只能走 transfer
        if (!isSinglePid100) continue;
        const sourcePid = nonZeroPids[0];
        if (sourcePid === targetPid) continue;
        pushCandidate(sourcePid, "transfer");
      } else {
        // 自由 ad:走 split(每個非 target 產品都列為候選)
        const sourcePids = nonZeroPids.filter((k) => k !== targetPid);
        for (const pid of sourcePids) pushCandidate(pid, "split");
      }
    }
    candidates.sort((a, b) => {
      // 1) priority(多花最嚴重者前)
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 2) APP 偏好(補小島時讓 APP source 上)
      if (a.appPreferenceBonus !== b.appPreferenceBonus) return b.appPreferenceBonus - a.appPreferenceBonus;
      // 3) score(多花金額大者前)
      return b.score - a.score;
    });
    return candidates[0] || null;
  };

  // 把 deltaW(權重 %)受 §3.2 雙邊夾擠後,回傳合法的最大值
  // options.allowTargetUpperBreak: 允許 target 超出 band.upper(規則 3 用)
  // options.allowAppSourceLowerBreak: 允許 APP source 跌破 band.lower(Pass 1 補小島時用,
  //   反映使用者優先順序「小島補下限優先 1 > APP 不超月預算優先 3 > APP 平均日花費優先 4」)
  // 回傳:{ cap: 數字, sourceLowerBreached: bool, sourceProduct: pObj | null }
  const capByBands = (ad, sourcePid, targetPid, requestedW, day, options = {}) => {
    if (requestedW <= 0) return { cap: 0, sourceLowerBreached: false, sourceProduct: null };
    const dailyTwd = Number(ad.daily_amort_twd) || 0;
    if (dailyTwd <= 0) return { cap: 0, sourceLowerBreached: false, sourceProduct: null };

    let cap = requestedW;
    let sourceLowerBreached = false;

    // 1) source 端:整個 ad active 期間,削後不能破 band.lower
    //    例外:options.allowAppSourceLowerBreak 且 source 是 APP → 跳過此檢查,但標記 breached
    const sourceProduct = productsById[sourcePid];
    const skipSourceLowerCheck = options.allowAppSourceLowerBreak && sourceProduct && sourceProduct.type === "app";
    if (sourceProduct && !isNoBand(sourceProduct) && !skipSourceLowerCheck) {
      const start = day < ad.start_date ? ad.start_date : day;
      const end = ad.end_date < scanEnd ? ad.end_date : scanEnd;
      for (const d of daysBetween(start, end)) {
        const dayYm = monthOf(d);
        const bands = getBands(sourceProduct, dayYm);
        const band = bands[d];
        if (!band || !band.budget_set) continue;
        const cur = effectiveBaseline(sourcePid, d);
        const overLower = cur - band.lower;
        if (overLower <= 0) { cap = 0; break; }
        const wCap = Math.floor(overLower / dailyTwd * 100);
        if (wCap < cap) cap = wCap;
        if (cap <= 0) break;
      }
    } else if (skipSourceLowerCheck) {
      // APP source 跳過 lower 檢查,但事後判斷實際借出後是否真的破 lower(設標記)
      const start = day < ad.start_date ? ad.start_date : day;
      const end = ad.end_date < scanEnd ? ad.end_date : scanEnd;
      for (const d of daysBetween(start, end)) {
        const dayYm = monthOf(d);
        const bands = getBands(sourceProduct, dayYm);
        const band = bands[d];
        if (!band || !band.budget_set) continue;
        const cur = effectiveBaseline(sourcePid, d);
        // 借 cap% 後 source 在 d 的攤提 = cur - dailyTwd × cap/100
        const afterBorrow = cur - dailyTwd * cap / 100;
        if (afterBorrow < band.lower) { sourceLowerBreached = true; break; }
      }
    }
    if (cap <= 0) return { cap: 0, sourceLowerBreached: false, sourceProduct };

    // 2) target 端:除非 allowTargetUpperBreak,否則加後不能破 band.upper
    if (!options.allowTargetUpperBreak) {
      const targetProduct = productsById[targetPid];
      if (targetProduct && !isNoBand(targetProduct)) {
        const start = day < ad.start_date ? ad.start_date : day;
        const end = ad.end_date < scanEnd ? ad.end_date : scanEnd;
        for (const d of daysBetween(start, end)) {
          const dayYm = monthOf(d);
          const bands = getBands(targetProduct, dayYm);
          const band = bands[d];
          if (!band || !band.budget_set) continue;
          const cur = effectiveBaseline(targetPid, d);
          const headroom = band.upper - cur;
          if (headroom <= 0) { cap = 0; break; }
          const wCap = Math.floor(headroom / dailyTwd * 100);
          if (wCap < cap) cap = wCap;
          if (cap <= 0) break;
        }
      }
    }
    if (cap <= 0) return { cap: 0, sourceLowerBreached: false, sourceProduct };

    // 3) source 當前可借的權重(不能超過它目前還剩的)
    const w = effectiveWeights(ad, day);
    const sourceCurrent = Math.max(0, Number(w[sourcePid]) || 0);
    if (sourceCurrent < cap) cap = sourceCurrent;

    return { cap: Math.max(0, Math.floor(cap)), sourceLowerBreached, sourceProduct };
  };

  // schedule 一筆 fix,回傳實際配的 deltaW
  // options.mode = "transfer" → 整桶搬,deltaW 必須是 100 才能成立(不夠就 0)
  // options.mode = "split"(預設)→ 一般小額借
  const tryFix = (ad, sourcePid, targetPid, requestedW, day, priority, reasonNote, options = {}) => {
    let deltaW;
    let sourceLowerBreached = false;
    if (options.mode === "transfer") {
      // 整桶搬:要嘛 100% 全搬,要嘛不搬
      const r = capByBands(ad, sourcePid, targetPid, 100, day, options);
      if (r.cap < 100) return 0;
      deltaW = 100;
      sourceLowerBreached = r.sourceLowerBreached;
    } else {
      const r = capByBands(ad, sourcePid, targetPid, requestedW, day, options);
      if (r.cap <= 0) return 0;
      deltaW = r.cap;
      sourceLowerBreached = r.sourceLowerBreached;
    }
    activeFixes.push({ ad, sourcePid, targetPid, deltaW, fromDate: day });
    planned.push({
      ad, effective: day, sourcePid, targetPid, deltaW,
      kind: options.mode === "transfer" ? "transfer" : "fix",
      priority, reasonNote,
      sourceLowerBreached,  // 標記:此 fix 造成 source 跌破 lower,UI 應顯示警示
    });
    return deltaW;
  };

  // 算某產品 X 本月預估月攤提(原始過去 + effective 未來)
  const projectMonthly = (pid) => {
    const dayYm = monthOf(today);
    const grid = getGrid(dayYm);
    let total = 0;
    for (const d of daysBetween(`${dayYm}-01`, nextDay(monthEnd(dayYm)))) {
      if (d < today) total += grid[d]?.[pid] || 0;
      else total += effectiveBaseline(pid, d);
    }
    return total;
  };

  // === Pass 1 — 小島 daily shortfall(嚴格 ±0.5%)===
  // priority 1:使用者最在乎的「小島日花費一定要補到範圍」
  // 規則:
  //   - 來源優先選 APP 產品(因為小島嚴格不能破 lower,APP 是優先 3-4 可軟性犧牲)
  //   - 借完讓 APP source 跌破 lower 是允許的,但會標記 sourceLowerBreached → UI 提示需採買新廣告
  const islands = (state.products || []).filter((p) => p.type === "island" && !isNoBand(p));
  for (const product of islands) {
    for (const day of [...daysBetween(today, scanEnd)]) {
      const dayYm = monthOf(day);
      const bands = getBands(product, dayYm);
      const band = bands[day];
      if (!band || !band.budget_set) continue;
      const cur = effectiveBaseline(product.id, day);
      if (cur <= 0) continue;  // 該日無採買不處理
      if (cur >= band.lower) continue;
      const shortfall = band.lower - cur;
      // 第一輪:嚴格借(source 不破 lower)優先,APP source 排前面
      let candidate = pickBestSource(product.id, day, { preferAppSource: true });
      let got = 0;
      if (candidate) {
        const dailyTwd = Number(candidate.ad.daily_amort_twd) || 0;
        if (dailyTwd > 0) {
          const wantW = Math.ceil(shortfall / dailyTwd * 100);
          const sourceProduct = productsById[candidate.sourcePid];
          got = tryFix(
            candidate.ad, candidate.sourcePid, product.id, wantW, day,
            1,
            reasonOf(candidate, product, sourceProduct, day, "補小島"),
            { mode: candidate.mode }
          );
        }
      }
      // 第二輪:嚴格借不滿足 → 允許 APP source 跌破 lower 再試一次
      // (反映優先序:小島補下限 > APP 不超預算 > APP 平均日花費)
      if (got === 0) {
        candidate = pickBestSource(product.id, day, { preferAppSource: true });
        if (candidate) {
          const dailyTwd = Number(candidate.ad.daily_amort_twd) || 0;
          if (dailyTwd > 0) {
            const wantW = Math.ceil(shortfall / dailyTwd * 100);
            const sourceProduct = productsById[candidate.sourcePid];
            tryFix(
              candidate.ad, candidate.sourcePid, product.id, wantW, day,
              1,
              reasonOf(candidate, product, sourceProduct, day, "補小島(可能讓 APP 破下限)"),
              { mode: candidate.mode, allowAppSourceLowerBreak: true }
            );
          }
        }
      }
    }
  }

  // === Pass 2 — APP 月攤提少花 > 6 萬:推到 upper,仍不夠則突破 ===
  // priority 2:對應使用者「APP 平均日花費更好,做不到就以不花超過為主」 — 月度少花太多比單日 shortfall 嚴重
  const apps = (state.products || []).filter((p) => p.type === "app" && !isNoBand(p));
  for (const product of apps) {
    const budget = getMonthlyBudget(state, product.id, ym);
    if (budget == null) continue;
    let underspend = budget - projectMonthly(product.id);
    if (underspend <= APP_UNDERSPEND_THRESHOLD) continue;

    // 第一步:先推到 upper(不破)
    for (const day of [...daysBetween(today, scanEnd)]) {
      if (underspend <= APP_UNDERSPEND_THRESHOLD) break;
      const dayYm = monthOf(day);
      const bands = getBands(product, dayYm);
      const band = bands[day];
      if (!band || !band.budget_set) continue;
      const cur = effectiveBaseline(product.id, day);
      if (cur >= band.upper) continue;
      const headroom = band.upper - cur;
      const candidate = pickBestSource(product.id, day);
      if (!candidate) continue;
      const dailyTwd = Number(candidate.ad.daily_amort_twd) || 0;
      if (dailyTwd <= 0) continue;
      const wantW = Math.ceil(headroom / dailyTwd * 100);
      const sourceProduct = productsById[candidate.sourcePid];
      const got = tryFix(
        candidate.ad, candidate.sourcePid, product.id, wantW, day,
        2,
        reasonOf(candidate, product, sourceProduct, day, "補 APP 月預算"),
        { mode: candidate.mode }
      );
      if (got > 0) underspend = budget - projectMonthly(product.id);
    }

    // 第二步:仍不夠 → 突破 upper
    if (underspend > APP_UNDERSPEND_THRESHOLD) {
      for (const day of [...daysBetween(today, scanEnd)]) {
        if (underspend <= APP_UNDERSPEND_THRESHOLD) break;
        const candidate = pickBestSource(product.id, day);
        if (!candidate) continue;
        const dailyTwd = Number(candidate.ad.daily_amort_twd) || 0;
        if (dailyTwd <= 0) continue;
        // 想消化掉 (underspend - 60K),分散到剩下的天數
        const remainDays = [...daysBetween(day, scanEnd)].length || 1;
        const perDay = Math.ceil((underspend - APP_UNDERSPEND_THRESHOLD) / remainDays);
        const wantW = Math.ceil(perDay / dailyTwd * 100);
        const sourceProduct = productsById[candidate.sourcePid];
        const got = tryFix(
          candidate.ad, candidate.sourcePid, product.id, wantW, day,
          2,
          reasonOf(candidate, product, sourceProduct, day, "補 APP 月預算(突破上限)"),
          { allowTargetUpperBreak: true, mode: candidate.mode }
        );
        if (got > 0) underspend = budget - projectMonthly(product.id);
      }
    }
  }

  // === Pass 3 — APP daily shortfall(嚴格 ±30%)===
  // priority 3:軟性目標 — 能補就補,不能就接受月度容差內的少花
  for (const product of apps) {
    for (const day of [...daysBetween(today, scanEnd)]) {
      const dayYm = monthOf(day);
      const bands = getBands(product, dayYm);
      const band = bands[day];
      if (!band || !band.budget_set) continue;
      const cur = effectiveBaseline(product.id, day);
      if (cur <= 0) continue;
      if (cur >= band.lower) continue;
      const shortfall = band.lower - cur;
      const candidate = pickBestSource(product.id, day);
      if (!candidate) continue;
      const dailyTwd = Number(candidate.ad.daily_amort_twd) || 0;
      if (dailyTwd <= 0) continue;
      const wantW = Math.ceil(shortfall / dailyTwd * 100);
      const sourceProduct = productsById[candidate.sourcePid];
      tryFix(
        candidate.ad, candidate.sourcePid, product.id, wantW, day,
        3,
        reasonOf(candidate, product, sourceProduct, day, "補 APP 下限"),
        { mode: candidate.mode }
      );
    }
  }

  return planned;
}
