// 個別段操作依真正的配對 ID 與期間連動，不以渠道代碼模糊比對。
export function pairedTargetsForSegment(allAds, seg) {
  if (!seg) return [];
  const targets = [seg];
  if (seg.split_pair_id) {
    for (const ad of (allAds || [])) {
      if (ad.id === seg.id) continue;
      const overlaps = ad.start_date && ad.end_date && seg.start_date && seg.end_date &&
        ad.start_date < seg.end_date && seg.start_date < ad.end_date;
      if (ad.split_pair_id === seg.split_pair_id && overlaps) targets.push(ad);
    }
  }
  const seen = new Set();
  return targets.filter((ad) => {
    const id = String(ad?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
