import { evalFormula } from "../lib/formula.js";
import { getMonthlyBudget, NO_BAND_PIDS } from "../schema.js";
import { bandFor, bandsForMonth } from "./budget.js";
import { adContributionPerMonth, dailySpendGrid } from "./spending.js";
import { daysOfMonth, isInRange, todayTaipei } from "../lib/dates.js";

// 評估一筆成效紀錄對該產品的「達標分數」：命中目標數 / 目標總數。
// 回傳 { metCount, totalCount, ratio, details: [{name, actual, goal, met, delta}] }
export function scoreRecord(record, targets) {
  const details = [];
  let met = 0;
  for (const t of targets) {
    let actual = null;
    try { actual = evalFormula(t.formula, record); } catch { actual = null; }
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

  const enriched = adsForProduct.map((a) => {
    // 配對成效紀錄：優先用 ad_code（同代碼跨段共用，最穩定）→ ad_id（精準到段）→ ad_name（fallback）
    // 之前單純用 ad_name 比對，遇到 perf 紀錄的 ad_name 與 active 段 ad_name 有微小差異時會配對失敗
    const rec = (state.performance_data || []).find(
      (r) => r.product_id === product.id && (
        r.ad_code === a.ad_code || r.ad_id === a.id || r.ad_name === a.ad_name
      )
    );
    const score = rec && targets.length ? scoreRecord(rec, targets) : null;
    const old = Number(a.weights[product.id]) || 0;
    return { ad: a, rec, score, old, locked: !!a.lock_perf_adjust };
  });

  const reasonOf = (score, locked) => {
    if (locked) return "已鎖定（不調整）";
    if (!score || score.ratio == null) return "無成效資料 — 維持";
    if (score.ratio >= 1.0) return `達標 (${score.metCount}/${score.totalCount}) — 維持`;
    return `${(score.ratio * 100).toFixed(0)}% 達成 (${score.metCount}/${score.totalCount})`;
  };

  // 預設：所有廣告權重維持原樣
  const adjustments = enriched.map((x) => ({
    ad: x.ad, rec: x.rec, score: x.score,
    old: x.old, newWeight: x.old, delta: 0,
    locked: x.locked, reasonText: reasonOf(x.score, x.locked),
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
          a.reasonText = `${reasonOf(s.r.score, false)} — 接收 +${s.rounded}%`;
        }
      });
      notes.push(`${product.name}：「${worst.ad.ad_code}」(${(worst.score.ratio * 100).toFixed(0)}%) 削 ${reduceInt}% → 分給其他 ${recipients.length} 筆`);
    }
  }

  // ── 帶寬硬上限校正：成效最差者優先削掉 ─────────────
  if (ym && !NO_BAND_PIDS.has(product.id)) {
    const budget = getMonthlyBudget(state, product.id, ym);
    const band = bandFor(product, ym, budget);
    if (band.upper > 0) {
      const peakInfo = peakDailyForProduct(adjustments, product.id, ym);
      if (peakInfo.peak > band.upper) {
        const overTwd = peakInfo.peak - band.upper;
        // 該日活躍且未鎖的廣告，依成效（ratio）由低到高排
        const day = peakInfo.day;
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
          // 此筆最多可釋放的權重 → 100% 對應的 TWD = dailyTwd × weight/100
          const adContrib = dailyTwd * (adj.newWeight / 100);
          const dropContrib = Math.min(adContrib, needRemoveTwd);
          // 換算回扣多少權重點（向上取整避免 underflow）
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
          notes.push(`${product.name} 於 ${day} 新日峰值 ${Math.round(peakInfo.peak).toLocaleString()} > 建議花費值上緣 ${Math.round(band.upper).toLocaleString()}，按成效最差優先削減 ${cappedCount} 筆：${removedFromAds.slice(0, 3).join("、")}${removedFromAds.length > 3 ? "…" : ""}`);
        }
        if (needRemoveTwd > 0.5) {
          notes.push(`${product.name} 仍有 ${Math.round(needRemoveTwd).toLocaleString()} TWD/日 超緣（鎖定廣告貢獻或所有未鎖已削至 0）`);
        }
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

  const out = [];
  for (const segs of byCode.values()) {
    segs.sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
    let pick = segs.find((s) => s.start_date <= today && today < s.end_date);  // 1. 含今日
    if (!pick) pick = segs[0];  // 2. 最早開始的未來段
    if (pick) out.push(pick);
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

  // 先建立 baseline：依目前 newWeights 算出每產品每日攤提合計
  const dailySpend = {};
  const days = ym ? [...daysOfMonth(ym)] : [];
  if (ym) {
    for (const day of days) dailySpend[day] = {};
    for (const e of byAd.values()) {
      const ad = e.ad;
      const daily = Number(ad.daily_amort_twd) || 0;
      if (daily <= 0) continue;
      for (const day of days) {
        if (!isInRange(day, ad.start_date, ad.end_date)) continue;
        for (const pp of e.perProduct) {
          const w = Number(pp.new) || 0;
          if (w <= 0) continue;
          dailySpend[day][pp.product.id] = (dailySpend[day][pp.product.id] || 0) + daily * (w / 100);
        }
      }
    }
    // 把不在 pivot 但仍貢獻 ym 的廣告（過去段、被 selectActiveSegments 過濾掉的）也算進來，
    // 否則 cap 計算會低估 baseline 而誤以為仍有空間
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
      if (NO_BAND_PIDS.has(p.id)) continue;
      productBands[p.id] = bandsForMonth(state, p, ym);
    }
  }

  // 過去日的攤提已凍結（看 daily_amort_override），改權重也回不去 → cap 評估只看未來日
  const today = todayTaipei();
  const futureDays = ym ? days.filter((d) => d >= today) : [];

  // 月度預算 cap：past 用 daily_amort_override 反映實際發生（不是計算出來的），future 從 dailySpend baseline
  // 這樣才能正確算「剩餘預算」 — 否則用計算值會跟儀表板的真實累積花費對不上
  const pastSpend = {};
  const futureSpend = {};
  if (ym) {
    const pastDays = days.filter((d) => d < today);
    for (const p of state.products) {
      let past = 0;
      for (const d of pastDays) {
        const ov = state.daily_amort_override?.[d]?.[p.id];
        past += Number.isFinite(ov) ? ov : (dailySpend[d]?.[p.id] || 0);
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
    const checkBand = !NO_BAND_PIDS.has(pid) && !!productBands[pid];
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

  for (const entry of byAd.values()) {
    if (entry.ad.lock_perf_adjust) continue;
    if (entry.perProduct.length === 0) continue;

    const sum = entry.perProduct.reduce((s, pp) => s + (Number(pp.new) || 0), 0);

    // 「建議淘汰」獨立判斷（不依賴 sum===0）：只要每個有權重的產品的「絕對成效 ratio」
    // 都 < threshold，就建議淘汰。worst-first 削減後的 sum 是相對排名結果，跟絕對成效無關 ——
    // 一支廣告可能對 A 產品「相對沒那麼差」（被加權重）但對所有產品仍「絕對未達標」。
    const ELIMINATE_RATIO_THRESHOLD = 0.3;
    if (entry.perProduct.length > 0) {
      const withScore = entry.perProduct.filter((pp) => pp.score && pp.score.ratio != null);
      const allHaveData = withScore.length === entry.perProduct.length && withScore.length > 0;
      const allBad = allHaveData && withScore.every((pp) => pp.score.ratio < ELIMINATE_RATIO_THRESHOLD);
      if (allBad) {
        entry.suggestEliminate = true;
        const ratios = withScore.map((pp) => `${pp.product.name} ${(pp.score.ratio * 100).toFixed(0)}%`).join("、");
        allNotes.push(`${entry.ad.ad_name}（${entry.ad.ad_code}）：所有 ${withScore.length} 個產品成效皆 < ${ELIMINATE_RATIO_THRESHOLD * 100}% (${ratios})，建議淘汰整支廣告`);
        continue;  // 跳過 100% 校正 — 整支該死，不要把權重補到最佳產品
      }
    }

    if (sum === 100) continue;

    // null score 視為中性（0.5），不會優先被砍也不會優先被加
    const scoreOf = (pp) => pp.score?.ratio ?? 0.5;

    if (sum > 100) {
      // 從最爛的產品先扣
      let excess = sum - 100;
      const sorted = [...entry.perProduct].sort((a, b) => scoreOf(a) - scoreOf(b));
      for (const pp of sorted) {
        if (excess <= 0) break;
        const reducible = pp.new;
        const reduce = Math.min(reducible, excess);
        if (reduce > 0) {
          pp.new -= reduce;
          pp.cappedByAdSum = true;
          pp.scaleAdjust = (pp.scaleAdjust || 0) - reduce;
          excess -= reduce;
          applyDelta(entry.ad, pp.product.id, -reduce);
        }
      }
    } else {
      // 從最好的產品先加，但不能讓該產品任一日花費超出 band.upper
      let deficit = 100 - sum;
      const sorted = [...entry.perProduct].sort((a, b) => scoreOf(b) - scoreOf(a));
      for (const pp of sorted) {
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
      if (deficit > 0) {
        // 所有未爆 band 上限的產品都已加滿，仍有缺口 → 維持 sum<100，記 note
        allNotes.push(`${entry.ad.ad_name}（${entry.ad.ad_code}）：補 100% 受建議花費值限制，剩 ${deficit}% 未補（合計 ${100 - deficit}%）`);
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

  // 只保留至少一個產品有權重的廣告
  const pivot = [...byAd.values()].filter((e) => Object.keys(e.oldWeights).length > 0);
  pivot.notes = allNotes;
  return pivot;
}

// 模擬將 newWeightsByAd（adId → {pid: weight}）套上去之後，每個產品的當月攤提 + 每日峰值。
//
// 重點：權重調整只影響「今日（含）之後」的攤提（過去日已凍結、由 daily_amort_override 主導，
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
  // 月度合計：過去日用 daily_amort_override（實際發生）、未來日用權重計算值。
  // 否則「整月都用 new weights」會誤導 — 過去日改不了權重，硬塞 new weights 會與儀表板對不上。
  for (const day of allDays) {
    const isPast = day < today;
    for (const p of state.products) {
      let oldAmt, newAmt;
      if (isPast) {
        const ov = state.daily_amort_override?.[day]?.[p.id];
        oldAmt = Number.isFinite(ov) ? ov : (oldGrid[day]?.[p.id] || 0);
        newAmt = oldAmt;  // 過去日 new=old（改不了）
      } else {
        oldAmt = oldGrid[day]?.[p.id] || 0;
        newAmt = newGrid[day]?.[p.id] || 0;
      }
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
