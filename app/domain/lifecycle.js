import { uid } from "../state.js";
import { detectFamilyCollision, splitWeightsByFamily, deriveSplitCodes } from "./auto-split.js";

// 共用：依 weights 內容判斷 purchase_mode
function pickPurchaseMode(weights) {
  const keys = Object.keys(weights || {}).filter((k) => Number(weights[k]) > 0);
  return (keys.length === 1 && Number(weights[keys[0]]) === 100) ? "independent" : "shared";
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

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
    // 段建立當下的代碼(預設沿用 source.ad_code;caller 可在 patch 覆寫)
    code_at_creation: source.ad_code,
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
    code_at_creation: source.ad_code,
  };
  if (notes != null && String(notes).trim()) patch.notes = String(notes).trim();
  const newSeg = spawnFrom(source, patch);
  return { closed, segments: [newSeg] };
}

// 自動拆 t / 配對(2026-05 新增,CLAUDE.md §5.7.2):
// 對非配對的 source ad 做權重調整時,若新 weights 觸發同家族母+破圈碰撞,自動拆 pair。
//
// 流程:
//   1. source 整支廣告 ad_code 改名為 stXXXt(所有段 ad_code 跟著改;歷史段 code_at_creation 保留原代碼)
//   2. source 開新段 5/14 起,weights = 破圈側
//   3. 新建一般側 ad(stXXX),5/14 起,weights = 一般側
//   4. 兩支共用新生 split_pair_id
//
// 回傳:
//   {
//     mode: "split",
//     pairId,
//     sourceRename: { from, to },           // source ad 改名前後
//     sourceClosedSeg: <trim 後的舊段>,      // 舊段內存物件已被 trim
//     sourceNewSeg: <破圈側新段 ad 物件>,    // caller push 進 state.ads
//     newGeneralAd: <一般側新 ad 物件>,      // caller push 進 state.ads
//     sourceCodeUpdates: [...]              // source 同一 ad 鏈的所有歷史段需要改 ad_code 的清單
//   }
//
// 注意:caller 拿到 sourceCodeUpdates 後,要對 source 的所有歷史段(用 ad_code 比對)做 ad_code 更新
//      + 設 code_at_creation 為原代碼(如果還沒設)
export function buildWeightAdjustWithAutoSplit(state, source, effectiveDate, newWeights, options) {
  const { notes, allSegsOfSource } = options || {};
  if (effectiveDate <= source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  const products = state.products || [];
  const detect = detectFamilyCollision(newWeights, products);
  const isAlreadyPaired = !!source.split_pair_id;

  // Case A: 已在 pair 內 → 走原本 buildWeightAdjust(後續 caller 仍要呼叫 rebalanceSplitPair)
  if (isAlreadyPaired) {
    const out = buildWeightAdjust(source, effectiveDate, newWeights, notes);
    return { mode: "in_pair", ...out };
  }

  // Case B: 沒在 pair + 沒碰撞 → 走原本 buildWeightAdjust
  if (!detect.collision) {
    const out = buildWeightAdjust(source, effectiveDate, newWeights, notes);
    return { mode: "plain", ...out };
  }

  // Case C: 沒在 pair + 有碰撞 → 觸發拆 t
  const { normal, poquan, normalSum, poquanSum } = splitWeightsByFamily(newWeights, products);
  if (normalSum <= 0 || poquanSum <= 0) {
    // 理論上 detectFamilyCollision === true 必然兩側都有,這是保險
    const out = buildWeightAdjust(source, effectiveDate, newWeights, notes);
    return { mode: "plain", ...out };
  }

  const { parentCode, tVariantCode } = deriveSplitCodes(source.ad_code);
  const pairId = `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const totalSum = normalSum + poquanSum;
  const generalRatio = normalSum / totalSum;
  const poquanRatio = poquanSum / totalSum;
  const baseDaily = Number(source.daily_amort_twd)
    || (Number(source.amount_twd) / Number(source.amortize_days) || 0);

  // 1) source 段 trim end → effectiveDate
  const closed = trimEnd(source, effectiveDate);

  // 2) source 開新段:破圈側,代碼變 stXXXt
  const sourceNewSeg = spawnFrom(source, {
    ad_code: tVariantCode,
    ad_name: source.ad_name,  // 名稱不自動加 t,避免污染(若使用者要 visually 區分可手動)
    start_date: effectiveDate,
    end_date: source.end_date,
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * poquanRatio),
    amount_cny: round2((Number(source.amount_cny) || 0) * poquanRatio),
    amount_twd: (Number(source.amount_twd) || 0) * poquanRatio,
    daily_amort_twd: baseDaily * poquanRatio,
    weights: { ...poquan },
    renewal_reason: "拆t改名",
    notes: notes && String(notes).trim()
      ? `${String(notes).trim()}(同家族碰撞,自動拆 t)`
      : "權重含同家族母+破圈,自動拆 t 配對",
    split_pair_id: pairId,
    split_role: "t_variant",
    code_at_creation: tVariantCode,
  });

  // 3) 新建一般側 ad(stXXX)
  const newGeneralAd = {
    id: uid("ad"),
    ad_code: parentCode,
    ad_name: source.ad_name,
    group: source.group || "",
    currency: source.currency || "CNY",
    amount_orig: round2((Number(source.amount_orig) || Number(source.amount_cny) || 0) * generalRatio),
    currency_rate: source.currency_rate || 1,
    amount_cny: round2((Number(source.amount_cny) || 0) * generalRatio),
    exchange_rate: source.exchange_rate,
    amount_twd: (Number(source.amount_twd) || 0) * generalRatio,
    start_date: effectiveDate,
    end_date: source.end_date,
    amortize_days: source.amortize_days,
    daily_amort_twd: baseDaily * generalRatio,
    purchase_mode: pickPurchaseMode(normal),
    weights: { ...normal },
    lock_perf_adjust: false,
    lock_full: false,
    eliminated: false,
    renewal_of: null,
    renewal_reason: "初始",
    notes: `自動拆 t 配對(由 ${source.ad_code} 觸發,${effectiveDate} 起)`,
    split_pair_id: pairId,
    split_role: "parent",
    code_at_creation: parentCode,
  };

  // 4) 收集 source 同代碼所有歷史段(需要改 ad_code stXXX → stXXXt)
  // caller 提供 allSegsOfSource(同 ad_code + 同 renewal chain 的所有段)
  // 沒提供時退而求其次:只改 source 自身
  const segsToRename = Array.isArray(allSegsOfSource) && allSegsOfSource.length > 0
    ? allSegsOfSource
    : [source];

  return {
    mode: "split",
    pairId,
    sourceRename: { from: source.ad_code, to: tVariantCode },
    closed,             // trim 過的 source 段(同物件)
    sourceNewSeg,       // 破圈側新段(carrying split_pair_id + split_role='t_variant')
    newGeneralAd,       // 一般側新 ad(carrying split_pair_id + split_role='parent')
    segsToRename,       // 需要改 ad_code + 標 split_pair_id/role + 補 code_at_creation 的歷史段清單
  };
}

// 注意:`buildPoquanSplit`(事後拆出破圈/一般分流)已於 2026-05 移除,改由
// `buildWeightAdjustWithAutoSplit` 在「同家族母+破圈權重碰撞」時自動拆 pair。
// 對於舊資料(已有 split_pair_id 的廣告),配對重平衡仍走 `rebalanceSplitPair`。
