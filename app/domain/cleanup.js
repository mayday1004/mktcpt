// 未串鏈殘留段自動清理(2026-07,使用者要求:殘留段不要靠使用者手動刪)
//
// 只清「可證明不影響任何計算」的兩類殘留:
//   1. 無權重殘留副本:weights 全空。典型來源:舊版同步一遇 404 就永久暫停,
//      操作推到一半中斷 → Ads 列推上去了、AdWeights 沒推,留下權重遺失的重複副本。
//   2. 被旁路的 0 天權重載體:start == end(權重調整生效日 ≥ 段結束日開出的 forward 段),
//      正常流程續費會「從它開新段並引用它」;若續費改從別段開出(舊 build / 多分頁時序),
//      載體變成沒人引用的死分支 — 花費本來就是 0,任務又已被更晚的段取代,直接清掉。
//
// 共同前提(缺一不可,保守避免誤刪真資料):
//   - 共購段(purchase_mode ≠ 'independent';獨立採買同代碼多份各自成鏈,不動)
//   - 沒被任何段的 renewal_of 引用(絕不破壞續約鏈中段)
//   - 同代碼存在「結束日嚴格更晚」的其他共購段(= 這段已被取代,不是該合約唯一紀錄。
//     昨日 st214 的「最新段本身無權重」就是反例:沒有更晚的段 → 保留、由 UI 警示補權重)
//   - 無權重副本另要求:同代碼存在「有權重」的段 — 證明這個代碼的 AdWeights 資料
//     確實已載入,防止權重分頁還沒拉回來時把整批廣告誤判成無權重殺光
//
// 迴圈跑到 fixpoint:ghost 鏈(尾巴刪掉後,前一段變成未被引用)一次清完。
// 回傳刪除筆數;呼叫端(state.update / sync 拉回後)負責把刪除登記進同步刪除佇列。

function hasAnyWeight(seg) {
  return Object.values(seg?.weights || {}).some((w) => (Number(w) || 0) > 0);
}

export function pruneResidualSegments(st) {
  if (!Array.isArray(st?.ads) || st.ads.length === 0) return 0;
  let removedTotal = 0;
  let changed = true;
  while (changed) {
    changed = false;
    const ads = st.ads;
    const referenced = new Set(ads.map((a) => a.renewal_of).filter(Boolean));
    const byCode = new Map();
    for (const a of ads) {
      if (!byCode.has(a.ad_code)) byCode.set(a.ad_code, []);
      byCode.get(a.ad_code).push(a);
    }
    const keep = [];
    for (const s of ads) {
      let residual = false;
      if ((s.purchase_mode || "shared") !== "independent" &&
          s.start_date && s.end_date && !referenced.has(s.id)) {
        const sibs = (byCode.get(s.ad_code) || []).filter((o) =>
          o !== s && (o.purchase_mode || "shared") !== "independent");
        const superseded = sibs.some((o) => o.end_date && o.end_date > s.end_date);
        if (superseded) {
          const zeroDay = s.start_date === s.end_date;
          const weightlessCopy = !hasAnyWeight(s) && sibs.some(hasAnyWeight);
          residual = zeroDay || weightlessCopy;
        }
      }
      if (residual) { removedTotal += 1; changed = true; }
      else keep.push(s);
    }
    if (changed) st.ads = keep;
  }
  return removedTotal;
}
