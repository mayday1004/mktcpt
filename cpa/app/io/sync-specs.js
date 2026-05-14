// CPA 同步分頁定義。架構與 CPT app/io/sync-specs.js 相同
// (sheetName / dataHeaders / flatten / upsertInState / removeFromState / legacyParse)。
//
// 規則:
//   - dataHeaders 列在 sheet 上的順序;會多附 (站長名稱) / (渠道名稱) 等 derived 欄位讓人眼可讀,
//     apply 時忽略 derived 欄位(只用 ID 反查)
//   - 複合 _id 用 "::" 串接
//   - 各 spec 互不相依;upsertInState 不能假設「先有產品才有 install_data」
//     (sync 順序未必如此 — 用 ensureXxx 容錯)

import { RAW_INSTALL_FIELDS, CHANNEL_STATUSES, SETTLEMENT_MODES, ELIMINATION_MODES } from "../schema.js";

const numOr = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ===== Specs =====

export const TABLE_SYNC_SPECS = [
  // ── 1. 產品(_id = product.id) ──────────────────────────────────────
  {
    sheetName: "產品",
    dataHeaders: ["id", "名稱", "GSheets欄位代碼", "啟用CPA計費", "建立時間"],
    flatten: (s) => (s.products || []).map((p) => ({
      _id: p.id,
      dataRow: [
        p.id,
        p.name || "",
        p.gsheet_field_code || "",
        p.cpa_enabled ? "Y" : "",
        p.created_at || "",
      ],
    })),
    upsertInState(state, _id, obj) {
      state.products = state.products || [];
      const existing = state.products.find((x) => x.id === _id);
      const rec = {
        id: _id,
        name: String(obj["名稱"] || ""),
        gsheet_field_code: String(obj["GSheets欄位代碼"] || ""),
        cpa_enabled: String(obj["啟用CPA計費"] || "").toUpperCase() === "Y",
        created_at: String(obj["建立時間"] || existing?.created_at || ""),
      };
      if (existing) Object.assign(existing, rec);
      else state.products.push(rec);
    },
    removeFromState(state, _id) {
      state.products = (state.products || []).filter((p) => p.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iId = idx("id"), iName = idx("名稱"), iCode = idx("GSheets欄位代碼"),
            iEn = idx("啟用CPA計費"), iAt = idx("建立時間");
      return rows
        .map((r) => ({
          id: String(r[iId] || ""),
          name: String(r[iName] || ""),
          code: String(r[iCode] || ""),
          en: iEn >= 0 && String(r[iEn] || "").toUpperCase() === "Y" ? "Y" : "",
          at: String(r[iAt] || ""),
        }))
        .filter((p) => p.id)
        .map((p) => ({ _id: p.id, dataRow: [p.id, p.name, p.code, p.en, p.at] }));
    },
  },

  // ── 2. 站長(_id = publisher.id) ─────────────────────────────────────
  {
    sheetName: "站長",
    dataHeaders: ["id", "名稱", "預設CPA單價(RMB)", "聯絡方式", "結算模式", "建立時間"],
    flatten: (s) => (s.publishers || []).map((p) => ({
      _id: p.id,
      dataRow: [
        p.id,
        p.name || "",
        p.default_cpa_price_rmb ?? "",
        p.contact_info || "",
        p.settlement_mode || "prepaid",
        p.created_at || "",
      ],
    })),
    upsertInState(state, _id, obj) {
      state.publishers = state.publishers || [];
      const existing = state.publishers.find((x) => x.id === _id);
      const mode = String(obj["結算模式"] || "prepaid");
      const rec = {
        id: _id,
        name: String(obj["名稱"] || ""),
        default_cpa_price_rmb: numOr(obj["預設CPA單價(RMB)"]),
        contact_info: String(obj["聯絡方式"] || ""),
        settlement_mode: SETTLEMENT_MODES.includes(mode) ? mode : "prepaid",
        created_at: String(obj["建立時間"] || existing?.created_at || ""),
      };
      if (existing) Object.assign(existing, rec);
      else state.publishers.push(rec);
    },
    removeFromState(state, _id) {
      state.publishers = (state.publishers || []).filter((p) => p.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          id: String(r[idx("id")] || ""),
          name: String(r[idx("名稱")] || ""),
          price: numOr(r[idx("預設CPA單價(RMB)")]),
          contact: String(r[idx("聯絡方式")] || ""),
          mode: String(r[idx("結算模式")] || "prepaid"),
          at: String(r[idx("建立時間")] || ""),
        }))
        .filter((x) => x.id)
        .map((x) => ({ _id: x.id, dataRow: [x.id, x.name, x.price, x.contact, x.mode, x.at] }));
    },
  },

  // ── 3. 線路(_id = channel.id;含淘汰生命週期欄位) ──────────────────
  {
    sheetName: "線路",
    dataHeaders: [
      "id", "渠道名稱", "站長ID", "(站長名稱)", "個別CPA單價(RMB)",
      "狀態", "淘汰日期", "截止計費日期", "淘汰模式", "已確認淘汰日",
      "備註", "建立時間",
      "縮網址參數", "舊網域覆寫", "新網域覆寫", "縮網址已通知",
    ],
    flatten: (s) => {
      const pubName = Object.fromEntries((s.publishers || []).map((p) => [p.id, p.name]));
      return (s.channels || []).map((c) => ({
        _id: c.id,
        dataRow: [
          c.id,
          c.name || "",
          c.publisher_id || "",
          pubName[c.publisher_id] || "",
          c.cpa_price_rmb ?? "",
          c.status || "啟用中",
          c.eliminated_at || "",
          c.billing_end_date || "",
          c.elimination_mode || "",
          c.confirmed_eliminated_at || "",
          c.notes || "",
          c.created_at || "",
          c.short_url_param || "",
          c.short_url_old_override || "",
          c.short_url_new_override || "",
          c.short_url_notified ? "Y" : "",
        ],
      }));
    },
    upsertInState(state, _id, obj) {
      state.channels = state.channels || [];
      const existing = state.channels.find((x) => x.id === _id);
      const status = String(obj["狀態"] || "啟用中");
      const elimMode = String(obj["淘汰模式"] || "");
      const rec = {
        id: _id,
        name: String(obj["渠道名稱"] || ""),
        publisher_id: String(obj["站長ID"] || ""),
        cpa_price_rmb: obj["個別CPA單價(RMB)"] === "" || obj["個別CPA單價(RMB)"] == null
          ? null : numOr(obj["個別CPA單價(RMB)"]),
        status: CHANNEL_STATUSES.includes(status) ? status : "啟用中",
        eliminated_at: String(obj["淘汰日期"] || "").slice(0, 10) || "",
        billing_end_date: String(obj["截止計費日期"] || "").slice(0, 10) || "",
        elimination_mode: ELIMINATION_MODES.includes(elimMode) ? elimMode : "",
        confirmed_eliminated_at: String(obj["已確認淘汰日"] || "").slice(0, 10) || "",
        notes: String(obj["備註"] || ""),
        created_at: String(obj["建立時間"] || existing?.created_at || ""),
        short_url_param: String(obj["縮網址參數"] || ""),
        short_url_old_override: String(obj["舊網域覆寫"] || ""),
        short_url_new_override: String(obj["新網域覆寫"] || ""),
        short_url_notified: String(obj["縮網址已通知"] || "").toUpperCase() === "Y",
      };
      if (existing) Object.assign(existing, rec);
      else state.channels.push(rec);
    },
    removeFromState(state, _id) {
      state.channels = (state.channels || []).filter((c) => c.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => {
          const id = String(r[idx("id")] || "");
          if (!id) return null;
          return {
            _id: id,
            dataRow: [
              id,
              String(r[idx("渠道名稱")] || ""),
              String(r[idx("站長ID")] || ""),
              "",
              numOr(r[idx("個別CPA單價(RMB)")]),
              String(r[idx("狀態")] || "啟用中"),
              String(r[idx("淘汰日期")] || "").slice(0, 10),
              String(r[idx("截止計費日期")] || "").slice(0, 10),
              String(r[idx("淘汰模式")] || ""),
              String(r[idx("已確認淘汰日")] || "").slice(0, 10),
              String(r[idx("備註")] || ""),
              String(r[idx("建立時間")] || ""),
            ],
          };
        })
        .filter(Boolean);
    },
  },

  // ── 4. 打款記錄(_id = payment.id;FIFO 批次) ────────────────────────
  {
    sheetName: "打款記錄",
    dataHeaders: [
      "id", "站長ID", "(站長名稱)", "日期", "RMB金額", "匯率",
      "剩餘RMB", "備註", "建立時間",
    ],
    flatten: (s) => {
      const pubName = Object.fromEntries((s.publishers || []).map((p) => [p.id, p.name]));
      return (s.payments || []).map((p) => ({
        _id: p.id,
        dataRow: [
          p.id,
          p.publisher_id || "",
          pubName[p.publisher_id] || "",
          p.date || "",
          p.amount_rmb ?? 0,
          p.exchange_rate ?? 0,
          p.remaining_rmb ?? 0,
          p.notes || "",
          p.created_at || "",
        ],
      }));
    },
    upsertInState(state, _id, obj) {
      state.payments = state.payments || [];
      const existing = state.payments.find((x) => x.id === _id);
      const rec = {
        id: _id,
        publisher_id: String(obj["站長ID"] || ""),
        date: String(obj["日期"] || "").slice(0, 10),
        amount_rmb: numOr(obj["RMB金額"]),
        exchange_rate: numOr(obj["匯率"]),
        remaining_rmb: numOr(obj["剩餘RMB"]),
        notes: String(obj["備註"] || ""),
        created_at: String(obj["建立時間"] || existing?.created_at || ""),
      };
      if (existing) Object.assign(existing, rec);
      else state.payments.push(rec);
    },
    removeFromState(state, _id) {
      state.payments = (state.payments || []).filter((p) => p.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => {
          const id = String(r[idx("id")] || "");
          if (!id) return null;
          return {
            _id: id,
            dataRow: [
              id,
              String(r[idx("站長ID")] || ""),
              "",
              String(r[idx("日期")] || "").slice(0, 10),
              numOr(r[idx("RMB金額")]),
              numOr(r[idx("匯率")]),
              numOr(r[idx("剩餘RMB")]),
              String(r[idx("備註")] || ""),
              String(r[idx("建立時間")] || ""),
            ],
          };
        })
        .filter(Boolean);
    },
  },

  // ── 5. 安裝數據(_id = date::channel_id::product_id;9 個原始指標) ──
  {
    sheetName: "安裝數據",
    dataHeaders: [
      "日期", "渠道ID", "(渠道名稱)", "產品ID", "(產品名稱)",
      ...RAW_INSTALL_FIELDS,
    ],
    flatten: (s) => {
      const chName = Object.fromEntries((s.channels || []).map((c) => [c.id, c.name]));
      const prName = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      return (s.install_data || []).map((d) => ({
        _id: `${d.date}::${d.channel_id}::${d.product_id}`,
        dataRow: [
          d.date || "",
          d.channel_id || "",
          chName[d.channel_id] || "",
          d.product_id || "",
          prName[d.product_id] || "",
          ...RAW_INSTALL_FIELDS.map((f) => d[f] ?? 0),
        ],
      }));
    },
    upsertInState(state, _id, obj) {
      const [date, channel_id, product_id] = _id.split("::");
      if (!date || !channel_id || !product_id) return;
      state.install_data = state.install_data || [];
      const rec = {
        date,
        channel_id,
        product_id,
      };
      for (const f of RAW_INSTALL_FIELDS) {
        rec[f] = numOr(obj[f]);
      }
      const i = state.install_data.findIndex((d) =>
        d.date === date && d.channel_id === channel_id && d.product_id === product_id
      );
      if (i >= 0) state.install_data[i] = rec;
      else state.install_data.push(rec);
    },
    removeFromState(state, _id) {
      const [date, channel_id, product_id] = _id.split("::");
      state.install_data = (state.install_data || []).filter((d) =>
        !(d.date === date && d.channel_id === channel_id && d.product_id === product_id)
      );
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iDate = idx("日期"), iCh = idx("渠道ID"), iPr = idx("產品ID");
      return rows
        .map((r) => {
          const date = String(r[iDate] || "").slice(0, 10);
          const ch = String(r[iCh] || "");
          const pr = String(r[iPr] || "");
          if (!date || !ch || !pr) return null;
          const dataRow = [
            date, ch, "", pr, "",
            ...RAW_INSTALL_FIELDS.map((f) => numOr(r[idx(f)])),
          ];
          return { _id: `${date}::${ch}::${pr}`, dataRow };
        })
        .filter(Boolean);
    },
  },

  // ── 6. 自訂欄目(_id = custom_metric.id;內部報表用) ─────────────────
  {
    sheetName: "自訂欄目",
    dataHeaders: ["id", "名稱", "公式", "顯示百分比"],
    flatten: (s) => (s.custom_metrics || []).map((m) => ({
      _id: m.id,
      dataRow: [
        m.id,
        m.name || "",
        m.formula || "",
        m.show_as_percent ? "Y" : "",
      ],
    })),
    upsertInState(state, _id, obj) {
      state.custom_metrics = state.custom_metrics || [];
      const existing = state.custom_metrics.find((m) => m.id === _id);
      const rec = {
        id: _id,
        name: String(obj["名稱"] || ""),
        formula: String(obj["公式"] || ""),
        show_as_percent: String(obj["顯示百分比"] || "").toUpperCase() === "Y",
      };
      if (existing) Object.assign(existing, rec);
      else state.custom_metrics.push(rec);
    },
    removeFromState(state, _id) {
      state.custom_metrics = (state.custom_metrics || []).filter((m) => m.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          id: String(r[idx("id")] || ""),
          name: String(r[idx("名稱")] || ""),
          formula: String(r[idx("公式")] || ""),
          pct: String(r[idx("顯示百分比")] || ""),
        }))
        .filter((x) => x.id && x.name && x.formula)
        .map((x) => ({ _id: x.id, dataRow: [x.id, x.name, x.formula, x.pct] }));
    },
  },

  // ── 7. 設定(_id = key;只同步跨裝置共享的 key) ─────────────────────
  // 不同步:current_month(各客戶端跟系統時鐘走)、sheets_webapp_url、sheets_token(裝置相關)
  {
    sheetName: "設定",
    dataHeaders: ["key", "value"],
    flatten: (s) => {
      const settings = s.settings || {};
      const out = [];
      const push = (k, v) => out.push({ _id: k, dataRow: [k, String(v ?? "")] });
      push("expense_rate", settings.expense_rate ?? 4.8);
      push("income_rate", settings.income_rate ?? 4.6);
      push("low_balance_threshold_rmb", settings.low_balance_threshold_rmb ?? 200);
      push("short_url_new_domain", settings.short_url_new_domain ?? "");
      push("short_url_prefix", settings.short_url_prefix ?? "");
      return out;
    },
    upsertInState(state, _id, obj) {
      state.settings = state.settings || {};
      const v = obj["value"];
      if (_id === "expense_rate") state.settings.expense_rate = numOr(v, 4.8);
      else if (_id === "income_rate") state.settings.income_rate = numOr(v, 4.6);
      else if (_id === "low_balance_threshold_rmb") state.settings.low_balance_threshold_rmb = numOr(v, 200);
      else if (_id === "short_url_new_domain") state.settings.short_url_new_domain = String(v ?? "");
      else if (_id === "short_url_prefix") state.settings.short_url_prefix = String(v ?? "");
      // 忽略 current_month / sheets_webapp_url / sheets_token(這些不該從 server 套用)
    },
    removeFromState(state, _id) {
      if (!state.settings) return;
      if (_id === "expense_rate") state.settings.expense_rate = 4.8;
      else if (_id === "income_rate") state.settings.income_rate = 4.6;
      else if (_id === "low_balance_threshold_rmb") state.settings.low_balance_threshold_rmb = 200;
      else if (_id === "short_url_new_domain") state.settings.short_url_new_domain = "";
      else if (_id === "short_url_prefix") state.settings.short_url_prefix = "";
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({ k: String(r[idx("key")] || ""), v: r[idx("value")] }))
        .filter((x) => x.k)
        .map((x) => ({ _id: x.k, dataRow: [x.k, String(x.v ?? "")] }));
    },
  },
];
