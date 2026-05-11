import { getState, update, uid } from "../state.js";
import { isNoBand, getMonthlyBudget } from "../schema.js";
import { buildAdPivot, previewImpact, computeProductBudgetStatus } from "../domain/perf-adjust.js";
import { buildWeightAdjust } from "../domain/lifecycle.js";
import { todayTaipei, nowTaipeiStamp, daysOfMonth } from "../lib/dates.js";
import { detectFutureGaps, detectShortfalls, detectAppMonthlyUnderspend } from "../domain/gift-days.js";
import { openGiftDayFixModal } from "./gift-day-fix-modal.js";
import { checkMonthlyTotal, bandsForMonth } from "../domain/budget.js";
import { captureUndoSnapshot } from "../domain/undo.js";
import { dailySpendGrid } from "../domain/spending.js";
import { projectAdsWithRenewals } from "../domain/renewal-projection.js";

// 模組級狀態：使用者覆寫的「該廣告該產品 final 權重」
// key: `${adId}|${pid}` → number
let pending = new Map();

// 已勾選「同意套用」的廣告 id 集合：批量送出時只處理這些
// 鎖定 (🔒) = 該廣告不被自動建議影響；勾選同意 = 把建議套用上去
// 兩者獨立：可以鎖定後又勾選（沒意義，自動會忽略）；也可不鎖但不勾選（建議顯示但不送出）
let agreedAdIds = new Set();

// 過濾模式：all / changed / hasdata
let filterMode = "changed";
// 影響表是否摺疊 APP 列（預設展開）
let collapseApp = false;
// 套用後預估 區塊摺疊（預設摺疊）
let collapseImpact = true;
// 「展開全部產品」狀態 (CLAUDE.md §5.4.2)：哪些 ad 的權重欄要顯示全部 11 個產品 (含 0%)
let expandedAds = new Set();
let spendScenario = "renewal";
let autoAgreedSignature = "";

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;

  const scenario = scenarioFor(s, ym);
  const pivotAll = buildAdPivot(scenario.state, ym);
  const pivot = pivotAll.filter((e) => !e.ad.projected_renewal);
  if (pivot.length === 0) {
    root.innerHTML = `
      <div class="view-head">
        <div><h1>權重調整</h1></div>
      </div>
      <div class="card"><p class="ink-2">尚無任何廣告。</p></div>
    `;
    return;
  }

  // 計算「列上要顯示的權重」(pending > suggested > old) — 給下方表格用
  // 也納入 pending 對「不在 perProduct 的產品」(使用者手動加的 0%→N%)
  const newWeightsByAd = {};
  for (const e of pivotAll) {
    const final = { ...e.oldWeights };
    const handled = new Set();
    for (const pp of e.perProduct) {
      const key = `${e.ad.id}|${pp.product.id}`;
      const overridden = pending.get(key);
      const w = overridden != null ? overridden : pp.new;
      if (w > 0) final[pp.product.id] = w;
      else delete final[pp.product.id];
      handled.add(pp.product.id);
    }
    // pending 對未在 perProduct 的產品(手動加的 0% → N%)
    for (const [k, w] of pending.entries()) {
      const prefix = e.ad.id + "|";
      if (!k.startsWith(prefix)) continue;
      const pid = k.slice(prefix.length);
      if (handled.has(pid)) continue;
      if (w > 0) final[pid] = w;
      else delete final[pid];
    }
    newWeightsByAd[e.ad.id] = final;
  }
  syncDefaultAgreed(pivot, newWeightsByAd);

  // 影響預覽只反映「✓套用」勾選的廣告(CLAUDE.md §5.4.1)
  // 未勾選 = 原權重不動。手動覆寫但未勾,也不算進預覽。
  const effectiveWeightsByAd = {};
  for (const e of pivotAll) {
    effectiveWeightsByAd[e.ad.id] = agreedAdIds.has(e.ad.id)
      ? newWeightsByAd[e.ad.id]
      : { ...e.oldWeights };
  }
  const impact = previewImpact(scenario.state, ym, effectiveWeightsByAd);

  // 每產品的預算狀態(headroom 提示用,CLAUDE.md §5.4.2)
  const productStatus = computeProductBudgetStatus(scenario.state, ym, pivotAll);

  // 過濾廣告
  const filtered = pivot.filter((e) => {
    const oldW = e.oldWeights;
    const newW = newWeightsByAd[e.ad.id];
    const changed = !sameWeights(oldW, newW);
    const hasData = e.perProduct.some((pp) => pp.score && pp.score.ratio != null);
    if (filterMode === "changed") return changed;
    if (filterMode === "hasdata") return hasData;
    return true;
  });

  // 廣告調整入口(CLAUDE.md §5.8 v2):當有 shortfall 或 APP 月攤提少花 > 6 萬時顯示一鍵入口
  // 用 scenario.state(已套用續費 projection)— 跟 pivot baseline 對齊,只剩真實缺口才會出現
  const shortfalls = detectShortfalls(scenario.state, todayTaipei());
  const underspends = detectAppMonthlyUnderspend(scenario.state, todayTaipei());
  const totalIssues = shortfalls.length + underspends.length;
  const giftDayBanner = totalIssues > 0 ? `
    <div class="card" style="border-left:3px solid var(--warn);background:#fffbf0;margin-bottom:12px">
      <div class="card-head">
        <h3 style="margin:0;font-size:14px">🎁 偵測到 ${shortfalls.length > 0 ? `${shortfalls.length} 個產品日花費低於下限` : ""}${shortfalls.length > 0 && underspends.length > 0 ? "、" : ""}${underspends.length > 0 ? `${underspends.length} 個 APP 產品月攤提少花 > 6 萬` : ""}</h3>
        <button class="primary" id="pa-gd-fix-open">→ 一鍵調整</button>
      </div>
      <div class="ink-2" style="font-size:12px;line-height:1.7;margin-top:6px">
        系統會按優先序(小島補下限 → APP 補月預算 → APP 補下限)從可借的廣告挪權重。可在彈窗內勾選或取消個別調整。
      </div>
    </div>
  ` : "";

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>權重調整</h1>
        <div class="desc">以廣告為主：左欄原權重、右欄系統建議；可手動覆寫或鎖定整支廣告不調。<br>建議有兩道安全限制:未來日花費高峰 ≤ 建議日花費上限(破圈產品跳過) + 月攤提合計 ≤ 月預算(破圈/小島/APP 一律強制)。月攤提 = 過去實際攤提 + 未來依權重計算的金額。</div>
      </div>
    </div>

    ${giftDayBanner}

    ${renderImpactSummary(impact)}

    ${renderImpactDailyGrid(scenario.state, ym, effectiveWeightsByAd, scenario)}

    <div class="card perf-advice-card">
      <div class="card-head">
        <h2>廣告調整建議</h2>
        <div class="ink-3">勾選「✓套用」表示同意這筆建議,最後批量送出;鎖定狀態 🔓自由 / 🔒鎖權重(可整桶搬) / 🚫禁止挪動,點擊圖示循環切換</div>
      </div>

      <div class="filter-row">
        <span class="ink-3" style="font-size:12px">顯示：</span>
        <button class="filter-chip ${filterMode === "changed" ? "active" : ""}" data-filter="changed">會變動的（${pivot.filter((e) => !sameWeights(e.oldWeights, newWeightsByAd[e.ad.id])).length}）</button>
        <button class="filter-chip ${filterMode === "hasdata" ? "active" : ""}" data-filter="hasdata">有成效資料的（${pivot.filter((e) => e.perProduct.some((pp) => pp.score && pp.score.ratio != null)).length}）</button>
        <button class="filter-chip ${filterMode === "all" ? "active" : ""}" data-filter="all">全部（${pivot.length}）</button>
        <span class="ink-3" style="margin-left:auto;font-size:12px">
          <button class="link-btn" id="btn-agree-all-changed">全選有變動</button>
          ·
          <button class="link-btn" id="btn-agree-none">全不選</button>
        </span>
      </div>

      ${filtered.length === 0 ? `
        <div class="empty">此過濾沒有匹配的廣告</div>
      ` : `
        ${renderEditableAdviceCards(filtered, s, newWeightsByAd)}
      `}

      <div class="modal-actions" style="margin-top:16px">
        <button id="btn-reset">重置為系統建議</button>
        <button class="primary" id="btn-apply">套用已勾選的 ${countAgreedChanges(pivot, newWeightsByAd)} 筆 → 開新權重段</button>
      </div>
    </div>
  `;

  bindHandlers(root, pivot, newWeightsByAd);
}

function isApplicableChange(entry, newWeightsByAd) {
  const today = todayTaipei();
  if (!entry?.ad) return false;
  if (entry.ad.lock_perf_adjust && !entry.transferTarget) return false;
  if (!entry.ad.end_date || entry.ad.end_date <= today) return false;
  if (entry.suggestEliminate) return false;
  return !sameWeights(entry.oldWeights || {}, newWeightsByAd[entry.ad.id] || {});
}

function syncDefaultAgreed(pivot, newWeightsByAd) {
  const applicableIds = pivot
    .filter((e) => isApplicableChange(e, newWeightsByAd))
    .map((e) => e.ad.id)
    .sort();
  const signature = applicableIds.join("|");
  if (signature === autoAgreedSignature) return;
  autoAgreedSignature = signature;
  const valid = new Set(applicableIds);
  for (const id of [...agreedAdIds]) {
    if (!valid.has(id)) agreedAdIds.delete(id);
  }
  for (const id of applicableIds) agreedAdIds.add(id);
}

function renderAdviceList(entries, state, newWeightsByAd) {
  const productNameOf = Object.fromEntries((state.products || []).map((p) => [p.id, p.name]));
  const rows = entries.map((entry) => {
    const ad = entry.ad;
    const newW = newWeightsByAd[ad.id] || {};
    const applicable = isApplicableChange(entry, newWeightsByAd);
    const checked = applicable && agreedAdIds.has(ad.id);
    const lockState = ad.lock_full ? "full" : (ad.lock_perf_adjust ? "weight" : "free");
    const lockIconMap = { free: "🔓", weight: "🔒", full: "🚫" };
    const oldSum = sumWeights(entry.oldWeights);
    const newSum = sumWeights(newW);
    const changeText = describeWeightChange(entry.oldWeights || {}, newW, productNameOf);
    const note = entry.suggestEliminate
      ? `<span class="pill bad">建議淘汰</span>`
      : entry.transferTarget
        ? `<span class="pill warn">整桶搬 → ${esc(productNameOf[entry.transferTarget] || entry.transferTarget)}</span>`
        : applicable
          ? `<span class="pill ok">可套用</span>`
          : `<span class="pill">無法套用</span>`;
    const action = entry.suggestEliminate
      ? `<button class="primary danger eliminate-action" data-eliminate="${esc(ad.id)}">淘汰</button>`
      : "";
    return `
      <tr>
        <td style="width:42px;text-align:center">
          <input type="checkbox" class="agree-toggle" data-agree-adid="${esc(ad.id)}" ${checked ? "checked" : ""} ${applicable ? "" : "disabled"} />
        </td>
        <td style="width:42px;text-align:center">
          <button class="lock-btn ${lockState !== "free" ? "locked" : ""}" data-lock-adid="${esc(ad.id)}" title="切換鎖定狀態">${lockIconMap[lockState]}</button>
        </td>
        <td class="mono" style="width:96px">${esc(ad.ad_code || "")}</td>
        <td>
          <strong>${esc(ad.ad_name || "")}</strong>
          <div class="ink-3" style="font-size:11px">${esc(ad.start_date || "")} ~ ${esc(ad.end_date || "")}</div>
        </td>
        <td>${changeText}</td>
        <td class="num" style="width:92px">${oldSum}% → <strong>${newSum}%</strong></td>
        <td style="width:120px">${note} ${action}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="table-wrap" style="padding:14px 18px 18px;max-height:620px;overflow:auto">
      <table class="perf-adjust-list" style="font-size:12px">
        <thead>
          <tr>
            <th>套用</th>
            <th>鎖定</th>
            <th>代碼</th>
            <th>廣告</th>
            <th>權重變化</th>
            <th class="num">合計</th>
            <th>狀態</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderEditableAdviceCards(entries, state, newWeightsByAd) {
  return `
    <div style="display:flex;flex-direction:column;gap:12px;padding:14px 18px 18px">
      ${entries.map((entry) => renderEditableAdviceCard(entry, state, newWeightsByAd)).join("")}
    </div>
  `;
}

