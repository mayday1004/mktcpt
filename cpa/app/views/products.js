// 產品管理:CPA 產品 CRUD,設定 GSheets 欄位代碼、是否啟用 CPA 計價。
// P1 骨架。

import { getState } from "../state.js";

export function render(root) {
  const s = getState();
  const count = (s.products || []).length;
  root.innerHTML = `
    <header class="view-head">
      <h1>🎯 產品</h1>
      <div class="ink-2" style="font-size:13px">${count} 個</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>新增 / 編輯產品(名稱、GSheets 欄位代碼、是否啟用 CPA 計價)</li>
      </ul>
    </section>
  `;
}
