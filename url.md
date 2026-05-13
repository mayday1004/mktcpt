# 縮網址後台串接構想（buyads ↔ Yourls）

> 草稿文件,實作前再跟對方工程師對齊。本文不包含程式碼,只定義架構、資料合約與責任邊界。

## 1. 背景

目前的痛點:**buyads 算出來的權重調整,人工要再到 Yourls 後台(縮網址後台)重新輸入一次**。

兩邊各自的角色:

| 系統 | 角色 |
|---|---|
| **buyads**(本專案) | 算成效、產出權重調整建議、決定最終要套用的權重 |
| **Yourls 後台** | 真正執行流量分配 — 縮網址參數(如 `dhst291`)後面接幾支廣告各拿幾%流量 |

目標:讓 buyads 確認權重調整時自動把結果送過去,Yourls 套完後回報狀態,buyads 自動把待辦改成「已套用」。

## 2. 架構選擇

| 方案 | 怎麼運作 | 優 | 缺 |
|---|---|---|---|
| **A. Google Sheets 當佇列** ✅ | buyads 確認 → 寫入「權重調整佇列」分頁;Yourls 輪詢分頁 → 套用 → 寫入「權重調整回報」分頁;buyads 下次 sync 看到回報就改 todo 狀態 | 零新基建、可人工 debug、Sheets 即合約 | 延遲 5–30 秒 |
| B. buyads 出 REST API | 跑一個 Cloudflare Worker / Node 服務接 Yourls 請求 | 即時、標準 | 要部署+維護 |
| C. Apps Script 當 API 中樞 | 擴充現有 Apps Script,加 `pendingWeightChanges` / `reportApplied` 動作 | 用既有基建 | Apps Script quota + 慢 |

**決定:採方案 A**。理由:每週一次的調整節奏,即時性不重要;雙邊都已會讀寫 Sheets;debug 友善;真要轉 REST 時 sheet 結構直接變 schema。

## 3. 資料合約

### 3.1 分頁 `權重調整佇列`(buyads 寫、Yourls 讀)

| 欄位 | 範例 | 說明 |
|---|---|---|
| `change_id` | `buyads_2026-05-13_001` | 同一筆調整的多 row 共用,Yourls 用此判定原子套用單位 |
| `created_at` | `2026-05-13 14:23:01` | buyads 寫入時間(台北時間) |
| `short_url_param` | `dhst291` | 對齊 Yourls 的「縮網址名稱」欄位 |
| `product_id` | `AV9` | 必須兩邊**同字串**(見 §6 產品代碼對齊) |
| `product_name` | `愛威奶` | 給人眼閱讀用,Yourls 端不依賴 |
| `new_weight_pct` | `66` | **整數 0–100**(見 §4 權重整數化規則) |
| `source_ad_code` | `st291` | buyads 端的廣告代碼,給 Yourls debug 用 |
| `effective_at` | `2026-05-13` | 生效日(精度到天) |
| `note` | `成效調整 / 補日花費缺口` | 來源類型,可選 |

**範例:dhst291 整組調整 4 個產品**

| change_id | created_at | short_url_param | product_id | product_name | new_weight_pct | source_ad_code | effective_at | note |
|---|---|---|---|---|---|---|---|---|
| buyads_2026-05-13_001 | 2026-05-13 14:23 | dhst291 | AV9 | 愛威奶 | 66 | st291 | 2026-05-13 | 成效調整 |
| buyads_2026-05-13_001 | 2026-05-13 14:23 | dhst291 | PJ8 | 破解吧 | 24 | st291 | 2026-05-13 | 成效調整 |
| buyads_2026-05-13_001 | 2026-05-13 14:23 | dhst291 | OJY | 萬精游 | 4 | st291 | 2026-05-13 | 成效調整 |
| buyads_2026-05-13_001 | 2026-05-13 14:23 | dhst291 | XRK | 色軟庫 | 6 | st291 | 2026-05-13 | 成效調整 |

(4 row 加總 = 100,同 change_id)

### 3.2 分頁 `權重調整回報`(Yourls 寫、buyads 讀)

| 欄位 | 範例 | 說明 |
|---|---|---|
| `change_id` | `buyads_2026-05-13_001` | 對應佇列分頁 |
| `applied_at` | `2026-05-13 14:25:10` | Yourls 套用時間 |
| `status` | `applied` / `failed` / `partial` | 套用結果 |
| `error_msg` | `shorturl_param "dhst999" not found` | 失敗時必填 |

