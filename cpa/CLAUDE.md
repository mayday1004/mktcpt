# CPA 廣告計價後台 - 規格文件

## 0. 回覆答案時

以繁體中文回答為主,不要中英文夾雜。

---

## 1. 系統概述

這是一個 **CPA(Cost Per Action / 按安裝計費)廣告計價後台**。
廣告主管理多位站長(Publisher),每位站長旗下有多條線路(Channel,即渠道),
系統依**廠商安裝數 × CPA 單價**計算結算金額,並追蹤每位站長的預付款餘額。

**跟同 repo 內 CPT 廣告投放管理系統的關係**:
- **完全獨立的兩個系統**,各自的站長 / 廣告資料不互通(就算名字相同也視為兩筆)
- **共用「同步協定的程式碼骨架」** — v4 row-level CAS 同步、conflict-resolver modal、sync-log
- 兩邊各自走自己的 Google Sheets + Apps Script Token

**技術架構**:
- 前端:純靜態網頁(HTML + JS + CSS,ES modules,無 build step)
- 中介層:Google Apps Script Web App(部署為 Web App URL,執行身分 = 擁有者、存取權 = 任何人)
- 資料庫:Google Sheets(透過 Apps Script 雙向 row-level CAS 讀寫)
- localStorage 當 warm cache;網路斷線時本機 state 仍可操作,連線後同步

**自包含子專案**:這個 `cpa/` 目錄是完全自包含的,沒有 `import "../app/..."` 跨目錄相依。
未來搬到別台機器時,zip 整個 `cpa/` → 解壓 → 把內容放在新機器的網站根目錄就能跑(網址 `/`)。
開發期間透過 `scripts/sync-shared.cjs` 從 CPT 同步同步層改動進來,避免雙份飄移(詳見 §8)。

---

## 2. 核心實體

### 2.1 Product(產品)
- `id`(使用者自訂代碼)
- `name`(名稱)
- `gsheet_field_code`(匯入時用於對應 GSheets 欄位)
- `cpa_enabled`(布林,是否啟用 CPA 計價;沒啟用的產品不參與結算)
- `created_at`

### 2.2 Publisher(站長)
- `id`
- `name`
- `default_cpa_price_rmb`(預設 CPA 單價,RMB,範圍約 1.5~2.5)
- `contact_info`
- `settlement_mode`:`prepaid`(預付款制)或 `postpaid`(後結算制)
- `created_at`

### 2.3 Channel(線路 / 渠道)
- `id`
- `name`(渠道名稱,匯入時的**唯一識別鍵**,要跟 GSheets 匯入表格的渠道欄完全一致)
- `publisher_id`
- `cpa_price_rmb`(選填,個別單價;覆蓋站長預設單價)
- `status`:`啟用中` / `淘汰中` / `已淘汰`
- `eliminated_at`(被標記淘汰的日期)
- `billing_end_date`(截止計費日期,選填)
- `elimination_mode`:`stop` 停止計費 / `winding-down` 淘汰中繼續計費(詳見 §6)
- `confirmed_eliminated_at`(使用者手動確認後切換到「已淘汰」的日期)
- `notes`
- `created_at`

### 2.4 Payment(打款記錄)
- `id`
- `publisher_id`
- `date`
- `amount_rmb`(該筆 RMB 金額)
- `exchange_rate`(該筆下款的 RMB → TWD 匯率,鎖定不變,用於該批次的 TWD 花費計算)
- `remaining_rmb`(該批次還沒被結算費用消耗掉的 RMB 剩餘,FIFO 機制用)
- `notes`
- `created_at`

### 2.5 InstallData(每日安裝數據)
從匯入流程寫入。`_id` 用複合鍵 `date::channel_id::product_id`。

| 欄位 | 說明 |
|---|---|
| `date` | |
| `channel_id` | 從匯入「渠道名稱」比對線路得到 |
| `product_id` | 從匯入欄位代碼對應產品得到 |
| `不重複安裝數` | |
| `廠商安裝` | **CPA 計費依此欄位** |
| `不重複活躍` | |
| `首儲訂單數` | |
| `首儲金額` | |
| `訂單加總數` | |
| `總金額` | |
| `所有排重安裝` | |
| `所有排重活躍` | |

### 2.6 CustomMetric(自訂欄目)
給「內部報表」用,跟 CPT 的 `report_config.custom_metrics` 同 pattern。
- `id`
- `name`(欄目名稱)
- `formula`(計算公式,可引用原始欄位 + 系統計算值)
- `show_as_percent`

