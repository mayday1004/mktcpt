import { getMonthlyBudget, getReportVars } from "../schema.js";
import { bandsForMonth, checkMonthlyTotal } from "./budget.js";
import { dailySpendGrid, monthlyTotals } from "./spending.js";
import { daysOfMonth, addDays, todayTaipei } from "../lib/dates.js";
import { scoreRecord } from "./perf-adjust.js";

// 「成效全爛」門檻 — 與 perf-adjust suggestEliminate 同一條線
const POOR_PERF_RATIO_THRESHOLD = 0.3;

// 評估某廣告對所有有權重產品的成效是否「全爛」
//   通過條件：每個有權重的產品都有成效紀錄、都有目標、score.ratio 都 < threshold
//   回傳：null（資料不齊或不算全爛）/ [{ productId, productName, ratio }]（每個產品的最差比例）
export function evaluatePoorPerf(state, ad) {
  const pids = Object.entries(ad.weights || {})
    .filter(([, w]) => Number(w) > 0)
    .map(([pid]) => pid);
  if (pids.length === 0) return null;

  const result = [];
  for (const pid of pids) {
    const product = state.products.find((p) => p.id === pid);
    const targets = product?.performance_targets || [];
    if (targets.length === 0) return null;  // 沒設目標，無從判定
    // 取該廣告對該產品的最新一筆成效紀錄
    const recs = (state.performance_data || []).filter((r) =>
      r.product_id === pid && (r.ad_code === ad.ad_code || r.ad_id === ad.id)
    ).sort((a, b) => (b.period_end || "").localeCompare(a.period_end || ""));
    if (recs.length === 0) return null;  // 缺資料
    const score = scoreRecord(recs[0], targets, getReportVars(state));
    if (!score || score.ratio == null) return null;
    if (score.ratio >= POOR_PERF_RATIO_THRESHOLD) return null;  // 任一產品達標就不算全爛
    result.push({ productId: pid, productName: product?.name || pid, ratio: score.ratio });
  }
  return result.length > 0 ? result : null;
}

