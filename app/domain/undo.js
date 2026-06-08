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

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqStrings(values) {
  return [...new Set(asArray(values).map((v) => String(v || "").trim()).filter(Boolean))];
}

function normalizeUndoPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ad_snapshots: [], added_ad_ids: [], applied_ad_snapshots: [] };
  }
  return {
    ad_snapshots: asArray(payload.ad_snapshots),
    added_ad_ids: uniqStrings(payload.added_ad_ids),
    applied_ad_snapshots: asArray(payload.applied_ad_snapshots),
  };
}

function todoYourlsPayloads(todo) {
  if (Array.isArray(todo?.yourls_actions)) return todo.yourls_actions.filter(Boolean);
  if (todo?.yourls_action) return [todo.yourls_action];
  return [];
}

function purchaseModeFor(weights) {
  const keys = Object.keys(weights || {}).filter((key) => Number(weights[key]) > 0);
  return keys.length === 1 && Number(weights[keys[0]]) === 100 ? "independent" : "shared";
}

function weightsFromYourlsPayload(payload) {
  const out = {};
  for (const item of asArray(payload?.weights)) {
    const pid = String(item?.product_id || "").trim();
    const w = Number(item?.weight_pct) || 0;
    if (pid && w > 0) out[pid] = w;
  }
  return out;
}

