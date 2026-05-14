// 概覽:各站長餘額總覽、低餘額警示、本月結算預覽。
// P1 骨架,實際內容後續補。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  root.innerHTML = `
    <header class="view-head">
      <h1>📊 概覽</h1>
      <div class="ink-2" style="font-size:13px">${s.settings.current_month}</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來顯示:</p>
      <ul class="ink-2">
        <li>各站長 RMB 餘額一覽表(低於 ${s.settings.low_balance_threshold_rmb || 200} 標紅)</li>
        <li>本月各站長結算金額預覽</li>
        <li>近期匯入狀況 / 線路淘汰提醒</li>
      </ul>
    </section>
  `;
}