function renderEditableAdviceCard(entry, state, newWeightsByAd) {
  const ad = entry.ad;
  const productNameOf = Object.fromEntries((state.products || []).map((p) => [p.id, p.name]));
  const oldWeights = entry.oldWeights || {};
  const newWeights = newWeightsByAd[ad.id] || {};
  const applicable = isApplicableChange(entry, newWeightsByAd);
  const checked = applicable && agreedAdIds.has(ad.id);
  const lockState = ad.lock_full ? "full" : (ad.lock_perf_adjust ? "weight" : "free");
  const lockedAd = !!ad.lock_perf_adjust;
  const lockIconMap = { free: "🔓", weight: "🔒", full: "🚫" };
  const lockTitleMap = {
    free: "自由 — 自動建議可改權重",
    weight: "鎖權重 — 權重比例不變,但可整桶搬",
    full: "禁止挪動 — 不納入自動建議",
  };
  const isExpanded = expandedAds.has(ad.id);
  const includedIds = new Set();
  if (isExpanded) {
    for (const p of state.products || []) includedIds.add(p.id);
  } else {
    for (const pid of Object.keys(oldWeights)) if (Number(oldWeights[pid]) > 0) includedIds.add(pid);
    for (const pid of Object.keys(newWeights)) if (Number(newWeights[pid]) > 0) includedIds.add(pid);
    for (const pp of entry.perProduct || []) {
      if (pp.systemAdded || Number(pp.new) > 0 || Number(pp.old) > 0) includedIds.add(pp.product.id);
    }
    for (const [k, w] of pending.entries()) {
      const prefix = ad.id + "|";
      if (k.startsWith(prefix) && Number(w) > 0) includedIds.add(k.slice(prefix.length));
    }
  }
  let products = (state.products || []).filter((p) => includedIds.has(p.id));
  products = products.sort((a, b) => {
    const wa = Number(oldWeights[a.id]) || 0;
    const wb = Number(oldWeights[b.id]) || 0;
    if (wa !== wb) return wb - wa;
    return a.name.localeCompare(b.name);
  });
  const hiddenCount = Math.max(0, (state.products || []).length - products.length);

  const rows = products.map((p) => {
    const key = `${ad.id}|${p.id}`;
    const oldW = Math.round(Number(oldWeights[p.id]) || 0);
    const suggestedW = Math.round(Number(newWeights[p.id]) || 0);
    const finalW = pending.has(key) ? Math.round(Number(pending.get(key)) || 0) : suggestedW;
    const delta = finalW - oldW;
    const deltaCls = delta > 0 ? "delta-up" : delta < 0 ? "delta-down" : "delta-zero";
    const deltaText = delta > 0 ? `↑ +${delta}` : delta < 0 ? `↓ ${delta}` : "→ 0";
    const pp = (entry.perProduct || []).find((x) => x.product.id === p.id);
    const scoreCell = formatScoreCell(pp, false);
    const systemAdded = oldW === 0 && finalW > 0;
    const rowCls = systemAdded ? "system-added-row" : (oldW === 0 && finalW === 0 ? "zero-row" : "");
    return `
      <tr class="${rowCls}">
        <td style="padding:9px 12px;border-bottom:1px solid #f1f3f7">${esc(p.name)} <span class="pill ${p.type}" style="font-size:10px;margin-left:4px">${p.type === "app" ? "APP" : "小島"}</span></td>
        <td class="num" style="padding:9px 12px;border-bottom:1px solid #f1f3f7">${oldW}%</td>
        <td class="num" style="padding:9px 12px;text-align:center;border-bottom:1px solid #f1f3f7">
          <span class="weight-input-wrap">
            <input type="number" min="0" max="100" step="1" class="w-input"
              data-adid="${esc(ad.id)}" data-pid="${esc(p.id)}"
              value="${finalW}" ${lockedAd ? "disabled" : ""} />
          </span>
        </td>
        <td class="num" style="padding:9px 12px;text-align:right;border-bottom:1px solid #f1f3f7"><span class="${deltaCls}">${deltaText}</span></td>
        <td style="padding:9px 12px;border-bottom:1px solid #f1f3f7">${scoreCell}</td>
        <td class="ink-2" style="padding:9px 12px;border-bottom:1px solid #f1f3f7;font-size:12px">${editableReason(pp, delta, entry, p.id)}</td>
      </tr>
    `;
  }).join("");

  const oldSum = sumWeights(oldWeights);
  const newSum = sumWeights(currentWeightsFromProducts(products, oldWeights, newWeights, ad.id));
  const sumCls = newSum === 100 ? "ok" : newSum > 100 ? "bad" : "warn";
  const statusTag = entry.suggestEliminate
    ? `<span class="pill bad">建議淘汰</span>`
    : entry.transferTarget
      ? `<span class="pill warn">整桶搬 → ${esc(productNameOf[entry.transferTarget] || entry.transferTarget)}</span>`
      : applicable
        ? `<span class="pill ok">可套用</span>`
        : `<span class="pill">無法套用</span>`;
  const toggleExpandBtn = isExpanded
    ? `<button class="link-btn" data-toggle-expand="${esc(ad.id)}">⊖ 收起</button>`
    : hiddenCount > 0
      ? `<button class="link-btn" data-toggle-expand="${esc(ad.id)}">⊕ 展開全部產品 (還有 ${hiddenCount} 個)</button>`
      : "";
  return `
    <div style="border:1px solid ${checked ? "#b8dfc5" : "#dfe4ec"};border-radius:8px;background:${checked ? "#fbfffc" : "#fff"};overflow:hidden">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-height:50px;padding:10px 14px;background:${checked ? "#f0faf4" : "#f8fafc"};border-bottom:1px solid #edf0f5">
        <span style="display:inline-flex;align-items:center;justify-content:center;min-width:22px">
          <input type="checkbox" class="agree-toggle" data-agree-adid="${esc(ad.id)}" ${checked ? "checked" : ""} ${applicable ? "" : "disabled"} />
        </span>
        <button class="lock-btn ${lockState !== "free" ? "locked" : ""}" data-lock-adid="${esc(ad.id)}" title="${esc(lockTitleMap[lockState])}">${lockIconMap[lockState]}</button>
        <span class="mono ad-code-tag">${esc(ad.ad_code || "")}</span>
        <strong class="ad-name">${esc(ad.ad_name || "")}</strong>
        <span class="ad-period ink-3">${esc(ad.start_date || "")} ~ ${esc(ad.end_date || "")}</span>
        ${statusTag}
        <span style="flex:1"></span>
        <span class="ink-3" style="font-size:11px">原合計 ${oldSum}%</span>
        <span class="weight-sum-badge ${sumCls}">合計 <strong>${newSum}%</strong></span>
      </div>
      <div style="overflow:auto">
      <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px">
        <colgroup>
          <col style="width:160px">
          <col style="width:84px">
          <col style="width:122px">
          <col style="width:88px">
          <col style="width:260px">
          <col>
        </colgroup>
        <thead>
          <tr>
            <th style="padding:8px 12px;text-align:left;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">產品</th>
            <th class="num" style="padding:8px 12px;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">原權重</th>
            <th class="num" style="padding:8px 12px;text-align:center;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">建議權重</th>
            <th style="padding:8px 12px;text-align:right;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">變化</th>
            <th style="padding:8px 12px;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">成效</th>
            <th style="padding:8px 12px;background:#fff;border-bottom:1px solid #eef1f6;color:var(--ink-3);font-size:11px">建議結果</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
      ${toggleExpandBtn ? `<div style="padding:6px 14px;background:#fafbfc;border-top:1px solid #f0f2f6;font-size:12px">${toggleExpandBtn}</div>` : ""}
    </div>
  `;
}

