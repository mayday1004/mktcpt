// 對帳報表(給站長用,全 RMB):站長 × 月份,顯示日明細 / 各產品安裝 × 單價小計 / 結算 / 剩餘。
// P1 骨架。

export function render(root) {
  root.innerHTML = `
    <header class="view-head">
      <h1>📄 對帳報表</h1>
      <div class="ink-2" style="font-size:13px">站長用 · 全 RMB</div>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>篩選器:站長 × 月份</li>
        <li>顯示:上月餘款 / 預付款、日明細(每日各產品安裝 × 單價小計)、各產品安裝總計、結算總金額(RMB)、本期打款記錄、剩餘金額(可為負)</li>
        <li>後結算站長:剩餘為負 = 應付金額</li>
        <li>不匯出 PDF/Excel,截圖即可</li>
      </ul>
    </section>
  `;
}
