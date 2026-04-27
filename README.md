# 廣告投放管理

按產品、按廣告、按日攤提的靜態網頁應用。完整規格見 [CLAUDE.md](CLAUDE.md)。

## 檔案結構

```
buyads/
├── CLAUDE.md            # 規格文件（決策都在這）
├── index.html           # 入口
├── README.md
├── app/
│   ├── styles.css       # 全部樣式
│   ├── main.js          # router / 入口
│   ├── state.js         # localStorage + pub/sub
│   ├── schema.js        # 預設資料、14 個成效變數
│   ├── lib/
│   │   ├── dates.js     # 日期工具（跨月切段）
│   │   ├── csv.js       # CSV 編碼、下載、挑檔
│   │   └── formula.js   # 安全公式計算
│   ├── domain/
│   │   ├── budget.js    # 帶寬與月結容差檢核
│   │   └── spending.js  # 每日花費聚合
│   ├── io/
│   │   └── sheets.js    # Apps Script 串接 client
│   └── views/
│       ├── dashboard.js # 概覽＋每日攤提表
│       ├── products.js  # 產品 CRUD＋成效目標
│       ├── ads.js       # 廣告 CRUD＋權重、CSV 匯入匯出
│       ├── todos.js     # 待辦清單
│       └── settings.js  # 匯率、月份、Sheets 同步、備份
└── apps-script/
    ├── Code.gs
    ├── appsscript.json
    └── README.md        # 部署步驟
```

## 啟動

需要本機靜態伺服器（ES modules 在 `file://` 無法載入）：

```bash
# 任一皆可
python -m http.server 8080
# 或 VSCode 安裝 Live Server 右鍵 index.html → Open with Live Server
# 或 npx serve .
```

開啟 `http://localhost:8080/`。

## 使用流程

1. **設定** 頁填當月、支出匯率、收入匯率 → 儲存。
2. **產品** 頁填各產品月預算；新增成效目標（名稱＋公式＋目標值＋方向）。
3. **廣告** 頁新增廣告（人民幣金額 × 當下匯率 → 台幣；攤提天數手動填），分配權重。
4. **概覽** 頁即時看每個產品當月攤提、帶寬狀態、每日攤提分布。
5. （選配）**設定** → 貼上 Apps Script Web App URL → 推上 Sheets 做雲端備份。部署見 [apps-script/README.md](apps-script/README.md)。

## 目前範圍（MVP）

已實作：
- 產品、廣告 CRUD
- 共購＋獨立採買（都用「一列一筆採買」表示）
- 續費（會帶入上一段的匯率預設值，使用者填新時段）
- 每日攤提 + 產品帶寬檢核（APP ±30% / 小島 ±0.5%）
- 每日攤提表底部月合計 + vs 預算差額
- **自動權重建議**（廣告編輯器內「🤖 依剩餘預算自動建議」）
- **儲存廣告時自動建立待辦**（含產品/權重說明，提醒去改連結分流）
- CSV 匯出/匯入（多列一廣告，每列一個產品權重）
- JSON 匯出/匯入、整份重設、拉回 Sheets 前自動備份 JSON
- Apps Script 雙向同步（通用 writeTable/readTable，SECRET 保護）
- **每週成效匯入**（Google Sheets「成效輸入」暫存分頁 → 📥 附加本週成效 → 驗證 → 預覽 → 合併去重）

尚未實作（CLAUDE.md 有規格但待下一輪）：
- 反向建議（給日期→建議採買哪幾個產品怎麼分）
- 成效驅動自動調權（資料已可匯入，下一步做調權演算法）
- 按產品分頁的 CSV 匯出（目前是扁平格式，為了 round-trip）
```

