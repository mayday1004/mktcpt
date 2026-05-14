# Apps Script 部署

> 💡 **完整步驟與複製按鈕在應用程式內** — 開啟網頁 → **設定** 頁 → 「☁️ Google Sheets 同步」卡片 → 點「⚙️ 一次性設定步驟」。

本資料夾保留兩個檔案作為參考／版控:

- [Code.gs](Code.gs) — 貼到 Apps Script 編輯器的內容(記得把 `SECRET` 改成自己的隨機字串)
- [appsscript.json](appsscript.json) — 時區與執行時期設定

## 同步協定版本

**v4(目前)— Row-level CAS**:每筆 row 多一個 `_version` 整數欄位,client push 時帶 `_expected_version`,
server 比對:不符就回 conflicts(不寫入)、相符就 +1 寫入。比 v3 多一道防護避免靜默覆寫。

**META_COLS 順序**:`_id` → `_updated_at` → `_deleted` → `_version`

歷史:
- v3:Row-level LWW(silent overwrite,2026-05 之前)
- v4:Row-level CAS(衝突偵測 + 解衝突 UI,2026-05 起)

升級 v3 → v4:第一次 upsertRows 自動 migrate(header 對不上 → 整片清掉重建,client 端會把全部 row 推上來,等於 resync)。
舊資料沒有 `_version` 欄 → 第一次寫入時被視為 0,server 寫入後變 1,之後正常 CAS。

## 為什麼是通用 writeTable / readTable / upsertRows

這份 Apps Script 只做幾件事:依名字建/清/寫分頁、依名字讀分頁、CAS 寫入。**分頁結構完全由前端決定**。

好處:
- 以後新增/修改分頁欄位,**只要改前端**,不用碰 Apps Script
- 換 Sheet 或換電腦,把新的 Web App URL + SECRET 填回設定頁就能用
- 非工程師接手也只要會做「部署 → 貼 URL → 輸入 Token」三步

## 分頁清單(由前端 `app/io/sync-specs.js` 定義)

產品 / 產品月預算 / 產品日預算 / 產品預算變動 / 成效目標 / 廣告 / 廣告權重 / 成效資料 / 待辦 / 設定 / 報表自訂欄位

日期欄位(`YYYY-MM-DD` 開頭的字串)會被 Apps Script 自動設為純文字格式,避免 Sheets 自動把 `2026-04-24` 轉成「日期 44941」導致往返不一致。

## 對外 actions

| action | 用途 |
|---|---|
| `ping` | 健康檢查,回 `{ ok, version }` |
| `readMeta` | 拿 server_version + last_modified_at(輕量) |
| `readTable(sheetName)` | 讀單張 sheet |
| `readAllTables(sheetNames[])` | 一次拉多張 sheet(合 12 個 round trip 為 1 個) |
| `upsertRows(sheetName, headers, rows)` | **CAS 寫入**:rows 內 `_version` 為 expected,server 不符就進 conflicts |
| `writeTable(sheetName, headers, rows)` | 整片覆寫(救援用,不檢查 version) |

## upsertRows CAS 行為

對每筆輸入 row 看 `_id`:
- 既有不存在 + expected=0 → create,server 寫入 version=1
- 既有不存在 + expected>0 → resurrection(可能對方刪了又被你拉回來),寫入 version=expected+1
- 既有存在,server.version == expected → 寫入,version=expected+1
- 既有存在,server.version != expected → **衝突**,不寫入,收進 `conflicts` 回應

回應格式:
```json
{
  "ok": true,
  "applied": [{ "_id": "...", "_updated_at": "...", "_version": 5 }],
  "conflicts": [{
    "_id": "...",
    "current_row": [...],
    "current_version": 7,
    "current_updated_at": "2026-05-14T10:23:45.000Z",
    "expected_version": 4
  }],
  "server_version": 1234
}
```

## 除錯

- **invalid token**:Apps Script 裡的 `SECRET` 跟設定頁的 Token 不一致
- **回應非 JSON**:通常是沒授權完成、或部署時存取權沒選「任何人」
- **改了代碼但沒生效**:要到「管理部署 → 編輯 → 版本:新版本 → 部署」
- **`headers must include _id, _updated_at, _deleted, _version`**:升 v4 後客戶端漏帶 `_version` 欄

## 客戶端看 sync log

任何時間在瀏覽器 DevTools console 打 `__buyadsLog()` 可以看最近 200 筆同步事件(push、pull、conflict、network 錯誤等)。
有人回報「我明明儲存了卻又被改回去」時,叫他打開 console 跑這個指令把結果貼出來。