function inferAppliedAdSnapshotsFromTodo(state, todo, payload) {
  const payloads = todoYourlsPayloads(todo);
  if (payloads.length === 0) return [];

  const beforePayload = normalizeUndoPayload(todo?.undo_payload);
  const beforeById = new Map(beforePayload.ad_snapshots.map((snap) => [String(snap?.id || ""), snap]));
  const addedIds = [...beforePayload.added_ad_ids];
  const usedAddedIds = new Set();
  const inferred = [];

  for (const action of payloads) {
    if (String(action?.kind || "") !== "update_weights") continue;
    const sourceId = String(action?.source_ad_id || "").trim();
    const before = beforeById.get(sourceId) ||
      asArray(state?.ads).find((ad) => String(ad?.id || "") === sourceId);
    if (!before) continue;
    const effective = String(action?.effective_date || before.start_date || "").slice(0, 10);
    const weights = weightsFromYourlsPayload(action);
    if (!effective || Object.keys(weights).length === 0) continue;

    if (effective <= String(before.start_date || "")) {
      inferred.push({
        ...clone(before),
        weights,
        purchase_mode: purchaseModeFor(weights),
      });
      continue;
    }
    if (effective >= String(before.end_date || "")) continue;

    inferred.push({ ...clone(before), end_date: effective });
    const addedId = addedIds.find((id) => !usedAddedIds.has(id));
    if (!addedId) continue;
    usedAddedIds.add(addedId);
    inferred.push({
      ...clone(before),
      id: addedId,
      start_date: effective,
      end_date: before.end_date,
      weights,
      purchase_mode: purchaseModeFor(weights),
      renewal_of: before.id,
      renewal_reason: "權重調整",
      code_at_creation: before.ad_code,
    });
  }
  return inferred;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function descContainsAdCode(desc, code) {
  const text = String(desc || "");
  const raw = String(code || "").trim();
  if (!raw) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(raw)}([^A-Za-z0-9_-]|$)`, "i");
  return re.test(text);
}

function todoMonthDay(todo) {
  const m = String(todo?.description || "").trim().match(/^(\d{1,2})\/(\d{1,2})\s+/);
  if (!m) return "";
  return `${String(m[1]).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
}

function inferAddedAdIdsFromTodo(state, todo) {
  if (String(todo?.action_type || "") !== "新增廣告") return [];
  const ads = asArray(state?.ads);
  const ids = new Set();
  const codeCandidates = new Set();
  const desc = String(todo?.description || "");
  const md = todoMonthDay(todo);

  for (const payload of todoYourlsPayloads(todo)) {
    const sourceId = String(payload?.source_ad_id || "").trim();
    const sourceCode = String(payload?.source_ad_code || "").trim();
    if (sourceId) ids.add(sourceId);
    if (sourceCode) codeCandidates.add(sourceCode);
  }

  for (const ad of ads) {
    if (!ad?.id) continue;
    if (ids.has(String(ad.id))) continue;
    if (String(ad.renewal_reason || "初始") !== "初始") continue;
    if (ad.renewal_of) continue;
    const code = String(ad.ad_code || "");
    if (!code) continue;
    if (codeCandidates.has(code) || descContainsAdCode(desc, code)) ids.add(String(ad.id));
  }

  if (!md) return [...ids];
  const datedIds = ads
    .filter((ad) => ids.has(String(ad?.id)) && String(ad?.start_date || "").slice(5, 10) === md)
    .map((ad) => String(ad.id));
  return datedIds.length > 0 ? datedIds : [...ids];
}

export function undoPayloadForTodo(state, todo) {
  const payload = normalizeUndoPayload(todo?.undo_payload);
  return {
    ad_snapshots: payload.ad_snapshots,
    added_ad_ids: uniqStrings([
      ...payload.added_ad_ids,
      ...inferAddedAdIdsFromTodo(state, todo),
    ]),
    applied_ad_snapshots: payload.applied_ad_snapshots,
  };
}

export function todoHasUndo(state, todo) {
  const payload = undoPayloadForTodo(state, todo);
  return payload.ad_snapshots.length > 0 || payload.added_ad_ids.length > 0;
}

// 撤回:把 state.ads 還原回 ad_snapshots,並刪掉 added_ad_ids
// 在 update() 內呼叫(會直接 mutate state)
// 回傳 { ok, restoredCount, deletedCount }
export function applyUndo(state, payload) {
  if (!payload) return { ok: false, msg: "此待辦沒有可還原的資料變動" };
  const { ad_snapshots = [], added_ad_ids = [] } = normalizeUndoPayload(payload);
  if (ad_snapshots.length === 0 && added_ad_ids.length === 0) {
    return { ok: false, msg: "此待辦沒有可還原的資料變動" };
  }

  // 1. 刪掉新建的廣告
  let deletedCount = 0;
  if (added_ad_ids.length > 0) {
    const idSet = new Set(added_ad_ids);
    const before = state.ads.length;
    state.ads = state.ads.filter((a) => !idSet.has(String(a.id)));
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

export function applyTodoUndo(state, todo) {
  return applyUndo(state, undoPayloadForTodo(state, todo));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedTodosWithAppliedSnapshots(state) {
  return asArray(state?.todos)
    .filter((todo) =>
      asArray(todo?.undo_payload?.applied_ad_snapshots).length > 0 ||
      (asArray(todo?.undo_payload?.ad_snapshots).length > 0 && todoYourlsPayloads(todo).length > 0)
    )
    .slice()
    .sort((a, b) =>
      String(a?.created_at || "").localeCompare(String(b?.created_at || "")) ||
      String(a?.id || "").localeCompare(String(b?.id || ""))
    );
}

function sameWeights(a, b) {
  const ak = Object.keys(a || {}).sort();
  const bk = Object.keys(b || {}).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (key !== bk[i]) return false;
    if (Number(a?.[key] || 0) !== Number(b?.[key] || 0)) return false;
  }
  return true;
}

function adMatchesSnapshot(ad, snap) {
  if (!ad || !snap) return false;
  return String(ad.ad_code || "") === String(snap.ad_code || "") &&
    String(ad.start_date || "") === String(snap.start_date || "") &&
    String(ad.end_date || "") === String(snap.end_date || "") &&
    String(ad.renewal_reason || "") === String(snap.renewal_reason || "") &&
    sameWeights(ad.weights, snap.weights);
}

function isSparseAd(ad) {
  return !String(ad?.ad_code || "").trim() ||
    !String(ad?.start_date || "").trim() ||
    !String(ad?.end_date || "").trim();
}

export function materializeTodoAppliedSnapshots(state, todo) {
  const payload = undoPayloadForTodo(state, todo);
  const applied = asArray(payload.applied_ad_snapshots).length > 0
    ? asArray(payload.applied_ad_snapshots)
    : inferAppliedAdSnapshotsFromTodo(state, todo, payload);
  if (applied.length === 0) return 0;
  if (!Array.isArray(state.ads)) state.ads = [];

  const beforeById = new Map(asArray(payload.ad_snapshots).map((snap) => [String(snap?.id || ""), snap]));
  const addedIds = new Set(uniqStrings(payload.added_ad_ids));
  let changed = 0;

  for (const snap of applied) {
    const id = String(snap?.id || "");
    if (!id) continue;
    const idx = state.ads.findIndex((ad) => String(ad?.id || "") === id);
    if (idx < 0) {
      state.ads.push(clone(snap));
      changed += 1;
      continue;
    }

    const existing = state.ads[idx];
    const before = beforeById.get(id);
    const shouldApply = isSparseAd(existing) ||
      (before && adMatchesSnapshot(existing, before)) ||
      (addedIds.has(id) && isSparseAd(existing));
    if (!shouldApply) continue;
    state.ads[idx] = clone(snap);
    changed += 1;
  }
  return changed;
}

export function materializeTodosAppliedSnapshots(state) {
  let changed = 0;
  for (const todo of sortedTodosWithAppliedSnapshots(state)) {
    changed += materializeTodoAppliedSnapshots(state, todo);
  }
  return changed;
}
