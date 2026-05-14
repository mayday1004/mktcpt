// 資料匯入:從 GSheets「安裝數據輸入」分頁讀取,渠道名稱比對線路後寫入。
// P1 骨架。

export function render(root) {
  root.innerHTML = `
    <header class="view-head">
      <h1>📥 資料匯入</h1>
    </header>
    <section class="empty-state">
      <h2>🚧 開發中</h2>
      <p class="ink-2">本頁未來:</p>
      <ul class="ink-2">
        <li>從 GSheets「安裝數據輸入」分頁拉資料(類似 CPT 的「成效輸入」)</li>
        <li>用渠道名稱比對系統線路,未對應者彈警告</li>
        <li>預覽 → 匯入按鈕 → 寫進 install_data + 推回 GSheets「安裝數據」</li>
      </ul>
    </section>
  `;
}