---

## 3. 計價規則

### 3.1 適用單價
```
適用單價(RMB)= 線路個別單價(若有設定) or 站長預設單價
```

### 3.2 結算金額(RMB)
```
結算金額(RMB)= Σ 各產品 廠商安裝數(四捨五入) × 適用單價
站長結算總金額(RMB)= Σ 旗下所有線路結算金額
剩餘金額(RMB)= Σ 預付款 − Σ 結算費用(可為負數)
```

**規則**:
- **安裝數必須四捨五入後再乘以單價**(`Math.round(廠商安裝) × 單價`)
- 同一站長所有產品共用相同單價(線路個別單價亦同 — 同線路所有產品共用)
- 剩餘金額為負數代表應付給站長的欠款
- 站長對帳單**全程使用 RMB**,不顯示 TWD

### 3.3 花費計算(TWD,內部報表用)
```
花費(TWD)= 廠商安裝數(四捨五入) × CPA 單價(RMB) × 適用匯率(依 FIFO 決定)
```

詳見 §4.2 FIFO 機制。

---

## 4. 貨幣與匯率

### 4.1 用途
| 用途 | 幣別 |
|------|------|
| CPA 單價 | RMB |
| 打款給站長 | RMB |
| 站長對帳單 | RMB |
| 內部報表花費 | TWD(由 RMB × FIFO 匯率換算) |
| 內部報表收入欄位(首儲金額等) | TWD(用 `settings.income_rate` 換算) |

### 4.2 匯率 FIFO 消耗機制

每次補款記錄一個 `(RMB 金額, 當次匯率)` 批次。計算 TWD 花費時,**依時間順序消耗各批次的 RMB 餘額**:

```
範例:
  批次 A(較早):1,000 RMB @ 4.7  → TWD 成本 4,700
  批次 B(較晚):500 RMB @ 4.8    → TWD 成本 2,400

某日花費 800 RMB(廠商安裝 × 單價)→
  ① 先消耗批次 A 的 800 RMB,適用匯率 4.7 → 3,760 TWD
  ② 批次 A 剩 200 RMB

某日花費 600 RMB →
  ① 消耗批次 A 剩 200 RMB @ 4.7 → 940 TWD
  ② 再消耗批次 B 的 400 RMB @ 4.8 → 1,920 TWD
  ③ 該日總 TWD 花費 2,860
  ④ 批次 A 耗盡(remaining_rmb=0)、批次 B 剩 100 RMB
```

**為什麼這樣設計**:確保 TWD 花費反映實際取得 RMB 的成本,符合 FIFO 會計原則。

**沒有對應批次怎麼辦**:若某日結算費用 > Σ 預付款剩餘(預付款制超花、或後結算制完全沒打款),
用 `settings.expense_rate`(預設值)當 fallback 匯率,並在報表上標警示。

---

## 5. 功能模組(對應 sidebar)

### 5.1 概覽
- 各站長 RMB 餘額一覽表(低於 `settings.low_balance_threshold_rmb` 標紅)
- 本月各站長結算金額預覽
- 近期匯入狀況 / 線路淘汰提醒

### 5.2 站長
- CRUD:名稱 / 預設 CPA 單價(RMB) / 聯絡方式 / 結算模式(預付/後結)
- 查看旗下線路與本月結算金額

### 5.3 線路
- CRUD:渠道名稱(唯一識別鍵) / 所屬站長 / 個別單價(空白沿用站長預設)
- 淘汰生命週期(詳見 §6)
- 線路異動報表(輸入日期區間,列出該區間新增 / 淘汰的線路)

### 5.4 產品
- CRUD:名稱 / GSheets 欄位代碼 / 是否啟用 CPA 計價

### 5.5 資料匯入
- 從 GSheets「安裝數據輸入」分頁讀(類似 CPT 「成效輸入」流程)
- 用渠道名稱比對系統線路,**未能對應者彈警告,不寫入**
- 預覽 → 確認 → 寫入本機 `install_data` + 推回 GSheets「安裝數據」
- 匯入欄位:日期 / 渠道名稱 / 各原始指標(§2.5 表格)
- 手動觸發(未來預留排程介面)

### 5.6 帳務
- 各站長 RMB 餘額總覽
- 新增打款記錄(日期 / RMB 金額 / 匯率 / 備註)
- FIFO 匯率批次管理:可查看各批次的初始 RMB、已消耗、剩餘
- 低餘額警示

