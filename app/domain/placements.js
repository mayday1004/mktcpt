// 同一支廣告、同一期合約上的「版位」。
// 每個版位是一段自己的金額與權重（單產品 100%，或多產品共購但加總 100%）。
// 它們日期重疊是因為同時在跑，不是前後續約，也不能當成未串鏈的重複段。
// 版位中途改權重（renewal_reason = 權重調整）才是下一個時間軸節點。

export function positiveWeights(seg) {
  return Object.entries(seg?.weights || {})
    .map(([pid, weight]) => ({ pid, weight: Number(weight) || 0 }))
    .filter((entry) => entry.weight > 0);
}

export function weightSum(seg) {
  return positiveWeights(seg).reduce((sum, entry) => sum + entry.weight, 0);
}

export function productIds(seg) {
  return new Set(positiveWeights(seg).map((entry) => entry.pid));
}

export function rangesOverlap(a, b) {
  return !!(a?.start_date && a?.end_date && b?.start_date && b?.end_date &&
    a.start_date < b.end_date && b.start_date < a.end_date);
}

// 兩段日期重疊，而且至少有一個產品同時有權重 → 同一筆錢會被攤兩次。
export function productsIntersect(a, b) {
  if (!rangesOverlap(a, b)) return false;
  const other = productIds(b);
  for (const pid of productIds(a)) if (other.has(pid)) return true;
  return false;
}

function isAdjust(seg) {
  return seg?.renewal_reason === "權重調整";
}

function productKey(seg) {
  return [...productIds(seg)].sort().join("\0");
}

function emptyPlacement() {
  return {
    parallel: false,
    positions: [],
    adjusts: [],
    coveredIds: [],
    duplicateIds: [],
    contractStart: "",
    contractEnd: "",
  };
}

// 以參考段所屬的合約起始日，找出同期的全部版位，以及從這些版位開出的權重調整。
export function describePlacements(segs, referenceSeg) {
  const list = segs || [];
  const byId = new Map(list.map((seg) => [seg.id, seg]));
  let anchor = referenceSeg;
  const seen = new Set();
  while (anchor && isAdjust(anchor) && anchor.renewal_of && !seen.has(anchor.id)) {
    seen.add(anchor.id);
    const parent = byId.get(anchor.renewal_of);
    if (!parent) break;
    anchor = parent;
  }
  if (!anchor?.start_date) return emptyPlacement();

  const sameStart = list.filter((seg) => seg.start_date === anchor.start_date && !isAdjust(seg));
  const kept = [];
  const duplicateIds = [];
  for (const seg of sameStart) {
    const key = productKey(seg);
    const prior = kept.find((item) => productKey(item) === key && rangesOverlap(item, seg));
    const shared = (seg.purchase_mode || "shared") !== "independent";
    if (prior && shared) duplicateIds.push(seg.id);
    else kept.push(seg);
  }

  const positionIds = new Set(kept.map((seg) => seg.id));
  const adjusts = [];
  const adjustIds = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const seg of list) {
      if (!isAdjust(seg) || !seg.renewal_of || adjustIds.has(seg.id)) continue;
      if (positionIds.has(seg.renewal_of) || adjustIds.has(seg.renewal_of)) {
        adjustIds.add(seg.id);
        adjusts.push(seg);
        grew = true;
      }
    }
  }
  adjusts.sort((a, b) =>
    (a.start_date || "").localeCompare(b.start_date || "") ||
    (a.end_date || "").localeCompare(b.end_date || "")
  );

  const contractStart = anchor.start_date;
  const ends = [...kept, ...adjusts].map((seg) => seg.end_date).filter(Boolean).sort();
  const contractEnd = ends[ends.length - 1] || anchor.end_date || "";
  return {
    parallel: kept.length >= 2,
    positions: kept.map((seg) => ({
      seg,
      until: seg.end_date && contractEnd && seg.end_date < contractEnd ? seg.end_date : "",
    })),
    adjusts: adjusts.map((seg) => ({ seg, parent: byId.get(seg.renewal_of) || null })),
    coveredIds: [...positionIds, ...adjustIds],
    duplicateIds,
    contractStart,
    contractEnd,
  };
}

export function placementLines(seg) {
  const usdt = seg?.currency === "USDT";
  const orig = Number(seg?.amount_orig) || 0;
  const rmb = Number(seg?.amount_cny) || 0;
  const daily = Number(seg?.daily_amort_twd) || 0;
  return positiveWeights(seg).map(({ pid, weight }) => {
    const ratio = weight / 100;
    return {
      pid,
      weight,
      usdt: usdt ? Math.round(orig * ratio) : null,
      rmb: Math.round(rmb * ratio),
      daily: Math.round(daily * ratio),
    };
  });
}

export function sumLines(lines) {
  return {
    usdt: lines.reduce((sum, line) => sum + (line.usdt || 0), 0),
    rmb: lines.reduce((sum, line) => sum + line.rmb, 0),
    daily: lines.reduce((sum, line) => sum + line.daily, 0),
  };
}

export function daysBetween(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86400000));
}

export function placementsAllFull(positions) {
  return positions.length > 0 && positions.every((item) => Math.abs(weightSum(item.seg ?? item) - 100) <= 0.5);
}

export function cohortWeightMap(segments) {
  const map = new Map();
  for (const seg of segments || []) {
    for (const { pid, weight } of positiveWeights(seg)) map.set(pid, weight);
  }
  return map;
}

// 合約開始日之前、結束日最晚的那一期版位（結束日貼著新合約開始日也算上一期）。
export function previousPlacementCohort(segs, contractStart) {
  const earlier = (segs || []).filter((seg) =>
    seg.start_date && seg.end_date && seg.end_date <= contractStart && !isAdjust(seg)
  );
  if (earlier.length === 0) return [];
  const maxEnd = earlier.map((seg) => seg.end_date).sort().at(-1);
  const start = earlier
    .filter((seg) => seg.end_date === maxEnd)
    .map((seg) => seg.start_date)
    .sort()
    .at(-1);
  return earlier.filter((seg) => seg.start_date === start);
}
