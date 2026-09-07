import test from "node:test";
import assert from "node:assert/strict";
import { renderTimelineNode } from "../app/views/ads.js";
import { dailySpendForAd, displayWeightsForAd } from "../app/domain/spending.js";

test("調權後歷史段保留 20/40/40，增減各依前後期比例", () => {
  const products = [
    { id: "AV9", name: "愛威奶" },
    { id: "HYC", name: "黃油圈" },
    { id: "av9_poquan", name: "愛威奶破圈", is_poquan: true, parent_product_id: "AV9" },
  ];
  const segment = (id, code, amount, weights, start, end, prev = null) => ({
    id, ad_code: code, amount_cny: amount, amount_twd: amount * 4.9,
    daily_amort_twd: amount * 4.9 / 30, amortize_days: 30, exchange_rate: 4.9,
    weights, start_date: start, end_date: end, split_pair_id: "history-pair",
    split_role: code.endsWith("t") ? "t_variant" : "parent",
    renewal_of: prev, renewal_reason: prev ? "權重調整" : "初始",
  });
  const parent = segment("p1", "st304", 24000, { AV9: 100 / 3, HYC: 200 / 3 }, "2026-09-01", "2026-09-02");
  const variant = segment("t1", "st304t", 16000, { av9_poquan: 100 }, "2026-09-01", "2026-09-02");
  const nextParent = segment("p2", "st304", 20000, { AV9: 100 }, "2026-09-02", "2026-10-01", "p1");
  const nextVariant = segment("t2", "st304t", 20000, { av9_poquan: 100 }, "2026-09-02", "2026-10-01", "t1");
  const allAds = [parent, variant, nextParent, nextVariant];
  const before = structuredClone(allAds);
  const render = (seg, idx, chain) => renderTimelineNode(seg, idx, chain, products,
    { allAds, familyScale: 0.5, timelineMode: "weight-chain", referenceSeg: chain.at(-1) });
  const oldParentHtml = render(parent, 0, [parent, nextParent]);
  const oldVariantHtml = render(variant, 0, [variant, nextVariant]);
  assert.match(oldParentHtml, /愛威奶 20%/);
  assert.match(oldParentHtml, /黃油圈 40%/);
  assert.match(oldVariantHtml, /愛威奶破圈 40%/);
  const newParentHtml = render(nextParent, 1, [parent, nextParent]);
  const newVariantHtml = render(nextVariant, 1, [variant, nextVariant]);
  assert.match(newParentHtml, /愛威奶 50%/);
  assert.match(newParentHtml, /愛威奶 \+30%/);
  assert.match(newParentHtml, /黃油圈 -40%/);
  assert.match(newVariantHtml, /愛威奶破圈 \+10%/);
  assert.deepEqual(displayWeightsForAd(parent, allAds, "2026-09-01"), { AV9: 20, HYC: 40 });
  assert.deepEqual(displayWeightsForAd(variant, allAds, "2026-09-01"), { av9_poquan: 40 });
  const totalDaily = 40000 * 4.9 / 30;
  const daily = dailySpendForAd(parent, "2026-09-01", allAds);
  assert.ok(Math.abs(daily.AV9 - totalDaily * 0.2) < 1e-8);
  assert.ok(Math.abs(daily.HYC - totalDaily * 0.4) < 1e-8);
  assert.deepEqual(allAds, before);
});


test("同配對 ID 的 dhst304 不得縮放 st304 的歷史或目前比例", () => {
  const parent = { id: "p", ad_code: "st304", split_pair_id: "shared-id", split_role: "parent",
    start_date: "2026-09-01", end_date: "2026-10-01", amount_cny: 24000,
    weights: { AV9: 100 / 3, HYC: 200 / 3 } };
  const variant = { ...parent, id: "t", ad_code: "st304t", split_role: "t_variant",
    amount_cny: 16000, weights: { av9_poquan: 100 } };
  const unrelated = [{ ...parent, id: "dhp", ad_code: "dhst304" },
    { ...variant, id: "dht", ad_code: "dhst304t" }];
  for (const allAds of [[parent, variant, ...unrelated], [...unrelated, variant, parent]]) {
    for (const day of [null, "2026-09-01"]) {
      assert.deepEqual(displayWeightsForAd(parent, allAds, day), { AV9: 20, HYC: 40 });
      assert.deepEqual(displayWeightsForAd(variant, allAds, day), { av9_poquan: 40 });
    }
  }
});
