import { evalFormula } from "../lib/formula.js";
import { getMonthlyBudget, isNoBand, isNoBandPid, getReportVars } from "../schema.js";
import { bandFor, bandsForMonth } from "./budget.js";
import { adContributionPerMonth, dailySpendGrid } from "./spending.js";
import { daysOfMonth, isInRange, todayTaipei } from "../lib/dates.js";

// 評估一筆成效紀錄對該產品的「達標分數」：命中目標數 / 目標總數。
// extraVars: 公式可能參考的非 metric 變數(常見:收入匯率、支出匯率),用 schema.getReportVars(state) 取。
//   若不傳,公式裡的 收入匯率/支出匯率 會被替換成 0 → 「扣首儲收入後 CPI」這類目標系統性算錯。
// 回傳 { metCount, totalCount, ratio, details: [{name, actual, goal, met, delta}] }
export function scoreRecord(record, targets, extraVars = {}) {
  const vars = { ...record, ...extraVars };
  const details = [];
  let met = 0;
  for (const t of targets) {
    let actual = null;
    try { actual = evalFormula(t.formula, vars); } catch { actual = null; }
    if (actual == null || !Number.isFinite(actual)) {
      details.push({ name: t.name, actual: null, goal: t.goal_value, met: false, delta: null });
      continue;
    }
    const passed = t.direction === "lower_better" ? actual <= t.goal_value : actual >= t.goal_value;
    if (passed) met++;
    const delta = t.direction === "lower_better"
      ? (t.goal_value - actual) / Math.max(1e-9, t.goal_value)
      : (actual - t.goal_value) / Math.max(1e-9, t.goal_value);
    details.push({ name: t.name, actual, goal: t.goal_value, met: passed, delta, direction: t.direction });
  }
  const total = targets.length;
  return { metCount: met, totalCount: total, ratio: total ? met / total : null, details };
}

// 給某產品所有「有此產品權重」的廣告做建議。新算法（worst-first）：
//   1. 全部達標（ratio ≥ 1.0）或全部無資料 → 整個產品不調整
//   2. 否則只削掉「最爛」一支（未鎖、ratio < 1.0、最低 ratio），削多少取決於 (1 - ratio)
//   3. 削下來的權重等比例分給「其他未鎖」廣告（跳過最爛這支）
//   4. 鎖定者完全不動
//   5. 帶寬硬上限校正：如果新日峰值超過 band.upper，按 worst-first 從未鎖廣告削（同樣排序）
// 回傳 { adjustments, notes }
export function suggestProductAdjustments(state, product, ym) {
  const targets = product.performance_targets || [];
  const adsForProduct = state.ads.filter((a) => Number(a.weights?.[product.id]) > 0);
  if (adsForProduct.length === 0) return { adjustments: [], notes: [] };

  const reportVars = getReportVars(state, ym);
  const enriched = adsForProduct.map((a) => {
    // 配對成效紀錄：優先用 ad_code（同代碼跨段共用，最穩定）→ ad_id（精準到段）→ ad_name（fallback）
    // 之前單純用 ad_name 比對，遇到 perf 紀錄的 ad_name 與 active 段 ad_name 有微小差異時會配對失敗
    const rec = (state.performance_data || []).find(
      (r) => r.product_id === product.id && (
        r.ad_code === a.ad_code || r.ad_id === a.id || r.ad_name === a.ad_name
      )
    );
    const score = rec && targets.length ? scoreRecord(rec, targets, reportVars) : null;
    const old = Number(a.weights[product.id]) || 0;
    // 鎖定狀態:🔒 鎖權重 OR 🚫 禁止挪動 → 都從自動「分權重」候選中排除
    const lockState = a.lock_full ? "full" : (a.lock_perf_adjust ? "weight" : "free");
    return { ad: a, rec, score, old, locked: lockState !== "free", lockState };
  });

  const reasonOf = (score, lockState) => {
    if (lockState === "full") return "🚫 禁止挪動(自動不動)";
    if (lockState === "weight") return "🔒 鎖權重(自動不動)";
    if (!score || score.ratio == null) return "無成效資料 — 維持";
    if (score.ratio >= 1.0) return `達標 (${score.metCount}/${score.totalCount}) — 維持`;
    return `${(score.ratio * 100).toFixed(0)}% 達成 (${score.metCount}/${score.totalCount})`;
  };

  // 預設：所有廣告權重維持原樣
  const adjustments = enriched.map((x) => ({
    ad: x.ad, rec: x.rec, score: x.score,
    old: x.old, newWeight: x.old, delta: 0,
    locked: x.locked, lockState: x.lockState,
    reasonText: reasonOf(x.score, x.lockState),
  }));
  const byId = new Map(adjustments.map((a) => [a.ad.id, a]));

  const notes = [];

  // ── 找最爛者並削減 ─────────────────────────────
  // 條件：未鎖、有成效資料、ratio < 1.0
  const candidates = enriched.filter((x) => !x.locked && x.score && x.score.ratio != null && x.score.ratio < 1.0);
  if (candidates.length === 0) {
    notes.push(`${product.name}：無未達標的可調廣告（已達標或無資料／已鎖定），不調整`);
  } else {
    candidates.sort((a, b) => a.score.ratio - b.score.ratio);
    const worst = candidates[0];

    // 削減量 = old × (1 - ratio)（線性，全沒達標就全削掉）
    const reduceFloat = worst.old * (1 - worst.score.ratio);
    const reduceInt = Math.min(worst.old, Math.max(1, Math.round(reduceFloat)));

    // 接收者：未鎖、非最爛
    const recipients = enriched.filter((x) => !x.locked && x !== worst);

    // 套用削減
    byId.get(worst.ad.id).newWeight = worst.old - reduceInt;
    byId.get(worst.ad.id).delta = -reduceInt;
    byId.get(worst.ad.id).reasonText = `成效最差 ${(worst.score.ratio * 100).toFixed(0)}% — 削 ${reduceInt}%`;

    if (recipients.length === 0) {
      // 沒人能接 → 該產品的 sum 直接掉，per-ad scaling 之後會自動補
      notes.push(`${product.name}：最爛「${worst.ad.ad_code}」削 ${reduceInt}%，無其他未鎖廣告可接收（sum 暫降）`);
    } else {
      const totalRecipOld = recipients.reduce((s, r) => s + r.old, 0);
      const shares = recipients.map((r) => ({
        r,
        share: totalRecipOld > 0 ? (r.old / totalRecipOld) * reduceInt : reduceInt / recipients.length,
      }));
      shares.forEach((s) => { s.rounded = Math.round(s.share); });
      let allocated = shares.reduce((s, x) => s + x.rounded, 0);
      let diff = reduceInt - allocated;
      if (diff !== 0 && shares.length > 0) {
        shares.sort((a, b) => Math.abs(b.share - b.rounded) - Math.abs(a.share - a.rounded));
        for (let i = 0; i < shares.length && diff !== 0; i++) {
          const cap = diff > 0 ? Math.abs(diff) : Math.min(Math.abs(diff), shares[i].r.old + shares[i].rounded);
          const adj = diff > 0 ? cap : -cap;
          shares[i].rounded += adj;
          diff -= adj;
          if (shares[i].rounded < 0) {
            diff += -shares[i].rounded;
            shares[i].rounded = 0;
          }
        }
      }
      shares.forEach((s) => {
        const newW = s.r.old + s.rounded;
        const a = byId.get(s.r.ad.id);
        a.newWeight = newW;
        a.delta = s.rounded;
        if (s.rounded > 0) {
          a.reasonText = `${reasonOf(s.r.score, s.r.lockState)} — 接收 +${s.rounded}%`;
        }
      });
      notes.push(`${product.name}：「${worst.ad.ad_code}」(${(worst.score.ratio * 100).toFixed(0)}%) 削 ${reduceInt}% → 分給其他 ${recipients.length} 筆`);
    }
  }

  // ── 帶寬硬上限校正:成效最差者優先削掉 ─────────────
  // 用 per-day band(bandsForMonth)而非單一月平均;只檢查「今天起」的未來日。
  // 原本用 bandFor(月平均)有 budget_changes 時會跟 previewImpact 用的 per-day band 對不起來。
  // 此外只能削未來:newWeight 改不到過去日,若包含過去日 over upper → 演算法會誤削過量,
  // 反而讓未來 baseline 太低,cross-product redistribution 又補回去就衝過頭。
  if (ym && !isNoBand(product)) {
    const dayBands = bandsForMonth(state, product, ym);
    const today = todayTaipei();
    const allDays = Object.keys(dayBands).sort().filter((d) => d >= today);
    for (const day of allDays) {
      const band = dayBands[day];
      if (!band || !band.budget_set || band.upper <= 0) continue;
      // 重算該日的 peak(包含此 product 上所有 adjustment 後的 newWeight 貢獻)
      let dayPeak = 0;
      for (const adj of adjustments) {
        if (!isInRange(day, adj.ad.start_date, adj.ad.end_date)) continue;
        const w = Number(adj.newWeight) || 0;
        if (w <= 0) continue;
        dayPeak += (Number(adj.ad.daily_amort_twd) || 0) * (w / 100);
      }
      if (dayPeak <= band.upper) continue;
      const overTwd = dayPeak - band.upper;
      const onPeak = adjustments
        .filter((a) => !a.locked && isInRange(day, a.ad.start_date, a.ad.end_date) && a.newWeight > 0)
        .sort((a, b) => (a.score?.ratio ?? 0.5) - (b.score?.ratio ?? 0.5));
      let needRemoveTwd = overTwd;
      let cappedCount = 0;
      const removedFromAds = [];
      for (const adj of onPeak) {
        if (needRemoveTwd <= 0) break;
        const dailyTwd = Number(adj.ad.daily_amort_twd) || 0;
        if (dailyTwd <= 0) continue;
        const adContrib = dailyTwd * (adj.newWeight / 100);
        const dropContrib = Math.min(adContrib, needRemoveTwd);
        const dropPct = Math.min(adj.newWeight, Math.ceil(dropContrib / dailyTwd * 100));
        if (dropPct <= 0) continue;
        adj.newWeight -= dropPct;
        adj.delta = adj.newWeight - adj.old;
        adj.cappedByBand = true;
        needRemoveTwd -= dailyTwd * (dropPct / 100);
        cappedCount++;
        removedFromAds.push(`${adj.ad.ad_code}(-${dropPct}%)`);
      }
      if (cappedCount > 0) {
        notes.push(`${product.name} ${day} 日峰值 ${Math.round(dayPeak).toLocaleString()} > 上限 ${Math.round(band.upper).toLocaleString()},削 ${cappedCount} 筆:${removedFromAds.slice(0, 3).join("、")}${removedFromAds.length > 3 ? "…" : ""}`);
      }
      if (needRemoveTwd > 0.5) {
        notes.push(`${product.name} ${day} 仍有 ${Math.round(needRemoveTwd).toLocaleString()} TWD 超上限(鎖定廣告或所有未鎖已削至 0)`);
      }
    }
  }

  return { adjustments, notes };
}

