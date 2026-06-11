# 縮網址後台串接方案（buyads ↔ Yourls）

> 2026-06-05 整理版。本文把目前討論收斂成可實作方案：buyads 負責產生待批准動作與寫入佇列，具備 Yourls IP 權限的 B 電腦負責用 Python/Playwright worker 主動拉佇列、登入 Yourls 後台執行，最後把結果寫回 Google Sheets。

## 0. 目前本機實際操作流程

目前要先跑的不是 fake Yourls，也不是 Railway。實際驗收流程是：

```text
VS Code Go Live 開 CPT 後台
→ 在 CPT 新建 L1 廣告或調整既有 L1 廣告權重
→ 到待辦按「批准」
→ CPT 寫入 Google Sheets 的 YOURLS操作佇列
→ 本機 PowerShell 掛著的 worker 讀取佇列
→ worker 用本機網路開真實 Yourls 後台
→ worker 建立縮網址 / 建立權重 / 修改權重
→ worker 回寫 applied 或 failed
→ CPT 同步後顯示已完成或錯誤
```

CPT 網頁本身不能直接啟動本機 Python，所以要先在本機另外開一個 PowerShell 視窗掛 worker。

### A/B 電腦資料夾模式

現在改成兩個獨立專案資料夾，不再把 worker 放在 buyads 裡，也不再用 `yourls_worker_dist` 打包。

本機測試資料夾：

```text
C:\Users\user\Downloads\
├─ buyads\          # A 電腦角色：CPT Go Live 前端
└─ yourls_worker\   # B 電腦角色：Yourls 帕魯 worker
```

實際上線時：

- A 電腦只需要開 `buyads` 專案，用 Go Live 操作 CPT 後台。
- B 電腦只需要開 `yourls_worker` 專案，在 VS Code terminal 常駐 worker。
- 兩邊透過 Google Sheets 的 `YOURLS操作佇列` 溝通。

`yourls_worker` 資料夾長這樣：

```text
yourls_worker/
├─ .env.local
├─ .env.local.example
├─ .venv/
├─ requirements.txt
├─ run_poll.ps1
├─ run_poll.sh
├─ setup_mac.sh
├─ setup_windows.ps1
└─ worker.py
```

B 電腦用 VS Code 直接打開 `yourls_worker` 資料夾即可。`.env.local` 也放在 `yourls_worker` 資料夾裡，不要放回 buyads。

### 本機 Windows 測試 worker

第一次設定：

```powershell
cd C:\Users\user\Downloads\yourls_worker
.\setup_windows.ps1
```

平常執行：

```powershell
cd C:\Users\user\Downloads\yourls_worker
.\run_poll.ps1 -PollSeconds 15
```

如果要手動登入 Yourls：

```powershell
.\run_poll.ps1 -PollSeconds 15 -ManualLogin
```

### B 電腦 mac 執行 worker

第一次設定：

```bash
cd ~/Downloads/yourls_worker
bash setup_mac.sh
```

然後打開 `.env.local`，填入必要環境變數：

```text
SHEETS_WEBAPP_URL=https://script.google.com/macros/s/.../exec
SHEETS_TOKEN=你的 Apps Script token
YOURLS_BASE_URL=https://yourls-admin.iavnight.com/admin
```

如果要由 worker 自動登入 Yourls，取消註解並填值：

```text
# YOURLS_USERNAME=user01
# YOURLS_PASSWORD=你的 Yourls 密碼
```

`.env.local` 不會進 git。B 電腦打開 `yourls_worker` 時，也是在這個資料夾裡放自己的 `.env.local`。

填好 `.env.local` 後，自動登入版執行：

```bash
bash run_poll.sh
```

手動登入版執行：

```bash
MANUAL_LOGIN=1 bash run_poll.sh
```

## 1. 背景與目標

目前痛點是：buyads 算出新增廣告或權重調整後，仍要人工到 Yourls 縮網址後台重新開渠道或修改權重。

目標改成：

1. buyads 建立待辦，但不直接把它當成已完成。
2. 使用者在待辦按「批准」。
3. 系統自動到 Yourls 後台執行對應動作。
4. 執行完後重新讀 Yourls 後台驗證。
5. 驗證成功才回報已完成；失敗則保留待處理並顯示原因。
6. 每次批准、執行、成功、失敗都記錄在 Google Sheets。

重要概念：**批准不是完成**。批准只是授權 worker 去 Yourls 執行；完成必須由 worker 執行後驗證結果決定。

## 2. 最終架構決策

