// 結算 + FIFO 引擎。
// 所有報表 / 帳務頁 / 概覽都從這裡的 API 取數,確保各處數字一致。
//
// 主要 API:
//   getEffectivePrice(state, channelId)              → 適用單價(RMB)
//   isChannelBillableOn(channel, ymd)                → 該日是否計費
//   computeDailyCostsRMB(state, opts)                → [{date, channel_id, product_id, publisher_id, installs, price_rmb, cost_rmb}]
//   computeFIFO(state, opts)                         → { batches: [{...payment, consumed, remaining}],
//                                                         dailyCosts: [{...日線, twd, batches_used: [{payment_id, rmb, rate}]}],
//                                                         shortfall_rmb: number(沒對應到批次的 RMB,用 fallback 匯率) }
//   computePublisherBalance(state, publisherId, asOf?) → { paid_rmb, settled_rmb, balance_rmb }
//
// 規則(§3.2 / §3.3):
//   - 廠商安裝**四捨五入**再乘單價(避免小數累積誤差)
//   - FIFO:依 payment.date asc 消耗;同日多筆依 created_at 補序
//   - 沒對應批次(預付不夠 or 後結算還沒打款) → 用 settings.expense_rate 當 fallback,並標 warning
//   - 「啟用中」永遠計費;「淘汰中 + stop」截止計費日(含當天)後不算;
//     「淘汰中 + winding-down」一律計費(等使用者手動確認);「已淘汰」確認日(含當天)後不算
//   - 沒設 cpa_enabled 的產品 → 不計入結算

import { todayTaipei } from "../lib/dates.js";

const round = (n) => Math.round(n || 0);

export function getEffectivePrice(state, channelId) {
  const ch = (state.channels || []).find((c) => c.id === channelId);
  if (!ch) return 0;
  if (ch.cpa_price_rmb != null && Number.isFinite(Number(ch.cpa_price_rmb))) {
    return Number(ch.cpa_price_rmb);
  }
  const pub = (state.publishers || []).find((p) => p.id === ch.publisher_id);
  return Number(pub?.default_cpa_price_rmb || 0);
}

export function isChannelBillableOn(channel, ymd) {
  if (!channel) return false;
  const st = channel.status || "啟用中";
  if (st === "啟用中") return true;
  if (st === "淘汰中") {
    if (channel.elimination_mode === "winding-down") return true;
    // stop 模式:截止計費日(含當天)後不再計費
    if (channel.billing_end_date && ymd > channel.billing_end_date) return false;
    return true;
  }
  if (st === "已淘汰") {
    // 確認日(含當天)後不再計費
    if (channel.confirmed_eliminated_at && ymd > channel.confirmed_eliminated_at) return false;
    if (!channel.confirmed_eliminated_at) return false;  // 沒填確認日 → 視為已停
    return true;
  }
  return false;
}

// 算每筆 install_data 的 RMB 成本(尊重 billable 規則、cpa_enabled、四捨五入)
//
// opts.publisherId: 只算某站長
// opts.from, opts.to: 期間篩選(YYYY-MM-DD,inclusive)
// opts.includeNonEnabled: 預設 false。傳 true 連未啟用 CPA 的產品也列出(花費 = 0)
export function computeDailyCostsRMB(state, opts = {}) {
  const channels = state.channels || [];
  const products = state.products || [];
  const chById = Object.fromEntries(channels.map((c) => [c.id, c]));
  const prById = Object.fromEntries(products.map((p) => [p.id, p]));
  const out = [];

  for (const d of state.install_data || []) {
    const ch = chById[d.channel_id];
    const pr = prById[d.product_id];
    if (!ch || !pr) continue;
    if (opts.publisherId && ch.publisher_id !== opts.publisherId) continue;
    if (opts.from && d.date < opts.from) continue;
    if (opts.to && d.date > opts.to) continue;

    const billable = isChannelBillableOn(ch, d.date);
    const cpaOn = pr.cpa_enabled !== false;
    const installs = round(d["廠商安裝"]);
    const price = getEffectivePrice(state, ch.id);
    const billed = billable && cpaOn ? installs : 0;
    const cost = billed * price;

    if (cost === 0 && !opts.includeNonEnabled) continue;
    out.push({
      date: d.date,
      channel_id: ch.id,
      channel_name: ch.name,
      publisher_id: ch.publisher_id,
      product_id: pr.id,
      product_name: pr.name,
      installs_raw: d["廠商安裝"] || 0,
      installs_billed: billed,
      price_rmb: price,
      cost_rmb: cost,
      billable,
      cpa_enabled: cpaOn,
    });
  }
  return out;
}