buyads 端讀回:
- `applied` → 把對應 todo 標成「已套用」
- `failed` → todo 仍為 pending + 顯示錯誤訊息 + 提供「重發到 Yourls」按鈕(產生新 change_id)
- `partial` → todo 標成「部分套用」+ 顯示哪幾個 product 失敗

## 4. 權重整數化規則(buyads 端責任)

**硬規定:buyads 寫入佇列分頁的 `new_weight_pct` 一定是整數,且同 change_id 加總一定 = 100**。Yourls 端可以無腦套用,不做 normalize,不容忍 99 / 101。

### 4.1 內部 vs 外送的差別

| 階段 | 精度 | 為什麼 |
|---|---|---|
| buyads **內部計算** | 2 位小數允許(如 61.82 / 22.72 / 15.46) | 避免「APP 大、小島小」混選時整數四捨五入讓小島 weight 略高,造成 dailyShare 超過 upper(這是 `computeIntegerWeights(items, 2)` 的存在原因) |
| buyads **寫入佇列**(送 Yourls) | **必須整數,加總 = 100** | Yourls 的縮網址設定頁面只接受整數權重;且 1% 是最小分配單位 |

### 4.2 整數化演算法(Largest Remainder / Hamilton method)

Pseudo:
```
input:  { AV9: 61.82, PJ8: 22.72, OJY: 4.18, XRK: 11.28 }
                                            ^ 加總 = 100.00
step 1: floor each
        { AV9: 61, PJ8: 22, OJY: 4, XRK: 11 }  sum = 98, 差 2
step 2: 取小數部分,由大到小排序
        AV9: 0.82, PJ8: 0.72, XRK: 0.28, OJY: 0.18
step 3: 給前 2 名 +1
        AV9: 62, PJ8: 23, XRK: 11, OJY: 4
output: { AV9: 62, PJ8: 23, OJY: 4, XRK: 11 }  sum = 100 ✓
```

實作位置建議:新建 `app/lib/weight-export.js`,export `normalizeWeightsForYourls(weights: {pid: number}): {pid: int}`,簽名強制保證 `Object.values(out).reduce((a,b)=>a+b, 0) === 100`(寫 assertion)。

### 4.3 邊界處理

- **某產品 weight = 0** → 不寫進佇列(避免無意義 row)
- **整組權重 = 100% 集中在一個 product**(independent) → 寫 1 row,`new_weight_pct: 100`
- **某產品 weight 介於 0 < x < 0.5** → Hamilton 演算法會自然把它輪到 0 或 1,看其他 row 的小數分布。**結果若是 0 就不寫進佇列**
- **若整組 weight 整數化後找不到任何 row 拿 ≥ 1%**(極端情況,例如 0.4 + 0.4 + 0.2 共三個產品都 floor 為 0)→ 給最大的那筆 100,其餘略過(這個情況實務上不太會發生,但要 assert 不可寫出 sum ≠ 100)

## 5. 雙方工程師工作分工

### 5.1 buyads 端(我們)

1. **「確認套用」流程擴充**:現有 `成效調整權重` / `補日花費缺口` / `手動改權重` 三種 action_type 套用時,除了現有的 todo + undo_payload,額外把「最終套用的權重」normalize 後寫到 `權重調整佇列` 分頁
2. **change_id 生成**:格式 `buyads_{YYYY-MM-DD}_{seq}`(seq 從當日 001 開始,跨天歸 0)
3. **資料展開**:一筆 `st291` 改動 4 個產品 → 寫 4 row,共用 change_id
4. **回報輪詢**:既有 sync 流程順便拉 `權重調整回報` 分頁,依 change_id 對應更新 todo 的 status 顯示
5. **產品代碼映射表**:CLAUDE.md 加一節,buyads side product_id ↔ Yourls side product_id 對應(尤其破圈系列、OJI/OJY)
6. **「重發」按鈕**:失敗的 todo 顯示「↻ 重發到 Yourls」按鈕,點下去產生新 change_id 重寫一遍佇列
7. **`normalizeWeightsForYourls` 工具**:見 §4.2,加 assertion 防呆

### 5.2 Yourls 端(對方)

