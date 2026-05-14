// CPA schema:state 預設值與 entity 結構。
//
// 跟 CPT 不同的核心:
//   - 沒有「廣告」/「權重」概念,實體是「站長 / 線路 / 產品 / 打款 / 安裝數據」
//   - 主要計價走 RMB(站長對帳全程 RMB),TWD 只在內部報表用(RMB × 適用匯率)
//   - 匯率走 FIFO 消耗:每筆打款記錄該批次的固定匯率,花費計算依時間順序消耗較早批次

export const VERSION = 1;

// 安裝數據的原始欄位(對應匯入表格)
export const RAW_INSTALL_FIELDS = [
  "不重複安裝數",
  "廠商安裝",       // CPA 計費依此欄位
  "不重複活躍",
  "首儲訂單數",
  "首儲金額",
  "訂單加總數",
  "總金額",
  "所有排重安裝",
  "所有排重活躍",
];

// 線路狀態
export const CHANNEL_STATUSES = ["啟用中", "淘汰中", "已淘汰"];

// 結算模式(站長)
export const SETTLEMENT_MODES = ["prepaid", "postpaid"];  // 預付款 / 後結算

// 採用連結 slot(站長)— 同 CPT short_url_type
export const SHORT_URL_TYPES = ["L1", "L3", "L5", ""];
export const SHORT_URL_TYPE_LABEL = { L1: "權重", L3: "APK", L5: "小島", "": "不採用" };

// 淘汰模式(線路)
export const ELIMINATION_MODES = ["stop", "winding-down"];
// stop          → 明確停止合作,從淘汰隔天起不計費
// winding-down  → 已通知站長停止但對方還在處理,繼續計費但顯示淘汰標記

export function defaultState() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    version: VERSION,
    settings: {
      current_month: ym,
      expense_rate: 4.8,            // RMB → TWD 支出匯率(預設值;月匯率沒設才用此)
      income_rate: 4.6,             // TWD 收款匯率(預設值;月匯率沒設才用此)
      low_balance_threshold_rmb: 200,  // 站長餘額低於此值在概覽顯示警示
      sheets_webapp_url: "",
      sheets_token: "",
      short_url_new_domain: "",     // 全站當前新網域(縮網址頁)
      short_url_prefix_map: { L1: "l1", L3: "l3", L5: "l5" },  // slot → 實際前綴(同 CPT)
      monthly_rates: {},            // { "2026-05": { expense: 4.8, income: 4.6 }, ... }
    },
    products: [],          // [{ id, name, gsheet_field_code, short_url_code?, cpa_enabled, created_at }]
    publishers: [],        // [{ id, name, default_cpa_price_rmb, contact_info, settlement_mode,
                           //   short_url_type?(L1/L3/L5/""), created_at }]
    channels: [],          // [{ id, name(=渠道名稱), publisher_id, cpa_price_rmb?, status,
                           //   eliminated_at?, billing_end_date?, elimination_mode?,
                           //   confirmed_eliminated_at?, notes, created_at,
                           //   short_url_params?({product_id: param}),  // per-product 參數覆寫
                           //   short_url_old_override?, short_url_new_override?, short_url_notified? }]
    payments: [],          // [{ id, publisher_id, date, amount_rmb, exchange_rate,
                           //   remaining_rmb(FIFO 剩餘), notes, created_at }]
    install_data: [],      // [{ id(=date::channel_id::product_id), date, channel_id,
                           //   product_id, ...RAW_INSTALL_FIELDS }]
    custom_metrics: [],    // [{ id, name, formula, show_as_percent }] — 內部報表自訂欄目
    todos: [],             // 可選,沿用 CPT 待辦 pattern
  };
}

// 線路顏色:狀態映射(給列表 / 報表醒目標示用)
export function channelStatusColor(status) {
  if (status === "淘汰中") return "#ff9800";    // 橘
  if (status === "已淘汰") return "#d32f2f";    // 紅
  return "#4caf50";                              // 綠(啟用中)
}

// 取得指定月份的匯率(回 { expense, income });沒設月匯率時 fallback 全域預設
export function getRatesForMonth(settings, yearMonth) {
  const monthly = settings?.monthly_rates?.[yearMonth];
  return {
    expense: Number(monthly?.expense ?? settings?.expense_rate ?? 4.8),
    income: Number(monthly?.income ?? settings?.income_rate ?? 4.6),
  };
}
