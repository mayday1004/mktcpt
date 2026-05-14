// 內部報表(給廣告主用,TWD + 自訂欄目):mirror CPT 的成效報表。
// pivot:線路 × 產品 × 日期,可切換 group by。
// 系統計算值:花費(TWD)= 廠商安裝 × 適用單價 × 適用匯率(FIFO)、結算金額(RMB)。
// 自訂欄目走 state.custom_metrics(跟 CPT 同 pattern)。
// P1 骨架。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  const cmCount = (s.custom_metrics || []).length;
  root.innerHTML = `
    <header class="view-head">
      <h1>📈 內部報表</h1>
      <div class="ink-2" style="font-size:13px">廣告主用 · TWD · 自訂欄目 ${cmCount} 個</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來(mirror CPT 成效報表):</p>
      <ul class="ink-2">
        <li>pivot 表(線路 × 產品 × 日期,可切換 group by)</li>
        <li>原始指標:不重複安裝數、廠商安裝、不重複活躍、首儲訂單數、首儲金額…</li>
        <li>系統計算值:花費(TWD)、結算金額(RMB)、適用單價、適用匯率</li>
        <li>自訂欄目(CPI / ROI / 活躍率…公式可引用任何欄位)</li>
        <li>篩選 + 隱藏 / 顯示欄位記住 + CSV 匯出</li>
      </ul>
    </section>
  `;
}