function currentWeightsFromProducts(products, oldWeights, newWeights, adId) {
  const out = { ...(newWeights || {}) };
  for (const p of products || []) {
    const key = `${adId}|${p.id}`;
    if (pending.has(key)) {
      const v = Math.round(Number(pending.get(key)) || 0);
      if (v > 0) out[p.id] = v;
      else delete out[p.id];
    } else if ((oldWeights[p.id] || newWeights[p.id]) && !(p.id in out)) {
      out[p.id] = Math.round(Number(newWeights[p.id]) || 0);
    }
  }
  return out;
}

function editableReason(pp, delta, entry, pid) {
  if (entry.transferTarget && pid === entry.transferTarget) return `<span class="ok">接收該廣告</span>`;
  if (entry.transferSourcePid && pid === entry.transferSourcePid) return `<span class="bad">整個挪走</span>`;
  if (pp?.systemAdded) return `<span class="ok">系統新增產品</span>`;
  if (delta > 0) return `<span class="ok">接收權重</span>`;
  if (delta < 0) return `<span class="bad">削減權重</span>`;
  return `<span class="ink-3">維持</span>`;
}

function sumWeights(weights) {
  return Object.values(weights || {}).reduce((sum, v) => sum + Math.round(Number(v) || 0), 0);
}

function describeWeightChange(oldWeights, newWeights, productNameOf) {
  const pids = new Set([...Object.keys(oldWeights || {}), ...Object.keys(newWeights || {})]);
  const changes = [...pids]
    .map((pid) => {
      const oldW = Math.round(Number(oldWeights[pid]) || 0);
      const newW = Math.round(Number(newWeights[pid]) || 0);
      return { pid, oldW, newW, delta: newW - oldW };
    })
    .filter((x) => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (changes.length === 0) return `<span class="ink-3">維持原權重</span>`;
  const shown = changes.slice(0, 5).map((x) => {
    const cls = x.delta > 0 ? "delta-up" : "delta-down";
    const sign = x.delta > 0 ? "+" : "";
    return `<span class="${cls}">${esc(productNameOf[x.pid] || x.pid)} ${x.oldW}% → ${x.newW}% (${sign}${x.delta}%)</span>`;
  }).join("<br>");
  const more = changes.length > 5 ? `<div class="ink-3" style="font-size:11px">另 ${changes.length - 5} 項變化</div>` : "";
  return shown + more;
}

function scenarioFor(state, ym) {
  if (spendScenario !== "renewal") {
    return { state, virtualRenewals: [], excludedPoorPerf: [] };
  }
  const projection = projectAdsWithRenewals(state, ym, { fromDate: todayTaipei(), excludePoorPerf: true });
  return {
    state: { ...state, ads: projection.ads },
    virtualRenewals: projection.virtualRenewals,
    excludedPoorPerf: projection.excludedPoorPerf,
  };
}

function uniqueByCode(ads) {
  const seen = new Set();
  const out = [];
  for (const ad of ads || []) {
    const key = ad.ad_code || ad.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ad);
  }
  return out;
}

