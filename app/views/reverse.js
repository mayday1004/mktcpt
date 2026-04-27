import { getState } from "../state.js";
import { suggestForDate } from "../domain/reverse.js";
import { suggestWeights } from "../domain/suggest.js";

let mode = "date";  // "date" | "amount"
let pickedDate = "";
let pickedPids = new Set();  // date-mode 多選產品 id
let amortizeDays = 30;

// amount-mode 表單值
let amtStart = "";
let amtEnd = "";
let amtDays = 30;
let amtCny = 0;

function todayStr() { return new Date().toISOString().slice(0, 10); }

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;
  const today = todayStr();
  // 預設目標日 = 今天（若今日已過當月，仍以今日為準，使用者可自行往後挑）
  if (!pickedDate || pickedDate < today) pickedDate = today;
  if (!amtStart || amtStart < today) amtStart = today;
  if (!amtEnd || amtEnd <= amtStart) {
    const d = new Date(amtStart);
    d.setDate(d.getDate() + 30);
    amtEnd = d.toISOString().slice(0, 10);
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
  const cards = suggestForDate(s, pickedDate, rate);
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

      <div class="rev-suggest" style="margin-bottom:14px;font-size:14px">
        ${pickedDate} 起合計可補 <strong style="font-size:18px">${Math.round(totalDailyTwd).toLocaleString()}</strong> TWD/日<br>
        <span class="ink-2" style="font-size:13px">
          買一筆 ${days} 天的廣告 → 總價 <strong>${totalCny.toLocaleString()}</strong> RMB
          （= ${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
        </span>
      </div>

      <div class="rev-product-cards">
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
              <div class="rev-row"><span class="label">月剩餘</span><span class="val">${Math.round(c.monthRemaining || 0).toLocaleString()}</span></div>
              <div class="rev-row"><span class="label">當日尚可加</span><span class="val">${Math.round(c.todayHeadroom || 0).toLocaleString()}</span></div>
              <div class="rev-row"><span class="label">分到 daily</span><span class="val"><strong>${Math.round(dailyShare).toLocaleString()}</strong></span></div>
            </div>
          `;
        }).join("")}
      </div>

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
  return `
    <div class="card">
      <div class="card-head">
        <h2>${esc(c.product.name)} <span class="pill ${c.product.type}" style="font-weight:400">${c.product.type === "app" ? "APP" : "小島"}</span></h2>
        ${usable ? `<button class="primary" id="date-create">📋 用此參數建立廣告</button>` : ""}
      </div>

      <div class="rev-product-cards">
        <div class="rev-card">
          <h3 style="margin-bottom:8px">月度狀況</h3>
          <div class="rev-row"><span class="label">月預算</span><span class="val">${Math.round(c.budget).toLocaleString()}</span></div>
          <div class="rev-row"><span class="label">月已花</span><span class="val">${Math.round(c.monthSpent).toLocaleString()}</span></div>
          <div class="rev-row"><span class="label">月剩餘</span><span class="val"><strong>${Math.round(c.monthRemaining).toLocaleString()}</strong></span></div>
        </div>

        <div class="rev-card">
          <h3 style="margin-bottom:8px">${pickedDate} 當日狀況</h3>
          <div class="rev-row"><span class="label">建議日花費上緣</span><span class="val">${Math.round(c.band.upper).toLocaleString()}</span></div>
          <div class="rev-row"><span class="label">已配置</span><span class="val">${Math.round(c.todaySpent).toLocaleString()}</span></div>
          <div class="rev-row"><span class="label">尚可加</span><span class="val"><strong>${Math.round(c.todayHeadroom).toLocaleString()}</strong></span></div>
        </div>
      </div>

      <div class="rev-suggest" style="margin-top:16px;font-size:14px">
        ${usable ? `
          這天可補 <strong style="font-size:18px">${Math.round(c.suggestTwd).toLocaleString()}</strong> TWD（取「月剩餘」與「當日尚可加」較小者）<br>
          <span class="ink-2" style="font-size:13px">
            買一筆 ${days} 天的廣告，本產品 100% 採買 →
            總價約 <strong>${totalCny.toLocaleString()}</strong> RMB
            （= ${Math.round(totalTwd).toLocaleString()} TWD ÷ ${rate}）
          </span>
        ` : `
          <span style="color:var(--bad)">${esc(c.note || "—")}</span>
        `}
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
    const d = new Date(amtStart);
    d.setDate(d.getDate() + amtDays);
    amtEnd = d.toISOString().slice(0, 10);
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
        <label>金額（人民幣）</label>
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
    ` : `
      <div class="card">
        <div class="card-head">
          <h2>建議權重分配</h2>
          <button class="primary" id="amt-create">📋 用此參數建立廣告</button>
        </div>
        ${reasons.length ? `<div class="hint">${reasons.map((r) => esc(r)).join("；")}</div>` : `<div class="hint" style="color:var(--ok)">建議已套用（依各產品剩餘預算比例，受建議日花費上緣限制；已補到位的產品自動排除）</div>`}
        <div class="rev-product-cards mt-16">
          ${Object.entries(suggested)
            .sort(([, a], [, b]) => b - a)
            .map(([pid, w]) => {
              const dailyShare = dailyTwd * (w / 100);
              const totalShare = amountTwd * (w / 100);
              const cand = candById[pid];
              // 月內貢獻：本廣告在 ym 內的天數 × dailyShare
              const monthContrib = dailyShare * inMonthDays;
              const monthSpent = cand?.spent || 0;
              const budget = cand?.budget;
              const projTotal = monthSpent + monthContrib;
              let budgetLine = "";
              if (budget != null && budget > 0) {
                const over = projTotal - budget;
                if (over > 0.5) {
                  budgetLine = `<div class="rev-row"><span class="label">本月攤提預估</span><span class="val" style="color:var(--bad)"><strong>${Math.round(projTotal).toLocaleString()}</strong> / ${Math.round(budget).toLocaleString()} ✗ 超 ${Math.round(over).toLocaleString()}</span></div>`;
                } else {
                  budgetLine = `<div class="rev-row"><span class="label">本月攤提預估</span><span class="val" style="color:var(--ok)"><strong>${Math.round(projTotal).toLocaleString()}</strong> / ${Math.round(budget).toLocaleString()} ✓</span></div>`;
                }
              }
              // 下月攤提預估：跨月時顯示。基線為「假設所有現有廣告都續費」的下月合計。
              // 預算未設則假設＝本月。爆超 → 加註建議淘汰 RMB 量。
              let nextMonthLine = "";
              let nextEliminateLine = "";
              if (inNextMonthDays > 0 && cand?.nextBudgetAssumed != null && cand.nextBudgetAssumed > 0) {
                const nextContrib = dailyShare * inNextMonthDays;
                const nextProj = (cand.nextSpent || 0) + nextContrib;  // nextSpent 已是「續費假設後」的基線
                const nextBudget = cand.nextBudgetAssumed;
                const nextOver = nextProj - nextBudget;
                const tags = [];
                if (cand.nextBudgetIsAssumed) tags.push("預算假設＝本月");
                tags.push("含現廣告續費");
                const tagHtml = `<span class="ink-3" style="font-size:11px">（${tags.join("；")}）</span>`;
                if (nextOver > 0.5) {
                  nextMonthLine = `<div class="rev-row"><span class="label">下月攤提預估 ${tagHtml}</span><span class="val" style="color:var(--bad)"><strong>${Math.round(nextProj).toLocaleString()}</strong> / ${Math.round(nextBudget).toLocaleString()} ✗ 超 ${Math.round(nextOver).toLocaleString()}</span></div>`;
                  // 建議淘汰：把超出 TWD 換算回 RMB（以 rate 換算，保守估）
                  const eliminateRmb = rate > 0 ? Math.ceil(nextOver / rate) : 0;
                  if (eliminateRmb > 0) {
                    nextEliminateLine = `<div class="rev-row"><span class="label">需淘汰 RMB</span><span class="val" style="color:var(--bad)">≈ <strong>${eliminateRmb.toLocaleString()}</strong> RMB（以 ${rate} 換算）</span></div>`;
                  }
                } else {
                  nextMonthLine = `<div class="rev-row"><span class="label">下月攤提預估 ${tagHtml}</span><span class="val" style="color:var(--ok)"><strong>${Math.round(nextProj).toLocaleString()}</strong> / ${Math.round(nextBudget).toLocaleString()} ✓</span></div>`;
                }
              }
              return `
                <div class="rev-card">
                  <h3>
                    <span>${esc(nameOf[pid] || pid)}</span>
                    <span class="pill ${productOf[pid]?.type || ""}" style="font-weight:400;font-size:11px;margin-left:4px">${productOf[pid]?.type === "app" ? "APP" : "小島"}</span>
                    <span class="pill" style="font-size:14px;margin-left:auto">${w}%</span>
                  </h3>
                  <div class="rev-row"><span class="label">每日攤提（TWD）</span><span class="val">${Math.round(dailyShare).toLocaleString()}</span></div>
                  <div class="rev-row"><span class="label">總額分攤（TWD）</span><span class="val">${Math.round(totalShare).toLocaleString()}</span></div>
                  <div class="rev-row"><span class="label">總額分攤（RMB）</span><span class="val">${Math.round(totalShare / rate).toLocaleString()}</span></div>
                  ${budgetLine}
                  ${nextMonthLine}
                  ${nextEliminateLine}
                </div>
              `;
            }).join("")}
        </div>
        <div class="hint mt-16">
          合計：<strong>${totalW}%</strong>
          ${inMonthDays ? `；本月攤提天 <strong>${inMonthDays}</strong>` : ""}
          ${inNextMonthDays ? `；下月（${ymNext}）攤提天 <strong>${inNextMonthDays}</strong>` : ""}
        </div>
        ${(() => {
          // 全局淘汰建議：彙總所有產品的下月超支
          if (!inNextMonthDays || rate <= 0) return "";
          let totalOverTwd = 0;
          const overByProd = [];
          for (const [pid, w] of Object.entries(suggested)) {
            const cand = candById[pid];
            if (!cand?.nextBudgetAssumed || cand.nextBudgetAssumed <= 0) continue;
            const dailyShare = dailyTwd * (w / 100);
            const nextContrib = dailyShare * inNextMonthDays;
            const nextProj = (cand.nextSpent || 0) + nextContrib;
            const over = nextProj - cand.nextBudgetAssumed;
            if (over > 0.5) {
              totalOverTwd += over;
              overByProd.push({ name: nameOf[pid] || pid, over });
            }
          }
          if (totalOverTwd <= 0) return "";
          const totalEliminateRmb = Math.ceil(totalOverTwd / rate);
          const detail = overByProd.map((x) => `${esc(x.name)} ≈ ${Math.ceil(x.over / rate).toLocaleString()} RMB`).join("、");
          return `
            <div class="hint" style="margin-top:12px;padding:10px 12px;background:#fde3e3;border-radius:6px;font-size:13px;color:var(--bad)">
              <strong>⚠️ 下月超支總計</strong>：${Math.round(totalOverTwd).toLocaleString()} TWD<br>
              要買進這筆廣告，建議**先淘汰約 ${totalEliminateRmb.toLocaleString()} RMB** 的現有廣告（明細：${detail}），讓下月有空間接住攤提。<br>
              <span class="ink-3" style="font-size:11px">假設前提：(1) 下月所有現有廣告會續費 (2) 下月預算暫以本月為基準</span>
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
  const cards = suggestForDate(s, pickedDate, rate);
  const onlyPid = pickedPids.size === 1 ? [...pickedPids][0] : null;
  const card = cards.find((c) => c.product.id === onlyPid);
  if (!card || card.kind !== "ok" || card.suggestTwd <= 0) {
    toast("該產品這天沒有可加空間", "bad");
    return;
  }

  const totalTwd = card.suggestTwd * amortizeDays;
  const cny = rate > 0 ? Math.round(totalTwd / rate) : 0;
  const startDate = pickedDate;
  const endDateObj = new Date(startDate);
  endDateObj.setDate(endDateObj.getDate() + amortizeDays);
  const endDate = endDateObj.toISOString().slice(0, 10);

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
  const cards = suggestForDate(s, pickedDate, rate);
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
  const endDateObj = new Date(startDate);
  endDateObj.setDate(endDateObj.getDate() + amortizeDays);
  const endDate = endDateObj.toISOString().slice(0, 10);
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
