// CPA 同步分頁定義。架構與 CPT app/io/sync-specs.js 完全相同
// (sheetName / dataHeaders / flatten / upsertInState / removeFromState / legacyParse),
// 只是 entity 換成 CPA 的(站長 / 線路 / 產品 / 打款 / 安裝 / 自訂欄目)。
//
// P1 階段先放空陣列,讓骨架可以跑;P3 階段填入完整 specs。

export const TABLE_SYNC_SPECS = [
  // ── 1. 站長(_id = publisher.id) ───────────────────────────────────
  // 預留位置,P3 階段補
  //
  // ── 2. 線路(_id = channel.id) ─────────────────────────────────────
  // ── 3. 產品(_id = product.id) ─────────────────────────────────────
  // ── 4. 打款記錄(_id = payment.id) ─────────────────────────────────
  // ── 5. 安裝數據(_id = date::channel_id::product_id) ───────────────
  // ── 6. 自訂欄目(_id = custom_metric.id) ───────────────────────────
];
