// 同一支廣告、同一期合約上的「版位」。
// 用來判斷未串鏈：日期重疊但產品不重疊的是同期版位，不是重複段。
// 同一產品又日期重疊的共購段才是會把錢算兩次的未串鏈。
// 版位中途的權重調整仍掛在原版位後面，時間軸沿用原本的節點。

export function positiveWeights(seg) {
  return Object.entries(seg?.weights || {})
    .map(([pid, weight]) => ({ pid, weight: Number(weight) || 0 }))
    .filter((entry) => entry.weight > 0);
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