// 計算當下要關心的事。回傳 [{kind, severity, msg, link, linkText}]
//   kind:    "budget" / "band" / "expiry" / "todo"
//   severity: "bad" / "warn" / "info"
//   link:    URL hash 例如 "#dashboard"，或 null
//
// 規則(與 §3 對齊,透過 checkMonthlyTotal 統一閾值):
// - budget: 多花太多 (bad/紅) / 少花太多 (warn/橘) / 容許內不告警(綠/不顯示)
// - band:   小島產品任一日峰值超過 band.upper(bad);APP 超過上限 (warn)
// - expiry: 7 天內 end_date 且尚未有續費段
// - todo:   pending todo > 3 天的數量
export function computeAlerts(state, ymd /* today YYYY-MM-DD */) {
  const ym = state.settings.current_month;
  const out = [];
  const today = ymd || todayTaipei();

  // ── 1. 月預算 ─────────────────────────────────────
  const totalsToUse = monthlyTotals(state.ads, ym);
  for (const p of state.products) {
    const budget = getMonthlyBudget(state, p.id, ym);
    if (budget == null) continue;
    const total = totalsToUse[p.id] || 0;
    const check = checkMonthlyTotal(total, budget, p.type);
    // 只有非「容許內」才需要告警
    if (check.kind === "bad" || check.kind === "warn") {
      out.push({ kind: "budget", severity: check.kind, msg: `${p.name} ${check.msg}`, link: "#dashboard" });
    }
  }

  // ── 2. 建議日花費（forward-only 分段檢查）────────────────
  // 只警示「當日及未來」— 過去日子已經花掉，無法調整
  const grid = dailySpendGrid(state.ads, ym);
  for (const p of state.products) {
    const budget = getMonthlyBudget(state, p.id, ym);
    if (budget == null) continue;
    const dayBands = bandsForMonth(state, p, ym);
    const breachDays = [];
    for (const d of daysOfMonth(ym)) {
      if (d < today) continue;  // 跳過過去日
      const b = dayBands[d];
      if (!b || !b.budget_set || b.upper <= 0) continue;
      const v = (grid[d] && grid[d][p.id]) || 0;
      if (v > b.upper) breachDays.push({ day: d, v, upper: b.upper });
    }
    if (breachDays.length === 0) continue;
    const sample = breachDays.slice(0, 3).map((b) => `${b.day.slice(5)} ${Math.round(b.v).toLocaleString()}`).join("、");
    const sev = p.type === "island" ? "bad" : "warn";
    out.push({
      kind: "band",
      severity: sev,
      msg: `${p.name} 未來有 ${breachDays.length} 天超出建議日花費上限：${sample}${breachDays.length > 3 ? "…" : ""}`,
      link: "#dashboard",
    });
  }

  // ── 3. 10 天內到期且尚未續費 ────────────────────
  // 先以 ad_name 分組去重（多段同名廣告只算一筆，取最早到期者）。
  // 超過 5 支廣告時改為單一摘要列，避免警告區被同類訊息淹沒；詳見「即將到期」卡。
  const horizon = addDays(today, 10);
  const renewed = new Set(state.ads.map((a) => a.renewal_of).filter(Boolean));
  const expiryByName = new Map();
  for (const a of state.ads) {
    if (a.eliminated) continue;  // 已淘汰：使用者明確不再追蹤
    if (a.end_date < today || a.end_date > horizon || renewed.has(a.id)) continue;
    const key = a.ad_name || a.ad_code;
    const days = Math.max(0, Math.round((Date.parse(a.end_date) - Date.parse(today)) / 86400000));
    if (!expiryByName.has(key) || days < expiryByName.get(key).days) {
      expiryByName.set(key, { ad: a, days });
    }
  }
  const expiryGrouped = [...expiryByName.values()].sort((a, b) => a.days - b.days);
  if (expiryGrouped.length > 5) {
    const earliest = expiryGrouped[0];
    out.push({
      kind: "expiry",
      severity: earliest.days <= 3 ? "bad" : earliest.days <= 7 ? "warn" : "info",
      msg: `${expiryGrouped.length} 支廣告 10 天內到期（最早：${earliest.ad.ad_name} ${earliest.days} 天）`,
      link: "#dashboard",
    });
  } else {
    for (const { ad, days } of expiryGrouped) {
      out.push({
        kind: "expiry",
        severity: days <= 3 ? "bad" : days <= 7 ? "warn" : "info",
        msg: `${ad.ad_name} ${days} 天後到期（${ad.end_date}）`,
        link: "#ads",
      });
    }
  }

  // ── 4. 超過 3 天還 pending 的待辦 ──────────────────
  const stalePendings = (state.todos || []).filter((t) => {
    if ((t.status || "pending") !== "pending") return false;
    if (!t.created_at) return false;
    const ageDays = (Date.parse(today) - Date.parse(t.created_at.slice(0, 10))) / 86400000;
    return ageDays >= 3;
  });
  if (stalePendings.length > 0) {
    out.push({
      kind: "todo",
      severity: "warn",
      msg: `${stalePendings.length} 筆待辦 pending 超過 3 天未完成`,
      link: "#todos",
    });
  }

  return out;
}

// 列出 N 天內到期的廣告（給概覽頁的「即將到期」卡用）
//
// 規則:
//   1. 以「renewal chain 尾段」為單位 = 沒被任何段 renewal_of 指到的段
//      - 共購廣告(1 個 ad record)→ 1 個尾段
//      - 獨立採買 N 個產品共代碼 → N 個尾段(每個產品線一個)
//        例:st100 色狗导航 由 AV9 / JK / HYC 各買 100% → 3 個獨立 ad → 3 個尾段
//        舊邏輯只取 latestByCode 一筆,會讓另外 2 個產品在「即將到期」卡漏失產品 pill。
//   2. 已淘汰的段跳過
//   3. 「送天數」/「送天數結束」是舊系統的暫時段(實務上不應該還是鏈尾),防呆跳過
//   4. 渲染端(renderExpiringCard / dashboard renderActionRequired)會用 ad_name 二次去重,
//      所以同一支廣告的多個尾段仍然合併成一列,但所有產品 pill 都會列出
export function expiringAds(state, days = 10, todayYmd) {
  const today = todayYmd || todayTaipei();
  const horizon = addDays(today, days);
  const SKIP_REASONS = new Set(["送天數", "送天數結束"]);

  const referenced = new Set(state.ads.map((a) => a.renewal_of).filter(Boolean));

  const out = [];
  for (const a of state.ads) {
    if (a.eliminated) continue;
    if (!a.end_date) continue;
    if (referenced.has(a.id)) continue;  // 不是鏈尾:已被後續段取代
    if (a.end_date < today || a.end_date > horizon) continue;
    if (SKIP_REASONS.has(a.renewal_reason)) continue;
    out.push({
      ad: a,
      daysLeft: Math.max(0, Math.round((Date.parse(a.end_date) - Date.parse(today)) / 86400000)),
      poorPerf: evaluatePoorPerf(state, a),
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}

