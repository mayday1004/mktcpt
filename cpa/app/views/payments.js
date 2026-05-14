// 帳務管理:各站長餘額總覽、打款記錄、FIFO 匯率批次。
// P1 骨架。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  const count = (s.payments || []).length;
  root.innerHTML = `
    <header class="view-head">
      <h1>💰 帳務</h1>
      <div class="ink-2" style="font-size:13px">${count} 筆打款</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>各站長 RMB 餘額一覽(預付款累計 − 結算費用累計)</li>
        <li>新增打款記錄(日期、RMB 金額、匯率、備註)</li>
        <li>FIFO 匯率批次管理:每批次的初始 RMB、已消耗、剩餘</li>
        <li>低餘額警示(低於閾值標紅)</li>
      </ul>
    </section>
  `;
}
