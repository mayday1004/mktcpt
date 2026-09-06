import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../app/schema.js";
import { getState, replaceState, update, applySync, undo } from "../app/state.js";
import { materializeTodosAppliedSnapshots } from "../app/domain/undo.js";
import { TABLE_SYNC_SPECS } from "../app/io/sync-specs.js";
import { clearSyncDeleted, getPendingSyncDeletedIds } from "../app/io/sync-deletions.js";

const adsSpec = TABLE_SYNC_SPECS.find((s) => s.sheetName === "廣告");
const weightsSpec = TABLE_SYNC_SPECS.find((s) => s.sheetName === "廣告權重");
const todosSpec = TABLE_SYNC_SPECS.find((s) => s.sheetName === "待辦");
function fixture(prefix) {
  const state = defaultState();
  state.ads = ["dhst304", "dhst304", "st304"].map((code, i) => ({
    id: `${prefix}-${i}`, ad_code: code, ad_name: code,
    start_date: `2026-0${i + 6}-01`, end_date: `2026-0${i + 7}-01`,
    amount_cny: 100, amount_twd: 470, exchange_rate: 4.7, amortize_days: 30,
    weights: { AV9: 100 }, purchase_mode: "independent", renewal_reason: "初始",
  }));
  state.todos = [{ id: `${prefix}-todo`, action_type: "新增廣告", status: "done",
    created_at: "2026-06-01 12:00:00", description: "新增 dhst304",
    undo_payload: { ad_snapshots: [], added_ad_ids: state.ads.map((a) => a.id),
      applied_ad_snapshots: structuredClone(state.ads) },
  }];
  return state;
}

test("個別刪除後待辦不復活廣告，其他段與 st304 保留", () => {
  replaceState(fixture("single"));
  const kept = structuredClone(getState().ads.slice(1));
  update((s) => { s.ads = s.ads.filter((a) => a.id !== "single-0"); });
  assert.deepEqual(getState().ads, kept);
  assert.ok(getPendingSyncDeletedIds("廣告").includes("single-0"));
  assert.ok(getPendingSyncDeletedIds("廣告權重").includes("single-0::AV9"));
  clearSyncDeleted("廣告", ["single-0"]);
  applySync(() => {});
  assert.deepEqual(getState().ads, kept);
});

test("整筆刪除 dhst304 後重複同步待辦仍保留完整 st304", () => {
  replaceState(fixture("whole"));
  const kept = structuredClone(getState().ads.filter((a) => a.ad_code === "st304"));
  const todoRow = todosSpec.flatten(getState())[0];
  update((s) => { s.ads = s.ads.filter((a) => a.ad_code !== "dhst304"); });
  applySync((s) => todosSpec.upsertInState(s, todoRow._id,
    Object.fromEntries(todosSpec.dataHeaders.map((h, i) => [h, todoRow.dataRow[i]]))));
  update(() => {});
  assert.deepEqual(getState().ads, kept);
});

test("重新載入的伺服器刪除標記阻擋舊權重及待辦快照", () => {
  const source = fixture("reload");
  const state = defaultState();
  adsSpec.removeFromState(state, "reload-0");
  weightsSpec.upsertInState(state, "reload-0::AV9", { "權重%": 100 });
  state.todos = source.todos;
  materializeTodosAppliedSnapshots(state);
  assert.deepEqual(state.ads.map((a) => a.id), ["reload-1", "reload-2"]);
  // 伺服器明確還原完整廣告後，正常接受權重。
  const row = adsSpec.flatten(source)[0];
  adsSpec.upsertInState(state, row._id,
    Object.fromEntries(adsSpec.dataHeaders.map((h, i) => [h, row.dataRow[i]])));
  weightsSpec.upsertInState(state, "reload-0::AV9", { "權重%": 100 });
  assert.equal(state.ads.find((a) => a.id === "reload-0").weights.AV9, 100);
});

test("沒有刪除標記時仍可修復同步缺漏的廣告", () => {
  const state = fixture("repair");
  state.ads = [];
  assert.equal(materializeTodosAppliedSnapshots(state), 3);
});

test("明確復原可還原剛刪除的段", async () => {
  replaceState(fixture("undo"));
  await new Promise((resolve) => setTimeout(resolve, 210));
  update((s) => { s.ads = s.ads.filter((a) => a.id !== "undo-0"); });
  assert.ok(!getState().ads.some((a) => a.id === "undo-0"));
  undo();
  assert.ok(getState().ads.some((a) => a.id === "undo-0"));
});
