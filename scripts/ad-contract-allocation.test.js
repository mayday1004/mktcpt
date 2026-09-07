import test from "node:test";
import assert from "node:assert/strict";
import { splitWeightsByFamily } from "../app/domain/auto-split.js";
import { buildWeightAdjustWithAutoSplit } from "../app/domain/lifecycle.js";
import { dailySpendForAd } from "../app/domain/spending.js";
import { TABLE_SYNC_SPECS } from "../app/io/sync-specs.js";
import { rebalanceSplitPair } from "../app/domain/split-pair.js";

const products = [{ id: "AV9" }, { id: "HYC" },
  { id: "av9_poquan", is_poquan: true, parent_product_id: "AV9" }];
const initial = { AV9: 20, av9_poquan: 40, HYC: 40 };
const source = { id: "contract", ad_code: "st304", ad_name: "平行世界", weights: initial,
  amount_cny: 40000, amount_orig: 40000, amount_twd: 196000, exchange_rate: 4.9,
  amortize_days: 30, daily_amort_twd: 196000 / 30, start_date: "2026-09-01", end_date: "2026-10-01",
  renewal_reason: "初始", currency: "CNY", purchase_mode: "shared" };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test("新增拆分保留 8000/16000/16000；重平衡不把 1:2 取整", () => {
  const parts = splitWeightsByFamily(initial, products);
  near(24000 * parts.normalInternal.AV9 / 100, 8000);
  near(24000 * parts.normalInternal.HYC / 100, 16000);
  const result = buildWeightAdjustWithAutoSplit({ products }, source, "2026-09-01", initial);
  const state = { products, ads: [result.sourceReplacement, ...result.addedSegments] };
  const parent = state.ads.find((a) => a.split_role === "parent");
  rebalanceSplitPair(state, parent);
  near(parent.amount_cny * parent.weights.AV9 / 100, 8000);
  near(parent.amount_cny * parent.weights.HYC / 100, 16000);
});

test("40000 合約 9/2 調權、同步三次後仍保留各期分配和每日花費", () => {
  const result = buildWeightAdjustWithAutoSplit({ products }, source, "2026-09-02", { AV9: 50, av9_poquan: 50 });
  let state = { products, ads: [result.sourceReplacement, ...result.addedSegments] };
  const check = () => {
    for (const [date, expected] of [["2026-09-01", { AV9: 8000, av9_poquan: 16000, HYC: 16000 }],
      ["2026-09-02", { AV9: 20000, av9_poquan: 20000, HYC: 0 }],
      ["2026-09-30", { AV9: 20000, av9_poquan: 20000, HYC: 0 }]]) {
      const allocated = {}, daily = {};
      for (const ad of state.ads) {
        assert.equal(ad.amortize_days, 30);
        if (ad.start_date <= date && date < ad.end_date) {
          for (const [pid, w] of Object.entries(ad.weights)) allocated[pid] = (allocated[pid] || 0) + ad.amount_cny * w / 100;
        }
        for (const [pid, value] of Object.entries(dailySpendForAd(ad, date, state.ads))) daily[pid] = (daily[pid] || 0) + value;
      }
      for (const [pid, amount] of Object.entries(expected)) {
        near(allocated[pid] || 0, amount);
        near(daily[pid] || 0, amount * 4.9 / 30);
      }
      near(Object.values(allocated).reduce((a, b) => a + b, 0), 40000);
    }
    for (const ad of state.ads) assert.deepEqual(dailySpendForAd(ad, "2026-10-01", state.ads), {});
  };
  check();
  for (let cycle = 0; cycle < 3; cycle++) {
    const next = { products, ads: [] };
    for (const name of ["廣告", "廣告權重"]) {
      const spec = TABLE_SYNC_SPECS.find((s) => s.sheetName === name);
      for (const row of spec.flatten(state)) spec.upsertInState(next, row._id,
        Object.fromEntries(spec.dataHeaders.map((h, i) => [h, row.dataRow[i]])));
    }
    state = next;
    check();
  }
  assert.deepEqual(source.weights, initial);
  assert.equal(source.end_date, "2026-10-01");
});


test("舊格式權重匯入再同步，不可把 20/40/40 取整成 19.8/40/40.2", () => {
  const parts = splitWeightsByFamily(initial, products);
  const spec = TABLE_SYNC_SPECS.find((s) => s.sheetName === "廣告權重");
  let state = { products, ads: [{ ...source, id: "legacy-parent", amount_cny: 24000,
    amount_twd: 117600, daily_amort_twd: 3920, weights: parts.normalInternal }] };
  for (let cycle = 0; cycle < 3; cycle++) {
    const legacy = spec.flatten(state).map((row) => row.dataRow);
    const rows = spec.legacyParse(spec.dataHeaders, legacy);
    const restored = JSON.parse(JSON.stringify(state));
    restored.ads[0].weights = {};
    for (const row of rows) spec.upsertInState(restored, row._id,
      Object.fromEntries(spec.dataHeaders.map((header, i) => [header, row.dataRow[i]])));
    state = restored;
    near(state.ads[0].amount_cny * state.ads[0].weights.AV9 / 100, 8000);
    near(state.ads[0].amount_cny * state.ads[0].weights.HYC / 100, 16000);
    const daily = dailySpendForAd(state.ads[0], "2026-09-01", state.ads);
    near(daily.AV9, 8000 * 4.9 / 30);
    near(daily.HYC, 16000 * 4.9 / 30);
  }
});
