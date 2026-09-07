import test from "node:test";
import assert from "node:assert/strict";
import { defaultState } from "../app/schema.js";
import { replaceState, getState } from "../app/state.js";
import { TABLE_SYNC_SPECS } from "../app/io/sync-specs.js";
import { syncOnce } from "../app/io/sync.js";

test("冷啟動完整同步：實體刪列後重建，不把舊快照推回廣告主表", async (t) => {
  const oldAds = ["dhst304", "dhst304t", "st304", "st304t"].map((code, i) => ({
    id: `old-${i}`, ad_code: code, ad_name: "平行世界", amount_cny: 7500,
    amount_twd: 36750, exchange_rate: 4.9, amortize_days: 7,
    start_date: "2026-09-01", end_date: "2026-09-08",
    purchase_mode: "independent", weights: { AV9: 100 }, renewal_reason: "初始",
  }));
  const server = defaultState();
  server.ads = [{ ...oldAds[2], id: "new-st304" }];
  server.todos = [{ id: "old-todo", action_type: "新增廣告", status: "done",
    created_at: "2026-09-01 12:00:00", description: "新增平行世界",
    undo_payload: { ad_snapshots: [], added_ad_ids: oldAds.map((a) => a.id), applied_ad_snapshots: oldAds },
  }];
  const tables = Object.fromEntries(TABLE_SYNC_SPECS.map((spec) => {
    const rows = spec.flatten(server);
    // 保留舊權重，模擬廣告刪除成功、子表尚有殘留的情況。
    if (spec.sheetName === "廣告權重") rows.push(...spec.flatten({ ads: oldAds }));
    return [spec.sheetName, { headers: [...spec.dataHeaders, "_id", "_updated_at", "_deleted", "_version"],
      rows: rows.map((r) => [...r.dataRow, r._id, "2026-09-07 10:00:00", "", 1]) }];
  }));
  const client = defaultState();
  client.settings.sheets_webapp_url = "https://script.google.com/macros/s/test-deletion-sync/exec";
  client.settings.sheets_token = "test-only";
  // 不讓設定表覆蓋測試連線設定。
  tables["設定"] = { headers: [], rows: [] };
  replaceState(client);
  const writes = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const req = JSON.parse(options.body.get("payload"));
    if (req.action === "readMeta") return new Response(JSON.stringify({ server_version: 1 }));
    if (req.action === "readAllTables") return new Response(JSON.stringify({ sheets: tables, server_version: 1 }));
    assert.ok(["upsertRows", "deleteRows"].includes(req.action));
    writes.push(req);
    return new Response(JSON.stringify({ applied: [], conflicts: [], server_version: 1 }));
  });
  await syncOnce(null, { serverWins: true });
  assert.deepEqual(getState().ads.map((a) => a.id), ["new-st304"]);
  await syncOnce();
  assert.deepEqual(getState().ads.map((a) => a.id), ["new-st304"]);
  for (const req of writes.filter((r) => r.action === "upsertRows" && r.sheetName === "廣告")) {
    assert.ok(req.rows.every((row) => !String(row[req.headers.indexOf("_id")]).startsWith("old-")));
  }
});
