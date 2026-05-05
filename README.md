# 廣告投放管理

按產品、按廣告、按日攤提的單頁網站應用（SPA）。完整業務規格見 [CLAUDE.md](CLAUDE.md)。

- **前端**：Vanilla JS（ES modules）+ localStorage，無框架
- **後端**：Google Sheets + Apps Script Web App（共享資料來源）
- **部署**：Docker（esbuild 打包 → JS 混淆 → Caddy 靜態伺服器），可一鍵部署到 Railway 等平台

---

## 檔案結構

```
buyads/
├── CLAUDE.md              # 業務規格（所有產品/預算/匯率/權重規則）
├── README.md
├── index.html             # 入口 HTML
├── app/                   # 前端原始碼（未混淆，工程師看這裡）
│   ├── main.js            # router / 啟動 / 全域 toast / modal / 復原
│   ├── state.js           # localStorage + pub/sub + undo stack
│   ├── schema.js          # 預設產品、14 個成效變數、月度匯率/預算解析
│   ├── styles.css
│   ├── lib/
│   │   ├── dates.js       # 台北時區日期、跨月切段
│   │   ├── csv.js         # CSV 編解碼、下載、挑檔
│   │   ├── formula.js     # 安全公式計算（成效目標）
│   │   ├── deploy-config.js   # 讀 build 期注入的 Sheets URL/Token
│   │   └── sync-banner.js     # 同步進度條 UI
│   ├── domain/
│   │   ├── budget.js      # 帶寬（APP ±30%、小島 ±0.5%）+ 月結容差
│   │   ├── spending.js    # 每日花費聚合、跨月切段
│   │   ├── lifecycle.js   # 廣告生命週期（續費/權重調整/送天數/轉移）
│   │   ├── alerts.js      # 即將到期、預算警示
│   │   ├── suggest.js     # 權重自動建議
│   │   ├── reverse.js     # 反向建議（先選日期再找廣告）
│   │   └── perf-adjust.js # 成效驅動調權
│   ├── io/
│   │   ├── sheets.js              # Apps Script Web App client
│   │   ├── sheets-schema.js       # 正規化分頁 schema + 模糊比對
│   │   └── performance-import.js  # 每週成效匯入流程
│   └── views/
│       ├── dashboard.js    # 概覽 + 每日攤提表
│       ├── products.js     # 產品 CRUD + 成效目標
│       ├── ads.js          # 廣告 CRUD + 權重 + CSV
│       ├── perf-adjust.js  # 成效驅動權重調整
│       ├── perf-report.js  # 成效報表
│       ├── perf-import-ui.js
│       ├── reverse.js      # 採買建議
│       ├── todos.js
│       └── settings.js     # 匯率、月份、Sheets 同步、匯出入
├── apps-script/           # Google Apps Script 後端（部署到 Sheets）
│   ├── Code.gs            # 通用 ping / writeTable / readTable
│   ├── appsscript.json
│   └── README.md          # 部署步驟
├── build.js               # 打包腳本（esbuild + 混淆）
├── package.json
├── Dockerfile             # 兩階段：node build → caddy serve
└── Caddyfile              # 靜態伺服器設定
```

> `node_modules/` 與 `dist/` 是 `npm install` / `npm run build` 自動產生的，已在 `.gitignore`。

---

## 本機開發

ES modules 在 `file://` 無法載入，需要靜態伺服器：

```bash
# 任一皆可
python -m http.server 8080
npx serve .
# 或 VSCode 裝 Live Server 右鍵 index.html → Open with Live Server
```

開啟 <http://localhost:8080/>。本機開發**不需要** `npm install`，直接讀 `app/` 原始碼。

---

## 打包與部署

### Build 流程（`npm run build`）

[build.js](build.js) 依序做：

