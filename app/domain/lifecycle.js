import { uid } from "../state.js";

// 共用：依 weights 內容判斷 purchase_mode
function pickPurchaseMode(weights) {
  const keys = Object.keys(weights || {}).filter((k) => Number(weights[k]) > 0);
  return (keys.length === 1 && Number(weights[keys[0]]) === 100) ? "independent" : "shared";
}

// 將源段套上「於 effectiveDate 收尾」效果（不變動段以外資料）
function trimEnd(source, effectiveDate) {
  return { ...source, end_date: effectiveDate };
}

// 開新段：沿用源段所有欄位，覆蓋指定 patch；自動帶上 renewal_of
function spawnFrom(source, patch) {
  const next = {
    id: uid("ad"),
    ad_code: source.ad_code,
    ad_name: source.ad_name,
    group: source.group || "",
    currency: source.currency || "CNY",
    amount_orig: source.amount_orig != null ? source.amount_orig : source.amount_cny,
    currency_rate: source.currency_rate || 1,
    amount_cny: source.amount_cny,
    exchange_rate: source.exchange_rate,
    amount_twd: source.amount_twd,
    start_date: source.end_date,
    end_date: source.end_date,
    amortize_days: source.amortize_days,
    daily_amort_twd: source.daily_amort_twd,
    purchase_mode: source.purchase_mode || "shared",
    weights: { ...(source.weights || {}) },
    lock_perf_adjust: !!source.lock_perf_adjust,
    lock_full: !!source.lock_full,
    eliminated: !!source.eliminated,
    // 破圈分流配對(若源段有 split_pair_id 一併傳承,否則 undefined)
    split_pair_id: source.split_pair_id || undefined,
    split_role: source.split_role || undefined,
    renewal_of: source.id,
    renewal_reason: "續費",
    ...patch,
  };
  next.purchase_mode = pickPurchaseMode(next.weights);
  return next;
}

// 權重調整：生效日 + 新 weights + 選填備註，金額/匯率/攤提天/每日攤提皆沿用
//
// 備註欄是給「跨產品搬遷」做註記用（例：「AV9 50% → 愛威奶破圈 50%」）。
// 「轉移」事件已併入此函式（CLAUDE.md §3.4），新段一律 renewal_reason='權重調整'，
// 跨產品的細節在備註欄記錄。
export function buildWeightAdjust(source, effectiveDate, newWeights, notes) {
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  const closed = trimEnd(source, effectiveDate);
  const patch = {
    start_date: effectiveDate,
    end_date: source.end_date,
    weights: { ...newWeights },
    renewal_reason: "權重調整",
  };
  if (notes != null && String(notes).trim()) patch.notes = String(notes).trim();
  const newSeg = spawnFrom(source, patch);
  return { closed, segments: [newSeg] };
}

// 事後拆出破圈分流:對既有單支廣告(沒有 split_pair_id)在 effectiveDate 起拆成 parent + t-variant
// 兩支廣告共用 split_pair_id,日後修改任一支權重會透過 rebalanceSplitPair 自動同步。
//
// 拆分行為:
//   1. trim 源段 end_date 到 effectiveDate (收尾)
//   2. 開新 parent 段(同代碼 stXXX):金額 = 原 × (100 − pct)%,權重沿用原 weights,
//      renewal_reason='權重調整',備註寫拆分原因
//   3. 開新 t-variant 廣告(新 ad_code = 原代碼 + "t"):金額 = 原 × pct%,
//      weights = { poquanProductId: 100 }, renewal_reason='初始'
//   4. 兩支同時帶 split_pair_id (parent + t_variant)
//
// 回 { closed, parentNewSeg, tVariantNewAd, pairId }
export function buildPoquanSplit(source, effectiveDate, poquanPct, poquanProductId, notes) {
  if (source.split_pair_id) {
    throw new Error("此廣告已是破圈分流配對,不能再拆");
  }
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  const pct = Number(poquanPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
    throw new Error("破圈占比必須是 1~99 之間");
  }
  if (!poquanProductId) {
    throw new Error("請選破圈分配的目標產品");
  }
  if ((source.weights || {})[poquanProductId] > 0) {
    throw new Error("破圈目標產品已存在於原廣告權重中,請先用「權重調整」移除");
  }

  const pairId = `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const normalRatio = (100 - pct) / 100;
  const poquanRatio = pct / 100;
  const round2 = (n) => Math.round(n * 100) / 100;
  const baseDaily = Number(source.daily_amort_twd) || (Number(source.amount_twd) / Number(source.amortize_days) || 0);

  const closed = trimEnd(source, effectiveDate);

  const parentNewSeg = spawnFrom(source, {
    start_date: effectiveDate,
    end_date: source.end_date,
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * normalRatio),
    amount_cny: round2((Number(source.amount_cny) || 0) * normalRatio),
    amount_twd: (Number(source.amount_twd) || 0) * normalRatio,
    daily_amort_twd: baseDaily * normalRatio,
    weights: { ...(source.weights || {}) },
    renewal_reason: "權重調整",
    notes: (notes && String(notes).trim()) ? String(notes).trim() : `事後拆出破圈分流 ${pct}% → ${poquanProductId}`,
    split_pair_id: pairId,
    split_role: "parent",
  });

  const tVariantNewAd = {
    id: uid("ad"),
    ad_code: source.ad_code + "t",
    ad_name: (source.ad_name || "") + "t",
    group: source.group || "",
    currency: source.currency || "CNY",
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * poquanRatio),
    currency_rate: source.currency_rate || 1,
    amount_cny: round2((Number(source.amount_cny) || 0) * poquanRatio),
    exchange_rate: source.exchange_rate,
    amount_twd: (Number(source.amount_twd) || 0) * poquanRatio,
    start_date: effectiveDate,
    end_date: source.end_date,
    amortize_days: source.amortize_days,
    daily_amort_twd: baseDaily * poquanRatio,
    purchase_mode: "independent",
    weights: { [poquanProductId]: 100 },
    lock_perf_adjust: false,
    lock_full: false,
    eliminated: false,
    renewal_of: null,
    renewal_reason: "初始",
    notes: `破圈分流(由 ${source.ad_code} 事後拆出 ${pct}%)`,
    split_pair_id: pairId,
    split_role: "t_variant",
  };

  return { closed, parentNewSeg, tVariantNewAd, pairId };
}
