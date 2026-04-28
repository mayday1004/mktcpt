import { getState } from "../state.js";
import { suggestForDate } from "../domain/reverse.js";
import { suggestWeights } from "../domain/suggest.js";
import { dailySpendGrid } from "../domain/spending.js";
import { addDays, monthOf, monthEnd, daysOfMonth, todayTaipei } from "../lib/dates.js";
import { getMonthlyBudget, NO_BAND_PIDS } from "../schema.js";
import { bandsForMonth } from "../domain/budget.js";

let mode = "date";  // "date" | "amount"
let pickedDate = "";
let pickedPids = new Set();  // date-mode 多選產品 id
let amortizeDays = 30;

// amount-mode 表單值
let amtStart = "";
let amtEnd = "";
let amtDays = 30;
let amtCny = 0;

const todayStr = todayTaipei;

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;
  const today = todayStr();
  // 預設目標日 = 今天（若今日已過當月，仍以今日為準，使用者可自行往後挑）
  if (!pickedDate || pickedDate < today) pickedDate = today;
  if (!amtStart || amtStart < today) amtStart = today;
  if (!amtEnd || amtEnd <= amtStart) {
    amtEnd = addDays(amtStart, 30);
  }

  // 產品選擇器預設：第一個產品；同時清掉不存在的 pid
  for (const pid of [...pickedPids]) {
    if (!s.products.find((p) => p.id === pid)) pickedPids.delete(pid);
  }
  if (pickedPids.size === 0 && s.products[0]) {
    pickedPids = new Set([s.products[0].id]);
  }

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>採買建議</h1>
        <div class="desc">兩種模式：① 選日期 + 產品 → 算出該產品這天要補多少才補到位；② 給定一筆 RMB 金額與起迄 → 系統建議怎麼分產品權重</div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab ${mode === "date" ? "active" : ""}" data-mode="date">依日期看可加空間</button>
      <button class="tab ${mode === "amount" ? "active" : ""}" data-mode="amount">依金額分配權重</button>
    </div>

    ${mode === "date" ? renderDateMode(s, ym) : renderAmountMode(s, ym)}
  `;

  bindHandlers(root);
}

// ── Mode 1: 依日期看可加空間 ───────────────────────────────────────
function renderDateMode(s, ym) {
  const rate = s.settings.expense_rate;
  const today = todayStr();
  if (pickedDate < today) pickedDate = today;
  const cards = suggestForDate(s, pickedDate, rate, amortizeDays);
  const selected = cards.filter((c) => pickedPids.has(c.product.id));

  // 產品 chip 列：多選；每個 chip 旁顯示該產品當日可加的簡短摘要
  const chips = s.products.map((p) => {
    const c = cards.find((x) => x.product.id === p.id);
    const isActive = pickedPids.has(p.id);
    let badge = "";
    if (c) {
      if (c.kind === "ok" && c.suggestTwd > 0) badge = `<span class="ink-3" style="margin-left:4px">+${Math.round(c.suggestTwd).toLocaleString()}</span>`;
      else if (c.kind === "full") badge = `<span class="ink-3" style="margin-left:4px">滿</span>`;
      else if (c.kind === "empty") badge = `<span class="ink-3" style="margin-left:4px">—</span>`;
    }
    return `<button class="filter-chip ${isActive ? "active" : ""}" data-rev-pid="${esc(p.id)}">${esc(p.name)}${badge}</button>`;
  }).join("");

  let cardHtml;
  if (selected.length === 0) {
    cardHtml = `<div class="card"><p class="ink-2">請至少選一個產品（可多選）。</p></div>`;
  } else if (selected.length === 1) {
    cardHtml = renderDateCardLarge(selected[0], amortizeDays, rate);
  } else {
    cardHtml = renderDateCombinedCard(selected, amortizeDays, rate);
  }

  return `
    <div class="rev-controls">
      <div class="field" style="min-width:160px">
        <label>目標日期（當日或未來）</label>
        <input id="rev-date" type="date" value="${pickedDate}" min="${today}" />
      </div>
      <div class="field" style="min-width:140px">
        <label>支出匯率</label>
        <input id="rev-rate" type="number" step="0.01" value="${rate}" disabled />
        <div class="hint">在「設定」頁修改</div>
      </div>
      <div class="field" style="min-width:120px">
        <label>預期攤提天數</label>
        <input id="rev-days" type="number" value="${amortizeDays}" min="1" max="180" />
        <div class="hint">用於估算 RMB 採買額（單日 × 攤提天）</div>
      </div>
    </div>

    <div class="filter-row" style="margin-bottom:12px">
      <span class="ink-3" style="font-size:12px">產品（可多選）：</span>
      ${chips}
      ${pickedPids.size > 0 ? `<button class="link-btn" id="rev-clear-pids" style="margin-left:auto">清除選擇</button>` : ""}
    </div>

    ${cardHtml}
  `;
}

// 多選產品：合計可加空間 + 自動分權重（依 suggestTwd 比例）
// 「已補到位」(kind != ok 或 suggestTwd <= 0) 的產品自動排除分配，但仍列出原因。
function renderDateCombinedCard(cards, days, rate) {
  const usable = cards.filter((c) => c.kind === "ok" && c.suggestTwd > 0);
  const skipped = cards.filter((c) => !(c.kind === "ok" && c.suggestTwd > 0));

  if (usable.length === 0) {
    return `
      <div class="card">
        <h2>合計可加空間</h2>
        <p class="ink-2">所選產品都沒有可加空間。</p>
        ${renderSkippedList(skipped)}
      </div>
      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: 0,
        weights: {},
      })}
    `;
  }

  const totalDailyTwd = usable.reduce((s, c) => s + c.suggestTwd, 0);
  const totalTwd = totalDailyTwd * days;
  const totalCny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const weights = computeIntegerWeights(usable.map((c) => ({ id: c.product.id, value: c.suggestTwd })));

  return `
    <div class="card">
      <div class="card-head">
        <h2>${usable.length} 個產品 — 合計可加空間</h2>
        <button class="primary" id="date-create-multi">📋 用此參數建立廣告</button>
      </div>

      <div class="rev-hero">
        <div class="rev-hero-num">${Math.round(totalDailyTwd).toLocaleString()} <span class="rev-hero-unit">TWD/日</span></div>
        <div class="rev-hero-sub">
          ${pickedDate} 起，買 ${days} 天廣告 → <strong>${totalCny.toLocaleString()}</strong> RMB（${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
        </div>
        <div class="rev-hero-limits">
          ${usable.map((c) => {
            const w = weights[c.product.id] || 0;
            const dailyShare = totalDailyTwd * (w / 100);
            return `<div><strong>${esc(c.product.name)} ${w}%</strong> — ${Math.round(dailyShare).toLocaleString()} TWD/日 <span class="ink-3" style="font-size:11px">(最緊 ${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span></div>`;
          }).join("")}
        </div>
      </div>

      <details class="rev-details">
        <summary>各產品限制細節</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          ${usable.map((c) => {
            const w = weights[c.product.id] || 0;
            const dailyShare = totalDailyTwd * (w / 100);
            return `
              <div class="rev-card">
                <h3>
                  <span>${esc(c.product.name)}</span>
                  <span class="pill ${c.product.type}" style="font-weight:400;font-size:11px;margin-left:4px">${c.product.type === "app" ? "APP" : "小島"}</span>
                  <span class="pill" style="font-size:14px;margin-left:auto">${w}%</span>
                </h3>
                <div class="rev-row"><span class="label">月剩餘 / ${c.daysToMonthEnd} 天</span><span class="val">${Math.round(c.monthRemainPerDay || 0).toLocaleString()}/日</span></div>
                <div class="rev-row"><span class="label">攤提區間最緊</span><span class="val">${Math.round(c.minHeadroomInPeriod || 0).toLocaleString()}<span class="ink-3" style="font-size:11px"> (${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span></span></div>
                <div class="rev-row"><span class="label">分到 daily</span><span class="val"><strong>${Math.round(dailyShare).toLocaleString()}</strong></span></div>
              </div>
            `;
          }).join("")}
        </div>
      </details>

      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: totalDailyTwd,
        weights,
      })}

      ${renderSkippedList(skipped)}
    </div>
  `;
}

function renderSkippedList(skipped) {
  if (!skipped || skipped.length === 0) return "";
  const items = skipped.map((c) => {
    const note = c.note || (c.kind === "full" ? "已補到位" : c.kind === "empty" ? "未設預算" : "無可加空間");
    return `<li><strong>${esc(c.product.name)}</strong> — ${esc(note)}</li>`;
  }).join("");
  return `
    <div class="hint" style="margin-top:14px;padding:10px 12px;background:#f7f9fc;border-radius:6px;font-size:12px">
      <strong>未納入分配的產品（${skipped.length}）：</strong>
      <ul style="margin:4px 0 0;padding-left:20px">${items}</ul>
    </div>
  `;
}

// 依 value 比例算整數權重，最後一筆收尾補到 100
function computeIntegerWeights(items) {
  const total = items.reduce((s, x) => s + (Number(x.value) || 0), 0);
  const out = {};
  if (total <= 0 || items.length === 0) return out;
  let acc = 0;
  for (let i = 0; i < items.length - 1; i++) {
    out[items[i].id] = Math.round((Number(items[i].value) || 0) / total * 100);
    acc += out[items[i].id];
  }
  out[items[items.length - 1].id] = 100 - acc;
  return out;
}

// 大張卡片：選定產品 + 日期後顯示該產品的補貨建議
function renderDateCardLarge(c, days, rate) {
  if (c.budget == null) {
    return `
      <div class="card">
        <h2>${esc(c.product.name)} <span class="pill ${c.product.type}" style="font-weight:400">${c.product.type === "app" ? "APP" : "小島"}</span></h2>
        <p class="ink-2">尚未設定月預算 — 請到「產品」頁設定後再回來查看。</p>
      </div>
    `;
  }
  const usable = c.kind === "ok" && c.suggestTwd > 0;
  const totalTwd = c.suggestTwd * days;
  const totalCny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  // 哪個是 binding constraint：月剩餘÷剩餘天數 vs 攤提區間最緊
  const monthBindingFirst = (c.monthRemainPerDay ?? Infinity) <= (c.minHeadroomInPeriod ?? Infinity);
  const monthBindingTag = monthBindingFirst ? `<span class="pill warn" style="font-size:10px;margin-left:4px">較緊</span>` : "";
  const periodBindingTag = !monthBindingFirst ? `<span class="pill warn" style="font-size:10px;margin-left:4px">較緊</span>` : "";

  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(c.product.name)} <span class="pill ${c.product.type}" style="font-weight:400">${c.product.type === "app" ? "APP" : "小島"}</span></h2>
        ${usable ? `<button class="primary" id="date-create">📋 用此參數建立廣告</button>` : ""}
      </div>

      ${usable ? `
        <div class="rev-hero">
          <div class="rev-hero-num">${Math.round(c.suggestTwd).toLocaleString()} <span class="rev-hero-unit">TWD/日</span></div>
          <div class="rev-hero-sub">
            買 ${days} 天廣告，本產品 100% 採買 → <strong>${totalCny.toLocaleString()}</strong> RMB（${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
          </div>
          <div class="rev-hero-limits">
            <div>月剩餘 ÷ 剩餘 ${c.daysToMonthEnd} 天 = <strong>${Math.round(c.monthRemainPerDay || 0).toLocaleString()}</strong>/日${monthBindingTag}</div>
            <div>攤提區間 ${c.amortizeDaysUsed} 天最緊 = <strong>${Math.round(c.minHeadroomInPeriod || 0).toLocaleString()}</strong>/日 <span class="ink-3">(${c.minHeadroomDay ? c.minHeadroomDay.slice(5) : "—"})</span>${periodBindingTag}</div>
          </div>
        </div>
      ` : `
        <div class="rev-hero rev-hero-bad">
          <div class="rev-hero-num" style="color:var(--bad);font-size:18px">無可加空間</div>
          <div class="rev-hero-sub" style="color:var(--bad)">${esc(c.note || "—")}</div>
        </div>
      `}

      <details class="rev-details">
        <summary>細節（月度／當日／建議花費值）</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          <div class="rev-card">
            <h3 style="margin-bottom:8px">月度</h3>
            <div class="rev-row"><span class="label">月預算</span><span class="val">${Math.round(c.budget).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">月已花</span><span class="val">${Math.round(c.monthSpent).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">月剩餘</span><span class="val">${Math.round(c.monthRemaining).toLocaleString()}</span></div>
          </div>
          <div class="rev-card">
            <h3 style="margin-bottom:8px">${pickedDate} 當日</h3>
            <div class="rev-row"><span class="label">建議日花費上緣</span><span class="val">${Math.round(c.band.upper).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">已配置</span><span class="val">${Math.round(c.todaySpent).toLocaleString()}</span></div>
            <div class="rev-row"><span class="label">當日尚可加</span><span class="val">${Math.round(c.todayHeadroom).toLocaleString()}</span></div>
          </div>
        </div>
      </details>

      ${renderSimulatedMonthGrid({
        start_date: pickedDate,
        end_date: addDays(pickedDate, days),
        amortize_days: days,
        daily_amort_twd: c.suggestTwd,
        weights: { [c.product.id]: 100 },
      })}
    </div>
  `;
}

