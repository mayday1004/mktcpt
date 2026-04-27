# Apps Script 部署

> 💡 **完整步驟與複製按鈕在應用程式內** — 開啟網頁 → **設定** 頁 → 「☁️ Google Sheets 同步」卡片 → 點「⚙️ 一次性設定步驟」。

本資料夾保留兩個檔案作為參考／版控：

- [Code.gs](Code.gs) — 貼到 Apps Script 編輯器的內容（記得把 `SECRET` 改成自己的隨機字串）
- [appsscript.json](appsscript.json) — 時區與執行時期設定

## 為什麼是通用 writeTable / readTable

這份 Apps Script 只做兩件事：依名字建/清/寫分頁、依名字讀分頁。**分頁結構完全由前端決定**。

好處：

- 以後新增/修改分頁欄位，**只要改前端**，不用碰 Apps Script
- 換 Sheet 或換電腦，把新的 Web App URL + SECRET 填回設定頁就能用
- 非工程師接手也只要會做「部署 → 貼 URL → 輸入 Token」三步

## 分頁清單（由前端 `app/io/sheets-schema.js` 定義）

產品 / 成效目標 / 廣告 / 廣告權重 / 成效資料 / 待辦 / 設定

日期欄位（`YYYY-MM-DD` 開頭的字串）會被 Apps Script 自動設為純文字格式，避免 Sheets 自動把 `2026-04-24` 轉成「日期 44941」導致往返不一致。

## 除錯

- **invalid token**：Apps Script 裡的 `SECRET` 跟設定頁的 Token 不一致
- **回應非 JSON**：通常是沒授權完成、或部署時存取權沒選「任何人」
- **改了代碼但沒生效**：要到「管理部署 → 編輯 → 版本：新版本 → 部署」
