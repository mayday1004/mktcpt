import test from "node:test";
import assert from "node:assert/strict";
import {
  describePlacements,
  placementLines,
  productsIntersect,
  sumLines,
} from "../app/domain/placements.js";
import { renderPlacementTimeline } from "../app/views/ads.js";

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

const products = [
  { id: "AV9", name: "愛威奶" },
  { id: "HYC", name: "黃油圈" },
  { id: "LOVE2", name: "love2" },
  { id: "PJ8", name: "破解吧" },
  { id: "OJI", name: "萬精游" },
  { id: "ZFB", name: "汁婦寶" },
  { id: "MYS", name: "磨欲爽" },
];

test("同期版位收成一張合約，400U 共購拆成兩條產品線", () => {
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
  assert.equal(productsIntersect(previous, av9), false);

  const lines = placement.positions.flatMap((item) => placementLines(item.seg));
  const totals = sumLines(lines);
  assert.equal(totals.usdt, 1600);
  assert.equal(totals.daily, 1719);
  const slotLines = placementLines(slot);
  assert.deepEqual(slotLines.map((line) => line.usdt), [200, 200]);
  assert.deepEqual(slotLines.map((line) => line.daily), [215, 215]);

  const html = renderPlacementTimeline(placement, all, products, { referenceSeg: av9 });
  assert.match(html, /USDT 1[,.]?600/);
  assert.match(html, /1[,.]?719 NTD/);
  assert.match(html, /各版位 100%/);
  assert.match(html, /側邊栏banner/);
  assert.match(html, /破解吧 50%/);
  assert.match(html, /萬精游 50%/);
  assert.doesNotMatch(html, /未串鏈/);
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
  assert.deepEqual(placement.coveredIds.sort(), ["av9", "hyc", "islands"]);

  const html = renderPlacementTimeline(placement, all, products, { referenceSeg: islands });
  assert.match(html, /只到 10\/8（2天）/);
  assert.match(html, /實際合約天數 31天/);
  assert.match(html, /汁婦寶/);
  assert.match(html, /磨欲爽/);
  assert.match(html, /愛威奶 0%/);
  assert.match(html, /汁婦寶 \+50%/);
  assert.match(html, /磨欲爽 \+50%/);
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
  const totals = sumLines(placement.positions.flatMap((item) => placementLines(item.seg)));
  assert.equal(totals.usdt, 900);
});
