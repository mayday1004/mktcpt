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
    ad_copy: source.ad_copy || "",
    contact_tg: source.contact_tg || "",
    contact_info: source.contact_info || "",
    short_url_type: source.short_url_type || "",
    short_url_param: source.short_url_param || "",
    short_url_old_override: source.short_url_old_override || "",
    short_url_new_override: source.short_url_new_override || "",
    short_url_old_prefix: source.short_url_old_prefix || "",
    short_url_notified: !!source.short_url_notified,
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
  if (effectiveDate < source.start_date || effectiveDate >= source.end_date) {
    throw new Error(`生效日 ${effectiveDate} 必須落在原段區間 (${source.start_date} ~ ${source.end_date}) 之間`);
  }
  // 邊界 case:生效日 = 段第一天 → 直接覆寫 source 的 weights、不切段
  // (避免產生長度 0 的空段,並讓「續費當天改權重」這種常見情境自然處理)
  // renewal_reason 保留原值(例:剛續費那段仍標「續費」),todo 仍會記錄權重變化
  if (effectiveDate === source.start_date) {
    const updated = {
      ...source,
      weights: { ...newWeights },
      purchase_mode: pickPurchaseMode(newWeights),
    };
    if (notes != null && String(notes).trim()) {
      const trimmed = String(notes).trim();
      updated.notes = (source.notes || "").trim()
        ? `${source.notes}\n${trimmed}`
        : trimmed;
    }
    return { closed: updated, segments: [] };
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
//   1. 依 source 原代碼決定語意側:stXXX 留 parent,stXXXt 留 t-variant
//   2. 生效日前若舊 weights 已混合,補出另一側歷史段,讓歷史也符合 canonical
//   3. 生效日起建立 parent / t-variant 的新段(或 same-start 原地覆寫 source 側)
//   4. 兩支共用新生 split_pair_id
//
// 回傳:
//   {
//     mode: "split",
//     pairId,
//     sourceRename: { from, to, parentCode, tVariantCode },
//     sourceReplacement: <source id 覆寫後段>,
//     addedSegments: <補出的另一側歷史段 + 生效日後新增段>,
//     snapshotIds: <撤回前需 snapshot 的原段 ids>
//   }
export function buildWeightAdjustWithAutoSplit(state, source, effectiveDate, newWeights, options) {
  const { notes, allSegsOfSource } = options || {};
  if (effectiveDate < source.start_date || effectiveDate >= source.end_date) {
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
  // 若生效日等於段起始日,source 留在原語意側並補另一側,不產生空段。
  const afterSides = splitWeightsByFamily(newWeights, products);
  const { normalSum, poquanSum } = afterSides;
  if (normalSum <= 0 || poquanSum <= 0) {
    // 理論上 detectFamilyCollision === true 必然兩側都有,這是保險
    const out = buildWeightAdjust(source, effectiveDate, newWeights, notes);
    return { mode: "plain", ...out };
  }

  const { parentCode, tVariantCode } = deriveSplitCodes(source.ad_code);
  const pairId = `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const sameStart = effectiveDate === source.start_date;
  const beforeSides = splitWeightsByFamily(source.weights || {}, products);
  const sourceRole = /[tT]$/.test(String(source.ad_code || "")) ? "t_variant" : "parent";
  const otherRole = sourceRole === "parent" ? "t_variant" : "parent";
  const codeForRole = (role) => role === "parent" ? parentCode : tVariantCode;
  const sideOf = (sides, role) => role === "parent"
    ? { raw: sides.normal, sum: sides.normalSum, internal: sides.normalInternal }
    : { raw: sides.poquan, sum: sides.poquanSum, internal: sides.poquanInternal };
  const baseOrig = Number(source.amount_orig) || Number(source.amount_cny) || 0;
  const baseCny = Number(source.amount_cny) || 0;
  const baseTwd = Number(source.amount_twd) || 0;
  const baseDaily = Number(source.daily_amort_twd)
    || (Number(source.amount_twd) / Number(source.amortize_days) || 0);
  const splitNote = notes && String(notes).trim()
    ? `${String(notes).trim()}(同家族碰撞,自動拆 t)`
    : "權重含同家族母+破圈,自動拆 t 配對";

  const makeSidePatch = (sides, role, startDate, endDate, renewalOf, renewalReason, opts = {}) => {
    const side = sideOf(sides, role);
    const total = (Number(sides.normalSum) || 0) + (Number(sides.poquanSum) || 0);
    const ratio = total > 0 ? side.sum / total : 0;
    return {
      ad_code: codeForRole(role),
      ad_name: source.ad_name,
      group: source.group || "",
      currency: source.currency || "CNY",
      amount_orig: round2(baseOrig * ratio),
      currency_rate: source.currency_rate || 1,
      amount_cny: round2(baseCny * ratio),
      exchange_rate: source.exchange_rate,
      amount_twd: baseTwd * ratio,
      start_date: startDate,
      end_date: endDate,
      amortize_days: source.amortize_days,
      daily_amort_twd: baseDaily * ratio,
      purchase_mode: pickPurchaseMode(side.internal),
      weights: { ...side.internal },
      lock_perf_adjust: opts.preserveSourceFlags ? !!source.lock_perf_adjust : false,
      lock_full: opts.preserveSourceFlags ? !!source.lock_full : false,
      ad_copy: source.ad_copy || "",
      contact_tg: source.contact_tg || "",
      contact_info: source.contact_info || "",
      short_url_type: source.short_url_type || "",
      short_url_param: source.short_url_param || "",
      short_url_old_override: source.short_url_old_override || "",
      short_url_new_override: source.short_url_new_override || "",
      short_url_old_prefix: source.short_url_old_prefix || "",
      short_url_notified: !!source.short_url_notified,
      eliminated: opts.preserveSourceFlags ? !!source.eliminated : false,
      renewal_of: renewalOf || null,
      renewal_reason: renewalReason,
      notes: opts.notes || splitNote,
      split_pair_id: pairId,
      split_role: role,
      code_at_creation: codeForRole(role),
    };
  };

  const addedSegments = [];
  const sourceSideAfter = sideOf(afterSides, sourceRole);
  const otherSideAfter = sideOf(afterSides, otherRole);
  const otherSideBefore = sideOf(beforeSides, otherRole);
  const originalEnd = source.end_date;

  let sourceReplacement;
  let sourcePostSeg = null;
  let otherPreSeg = null;

  if (sameStart) {
    sourceReplacement = {
      ...source,
      ...makeSidePatch(afterSides, sourceRole, effectiveDate, originalEnd, source.renewal_of || null, source.renewal_reason || "權重調整", { preserveSourceFlags: true }),
    };
  } else {
    sourceReplacement = {
      ...source,
      ...makeSidePatch(beforeSides, sourceRole, source.start_date, effectiveDate, source.renewal_of || null, source.renewal_reason || "初始", {
        preserveSourceFlags: true,
        notes: source.notes || "",
      }),
    };
    sourcePostSeg = {
      id: uid("ad"),
      ...makeSidePatch(afterSides, sourceRole, effectiveDate, originalEnd, source.id, "權重調整", { preserveSourceFlags: true }),
    };
    if (sourceSideAfter.sum > 0) addedSegments.push(sourcePostSeg);
  }

  if (!sameStart && otherSideBefore.sum > 0) {
    otherPreSeg = {
      id: uid("ad"),
      ...makeSidePatch(beforeSides, otherRole, source.start_date, effectiveDate, null, source.renewal_reason || "初始", {
        notes: `自動拆 t 配對(由 ${source.ad_code} 歷史段補正,${source.start_date} 起)`,
      }),
    };
    addedSegments.push(otherPreSeg);
  }

  if (otherSideAfter.sum > 0) {
    const otherRenewalOf = otherPreSeg?.id || null;
    addedSegments.push({
      id: uid("ad"),
      ...makeSidePatch(afterSides, otherRole, effectiveDate, originalEnd, otherRenewalOf, otherRenewalOf ? "權重調整" : "拆t改名", {
        notes: `自動拆 t 配對(由 ${source.ad_code} 觸發,${effectiveDate} 起)`,
      }),
    });
  }

  return {
    mode: "split",
    pairId,
    sourceRename: { from: source.ad_code, to: codeForRole(sourceRole), parentCode, tVariantCode },
    sourceReplacement,  // source id 保留在原語意側:stXXX=parent,stXXXt=t-variant
    addedSegments,      // 補出的另一側歷史段 + 生效日後雙側段
    sourceRole,
    otherRole,
    snapshotIds: [source.id],
  };
}

// 注意:`buildPoquanSplit`(事後拆出破圈/一般分流)已於 2026-05 移除,改由
// `buildWeightAdjustWithAutoSplit` 在「同家族母+破圈權重碰撞」時自動拆 pair。
// 對於舊資料(已有 split_pair_id 的廣告),配對重平衡仍走 `rebalanceSplitPair`。