function renderImpactSummary(impacts) {
  const islands = impacts.filter((c) => c.product.type === "island");
  const apps = impacts.filter((c) => c.product.type === "app");
  const visible = collapseApp ? islands : impacts;

  // 共用:把數字變成「↑ +X」或「↓ -X」或「持平」(花費上升=綠、下降=紅)
  const fmtDelta = (d) => {
    if (d === 0) return `<span class="impact-delta zero">→ 持平</span>`;
    const cls = d > 0 ? "up" : "down";
    const arrow = d > 0 ? "↑" : "↓";
    const sign = d > 0 ? "+" : "";
    return `<span class="impact-delta ${cls}">${arrow} ${sign}${Math.round(d).toLocaleString()}</span>`;
  };

  const rows = visible.map((c) => {
    const { product, budget, band, oldTotal, newTotal, oldDailyPeak, newDailyPeak, oldPeakDay, newPeakDay } = c;
    const totalDelta = newTotal - oldTotal;
    const peakDelta = newDailyPeak - oldDailyPeak;
    const isIsland = product.type === "island";
    const checkBand = !isNoBand(product);

    // 月預算狀態(用 checkMonthlyTotal 統一閾值;APP/小島自動套對應 tolerance)
    const monthCheck = budget != null ? checkMonthlyTotal(newTotal, budget, product.type) : null;
    const monthKind = monthCheck?.kind || "ink-3";
    const monthBadge = monthCheck
      ? `<span class="pill ${monthKind}" style="font-size:11px;margin-top:4px;display:inline-block">${monthCheck.msg}</span>`
      : `<span class="ink-3" style="font-size:11px">未設預算</span>`;

    // 評估:新日花費對照建議日花費區間
    let evalCell;
    if (!checkBand) {
      evalCell = `<span class="pill" style="background:#eef1f6;color:var(--ink-3);font-size:11px">不檢查(破圈)</span>`;
    } else if (band.upper <= 0 || budget == null) {
      evalCell = `<span class="pill" style="background:#eef1f6;color:var(--ink-3);font-size:11px">未設預算</span>`;
    } else if (newDailyPeak > band.upper) {
      const over = newDailyPeak - band.upper;
      evalCell = `<span class="pill bad" style="font-size:11px">✗ 超出上限 +${Math.round(over).toLocaleString()}</span>
        <div class="ink-3" style="font-size:10px;margin-top:3px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    } else if (newDailyPeak < band.lower && newDailyPeak > 0) {
      const under = band.lower - newDailyPeak;
      evalCell = `<span class="pill warn" style="font-size:11px">⚠ 低於下限 -${Math.round(under).toLocaleString()}</span>
        <div class="ink-3" style="font-size:10px;margin-top:3px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    } else {
      evalCell = `<span class="pill ok" style="font-size:11px">✓ 在區間內</span>
        <div class="ink-3" style="font-size:10px;margin-top:3px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    }

    return `
      <tr class="${isIsland ? "island-row" : ""} impact-row impact-row-${monthKind}">
        <td>
          <strong>${esc(product.name)}</strong>
          <span class="pill ${product.type}" style="margin-left:6px;font-size:10px">${product.type === "app" ? "APP" : "小島"}</span>
        </td>
        <td class="num">${budget != null ? Math.round(budget).toLocaleString() : "<span class='ink-3'>未設</span>"}</td>
        <td class="num">
          <div class="impact-cell-main"><strong class="${monthKind}">${Math.round(newTotal).toLocaleString()}</strong></div>
          <div class="impact-cell-sub">原 ${Math.round(oldTotal).toLocaleString()} ${fmtDelta(totalDelta)}</div>
          <div>${monthBadge}</div>
        </td>
        <td class="num">
          <div class="impact-cell-main"><strong>${Math.round(newDailyPeak).toLocaleString()}</strong></div>
          <div class="impact-cell-sub">原 ${Math.round(oldDailyPeak).toLocaleString()} ${fmtDelta(peakDelta)}</div>
          ${newPeakDay ? `<div class="ink-3" style="font-size:10px">於 ${newPeakDay.slice(5)}</div>` : ""}
        </td>
        <td>${evalCell}</td>
      </tr>
    `;
  }).join("");

  const chevron = collapseImpact ? "▶" : "▼";
  return `
    <div class="card perf-impact-card">
      <div class="card-head">
        <h2 id="btn-toggle-impact" style="cursor:pointer;user-select:none">${chevron} 套用後預估</h2>
        <div class="ink-3" style="font-size:12px">
          顯示套用建議調整後,每個產品月攤提與日花費的變化
          ${!collapseImpact && apps.length > 0 ? `<button id="btn-toggle-app" class="link-btn" style="margin-left:8px">${collapseApp ? `展開 APP(${apps.length})` : "只看小島"}</button>` : ""}
        </div>
      </div>
      ${collapseImpact ? "" : `
      <div class="impact-legend">
        <span class="impact-legend-item"><span class="pill ok" style="font-size:10px">綠</span> 容許範圍內</span>
        <span class="impact-legend-item"><span class="pill warn" style="font-size:10px">橘</span> 少花太多</span>
        <span class="impact-legend-item"><span class="pill bad" style="font-size:10px">紅</span> 多花太多</span>
      </div>
      <div class="table-wrap">
        <table class="impact-table">
          <colgroup>
            <col style="width:120px">
            <col>
            <col>
            <col>
            <col style="width:170px">
          </colgroup>
          <thead>
            <tr>
              <th>產品</th>
              <th class="num">月預算</th>
              <th class="num">月花費(新 / 原 → 變化)</th>
              <th class="num">日花費(新 / 原 → 變化)</th>
              <th>評估</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      `}
    </div>
  `;
}

// 套用後每日攤提預覽
// 用 effectiveWeightsByAd(只反映「✓套用」勾選的廣告)patch 廣告權重,跟原始 grid 對比。
// 每格主數字 = 套用後值;有變化的同時顯示 ↑ +X 或 ↓ -X。
// 紅底 = 該日超出建議花費上限;橘底 = 低於下限。
function renderImpactDailyGrid(state, ym, effectiveWeightsByAd, scenario = null) {
  if (!state || !ym) return "";
  const today = todayTaipei();

  // 把 ads 的 weights 換成 effective(只 patch 有勾選的)
  // ★ 權重變更只影響今日及未來 — 對 active 段在 today 切兩半:過去用原 weights、未來用新 weights
  const patchedAds = [];
  for (const a of state.ads) {
    const eff = effectiveWeightsByAd[a.id];
    if (!eff || sameWeights(a.weights || {}, eff)) {
      patchedAds.push(a);
      continue;
    }
    if (a.start_date >= today) {
      // 整段都還沒開始 → 新 weights 套到整段(不影響過去,因為沒過去)
      patchedAds.push({ ...a, weights: eff });
    } else if (a.end_date <= today) {
      // 整段已結束 → 不該改(理論上不會走到這,因為 applyAll 已過濾)
      patchedAds.push(a);
    } else {
      // active 段 → 切兩半:[start, today) 原 weights、[today, end) 新 weights
      patchedAds.push({ ...a, end_date: today });
      patchedAds.push({ ...a, id: `${a.id}__preview_new`, start_date: today, weights: eff });
    }
  }

  const newGrid = dailySpendGrid(patchedAds, ym);
  const oldGrid = dailySpendGrid(state.ads, ym);
  const products = state.products || [];
  const monthDays = [...daysOfMonth(ym)];
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(state, p, ym)]));

  // 月合計
  const newTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  const oldTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  let newGrand = 0, oldGrand = 0;
  let anyChanged = false;

  const bodyRows = monthDays.map((d) => {
    const newRow = newGrid[d] || {};
    const oldRow = oldGrid[d] || {};
    let newDayTotal = 0, oldDayTotal = 0;
    const cells = products.map((p) => {
      const newAmt = newRow[p.id] || 0;
      const oldAmt = oldRow[p.id] || 0;
      newDayTotal += newAmt;
      oldDayTotal += oldAmt;
      newTotals[p.id] += newAmt;
      oldTotals[p.id] += oldAmt;
      const delta = newAmt - oldAmt;
      if (Math.abs(delta) >= 0.5) anyChanged = true;
      const b = dayBandsByPid[p.id]?.[d];
      const isFuture = d >= today;
      const checkBand = isFuture && b && b.budget_set && !isNoBand(p) && newAmt > 0;
      const isUnder = checkBand && newAmt < b.lower;
      const isOver = checkBand && newAmt > b.upper;
      const cls = `num ${isUnder ? "dg-under-band" : ""} ${isOver ? "dg-over-band" : ""} ${d < today ? "dg-past" : ""}`;
      let inner;
      if (newAmt === 0 && oldAmt === 0) {
        inner = "<span class='ink-3'>—</span>";
      } else {
        inner = `${Math.round(newAmt).toLocaleString()}`;
        if (Math.abs(delta) >= 0.5) {
          const deltaSign = delta > 0 ? "+" : "";
          const deltaCls = delta > 0 ? "delta-up" : "delta-down";
          inner += `<div class="${deltaCls}" style="font-size:10px;font-weight:500">${deltaSign}${Math.round(delta).toLocaleString()}</div>`;
        }
      }
      return `<td class="${cls}">${inner}</td>`;
    }).join("");
    newGrand += newDayTotal;
    oldGrand += oldDayTotal;
    const todayCls = d === today ? " dg-today" : "";
    return `<tr class="${todayCls.trim()}">
      <td class="mono">${d.slice(5)}${d === today ? " <span class='pill' style='font-size:10px;padding:0 4px;margin-left:2px;background:#111;color:#fff'>今天</span>" : ""}</td>
      ${cells}
      <td class="num"><strong>${Math.round(newDayTotal).toLocaleString()}</strong></td>
    </tr>`;
  }).join("");

  // 月合計列
  const footerCells = products.map((p) => {
    const newT = newTotals[p.id];
    const oldT = oldTotals[p.id];
    const budget = getMonthlyBudget(state, p.id, ym) || 0;
    const diff = newT - budget;
    const delta = newT - oldT;
    const diffClass = !budget ? "ink-3" : diff > 10000 ? "bad" : diff > 0 ? "warn" : -diff > 20000 ? "warn" : "ok";
    let deltaTag = "";
    if (Math.abs(delta) >= 0.5) {
      const deltaSign = delta > 0 ? "+" : "";
      const deltaCls = delta > 0 ? "delta-up" : "delta-down";
      deltaTag = `<div class="${deltaCls}" style="font-size:10px">${deltaSign}${Math.round(delta).toLocaleString()}</div>`;
    }
    return `<td class="num dg-foot">
      <strong>${Math.round(newT).toLocaleString()}</strong>
      ${deltaTag}
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const headerCells = products.map((p) => `<th class="num">${esc(p.name)}</th>`).join("");

  const subhint = anyChanged
    ? "綠色 = 套用後增加,紅色 = 減少。紅底 = 該日超出建議花費上限,橘底 = 低於下限。"
    : `目前沒有勾選任何「✓套用」,下表 = ${spendScenario === "renewal" ? "續費預估" : "實際資料"}每日攤提(無變化)。勾選下方建議後此表會即時反映變化。`;
  const scenarioNote = spendScenario === "renewal" && scenario
    ? `<div class="ink-3" style="font-size:12px">已含 ${uniqueByCode(scenario.virtualRenewals).length} 支預估續費廣告；虛擬續費段只參與 baseline，不會被批量套用。</div>`
    : "";
  const scenarioChips = `
    <div style="display:flex;align-items:center;gap:6px">
      <span class="ink-3" style="font-size:12px">攤提模式：</span>
      <button class="filter-chip ${spendScenario === "renewal" ? "active" : ""}" data-spend-scenario="renewal">續費預估</button>
      <button class="filter-chip ${spendScenario === "actual" ? "active" : ""}" data-spend-scenario="actual">實際資料</button>
    </div>
  `;

  return `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>套用後每日攤提預覽 (${ym})</h2>
        ${scenarioChips}
      </div>
      <div class="ink-3" style="font-size:12px;margin-bottom:6px">${subhint}</div>
      ${scenarioNote}
      <div class="table-wrap" style="max-height:560px;overflow:auto">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              ${headerCells}
              <th class="num">當日合計</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
          <tfoot>
            <tr class="dg-foot-row">
              <td><strong>月合計</strong><div class="ink-3" style="font-size:11px">vs 預算</div></td>
              ${footerCells}
              <td class="num dg-foot"><strong>${Math.round(newGrand).toLocaleString()}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

// 計算「會被批量送出」的廣告筆數：使用者勾選同意 + 沒過期 + 不是淘汰建議 + 權重真有變動
// 🔒 鎖權重的 single-product 100% 廣告可套用「整桶搬」建議。
function countAgreedChanges(pivot, newWeightsByAd) {
  const today = todayTaipei();
  let n = 0;
  for (const e of pivot) {
    if (!agreedAdIds.has(e.ad.id)) continue;
    if (e.ad.lock_perf_adjust && !e.transferTarget) continue;
    if (!e.ad.end_date || e.ad.end_date <= today) continue;
    if (e.suggestEliminate) continue;
    if (sameWeights(e.oldWeights || {}, newWeightsByAd[e.ad.id] || {})) continue;
    n++;
  }
  return n;
}

function renderAdCard(entry, state, newWeightsByAd, productStatus) {
  const { ad, oldWeights, perProduct, suggestEliminate, transferTarget, transferSourcePid } = entry;
  const productNameOf = Object.fromEntries(state.products.map((p) => [p.id, p.name]));

  const lockState = ad.lock_full ? "full" : (ad.lock_perf_adjust ? "weight" : "free");
  const locked = lockState !== "free";
  const lockIconMap = { free: "🔓", weight: "🔒", full: "🚫" };
  const lockTitleMap = {
    free: "自由 — 自動建議可改權重(點擊切換鎖定狀態)",
    weight: "🔒 鎖權重 — 權重比例不變,但可被建議整桶搬到別產品(點擊切換)",
    full: "🚫 禁止挪動 — 完全不納入自動建議,成效爛只建議淘汰(點擊切換)",
  };
  const lockBtn = `<button class="lock-btn ${locked ? "locked" : ""}" data-lock-adid="${esc(ad.id)}" title="${esc(lockTitleMap[lockState])}">${lockIconMap[lockState]}</button>`;

  // 套用勾選框邏輯
  const today = todayTaipei();
  const isPast = !ad.end_date || ad.end_date <= today;
  const noChange = sameWeights(oldWeights || {}, (newWeightsByAd && newWeightsByAd[ad.id]) || {});
  const canApplyLockedTransfer = !!transferTarget && lockState === "weight";
  const agreeDisabled = (locked && !canApplyLockedTransfer) || isPast || noChange || suggestEliminate;
  const agreeChecked = !agreeDisabled && agreedAdIds.has(ad.id);
  const agreeTitle = suggestEliminate ? "建議淘汰,請點「淘汰」按鈕"
    : locked && !canApplyLockedTransfer ? "已鎖定,無法套用"
    : isPast ? "已過期,無法套用"
    : noChange ? "無變動"
    : "勾選同意套用此建議";
  // 一般鎖定 / 建議淘汰 不能批量套用;🔒 整桶搬是鎖權重的例外。
  const agreeBox = ((locked && !canApplyLockedTransfer) || suggestEliminate)
    ? `<span class="ad-card-pick" title="${esc(agreeTitle)}">—</span>`
    : `<input type="checkbox" class="agree-toggle" data-agree-adid="${esc(ad.id)}" ${agreeChecked ? "checked" : ""} ${agreeDisabled ? "disabled" : ""} title="${agreeTitle}" />`;

  // 卡片狀態 class
  const cardCls = [
    "ad-card",
    suggestEliminate ? "ad-card-eliminate" : "",
    transferTarget ? "ad-card-transfer" : "",
    agreeChecked ? "ad-card-agreed" : (!agreeDisabled && !noChange ? "ad-card-dim" : ""),
  ].filter(Boolean).join(" ");

  // 建議淘汰 banner(淘汰按鈕永遠可點 — 淘汰是使用者決策,不受鎖定影響)
  const eliminateBanner = suggestEliminate ? `
    <div class="ad-card-banner ad-card-banner-bad">
      <strong>❌ 建議淘汰</strong>
      <span>所有產品成效都最差</span>
      <button class="primary danger eliminate-action" data-eliminate="${esc(ad.id)}">淘汰(到期不續費)</button>
    </div>
  ` : "";

  // ── 一般 / 整桶搬建議 ──

  // 決定要顯示哪些產品(預設只顯示有權重 / 系統建議的;展開顯示全部)
  const isExpanded = expandedAds.has(ad.id);
  let displayProducts;
  if (isExpanded) {
    displayProducts = state.products;
  } else {
    const includedIds = new Set();
    for (const pid of Object.keys(oldWeights)) if (Number(oldWeights[pid]) > 0) includedIds.add(pid);
    for (const pp of perProduct) {
      if (Number(pp.new) > 0 || pp.systemAdded) includedIds.add(pp.product.id);
    }
    for (const [k, w] of pending.entries()) {
      const prefix = ad.id + "|";
      if (!k.startsWith(prefix)) continue;
      if (Number(w) > 0) includedIds.add(k.slice(prefix.length));
    }
    displayProducts = state.products.filter((p) => includedIds.has(p.id));
  }
  const hiddenCount = state.products.length - displayProducts.length;

  // 排序:按原權重從大到小,0% 排最後
  displayProducts = [...displayProducts].sort((a, b) => {
    const wa = Number(oldWeights[a.id]) || 0;
    const wb = Number(oldWeights[b.id]) || 0;
    if (wa !== wb) return wb - wa;
    return a.name.localeCompare(b.name);
  });

  // 計算新權重合計
  let newSum = 0;
  const oldSum = displayProducts.reduce((s, p) => s + (Number(oldWeights[p.id]) || 0), 0);
  let anyCappedByAdSum = false;
  const lockedAd = !!ad.lock_perf_adjust;

  const productRows = displayProducts.map((p) => {
    const key = `${ad.id}|${p.id}`;
    const pp = perProduct.find((x) => x.product.id === p.id);
    const oldW = Number(oldWeights[p.id]) || 0;
    const suggestedW = pp ? pp.new : oldW;
    const overridden = pending.get(key);
    const finalW = overridden != null ? overridden : suggestedW;
    newSum += Number(finalW) || 0;
    if (pp?.cappedByAdSum) anyCappedByAdSum = true;

    const delta = finalW - oldW;
    const deltaText = delta === 0
      ? `<span class="delta-zero">→ 0</span>`
      : delta > 0
        ? `<span class="delta-up">↑ +${delta}</span>`
        : `<span class="delta-down">↓ ${delta}</span>`;

    // 成效狀態 cell
    const scoreCell = formatScoreCell(pp, false);

    // 建議結果 cell — 主標籤 + 原因(口語化,不暴露 score.ratio 百分比)
    // 🔒 整桶搬建議:source 顯示「整個挪走」、target 顯示「接收該廣告」(優先於 locked 判斷)
    const sub = (txt) => `<div class="ink-3" style="font-size:10px;line-height:1.3;margin-top:2px">${txt}</div>`;
    const score = pp?.score;
    let reasonText;
    if (transferTarget && p.id === transferTarget) {
      reasonText = `<span class="ok">接收該廣告</span>${sub("從鎖定廣告轉入此產品")}`;
    } else if (transferTarget && p.id === transferSourcePid) {
      reasonText = `<span class="bad">整個挪走</span>${sub("廣告對此產品成效不佳,移到其他產品")}`;
    } else if (pp?.locked) {
      const why = lockState === "full" ? "禁止挪動,不參與自動調整" : "非權重廣告,全部移出";
      reasonText = `${lockState === "full" ? "🚫 禁止挪動" : "🔒 鎖權重"}${sub(why)}`;
    } else if (suggestEliminate) {
      reasonText = `<span class="bad">削減</span>${sub("廣告對所有產品成效都不佳,建議淘汰")}`;
    } else if (delta === 0) {
      let why;
      if (!score || score.ratio == null) why = "尚無成效資料,維持原權重";
      else if (score.ratio >= 1.0) why = "廣告成效達標,維持原權重";
      else why = "成效尚可,本廣告非此產品最差";
      reasonText = `維持${sub(why)}`;
    } else if (delta > 0) {
      let why;
      if (pp.crossBorrowed) why = "此產品預算還有空間,從其他產品接收權重";
      else if (pp.cappedByAdSum && (pp.scaleAdjust || 0) > 0) why = "本廣告權重未滿 100%,補回";
      else if (!score || score.ratio == null) why = "從成效不佳的廣告接收權重";
      else if (score.ratio >= 1.0) why = "廣告成效達標,增加權重";
      else why = "本廣告對此產品相對較好,增加權重";
      reasonText = `<span class="ok">接收</span>${sub(why)}`;
    } else {
      let why;
      if (pp.crossLent) why = "此產品預算飽和,讓出權重給預算不足的產品";
      else if (pp.cappedByBand) why = "已達日花費上限,削回";
      else if (pp.cappedByAdSum && (pp.scaleAdjust || 0) < 0) why = "本廣告權重超過 100%,縮回";
      else if (score && score.ratio != null && score.ratio < 1.0) why = "廣告成效不佳,減少權重";
      else if (score && score.ratio >= 1.0) why = "雖達標,但其他廣告對此產品更好";
      else why = "尚無成效資料,依排序削減";
      reasonText = `<span class="bad">削減</span>${sub(why)}`;
    }
    if (pp?.cappedByBand) {
      reasonText += ` <span class="band-cap-badge" title="此產品建議已削至建議日花費上限">⤓ 削至上限</span>`;
    }
    if (pp?.bandBreached) {
      reasonText += ` <span class="band-breach-badge" title="為了把廣告 sum 補到 100%,APP 產品允許突破日 band.upper(僅 APP,小島嚴格不破)">↑ 超日上限</span>`;
    }

    // 預算 headroom icon(0% 且該產品有 budget 餘額)
    const isSystemAdded = !!pp?.systemAdded && finalW > 0 && oldW === 0;
    const status = productStatus?.[p.id];
    const hasHeadroom = status?.headroom > 0;
    const isZero = finalW === 0;
    let inputBadge = "";
    if (isZero && hasHeadroom) {
      inputBadge = `<span class="weight-headroom" title="本月還有 ${Math.round(status.headroom).toLocaleString()} TWD 預算可花,可手動加進此廣告">💰</span>`;
    }
    if (isSystemAdded) {
      inputBadge += `<span class="weight-system-added" title="系統建議從其他產品借權重補預算">＋</span>`;
    }

    const productType = p.type === "app" ? "APP" : "小島";
    const rowCls = isZero && oldW === 0 ? "zero-row" : isSystemAdded ? "system-added-row" : "";

    return `
      <tr class="${rowCls}">
        <td>${esc(p.name)} <span class="pill ${p.type}" style="font-size:10px;margin-left:4px">${productType}</span></td>
        <td class="num">${oldW}%</td>
        <td class="num"><div class="weight-input-wrap">
          ${inputBadge}<input type="number" min="0" max="100" step="1" class="w-input"
                 data-adid="${esc(ad.id)}" data-pid="${esc(p.id)}"
                 value="${finalW}" ${lockedAd ? "disabled" : ""} />
        </div></td>
        <td class="num">${deltaText}</td>
        <td>${scoreCell}</td>
        <td class="ink-2" style="font-size:12px">${reasonText}</td>
      </tr>
    `;
  }).join("");

  // 展開/收起按鈕
  const toggleExpandBtn = isExpanded
    ? `<button class="link-btn" data-toggle-expand="${esc(ad.id)}">⊖ 收起</button>`
    : (hiddenCount > 0
        ? `<button class="link-btn" data-toggle-expand="${esc(ad.id)}">⊕ 展開全部產品 (還有 ${hiddenCount} 個)</button>`
        : "");

  // 合計 badge
  const sumCls = newSum === 100 ? "ok" : newSum > 100 ? "bad" : newSum > 0 ? "warn" : "ink-3";
  const sumBadge = `<span class="weight-sum-badge ${sumCls}">合計 <strong>${newSum}%</strong></span>`;
  // 只在「真的已校準到 100」時才顯示;否則 cappedByAdSum 已被後續 band 削回,sumBadge 會自己顯示實際合計
  const calibratedBadge = (anyCappedByAdSum && newSum === 100) ? `<span class="band-cap-badge" title="系統已等比例縮放使合計=100%">已校準至 100</span>` : "";
  const oldSumNote = oldSum !== 100 ? `<span class="ink-3" style="font-size:11px">原合計 ${oldSum}%</span>` : "";

  // 整桶搬建議 banner
  const transferBanner = transferTarget
    ? `<span class="transfer-badge" title="${esc(entry.transferReason || "")}">🔒 整桶搬建議 → ${esc(productNameOf[transferTarget] || transferTarget)}</span>`
    : "";

  return `
    <div class="${cardCls}">
      <div class="ad-card-head">
        <span class="ad-card-pick">${agreeBox}</span>
        ${lockBtn}
        <span class="mono ad-code-tag">${esc(ad.ad_code)}</span>
        <strong class="ad-name">${esc(ad.ad_name)}</strong>
        <span class="ad-period ink-3">${ad.start_date} ~ ${ad.end_date}</span>
        ${eliminateBanner}
        ${transferBanner}
        <span class="ad-card-spacer"></span>
        ${oldSumNote}
        ${sumBadge}
        ${calibratedBadge}
      </div>
      <table class="ad-products">
        <colgroup>
          <col style="width:130px">
          <col><col><col><col>
          <col style="width:120px">
        </colgroup>
        <thead>
          <tr>
            <th>產品</th>
            <th class="num">原權重</th>
            <th class="num">建議權重</th>
            <th>變化</th>
            <th>成效</th>
            <th>建議結果</th>
          </tr>
        </thead>
        <tbody>${productRows}</tbody>
      </table>
      ${toggleExpandBtn ? `<div class="ad-card-foot">${toggleExpandBtn}</div>` : ""}
    </div>
  `;
}

function safeRenderAdCard(entry, state, newWeightsByAd, productStatus) {
  try {
    return renderAdCard(entry, state, newWeightsByAd, productStatus);
  } catch (err) {
    console.error("renderAdCard failed", entry?.ad, err);
    const ad = entry?.ad || {};
    return `
      <div class="ad-card ad-card-eliminate">
        <div class="ad-card-head">
          <span class="mono ad-code-tag">${esc(ad.ad_code || ad.id || "unknown")}</span>
          <strong class="ad-name">${esc(ad.ad_name || "廣告資料異常")}</strong>
          <span class="pill bad">渲染失敗</span>
          <span class="ink-3" style="font-size:12px">請重新同步資料或檢查此廣告的產品/權重資料</span>
        </div>
      </div>
    `;
  }
}

// 成效 cell:
//  - 一律顯示實際成效值(CPI/CPC 等),不用「達標 m/n」「N% (m/n)」百分比文字
//  - 達標=綠色、未達標=紅色
//  - 鎖定的廣告也照樣顯示成效(不另外標「已鎖定」)
//  - alwaysBad=true(淘汰分支)強制紅色
function formatScoreCell(pp, alwaysBad) {
  const score = pp?.score;
  if (!score || !score.details || score.details.length === 0) {
    return `<span class="ink-3">無資料</span>`;
  }
  return score.details.map((d) => {
    if (d.actual == null || !Number.isFinite(d.actual)) {
      return `<span class="ink-3">${esc(d.name)} 無</span>`;
    }
    const met = !!d.met && !alwaysBad;
    const cls = met ? "ok" : "bad";
    const sym = met ? "✓" : "✗";
    return `<span class="${cls}">${sym} ${esc(d.name)} ${formatMetric(d.actual)}</span>`;
  }).join(" ");
}

// 成效實際值固定 2 位小數(CPI/CPC 等典型值都需小數點精度)
function formatMetric(v) {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(2);
}

function bindHandlers(root, pivot, newWeightsByAd) {
  // 廣告調整建議一鍵入口
  const gdBtn = root.querySelector("#pa-gd-fix-open");
  if (gdBtn) gdBtn.onclick = () => openGiftDayFixModal(() => render(root));

  root.querySelectorAll("[data-filter]").forEach((el) => {
    el.onclick = () => { filterMode = el.dataset.filter; render(root); };
  });
  root.querySelectorAll("[data-spend-scenario]").forEach((el) => {
    el.onclick = () => { spendScenario = el.dataset.spendScenario; render(root); };
  });
  const tg = root.querySelector("#btn-toggle-app");
  if (tg) tg.onclick = (e) => { e.stopPropagation(); collapseApp = !collapseApp; render(root); };
  const tgImpact = root.querySelector("#btn-toggle-impact");
  if (tgImpact) tgImpact.onclick = () => { collapseImpact = !collapseImpact; render(root); };

  root.querySelectorAll("input.w-input").forEach((inp) => {
    inp.onchange = () => {
      const v = inp.value === "" ? 0 : Number(inp.value) || 0;
      pending.set(`${inp.dataset.adid}|${inp.dataset.pid}`, v);
      render(root);
    };
  });

  // 「⊕ 展開全部產品」/「⊖ 收起」 (CLAUDE.md §5.4.2)
  root.querySelectorAll("[data-toggle-expand]").forEach((btn) => {
    btn.onclick = () => {
      const adId = btn.dataset.toggleExpand;
      if (expandedAds.has(adId)) expandedAds.delete(adId);
      else expandedAds.add(adId);
      render(root);
    };
  });

  // 🔒 鎖定按鈕(三段循環:自由 → 鎖權重 → 禁止挪動 → 自由)
  root.querySelectorAll("button.lock-btn").forEach((btn) => {
    btn.onclick = () => {
      const adId = btn.dataset.lockAdid;
      let willClearAgree = false;
      update((st) => {
        const a = st.ads.find((x) => x.id === adId);
        if (!a) return;
        const cur = a.lock_full ? "full" : (a.lock_perf_adjust ? "weight" : "free");
        // 三段循環
        if (cur === "free") {
          a.lock_perf_adjust = true; a.lock_full = false;
          willClearAgree = true;
        } else if (cur === "weight") {
          a.lock_perf_adjust = true; a.lock_full = true;
          willClearAgree = true;
        } else {
          a.lock_perf_adjust = false; a.lock_full = false;
        }
      });
      if (willClearAgree) {
        agreedAdIds.delete(adId);
        for (const k of [...pending.keys()]) if (k.startsWith(adId + "|")) pending.delete(k);
      }
      render(root);
    };
  });

  // ✓ 同意套用 勾選框
  root.querySelectorAll("input.agree-toggle").forEach((inp) => {
    inp.onchange = () => {
      const adId = inp.dataset.agreeAdid;
      if (inp.checked) agreedAdIds.add(adId);
      else agreedAdIds.delete(adId);
      // render 是為了更新底部按鈕的「N 筆」計數
      render(root);
    };
  });

  // 全選有變動 / 全不選
  const agreeAll = root.querySelector("#btn-agree-all-changed");
  if (agreeAll) agreeAll.onclick = () => {
    const today = todayTaipei();
    for (const e of pivot) {
      if (e.ad.lock_perf_adjust && !e.transferTarget) continue;
      if (!e.ad.end_date || e.ad.end_date <= today) continue;
      if (e.suggestEliminate) continue;
      if (sameWeights(e.oldWeights || {}, newWeightsByAd[e.ad.id] || {})) continue;
      agreedAdIds.add(e.ad.id);
    }
    render(root);
  };
  const agreeNone = root.querySelector("#btn-agree-none");
  if (agreeNone) agreeNone.onclick = () => { agreedAdIds.clear(); render(root); };

  const reset = root.querySelector("#btn-reset");
  if (reset) reset.onclick = () => { pending.clear(); render(root); };

  const apply = root.querySelector("#btn-apply");
  if (apply) apply.onclick = () => applyAll(pivot, newWeightsByAd, root);

  // 「淘汰」— 標記廣告為到期不續費（不改 end_date，攤提到原期間結束自動停）
  root.querySelectorAll("[data-eliminate]").forEach((btn) => {
    btn.onclick = () => eliminateAd(btn.dataset.eliminate, root);
  });
}

async function eliminateAd(adId, root) {
  const s = getState();
  const ad = s.ads.find((a) => a.id === adId);
  if (!ad) { toast("找不到該廣告", "bad"); return; }
  const ok = await confirmAsync({
    title: "淘汰廣告（到期不續費）",
    body: "標記為「到期不再投放」— 廣告會跑完原本的攤提期間，但不會出現在『即將到期』警示，也不會被視為需要續費。可隨時取消淘汰恢復追蹤。",
    details: [
      `${ad.ad_code} ${ad.ad_name}`,
      `原期間 ${ad.start_date} ~ ${ad.end_date}`,
      `每日攤提 ${Math.round(ad.daily_amort_twd || 0).toLocaleString()} TWD`,
    ],
    okText: "淘汰", danger: true,
  });
  if (!ok) return;

  update((st) => {
    const targetCode = ad.ad_code;
    // 撤回快照:該 ad_code 所有段
    const targetIds = st.ads.filter((a) => a.ad_code === targetCode).map((a) => a.id);
    const ad_snapshots = captureUndoSnapshot(st, targetIds);
    st.ads.forEach((a) => {
      if (a.ad_code === targetCode) a.eliminated = true;
    });
    st.todos.push({
      id: uid("todo"),
      created_at: nowTaipeiStamp(),
      action_type: "淘汰廣告",
      description: `${ad.ad_code} ${ad.ad_name}：因成效全線最差，到期不再續費`,
      status: "pending",
      undo_payload: { ad_snapshots, added_ad_ids: [] },
    });
  }, "淘汰廣告");
  toast("已標記淘汰，並建立待辦", "ok");
  render(root);
}

async function applyAll(pivot, newWeightsByAd, root) {
  const today = todayTaipei();
  const changes = [];
  const eliminateCount = pivot.filter((e) => e.suggestEliminate).length;
  for (const e of pivot) {
    if (!agreedAdIds.has(e.ad.id)) continue;  // 必須使用者明確勾選「同意套用」
    if (e.ad.lock_perf_adjust && !e.transferTarget) continue;
    if (!e.ad.end_date || e.ad.end_date <= today) continue;  // 過去廣告不能調
    if (e.suggestEliminate) continue;  // 建議淘汰的不走「權重調整」，需到廣告頁手動「提前結束」
    const oldW = e.oldWeights || {};
    const newW = newWeightsByAd[e.ad.id] || {};
    const same = sameWeights(oldW, newW);
    if (!same) changes.push({ ad: e.ad, newW });
  }
  if (changes.length === 0 && eliminateCount === 0) {
    toast("沒有勾選任何要套用的調整", "");
    return;
  }
  if (changes.length === 0 && eliminateCount > 0) {
    toast(`只有 ${eliminateCount} 筆建議淘汰，請到「廣告」頁手動結束`, "warn");
    return;
  }

  // dry-run preview details
  const preview = changes.slice(0, 12).map((ch) => {
    const oldStr = formatWeights(ch.ad.weights);
    const newStr = formatWeights(ch.newW);
    return `${ch.ad.ad_code} ${ch.ad.ad_name}：${oldStr} → ${newStr}`;
  });
  if (changes.length > 12) preview.push(`…還有 ${changes.length - 12} 筆`);
  if (eliminateCount > 0) preview.push(`（另 ${eliminateCount} 筆建議淘汰未套用，需到廣告頁手動結束）`);

  const ok = await confirmAsync({
    title: "套用成效調整",
    body: `將對 ${changes.length} 筆廣告開「權重調整」新段（生效日 ${today}），並建立 1 筆待辦。${eliminateCount > 0 ? `\n另 ${eliminateCount} 筆建議淘汰不在本批，需手動處理。` : ""}`,
    details: preview,
    okText: `套用 ${changes.length} 筆`,
  });
  if (!ok) return;

  let okCount = 0, errCount = 0;
  const successDetails = [];
  update((st) => {
    // 撤回快照:被改的 ads
    const ad_snapshots = captureUndoSnapshot(st, changes.map((ch) => ch.ad.id));
    const added_ad_ids = [];

    const nameOf = Object.fromEntries(st.products.map((p) => [p.id, p.name]));
    const fmtW = (w) => Object.entries(w || {})
      .filter(([, v]) => Math.round(Number(v) || 0) > 0)
      .sort(([, a], [, b]) => Number(b) - Number(a))
      .map(([pid, v]) => `${nameOf[pid] || pid} ${Math.round(Number(v) || 0)}%`)
      .join("、");
    for (const ch of changes) {
      const seg = st.ads.find((a) => a.id === ch.ad.id);
      if (!seg) { errCount++; continue; }
      const effective = today > seg.start_date && today < seg.end_date ? today : seg.start_date;
      const oldStr = fmtW(seg.weights);
      const newStr = fmtW(ch.newW);
      try {
        if (effective <= seg.start_date) {
          seg.weights = { ...ch.newW };
          okCount++;
          successDetails.push(`${seg.ad_code} ${seg.ad_name}｜${oldStr} → ${newStr}`);
        } else {
          const r = buildWeightAdjust(seg, effective, { ...ch.newW });
          const i = st.ads.findIndex((a) => a.id === seg.id);
          if (i >= 0) st.ads[i] = r.closed;
          st.ads.push(...r.segments);
          added_ad_ids.push(...r.segments.map((s) => s.id));
          okCount++;
          successDetails.push(`${seg.ad_code} ${seg.ad_name}｜${oldStr} → ${newStr}`);
        }
      } catch { errCount++; }
    }
    if (okCount > 0) {
      const head = `成效調整套用至 ${okCount} 筆廣告${errCount ? `（另 ${errCount} 筆失敗）` : ""}：`;
      st.todos.push({
        id: uid("todo"),
        created_at: nowTaipeiStamp(),
        action_type: "成效調整權重",
        description: `${head}\n${successDetails.join("\n")}\n（請至連結隨機縮網址後台調整權重）`,
        status: "pending",
        undo_payload: { ad_snapshots, added_ad_ids },
      });
    }
  });
  // 套用後清掉 pending 與 agreedAdIds（避免下一次又拿舊勾選去送）
  pending.clear();
  agreedAdIds.clear();
  toast(`已套用 ${okCount} 筆${errCount ? `，失敗 ${errCount}` : ""}`, okCount > 0 ? "ok" : "bad");
  render(root);
}

function formatWeights(w) {
  return Object.entries(w || {})
    .filter(([, v]) => Number(v) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a))
    .map(([pid, v]) => `${pid}:${v}%`)
    .join(", ") || "（無）";
}

function sameWeights(a, b) {
  const ka = Object.keys(a || {}), kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (Number(a[k]) !== Number(b[k])) return false;
  return true;
}

// 「最終 delta% — 成效狀態」格式
//   - 鎖定 → 「已鎖定」
//   - 無成效 → 「±X% — 無成效資料」（或 「維持 — 無成效資料」）
//   - 已達標（ratio >= 1.0） → 「±X% — 達標 (m/n)」
//   - 部分達標（0 < ratio < 1.0） → 「±X% — Y% 達成 (m/n)」
//   - 完全不達標 → 「±X% — 未達標 (0/n)」
function formatReason(pp) {
  const delta = (Number(pp.new) || 0) - (Number(pp.old) || 0);
  const deltaText = delta === 0 ? "維持" : (delta > 0 ? `+${delta}%` : `${delta}%`);
  if (pp.locked) return `${deltaText} — 已鎖定`;
  const score = pp.score;
  let scoreText;
  if (!score || score.ratio == null) scoreText = "無成效資料";
  else if (score.ratio >= 1.0) scoreText = `達標 (${score.metCount}/${score.totalCount})`;
  else if (score.ratio === 0) scoreText = `未達標 (0/${score.totalCount})`;
  else scoreText = `${Math.round(score.ratio * 100)}% 達成 (${score.metCount}/${score.totalCount})`;
  return esc(`${deltaText} — ${scoreText}`);
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
