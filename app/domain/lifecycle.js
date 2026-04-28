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
    renewal_of: source.id,
    renewal_reason: "續費",
    ...patch,
  };
  next.purchase_mode = pickPurchaseMode(next.weights);
  return next;
}

// 權重調整：生效日 + 新 weights，金額/匯率/攤提天/每日攤提皆沿用
export function buildWeightAdjust(source, effectiveDate, newWeights) {
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  const closed = trimEnd(source, effectiveDate);
  const newSeg = spawnFrom(source, {
    start_date: effectiveDate,
    end_date: source.end_date,
    weights: { ...newWeights },
    renewal_reason: "權重調整",
  });
  return { closed, segments: [newSeg] };
}

// 轉移：生效日 + 新 weights（使用者手填，例如把 AV9 的 50% 移到 av9_poquan）
// 不檢查源/目產品具體欄位，只負責關段+開新段
export function buildTransfer(source, effectiveDate, newWeights) {
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間之間`);
  }
  const closed = trimEnd(source, effectiveDate);
  const newSeg = spawnFrom(source, {
    start_date: effectiveDate,
    end_date: source.end_date,
    weights: { ...newWeights },
    renewal_reason: "轉移",
  });
  return { closed, segments: [newSeg] };
}