1. `esbuild` 把 `app/main.js` 與所有 import 模組打成單一 IIFE（ES2020、minified）
2. `javascript-obfuscator` 混淆變數名稱、字串 base64 編碼，產出 `dist/app.js`
3. 把 `app/styles.css`、`apps-script/Code.gs` 複製到 `dist/`
4. 產出 `dist/index.html`，把 `<script type="module" src="app/main.js">` 改寫為 `<script src="app.js" defer>`
5. 把 build 期環境變數 `SHEETS_WEBAPP_URL` / `SHEETS_TOKEN` 編譯進 bundle（[lib/deploy-config.js](app/lib/deploy-config.js)）

```bash
# 純打包
SHEETS_WEBAPP_URL="https://script.google.com/macros/s/.../exec" \
SHEETS_TOKEN="your-secret" \
npm run build

# 打包 + 本機預覽
npm run preview
```

### Docker / Railway 部署

[Dockerfile](Dockerfile) 為兩階段：

- **Stage 1（build）**：`node:20-alpine`，安裝相依、跑 `npm run build`，產 `dist/`
- **Stage 2（runtime）**：`caddy:2-alpine`，把 `dist/` 複製進去後丟掉 Node

Railway 上設定環境變數 `SHEETS_WEBAPP_URL` / `SHEETS_TOKEN`，push 即自動 build & deploy。所有訪客自動共用同一份 Sheets。

---

## Google Sheets 後端

`app/io/sheets.js` 透過 multipart/form-data POST 呼叫 Apps Script Web App：

- `ping` — 測試連線
- `writeTable { sheetName, headers, rows }` — 清掉並覆寫指定分頁
- `readTable { sheetName }` — 讀回 `{headers, rows}`

每次請求都帶 `token`，後端比對 `Code.gs` 內硬寫的 `SECRET` 常數。

正規化分頁清單見 [CLAUDE.md §7.3](CLAUDE.md)；前端遍歷 schema 推 / 拉。

部署步驟見 [apps-script/README.md](apps-script/README.md)。

---

## 使用流程

1. **設定** → 填當月、支出匯率、收入匯率 → 儲存
2. **產品** → 各產品月預算 + 成效目標（名稱／公式／目標值／方向）
3. **廣告** → 新增廣告（人民幣 × 當下匯率 → 台幣自動換算；攤提天數手動填），分配權重
4. **概覽** → 即時看每產品當月攤提、帶寬狀態、每日攤提分布
5. **設定 → Google Sheets 同步** → ⬇️ 從 Sheets 拉資料 / ☁️ 推回 Sheets
6. **設定 → 成效輸入分頁** → 每週貼平台匯出資料 → 📥 附加本週成效 → 驗證預覽 → 合併

---

## 目前狀態

**已實作**

- 產品 / 廣告 CRUD（共購 + 獨立採買）
- 廣告生命週期：續費 / 權重調整 / 送天數 / 轉移 / 結束（關舊段、開新段、`renewal_of` 鏈）
- 每日攤提 + 帶寬檢核（APP ±30%、小島 ±0.5%、混合共購雙邊獨立檢核）
- 跨月攤提自動切段、月結容差（少花 ≤ 2 萬、超花 ≤ 1 萬）
- 自動權重建議（依剩餘預算 + 帶寬剩餘空間）
- 反向建議（給日期 → 建議買多少／怎麼分）
- 成效驅動調權預覽
- CSV 匯出 / 匯入、JSON 匯出 / 匯入、復原（Ctrl+Z）
- Google Sheets 雙向同步（通用 writeTable / readTable + SECRET）
- 每週成效匯入（Sheets「成效輸入」暫存分頁 → 驗證 → 預覽 → 合併去重）
- 即將到期 Todo、儲存廣告自動建 Todo（提醒改連結分流）
- 多月份月度匯率 / 月度預算覆寫
- 部署模式（Railway 變數注入 URL/Token，全使用者共用同一份資料）

**未實作 / 規劃中**

- 廣告詳情頁的時間軸視圖（多段一覽）
- 到期前自動產 Todo（目前是被動顯示，尚未自動建立）
- 報表單向推送（月度 / 每日花費 / 分組 / 攤提）
- 按產品分頁的 CSV 匯出（目前是扁平 round-trip 格式）