// 計算某組 adjustments 套用 newWeight 後，該產品在 ym 各日中的最大攤提合計。
// 給 onlyDay 時只算那一天（用於計算鎖定廣告於峰值日的貢獻）。
function peakDailyForProduct(adjustments, productId, ym, onlyDay) {
  let maxPeak = 0;
  let peakDay = null;
  const days = onlyDay ? [onlyDay] : [...daysOfMonth(ym)];
  for (const day of days) {
    let sum = 0;
    for (const adj of adjustments) {
      const ad = adj.ad;
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      const w = Number(adj.newWeight) || 0;
      if (w <= 0) continue;
      sum += (Number(ad.daily_amort_twd) || 0) * (w / 100);
    }
    if (sum > maxPeak) { maxPeak = sum; peakDay = day; }
  }
  return { peak: maxPeak, day: peakDay };
}

// 成效調整只處理「end_date 在未來」的廣告 — 過去的攤提已經發生，無法調整。
// 同 ad_code 多段時，挑「對 ym 最相關」的未來段：
//   1. 包含 today 的段（最佳：今日切，未來新權重）
//   2. 否則：start_date 在未來的段中、最早開始的
//   3. 都沒有 → 該 ad_code 已全部過去 → 不處理
function selectActiveSegments(state, ym) {
  const today = todayTaipei();

  const byCode = new Map();
  for (const a of state.ads) {
    if (!a.end_date || a.end_date <= today) continue;  // 過去段直接過濾
    const key = a.ad_code;
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(a);
  }

  // 包含同 ad_code 的「**所有**未來 active 段」,不再只挑一個。
  // 為什麼:J-reverse import 會讓一個 ad_code 同時有多個 cycle(例如 st214 4/16-5/16 + 5/16-5/27)。
  // 如果只挑一個,band correction 計算 dayPeak 時會漏掉其他段,小島就可能套用後仍超上限
  // (5/16 漏掉 5/16-5/27 那段的貢獻 → 沒判定為超上限 → 沒削減)。
  const out = [];
  for (const segs of byCode.values()) {
    segs.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
    for (const s of segs) out.push(s);
  }
  return out;
}

