// 每張同步分頁的 spec：
//   - sheetName: Sheets 分頁名
//   - dataHeaders: 資料欄位順序（不含 _id/_updated_at/_deleted 三個 metadata）
//   - flatten(state): 從 state 攤平成 [{ _id, dataRow }]
//   - upsertInState(state, _id, obj): server 回來的 row（obj 是 dataHeaders 的 key/value）寫入 state
//   - removeFromState(state, _id): server 標記刪除時從 state 移除
//   - legacyParse(headers, rows)?: 若 sheet 是舊格式（無 _id 欄），把舊 row 拆成 [{ _id, dataRow }]
//
// 設計準則：
//   1. dataHeaders 與舊 sheets-schema.js 大致對齊，但加上 (產品名稱) 等 derived 欄位是為了人眼可讀；
//      apply 時忽略它們（不 mutate state.products）
//   2. 複合鍵 _id 用 "::" 串接，避免跟自然 id 撞（natural id 都是英數字）
//   3. nested 結構（products[].performance_targets / ads[].weights / monthly_budgets[pid][ym] 等）
//      在 spec 裡 normalize/denormalize；view code 完全不變

import { METRICS, RENEWAL_REASONS, PRODUCT_TYPES } from "../schema.js";
import { applyDoneEliminateTodos, normalizeTodoCreatedAt } from "../domain/todo-utils.js";

// ===== 共用 helpers =====

function nameOfProduct(state, pid) {
  return state.products?.find((p) => p.id === pid)?.name || "";
}

function ensureProduct(state, pid) {
  let p = state.products?.find((x) => x.id === pid);
  if (!p) {
    p = { id: pid, name: pid, type: "app", no_band: false, performance_targets: [] };
    state.products = state.products || [];
    state.products.push(p);
  }
  return p;
}

function ensureAd(state, adId) {
  let a = state.ads?.find((x) => x.id === adId);
  if (!a) {
    a = {
      id: adId, ad_code: "", ad_name: "", group: "",
      currency: "CNY", amount_orig: 0, currency_rate: 1,
      amount_cny: 0, exchange_rate: 4.7, amount_twd: 0,
      start_date: "", end_date: "", amortize_days: 30, daily_amort_twd: 0,
      purchase_mode: "shared", weights: {}, renewal_of: null,
      renewal_reason: "初始", lock_perf_adjust: false, lock_full: false, notes: "",
      eliminated: false,
    };
    state.ads = state.ads || [];
    state.ads.push(a);
  }
  return a;
}

const numOr = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

// ===== Specs =====

