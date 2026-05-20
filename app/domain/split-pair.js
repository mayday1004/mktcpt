// 破圈分流配對(split pair)重新平衡邏輯
//
// 規格(回應使用者問題:「5/10-5/22 st287t 的權重回歸沒反應在 st287 #4 段」):
//   - 「拆出破圈分流」建立的兩支廣告(parent st287 + t-variant st287t)以 split_pair_id 綁定
//   - 當任一支被建立 `權重調整` 新段時,系統依當下兩支的 weights × amount 重算「每產品分配」,
//     再回填 canonical form:parent 只承載一般產品金額、t-variant 只承載破圈產品金額
//   - 舉例:若 t-variant 的權重從 {愛威奶破圈 100%} 改成 {愛威奶 100%}, 1,800 RMB 會回流到 parent,
//     parent 變 30,000、t-variant 變 0(該段自動結束)
//
// 觸發點:ads.js / perf-adjust.js / gift-day-fix-modal.js 三個地方 buildWeightAdjust 之後呼叫
//
// 副作用:會修改 state.ads(trim linked active 段、push linked 新段、可能 mutate sourceNewSeg 的金額/權重)

import { uid } from "../state.js";

function isPoquanProduct(state, pid) {
  return state?.products?.find((p) => p.id === pid)?.is_poquan === true;
}

// 找到 sourceAd 同 pair 中另一支廣告的所有段
function getPairedAdSegments(state, sourceAd) {
  if (!sourceAd?.split_pair_id) return [];
  return (state.ads || []).filter((a) =>
    a.split_pair_id === sourceAd.split_pair_id && a.ad_code !== sourceAd.ad_code
  );
}

// 找在 effective 日當天 active 的段(start_date <= effective < end_date)
function findActiveSegment(segments, effective) {
  const candidates = segments.filter((a) =>
    a.start_date && a.end_date && a.start_date <= effective && a.end_date > effective
  );
  if (candidates.length === 0) return null;
  // 取 start_date 最晚那一段(最新的)
  return candidates.sort((a, b) => (b.start_date || "").localeCompare(a.start_date || ""))[0];
}

// 把 per-product allocation 物件 normalize 成整數 % 權重(和 = 100)
// 採用 largest-remainder 法,避免四捨五入累積誤差
function normalizeAllocation(alloc) {
  const total = Object.values(alloc).reduce((s, v) => s + v, 0);
  if (total <= 0) return {};
  const entries = Object.entries(alloc)
    .filter(([, v]) => v > 0)
    .map(([pid, v]) => ({ pid, pct: v / total * 100 }));
  if (entries.length === 0) return {};
  entries.forEach((e) => { e.floor = Math.floor(e.pct); e.rem = e.pct - e.floor; });
  let assigned = entries.reduce((s, e) => s + e.floor, 0);
  let deficit = 100 - assigned;
  entries.sort((a, b) => b.rem - a.rem);
  for (let i = 0; i < entries.length && deficit > 0; i++) {
    entries[i].floor += 1;
    deficit--;
  }
  const result = {};
  for (const e of entries) {
    if (e.floor > 0) result[e.pid] = e.floor;
  }
  return result;
}

// 比較兩個 weights map 是否完全相同
function weightsEqual(a, b) {
  const ka = Object.keys(a || {}).filter((k) => Number(a[k]) > 0);
  const kb = Object.keys(b || {}).filter((k) => Number(b[k]) > 0);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (Number(a[k]) !== Number(b[k])) return false;
  }
  return true;
}