// 把所有產品的建議組合成「以廣告為主」的視圖
// 每個 ad 一筆：
//   { ad, oldWeights, suggestedWeights, perProduct: [{product, old, new, score, reasonText, locked, cappedByBand, cappedByAdSum}], notes }
// 處理流程：
//   1. 依 ad_code 去重（同代碼多段只取對 ym 最相關的一段，其他過去/未來段不處理）
//   2. 對每個產品跑 suggestProductAdjustments（含帶寬硬上限校正）
//   3. 收尾：per-ad 合計若 > 100%，等比例縮回 100%（避免單一廣告權重總和爆掉）
export function buildAdPivot(state, ym) {
  const relevantAds = ym ? selectActiveSegments(state, ym) : state.ads;
  const synthState = { ...state, ads: relevantAds };

  const byAd = new Map();
  for (const a of relevantAds) {
    byAd.set(a.id, {
      ad: a,
      oldWeights: { ...(a.weights || {}) },
      suggestedWeights: { ...(a.weights || {}) },
      perProduct: [],
    });
  }
  const allNotes = [];
  for (const p of state.products) {
    const r = suggestProductAdjustments(synthState, p, ym);
    if (r.notes && r.notes.length) allNotes.push(...r.notes);
    for (const adj of r.adjustments) {
      const entry = byAd.get(adj.ad.id);
      if (!entry) continue;
      if (adj.newWeight > 0) entry.suggestedWeights[p.id] = adj.newWeight;
      else delete entry.suggestedWeights[p.id];
      entry.perProduct.push({
        product: p,
        old: adj.old,
        new: adj.newWeight,
        score: adj.score,
        reasonText: adj.reasonText,
        locked: adj.locked,
        cappedByBand: !!adj.cappedByBand,
        cappedByAdSum: false,
      });
    }
  }

  // ── per-ad 合計強制 = 100%（worst-first 削減 / best-first 增加，且 band-aware）─
  // 鎖定的廣告完全不動；perProduct 為空也跳過。
  // 重點：補 100% 時必須考慮各產品在當下的「日花費 vs band.upper」剩餘空間，
  // 不能盲目把削下的權重倒回最好分數的產品（先前 bug：JK/HYC/PJ8 因此被推回上限以上）。

  // 先建立 baseline 每產品每日攤提合計。
  //   過去日(d < today): 用 ad.weights(原權重) — 過去花費已經發生,改 newWeight 不影響;
  //                      若這裡也用 pp.new,pastSpend 會被低估,cross-product 會誤判少花太多
  //                      然後補太多,讓未來小島衝出 upper。
  //   今日及未來 (d >= today): 用 pp.new(建議權重) — 這是真的會發生的未來分布。
  const dailySpend = {};
  const days = ym ? [...daysOfMonth(ym)] : [];
  const _today = ym ? todayTaipei() : null;
  if (ym) {
    for (const day of days) dailySpend[day] = {};
    for (const e of byAd.values()) {
      const ad = e.ad;
      const daily = Number(ad.daily_amort_twd) || 0;
      if (daily <= 0) continue;
      for (const day of days) {
        if (!isInRange(day, ad.start_date, ad.end_date)) continue;
        if (day < _today) {
          // 過去日:用原權重(ad.weights),不用 pp.new
          for (const [pid, w] of Object.entries(ad.weights || {})) {
            const wn = Number(w) || 0;
            if (wn <= 0) continue;
            dailySpend[day][pid] = (dailySpend[day][pid] || 0) + daily * (wn / 100);
          }
        } else {
          // 今日及未來:用 pp.new(建議權重)
          for (const pp of e.perProduct) {
            const w = Number(pp.new) || 0;
            if (w <= 0) continue;
            dailySpend[day][pp.product.id] = (dailySpend[day][pp.product.id] || 0) + daily * (w / 100);
          }
        }
      }
    }
    // 不在 pivot 的廣告(過去段、被 selectActiveSegments 過濾掉的):一律用 ad.weights。
    for (const ad of state.ads) {
      if (byAd.has(ad.id)) continue;
      const daily = Number(ad.daily_amort_twd) || 0;
      if (daily <= 0) continue;
      for (const day of days) {
        if (!isInRange(day, ad.start_date, ad.end_date)) continue;
        for (const [pid, w] of Object.entries(ad.weights || {})) {
          const wn = Number(w) || 0;
          if (wn <= 0) continue;
          dailySpend[day][pid] = (dailySpend[day][pid] || 0) + daily * (wn / 100);
        }
      }
    }
  }

  // 各產品的 forward-only 每日帶寬（破圈跳過 — 破圈不檢查 daily band，但月度仍強制不超過預算）
  const productBands = {};
  if (ym) {
    for (const p of state.products) {
      if (isNoBand(p)) continue;
      productBands[p.id] = bandsForMonth(state, p, ym);
    }
  }

  // 過去日的攤提已凍結 — 改權重只影響未來，cap 評估只看未來日
  const today = todayTaipei();
  const futureDays = ym ? days.filter((d) => d >= today) : [];

  // 月度預算 cap：past 用 dailySpend 反映過去段權重的實際攤提；future 從 dailySpend baseline。
  // 過去日的權重已經由 segment 的 renewal_reason 鏈保留，計算值即為實際發生。
  const pastSpend = {};
  const futureSpend = {};
  if (ym) {
    const pastDays = days.filter((d) => d < today);
    for (const p of state.products) {
      let past = 0;
      for (const d of pastDays) {
        past += dailySpend[d]?.[p.id] || 0;
      }
      pastSpend[p.id] = past;
      let future = 0;
      for (const d of futureDays) {
        future += dailySpend[d]?.[p.id] || 0;
      }
      futureSpend[p.id] = future;
    }
  }

  // 給定 ad、pid，回傳「最多還能加多少權重點」同時滿足：
  //   1. （非破圈）每日花費 ≤ band.upper（forward-only 段帶寬）
  //   2. 月度合計（過去實際 + 未來 baseline + 此次新增）≤ 月預算（破圈與小島為硬上限）
  const maxAddableWeight = (ad, pid) => {
    if (!ym) return Infinity;
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) return 0;

    // 算 ad 在 future 內的活躍天數，順便取 daily band 最緊那天
    let minDailyHeadroom = Infinity;
    let activeFutureDays = 0;
    const checkBand = !isNoBandPid(state, pid) && !!productBands[pid];
    const bands = productBands[pid];
    for (const day of futureDays) {
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      activeFutureDays++;
      if (checkBand) {
        const band = bands[day];
        if (band && band.budget_set && band.upper > 0) {
          const cur = dailySpend[day]?.[pid] || 0;
          const headroom = band.upper - cur;
          if (headroom < minDailyHeadroom) minDailyHeadroom = headroom;
          if (minDailyHeadroom <= 0) return 0;
        }
      }
    }
    if (activeFutureDays === 0) return 0;
    const bandCapWeight = isFinite(minDailyHeadroom)
      ? Math.max(0, Math.floor(minDailyHeadroom / daily * 100))
      : Infinity;

    // 月度預算 cap（破圈/小島硬上限；APP 也走預算不留容差，避免自動建議冒進）
    const budget = getMonthlyBudget(state, pid, ym);
    if (budget == null) return bandCapWeight;
    const totalProjected = (pastSpend[pid] || 0) + (futureSpend[pid] || 0);
    const remaining = Math.max(0, budget - totalProjected);
    // 增加 X 權重點 ≈ daily × X/100 × activeFutureDays TWD
    const monthlyCapWeight = Math.max(0, Math.floor(remaining / (daily * activeFutureDays) * 100));

    return Math.min(bandCapWeight, monthlyCapWeight);
  };

  // 鏡像 maxAddableWeight:回傳「最多可削減多少權重點」而不破 band.lower
  // 用於 per-ad sum > 100 校正時(從成效爛的產品扣) — 沒有此檢查,小島會被砍到下限以下
  const maxRemovableWeight = (ad, pid, currentWeight) => {
    if (!ym) return currentWeight;
    if (isNoBandPid(state, pid)) return currentWeight;  // 破圈不檢查日帶寬
    const bands = productBands[pid];
    if (!bands) return currentWeight;
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) return 0;
    let minOverLower = Infinity;
    let activeDays = 0;
    for (const day of futureDays) {
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      activeDays++;
      const band = bands[day];
      if (!band || !band.budget_set) continue;
      const cur = dailySpend[day]?.[pid] || 0;
      const overLower = cur - band.lower;
      if (overLower < minOverLower) minOverLower = overLower;
      if (minOverLower <= 0) return 0;
    }
    if (activeDays === 0) return currentWeight;  // ad 已在過去 → 改權重不影響未來,可任削
    const bandCap = isFinite(minOverLower)
      ? Math.max(0, Math.floor(minOverLower / daily * 100))
      : currentWeight;
    return Math.min(bandCap, currentWeight);
  };

  const applyDelta = (ad, pid, delta) => {
    if (!ym || delta === 0) return;
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) return;
    for (const day of futureDays) {
      if (!isInRange(day, ad.start_date, ad.end_date)) continue;
      if (!dailySpend[day]) dailySpend[day] = {};
      const inc = daily * (delta / 100);
      dailySpend[day][pid] = (dailySpend[day][pid] || 0) + inc;
      futureSpend[pid] = (futureSpend[pid] || 0) + inc;
    }
  };

  // === 🔒 整桶搬建議(post-processing,在 sum 校正/淘汰判斷之前)===
  // 對 🔒 single-100% ad,若該產品成效 0.1 ≤ ratio < 0.3 → 建議整桶搬到「最少花的產品」(B1)
  // ratio < 0.1 (極差) → 不搬,留給下方淘汰判斷接手
  // 🚫 ads 完全不碰(由 suggestProductAdjustments 已標 lockState=full,維持原權重)
  if (ym) {
    const POOR_PERF_RATIO_THRESHOLD = 0.3;
    const TRANSFER_MIN_RATIO = 0.1;  // 低於此值不建議轉移,改建議淘汰
    const grid = dailySpendGrid(state.ads, ym);
    const monthSpentByPid = {};
    for (const day of [...daysOfMonth(ym)]) {
      for (const [pid, amt] of Object.entries(grid[day] || {})) {
        monthSpentByPid[pid] = (monthSpentByPid[pid] || 0) + amt;
      }
    }
    const pickTransferTarget = (excludePid) => {
      let best = null, bestRatio = Infinity;
      for (const p of state.products) {
        if (p.id === excludePid) continue;
        if (isNoBand(p)) continue;
        const budget = getMonthlyBudget(state, p.id, ym);
        if (budget == null || budget <= 0) continue;
        const spent = monthSpentByPid[p.id] || 0;
        const ratio = spent / budget;
        if (ratio < bestRatio) { bestRatio = ratio; best = p; }
      }
      return best;
    };

    for (const entry of byAd.values()) {
      const ad = entry.ad;
      if (ad.lock_full || !ad.lock_perf_adjust) continue;  // 只處理 🔒
      const w = entry.oldWeights;
      const nonZeroPids = Object.keys(w).filter((k) => Number(w[k]) > 0);
      if (nonZeroPids.length !== 1) continue;
      const sourcePid = nonZeroPids[0];
      if (Math.round(Number(w[sourcePid])) !== 100) continue;
      const sourcePP = entry.perProduct.find((pp) => pp.product.id === sourcePid);
      if (!sourcePP || !sourcePP.score || sourcePP.score.ratio == null) continue;
      if (sourcePP.score.ratio >= POOR_PERF_RATIO_THRESHOLD) continue;
      if (sourcePP.score.ratio < TRANSFER_MIN_RATIO) continue;  // 極差(< 10%) → 留給下方淘汰判斷

      const target = pickTransferTarget(sourcePid);
      if (!target) continue;

      const sourceProduct = state.products.find((p) => p.id === sourcePid);
      const tgtBudget = getMonthlyBudget(state, target.id, ym);
      const tgtSpent = monthSpentByPid[target.id] || 0;
      const tgtPct = tgtBudget > 0 ? Math.round(tgtSpent / tgtBudget * 100) : null;
      const reasonNote = `🔒 鎖權重 + 成效 ${(sourcePP.score.ratio * 100).toFixed(0)}% < ${POOR_PERF_RATIO_THRESHOLD * 100}% → 建議整桶搬到 ${target.name}${tgtPct != null ? `(月攤提 ${tgtPct}% 進度,最少花)` : ""}`;

      // 覆寫 suggestion
      entry.suggestedWeights = { [target.id]: 100 };
      entry.transferTarget = target.id;
      entry.transferSourcePid = sourcePid;
      entry.transferReason = reasonNote;

      // 更新 perProduct:source → 0,target → 100(target 不一定原本就在 perProduct 裡)
      sourcePP.new = 0;
      sourcePP.reasonText = reasonNote;
      let targetPP = entry.perProduct.find((pp) => pp.product.id === target.id);
      if (!targetPP) {
        entry.perProduct.push({
          product: target,
          old: 0,
          new: 100,
          score: null,
          reasonText: `🔒 整桶接收 ← ${sourceProduct?.name || sourcePid}`,
          locked: false,
          lockState: "free",
          cappedByBand: false,
          cappedByAdSum: false,
        });
      } else {
        targetPP.new = 100;
        targetPP.reasonText = `🔒 整桶接收 ← ${sourceProduct?.name || sourcePid}`;
      }

      // 同步 dailySpend / futureSpend / pastSpend:整桶搬把 source 的 100% 改為 target 的 100%。
      // 之前漏更新 → 後續 sum=100 校正 / cross-product redistribution 會用過時的 dailySpend,
      // 誤判 target 還有空間,導致小島 target 衝出 upper。
      // sourcePP.old / targetPP.old 是搬移前的權重(各自原本 100 / 0)。
      const sourceOldW = Number(sourcePP?.old) || 0;
      const targetOldW = Number((entry.perProduct.find((pp) => pp.product.id === target.id) || {}).old) || 0;
      const sourceDelta = -sourceOldW;       // source 從 sourceOldW 砍到 0
      const targetDelta = 100 - targetOldW;  // target 從 targetOldW 補到 100
      applyDelta(ad, sourcePid, sourceDelta);
      applyDelta(ad, target.id, targetDelta);

      allNotes.push(reasonNote);
    }
  }

  for (const entry of byAd.values()) {
    if (entry.transferTarget) continue;                                  // 🔒 整桶搬已決定,sum=100 不需校正,也不要 eliminate
    if (entry.perProduct.length === 0) continue;

    // 「建議淘汰」獨立判斷（不依賴 sum===0）：只要每個有權重的產品的「絕對成效 ratio」
    // 都 < threshold，就建議淘汰。worst-first 削減後的 sum 是相對排名結果，跟絕對成效無關 ——
    // 一支廣告可能對 A 產品「相對沒那麼差」（被加權重）但對所有產品仍「絕對未達標」。
    // 注意:🔒/🚫 鎖定的廣告也會跑此判斷(極差成效仍應提示淘汰)
    const ELIMINATE_RATIO_THRESHOLD = 0.3;
    if (entry.perProduct.length > 0) {
      const withScore = entry.perProduct.filter((pp) => pp.score && pp.score.ratio != null);
      const allHaveData = withScore.length === entry.perProduct.length && withScore.length > 0;
      const allBad = allHaveData && withScore.every((pp) => pp.score.ratio < ELIMINATE_RATIO_THRESHOLD);
      if (allBad) {
        entry.suggestEliminate = true;
        const ratios = withScore.map((pp) => `${pp.product.name} ${(pp.score.ratio * 100).toFixed(0)}%`).join("、");
        allNotes.push(`${entry.ad.ad_name}（${entry.ad.ad_code}）：所有 ${withScore.length} 個產品成效皆 < ${ELIMINATE_RATIO_THRESHOLD * 100}% (${ratios})，建議淘汰整支廣告`);
        // 既然建議淘汰,把先前 suggestProductAdjustments 對該筆廣告分到的「接收加成」
        // 全部還原成原權重 — 否則下面 sum=100 校正會被 continue 跳掉,留下 112% 之類的爛畫面。
        for (const pp of entry.perProduct) {
          pp.new = pp.old;
          pp.delta = 0;
          pp.scaleAdjust = 0;
          pp.cappedByAdSum = false;
        }
        entry.suggestedWeights = { ...entry.oldWeights };
        continue;  // 跳過 100% 校正 — 整支該死，不要把權重補到最佳產品
      }
    }

    // 🔒/🚫 鎖定廣告:走完淘汰判斷後,不做 sum 校正(權重不能動)
    if (entry.ad.lock_perf_adjust) continue;

    const sum = entry.perProduct.reduce((s, pp) => s + (Number(pp.new) || 0), 0);

    if (sum === 100) continue;

    // null score 視為中性（0.5），不會優先被砍也不會優先被加
    const scoreOf = (pp) => pp.score?.ratio ?? 0.5;

    if (sum > 100) {
      // 從最爛的產品先扣,但不能讓該產品任一日花費低於 band.lower(雙邊夾擠 — §3.2)
      // 之前缺這個檢查 → 已經在下限附近的小島會被進一步削到下限以下,impact 預覽顯示「低於下限」
      let excess = sum - 100;
      const sorted = [...entry.perProduct].sort((a, b) => scoreOf(a) - scoreOf(b));
      // 第一輪:守住 lower band
      for (const pp of sorted) {
        if (excess <= 0) break;
        const bandCap = maxRemovableWeight(entry.ad, pp.product.id, pp.new);
        const reduce = Math.min(pp.new, excess, bandCap);
        if (reduce > 0) {
          pp.new -= reduce;
          pp.cappedByAdSum = true;
          pp.scaleAdjust = (pp.scaleAdjust || 0) - reduce;
          excess -= reduce;
          applyDelta(entry.ad, pp.product.id, -reduce);
        }
      }
      // 第二輪:守不住下限的情況下,還是要把 sum 拉回 100(否則 ad weight sum 違規)。
      // 從成效最爛的產品再扣(忽略 lower band) — 這是無奈的取捨,並 push note 提醒。
      if (excess > 0) {
        for (const pp of sorted) {
          if (excess <= 0) break;
          const reduce = Math.min(pp.new, excess);
          if (reduce > 0) {
            pp.new -= reduce;
            pp.cappedByAdSum = true;
            pp.scaleAdjust = (pp.scaleAdjust || 0) - reduce;
            excess -= reduce;
            applyDelta(entry.ad, pp.product.id, -reduce);
          }
        }
        allNotes.push(`${entry.ad.ad_name}(${entry.ad.ad_code}):sum > 100 強制縮回時,有產品被削到下限以下(無法兼顧)`);
      }
    } else {
      // 補 sum=100。優先序:
      //   Phase A — 嚴格 band 補:既有 perProduct → 0% 產品(全類型),按 (band 容許) 加滿
      //     既有 sort by score desc(主題相關 + 成效好優先)
      //     0% sort by 月預算 gap desc(少花最多優先,順便用掉預算)
      //     小島也納入 0% 階段(strict band 內可加幾%就加幾%)
      //   Phase B — 仍有 deficit → 只允許在「APP 產品」突破 daily band.upper(月預算仍守)
      //     既有 APP → 0% APP,小島從不參與突破(嚴格 ±0.5%)
      // 設計依據:使用者 2026-05-09 決議「小島嚴格、APP 可突破 upper」+「0% 產品也要分」。
      // CLAUDE §5.4.2「範圍不放寬」對小島仍適用,APP 在 Phase B 改成軟限制以對齊 sum=100 強制。
      let deficit = 100 - sum;

      // ── Phase A:嚴格 band ──────────────────────────────
      // A1:既有 perProduct(主題已對,sort by 成效)
      const phaseA_existing = [...entry.perProduct].sort((a, b) => scoreOf(b) - scoreOf(a));
      for (const pp of phaseA_existing) {
        if (deficit <= 0) break;
        const addable = 100 - pp.new;
        const bandCap = maxAddableWeight(entry.ad, pp.product.id);
        const add = Math.min(addable, deficit, bandCap);
        if (add > 0) {
          pp.new += add;
          pp.cappedByAdSum = true;
          pp.scaleAdjust = (pp.scaleAdjust || 0) + add;
          deficit -= add;
          applyDelta(entry.ad, pp.product.id, add);
        }
      }
      // A2:0% 產品(全類型,strict band),sort by 月預算 gap desc
      if (deficit > 0) {
        const existingPids = new Set(entry.perProduct.map((pp) => pp.product.id));
        const phaseA_zero = [];
        for (const p of state.products) {
          if (existingPids.has(p.id)) continue;
          const bandCap = maxAddableWeight(entry.ad, p.id);
          if (bandCap <= 0) continue;
          const budget = getMonthlyBudget(state, p.id, ym);
          const projected = (pastSpend[p.id] || 0) + (futureSpend[p.id] || 0);
          const gap = budget != null ? budget - projected : 0;
          phaseA_zero.push({ p, bandCap, gap });
        }
        phaseA_zero.sort((a, b) => b.gap - a.gap);
        for (const { p, bandCap } of phaseA_zero) {
          if (deficit <= 0) break;
          const add = Math.min(deficit, bandCap);
          if (add <= 0) continue;
          entry.perProduct.push({
            product: p,
            old: 0,
            new: add,
            score: null,
            reasonText: "",
            locked: false,
            lockState: "free",
            cappedByBand: false,
            cappedByAdSum: true,
            scaleAdjust: add,
            systemAdded: true,
          });
          deficit -= add;
          applyDelta(entry.ad, p.id, add);
        }
      }

      // ── Phase B:只 APP 產品,允許突破日 band.upper(月預算仍硬擋)──────────
      if (deficit > 0) {
        const monthlyCapApp = (ad, pid) => {
          const daily = Number(ad.daily_amort_twd) || 0;
          if (daily <= 0) return 0;
          let active = 0;
          for (const day of futureDays) {
            if (isInRange(day, ad.start_date, ad.end_date)) active++;
          }
          if (active === 0) return 0;
          const budget = getMonthlyBudget(state, pid, ym);
          if (budget == null) return 100;
          const totalProjected = (pastSpend[pid] || 0) + (futureSpend[pid] || 0);
          const remaining = Math.max(0, budget - totalProjected);
          return Math.max(0, Math.floor(remaining / (daily * active) * 100));
        };

        // B1:既有 APP perProduct(可能在 phaseA 已加部分;這裡再 boost)
        const phaseB_existing = [...entry.perProduct]
          .filter((pp) => pp.product.type === "app")
          .sort((a, b) => scoreOf(b) - scoreOf(a));
        for (const pp of phaseB_existing) {
          if (deficit <= 0) break;
          const addable = 100 - pp.new;
          const cap = monthlyCapApp(entry.ad, pp.product.id);
          const add = Math.min(addable, deficit, cap);
          if (add > 0) {
            pp.new += add;
            pp.cappedByAdSum = true;
            pp.scaleAdjust = (pp.scaleAdjust || 0) + add;
            pp.bandBreached = true;
            deficit -= add;
            applyDelta(entry.ad, pp.product.id, add);
          }
        }

        // B2:0% APP 產品(phaseA 沒能加進去的 APP 產品 — 多半是月預算還有但 band 不夠)
        if (deficit > 0) {
          const existingPids = new Set(entry.perProduct.map((pp) => pp.product.id));
          const phaseB_zero = [];
          for (const p of state.products) {
            if (p.type !== "app") continue;
            if (existingPids.has(p.id)) continue;
            const cap = monthlyCapApp(entry.ad, p.id);
            if (cap <= 0) continue;
            const budget = getMonthlyBudget(state, p.id, ym);
            const projected = (pastSpend[p.id] || 0) + (futureSpend[p.id] || 0);
            const gap = budget != null ? budget - projected : 0;
            phaseB_zero.push({ p, cap, gap });
          }
          phaseB_zero.sort((a, b) => b.gap - a.gap);
          for (const { p, cap } of phaseB_zero) {
            if (deficit <= 0) break;
            const add = Math.min(deficit, cap);
            if (add <= 0) continue;
            entry.perProduct.push({
              product: p,
              old: 0,
              new: add,
              score: null,
              reasonText: "",
              locked: false,
              lockState: "free",
              cappedByBand: false,
              cappedByAdSum: true,
              scaleAdjust: add,
              systemAdded: true,
              bandBreached: true,
            });
            deficit -= add;
            applyDelta(entry.ad, p.id, add);
          }
        }
      }

      if (deficit > 0) {
        allNotes.push(`${entry.ad.ad_name}（${entry.ad.ad_code}）：sum=${100 - deficit}%，所有產品 band/月預算 都用盡(小島嚴格不破),剩 ${deficit}% 無法補`);
      }
    }

    // 把 sum=100 校正的 delta 加進 reasonText，讓使用者看到「per-product 削／接收」之外
    // 還被「per-ad 補滿／縮回」加減多少（避免 reason 看起來只 +1%、實際 +39% 的混淆）
    for (const pp of entry.perProduct) {
      const adj = pp.scaleAdjust || 0;
      if (adj !== 0) {
        const verb = adj > 0 ? "補滿" : "縮回";
        const sign = adj > 0 ? "+" : "";
        const tail = ` — ${verb} ${sign}${adj}%`;
        pp.reasonText = pp.reasonText ? `${pp.reasonText}${tail}` : tail.replace(/^ — /, "");
      }
    }

    // 更新 suggestedWeights map
    for (const pp of entry.perProduct) {
      if (pp.new > 0) entry.suggestedWeights[pp.product.id] = pp.new;
      else delete entry.suggestedWeights[pp.product.id];
    }
    const finalSum = entry.perProduct.reduce((s, pp) => s + (Number(pp.new) || 0), 0);
    if (finalSum !== sum) {
      const action = sum > 100 ? `從最爛的削回` : `加到最好的補滿`;
      allNotes.push(`${entry.ad.ad_name}（${entry.ad.ad_code}）原合計 ${sum}% → ${action} ${finalSum}%`);
    }
  }

  // ── 跨產品補少花（CLAUDE.md §5.4.2）─────────────────────────
  // 對每個少花 > 容差的產品 X，從多花最嚴重 / 成效最爛的產品挪權重過來
  // 用「零和轉移」(source -= ΔW, X += ΔW) 維持 per-ad sum=100%
  // §3.2 帶寬雙邊強制：source 不掉到 band.lower、X 不超過 band.upper
  if (ym) {
    applyCrossProductRedistribution({
      state, byAd, ym, dailySpend, pastSpend, futureSpend,
      futureDays, productBands, allNotes,
    });
  }

  // 只保留至少一個產品有權重的廣告（含跨產品新增的 systemAdded）
  const pivot = [...byAd.values()].filter((e) =>
    Object.keys(e.oldWeights).length > 0 || (e.perProduct || []).some((pp) => pp.new > 0)
  );

  // 自我審計:跑完所有 pass 後,檢查是否仍有未來日 over upper / under lower。
  // 若有,印 console.warn 表格讓使用者(和開發者)定位 bug —— 哪一支廣告貢獻了多少。
  // 修完之後預期應該是空表;有東西出現就代表演算法還沒修對。
  if (ym) {
    const _today = todayTaipei();
    const violations = [];
    for (const p of state.products) {
      if (isNoBand(p)) continue;
      const bands = productBands[p.id];
      if (!bands) continue;
      for (const [day, band] of Object.entries(bands)) {
        if (day < _today) continue;
        if (!band || !band.budget_set || band.upper <= 0) continue;
        const cur = dailySpend[day]?.[p.id] || 0;
        if (cur > band.upper + 0.5) {
          // 找出該日該產品所有貢獻的廣告
          const breakdown = [];
          let anyBreached = false;
          for (const e of pivot) {
            if (!isInRange(day, e.ad.start_date, e.ad.end_date)) continue;
            const pp = e.perProduct.find((x) => x.product.id === p.id);
            const w = pp ? Number(pp.new) || 0 : 0;
            if (w <= 0) continue;
            if (pp.bandBreached) anyBreached = true;
            const contrib = (Number(e.ad.daily_amort_twd) || 0) * (w / 100);
            breakdown.push({ ad: `${e.ad.ad_code} ${e.ad.ad_name}`, w, contrib: Math.round(contrib), src: pp.systemAdded ? "cross-product" : "originalOrSplit", breached: !!pp.bandBreached });
          }
          // APP 產品 + 有貢獻者標 bandBreached → 是 sum=100 補的故意突破,不算 bug
          const expected = (p.type === "app") && anyBreached;
          violations.push({
            product: p.name, day, cur: Math.round(cur),
            upper: Math.round(band.upper), over: Math.round(cur - band.upper),
            ads: breakdown, expected,
          });
        } else if (cur > 0 && cur < band.lower - 0.5) {
          violations.push({
            product: p.name, day, cur: Math.round(cur),
            lower: Math.round(band.lower), under: Math.round(band.lower - cur),
            kind: "under",
          });
        }
      }
    }
    const unexpected = violations.filter((v) => !v.expected);
    const expected = violations.filter((v) => v.expected);
    if (unexpected.length > 0) {
      console.warn(`[perf-adjust] ${unexpected.length} 筆「非預期」band 違規(可能是演算法 bug),詳情:`);
      for (const v of unexpected.slice(0, 20)) {
        if (v.kind === "under") {
          console.warn(`  ${v.day} ${v.product} cur=${v.cur} < lower=${v.lower} (under ${v.under})`);
        } else {
          console.warn(`  ${v.day} ${v.product} cur=${v.cur} > upper=${v.upper} (over ${v.over})`);
          for (const b of v.ads) {
            console.warn(`    [${b.src}] ${b.ad} weight=${b.w}% contrib=${b.contrib}`);
          }
        }
      }
      if (unexpected.length > 20) console.warn(`  …還有 ${unexpected.length - 20} 筆`);
    }
    if (expected.length > 0) {
      console.info(`[perf-adjust] ${expected.length} 筆 APP 產品「故意」突破日上限(為了補 sum=100,小島仍嚴格不破)。這是設計行為。`);
    }
  }

  pivot.notes = allNotes;
  return pivot;
}