採用 **Google Sheets 佇列 + B 電腦 Pull Worker + Playwright 爬蟲**。

| 元件 | 責任 |
|---|---|
| buyads 前端 | 建立待辦、判斷是否可送 Yourls、顯示「批准」、寫入操作佇列、讀回結果 |
| Google Sheets / Apps Script | 作為操作佇列、執行紀錄、狀態回報的共享資料層 |
| B 電腦 Pull Worker | 在有 Yourls IP 權限的專用電腦上執行，定期讀取待執行佇列，登入 Yourls 後台執行，再寫回結果 |
| Yourls 後台 | 實際建立縮網址渠道、修改縮網址權重 |

不採用直接從 buyads 呼叫 Yourls。buyads 是前端 app，不適合保存 Yourls 帳密，也不能穩定執行 Playwright。

不急著做 Yourls API。API 長期比較標準，但短期要改後台或部署服務；目前用 Playwright 操作後台比較快，且已有 `mkt` 專案可參考登入與頁面解析經驗。

因為 Yourls 後台有 IP 限制，Railway 這類雲端 worker 只有在 Yourls 願意白名單固定出口 IP 時才適合。第一版以 B 電腦執行為主，讓所有 Yourls 請求都從已授權網路出去。

## 3. 背景執行方式

### 3.1 主方案：B 電腦 Pull Worker

B 電腦是一台專門可以執行這件事情的電腦，且所在網路可以開啟 Yourls 後台。它不需要被 A 電腦或外網直接呼叫；它只要主動向 Google Sheets / Apps Script 拉待辦佇列即可。

流程：

```text
A 電腦使用 buyads 按「批准」
→ buyads 寫入 YOURLS操作佇列
→ B 電腦 worker 定期讀取 queued action
→ B 電腦 claim action 成 running
→ B 電腦 Playwright 登入 Yourls 後台執行
→ worker 驗證 Yourls 結果
→ worker 寫回 applied / failed 與執行紀錄
→ buyads 下次 sync 顯示結果
```

這個方式的好處：

- 符合 Yourls IP 限制，請求從 B 電腦所在網路出去。
- B 電腦不用開外網入口、不用 port forwarding、不暴露本機 HTTP service。
- A 電腦按批准後不用等待，可以繼續操作 buyads。
- B 電腦 worker 可以常駐，也可以每分鐘排程跑一次。
- 若 worker 當下沒開，佇列仍留在 Sheets，之後再跑即可補套。

建議第一版用「每 30-60 秒輪詢一次」或「Windows 工作排程器每 1 分鐘跑一次」。若 worker 實作成常駐程式，要加單機鎖，避免同一台 B 電腦開兩份同時執行。

### 3.2 B 電腦 worker 執行方式

可選兩種：

| 方式 | 說明 | 建議 |
|---|---|---|
| 常駐 worker | Python 程式啟動後每 30-60 秒讀一次佇列 | 適合 B 電腦穩定開著 |
| 排程 worker | Windows 工作排程器每 1 分鐘啟動一次，處理完就退出 | 第一版更簡單，較不怕常駐程式掛死 |

第一版建議用排程 worker。每次啟動只處理少量 action，執行完退出；若上一輪還沒跑完，靠 lock/claim 避免重複處理。

### 3.3 備案：雲端固定出口 IP

如果未來 Yourls 可以把雲端固定 IP 加白名單，可以改用 Railway / VPS / EC2 等背景服務。

Railway 有 Static Outbound IP，但通常需要符合平台方案限制；且 Yourls 後台必須願意白名單該 IP。這是備案，不是第一版主路線。

### 3.4 備案：A 電腦當下觸發本機工具

因為操作 buyads 按「批准」的人當下網路一定可以開啟 Yourls，也可以做成 A 電腦本機 helper 或 browser extension。

但純 buyads 網頁不能跨站操作 Yourls DOM；若要由 A 電腦直接執行，必須另裝本機工具、browser extension 或 Tampermonkey script。這適合沒有 B 電腦常開的情境，不作為第一版。

### 3.5 不需要 Chrome profile

這個 worker 不需要 `mkt` 專案那種 Chrome profile。

`mkt` 需要 Chrome profile，是因為它是本機資料抓取工具，會借用已登入的瀏覽器狀態，並把抓到的資料寫入 Google Sheets。

這次的 Yourls worker 是正式後台自動化服務，應改成：