// 對 split pair 做重新平衡。在 update() callback 內呼叫,直接 mutate `state`:
//   1. 修改 sourceNewSeg 的 amount_cny / amount_twd / daily_amort_twd / weights
//   2. 把 linked 對應 active 段 trim end_date 至 effective、push 一個新段(canonical form)
//
// 若 sourceNewSeg 沒 split_pair_id 或找不到 linked active 段 → 不動作。
// 若重算後跟 linked active 段現值相同 → 也不動作(避免每次 `權重調整` 都連帶開無實質變化的新段)。
export function rebalanceSplitPair(state, sourceNewSeg) {
  if (!sourceNewSeg?.split_pair_id) return null;
  const role = sourceNewSeg.split_role;
  if (role !== "parent" && role !== "t_variant") return null;

  const pairedSegs = getPairedAdSegments(state, sourceNewSeg);
  if (pairedSegs.length === 0) return null;

  const effective = sourceNewSeg.start_date;
  const linkedActive = findActiveSegment(pairedSegs, effective);
  if (!linkedActive) return null;

  // 算 per-product 分配:sourceNewSeg(新權重 + 舊金額) + linkedActive(現權重 + 現金額)
  const alloc = {};
  for (const [pid, w] of Object.entries(sourceNewSeg.weights || {})) {
    alloc[pid] = (alloc[pid] || 0) + (Number(sourceNewSeg.amount_cny) || 0) * Number(w) / 100;
  }
  for (const [pid, w] of Object.entries(linkedActive.weights || {})) {
    alloc[pid] = (alloc[pid] || 0) + (Number(linkedActive.amount_cny) || 0) * Number(w) / 100;
  }

  // 分成 general / poquan 兩堆
  const generalAlloc = {};
  const poquanAlloc = {};
  for (const [pid, v] of Object.entries(alloc)) {
    if (isPoquanProduct(state, pid)) poquanAlloc[pid] = v;
    else generalAlloc[pid] = v;
  }
  const generalTotal = Object.values(generalAlloc).reduce((s, v) => s + v, 0);
  const poquanTotal = Object.values(poquanAlloc).reduce((s, v) => s + v, 0);

  const newParentAmount = Math.round(generalTotal * 100) / 100;
  const newTAmount = Math.round(poquanTotal * 100) / 100;
  const newParentWeights = normalizeAllocation(generalAlloc);
  const newTWeights = normalizeAllocation(poquanAlloc);

  // 1) 修改 sourceNewSeg(已經 push 進 state.ads)
  const sourceTargetAmount = role === "parent" ? newParentAmount : newTAmount;
  const sourceTargetWeights = role === "parent" ? newParentWeights : newTWeights;
  sourceNewSeg.amount_cny = sourceTargetAmount;
  sourceNewSeg.amount_twd = sourceTargetAmount * (Number(sourceNewSeg.exchange_rate) || 0);
  sourceNewSeg.daily_amort_twd = (Number(sourceNewSeg.amortize_days) > 0)
    ? sourceNewSeg.amount_twd / sourceNewSeg.amortize_days : 0;
  sourceNewSeg.weights = sourceTargetWeights;

  // 2) 對 linked 做 trim + 新段(若重算後跟 linked active 現值完全相同,就跳過,避免噪音段)
  const linkedTargetAmount = role === "parent" ? newTAmount : newParentAmount;
  const linkedTargetWeights = role === "parent" ? newTWeights : newParentWeights;

  const linkedAmountChanged = Math.abs(linkedTargetAmount - (Number(linkedActive.amount_cny) || 0)) > 0.005;
  const linkedWeightsChanged = !weightsEqual(linkedTargetWeights, linkedActive.weights || {});
  if (!linkedAmountChanged && !linkedWeightsChanged) return null;

  // trim linked active end_date
  const originalEnd = linkedActive.end_date;
  linkedActive.end_date = effective;

  // spawn linked 新段
  const newLinkedSeg = {
    id: uid("ad"),
    ad_code: linkedActive.ad_code,
    ad_name: linkedActive.ad_name,
    group: linkedActive.group || "",
    currency: linkedActive.currency || "CNY",
    amount_orig: linkedActive.amount_orig != null ? linkedActive.amount_orig : linkedTargetAmount,
    currency_rate: linkedActive.currency_rate || 1,
    amount_cny: linkedTargetAmount,
    exchange_rate: linkedActive.exchange_rate,
    amount_twd: linkedTargetAmount * (Number(linkedActive.exchange_rate) || 0),
    start_date: effective,
    end_date: originalEnd,
    amortize_days: linkedActive.amortize_days,
    daily_amort_twd: (Number(linkedActive.amortize_days) > 0)
      ? (linkedTargetAmount * (Number(linkedActive.exchange_rate) || 0)) / linkedActive.amortize_days : 0,
    purchase_mode: Object.keys(linkedTargetWeights).length === 1 && Object.values(linkedTargetWeights)[0] === 100
      ? "independent" : "shared",
    weights: linkedTargetWeights,
    lock_perf_adjust: !!linkedActive.lock_perf_adjust,
    lock_full: !!linkedActive.lock_full,
    ad_copy: linkedActive.ad_copy || "",
    contact_tg: linkedActive.contact_tg || "",
    contact_info: linkedActive.contact_info || "",
    short_url_type: linkedActive.short_url_type || "",
    short_url_param: linkedActive.short_url_param || "",
    short_url_old_override: linkedActive.short_url_old_override || "",
    short_url_new_override: linkedActive.short_url_new_override || "",
    short_url_old_prefix: linkedActive.short_url_old_prefix || "",
    short_url_notified: !!linkedActive.short_url_notified,
    eliminated: !!linkedActive.eliminated,
    split_pair_id: linkedActive.split_pair_id,
    split_role: linkedActive.split_role,
    renewal_of: linkedActive.id,
    renewal_reason: "權重調整",
    notes: `配對廣告 ${sourceNewSeg.ad_code} 權重變動,自動同步重平衡`,
  };

  state.ads.push(newLinkedSeg);
  return {
    linkedTrimmedId: linkedActive.id,
    newLinkedSegId: newLinkedSeg.id,
  };
}