1. **輪詢 loop**:每 5–10 分鐘讀 `權重調整佇列` 分頁,挑出**新的** change_id(已處理的 change_id 記在 Yourls 自己的 DB)
2. **冪等性**:同 change_id 只套一次,重複出現直接跳過
3. **驗證**:套用前檢查 `short_url_param` 存在、`product_id` 存在於 Yourls 產品表、`new_weight_pct` 是 0–100 整數、同 change_id 加總 = 100(不滿足 → 整批拒套 + 寫 failed)
4. **套用 = replace**:同 short_url_param 整組權重視為一次性替換(不是 increment),Yourls 端**沒列出的產品自動歸 0**
5. **回報**:套用完寫 `權重調整回報` 分頁,含 applied_at 與 status
6. **錯誤訊息要清楚**:不要只回 `failed`,要寫「shorturl `dhst999` not found / product `OJI` not in Yourls catalog(did you mean OJY?)」這類人可讀訊息

## 6. 容易踩雷的點

### 6.1 產品代碼對齊(最重要)

| Yourls 後台顯示(截圖) | buyads 用的 ID |
|---|---|
| `AV9` | `AV9` |
| `JK` | `JK` |
| `AV9-破圈`(產品 ID 19) | `av9_poquan` |
| `JK-破圈`(若存在) | `jk_poquan` |
| `OJY` | `OJI`(buyads 端命名,實際對應 Yourls 的 OJY) ⚠️ |
| 其餘小島 | 同名 |

**處理方式(buyads 端)**:不要修內部代碼,在送出前用 `productIdToYourlsId(pid)` 統一轉換。對應表寫死在 buyads code 並同步維護在 CLAUDE.md。Yourls 端不需要做任何 mapping。

(備註:`OJI` 是 buyads 內部歷史代碼,Yourls 用 `OJY`,使用者已知這是命名不一致,未來會在 Yourls 端統一改為 `OJY`,屆時 buyads 端也可考慮 rename;**過渡期一律靠 buyads 的 mapping 表處理**)

### 6.2 其他容易踩雷

1. **總和 ≠ 100% 嚴禁**:buyads 必須保證 100,Yourls 收到非 100 直接 reject(寫 failed),不要 partial-apply
2. **批次原子性**:一個 change_id 的多 row 必須全套或全不套,中途某 product 無效 → 整批 fail + 詳細列出哪 row 有問題
3. **同日多次調整**:buyads 一天可能對同 `dhst291` 發兩次調整,Yourls 必須按 created_at 順序處理,後者覆蓋前者(不可亂序套)
4. **時鐘漂移**:`effective_at` 用 `YYYY-MM-DD` 不含時間,避免兩邊時鐘對不上
5. **產品名稱欄位是輔助**:Yourls 端**只依賴 product_id 比對**,不要用 product_name 做 lookup(buyads 端的中文名可能跟 Yourls 不同)

## 7. 開發階段建議

| 階段 | 內容 | 完成標準 |
|---|---|---|
| **0. 對齊文件** | 本文件 + 產品代碼對應表 雙方簽核 | 兩邊工程師都看過、無歧義 |
| **1. buyads 寫入(無回讀)** | buyads 確認套用時寫佇列分頁;**先不接收回報、不顯示狀態** | 跑兩週,觀察佇列分頁的資料是否乾淨、加總是否一律 100 |
| **2. Yourls dry-run** | Yourls 讀佇列、parse、log 出「我要套什麼」**但不真的套** | 對方確認:資料解析無誤、product_id 都對得起來 |
| **3. Yourls 真實套用 + 回報** | dry-run 通過後改成真套,寫回報分頁 | 第一週每筆人工驗證、無誤後切自動 |
| **4. buyads 讀回報** | buyads 拉回報分頁、自動改 todo 狀態、顯示錯誤訊息與「重發」按鈕 | end-to-end 流程跑通 |
| **5. 監控與健康度** | 加一個「未套用超過 N 小時」的待辦提醒 | 防止 Yourls 端 outage 沒人發現 |

## 8. 未來擴充(這版不做)

- **Webhook 通知**:佇列分頁不靠輪詢,buyads 寫入後 ping 一下 Yourls
- **歷史版本查詢**:Yourls 套用前自動把舊權重備份到 `權重套用歷史` 分頁,buyads 可以撤回到任一版
- **多 short_url 同時調整**:目前一個 change_id 對應一個 short_url_param,未來可考慮一個 change_id 跨多個 param(看 Yourls 端是否支援批次)