- Yourls 登入帳密放在 B 電腦的本機設定檔或環境變數。
- Playwright 每次 headless 開瀏覽器，自動填 Yourls 登入表單。
- Google Sheets 讀寫用 Apps Script URL/token 或 service account。
- 不依賴使用者日常 Chrome profile、cookie 複製、`token.pickle`、人工選 profile。

若未來想減少每次登入，可以讓 worker 保存 Playwright `storage_state.json`；但第一版建議每次乾淨登入，穩定且好除錯。

### 3.6 B 電腦 worker 設定

```text
YOURLS_BASE_URL=https://yourls-admin.example.com/admin
YOURLS_USERNAME=...
YOURLS_PASSWORD=...
SHEETS_WEBAPP_URL=https://script.google.com/macros/s/.../exec
SHEETS_TOKEN=...
WORKER_ID=office-b-yourls-worker
DRY_RUN=1
```

| 變數 | 說明 |
|---|---|
| `YOURLS_BASE_URL` | Yourls 後台網址 |
| `YOURLS_USERNAME` | Yourls 後台帳號 |
| `YOURLS_PASSWORD` | Yourls 後台密碼 |
| `SHEETS_WEBAPP_URL` | buyads 目前使用的 Apps Script Web App URL |
| `SHEETS_TOKEN` | Apps Script token |
| `WORKER_ID` | worker 識別，例如 `office-b-yourls-worker` |
| `DRY_RUN` | `1` 時只解析與驗證，不送出表單 |

可選：

| 變數 | 說明 |
|---|---|
| `WORKER_POLL_SECONDS` | 常駐模式輪詢秒數，預設 60 |
| `WORKER_MAX_ACTIONS_PER_RUN` | 每次最多處理幾筆，預設 5 |
| `PLAYWRIGHT_HEADLESS` | `1` 背景執行，`0` 顯示瀏覽器方便除錯 |
| `STORAGE_STATE_PATH` | 若要保存 Playwright 登入狀態才需要 |

## 4. 觸發條件與待辦流程

### 4.1 哪些待辦要進 Yourls

只有符合下列條件的待辦才顯示「批准」並寫入 Yourls 操作佇列：

| 場景 | 條件 | Yourls 動作 | 執行時機 |
|---|---|---|---|
| 新增廣告 | `action_type = 新增廣告`，且採用連結 slot 是 `L1`，且有 `short_url_param` | 新增渠道 | 按「批准」後即可執行 |
| 手動改權重 | `action_type = 手動改權重`，且該廣告是 `L1`，且有 `short_url_param` | 修改權重 | 到 `effective_date` 當天才開始執行 |
| 成效調權重 | `action_type = 成效調權重`，且涉及廣告有 `L1 + short_url_param` | 修改權重 | 到 `effective_date` 當天才開始執行 |
| 補花費缺口 | 若本質也是權重調整，且涉及廣告有 `L1 + short_url_param` | 修改權重 | 按「批准」後即可執行 |

非 Yourls 類待辦可以保留原本的手動完成邏輯，或顯示成「標記完成」。不要讓沒有機器 payload 的待辦按「批准」。

### 4.2 按鈕語意

原本待辦的「完成」按鈕，在 Yourls-actionable 的項目上改為「批准」。

按「批准」後：

1. buyads 產生 `yourls_action` 結構化 payload。
2. 寫入 `YOURLS操作佇列`。
3. todo 顯示狀態改成「已批准，等待 Yourls 套用」。
4. 不進已完成區。

執行時機由 `payload_json.action_type` 決定：`手動改權重`、`成效調權重` 會留在 queued，等台北日期到 `effective_date` 當天才提供給 worker；`新增廣告`、`補花費缺口` 則按批准後就能被 worker 拉走。

worker 回報 `applied` 後：

1. buyads 下次 sync 讀回結果。
2. 對應 todo 才改成 `done`。
3. 已完成區顯示 applied 時間與 action id。

worker 回報 `failed` 後：

1. todo 保持 pending。
2. 顯示錯誤訊息。
3. 提供「重發」或「重新批准」按鈕，重新產生一個新的 `action_id`。

## 5. 資料模型

### 5.1 buyads todo 內部結構

目前待辦主要是人看的 `description`，不能讓 worker 從中文描述反解析。要新增機器可讀欄位。

建議 todo 加：

```json
{
  "yourls_action": {
    "action_id": "yourls_2026-06-05_001",
    "kind": "create_channel",
    "short_url_param": "dhst291",
    "source_ad_code": "st291",
    "ad_name": "廣告名稱",
    "effective_at": "2026-06-05",
    "weights": {
      "AV9": 66,
      "PJ8": 24,
      "OJI": 4,
      "XRK": 6
    },
    "status": "queued"
  }
}
```

