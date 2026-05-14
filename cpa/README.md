# CPA 廣告計價後台

按安裝(CPA)的廣告計價結算系統 — 管理站長 / 線路 / 打款 / 對帳。

📋 **完整規格與設計決議**:[CLAUDE.md](CLAUDE.md)

## 跟同 repo 內 CPT 系統的關係

- **完全獨立**的兩個系統,資料 / Sheets / Token 各自分開
- 共用「同步協定的程式碼骨架」(v4 row-level CAS + 衝突解決 modal),透過
  [`../scripts/sync-shared.cjs`](../scripts/sync-shared.cjs) 同步,**不要直接改 cpa/ 的同步層**
- 兩個系統選單列不互相跳轉

## 本地開發

在 repo root 起一個靜態伺服器(`python -m http.server` 或 VSCode Live Server),然後:
- CPT 在 `http://localhost:PORT/`
- CPA 在 `http://localhost:PORT/cpa/`

## 搬到別台機器(獨立部署)

1. 把 `cpa/` 整個資料夾 zip 起來
2. 放到新機器的網站根目錄,網址就會是 `/`(`cpa/index.html` → `/index.html`)
3. 開新的 Google Sheets,擴充功能 → Apps Script,貼 `apps-script/Code.gs`,改 `SECRET`
4. 部署為 Web App(執行身分 = 我;存取 = 任何人)→ 拿 URL
5. 開後台網頁,進設定頁填 URL + Token → 開始用

## 開發期維護同步層

CPT 共用層改動後,在 repo root 跑:
```
node scripts/sync-shared.cjs
```
會自動把 CPT 那邊改過的 sync engine / conflict store / sync-log / 等同步進來,
並套用 namespace 轉換(`buyads_*` → `cpa_*`、`__BUYADS_*` → `__CPA_*`)。

## 除錯

DevTools console 打 `__cpaLog()` 看最近 200 筆同步事件(push / pull / 衝突 / 網路錯誤)。
