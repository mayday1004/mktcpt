import test from "node:test";
import assert from "node:assert/strict";
import { describePlacements, productsIntersect } from "../app/domain/placements.js";

function seg(partial) {
  return {
    currency: "USDT",
    currency_rate: 6.8,
    exchange_rate: 4.9,
    amortize_days: 31,
    purchase_mode: "shared",
    renewal_of: null,
    renewal_reason: "續頁",
    notes: "",
    ad_copy: "",
    ...partial,
  };
}

test("同期不同產品的版位不是未串鏈", () => {
  const av9 = seg({
    id: "av9", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 537,
    weights: { AV9: 100 }, purchase_mode: "independent",
  });
  const hyc = seg({
    id: "hyc", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 537,
    weights: { HYC: 100 }, purchase_mode: "independent",
  });
  const love = seg({
    id: "love", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 200, amount_cny: 1360, daily_amort_twd: 215,
    weights: { LOVE2: 100 }, purchase_mode: "independent",
  });
  const slot = seg({
    id: "slot", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 400, amount_cny: 2720, daily_amort_twd: 430,
    weights: { PJ8: 50, OJI: 50 },
    notes: "側邊栏banner",
  });
  const previous = seg({
    id: "prev", ad_code: "1017", start_date: "2026-09-10", end_date: "2026-10-06",
    renewal_reason: "初始", amount_orig: 433, amount_cny: 2944, daily_amort_twd: 559,
    weights: { PJ8: 50, OJI: 50 },
  });
  const all = [previous, av9, hyc, love, slot];
  const placement = describePlacements(all, av9);
  assert.equal(placement.parallel, true);
  assert.deepEqual(placement.coveredIds.sort(), ["av9", "hyc", "love", "slot"]);
  assert.equal(productsIntersect(slot, av9), false);
  assert.equal(productsIntersect(previous, slot), false);
  assert.equal(placement.positions.some((item) => item.seg.id === "slot"), true);
});

test("版位中途改權重：原產品只跑到切點，新產品另開一節", () => {
  const av9 = seg({
    id: "av9", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-10-08",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 537,
    weights: { AV9: 100 }, purchase_mode: "independent",
  });
  const islands = seg({
    id: "islands", ad_code: "1017", start_date: "2026-10-08", end_date: "2026-11-06",
    renewal_of: "av9", renewal_reason: "權重調整",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 538,
    weights: { ZFB: 50, MYS: 50 },
  });
  const hyc = seg({
    id: "hyc", ad_code: "1017", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 537,
    weights: { HYC: 100 }, purchase_mode: "independent",
  });
  const all = [av9, hyc, islands];
  const placement = describePlacements(all, islands);
  assert.equal(placement.parallel, true);
  assert.equal(placement.positions.find((item) => item.seg.id === "av9").until, "2026-10-08");
  assert.equal(placement.adjusts.length, 1);
  assert.equal(placement.adjusts[0].seg.id, "islands");
  assert.equal(placement.adjusts[0].seg.start_date, "2026-10-08");
  assert.equal(placement.adjusts[0].seg.end_date, "2026-11-06");
  assert.deepEqual(placement.coveredIds.sort(), ["av9", "hyc", "islands"]);
  assert.equal(productsIntersect(islands, hyc), false);
});

test("同產品重疊的共購段仍是重複，不併進版位合計", () => {
  const kept = seg({
    id: "kept", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 400, amount_cny: 2720, daily_amort_twd: 430,
    weights: { PJ8: 50, OJI: 50 },
  });
  const extra = seg({
    id: "extra", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 400, amount_cny: 2720, daily_amort_twd: 430,
    weights: { PJ8: 50, OJI: 50 },
  });
  const other = seg({
    id: "other", start_date: "2026-10-06", end_date: "2026-11-06",
    amount_orig: 500, amount_cny: 3400, daily_amort_twd: 537,
    weights: { AV9: 100 }, purchase_mode: "independent",
  });
  const placement = describePlacements([kept, extra, other], other);
  assert.deepEqual(placement.duplicateIds, ["extra"]);
  assert.equal(placement.coveredIds.includes("extra"), false);
  assert.equal(productsIntersect(extra, kept), true);
});