`description` 仍保留給人看；`yourls_action` 才是 worker 執行依據。

### 5.2 Google Sheets 分頁 `YOURLS操作佇列`

一個 action 一列。這比舊版「同一 change_id 多列產品權重」更適合 worker 做鎖定、重試與回報。

| 欄位 | 範例 | 說明 |
|---|---|---|
| `action_id` | `yourls_2026-06-05_001` | 全域唯一，冪等 key |
| `todo_id` | `todo_xxx` | 對應 buyads 待辦 |
| `created_at` | `2026-06-05 14:23:01` | buyads 建立時間 |
| `approved_at` | `2026-06-05 14:25:10` | 使用者按批准時間 |
| `status` | `queued` / `running` / `applied` / `failed` | worker 狀態 |
| `kind` | `create_channel` / `update_weights` | Yourls 動作 |
| `short_url_param` | `dhst291` | Yourls 縮網址名稱 |
| `source_ad_code` | `st291` | buyads 廣告代碼 |
| `ad_name` | `廣告名稱` | 人眼辨識 |
| `effective_at` | `2026-06-05` | 生效日，精度到天 |
| `weight_summary` | `AV9 66 / PJ8 24 / OJI 4 / XRK 6` | 人眼快速檢查 |
| `payload_json` | `{...}` | worker 執行依據 |
| `attempt_count` | `1` | 重試次數 |
| `locked_at` | `2026-06-05 14:30:00` | worker claim 時間 |
| `worker_id` | `office-b-yourls-worker` | 哪個 worker 執行 |
| `applied_at` | `2026-06-05 14:31:10` | 成功套用時間 |
| `last_error` | `shorturl dhst999 not found` | 失敗原因 |

`payload_json` 建議格式：

```json
{
  "kind": "update_weights",
  "short_url_param": "dhst291",
  "source_ad_code": "st291",
  "effective_at": "2026-06-05",
  "weights": [
    { "product_id": "AV9", "product_name": "愛威奶", "weight_pct": 66 },
    { "product_id": "PJ8", "product_name": "破解吧", "weight_pct": 24 },
    { "product_id": "OJI", "product_name": "萬精游", "weight_pct": 4 },
    { "product_id": "XRK", "product_name": "色軟庫", "weight_pct": 6 }
  ]
}
```

### 5.3 Google Sheets 分頁 `YOURLS執行紀錄`

每次 worker 嘗試都新增一列，不覆蓋。這張表是稽核紀錄。

| 欄位 | 範例 | 說明 |
|---|---|---|
| `log_id` | `log_2026-06-05_143000_abc` | 紀錄唯一 ID |
| `action_id` | `yourls_2026-06-05_001` | 對應佇列 |
| `at` | `2026-06-05 14:31:10` | 紀錄時間 |
| `status` | `applied` / `failed` / `dry_run_ok` | 嘗試結果 |
| `kind` | `create_channel` / `update_weights` | 動作類型 |
| `short_url_param` | `dhst291` | 目標縮網址 |
| `before_json` | `{...}` | 執行前 Yourls 讀到的狀態 |
| `after_json` | `{...}` | 執行後 Yourls 讀到的狀態 |
| `operations_json` | `[{ "op": "create_weight", ... }]` | 實際規劃或執行的 create/edit 動作 |
| `error_msg` | `product OJI not found` | 失敗原因 |
| `worker_id` | `office-b-yourls-worker` | 執行者 |
| `dry_run` | `Y` / 空 | 是否 dry-run |

## 6. 權重規則

Yourls 送出的權重必須是整數，且同一個 `short_url_param` 加總必須等於 100。

buyads 內部可以保留小數權重；送 Yourls 前使用 Largest Remainder / Hamilton method 整數化。

範例：

```text
input:  AV9 61.82, PJ8 22.72, OJI 4.18, XRK 11.28
floor:  AV9 61,    PJ8 22,    OJI 4,    XRK 11    sum = 98
補差:   小數最大 AV9、PJ8 各 +1
output: AV9 62,    PJ8 23,    OJI 4,    XRK 11    sum = 100
```

邊界規則：

- 權重為 0 的產品不寫入 payload。
- 整數化後仍為 0 的產品不寫入 payload。
- 若只剩一個產品，直接送 100。
- 若加總不是 100，buyads 不允許批准，worker 也必須拒絕執行。
- Yourls 端套用視為 replace，不是 increment；payload 沒列出的產品在 Yourls 應歸 0。

