# Apps Script 部署

> 💡 **完整步驟與複製按鈕在應用程式內** — 開啟網頁 → **設定** 頁 → 「☁️ Google Sheets 同步」卡片 → 點「⚙️ 一次性設定步驟」。

本資料夾的檔案:

- [Code.gs](Code.gs) — Apps Script 程式碼(SECRET 讀「指令碼屬性」,見下方)
- [appsscript.json](appsscript.json) — 時區、執行時期、webapp 存取設定(API 部署時的「任何人」來自這裡)
- [deployment.json](deployment.json) — 目前使用中的 deployment ID(= /exec 網址中 `/macros/s/` 後那串)

## 自動部署(clasp)

改了 Code.gs 之後**不用再進 Apps Script 編輯器手動部署**:

```
npm run as:deploy        # clasp push + 更新同一個 deployment → /exec 網址永遠不變
npm run as:rotate-url    # 只在 Google 對舊網址持續 404 時用:開新網址 + 自動更新 Railway 變數
```

- `as:deploy` 沿用 [deployment.json](deployment.json) 裡的 deployment ID → **網址不變,Railway 不用動**
- `as:rotate-url` 建全新 deployment(新網址)→ 驗證活著 → 寫回 deployment.json → 更新 `.env.local` → 用 Railway CLI 改 `SHEETS_WEBAPP_URL`(觸發自動重佈)。舊 deployment 不刪,同事重整頁面後才切到新網址
- push 到 GitHub `main` 且 `apps-script/**` 有改動時,[GitHub Action](../.github/workflows/deploy-apps-script.yml) 也會自動跑 `as:deploy`(需設定 `CLASPRC_JSON` secret,見下)

### 一次性設定

1. **啟用 Apps Script API**:https://script.google.com/home/usersettings → 開啟
2. **登入 clasp**:`npx @google/clasp login`(用擁有這份試算表的 Google 帳號)
3. **填 scriptId**:Apps Script 編輯器 → ⚙️ 專案設定 → 複製「指令碼 ID」→ 貼進 repo 根目錄 [.clasp.json](../.clasp.json)
4. **把 SECRET 搬到指令碼屬性**:Apps Script 編輯器 → ⚙️ 專案設定 → 指令碼屬性 → 新增 `SECRET` = 你的隨機字串(要跟 Railway 的 `SHEETS_TOKEN` 一致)。Code.gs 優先讀這裡,真正的 token 不進 git,自動部署覆寫檔案也不會弄丟
5. **(rotate 用)登入 Railway CLI**:`npx @railway/cli login`,然後在 repo 目錄 `npx @railway/cli link` 選對 project/service
6. **(選用,GitHub 自動部署)**:本機 `clasp login` 完成後,把 `~/.clasprc.json` 整份內容存成 GitHub repo secret `CLASPRC_JSON`

### 為什麼網址可以永遠不變

`/exec` 網址長這樣:`https://script.google.com/macros/s/<deploymentId>/exec` — 網址就是 deployment ID。
「管理部署 → 編輯 → 新版本」(= `clasp deploy -i <同一個ID>`)只換程式碼版本、不換 ID → 網址不變。
只有「新增部署作業」(= `clasp deploy` 不帶 ID)才會生出新網址 — 所以平常一律用 `as:deploy`,新網址只留給路由故障時的 `as:rotate-url`。

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
- **Apps Script 回了 HTML 頁面**:通常是 Google/Apps Script 暫時錯誤、沒授權完成、部署時存取權沒選「任何人」、或 URL 不是 `/exec`
- **改了代碼但沒生效**:跑 `npm run as:deploy`(或手動「管理部署 → 編輯 → 版本:新版本 → 部署」)
- **`headers must include _id, _updated_at, _deleted, _version`**:升 v4 後客戶端漏帶 `_version` 欄

## 客戶端看 sync log

任何時間在瀏覽器 DevTools console 打 `__buyadsLog()` 可以看最近 200 筆同步事件(push、pull、conflict、network 錯誤等)。
有人回報「我明明儲存了卻又被改回去」時,叫他打開 console 跑這個指令把結果貼出來。
