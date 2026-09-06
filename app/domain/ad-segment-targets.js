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

// 舊資料可能讓 dhst304 / st304 四側共用同一配對 ID。
// 刪除此段只連動原代碼的另一側，保留渠道前綴，不擴大成整個家族。
export function deleteTargetsForSegment(allAds, seg) {
  const code = String(seg?.ad_code || "").trim().toLowerCase();
  const counterpart = code.endsWith("t") ? code.slice(0, -1) : `${code}t`;
  return pairedTargetsForSegment(allAds, seg).filter((ad) =>
    ad.id === seg.id || (code && String(ad.ad_code || "").trim().toLowerCase() === counterpart)
  );
}