## 7. 產品代碼對齊

Yourls worker 送出前必須把 buyads product id 轉成 Yourls 使用的 product id。

| buyads ID | Yourls ID | 備註 |
|---|---|---|
| `AV9` | `AV9` | 同名 |
| `av9_poquan` | `AV9-破圈` | 破圈產品 |
| `JK` | `JK` | 同名 |
| `jk_poquan` | `JK-破圈` | 破圈產品 |
| `HYC` | `HYC` | 同名 |
| `PJ8` | `PJ8` | 同名 |
| `ZFB` | `ZFB` | 同名 |
| `OJI` | `OJI` | 同名 |
| `MYS` | `MYS` | 同名 |
| `XRK` | `XRK` | 同名 |
| `BS` | `BS` | 同名 |

不要讓 worker 用 `product_name` 做 lookup；`product_name` 只給人眼閱讀。

## 8. B 電腦 Yourls worker 執行流程

### 8.1 主流程

1. B 電腦 worker 啟動。啟動方式可以是常駐輪詢，也可以是 Windows 工作排程器定期啟動。
2. worker 呼叫 Apps Script 讀 `YOURLS操作佇列`。
3. 找出 `status = queued` 且已可執行的 action，依 `approved_at` 由舊到新排序。`手動改權重`、`成效調權重` 未到 `effective_date` 前不會被列出。
4. 透過 Apps Script claim action：`queued -> running`，寫入 `locked_at`、`worker_id`、`attempt_count`。
5. claim 成功才繼續；claim 失敗代表已被其他 worker 拿走，直接跳過。
6. worker 用 B 電腦網路登入 Yourls。
7. 依 `kind` 執行：
   - `create_channel`：新增渠道。
   - `update_weights`：找到既有 `short_url_param` 後 replace 權重。
8. 執行後重新讀 Yourls 頁面，組出 `after_json`。
9. 比對 `after_json` 是否等於 payload 目標狀態。
10. 寫入 `YOURLS執行紀錄`。
11. 更新 `YOURLS操作佇列.status` 為 `applied` 或 `failed`。
12. 若是排程模式，程式退出；若是常駐模式，等待下一輪輪詢。

### 8.2 表單操作策略

優先順序：

1. 登入後抓取頁面上的 CSRF token / hidden inputs。
2. 用 Playwright 或 HTTP request 送後台表單 POST。
3. 若表單 route 或 token 太難解析，再退回 UI 點擊與填欄位。

不要只靠座標點擊。selector 應以欄位 name、label、table header、button text 為主。

### 8.3 冪等與重試

`action_id` 是冪等 key。

worker 看到已經是 `applied` 的 action 不再執行。若 action 是 `running` 但 `locked_at` 超過安全時間，例如 30 分鐘，可標為 `failed_timeout` 或重新排隊，這要在實作時明確決定。

若未來真的開多台 worker，仍然以 Apps Script 的 claim 動作作為唯一鎖。第一版只有 B 電腦一台 worker，也要保留 claim，避免使用者手動開兩份程式造成重複套用。

新增渠道時，如果 Yourls 已經存在同 `short_url_param`，第一版建議 fail，不要默默覆蓋。失敗訊息要清楚寫出「已存在」。

修改權重時，如果目前 Yourls 狀態已經等於 payload 目標狀態，可直接回報 `applied`，這是安全的冪等成功。

## 9. create_channel 與 update_weights

### 9.1 新增渠道 `create_channel`

觸發：新增廣告，採用連結為 `L1`，且有 `short_url_param`。

Yourls 動作分成兩段：先新增縮網址名稱，再逐產品建立權重設定。

#### 9.1.1 建立縮網址

入口：

```text
https://yourls-admin.iavnight.com/admin/shorturls/create
```

操作：

1. 檢查 `short_url_param` 是否已存在。
2. 若已存在，回報 failed，除非未來明確支援 upsert。
3. 開啟 `shorturls/create`。
4. 將 buyads 的 `short_url_param` 填入 Yourls 欄位「縮網址名稱」。
5. 按「提交」。
6. 重新讀取或搜尋 Yourls 縮網址，確認該 `short_url_param` 已建立。

#### 9.1.2 建立初始權重

入口：

```text
https://yourls-admin.iavnight.com/admin/shorturl-setting/create
```

Yourls 的權重設定是一個產品一筆資料，因此 target weights 有幾個正權重產品，就要送幾次 create。

