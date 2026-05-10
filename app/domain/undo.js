// 待辦撤回機制(CLAUDE.md §5.5)
//
// 每一筆會異動廣告資料的 todo,寫入時都帶一個 undo_payload,記錄:
//   ad_snapshots:   套用變動之前,被改到的廣告完整快照(deep clone)
//   added_ad_ids:   套用變動時「新建立」的 ad.id 列表(撤回時要刪)
//   eliminated_codes: 套用變動時被「淘汰」的 ad_code 列表(撤回時要把該代碼所有段的 eliminated 還原)
//                    因為淘汰是 mutate 全 ad_code 多段,使用 ad_snapshots 已涵蓋所以這欄目前不必要,留作擴展
//
// 撤回流程:
//   1. 用 added_ad_ids 把新建的廣告從 state.ads 刪掉
//   2. 用 ad_snapshots 把每個原始廣告完整覆寫回去
//   3. 刪掉這筆 todo(在呼叫端做)
//
// 限制:
//   - 只能還原 state.ads 範圍內的異動。budget_changes / settings 等其他資料不在範圍。
//   - 若使用者在這筆 todo 之後又對同一支廣告做了別的調整,撤回會把那些後續調整也回滾(等同「強制 reset 到當時的快照」)。

// 在 update() 內呼叫,在開始異動之前先 snapshot
//   adIds: string[] — 將要被改的 ad id 列表
export function captureUndoSnapshot(state, adIds) {
  const snapshots = [];
  const seen = new Set();
  for (const id of adIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ad = state.ads.find((a) => a.id === id);
    if (ad) snapshots.push(JSON.parse(JSON.stringify(ad)));
  }
  return snapshots;
}

// 撤回:把 state.ads 還原回 ad_snapshots,並刪掉 added_ad_ids
// 在 update() 內呼叫(會直接 mutate state)
// 回傳 { ok, restoredCount, deletedCount }
export function applyUndo(state, payload) {
  if (!payload) return { ok: false, msg: "此待辦沒有可還原的資料變動" };
  const { ad_snapshots = [], added_ad_ids = [] } = payload;
  if (ad_snapshots.length === 0 && added_ad_ids.length === 0) {
    return { ok: false, msg: "此待辦沒有可還原的資料變動" };
  }

  // 1. 刪掉新建的廣告
  let deletedCount = 0;
  if (added_ad_ids.length > 0) {
    const idSet = new Set(added_ad_ids);
    const before = state.ads.length;
    state.ads = state.ads.filter((a) => !idSet.has(a.id));
    deletedCount = before - state.ads.length;
  }

  // 2. 用快照覆寫回原本的廣告
  let restoredCount = 0;
  for (const snap of ad_snapshots) {
    const i = state.ads.findIndex((a) => a.id === snap.id);
    if (i >= 0) {
      state.ads[i] = JSON.parse(JSON.stringify(snap));
    } else {
      // 原廣告不在了(可能被人刪除) → push 回去
      state.ads.push(JSON.parse(JSON.stringify(snap)));
    }
    restoredCount++;
  }

  return { ok: true, restoredCount, deletedCount };
}
