// 線路管理:CRUD、淘汰生命週期、線路異動報表。
// P1 骨架。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  const count = (s.channels || []).length;
  root.innerHTML = `
    <header class="view-head">
      <h1>🔌 線路</h1>
      <div class="ink-2" style="font-size:13px">${count} 條</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>新增 / 編輯線路(渠道名稱 = 匯入比對鍵、所屬站長、個別 CPA 單價可覆寫)</li>
        <li>淘汰生命週期:啟用中 → 淘汰中(繼續計費 / 橘色標示)→ 已淘汰(停計費)</li>
        <li>截止計費日期提醒(系統提醒,使用者手動確認後切換)</li>
        <li>線路異動報表(日期區間內新增 / 淘汰的線路)</li>
      </ul>
    </section>
  `;
}