// FIFO 消耗:回傳每筆 payment batch 的 remaining + 每筆日花費對應到哪些批次
//
// opts.publisherId(必填)
// opts.asOf(預設今天):只消耗 ≤ asOf 的安裝數;打款批次也只看 ≤ asOf
export function computeFIFO(state, opts = {}) {
  const publisherId = opts.publisherId;
  const asOf = opts.asOf || todayTaipei();
  if (!publisherId) throw new Error("computeFIFO requires opts.publisherId");

  const expenseRate = Number(state.settings?.expense_rate || 4.8);
  const payments = (state.payments || [])
    .filter((p) => p.publisher_id === publisherId && (p.date || "") <= asOf)
    .map((p) => ({ ...p, _remaining: Number(p.amount_rmb || 0) }))
    .sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") ||
      (a.created_at || "").localeCompare(b.created_at || "") ||
      a.id.localeCompare(b.id)
    );

  const dailyCosts = computeDailyCostsRMB(state, {
    publisherId,
    to: asOf,
  })
    .filter((d) => d.cost_rmb > 0)
    .sort((a, b) =>
      (a.date || "").localeCompare(b.date || "") ||
      a.channel_id.localeCompare(b.channel_id) ||
      a.product_id.localeCompare(b.product_id)
    );

  let shortfallRmb = 0;
  const enriched = dailyCosts.map((d) => {
    let remaining = d.cost_rmb;
    let twd = 0;
    const used = [];
    for (const b of payments) {
      if (remaining <= 0) break;
      if (b._remaining <= 0) continue;
      const take = Math.min(b._remaining, remaining);
      b._remaining -= take;
      twd += take * Number(b.exchange_rate || 0);
      used.push({ payment_id: b.id, rmb: take, rate: Number(b.exchange_rate || 0) });
      remaining -= take;
    }
    let warning = false;
    if (remaining > 0) {
      twd += remaining * expenseRate;
      used.push({ payment_id: null, rmb: remaining, rate: expenseRate, fallback: true });
      shortfallRmb += remaining;
      warning = true;
    }
    return { ...d, twd_cost: twd, batches_used: used, warning };
  });

  const batches = payments.map((b) => {
    const consumed = Number(b.amount_rmb || 0) - b._remaining;
    return {
      ...b,
      consumed_rmb: consumed,
      remaining_rmb: b._remaining,
    };
  });

  return {
    batches,
    dailyCosts: enriched,
    shortfall_rmb: shortfallRmb,
    expense_rate_fallback: expenseRate,
  };
}

// 站長餘額(RMB)= Σ 預付款 − Σ 結算費用
// 後結算站長的「餘額」可為負(代表廣告主應付站長的金額)
export function computePublisherBalance(state, publisherId, asOf) {
  asOf = asOf || todayTaipei();
  const paid = (state.payments || [])
    .filter((p) => p.publisher_id === publisherId && (p.date || "") <= asOf)
    .reduce((sum, p) => sum + Number(p.amount_rmb || 0), 0);

  const settled = computeDailyCostsRMB(state, { publisherId, to: asOf })
    .reduce((sum, d) => sum + d.cost_rmb, 0);

  return {
    paid_rmb: paid,
    settled_rmb: settled,
    balance_rmb: paid - settled,
  };
}

// 每位站長的 summary(用在概覽 / 帳務頁總覽)
export function summarizeAllPublishers(state, asOf) {
  asOf = asOf || todayTaipei();
  return (state.publishers || []).map((p) => {
    const bal = computePublisherBalance(state, p.id, asOf);
    const channelCount = (state.channels || []).filter((c) => c.publisher_id === p.id).length;
    return {
      publisher: p,
      ...bal,
      channel_count: channelCount,
    };
  });
}