// 跨產品補少花：對少花超過容差的產品 X，從廣告 Y 上「多花最嚴重 / 成效最爛」的產品挪權重給 X。
// 零和轉移（source -= ΔW，X += ΔW），不破壞 per-ad sum=100%。
// §3.2 帶寬雙邊強制（X 不超 upper、source 不低 lower）。破圈跳過。
function applyCrossProductRedistribution({
  state, byAd, ym, dailySpend, pastSpend, futureSpend, futureDays, productBands, allNotes,
}) {
  // 容差：APP 60K、小島 20K（§3.1）
  const tolerance = (type) => type === "app" ? 60000 : 20000;

  // 算出每個產品的當前狀態（gap > tolerance 視為少花）
  const computeStatus = () => {
    const out = {};
    for (const p of state.products) {
      const budget = getMonthlyBudget(state, p.id, ym);
      const projected = (pastSpend[p.id] || 0) + (futureSpend[p.id] || 0);
      out[p.id] = {
        product: p,
        budget,
        projected,
        gap: budget != null ? budget - projected : null,
        tolerance: tolerance(p.type),
      };
    }
    return out;
  };

  // 算「廣告 ad 的活躍未來天數」（用於把月度缺口換算成權重點）
  const activeFutureDaysOf = (ad) => {
    let n = 0;
    for (const d of futureDays) if (isInRange(d, ad.start_date, ad.end_date)) n++;
    return n;
  };

  // X 在這支廣告還能「加多少權重」（看 X 的 daily band.upper + 月預算 cap）
  const maxAddable = (ad, targetPid) => {
    if (isNoBandPid(state, targetPid)) {
      // 「不檢查每日帶寬」產品只檢查月預算
      const budget = getMonthlyBudget(state, targetPid, ym);
      if (budget == null) return 0;
      const remaining = Math.max(0, budget - ((pastSpend[targetPid] || 0) + (futureSpend[targetPid] || 0)));
      const dailyTwd = Number(ad.daily_amort_twd) || 0;
      const days = activeFutureDaysOf(ad);
      if (dailyTwd <= 0 || days === 0) return 0;
      return Math.max(0, Math.floor(remaining / (dailyTwd * days) * 100));
    }
    const dailyTwd = Number(ad.daily_amort_twd) || 0;
    if (dailyTwd <= 0) return 0;
    const bands = productBands[targetPid];
    if (!bands) return 0;
    let minHeadroom = Infinity;
    let activeDays = 0;
    for (const d of futureDays) {
      if (!isInRange(d, ad.start_date, ad.end_date)) continue;
      activeDays++;
      const band = bands[d];
      if (!band || !band.budget_set || band.upper <= 0) continue;
      const cur = dailySpend[d]?.[targetPid] || 0;
      const headroom = band.upper - cur;
      if (headroom < minHeadroom) minHeadroom = headroom;
      if (minHeadroom <= 0) return 0;
    }
    if (activeDays === 0) return 0;
    const bandCap = isFinite(minHeadroom) ? Math.max(0, Math.floor(minHeadroom / dailyTwd * 100)) : Infinity;
    // 月預算 cap
    const budget = getMonthlyBudget(state, targetPid, ym);
    if (budget == null) return bandCap;
    const remaining = Math.max(0, budget - ((pastSpend[targetPid] || 0) + (futureSpend[targetPid] || 0)));
    const monthlyCap = Math.max(0, Math.floor(remaining / (dailyTwd * activeDays) * 100));
    return Math.min(bandCap, monthlyCap);
  };

  // source 在這支廣告還能「削多少權重」而不掉到 band.lower 以下
  const maxRemovable = (ad, sourcePid, currentWeight) => {
    if (isNoBandPid(state, sourcePid)) return currentWeight;  // 「不檢查每日帶寬」產品不限制削多少
    const dailyTwd = Number(ad.daily_amort_twd) || 0;
    if (dailyTwd <= 0) return 0;
    const bands = productBands[sourcePid];
    if (!bands) return currentWeight;
    let minOverLower = Infinity;
    let activeDays = 0;
    for (const d of futureDays) {
      if (!isInRange(d, ad.start_date, ad.end_date)) continue;
      activeDays++;
      const band = bands[d];
      if (!band || !band.budget_set) continue;
      const cur = dailySpend[d]?.[sourcePid] || 0;
      const overLower = cur - band.lower;
      if (overLower < minOverLower) minOverLower = overLower;
      if (minOverLower <= 0) return 0;
    }
    if (activeDays === 0) return 0;
    const bandCap = isFinite(minOverLower) ? Math.max(0, Math.floor(minOverLower / dailyTwd * 100)) : currentWeight;
    return Math.min(bandCap, currentWeight);
  };

  // applyDelta(ad, pid, delta)：更新 dailySpend / futureSpend
  const applyDelta = (ad, pid, deltaWeight) => {
    const dailyTwd = Number(ad.daily_amort_twd) || 0;
    if (dailyTwd <= 0 || deltaWeight === 0) return;
    for (const d of futureDays) {
      if (!isInRange(d, ad.start_date, ad.end_date)) continue;
      const inc = dailyTwd * (deltaWeight / 100);
      if (!dailySpend[d]) dailySpend[d] = {};
      dailySpend[d][pid] = (dailySpend[d][pid] || 0) + inc;
      futureSpend[pid] = (futureSpend[pid] || 0) + inc;
    }
  };

  // 主循環
  let status = computeStatus();
  const underspentList = state.products
    .filter((p) => status[p.id].gap != null && status[p.id].gap > status[p.id].tolerance)
    .sort((a, b) => status[b.id].gap - status[a.id].gap);

  for (const X of underspentList) {
    const xStatus = status[X.id];
    if (xStatus.gap <= xStatus.tolerance) continue;  // 可能在前一輪被補完了

    // 蒐集 candidates: (entry, sourcePp, priority, ranking)
    const candidates = [];
    for (const entry of byAd.values()) {
      if (entry.ad.lock_perf_adjust) continue;
      if (entry.suggestEliminate) continue;
      // X 在此廣告已有權重 → 跳過（既有 algo 會處理）
      const existingX = entry.perProduct.find((pp) => pp.product.id === X.id && pp.new > 0);
      if (existingX) continue;
      for (const pp of entry.perProduct) {
        if (pp.new <= 0) continue;
        if (pp.product.id === X.id) continue;
        const sourceStatus = status[pp.product.id];
        const isOverspent = sourceStatus.gap != null && sourceStatus.gap < -sourceStatus.tolerance;
        const isWorst = pp.score?.ratio != null && pp.score.ratio < 0.5;
        if (!isOverspent && !isWorst) continue;
        candidates.push({
          entry, sourcePp: pp,
          priority: isOverspent ? 1 : 2,
          overspendAmount: isOverspent ? -sourceStatus.gap : 0,
          sourceScore: pp.score?.ratio ?? 0.5,
        });
      }
    }
    // 排序：多花優先（多花最嚴重者前）；其次最爛（score 最低者前）
    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.priority === 1) return b.overspendAmount - a.overspendAmount;
      return a.sourceScore - b.sourceScore;
    });

    for (const c of candidates) {
      if (xStatus.gap <= xStatus.tolerance) break;  // 補夠了
      const { entry, sourcePp } = c;
      const ad = entry.ad;
      const dailyTwd = Number(ad.daily_amort_twd) || 0;
      if (dailyTwd <= 0) continue;
      const days = activeFutureDaysOf(ad);
      if (days === 0) continue;

      const xCap = maxAddable(ad, X.id);
      const sourceCap = maxRemovable(ad, sourcePp.product.id, sourcePp.new);
      // 還需要多少權重點（把 gap TWD 換算）
      const needWeight = Math.ceil(xStatus.gap / (dailyTwd * days));
      const deltaW = Math.min(xCap, sourceCap, sourcePp.new, needWeight);
      if (deltaW <= 0) continue;

      // 執行零和轉移
      sourcePp.new -= deltaW;
      sourcePp.crossLent = (sourcePp.crossLent || 0) + deltaW;
      const existingX = entry.perProduct.find((pp) => pp.product.id === X.id);
      if (existingX) {
        existingX.new += deltaW;
        existingX.systemAdded = true;
        existingX.crossBorrowed = (existingX.crossBorrowed || 0) + deltaW;
      } else {
        entry.perProduct.push({
          product: X,
          old: 0,
          new: deltaW,
          score: null,
          reasonText: `補 ${X.name} 預算 — 從「${sourcePp.product.name}」借 ${deltaW}%`,
          locked: false,
          cappedByBand: false,
          cappedByAdSum: false,
          systemAdded: true,
          crossBorrowed: deltaW,
        });
      }
      // 同步 suggestedWeights
      entry.suggestedWeights = entry.suggestedWeights || {};
      entry.suggestedWeights[sourcePp.product.id] = sourcePp.new;
      entry.suggestedWeights[X.id] = (entry.suggestedWeights[X.id] || 0) + deltaW;

      // 更新 dailySpend / futureSpend
      applyDelta(ad, sourcePp.product.id, -deltaW);
      applyDelta(ad, X.id, deltaW);

      // 更新 status
      status = computeStatus();

      allNotes.push(`跨產品補預算：「${ad.ad_code}」${sourcePp.product.name} ${sourcePp.new + deltaW}%→${sourcePp.new}%、${X.name} 新增 +${deltaW}%`);
    }
  }
}