export const TABLE_SYNC_SPECS = [
  // ── 1. 產品（id = product.id） ─────────────────────────────────────
  // 2026-05-22 補同步:is_poquan / parent_product_id(家族卡片歸位)
  {
    sheetName: "產品",
    dataHeaders: ["id", "名稱", "類型", "不檢查每日帶寬", "是破圈", "母產品ID"],
    flatten: (s) => (s.products || []).map((p) => ({
      _id: p.id,
      dataRow: [
        p.id, p.name, p.type, p.no_band ? "Y" : "",
        p.is_poquan ? "Y" : "",
        p.parent_product_id || "",
      ],
    })),
    upsertInState(state, _id, obj) {
      const p = ensureProduct(state, _id);
      p.id = String(obj.id || _id);
      p.name = String(obj["名稱"] || p.name || "");
      p.type = (obj["類型"] === "island") ? "island" : "app";
      p.no_band = String(obj["不檢查每日帶寬"] || "").toUpperCase() === "Y";
      // hasOwnProperty 保護:舊 sheet 還沒這兩欄時不蓋掉本機既有值
      if (Object.prototype.hasOwnProperty.call(obj, "是破圈")) {
        p.is_poquan = String(obj["是破圈"] || "").toUpperCase() === "Y";
      }
      if (Object.prototype.hasOwnProperty.call(obj, "母產品ID")) {
        p.parent_product_id = String(obj["母產品ID"] || "");
      }
    },
    removeFromState(state, _id) {
      state.products = (state.products || []).filter((p) => p.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iId = idx("id"), iName = idx("名稱"), iType = idx("類型"), iNb = idx("不檢查每日帶寬");
      const iPoq = idx("是破圈"), iParent = idx("母產品ID");
      return rows
        .map((r) => ({
          id: String(r[iId] || ""),
          name: String(r[iName] || ""),
          type: String(r[iType] || "app"),
          // 舊 sheet 沒這欄 → iNb=-1 → 取出 undefined → 預設 ""
          nb: iNb >= 0 && String(r[iNb] || "").toUpperCase() === "Y" ? "Y" : "",
          poq: iPoq >= 0 && String(r[iPoq] || "").toUpperCase() === "Y" ? "Y" : "",
          parent: iParent >= 0 ? String(r[iParent] || "") : "",
        }))
        .filter((p) => p.id)
        .map((p) => ({ _id: p.id, dataRow: [p.id, p.name, p.type, p.nb, p.poq, p.parent] }));
    },
  },

  // ── 2. 產品月預算（id = pid::ym） ─────────────────────────────────
  {
    sheetName: "產品月預算",
    dataHeaders: ["產品ID", "產品名稱", "月份(YYYY-MM)", "月預算(台幣)"],
    flatten: (s) => {
      const out = [];
      for (const [pid, months] of Object.entries(s.monthly_budgets || {})) {
        for (const [ym, amt] of Object.entries(months || {})) {
          if (!Number.isFinite(amt) || amt <= 0) continue;
          out.push({
            _id: `${pid}::${ym}`,
            dataRow: [pid, nameOfProduct(s, pid), ym, amt],
          });
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const pid = String(obj["產品ID"] || _id.split("::")[0]);
      const ym = String(obj["月份(YYYY-MM)"] || _id.split("::")[1]).slice(0, 7);
      const amt = numOr(obj["月預算(台幣)"]);
      if (!pid || !/^\d{4}-\d{2}$/.test(ym) || amt <= 0) return;
      if (!state.monthly_budgets) state.monthly_budgets = {};
      if (!state.monthly_budgets[pid]) state.monthly_budgets[pid] = {};
      state.monthly_budgets[pid][ym] = amt;
    },
    removeFromState(state, _id) {
      const [pid, ym] = _id.split("::");
      if (state.monthly_budgets?.[pid]) {
        delete state.monthly_budgets[pid][ym];
        if (Object.keys(state.monthly_budgets[pid]).length === 0) delete state.monthly_budgets[pid];
      }
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iPid = idx("產品ID"), iName = idx("產品名稱"), iYm = idx("月份(YYYY-MM)"), iAmt = idx("月預算(台幣)");
      return rows
        .map((r) => ({
          pid: String(r[iPid] || ""),
          name: String(r[iName] || ""),
          ym: String(r[iYm] || "").slice(0, 7),
          amt: numOr(r[iAmt]),
        }))
        .filter((x) => x.pid && /^\d{4}-\d{2}$/.test(x.ym) && x.amt > 0)
        .map((x) => ({ _id: `${x.pid}::${x.ym}`, dataRow: [x.pid, x.name, x.ym, x.amt] }));
    },
  },

  // ── 3. 產品日預算（id = pid::ym） ─────────────────────────────────
  {
    sheetName: "產品日預算",
    dataHeaders: ["產品ID", "產品名稱", "月份(YYYY-MM)", "日預算(台幣)"],
    flatten: (s) => {
      const out = [];
      for (const [pid, months] of Object.entries(s.daily_budgets || {})) {
        for (const [ym, amt] of Object.entries(months || {})) {
          if (!Number.isFinite(amt) || amt <= 0) continue;
          out.push({ _id: `${pid}::${ym}`, dataRow: [pid, nameOfProduct(s, pid), ym, amt] });
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const pid = String(obj["產品ID"] || _id.split("::")[0]);
      const ym = String(obj["月份(YYYY-MM)"] || _id.split("::")[1]).slice(0, 7);
      const amt = numOr(obj["日預算(台幣)"]);
      if (!pid || !/^\d{4}-\d{2}$/.test(ym) || amt <= 0) return;
      if (!state.daily_budgets) state.daily_budgets = {};
      if (!state.daily_budgets[pid]) state.daily_budgets[pid] = {};
      state.daily_budgets[pid][ym] = amt;
    },
    removeFromState(state, _id) {
      const [pid, ym] = _id.split("::");
      if (state.daily_budgets?.[pid]) {
        delete state.daily_budgets[pid][ym];
        if (Object.keys(state.daily_budgets[pid]).length === 0) delete state.daily_budgets[pid];
      }
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iPid = idx("產品ID"), iName = idx("產品名稱"), iYm = idx("月份(YYYY-MM)"), iAmt = idx("日預算(台幣)");
      return rows
        .map((r) => ({
          pid: String(r[iPid] || ""),
          name: String(r[iName] || ""),
          ym: String(r[iYm] || "").slice(0, 7),
          amt: numOr(r[iAmt]),
        }))
        .filter((x) => x.pid && /^\d{4}-\d{2}$/.test(x.ym) && x.amt > 0)
        .map((x) => ({ _id: `${x.pid}::${x.ym}`, dataRow: [x.pid, x.name, x.ym, x.amt] }));
    },
  },

  // ── 4. 產品預算變動（id = pid::ym::at_date） ─────────────────────
  {
    sheetName: "產品預算變動",
    dataHeaders: ["產品ID", "產品名稱", "月份(YYYY-MM)", "生效日", "金額(台幣)", "模式"],
    flatten: (s) => {
      const out = [];
      const typeOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.type]));
      for (const [pid, months] of Object.entries(s.budget_changes || {})) {
        for (const [ym, arr] of Object.entries(months || {})) {
          if (!Array.isArray(arr)) continue;
          for (const c of arr) {
            if (!c?.at_date || !Number.isFinite(c.amount) || c.amount <= 0) continue;
            const mode = c.mode || (typeOf[pid] === "island" ? "daily" : "monthly");
            out.push({
              _id: `${pid}::${ym}::${c.at_date}`,
              dataRow: [pid, nameOfProduct(s, pid), ym, c.at_date, c.amount, mode],
            });
          }
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const [pid, ym, at_date] = _id.split("::");
      const amt = numOr(obj["金額(台幣)"]);
      const modeRaw = String(obj["模式"] || "").toLowerCase();
      const mode = modeRaw === "daily" ? "daily" : modeRaw === "monthly" ? "monthly" : null;
      if (!pid || !/^\d{4}-\d{2}$/.test(ym) || !at_date || amt <= 0) return;
      if (!state.budget_changes) state.budget_changes = {};
      if (!state.budget_changes[pid]) state.budget_changes[pid] = {};
      if (!state.budget_changes[pid][ym]) state.budget_changes[pid][ym] = [];
      const arr = state.budget_changes[pid][ym];
      const existing = arr.find((c) => c.at_date === at_date);
      if (existing) {
        existing.amount = amt;
        if (mode) existing.mode = mode;
      } else {
        const entry = { at_date, amount: amt };
        if (mode) entry.mode = mode;
        arr.push(entry);
        arr.sort((a, b) => (a.at_date < b.at_date ? -1 : 1));
      }
    },
    removeFromState(state, _id) {
      const [pid, ym, at_date] = _id.split("::");
      const arr = state.budget_changes?.[pid]?.[ym];
      if (!arr) return;
      state.budget_changes[pid][ym] = arr.filter((c) => c.at_date !== at_date);
      if (state.budget_changes[pid][ym].length === 0) delete state.budget_changes[pid][ym];
      if (Object.keys(state.budget_changes[pid] || {}).length === 0) delete state.budget_changes[pid];
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iPid = idx("產品ID"), iName = idx("產品名稱"), iYm = idx("月份(YYYY-MM)"),
            iAt = idx("生效日"), iAmt = idx("金額(台幣)"), iMode = idx("模式");
      return rows
        .map((r) => ({
          pid: String(r[iPid] || ""),
          name: String(r[iName] || ""),
          ym: String(r[iYm] || "").slice(0, 7),
          at: String(r[iAt] || "").slice(0, 10),
          amt: numOr(r[iAmt]),
          mode: String(r[iMode] || "monthly"),
        }))
        .filter((x) => x.pid && x.ym && x.at && x.amt > 0)
        .map((x) => ({
          _id: `${x.pid}::${x.ym}::${x.at}`,
          dataRow: [x.pid, x.name, x.ym, x.at, x.amt, x.mode],
        }));
    },
  },

  // ── 5. 成效目標（id = target.id） ─────────────────────────────────
  {
    sheetName: "成效目標",
    dataHeaders: ["id", "產品ID", "名稱", "公式", "目標值", "方向"],
    flatten: (s) => {
      const out = [];
      for (const p of (s.products || [])) {
        for (const t of (p.performance_targets || [])) {
          if (!t.id) continue;
          out.push({
            _id: t.id,
            dataRow: [t.id, p.id, t.name || "", t.formula || "", t.goal_value ?? 0, t.direction || "lower_better"],
          });
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const pid = String(obj["產品ID"] || "");
      const product = state.products?.find((p) => p.id === pid);
      if (!product) return;
      product.performance_targets = product.performance_targets || [];
      const existing = product.performance_targets.find((t) => t.id === _id);
      const patch = {
        id: _id,
        name: String(obj["名稱"] || ""),
        formula: String(obj["公式"] || ""),
        goal_value: numOr(obj["目標值"]),
        direction: obj["方向"] === "higher_better" ? "higher_better" : "lower_better",
      };
      if (existing) Object.assign(existing, patch);
      else product.performance_targets.push(patch);
    },
    removeFromState(state, _id) {
      for (const p of (state.products || [])) {
        if (!Array.isArray(p.performance_targets)) continue;
        p.performance_targets = p.performance_targets.filter((t) => t.id !== _id);
      }
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      const iId = idx("id"), iPid = idx("產品ID"), iName = idx("名稱"),
            iF = idx("公式"), iG = idx("目標值"), iD = idx("方向");
      return rows
        .map((r) => ({ id: String(r[iId] || ""), pid: String(r[iPid] || ""), name: String(r[iName] || ""),
                       formula: String(r[iF] || ""), goal: numOr(r[iG]), dir: String(r[iD] || "lower_better") }))
        .filter((x) => x.id)
        .map((x) => ({ _id: x.id, dataRow: [x.id, x.pid, x.name, x.formula, x.goal, x.dir] }));
    },
  },

  // ── 6. 廣告（id = ad.id；不含 weights — 那是分開的 sheet） ─────
  // 2026-05-22 補同步:縮網址(6 欄)、code_at_creation(時間軸對照)、split_pair(配對)
  {
    sheetName: "廣告",
    dataHeaders: [
      "id", "廣告代碼", "廣告名稱", "廣告分組",
      "幣別", "原幣金額", "原幣→RMB匯率",
      "人民幣金額", "匯率", "台幣金額",
      "開始日期", "結束日期", "攤提天數", "每日攤提(台幣)",
      "購買模式", "續費來源", "調整原因", "鎖定不調整", "禁止挪動",
      "廣告文案", "聯絡用TG號", "站長聯繫", "備註", "已淘汰",
      "縮網址類型", "縮網址參數", "縮網址舊網域", "縮網址舊前綴", "縮網址新網域", "縮網址已通知",
      "段建立代碼", "配對ID", "配對角色",
    ],
    flatten: (s) => (s.ads || []).map((a) => ({
      _id: a.id,
      dataRow: [
        a.id, a.ad_code || "", a.ad_name || "", a.group || "",
        a.currency || "CNY",
        a.amount_orig != null ? a.amount_orig : a.amount_cny,
        a.currency_rate || 1,
        a.amount_cny || 0, a.exchange_rate || 4.7, a.amount_twd || 0,
        a.start_date || "", a.end_date || "", a.amortize_days || 30, a.daily_amort_twd || 0,
        a.purchase_mode || "shared",
        a.renewal_of || "",
        a.renewal_reason || "初始",
        a.lock_perf_adjust ? "Y" : "",
        a.lock_full ? "Y" : "",
        a.ad_copy || "",
        a.contact_tg || "",
        a.contact_info || "",
        a.notes || "",
        a.eliminated ? "Y" : "",
        a.short_url_type || "",
        a.short_url_param || "",
        a.short_url_old_override || "",
        a.short_url_old_prefix || "",
        a.short_url_new_override || "",
        a.short_url_notified ? "Y" : "",
        a.code_at_creation || "",
        a.split_pair_id || "",
        a.split_role || "",
      ],
    })),
    upsertInState(state, _id, obj) {
      // 拒絕「空白 ghost row」:沒 ad_code、沒名稱、沒金額、沒日期 → 不建 ad
      // 避免 sheets 有殘留空 row 時被無腦讀回來建一堆空 ad(已知 bug,2026-05-21 修)
      const adCode = String(obj["廣告代碼"] || "");
      const adName = String(obj["廣告名稱"] || "");
      const cny = numOr(obj["人民幣金額"]);
      const startDate = String(obj["開始日期"] || "");
      const endDate = String(obj["結束日期"] || "");
      if (!adCode && !adName && !cny && !startDate && !endDate) {
        // 全空 row,且 state 裡也沒這 id → 直接 skip,不建 ghost
        const existing = state.ads?.find((x) => x.id === _id);
        if (!existing) return;
        // 已存在但被 sync 推來空 row → 也別動,等下次推有資料的版本
        return;
      }

      const a = ensureAd(state, _id);
      const currency = String(obj["幣別"] || "CNY").toUpperCase() === "USDT" ? "USDT" : "CNY";
      const amountOrig = numOr(obj["原幣金額"], cny);
      const currencyRate = numOr(obj["原幣→RMB匯率"], 1);
      const reason = String(obj["調整原因"] || "初始");
      a.id = _id;
      a.ad_code = adCode;
      a.ad_name = adName;
      a.group = String(obj["廣告分組"] || "");
      a.currency = currency;
      a.amount_orig = amountOrig > 0 ? amountOrig : cny;
      a.currency_rate = currencyRate > 0 ? currencyRate : 1;
      a.amount_cny = cny;
      a.exchange_rate = numOr(obj["匯率"], 4.7);
      // 台幣金額 fallback:sheets 那欄空白或 0 時,改用 amount_cny × exchange_rate 重算
      // 避免 sheets 一旦該欄被洗成 0,後續 sync 就把 ad.amount_twd 也固定成 0,潰爛不可逆
      const twdFromSheet = numOr(obj["台幣金額"]);
      a.amount_twd = twdFromSheet > 0 ? twdFromSheet : Math.round(cny * a.exchange_rate * 1000) / 1000;
      a.start_date = startDate.slice(0, 10);
      a.end_date = endDate.slice(0, 10);
      a.amortize_days = numOr(obj["攤提天數"], 30);
      const dailyFromSheet = numOr(obj["每日攤提(台幣)"]);
      a.daily_amort_twd = dailyFromSheet > 0 ? dailyFromSheet : (a.amortize_days > 0 ? a.amount_twd / a.amortize_days : 0);
      a.purchase_mode = String(obj["購買模式"] || "shared");
      a.renewal_of = obj["續費來源"] ? String(obj["續費來源"]) : null;
      a.renewal_reason = RENEWAL_REASONS.includes(reason) ? reason : "初始";
      a.lock_perf_adjust = String(obj["鎖定不調整"] || "").toUpperCase() === "Y";
      a.lock_full = String(obj["禁止挪動"] || "").toUpperCase() === "Y";
      if (Object.prototype.hasOwnProperty.call(obj, "廣告文案")) a.ad_copy = String(obj["廣告文案"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "聯絡用TG號")) a.contact_tg = String(obj["聯絡用TG號"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "站長聯繫")) a.contact_info = String(obj["站長聯繫"] || "");
      a.notes = String(obj["備註"] || "");
      a.eliminated = String(obj["已淘汰"] || "").toUpperCase() === "Y";
      // 2026-05-22 補同步:縮網址 + code_at_creation + split_pair
      // 用 hasOwnProperty 判斷 — sheet 還沒 migrate 到新 headers 時這些 key 不在 obj 裡,
      // 跳過寫入,保留本機原值;migrate 後 sheet 有欄位就會寫入(空字串 = 該廣告本來就沒設)
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址類型")) a.short_url_type = String(obj["縮網址類型"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址參數")) a.short_url_param = String(obj["縮網址參數"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址舊網域")) a.short_url_old_override = String(obj["縮網址舊網域"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址舊前綴")) a.short_url_old_prefix = String(obj["縮網址舊前綴"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址新網域")) a.short_url_new_override = String(obj["縮網址新網域"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "縮網址已通知")) a.short_url_notified = String(obj["縮網址已通知"] || "").toUpperCase() === "Y";
      if (Object.prototype.hasOwnProperty.call(obj, "段建立代碼")) a.code_at_creation = String(obj["段建立代碼"] || "");
      if (Object.prototype.hasOwnProperty.call(obj, "配對ID")) a.split_pair_id = String(obj["配對ID"] || "") || null;
      if (Object.prototype.hasOwnProperty.call(obj, "配對角色")) {
        const role = String(obj["配對角色"] || "");
        a.split_role = (role === "parent" || role === "t_variant") ? role : null;
      }
      applyDoneEliminateTodos(state);
    },
    removeFromState(state, _id) {
      state.ads = (state.ads || []).filter((a) => a.id !== _id);
    },
    legacyParse(headers, rows) {
      // 舊「廣告」分頁 headers 跟現在差不多但少「已淘汰」、有「對應產品」摘要欄。
      // 這裡簡單抓對應欄,沒有的補預設。
      const idx = (h) => headers.indexOf(h);
      const out = [];
      for (const r of rows) {
        const id = String(r[idx("id")] || "");
        if (!id) continue;
        const cny = numOr(r[idx("人民幣金額")]);
        const cur = String(r[idx("幣別")] || "CNY").toUpperCase() === "USDT" ? "USDT" : "CNY";
        const ao = numOr(r[idx("原幣金額")], cny);
        const cr = numOr(r[idx("原幣→RMB匯率")], 1);
        const reason = String(r[idx("調整原因")] || "初始");
        out.push({
          _id: id,
          dataRow: [
            id, String(r[idx("廣告代碼")] || ""), String(r[idx("廣告名稱")] || ""), String(r[idx("廣告分組")] || ""),
            cur, ao > 0 ? ao : cny, cr > 0 ? cr : 1,
            cny, numOr(r[idx("匯率")], 4.7), numOr(r[idx("台幣金額")]),
            String(r[idx("開始日期")] || "").slice(0, 10),
            String(r[idx("結束日期")] || "").slice(0, 10),
            numOr(r[idx("攤提天數")], 30), numOr(r[idx("每日攤提(台幣)")]),
            String(r[idx("購買模式")] || "shared"),
            String(r[idx("續費來源")] || ""),
            RENEWAL_REASONS.includes(reason) ? reason : "初始",
            String(r[idx("鎖定不調整")] || "").toUpperCase() === "Y" ? "Y" : "",
            idx("禁止挪動") >= 0 && String(r[idx("禁止挪動")] || "").toUpperCase() === "Y" ? "Y" : "",
            idx("廣告文案") >= 0 ? String(r[idx("廣告文案")] || "") : "",
            idx("聯絡用TG號") >= 0 ? String(r[idx("聯絡用TG號")] || "") : "",
            idx("站長聯繫") >= 0 ? String(r[idx("站長聯繫")] || "") : "",
            String(r[idx("備註")] || ""),
            "",
            // 9 個新欄位:legacyParse 從舊 sheet 拉時補空(舊 sheet 沒這些 column)
            idx("縮網址類型") >= 0 ? String(r[idx("縮網址類型")] || "") : "",
            idx("縮網址參數") >= 0 ? String(r[idx("縮網址參數")] || "") : "",
            idx("縮網址舊網域") >= 0 ? String(r[idx("縮網址舊網域")] || "") : "",
            idx("縮網址舊前綴") >= 0 ? String(r[idx("縮網址舊前綴")] || "") : "",
            idx("縮網址新網域") >= 0 ? String(r[idx("縮網址新網域")] || "") : "",
            idx("縮網址已通知") >= 0 && String(r[idx("縮網址已通知")] || "").toUpperCase() === "Y" ? "Y" : "",
            idx("段建立代碼") >= 0 ? String(r[idx("段建立代碼")] || "") : "",
            idx("配對ID") >= 0 ? String(r[idx("配對ID")] || "") : "",
            idx("配對角色") >= 0 ? String(r[idx("配對角色")] || "") : "",
          ],
        });
      }
      return out;
    },
  },

  // ── 7. 廣告權重（id = ad_id::pid，每對權重獨立 _updated_at） ─────
  {
    sheetName: "廣告權重",
    dataHeaders: ["廣告ID", "廣告代碼", "廣告名稱", "產品ID", "產品名稱", "權重%"],
    flatten: (s) => {
      const out = [];
      const nameOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      for (const a of (s.ads || [])) {
        for (const [pid, w] of Object.entries(a.weights || {})) {
          if (!Number.isFinite(Number(w)) || Number(w) <= 0) continue;
          out.push({
            _id: `${a.id}::${pid}`,
            dataRow: [a.id, a.ad_code || "", a.ad_name || "", pid, nameOf[pid] || "", Math.round(Number(w))],
          });
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const [adId, pid] = _id.split("::");
      const w = numOr(obj["權重%"]);
      if (!adId || !pid || w <= 0) return;
      const a = ensureAd(state, adId);
      a.weights = a.weights || {};
      a.weights[pid] = w;
    },
    removeFromState(state, _id) {
      const [adId, pid] = _id.split("::");
      const a = state.ads?.find((x) => x.id === adId);
      if (a?.weights) delete a.weights[pid];
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          adId: String(r[idx("廣告ID")] || ""),
          adCode: String(r[idx("廣告代碼")] || ""),
          adName: String(r[idx("廣告名稱")] || ""),
          pid: String(r[idx("產品ID")] || ""),
          pname: String(r[idx("產品名稱")] || ""),
          w: numOr(r[idx("權重%")]),
        }))
        .filter((x) => x.adId && x.pid && x.w > 0)
        .map((x) => ({
          _id: `${x.adId}::${x.pid}`,
          dataRow: [x.adId, x.adCode, x.adName, x.pid, x.pname, Math.round(x.w)],
        }));
    },
  },

  // ── 8. 成效資料（id = ad_code::pid::period_start::period_end） ───
  {
    sheetName: "成效資料",
    dataHeaders: ["廣告代碼", "對應產品", "廣告分組", "資料起始日", "資料結束日", ...METRICS],
    flatten: (s) => {
      const out = [];
      for (const r of (s.performance_data || [])) {
        const id = `${r.ad_code || ""}::${r.product_id || ""}::${r.period_start || ""}::${r.period_end || ""}`;
        out.push({
          _id: id,
          dataRow: [
            r.ad_code || "", r.product_id || "", r.group || "",
            r.period_start || "", r.period_end || "",
            ...METRICS.map((m) => (r[m] ?? "")),
          ],
        });
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const adCode = String(obj["廣告代碼"] || "");
      const pid = String(obj["對應產品"] || "");
      const periodStart = String(obj["資料起始日"] || "").slice(0, 10);
      const periodEnd = String(obj["資料結束日"] || "").slice(0, 10);
      if (!adCode || !pid) return;
      const rec = {
        ad_code: adCode,
        product_id: pid,
        group: String(obj["廣告分組"] || ""),
        period_start: periodStart,
        period_end: periodEnd,
      };
      // 嘗試解析回 ad_id（fuzzy by ad_code + 期間 overlap）
      const ad = (state.ads || []).find((a) =>
        a.ad_code === adCode && Number(a.weights?.[pid]) > 0 &&
        a.start_date < periodEnd && a.end_date > periodStart
      );
      if (ad) {
        rec.ad_id = ad.id;
        rec.ad_name = ad.ad_name;
      } else {
        rec.ad_id = "";
        rec.ad_name = (state.ads || []).find((a) => a.ad_code === adCode)?.ad_name || "";
      }
      for (const m of METRICS) {
        const v = obj[m];
        if (v != null && v !== "") rec[m] = numOr(v);
      }
      state.performance_data = state.performance_data || [];
      const idx = state.performance_data.findIndex((r) =>
        r.ad_code === adCode && r.product_id === pid &&
        r.period_start === periodStart && r.period_end === periodEnd
      );
      if (idx >= 0) state.performance_data[idx] = rec;
      else state.performance_data.push(rec);
    },
    removeFromState(state, _id) {
      const [adCode, pid, ps, pe] = _id.split("::");
      state.performance_data = (state.performance_data || []).filter((r) =>
        !(r.ad_code === adCode && r.product_id === pid && r.period_start === ps && r.period_end === pe)
      );
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => {
          const ad_code = String(r[idx("廣告代碼")] || "");
          const pid = String(r[idx("對應產品")] || "");
          const ps = String(r[idx("資料起始日")] || "").slice(0, 10);
          const pe = String(r[idx("資料結束日")] || "").slice(0, 10);
          if (!ad_code || !pid) return null;
          return {
            _id: `${ad_code}::${pid}::${ps}::${pe}`,
            dataRow: [
              ad_code, pid, String(r[idx("廣告分組")] || ""),
              ps, pe,
              ...METRICS.map((m) => r[idx(m)] ?? ""),
            ],
          };
        })
        .filter(Boolean);
    },
  },

  // ── 9. 待辦（id = todo.id） ────────────────────────────────────────
  // 2026-05-22 補同步:undo_payload(JSON.stringify;> 30KB 跳過,避免爆 cell)
  {
    sheetName: "待辦",
    dataHeaders: ["id", "建立時間", "動作類型", "描述", "狀態", "撤回資料JSON"],
    flatten: (s) => (s.todos || []).map((t) => {
      // undo_payload 太大就跳過(Google Sheets cell 限 50000 char,留安全邊際)
      let undoJson = "";
      if (t.undo_payload) {
        try {
          const s = JSON.stringify(t.undo_payload);
          if (s.length <= 30000) undoJson = s;
        } catch { /* ignore */ }
      }
      return {
        _id: t.id,
        dataRow: [
          t.id, normalizeTodoCreatedAt(t.created_at), t.action_type || "",
          t.description || "", t.status || "pending", undoJson,
        ],
      };
    }),
    upsertInState(state, _id, obj) {
      state.todos = state.todos || [];
      const idx = state.todos.findIndex((t) => t.id === _id);
      const rec = {
        id: _id,
        created_at: normalizeTodoCreatedAt(obj["建立時間"]),
        action_type: String(obj["動作類型"] || ""),
        description: String(obj["描述"] || ""),
        status: obj["狀態"] === "done" ? "done" : "pending",
      };
      // undo_payload:hasOwnProperty 保護,沒這欄就保留本機既有(同 ad 處理方式)
      if (Object.prototype.hasOwnProperty.call(obj, "撤回資料JSON")) {
        const raw = String(obj["撤回資料JSON"] || "").trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") rec.undo_payload = parsed;
          } catch { /* 解析失敗 → 不寫 undo_payload,保 todo 本身 */ }
        }
      } else if (idx >= 0 && state.todos[idx].undo_payload) {
        // 舊 sheet 沒這欄 → 保留本機既有的 undo_payload
        rec.undo_payload = state.todos[idx].undo_payload;
      }
      if (idx >= 0) state.todos[idx] = rec;
      else state.todos.push(rec);
      applyDoneEliminateTodos(state);
    },
    removeFromState(state, _id) {
      state.todos = (state.todos || []).filter((t) => t.id !== _id);
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          id: String(r[idx("id")] || ""),
          created_at: normalizeTodoCreatedAt(r[idx("建立時間")]),
          at: String(r[idx("動作類型")] || ""),
          desc: String(r[idx("描述")] || ""),
          status: String(r[idx("狀態")] || "pending"),
          undo: idx("撤回資料JSON") >= 0 ? String(r[idx("撤回資料JSON")] || "") : "",
        }))
        .filter((x) => x.id)
        .map((x) => ({ _id: x.id, dataRow: [x.id, normalizeTodoCreatedAt(x.created_at), x.at, x.desc, x.status, x.undo] }));
    },
  },

  // ── 10. 設定（id = key） ───────────────────────────────────────────
  // 同步的 key 限定為「跨裝置共享、不會因為環境而不同」的:
  //   - current_month、expense_rate、income_rate、usdt_to_cny_rate、usd_to_twd_rate
  //   - monthly_rates 拆成多筆 key（如 "monthly_rate::2026-04::expense"）
  // 不同步:sheets_webapp_url、sheets_token、auto_sync_*（裝置相關）
  {
    sheetName: "設定",
    dataHeaders: ["key", "value"],
    flatten: (s) => {
      const settings = s.settings || {};
      const out = [];
      const push = (k, v) => out.push({ _id: k, dataRow: [k, String(v ?? "")] });
      push("current_month", settings.current_month);
      push("expense_rate", settings.expense_rate ?? 4.8);
      push("income_rate", settings.income_rate ?? 4.6);
      push("usdt_to_cny_rate", settings.usdt_to_cny_rate ?? 7);
      push("usd_to_twd_rate", settings.usd_to_twd_rate ?? 32);
      // 月度匯率覆寫拆成多筆
      for (const [ym, r] of Object.entries(settings.monthly_rates || {})) {
        for (const kind of ["expense", "income", "usdt_to_cny", "usd_to_twd"]) {
          const v = r?.[kind];
          if (Number.isFinite(v) && v > 0) push(`monthly_rate::${ym}::${kind}`, v);
        }
      }
      // 2026-05-22 補同步:縮網址全站設定
      if (settings.short_url_new_domain) push("short_url_new_domain", settings.short_url_new_domain);
      if (settings.short_url_old_domain) push("short_url_old_domain", settings.short_url_old_domain);
      if (settings.short_url_prefix_map && typeof settings.short_url_prefix_map === "object") {
        // 整個 prefix_map 一筆 row,value 用 JSON 序列化(map 只有 3 個 key,塞得下)
        try {
          push("short_url_prefix_map", JSON.stringify(settings.short_url_prefix_map));
        } catch { /* ignore */ }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      state.settings = state.settings || {};
      const v = obj["value"];
      if (_id === "current_month") {
        // 不從 sheet 同步 current_month — 由 client 各自跟系統時鐘走。
        // 若 sheet 有寫,忽略,但仍記在 meta(避免認為 dirty)
        return;
      }
      if (_id === "expense_rate") state.settings.expense_rate = numOr(v, 4.8);
      else if (_id === "income_rate") state.settings.income_rate = numOr(v, 4.6);
      else if (_id === "usdt_to_cny_rate") state.settings.usdt_to_cny_rate = numOr(v, 7);
      else if (_id === "usd_to_twd_rate") state.settings.usd_to_twd_rate = numOr(v, 32);
      else if (_id === "short_url_new_domain") state.settings.short_url_new_domain = String(v ?? "");
      else if (_id === "short_url_old_domain") state.settings.short_url_old_domain = String(v ?? "");
      else if (_id === "short_url_prefix_map") {
        const raw = String(v ?? "").trim();
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") state.settings.short_url_prefix_map = parsed;
          } catch { /* 解析失敗 → 不動 */ }
        }
      }
      else if (_id.startsWith("monthly_rate::")) {
        const [, ym, kind] = _id.split("::");
        if (!/^\d{4}-\d{2}$/.test(ym)) return;
        if (!["expense", "income", "usdt_to_cny", "usd_to_twd"].includes(kind)) return;
        state.settings.monthly_rates = state.settings.monthly_rates || {};
        if (!state.settings.monthly_rates[ym]) state.settings.monthly_rates[ym] = {};
        const num = numOr(v);
        if (num > 0) state.settings.monthly_rates[ym][kind] = num;
      }
    },
    removeFromState(state, _id) {
      if (!state.settings) return;
      if (_id === "current_month") return;  // 不刪
      if (_id === "expense_rate") state.settings.expense_rate = 4.8;
      else if (_id === "income_rate") state.settings.income_rate = 4.6;
      else if (_id === "usdt_to_cny_rate") state.settings.usdt_to_cny_rate = 7;
      else if (_id === "usd_to_twd_rate") state.settings.usd_to_twd_rate = 32;
      else if (_id === "short_url_new_domain") state.settings.short_url_new_domain = "";
      else if (_id === "short_url_old_domain") state.settings.short_url_old_domain = "";
      else if (_id === "short_url_prefix_map") delete state.settings.short_url_prefix_map;
      else if (_id.startsWith("monthly_rate::")) {
        const [, ym, kind] = _id.split("::");
        if (state.settings.monthly_rates?.[ym]) {
          delete state.settings.monthly_rates[ym][kind];
          if (Object.keys(state.settings.monthly_rates[ym]).length === 0) {
            delete state.settings.monthly_rates[ym];
          }
        }
      }
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({ k: String(r[idx("key")] || ""), v: r[idx("value")] }))
        .filter((x) => x.k)
        .map((x) => ({ _id: x.k, dataRow: [x.k, String(x.v ?? "")] }));
    },
  },

  // ── 11. 報表自訂欄位（id = custom_metric.id） ─────────────────────
  {
    sheetName: "報表自訂欄位",
    dataHeaders: ["id", "產品ID", "產品名稱", "名稱", "公式", "顯示百分比"],
    flatten: (s) => {
      const out = [];
      const nameOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      for (const [pid, cfg] of Object.entries(s.report_config || {})) {
        for (const m of (cfg?.custom_metrics || [])) {
          if (!m?.id || !m.name || !m.formula) continue;
          out.push({
            _id: m.id,
            dataRow: [m.id, pid, nameOf[pid] || "", m.name, m.formula, m.show_as_percent ? "Y" : ""],
          });
        }
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      const pid = String(obj["產品ID"] || "");
      if (!pid) return;
      state.report_config = state.report_config || {};
      if (!state.report_config[pid]) state.report_config[pid] = { hidden_metrics: [], custom_metrics: [] };
      const cfg = state.report_config[pid];
      cfg.custom_metrics = cfg.custom_metrics || [];
      const rec = {
        id: _id,
        name: String(obj["名稱"] || ""),
        formula: String(obj["公式"] || ""),
        show_as_percent: String(obj["顯示百分比"] || "").toUpperCase() === "Y",
      };
      const idx = cfg.custom_metrics.findIndex((m) => m.id === _id);
      if (idx >= 0) cfg.custom_metrics[idx] = rec;
      else cfg.custom_metrics.push(rec);
    },
    removeFromState(state, _id) {
      for (const cfg of Object.values(state.report_config || {})) {
        if (!cfg?.custom_metrics) continue;
        cfg.custom_metrics = cfg.custom_metrics.filter((m) => m.id !== _id);
      }
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          id: String(r[idx("id")] || ""),
          pid: String(r[idx("產品ID")] || ""),
          pname: String(r[idx("產品名稱")] || ""),
          name: String(r[idx("名稱")] || ""),
          formula: String(r[idx("公式")] || ""),
          pct: String(r[idx("顯示百分比")] || ""),
        }))
        .filter((x) => x.id && x.name && x.formula)
        .map((x) => ({ _id: x.id, dataRow: [x.id, x.pid, x.pname, x.name, x.formula, x.pct] }));
    },
  },

  // ── 12. 報表設定（id = product.id） ───────────────────────────────
  // 2026-05-22 新增:同步 report_config[pid] 的 hidden_metrics + user_configured flags。
  // custom_metrics 在 sheet 11(報表自訂欄位),per-metric row;這張 sheet 是 per-product row。
  {
    sheetName: "報表設定",
    dataHeaders: ["產品ID", "產品名稱", "隱藏欄位", "已自訂隱藏", "已自訂自訂"],
    flatten: (s) => {
      const out = [];
      const nameOf = Object.fromEntries((s.products || []).map((p) => [p.id, p.name]));
      for (const [pid, cfg] of Object.entries(s.report_config || {})) {
        if (!cfg) continue;
        const hidden = Array.isArray(cfg.hidden_metrics) ? cfg.hidden_metrics : [];
        const hiddenConfigured = cfg.hidden_metrics_user_configured === true;
        const customConfigured = cfg.custom_metrics_user_configured === true;
        // 全空白(沒隱藏 + 沒 flag)→ 跳過,避免推一堆空 row
        if (hidden.length === 0 && !hiddenConfigured && !customConfigured) continue;
        out.push({
          _id: pid,
          dataRow: [
            pid, nameOf[pid] || "",
            hidden.join(","),
            hiddenConfigured ? "Y" : "",
            customConfigured ? "Y" : "",
          ],
        });
      }
      return out;
    },
    upsertInState(state, _id, obj) {
      if (!_id) return;
      state.report_config = state.report_config || {};
      if (!state.report_config[_id]) state.report_config[_id] = { hidden_metrics: [], custom_metrics: [] };
      const cfg = state.report_config[_id];
      const hiddenStr = String(obj["隱藏欄位"] || "").trim();
      cfg.hidden_metrics = hiddenStr ? hiddenStr.split(",").map((s) => s.trim()).filter(Boolean) : [];
      cfg.hidden_metrics_user_configured = String(obj["已自訂隱藏"] || "").toUpperCase() === "Y";
      cfg.custom_metrics_user_configured = String(obj["已自訂自訂"] || "").toUpperCase() === "Y";
    },
    removeFromState(state, _id) {
      if (!state.report_config?.[_id]) return;
      const cfg = state.report_config[_id];
      cfg.hidden_metrics = [];
      delete cfg.hidden_metrics_user_configured;
      delete cfg.custom_metrics_user_configured;
      // 留著 cfg(custom_metrics 可能還在)
    },
    legacyParse(headers, rows) {
      const idx = (h) => headers.indexOf(h);
      return rows
        .map((r) => ({
          pid: String(r[idx("產品ID")] || ""),
          pname: String(r[idx("產品名稱")] || ""),
          hidden: String(r[idx("隱藏欄位")] || ""),
          hc: idx("已自訂隱藏") >= 0 && String(r[idx("已自訂隱藏")] || "").toUpperCase() === "Y" ? "Y" : "",
          cc: idx("已自訂自訂") >= 0 && String(r[idx("已自訂自訂")] || "").toUpperCase() === "Y" ? "Y" : "",
        }))
        .filter((x) => x.pid)
        .map((x) => ({ _id: x.pid, dataRow: [x.pid, x.pname, x.hidden, x.hc, x.cc] }));
    },
  },
];