### 5.7 對帳報表(給站長用,全 RMB)
按**站長 × 月份**篩選。

| 欄位 | 說明 |
|------|------|
| 站長名稱 | |
| 上月餘款 / 預付款 | 上期結轉餘額(RMB) |
| 日期明細 | 每日各產品安裝數 × 單價小計(RMB) |
| 各產品安裝數總計 | |
| 結算總金額(RMB) | |
| 本期打款記錄 | 該期間收到的預付款(RMB) |
| 剩餘金額(RMB) | 預付款累計 − 結算費用累計(可為負) |

- 後結算站長無預付款,剩餘為負數 = 應付金額
- 不需匯出 PDF / Excel,截圖後台畫面即可

### 5.8 內部報表(給廣告主用,TWD + 自訂欄目)
**Mirror CPT 的成效報表**([../app/views/perf-report.js](../app/views/perf-report.js))。

- pivot 表:`線路 × 產品 × 日期`,可切換 group by
- 原始指標:§2.5 列出的 9 個
- **系統計算值**(從原始指標 + 設定推導):
  - `花費(TWD)` = 廠商安裝(四捨五入) × 適用單價 × 適用匯率(FIFO)
  - `結算金額(RMB)` = 廠商安裝(四捨五入) × 適用單價
  - `適用單價`、`適用匯率`(顯示給人看)
- **自訂欄目**(`state.custom_metrics`):公式可引用任何原始欄位 + 系統計算值
  - 範例:`CPI = 花費 / 不重複安裝數`、`ROI = 首儲金額 × 收入匯率 / 花費`
- 篩選 + 隱藏 / 顯示欄位記住 + CSV 匯出

### 5.9 設定
- Apps Script Web App URL + Token(CPA 自己的 Sheets,跟 CPT 不同)
- 支出匯率 / 收入匯率(內部報表用的預設值;打款記錄有指定的話以該批次為準)
- 低餘額警示閾值(RMB)
- 重設同步狀態 / 重設全部資料

---

## 6. 線路生命週期

```
啟用中
  ↓ 標記淘汰(填截止計費日期、淘汰模式)
淘汰中(繼續計費)
  - 橘色 / 紅色醒目標示
  - 系統在截止日到時跳提醒
  - 由使用者**手動確認**後才切換
  ↓ 手動確認
已淘汰(停止計費)
  - 從 `confirmed_eliminated_at` 隔天起的安裝數不計入結算金額
  - 但安裝數仍繼續匯入紀錄備查
```

**淘汰模式**:
- **`stop`(停止計費模式)**:明確停止合作,從淘汰當日隔天起就不計費。`billing_end_date` 預設 = 淘汰日期。
- **`winding-down`(淘汰中模式)**:已通知站長停止但對方還在處理,繼續計費並顯示淘汰標記,
  提醒使用者督促站長盡快結束廣告並確認最終結算截止日。

**規則**:
- 淘汰後**可恢復啟用**,歷史紀錄保留
- 線路狀態為「淘汰中」時,所有列表 / 報表必須醒目標示(橘 / 紅)
- 截止計費日期到期提醒**只顯示,不自動切換狀態** — 使用者要手動確認

---

## 7. 儲存與同步

### 7.1 v4 Row-level CAS 同步協定
跟 CPT 完全相同的協定,只是換 namespace + 不同 Sheet。詳細看 [../CLAUDE.md §7](../CLAUDE.md)。

**摘要**:
- 每張資料分頁的最後 4 欄是隱性 metadata:`_id` / `_updated_at` / `_deleted` / `_version`
- Push 時帶 `_expected_version`,server CAS 不符就回 `conflicts[]` 不寫入
- Pull 時若「本機 dirty + server 也改過」也視為衝突
- 衝突未解前 auto-sync 暫停,右下角 ⚠️ banner 點開解衝突 modal
- 錯誤 logging:DevTools 打 `__cpaLog()` 看最近 200 筆同步事件

### 7.2 localStorage namespace
跟 CPT 完全隔離:

| key | 用途 |
|---|---|
| `cpa_state_v1` | 本機 state(站長 / 線路 / 產品 / 打款 / 安裝數據 / 自訂欄目) |
| `cpa_sync_meta_v1` | 每筆 row 的 `_version` + fingerprint + `_updated_at` |
| `cpa_server_version_v1` | server 全域版本號的 last-seen,用來短路 pull |
| `cpa_conflicts_v1` | 衝突佇列 |
| `cpa_undo_v1` | undo 堆疊 |
| `cpa_sidebar_collapsed` | sidebar 收合狀態 |