範例：

```text
short_url_param = dhst999
target weights = AV9 10%, JK 50%, HYC 40%
```

worker 依序執行：

1. 到 `shorturl-setting/create`，縮網址名稱填 `dhst999`，產品名稱選 `AV9`，權重填 `10`，按「提交」。
2. 再到 `shorturl-setting/create`，縮網址名稱填 `dhst999`，產品名稱選 `JK`，權重填 `50`，按「提交」。
3. 再到 `shorturl-setting/create`，縮網址名稱填 `dhst999`，產品名稱選 `HYC`，權重填 `40`，按「提交」。

規則：

- 只為 `weight_pct > 0` 的產品建立設定。
- 產品名稱選單使用映射後的 Yourls 產品代碼，例如 `AV9`、`JK`、`HYC`。
- 若產品選單找不到該代碼，整個 action 回報 failed。
- 每送出一筆後，worker 應確認沒有表單錯誤再繼續下一筆。
- 全部建立完後，到 `shorturl-setting` 列表搜尋該 `short_url_param`，確認每個產品的權重都正確，且正權重加總為 100。

create_channel 完成標準：

- `shorturls` 已存在該縮網址名稱。
- `shorturl-setting` 中該縮網址名稱的正權重產品與 payload 一致。
- 權重整數加總 = 100。

### 9.2 既有廣告調整權重 `update_weights`

觸發：手動改權重、成效調權重、補花費缺口等，且廣告是 `L1 + short_url_param`。

入口：

```text
https://yourls-admin.iavnight.com/admin/shorturl-setting
```

查詢方式：

1. 進入 `shorturl-setting` 列表。
2. 在篩選區的「縮網址名稱」欄位輸入該廣告的 `short_url_param`，例如 `dhst292`。
3. 按「搜索」。
4. 讀取列表中該縮網址名稱目前所有產品權重。

範例目前狀態：

```text
dhst292:
JK 15%
HYC 31%
PJ8 30%
ZFB 6%
XRK 9%
BS 9%
```

目前權重讀取規則：

- 以列表中的「產品名稱」作為 product key。
- 以列表中的「權重」作為 current weight。
- 沒出現在列表中的產品視為目前 0%。
- 列表中出現但 payload 沒列出的產品，target 視為 0%。

### 9.2.1 計算操作差異

worker 先把目前狀態與 target payload 做 diff：

| 狀況 | 操作 |
|---|---|
| target > 0，且目前沒有該產品列 | 走 `shorturl-setting/create` 新增一列 |
| target > 0，且目前有該產品列，但權重不同 | 進該列「操作 > 編輯」修改權重 |
| target = 0，且目前有該產品列 | 進該列「操作 > 編輯」把權重改成 0 |
| target = 0，且目前沒有該產品列 | 不需動作 |
| target = current | 不需動作 |

重要順序：

1. **先新增所有 0% → 正權重的產品列**。
2. 再編輯既有產品列，包括調高、調低、改成 0。
3. 最後重新搜尋與驗證。

這個順序是為了符合既有操作習慣。例：JK 要從 15% 變 0%，同時新增 AV9 15%，應先 create `AV9 15%`，再 edit `JK 0%`。

### 9.2.2 新增原本 0% 的產品權重

入口：

```text
https://yourls-admin.iavnight.com/admin/shorturl-setting/create
```

操作：

1. 縮網址名稱填 `short_url_param`。
2. 產品名稱選 target product，例如 `AV9`。
3. 權重填 target weight，例如 `15`。
4. 按「提交」。
5. 若 target 有多個原本 0% 的新產品，逐一重複以上動作。

### 9.2.3 編輯既有產品權重

入口：

```text
https://yourls-admin.iavnight.com/admin/shorturl-setting
```

操作：

1. 搜尋 `short_url_param`。
2. 找到要修改的產品那一列。
3. 點該列「操作 > 編輯」。
4. 進入編輯頁後，保留縮網址名稱與產品名稱。
5. 將「權重」改成 target weight。若 target 是 0，就填 `0`。
6. 按「提交」。
7. 返回列表後繼續處理下一筆。

### 9.2.4 驗證規則

所有 create/edit 動作完成後，worker 必須回到：

```text
https://yourls-admin.iavnight.com/admin/shorturl-setting
```

再次用「縮網址名稱」搜尋 `short_url_param`，讀取列表後驗證：