// ── 給 UI 用：每產品的預算狀態 (CLAUDE.md §5.4.2 視覺提示) ────────
// 回傳 { [pid]: { product, budget, projected, gap, headroom, tolerance, isUnderspent, isOverspent } }
// - gap > 0 = 還沒花到預算（headroom = gap）
// - gap < -tolerance = 多花
// - 0 < gap < tolerance = 接近預算（容差內）
export function computeProductBudgetStatus(state, ym, pivot) {
  const result = {};
  // 用 pivot 的 newWeights 算預估 spend；若 pivot 為空（無建議），fallback 用既有 weights
  const today = todayTaipei();
  const days = ym ? [...daysOfMonth(ym)] : [];
  const pastDays = days.filter((d) => d < today);
  const futureDays = days.filter((d) => d >= today);

  // 重建 dailySpend：past 用真實段（state.ads 的 weights）、future 用 pivot 的 newWeights
  const dailySpend = {};
  for (const d of days) dailySpend[d] = {};

  // Past: state.ads 真實 weights
  for (const ad of state.ads) {
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) continue;
    for (const d of pastDays) {
      if (!isInRange(d, ad.start_date, ad.end_date)) continue;
      for (const [pid, w] of Object.entries(ad.weights || {})) {
        const wn = Number(w) || 0;
        if (wn <= 0) continue;
        dailySpend[d][pid] = (dailySpend[d][pid] || 0) + daily * (wn / 100);
      }
    }
  }

  // Future: 從 pivot 的 perProduct 取 new；不在 pivot 的廣告(過去段)也納入
  const adIdsInPivot = new Set((pivot || []).map((e) => e.ad.id));
  for (const e of (pivot || [])) {
    const daily = Number(e.ad.daily_amort_twd) || 0;
    if (daily <= 0) continue;
    for (const d of futureDays) {
      if (!isInRange(d, e.ad.start_date, e.ad.end_date)) continue;
      for (const pp of e.perProduct) {
        const w = Number(pp.new) || 0;
        if (w <= 0) continue;
        dailySpend[d][pp.product.id] = (dailySpend[d][pp.product.id] || 0) + daily * (w / 100);
      }
    }
  }
  for (const ad of state.ads) {
    if (adIdsInPivot.has(ad.id)) continue;
    const daily = Number(ad.daily_amort_twd) || 0;
    if (daily <= 0) continue;
    for (const d of futureDays) {
      if (!isInRange(d, ad.start_date, ad.end_date)) continue;
      for (const [pid, w] of Object.entries(ad.weights || {})) {
        const wn = Number(w) || 0;
        if (wn <= 0) continue;
        dailySpend[d][pid] = (dailySpend[d][pid] || 0) + daily * (wn / 100);
      }
    }
  }

  for (const p of state.products) {
    const budget = getMonthlyBudget(state, p.id, ym);
    let projected = 0;
    for (const d of days) projected += dailySpend[d]?.[p.id] || 0;
    const gap = budget != null ? budget - projected : null;
    const tol = p.type === "app" ? 60000 : 20000;
    result[p.id] = {
      product: p,
      budget,
      projected,
      gap,
      headroom: gap != null && gap > 0 ? gap : 0,
      tolerance: tol,
      isUnderspent: gap != null && gap > tol,
      isOverspent: gap != null && gap < -tol,
      hasBudget: budget != null,
    };
  }
  return result;
}

