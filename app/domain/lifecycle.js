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

// 送天數：在 [pauseStart, pauseEnd) 期間把 pausedProductIds 暫停（權重=0），
// pauseEnd 之後開第三段恢復原權重直到原 end_date。
// 若 pauseStart === source.start_date：直接從 source 暫停（不需先 trim）。
// 若 pauseEnd >= source.end_date：略過恢復段。
export function buildGiftDays(source, pauseStart, pauseEnd, pausedProductIds) {
  if (pauseStart < source.start_date || pauseStart >= source.end_date) {
    throw new Error(`暫停起日 ${pauseStart} 必須在原段區間內`);
  }
  if (pauseEnd <= pauseStart) {
    throw new Error(`暫停迄日必須晚於起日`);
  }
  const effectiveEnd = pauseEnd > source.end_date ? source.end_date : pauseEnd;
  const pausedSet = new Set(pausedProductIds);
  const pausedWeights = {};
  Object.entries(source.weights || {}).forEach(([pid, w]) => {
    pausedWeights[pid] = pausedSet.has(pid) ? 0 : Number(w) || 0;
  });

  const pausedSeg = spawnFrom(source, {
    start_date: pauseStart,
    end_date: effectiveEnd,
    weights: pausedWeights,
    renewal_reason: "送天數",
  });
  const closed = trimEnd(source, pauseStart);
  const segments = [pausedSeg];
  if (effectiveEnd < source.end_date) {
    const restoredSeg = spawnFrom(source, {
      start_date: effectiveEnd,
      end_date: source.end_date,
      weights: { ...(source.weights || {}) },
      renewal_reason: "送天數結束",
      renewal_of: pausedSeg.id,
    });
    segments.push(restoredSeg);
  }
  return { closed, segments };
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

// 提前結束：直接修改源段 end_date，不開新段
export function buildEndEarly(source, endDate) {
  if (endDate <= source.start_date) {
    throw new Error(`結束日必須晚於開始日 ${source.start_date}`);
  }
  if (endDate >= source.end_date) {
    throw new Error(`結束日已不晚於原 end_date ${source.end_date}，無需動作`);
  }
  return { closed: trimEnd(source, endDate), segments: [] };
}