- payload 中 `weight_pct > 0` 的產品，在 Yourls 中必須存在且權重相同。
- payload 中未列出或 target = 0 的產品，若 Yourls 還有該列，權重必須是 0；若沒有該列也視為 0。
- 正權重加總必須等於 100。
- 驗證成功才回報 `applied`。
- 驗證失敗回報 `failed`，並把 before/after 狀態寫進 `YOURLS執行紀錄`。

### 9.2.5 update_weights 範例

目前：

```text
dhst292:
JK 15
HYC 31
PJ8 30
ZFB 6
XRK 9
BS 9
```

目標：

```text
dhst292:
AV9 15
HYC 31
PJ8 30
ZFB 6
XRK 9
BS 9
JK 0
```

worker 操作：

1. 到 `shorturl-setting/create` 新增 `dhst292 / AV9 / 15`。
2. 回到 `shorturl-setting` 搜尋 `dhst292`。
3. 找到 `JK` 那列，點「操作 > 編輯」。
4. 將權重從 `15` 改成 `0`，按「提交」。
5. 重新搜尋 `dhst292`，確認正權重是 AV9 15、HYC 31、PJ8 30、ZFB 6、XRK 9、BS 9，JK 為 0 或不計入正權重。

## 10. buyads 實作切點

### 10.1 待辦建立時要保存 payload

目前待辦描述是人看的，例如「請至連結後台調整權重」。之後要在建立待辦時同時保存機器可讀 payload。

相關來源：

- 新增廣告：`app/views/ads.js`
- 手動改權重：`app/views/ads.js`
- 成效調權重：`app/views/perf-adjust.js`
- 補花費缺口：`app/views/gift-day-fix-modal.js`
- 待辦顯示與按鈕：`app/views/todos.js`
- Sheets 同步：`app/io/sync-specs.js`、`apps-script/Code.gs`

### 10.2 待辦狀態建議

todo 內部可以保留 `pending/done`，另加 `yourls_status` 表示後台執行狀態。

| todo.status | yourls_status | 顯示 |
|---|---|---|
| `pending` | 空 | 一般待辦 |
| `pending` | `queued` | 已批准，等待 Yourls |
| `pending` | `running` | Yourls 執行中 |
| `done` | `applied` | 已完成 |
| `pending` | `failed` | 失敗，可重發 |

這樣不會把「已批准但未執行」誤算成完成。

## 11. Google Sheets / Apps Script

建議不要讓 B 電腦 worker 直接用 `gspread + OAuth token.pickle`。

第一版最順的做法是擴充 buyads 既有 Apps Script：

- `yourlsListQueuedActions`
- `yourlsClaimAction`
- `yourlsReportActionResult`
- `yourlsAppendExecutionLog`

Apps Script 裡用同一個 SECRET token 驗證 B 電腦 worker。這樣 worker 只需要打 Apps Script，不需要處理 Google OAuth。

如果之後覺得 Apps Script 太慢或功能太繞，再改 service account 直連 Google Sheets。

## 12. 風險與防呆

| 風險 | 處理方式 |
|---|---|
| Yourls 有 captcha / 2FA | Playwright worker 會卡住，需先確認後台沒有這些機制 |
| Yourls 有 IP 白名單 | 第一版讓 B 電腦 worker 從已授權網路執行；Railway 固定 IP 只作為備案 |
| B 電腦沒有開機或 worker 沒跑 | action 留在 queued，buyads 顯示待本機套用；加監控提醒超過 N 小時未處理 |
| B 電腦同時開兩份 worker | Apps Script claim action 作為鎖；claim 失敗的 worker 直接跳過 |
| Yourls 表單欄位改版 | worker selector 要集中封裝，失敗時截圖與寫清楚錯誤 |
| 同一 action 重跑 | 用 `action_id` 做冪等，applied 不重跑 |
| 同一 short_url 同日多次調整 | 依 `approved_at` 順序執行，後者覆蓋前者 |
| 權重加總不是 100 | buyads 不准批准，worker 再驗一次 |
| 產品 mapping 錯誤 | worker fail，不 partial apply |
| Yourls 操作成功但回報失敗 | worker 下次重跑時先讀 Yourls 狀態，若已符合目標就補回 applied |
| 新增渠道撞名 | 第一版 fail，不自動覆蓋 |

## 13. 開發階段