// 模擬「假設這筆新廣告買下去 + 所有現有廣告到期都續費」之後的整月每日攤提表。
//   - 對每個 ad_code 的最後一段，把 end_date 推到月底+1（沒淘汰才推）
//   - 加上代表新採買的 fakeAd（caller 提供 weights，可單產品 100% 或多產品分權重）
//   - 即使新採買無法成立（daily_amort_twd <= 0），仍顯示「續費後 baseline」表格，標題改寫
// 表格格式跟概覽頁的「每日攤提（台幣）」一致。
function renderSimulatedMonthGrid(fakeAdInput) {
  const s = getState();
  if (!fakeAdInput || !fakeAdInput.start_date) return "";

  const hasNewBuy = (fakeAdInput.daily_amort_twd || 0) > 0;
  const ym = monthOf(fakeAdInput.start_date);
  const monthEndExclusive = addDays(monthEnd(ym), 1);

  // 找每 ad_code 的最後段（max end_date），把它的 end_date 推到月底+1
  // 但只對「end_date 仍在今日（含）之後」的最後段做 — 已過期但沒手動續費的廣告
  // 系統不該替他自動續費（會把過去無花費日塞進來）
  const today = todayTaipei();
  const latestByCode = new Map();
  for (const a of s.ads) {
    if (a.eliminated) continue;  // 已淘汰：使用者明確不續費，不模擬
    const cur = latestByCode.get(a.ad_code);
    if (!cur || a.end_date > cur.end_date) latestByCode.set(a.ad_code, a);
  }
  const latestIds = new Set([...latestByCode.values()].map((a) => a.id));
  const renewedAds = s.ads.map((a) => {
    if (!latestIds.has(a.id)) return a;
    if (a.end_date >= monthEndExclusive) return a;  // 已涵蓋整月
    if (a.end_date < today) return a;               // 已過期：不假設續費
    return { ...a, end_date: monthEndExclusive };
  });

  const ads = hasNewBuy
    ? [...renewedAds, { id: "preview_new_ad", ad_code: "_PREVIEW_", ad_name: "(預覽：新採買)", group: "preview", ...fakeAdInput }]
    : renewedAds;
  const grid = dailySpendGrid(ads, ym);
  const products = s.products;
  const monthDays = [...daysOfMonth(ym)];
  const dayBandsByPid = Object.fromEntries(products.map((p) => [p.id, bandsForMonth(s, p, ym)]));

  const monthTotals = Object.fromEntries(products.map((p) => [p.id, 0]));
  let grandTotal = 0;

  const bodyRows = monthDays.map((d) => {
    const row = grid[d] || {};
    let dayTotal = 0;
    const cells = products.map((p) => {
      const amt = row[p.id] || 0;
      dayTotal += amt;
      monthTotals[p.id] += amt;
      const b = dayBandsByPid[p.id]?.[d];
      const isFuture = d >= today;
      const out = isFuture && b && b.budget_set && !NO_BAND_PIDS.has(p.id) && amt > 0 && (amt < b.lower || amt > b.upper);
      const cls = `num ${out ? "dg-out-of-band" : ""} ${d < today ? "dg-past" : ""}`;
      return `<td class="${cls}">${amt ? Math.round(amt).toLocaleString() : "<span class='ink-3'>—</span>"}</td>`;
    }).join("");
    grandTotal += dayTotal;
    return `<tr>
      <td class="mono">${d.slice(5)}</td>
      ${cells}
      <td class="num"><strong>${Math.round(dayTotal).toLocaleString()}</strong></td>
    </tr>`;
  }).join("");

  const footerCells = products.map((p) => {
    const total = monthTotals[p.id];
    const budget = getMonthlyBudget(s, p.id, ym) || 0;
    const diff = total - budget;
    const diffClass = !budget ? "ink-3" : diff > 10000 ? "bad" : diff > 0 ? "warn" : -diff > 20000 ? "warn" : "ok";
    return `<td class="num dg-foot">
      <strong>${Math.round(total).toLocaleString()}</strong>
      ${budget ? `<div class="dg-foot-sub ${diffClass}">${diff >= 0 ? "+" : ""}${Math.round(diff).toLocaleString()}</div>` : ""}
    </td>`;
  }).join("");

  const headerCells = products.map((p) => `<th class="num">${esc(p.name)}</th>`).join("");

  const heading = hasNewBuy
    ? `採買後每日攤提（${ym}，台幣）`
    : `現有廣告續費後每日攤提（${ym}，台幣）`;
  const subhint = hasNewBuy
    ? "假設此筆新廣告買下 + 所有現有廣告到期都續費（end_date 推至月底）。紅色格 = 當日及未來日超出建議日花費。"
    : "這筆新採買沒有可加空間，下表只顯示「現有廣告全部續費」後的整月分布（不含這筆）。紅色格 = 當日及未來日超出建議日花費。";

  return `
    <div class="card" style="margin-top:14px">
      <div class="card-head">
        <h2>${heading}</h2>
        <div class="ink-3" style="font-size:12px">${subhint}</div>
      </div>
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
              <td class="num dg-foot"><strong>${Math.round(grandTotal).toLocaleString()}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}


// ── Mode 2: 依金額分配權重 ─────────────────────────────────────────
function renderAmountMode(s, ym) {
  const rate = s.settings.expense_rate;
  const today = todayStr();
  // 採買只能往未來；amtStart 落在過去就強拉到今日
  if (amtStart && amtStart < today) amtStart = today;
  if (amtEnd && amtEnd <= amtStart) {
    amtEnd = addDays(amtStart, amtDays);
  }
  const amountTwd = (Number(amtCny) || 0) * rate;
  const dailyTwd = amtDays > 0 ? amountTwd / amtDays : 0;

  let suggested = null;
  let reasons = [];
  let candidates = [];
  let inMonthDays = 0;
  let inNextMonthDays = 0;
  let ymNext = "";
  if (amtCny > 0 && amtStart && amtEnd && amtDays > 0 && amtEnd > amtStart) {
    const fakeAd = {
      start_date: amtStart,
      end_date: amtEnd,
      amortize_days: amtDays,
      daily_amort_twd: dailyTwd,
    };
    const r = suggestWeights(s, s.products, s.ads, ym, fakeAd);
    suggested = r.weights;
    reasons = r.reasons;
    candidates = r.candidates || [];
    inMonthDays = r.inMonthDays || 0;
    inNextMonthDays = r.inNextMonthDays || 0;
    ymNext = r.ymNext || "";
  }

  const nameOf = Object.fromEntries(s.products.map((p) => [p.id, p.name]));
  const productOf = Object.fromEntries(s.products.map((p) => [p.id, p]));
  const candById = Object.fromEntries(candidates.map((c) => [c.p.id, c]));
  const excluded = candidates.filter((c) => c.excludeReason);
  const totalW = suggested ? Object.values(suggested).reduce((a, b) => a + b, 0) : 0;

  return `
    <div class="rev-controls">
      <div class="field" style="min-width:140px">
        <label>金額（RMB）</label>
        <input id="amt-cny" type="number" step="any" value="${amtCny || ""}" placeholder="例 90000" />
      </div>
      <div class="field" style="min-width:140px">
        <label>支出匯率</label>
        <input id="amt-rate" type="number" step="0.01" value="${rate}" disabled />
        <div class="hint">= ${Math.round(amountTwd).toLocaleString()} TWD</div>
      </div>
      <div class="field" style="min-width:140px">
        <label>開始日（當日或未來）</label>
        <input id="amt-start" type="date" value="${amtStart}" min="${today}" />
      </div>
      <div class="field" style="min-width:140px">
        <label>結束日（不含）</label>
        <input id="amt-end" type="date" value="${amtEnd}" min="${today}" />
      </div>
      <div class="field" style="min-width:120px">
        <label>攤提天數</label>
        <input id="amt-days" type="number" value="${amtDays}" min="1" max="180" />
        <div class="hint">每日攤提 = ${Math.round(dailyTwd).toLocaleString()} TWD</div>
      </div>
    </div>

    ${suggested == null ? `
      <div class="card"><p class="ink-2">填入金額、起訖、攤提天數後，系統會依各產品「剩餘預算」與「當日建議日花費剩餘空間」算出建議權重。</p></div>
    ` : Object.keys(suggested).length === 0 ? `
      <div class="card">
        <p class="ink-2" style="color:var(--bad)">無法給出建議：</p>
        <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      </div>
      ${renderSimulatedMonthGrid({
        start_date: amtStart,
        end_date: amtEnd,
        amortize_days: amtDays,
        daily_amort_twd: 0,
        weights: {},
      })}
    ` : `
      <div class="card">
        <div class="card-head">
          <h2>建議權重分配</h2>
          <button class="primary" id="amt-create">📋 用此參數建立廣告</button>
        </div>

        <div class="rev-hero">
          <div class="rev-hero-num">${Math.round(amountTwd).toLocaleString()} <span class="rev-hero-unit">TWD（${amtCny.toLocaleString()} RMB）</span></div>
          <div class="rev-hero-sub">
            ${amtStart} ~ ${amtEnd}（${amtDays} 天）→ 每日攤提 <strong>${Math.round(dailyTwd).toLocaleString()}</strong> TWD
          </div>
          <div class="rev-hero-limits">
            ${Object.entries(suggested).sort(([, a], [, b]) => b - a).map(([pid, w]) => {
              const dailyShare = dailyTwd * (w / 100);
              return `<div><strong>${esc(nameOf[pid] || pid)} ${w}%</strong> — ${Math.round(dailyShare).toLocaleString()} TWD/日</div>`;
            }).join("")}
          </div>
        </div>

        ${reasons.length ? `<div class="hint" style="margin-top:8px">${reasons.map((r) => esc(r)).join("；")}</div>` : ""}

        <details class="rev-details">
          <summary>各產品預算 / 建議花費值 細節</summary>
        <div class="rev-product-cards" style="margin-top:8px">
          ${Object.entries(suggested)
            .sort(([, a], [, b]) => b - a)
            .map(([pid, w]) => {
              const dailyShare = dailyTwd * (w / 100);
              const totalShare = amountTwd * (w / 100);
              const cand = candById[pid];
              const monthContrib = dailyShare * inMonthDays;
              const monthSpent = cand?.spent || 0;
              const budget = cand?.budget;
              const projTotal = monthSpent + monthContrib;
              const fmt = (n) => Math.round(n).toLocaleString();

              // 本月：projTotal vs budget
              let thisMonthLine = "";
              if (budget != null && budget > 0) {
                const over = projTotal - budget;
                const cls = over > 0.5 ? "bad" : "ok";
                const sign = over > 0.5 ? `✗ +${fmt(over)}` : "✓";
                thisMonthLine = `<div class="rev-line"><span class="rev-k">本月</span><span class="rev-v ${cls}">${fmt(projTotal)} / ${fmt(budget)} ${sign}</span></div>`;
              }

              // 下月：baseline + nextContrib vs nextBudget
              let nextMonthLine = "";
              let cutLine = "";
              if (inNextMonthDays > 0 && cand?.nextBudgetAssumed != null && cand.nextBudgetAssumed > 0) {
                const nextContrib = dailyShare * inNextMonthDays;
                const baseline = cand.nextSpent || 0;
                const nextProj = baseline + nextContrib;
                const nextBudget = cand.nextBudgetAssumed;
                const nextOver = nextProj - nextBudget;
                const baselineOver = Math.max(0, baseline - nextBudget);
                const newOnlyOver = Math.max(0, nextOver) - baselineOver;
                const cls = nextOver > 0.5 ? "bad" : "ok";
                const sign = nextOver > 0.5 ? `✗ +${fmt(nextOver)}` : "✓";
                const tipText = `${cand.nextBudgetIsAssumed ? "下月預算未設，以本月為假設；" : ""}已含現廣告續費`;
                nextMonthLine = `<div class="rev-line"><span class="rev-k" title="${tipText}">下月</span><span class="rev-v ${cls}">${fmt(nextProj)} / ${fmt(nextBudget)} ${sign}</span></div>`;
                if (nextOver > 0.5) {
                  if (newOnlyOver > 0.5 && rate > 0) {
                    const cutRmb = Math.ceil(newOnlyOver / rate);
                    const note = baselineOver > 0.5
                      ? `<div class="rev-note">光現有廣告續費就會超 ${Math.ceil(baselineOver / rate).toLocaleString()} RMB（與這筆採買無關）</div>`
                      : "";
                    cutLine = `<div class="rev-line"><span class="rev-k">需砍</span><span class="rev-v bad">≈ ${cutRmb.toLocaleString()} RMB</span></div>${note}`;
                  } else if (baselineOver > 0.5) {
                    cutLine = `<div class="rev-note">超出全來自「現有廣告續費」（與這筆採買無關）</div>`;
                  }
                }
              }

              return `
                <div class="rev-card">
                  <h3>
                    <span>${esc(nameOf[pid] || pid)}</span>
                    <span class="pill ${productOf[pid]?.type || ""}" style="font-weight:400;font-size:11px;margin-left:4px">${productOf[pid]?.type === "app" ? "APP" : "小島"}</span>
                    <span class="pill" style="font-size:14px;margin-left:auto">${w}%</span>
                  </h3>
                  <div class="rev-line"><span class="rev-k">日／月</span><span class="rev-v">${fmt(dailyShare)}／${fmt(totalShare)} <span class="ink-3">(${fmt(totalShare / rate)} RMB)</span></span></div>
                  ${thisMonthLine}
                  ${nextMonthLine}
                  ${cutLine}
                </div>
              `;
            }).join("")}
        </div>
        <div class="hint" style="margin-top:8px">
          合計：<strong>${totalW}%</strong>
          ${inMonthDays ? `；本月攤提天 <strong>${inMonthDays}</strong>` : ""}
          ${inNextMonthDays ? `；下月（${ymNext}）攤提天 <strong>${inNextMonthDays}</strong>` : ""}
        </div>
        </details>
        ${(() => {
          // 全局淘汰建議：彙總所有產品的下月超支
          // 只算「新廣告造成的額外超出」（newOnlyOver），不把 baseline 已超的部分推給這筆新廣告
          if (!inNextMonthDays || rate <= 0) return "";
          let newOnlyOverTotal = 0;     // 純粹由新廣告引發的超支總額
          let baselineOverTotal = 0;     // baseline 已超的總額（提示用）
          const overByProd = [];
          for (const [pid, w] of Object.entries(suggested)) {
            const cand = candById[pid];
            if (!cand?.nextBudgetAssumed || cand.nextBudgetAssumed <= 0) continue;
            const dailyShare = dailyTwd * (w / 100);
            const nextContrib = dailyShare * inNextMonthDays;
            const baseline = cand.nextSpent || 0;
            const nextBudget = cand.nextBudgetAssumed;
            const totalOver = Math.max(0, baseline + nextContrib - nextBudget);
            const baselineOver = Math.max(0, baseline - nextBudget);
            const newOnly = Math.max(0, totalOver - baselineOver);
            if (newOnly > 0.5) {
              newOnlyOverTotal += newOnly;
              overByProd.push({ name: nameOf[pid] || pid, over: newOnly });
            }
            if (baselineOver > 0.5) baselineOverTotal += baselineOver;
          }
          if (newOnlyOverTotal <= 0 && baselineOverTotal <= 0) return "";
          if (newOnlyOverTotal <= 0) {
            return `
              <div class="hint rev-summary rev-summary-info">
                ℹ️ 光現有廣告續費就會超 ${Math.ceil(baselineOverTotal / rate).toLocaleString()} RMB（與這筆採買無關）
              </div>
            `;
          }
          const totalEliminateRmb = Math.ceil(newOnlyOverTotal / rate);
          const detail = overByProd.map((x) => `${esc(x.name)} ${Math.ceil(x.over / rate).toLocaleString()}`).join("、");
          const baselineNote = baselineOverTotal > 0.5
            ? `<div class="rev-note">另外，光現有廣告續費就會超 ${Math.ceil(baselineOverTotal / rate).toLocaleString()} RMB（與這筆採買無關）</div>`
            : "";
          return `
            <div class="hint rev-summary rev-summary-bad">
              <strong>⚠️ 需先砍 ≈ ${totalEliminateRmb.toLocaleString()} RMB</strong>
              <div class="rev-note" style="margin-left:0">明細：${detail} RMB</div>
              ${baselineNote}
            </div>
          `;
        })()}
        ${excluded.length ? `
          <div class="hint" style="margin-top:12px;padding:10px 12px;background:#f7f9fc;border-radius:6px;font-size:12px">
            <strong>未納入分配的產品（${excluded.length}）：</strong>
            <ul style="margin:4px 0 0;padding-left:20px">
              ${excluded.map((c) => `<li><strong>${esc(c.p.name)}</strong> — ${esc(c.excludeReason)}</li>`).join("")}
            </ul>
          </div>
        ` : ""}
      </div>

      ${renderSimulatedMonthGrid({
        start_date: amtStart,
        end_date: amtEnd,
        amortize_days: amtDays,
        daily_amort_twd: dailyTwd,
        weights: suggested,
      })}
    `}
  `;
}

function bindHandlers(root) {
  root.querySelectorAll("[data-mode]").forEach((el) => {
    el.onclick = () => {
      mode = el.dataset.mode;
      render(root);
    };
  });

  if (mode === "date") {
    root.querySelector("#rev-date").onchange = (e) => { pickedDate = e.target.value; render(root); };
    root.querySelector("#rev-days").oninput = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0 && v <= 365) { amortizeDays = v; render(root); }
    };
    root.querySelectorAll("[data-rev-pid]").forEach((el) => {
      el.onclick = () => {
        const pid = el.dataset.revPid;
        if (pickedPids.has(pid)) pickedPids.delete(pid);
        else pickedPids.add(pid);
        render(root);
      };
    });
    const clearBtn = root.querySelector("#rev-clear-pids");
    if (clearBtn) clearBtn.onclick = () => { pickedPids.clear(); render(root); };
    const dc = root.querySelector("#date-create");
    if (dc) dc.onclick = () => createFromDateMode();
    const dcm = root.querySelector("#date-create-multi");
    if (dcm) dcm.onclick = () => createFromDateMultiMode();
  } else {
    const apply = () => render(root);
    const q = (sel) => root.querySelector(sel);
    q("#amt-cny").onchange = (e) => { amtCny = Number(e.target.value) || 0; apply(); };
    q("#amt-start").onchange = (e) => { amtStart = e.target.value; apply(); };
    q("#amt-end").onchange = (e) => { amtEnd = e.target.value; apply(); };
    q("#amt-days").onchange = (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0 && v <= 365) { amtDays = v; apply(); }
    };
    const create = q("#amt-create");
    if (create) create.onclick = () => createFromAmountMode();
  }
}

function createFromAmountMode() {
  const s = getState();
  const ym = s.settings.current_month;
  const rate = s.settings.expense_rate;
  const dailyTwd = amtDays > 0 ? (amtCny * rate) / amtDays : 0;
  const fakeAd = {
    start_date: amtStart, end_date: amtEnd,
    amortize_days: amtDays, daily_amort_twd: dailyTwd,
  };
  const r = suggestWeights(s, s.products, s.ads, ym, fakeAd);
  // 暫存 prefill 給 ads 編輯彈窗
  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: amtCny,
    exchange_rate: rate,
    start_date: amtStart,
    end_date: amtEnd,
    amortize_days: amtDays,
    weights: r.weights,
  }));
  location.hash = "#ads";
}

// date mode「用此參數建立廣告」：單一產品時 100%；多選時用合計 daily + 比例權重
function createFromDateMode() {
  const s = getState();
  const rate = s.settings.expense_rate;
  const cards = suggestForDate(s, pickedDate, rate, amortizeDays);
  const onlyPid = pickedPids.size === 1 ? [...pickedPids][0] : null;
  const card = cards.find((c) => c.product.id === onlyPid);
  if (!card || card.kind !== "ok" || card.suggestTwd <= 0) {
    toast("該產品這天沒有可加空間", "bad");
    return;
  }

  const totalTwd = card.suggestTwd * amortizeDays;
  const cny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const startDate = pickedDate;
  const endDate = addDays(startDate, amortizeDays);

  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: cny,
    exchange_rate: rate,
    start_date: startDate,
    end_date: endDate,
    amortize_days: amortizeDays,
    weights: { [onlyPid]: 100 },
  }));
  location.hash = "#ads";
}

// date mode 多選：合計 daily 為廣告 daily，依各產品 suggestTwd 比例分權
function createFromDateMultiMode() {
  const s = getState();
  const rate = s.settings.expense_rate;
  const cards = suggestForDate(s, pickedDate, rate, amortizeDays);
  const usable = cards.filter((c) => pickedPids.has(c.product.id) && c.kind === "ok" && c.suggestTwd > 0);
  if (usable.length === 0) {
    toast("選中的產品都沒有可加空間", "bad");
    return;
  }
  const totalDailyTwd = usable.reduce((s, c) => s + c.suggestTwd, 0);
  const weights = computeIntegerWeights(usable.map((c) => ({ id: c.product.id, value: c.suggestTwd })));
  const totalTwd = totalDailyTwd * amortizeDays;
  const cny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const startDate = pickedDate;
  const endDate = addDays(startDate, amortizeDays);
  sessionStorage.setItem("buyads_prefill_ad", JSON.stringify({
    amount_cny: cny,
    exchange_rate: rate,
    start_date: startDate,
    end_date: endDate,
    amortize_days: amortizeDays,
    weights,
  }));
  location.hash = "#ads";
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
