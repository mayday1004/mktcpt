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

// 事後拆出破圈/一般分流配對:對既有單支廣告(沒有 split_pair_id)在 effectiveDate 起拆成
// parent (stXXX) + t-variant (stXXXt) 兩支,共用 split_pair_id,
// 日後修改任一支權重會透過 rebalanceSplitPair 自動同步。
//
// 雙向支援(parent 永遠是一般側、t-variant 永遠是破圈側,命名慣例不變):
//   - Forward(source 為一般 100%):
//     parentWeights = source.weights(保留),tVariantWeights = { 新破圈產品: 100 }
//   - Reverse(source 為破圈 100%):
//     parentWeights = { 新一般產品: 100 },tVariantWeights = source.weights(原破圈權重)
// caller 決定方向,本函式只負責產出 segments + amount 比例分配。
//
// options:
//   - tVariantPct (1~99):t-variant 那一支的金額占比(parent 拿 100 − pct)
//   - parentWeights:parent 那一支的 weights({ pid: % },加總 = 100)
//   - tVariantWeights:t-variant 那一支的 weights({ pid: % },加總 = 100)
//   - notes (選填):parent 段的備註
//
// 回 { closed, parentNewSeg, tVariantNewAd, pairId }
export function buildPoquanSplit(source, effectiveDate, options) {
  const { tVariantPct, parentWeights, tVariantWeights, notes } = options || {};
  if (source.split_pair_id) {
    throw new Error("此廣告已是破圈分流配對,不能再拆");
  }
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  const pct = Number(tVariantPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) {
    throw new Error("拆分占比必須是 1~99 之間");
  }
  const validWeights = (w) => {
    if (!w || typeof w !== "object") return false;
    const keys = Object.keys(w).filter((k) => Number(w[k]) > 0);
    if (keys.length === 0) return false;
    const sum = keys.reduce((s, k) => s + Number(w[k]), 0);
    return Math.abs(sum - 100) <= 0.01;
  };
  if (!validWeights(parentWeights)) throw new Error("parent 權重必填且加總須 = 100%");
  if (!validWeights(tVariantWeights)) throw new Error("t-variant 權重必填且加總須 = 100%");

  const pairId = `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const parentRatio = (100 - pct) / 100;
  const tVariantRatio = pct / 100;
  const round2 = (n) => Math.round(n * 100) / 100;
  const baseDaily = Number(source.daily_amort_twd) || (Number(source.amount_twd) / Number(source.amortize_days) || 0);

  const closed = trimEnd(source, effectiveDate);

  const parentNewSeg = spawnFrom(source, {
    start_date: effectiveDate,
    end_date: source.end_date,
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * parentRatio),
    amount_cny: round2((Number(source.amount_cny) || 0) * parentRatio),
    amount_twd: (Number(source.amount_twd) || 0) * parentRatio,
    daily_amort_twd: baseDaily * parentRatio,
    weights: { ...parentWeights },
    renewal_reason: "權重調整",
    notes: (notes && String(notes).trim()) ? String(notes).trim() : "事後拆分破圈/一般分流配對",
    split_pair_id: pairId,
    split_role: "parent",
  });

  const tvKeys = Object.keys(tVariantWeights).filter((k) => Number(tVariantWeights[k]) > 0);
  const tvPurchaseMode = (tvKeys.length === 1 && Number(tVariantWeights[tvKeys[0]]) === 100) ? "independent" : "shared";

  const tVariantNewAd = {
    id: uid("ad"),
    ad_code: source.ad_code + "t",
    ad_name: (source.ad_name || "") + "t",
    group: source.group || "",
    currency: source.currency || "CNY",
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * tVariantRatio),
    currency_rate: source.currency_rate || 1,
    amount_cny: round2((Number(source.amount_cny) || 0) * tVariantRatio),
    exchange_rate: source.exchange_rate,
    amount_twd: (Number(source.amount_twd) || 0) * tVariantRatio,
    start_date: effectiveDate,
    end_date: source.end_date,
    amortize_days: source.amortize_days,
    daily_amort_twd: baseDaily * tVariantRatio,
    purchase_mode: tvPurchaseMode,
    weights: { ...tVariantWeights },
    lock_perf_adjust: false,
    lock_full: false,
    eliminated: false,
    renewal_of: null,
    renewal_reason: "初始",
    notes: `破圈分流配對(由 ${source.ad_code} 事後拆出 ${pct}%)`,
    split_pair_id: pairId,
    split_role: "t_variant",
  };

  return { closed, parentNewSeg, tVariantNewAd, pairId };
}