| 階段 | 內容 | 完成標準 |
|---|---|---|
| 0. 對齊表單 | 依本文件的 Yourls 路徑與截圖，實測表單 selector / hidden input / 送出後回應 | 確認縮網址建立、權重 create、權重 edit 三條路徑都能被 Playwright 操作 |
| 1. buyads payload | 待辦新增 `yourls_action`，批准後寫 `YOURLS操作佇列` | Sheets 佇列資料完整，權重整數且 sum=100 |
| 2. B 電腦 worker dry-run | B 電腦跑 worker，只登入、搜尋、計算操作計畫，不送出 | `YOURLS執行紀錄` 寫 `dry_run_ok`，且列出將 create/edit 哪些列 |
| 3. update_weights 真套 | 支援既有廣告調權重：新增 0→正權重列、編輯既有列、改 0 | 執行後能讀回驗證，buyads 顯示 applied |
| 4. create_channel 真套 | 支援新增 L1 渠道：先 `shorturls/create`，再逐產品 `shorturl-setting/create` | 撞名、缺欄位、成功建立都有明確回報 |
| 5. 失敗重發 | failed todo 可重新批准，產生新 action_id | 重試不污染舊紀錄 |
| 6. 監控 | 超過 N 小時未 applied 的 action 顯示警告 | 能發現 worker 或 Yourls 異常 |

## 14. MVP 建議

第一版先做：

1. buyads 針對 `L1 + short_url_param` 的新增廣告與權重調整產生 Yourls payload。
2. 待辦按「批准」後寫 `YOURLS操作佇列`。
3. B 電腦 worker dry-run，能列出新增縮網址、逐產品新增權重、既有權重 create/edit 的操作計畫。
4. dry-run 確認後，先開 `update_weights` 真實套用。
5. `update_weights` 穩定後，再開 `create_channel` 真實套用。

先不要做：

- 多 short_url 同一 action。
- 歷史版本回滾。
- storage_state 持久化。
- webhook 即時觸發。
- Railway / 雲端固定 IP 部署。

## 15. 接下來實作安排

Yourls 後台對 `create_channel` 與 `update_weights` 的操作流程已整理在第 9 章。接下來依下列順序實作。

### 15.1 buyads 端

1. 新增 `yourls_action` payload builder。
2. 建立 `normalizeWeightsForYourls`，保證整數且 sum=100。
3. 待辦頁判斷哪些項目可「批准」。
4. 「批准」寫入 `YOURLS操作佇列`，todo 顯示 queued。
5. 同步讀回 `YOURLS操作佇列` / `YOURLS執行紀錄`，更新 todo 顯示狀態。
6. failed 狀態提供重新批准，產生新 `action_id`。

### 15.2 Apps Script / Sheets

1. 新增或擴充 `YOURLS操作佇列` 分頁。
2. 新增 `YOURLS執行紀錄` 分頁。
3. 實作 `yourlsListQueuedActions`。
4. 實作 `yourlsClaimAction`，必須用 lock 防止重複 claim。
5. 實作 `yourlsReportActionResult`。
6. 實作 `yourlsAppendExecutionLog`。

### 15.3 B 電腦 worker

1. 建立 `yourls_worker` Python 專案或工具資料夾。
2. Playwright 登入 Yourls。
3. 讀 queued action，claim 後 dry-run。
4. 實作 `read_current_weights(short_url_param)`。
5. 實作 `plan_update_weights(before, target)`，產出 create/edit 操作計畫。
6. 實作 `update_weights` dry-run。
7. 開啟 `update_weights` 真實提交與驗證。
8. 實作 `create_shorturl(short_url_param)` dry-run / 真套。
9. 實作 `create_weight_setting(short_url_param, product, weight)` dry-run / 真套。
10. 開啟 `create_channel` 真實提交與驗證。
11. 實作錯誤截圖、HTML snapshot、執行紀錄。

### 15.4 驗收順序

1. 手動建立一筆測試 queued action。
2. B 電腦 worker dry-run 能找到 Yourls 目標並寫 `dry_run_ok`。
3. 用一筆低風險 short_url 測 `update_weights` 真套。
4. buyads 能從 Sheets 讀回 applied 並把 todo 標成完成。
5. 測 failed：不存在 short_url、產品 mapping 錯誤、權重 sum 非 100。
6. 測重跑：已 applied 的 action 不會重複執行。

## 16. 參考文件

- Railway Build & Deploy: https://docs.railway.com/build-deploy
- Railway Cron Jobs: https://docs.railway.com/cron-jobs
- Railway Volumes: https://docs.railway.com/volumes
- Railway Static Outbound IPs: https://docs.railway.com/networking/static-outbound-ips
- Playwright Python Docker: https://playwright.dev/python/docs/docker