// 模擬將 newWeightsByAd（adId → {pid: weight}）套上去之後，每個產品的當月攤提 + 每日峰值。
//
// 重點：權重調整只影響「今日（含）之後」的攤提（過去日的權重由 segment renewal 鏈固定，
// 改權重也回不去）。所以 daily peak 只取 future 區間，避免拿過去日的高峰誤導使用者
// — 例如「破解吧 04-22 開新段那一天 peak 13,894」這種數字會誤認為今日花費。
// 月度合計仍取整月加總，因為 budget 是月度概念。
//
// 回傳 [{ product, budget, band,
//        oldTotal, newTotal,
//        oldDailyPeak, newDailyPeak, oldPeakDay, newPeakDay }]
export function previewImpact(state, ym, newWeightsByAd) {
  const cloneAds = state.ads.map((a) => ({
    ...a,
    weights: newWeightsByAd[a.id] || { ...(a.weights || {}) },
  }));
  const oldGrid = dailySpendGrid(state.ads, ym);
  const newGrid = dailySpendGrid(cloneAds, ym);

  const today = todayTaipei();
  const allDays = [...daysOfMonth(ym)];
  // peak 評估區間：今日（含）之後；若整月已過 → 取月底當參考
  const futureDays = allDays.filter((d) => d >= today);
  const evalDays = futureDays.length > 0 ? futureDays : allDays.slice(-1);
  const refDay = futureDays[0] || (allDays.length ? allDays[allDays.length - 1] : null);

  const oldTotals = {}; const newTotals = {};
  // 月度合計：過去日的 oldGrid 已反映過去段權重（segment chain 保留），new 權重不能改回去。
  // 未來日才用 newGrid 反映模擬權重。
  for (const day of allDays) {
    const isPast = day < today;
    for (const p of state.products) {
      const oldAmt = oldGrid[day]?.[p.id] || 0;
      const newAmt = isPast ? oldAmt : (newGrid[day]?.[p.id] || 0);
      oldTotals[p.id] = (oldTotals[p.id] || 0) + oldAmt;
      newTotals[p.id] = (newTotals[p.id] || 0) + newAmt;
    }
  }
  // peak：只看 future 區間
  const oldPeak = {}; const newPeak = {};
  const oldPeakDay = {}; const newPeakDay = {};
  for (const day of evalDays) {
    for (const [pid, amt] of Object.entries(oldGrid[day] || {})) {
      if ((oldPeak[pid] || 0) < amt) { oldPeak[pid] = amt; oldPeakDay[pid] = day; }
    }
    for (const [pid, amt] of Object.entries(newGrid[day] || {})) {
      if ((newPeak[pid] || 0) < amt) { newPeak[pid] = amt; newPeakDay[pid] = day; }
    }
  }

  return state.products.map((p) => {
    const budget = getMonthlyBudget(state, p.id, ym);
    const dayBands = refDay ? bandsForMonth(state, p, ym) : null;
    const dayBand = (refDay && dayBands?.[refDay]?.budget_set) ? dayBands[refDay] : null;
    const band = dayBand || bandFor(p, ym, budget);
    return {
      product: p,
      budget,
      band,
      oldTotal: oldTotals[p.id] || 0,
      newTotal: newTotals[p.id] || 0,
      oldDailyPeak: oldPeak[p.id] || 0,
      newDailyPeak: newPeak[p.id] || 0,
      oldPeakDay: oldPeakDay[p.id] || null,
      newPeakDay: newPeakDay[p.id] || null,
    };
  });
}