### 7.3 Apps Script
- 跟 CPT 用**同一份 Code.gs**(v4 協定本來就是通用 CRUD,不認得分頁名)
- CPA 自己開一個 Google Sheets,擴充功能 → Apps Script 貼 [apps-script/Code.gs](apps-script/Code.gs),
  `SECRET` 改用 CPA 專屬的隨機字串
- 部署 → Web App URL → 填到設定頁

### 7.4 試算表結構(分頁清單)
| 分頁名稱 | 內容 |
|---|---|
| `站長` | id, 名稱, 預設 CPA 單價(RMB), 聯絡方式, 結算模式 |
| `線路` | id, 渠道名稱, 所屬站長 ID, 個別 CPA 單價, 狀態, 淘汰相關欄位 |
| `產品` | id, 名稱, GSheets 欄位代碼, 是否啟用 CPA 計價 |
| `打款記錄` | id, 站長 ID, 日期, RMB 金額, 匯率, 批次剩餘 RMB, 備註 |
| `安裝數據` | id(複合), 日期, 渠道 ID, 產品 ID, 9 個原始指標 |
| `自訂欄目` | id, 名稱, 公式, 顯示百分比 |
| `安裝數據輸入` | 使用者貼資料用的暫存區,匯入按鈕單獨處理(不在一般同步循環) |
| `設定` | key/value 設定(支出/收入匯率、低餘額閾值) |
| `_sync_meta`(隱藏) | server_version + last_modified_at |

---

## 8. 技術方向 + 搬運說明

### 8.1 自包含原則
- `cpa/` 下**沒有**任何 `import "../app/..."` 或 `../shared/...` 跨目錄相依
- 共用同步層程式碼**物理複製**進 `cpa/app/`,namespace 改 `cpa_` 前綴
- 開發期間在這個 repo 內共寫,**未來搬機器只要打包 `cpa/` 整個資料夾**

### 8.2 搬到別台機器的步驟
1. zip `cpa/` 整個目錄
2. 放到新機器網站根目錄,網址會是 `/`(`cpa/index.html` → `/index.html`)
3. 開新的 Google Sheets,擴充功能 → Apps Script,貼 `cpa/apps-script/Code.gs`,改 `SECRET`
4. 部署 → 拿 Web App URL,進新後台的設定頁填 URL + Token
5. 完成,可獨立運作

### 8.3 開發期維護:同步層雙份不要飄移
CPT 共用同步層改動後,在 repo root 跑:
```
node scripts/sync-shared.cjs
```
腳本會把以下檔案從 CPT 複製過來並套用 namespace 轉換:
- `app/io/sync.js` → `cpa/app/io/sync.js`(`buyads_*` → `cpa_*`)
- `app/io/conflict-store.js` → `cpa/app/io/conflict-store.js`
- `app/io/conflict-resolver.js` → `cpa/app/io/conflict-resolver.js`
- `app/lib/sync-log.js`(`__buyadsLog` → `__cpaLog`)
- `app/lib/sync-banner.js`
- `app/lib/deploy-config.js`(`__BUYADS_*` → `__CPA_*`)
- `app/lib/dates.js`
- `apps-script/Code.gs`

**改 CPA 專屬的同步層邏輯時不要改 cpa/ 那邊** — 改 CPT 那邊然後跑 script,否則下次 script 跑會被蓋掉。

---

## 9. 已決議規則

- **與 CPT 完全獨立**:資料、Sheets、Token、狀態各自獨立,選單列不互相跳轉,連名字相同也視為兩筆
- **金額一律 RMB**:站長對帳全程 RMB,TWD 只在內部報表用(RMB × FIFO 匯率)
- **安裝數先四捨五入**再乘單價(避免小數累積誤差)
- **匯率 FIFO**:打款記錄一筆批次,花費計算依時間順序消耗,匯率鎖定為該批次值
- **渠道名稱是線路唯一識別鍵**,匯入時以此比對
- **淘汰生命週期手動切換**:截止日提醒只顯示,不自動切換(避免誤判)
- **同步協定 v4 row-level CAS**:跟 CPT 同一份 Code.gs,只是部署到不同 Sheets
- **localStorage namespace `cpa_*`**:跟 CPT 完全隔離

---

## 10. 待釐清問題

(目前全部已釐清,實作中若有新問題再補。)
