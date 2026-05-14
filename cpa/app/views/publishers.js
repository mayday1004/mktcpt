// 站長管理:CRUD、預設 CPA 單價(RMB)、結算模式(預付/後結)、聯絡方式。
// P1 骨架。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  const count = (s.publishers || []).length;
  root.innerHTML = `
    <header class="view-head">
      <h1>👤 站長</h1>
      <div class="ink-2" style="font-size:13px">${count} 位</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>新增 / 編輯站長(名稱、預設 CPA 單價 RMB、聯絡方式、結算模式)</li>
        <li>查看旗下線路與本月結算</li>
      </ul>
    </section>
  `;
}