// 線路 × 月份 metrics 矩陣,用於線路頁的成效視圖
//
// 回傳 Map<channel_id, {
//   channel, publisher_id,
//   total: { installs_raw, installs_billed, installs_unique, cost_rmb },
//   by_product: Map<product_id, { product_name, installs_raw, installs_billed, installs_unique, cost_rmb }>,
// }>
export function buildChannelMonthMatrix(state, yearMonth) {
  const from = `${yearMonth}-01`;
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

  const channels = state.channels || [];
  const products = state.products || [];
  const chById = Object.fromEntries(channels.map((c) => [c.id, c]));
  const prById = Object.fromEntries(products.map((p) => [p.id, p]));

  const matrix = new Map();
  const ensure = (channelId) => {
    if (!matrix.has(channelId)) {
      const ch = chById[channelId];
      matrix.set(channelId, {
        channel: ch,
        publisher_id: ch?.publisher_id,
        total: { installs_raw: 0, installs_billed: 0, installs_unique: 0, cost_rmb: 0 },
        by_product: new Map(),
      });
    }
    return matrix.get(channelId);
  };

  for (const d of state.install_data || []) {
    if (d.date < from || d.date > to) continue;
    const ch = chById[d.channel_id];
    const pr = prById[d.product_id];
    if (!ch || !pr) continue;

    const row = ensure(ch.id);
    if (!row.by_product.has(pr.id)) {
      row.by_product.set(pr.id, {
        product_id: pr.id,
        product_name: pr.name,
        installs_raw: 0,
        installs_billed: 0,
        installs_unique: 0,
        cost_rmb: 0,
      });
    }
    const pe = row.by_product.get(pr.id);
    const installsRaw = Number(d["廠商安裝"] || 0);
    const installsRounded = Math.round(installsRaw);
    const unique = Number(d["不重複安裝數"] || 0);
    const billable = isChannelBillableOn(ch, d.date);
    const cpaOn = pr.cpa_enabled !== false;
    const billed = billable && cpaOn ? installsRounded : 0;
    const price = getEffectivePrice(state, ch.id);
    const cost = billed * price;

    pe.installs_raw += installsRaw;
    pe.installs_billed += billed;
    pe.installs_unique += unique;
    pe.cost_rmb += cost;

    row.total.installs_raw += installsRaw;
    row.total.installs_billed += billed;
    row.total.installs_unique += unique;
    row.total.cost_rmb += cost;
  }

  // 沒有 install_data 的 channel 也加進 matrix(讓線路頁顯示全部)
  for (const ch of channels) {
    if (!matrix.has(ch.id)) {
      matrix.set(ch.id, {
        channel: ch,
        publisher_id: ch.publisher_id,
        total: { installs_raw: 0, installs_billed: 0, installs_unique: 0, cost_rmb: 0 },
        by_product: new Map(),
      });
    }
  }
  return matrix;
}

// 將 dailyCosts 依 publisher × month 彙總,用於對帳報表
export function aggregateByPublisherMonth(state, publisherId, yearMonth) {
  const from = `${yearMonth}-01`;
  const [y, m] = yearMonth.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

  const fifo = computeFIFO(state, { publisherId, asOf: to });
  const inPeriod = fifo.dailyCosts.filter((d) => d.date >= from && d.date <= to);

  // 期初餘額 = asOf = 月份前一天的餘額
  const prevDay = `${yearMonth}-01`;
  const dayBefore = (() => {
    const dt = new Date(Date.UTC(y, m - 1, 1, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  })();
  const openingBalance = computePublisherBalance(state, publisherId, dayBefore);

  const paymentsInPeriod = (state.payments || [])
    .filter((p) => p.publisher_id === publisherId && p.date >= from && p.date <= to)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  const totalSettledRMB = inPeriod.reduce((s, d) => s + d.cost_rmb, 0);
  const totalPaidInPeriod = paymentsInPeriod.reduce((s, p) => s + Number(p.amount_rmb || 0), 0);
  const closingBalance = openingBalance.balance_rmb - totalSettledRMB + totalPaidInPeriod;

  return {
    publisherId,
    yearMonth,
    from,
    to,
    opening_balance_rmb: openingBalance.balance_rmb,
    daily_costs: inPeriod,
    payments_in_period: paymentsInPeriod,
    total_settled_rmb: totalSettledRMB,
    total_paid_in_period_rmb: totalPaidInPeriod,
    closing_balance_rmb: closingBalance,
    shortfall_rmb: fifo.shortfall_rmb,
  };
}
