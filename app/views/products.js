import { getState, update, uid } from "../state.js";
import { PRODUCT_TYPES, METRICS, getMonthlyBudget, getDailyBudget, getBudgetSource, getBudgetChanges } from "../schema.js";
import { daysInMonth, todayTaipei } from "../lib/dates.js";
import { evalFormula, validateFormula } from "../lib/formula.js";

// 模組級狀態：使用者選的檢視月份（可預先設定未來月的預算）
// null = 沿用 settings.current_month；改後保留直到頁面重整
let viewYm = null;

export function render(root) {
  const s = getState();
  if (!viewYm || !/^\d{4}-\d{2}$/.test(viewYm)) viewYm = s.settings.current_month;
  // 防禦：若 viewYm 仍是壞值（被 Sheets 拉成 ISO），顯示時還原成 YYYY-MM
  let ym = viewYm;
  if (ym && !/^\d{4}-\d{2}$/.test(ym)) {
    const d = new Date(ym);
    if (!Number.isNaN(d.getTime())) {
      ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    }
  }

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>產品</h1>
        <div class="desc">產品主檔、月預算（每月獨立）、成效目標公式 — 檢視月份：<input type="month" id="view-ym" value="${ym}" class="view-ym-input" /></div>
      </div>
      <div class="view-actions">
        <button class="primary" id="btn-add-product">＋ 新增產品</button>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>產品</th>
              <th>類型</th>
              <th class="num">${ym} 月預算（台幣）</th>
              <th>成效目標</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${s.products.map((p) => row(s, p, ym)).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;

  const ymInput = root.querySelector("#view-ym");
  if (ymInput) ymInput.onchange = (e) => {
    const v = e.target.value;
    if (/^\d{4}-\d{2}$/.test(v)) {
      viewYm = v;
      render(root);
    }
  };
  root.querySelector("#btn-add-product").onclick = () => openEditor(null, ym);
  root.querySelectorAll("[data-edit]").forEach((el) => {
    el.onclick = () => openEditor(el.dataset.edit, ym);
  });
  root.querySelectorAll("[data-bump]").forEach((el) => {
    el.onclick = () => openBumpBudget(el.dataset.bump, ym);
  });
  root.querySelectorAll("[data-del]").forEach((el) => {
    el.onclick = async () => {
      const ok = await confirmAsync({
        title: "刪除產品",
        body: "刪除後相關的廣告權重需要手動處理。確定？",
        okText: "刪除", danger: true,
      });
      if (!ok) return;
      update((st) => {
        st.products = st.products.filter((p) => p.id !== el.dataset.del);
      }, "刪除產品");
      toast("已刪除", "ok");
    };
  });
}

// 「本月加預算」彈窗：登記一筆 budget_change，並更新 monthly_budgets
// 使用 forward-only 帶寬：from at_date 起到月底用「(新預算 - 段前已花) / 段內天數」算 daily target
function openBumpBudget(pid, ym) {
  const s = getState();
  const product = s.products.find((p) => p.id === pid);
  if (!product) return;
  const isIsland = product.type === "island";
  const mode = isIsland ? "daily" : "monthly";
  const today = todayTaipei();

  // 取「目前段值」— 找到 today 所屬的段，取其 amount 當基準（依 mode 解讀）
  const changes = getBudgetChanges(s, pid, ym);
  const findApplicable = (atDay) => {
    let pick = null;
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i].at_date <= atDay) { pick = changes[i]; break; }
    }
    return pick;
  };
  const todayInMonth = today >= `${ym}-01` && today < nextMonthFirst(ym);
  const refDay = todayInMonth ? today : `${ym}-01`;
  const cur = findApplicable(refDay)?.amount || 0;

  // 月份合法區間
  const minDate = `${ym}-01`;
  const dim = daysInMonth(ym);
  const maxDate = `${ym}-${String(dim).padStart(2, "0")}`;
  const initialDate = todayInMonth ? today : minDate;

  const labelCur = isIsland ? "當日預算（目前）" : "當月預算（目前）";
  const labelNew = isIsland ? "新日預算（台幣）" : "新月預算（台幣）";
  const formatAmt = (a) => Math.round(a).toLocaleString();

  const html = `
    <h2>${isIsland ? "加日預算" : "本月加預算"} — ${escape(product.name)} <span class="pill ${product.type}" style="font-size:11px;font-weight:400">${isIsland ? "小島" : "APP"}</span></h2>
    <p class="ink-2" style="font-size:13px">
      ${isIsland
        ? "從生效日起，每日預算（建議日花費基準）改為新值；生效日之前仍按舊日預算評估。可填過去日期回溯生效。"
        : "從生效日起，重新計算建議日花費 = (新月預算 - 段前已花) / 段內天數；生效日之前的日子保留原建議。可填過去日期回溯生效。"}
    </p>
    <div class="field-row">
      <div class="field">
        <label>${labelCur}</label>
        <input value="${formatAmt(cur)}" disabled />
      </div>
      <div class="field">
        <label>${labelNew}</label>
        <input type="number" id="bb-amount" value="${cur}" min="1" />
      </div>
      <div class="field">
        <label>生效日</label>
        <input type="date" id="bb-date" value="${initialDate}" min="${minDate}" max="${maxDate}" />
        <div class="hint">可填過去 / 今天 / 未來，限本月內</div>
      </div>
    </div>

    ${changes.length > 0 ? `
      <h3>本月變動紀錄</h3>
      <ul class="bc-history">
        ${changes.map((c, i) => `<li><span class="mono">${c.at_date}</span> → ${formatAmt(c.amount)} ${c.mode === "daily" ? "/日" : "（月度）"} ${i === 0 ? "<span class='ink-3'>(月初)</span>" : ""}</li>`).join("")}
      </ul>
    ` : ""}

    <div class="modal-actions">
      <button id="bb-cancel">取消</button>
      <button class="primary" id="bb-save">套用</button>
    </div>
  `;
  const dlg = modal.open(html);
  dlg.querySelector("#bb-cancel").onclick = () => modal.close();
  dlg.querySelector("#bb-save").onclick = () => {
    const newAmount = Number(dlg.querySelector("#bb-amount").value) || 0;
    const atDate = dlg.querySelector("#bb-date").value;
    if (newAmount <= 0) { toast("新預算需 > 0", "bad"); return; }
    if (newAmount === cur) { toast("新預算與目前相同，無需調整", ""); return; }
    if (!atDate || atDate < minDate || atDate > maxDate) { toast("生效日需在當月內", "bad"); return; }

    update((st) => {
      if (!st.budget_changes) st.budget_changes = {};
      if (!st.budget_changes[pid]) st.budget_changes[pid] = {};
      const arr = Array.isArray(st.budget_changes[pid][ym]) ? [...st.budget_changes[pid][ym]] : [];

      // 第一次加 — 把月初當前預算寫進去當第 0 段
      if (arr.length === 0) {
        const initial = changes.length > 0 ? changes[0].amount : cur;
        arr.push({ at_date: `${ym}-01`, amount: initial, mode });
      }
      // 同 at_date 已存在 → 覆寫；否則新增
      const existing = arr.find((c) => c.at_date === atDate);
      if (existing) {
        existing.amount = newAmount;
        existing.mode = mode;
      } else {
        arr.push({ at_date: atDate, amount: newAmount, mode });
      }
      arr.sort((a, b) => (a.at_date < b.at_date ? -1 : 1));
      st.budget_changes[pid][ym] = arr;

      // 同步 monthly_budgets / daily_budgets 的「初始值」（第 0 段 = 月初值）
      if (!st.monthly_budgets) st.monthly_budgets = {};
      if (!st.daily_budgets) st.daily_budgets = {};
      if (!st.monthly_budgets[pid]) st.monthly_budgets[pid] = {};
      if (!st.daily_budgets[pid]) st.daily_budgets[pid] = {};
      // 不更動既有月初基準（讓 budget_changes 自己當真相）
    }, `${isIsland ? "加日預算" : "本月加預算"} ${product.name} ${formatAmt(cur)}→${formatAmt(newAmount)}`);
    modal.close();
    toast(`已加預算：${formatAmt(cur)} → ${formatAmt(newAmount)}${isIsland ? " /日" : ""}`, "ok");
  };
}

function nextMonthFirst(ym) {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}

function row(state, p, ym) {
  const targets = (p.performance_targets || []).map((t) => `<span class="pill">${t.name}</span>`).join(" ") || `<span class="ink-3">未設定</span>`;
  const monthly = getMonthlyBudget(state, p.id, ym);
  const daily = getDailyBudget(state, p.id, ym);
  const source = getBudgetSource(state, p.id, ym);
  const changes = getBudgetChanges(state, p.id, ym);

  let budgetCell;
  const hasMultiSeg = changes.length > 1;
  if (monthly == null) {
    budgetCell = `<span class="pill warn">未設定</span>`;
  } else if (source === "daily" && !hasMultiSeg) {
    // 小島單段：顯示 daily × days 推導式
    budgetCell = `<strong>${Math.round(monthly).toLocaleString()}</strong>
      <div class="ink-3 mono" style="font-size:11px">= ${daily.toLocaleString()}/日 × ${daysInMonth(ym)} 天</div>`;
  } else if (hasMultiSeg) {
    // 有多段：顯示「最新段值」與下方 timeline，避免「= 舊daily × days」誤導
    const last = changes[changes.length - 1];
    const latestLabel = last.mode === "daily"
      ? `<span class="ink-3 mono" style="font-size:11px">最新 ${Math.round(last.amount).toLocaleString()}/日</span>`
      : `<span class="ink-3 mono" style="font-size:11px">最新月度 ${Math.round(last.amount).toLocaleString()}</span>`;
    budgetCell = `<strong>${Math.round(monthly).toLocaleString()}</strong>
      <div>${latestLabel}</div>`;
  } else {
    budgetCell = `<strong>${Math.round(monthly).toLocaleString()}</strong>`;
  }
  // 顯示分段時間軸（多於 1 段時）
  if (changes.length > 1) {
    const tlHtml = changes.map((c, i) => {
      const isLast = i === changes.length - 1;
      const cls = i === 0 ? "" : "warn";
      const suffix = c.mode === "daily" ? "/日" : "";
      return `<span class="bc-step ${cls}">${i === 0 ? "🟢" : "▴"} ${c.at_date.slice(5)} → ${Math.round(c.amount).toLocaleString()}${suffix}${isLast ? " <span class='ink-3'>(現)</span>" : ""}</span>`;
    }).join(" ");
    budgetCell += `<div class="bc-timeline">${tlHtml}</div>`;
  }
  return `
    <tr>
      <td><strong>${p.name}</strong><div class="ink-3 mono" style="font-size:11px">${p.id}</div></td>
      <td><span class="pill ${p.type}">${PRODUCT_TYPES[p.type].label}</span><div class="ink-3" style="font-size:11px;margin-top:2px">${PRODUCT_TYPES[p.type].desc}</div></td>
      <td class="num">${budgetCell}</td>
      <td>${targets}</td>
      <td class="right nowrap">
        ${monthly != null ? `<button data-bump="${p.id}" title="本月加預算">＋ 加預算</button>` : ""}
        <button data-edit="${p.id}">編輯</button>
        <button class="danger" data-del="${p.id}">刪除</button>
      </td>
    </tr>
  `;
}

function openEditor(id, ym) {
  const s = getState();
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) ym = s.settings.current_month;
  const p = id ? structuredClone(s.products.find((x) => x.id === id)) : blank();
  if (!p.performance_targets) p.performance_targets = [];
  const existingMonthly = id ? { ...(s.monthly_budgets?.[id] || {}) } : {};
  const existingDaily = id ? { ...(s.daily_budgets?.[id] || {}) } : {};

  const currentMonthly = existingMonthly[ym] ?? "";
  const currentDaily = existingDaily[ym] ?? "";

  // 把所有出現過的月份合併（去重 current）
  const allMonths = new Set([...Object.keys(existingMonthly), ...Object.keys(existingDaily)]);
  allMonths.delete(ym);
  const otherMonths = [...allMonths].sort((a, b) => b.localeCompare(a));

  const html = `
    <h2>${id ? "編輯產品" : "新增產品"}</h2>
    <div class="field-row">
      <div class="field"><label>產品名稱</label><input id="f-name" value="${p.name || ""}" /></div>
      <div class="field">
        <label>類型 ${id ? '<span class="ink-3" style="font-size:11px;font-weight:400">（建議勿變更）</span>' : ""}</label>
        <select id="f-type">
          <option value="app" ${p.type === "app" ? "selected" : ""}>APP（月預算 / 建議日花費 ±30%）</option>
          <option value="island" ${p.type === "island" ? "selected" : ""}>小島（日預算 / 建議日花費 ±0.5%）</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-top:8px">
      <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
        <input type="checkbox" id="f-no-band" ${p.no_band ? "checked" : ""} style="width:auto" />
        <span>不檢查每日帶寬</span>
        <span class="ink-3" style="font-size:11px">(破圈系列等極端花費產品勾選;成效調整、儀表板都跳過 ±範圍警示)</span>
      </label>
    </div>
    <div class="field" style="margin-top:4px">
      <label style="display:flex;align-items:center;gap:6px;font-weight:normal">
        <input type="checkbox" id="f-is-poquan" ${p.is_poquan ? "checked" : ""} style="width:auto" />
        <span>這是破圈產品</span>
        <span class="ink-3" style="font-size:11px">(新增廣告時可被選為「拆出破圈分流」目標;儀表板會歸到母產品家族卡片)</span>
      </label>
    </div>
    <div class="field" id="parent-product-row" style="margin-top:4px;display:${p.is_poquan ? "block" : "none"}">
      <label>母產品</label>
      <select id="f-parent-pid">
        <option value="">(無)</option>
        ${s.products.filter((x) => x.id !== id && !x.is_poquan && x.type === "app").map((x) =>
          `<option value="${escape(x.id)}" ${p.parent_product_id === x.id ? "selected" : ""}>${escape(x.name)} (${escape(x.id)})</option>`
        ).join("")}
      </select>
      <div class="hint">破圈會在儀表板歸入此母產品的家族卡片;權重邏輯仍完全獨立</div>
    </div>

    <h3 class="mt-16">${ym} 預算（台幣）</h3>
    <div id="budget-section"></div>

    <div id="other-budgets-section"></div>

    <h3 class="mt-16">成效目標</h3>
    <div id="targets"></div>
    <button class="mt-8" id="add-target">＋ 新增目標</button>

    <details class="mt-8" style="font-size:12px;color:var(--ink-2)">
      <summary style="cursor:pointer;user-select:none;color:var(--accent)">📖 公式可用的變數（${METRICS.length} 個）</summary>
      <div style="margin-top:8px;padding:10px 12px;background:#f6f8fc;border:1px solid #e1e8f2;border-radius:6px;line-height:1.8">
        ${METRICS.map((m) => `<code style="display:inline-block;margin:2px 6px 2px 0;padding:1px 6px;background:#fff;border:1px solid #d6def0;border-radius:3px;font-family:var(--mono);font-size:11px">${m}</code>`).join("")}
        <div class="ink-3" style="margin-top:6px;font-size:11px">把上面變數名稱直接寫進公式，例如 <code class="mono">花費/不重複安裝數</code>（CPI）、<code class="mono">花費/事件計數</code>（CPC）。支援 + - * / 與括號。</div>
      </div>
    </details>

    <div class="modal-actions">
      <button id="cancel">取消</button>
      <button class="primary" id="save">儲存</button>
    </div>
  `;
  const dlg = modal.open(html);

  // 依目前選的類型，動態渲染預算欄位（APP→月預算；小島→日預算）
  const renderBudgetSection = () => {
    const t = dlg.querySelector("#f-type").value;
    const host = dlg.querySelector("#budget-section");
    if (t === "island") {
      host.innerHTML = `
        <div class="field">
          <label>日預算</label>
          <input id="f-budget-daily" type="number" placeholder="（未設定）" value="${dlg.querySelector("#f-budget-daily")?.value ?? currentDaily}" />
          <div class="hint">每日固定預算；月度合計 = 日預算 × ${daysInMonth(ym)} 天（${ym}）</div>
        </div>
      `;
    } else {
      host.innerHTML = `
        <div class="field">
          <label>月預算</label>
          <input id="f-budget-monthly" type="number" placeholder="（未設定）" value="${dlg.querySelector("#f-budget-monthly")?.value ?? currentMonthly}" />
          <div class="hint">整月目標金額</div>
        </div>
      `;
    }

    // 其他月份區（亦依類型只顯示對應欄位）
    const otherHost = dlg.querySelector("#other-budgets-section");
    if (otherMonths.length === 0) { otherHost.innerHTML = ""; return; }
    const isIsland = t === "island";
    otherHost.innerHTML = `
      <h3 class="mt-16">其他月份（${isIsland ? "日預算" : "月預算"}）</h3>
      <div class="ink-2" style="font-size:12px">
        ${otherMonths.map((m) => {
          const v = isIsland ? (existingDaily[m] ?? "") : (existingMonthly[m] ?? "");
          return `
            <div class="other-month-row">
              <span class="mono" style="min-width:64px">${m}</span>
              <input data-budget-month="${m}" data-budget-mode="${isIsland ? "daily" : "monthly"}" type="number" value="${v}" placeholder="${isIsland ? "日預算" : "月預算"}" />
            </div>
          `;
        }).join("")}
      </div>
    `;
  };
  renderBudgetSection();
  dlg.querySelector("#f-type").onchange = renderBudgetSection;

  // 「這是破圈產品」勾選時才顯示母產品下拉
  const poqToggle = dlg.querySelector("#f-is-poquan");
  const parentRow = dlg.querySelector("#parent-product-row");
  if (poqToggle && parentRow) {
    poqToggle.onchange = () => {
      parentRow.style.display = poqToggle.checked ? "block" : "none";
    };
  }

  const renderTargets = () => {
    const host = dlg.querySelector("#targets");
    host.innerHTML = p.performance_targets.map((t, i) => targetRow(t, i)).join("") ||
      `<div class="ink-3" style="padding:8px 0">尚未設定任何目標。可用變數：${METRICS.join("、")}</div>`;
    host.querySelectorAll("[data-tdel]").forEach((el) => {
      el.onclick = () => {
        p.performance_targets.splice(Number(el.dataset.tdel), 1);
        renderTargets();
      };
    });
    host.querySelectorAll("[data-t-idx]").forEach((inp) => {
      inp.oninput = () => {
        const i = Number(inp.dataset.tIdx);
        const f = inp.dataset.tField;
        p.performance_targets[i][f] = inp.value;
      };
    });
  };

  renderTargets();
  dlg.querySelector("#add-target").onclick = () => {
    p.performance_targets.push({ id: uid("pt"), name: "", formula: "", goal_value: 0, direction: "lower_better" });
    renderTargets();
  };

  dlg.querySelector("#cancel").onclick = () => modal.close();
  dlg.querySelector("#save").onclick = () => {
    const isPoq = !!dlg.querySelector("#f-is-poquan")?.checked;
    const patch = {
      name: dlg.querySelector("#f-name").value.trim(),
      type: dlg.querySelector("#f-type").value,
      no_band: !!dlg.querySelector("#f-no-band")?.checked,
      is_poquan: isPoq,
      parent_product_id: isPoq ? (dlg.querySelector("#f-parent-pid")?.value || "") : "",
      performance_targets: p.performance_targets.filter((t) => t.name),
    };
    if (!patch.name) { toast("請輸入名稱", "bad"); return; }
    for (const t of patch.performance_targets) {
      const err = validateFormula(t.formula);
      if (err) { toast(`目標「${t.name}」公式錯：${err}`, "bad"); return; }
      t.goal_value = Number(t.goal_value) || 0;
    }
    // 依類型收集當月預算（APP→只有 monthly；小島→只有 daily）
    const newMonthly = {};
    const newDaily = {};
    const isIsland = patch.type === "island";
    if (isIsland) {
      const dayStr = dlg.querySelector("#f-budget-daily")?.value.trim() || "";
      const dayV = Number(dayStr);
      if (dayStr !== "" && Number.isFinite(dayV) && dayV > 0) newDaily[ym] = dayV;
    } else {
      const monStr = dlg.querySelector("#f-budget-monthly")?.value.trim() || "";
      const monV = Number(monStr);
      if (monStr !== "" && Number.isFinite(monV) && monV > 0) newMonthly[ym] = monV;
    }
    // 其他月份：依當前類型只收集對應 mode 的輸入
    dlg.querySelectorAll("[data-budget-month]").forEach((inp) => {
      const m = inp.dataset.budgetMonth;
      const mode = inp.dataset.budgetMode;
      const v = Number(inp.value);
      if (!Number.isFinite(v) || v <= 0) return;
      if (mode === "daily") newDaily[m] = v;
      else if (mode === "monthly") newMonthly[m] = v;
    });

    update((st) => {
      let pid;
      if (id) {
        const idx = st.products.findIndex((x) => x.id === id);
        st.products[idx] = { ...st.products[idx], ...patch };
        pid = id;
      } else {
        pid = uid("prod");
        st.products.push({ id: pid, ...patch });
      }
      if (!st.monthly_budgets) st.monthly_budgets = {};
      if (!st.daily_budgets) st.daily_budgets = {};
      // 比對哪些月份預算「實質變動」了 — 變動的月份才清 budget_changes
      // 沒變動的月份保留時序紀錄（避免使用者修個成效目標就丟失預算分段）
      const oldMonthly = id ? (st.monthly_budgets?.[pid] || {}) : {};
      const oldDaily = id ? (st.daily_budgets?.[pid] || {}) : {};
      const changedMonths = new Set();
      const allMonths = new Set([
        ...Object.keys(oldMonthly), ...Object.keys(newMonthly),
        ...Object.keys(oldDaily), ...Object.keys(newDaily),
      ]);
      for (const m of allMonths) {
        if ((oldMonthly[m] || 0) !== (newMonthly[m] || 0) || (oldDaily[m] || 0) !== (newDaily[m] || 0)) {
          changedMonths.add(m);
        }
      }
      st.monthly_budgets[pid] = newMonthly;
      st.daily_budgets[pid] = newDaily;
      if (changedMonths.size > 0 && st.budget_changes?.[pid]) {
        for (const m of changedMonths) delete st.budget_changes[pid][m];
        if (Object.keys(st.budget_changes[pid]).length === 0) delete st.budget_changes[pid];
      }
    }, id ? "編輯產品" : "新增產品");
    modal.close();
    toast("已儲存", "ok");
  };
}

function targetRow(t, i) {
  return `
    <div class="card" style="margin-bottom:8px;padding:12px">
      <div class="field-row">
        <div class="field" style="flex:1"><label>目標名稱</label><input data-t-idx="${i}" data-t-field="name" value="${t.name || ""}" placeholder="例：CPI" /></div>
        <div class="field" style="flex:2"><label>計算公式</label><input data-t-idx="${i}" data-t-field="formula" value="${t.formula || ""}" placeholder="例：花費/不重複安裝數" /></div>
        <div class="field" style="flex:1"><label>目標值</label><input data-t-idx="${i}" data-t-field="goal_value" type="number" step="any" value="${t.goal_value ?? 0}" /></div>
        <div class="field" style="flex:1"><label>方向</label>
          <select data-t-idx="${i}" data-t-field="direction">
            <option value="lower_better" ${t.direction === "lower_better" ? "selected" : ""}>越低越好</option>
            <option value="higher_better" ${t.direction === "higher_better" ? "selected" : ""}>越高越好</option>
          </select>
        </div>
        <div class="field" style="flex:0 0 60px;justify-content:flex-end"><label>&nbsp;</label><button data-tdel="${i}" class="danger">刪</button></div>
      </div>
    </div>
  `;
}

function blank() {
  return {
    name: "", type: "app", no_band: false,
    is_poquan: false, parent_product_id: "",
    performance_targets: [],
  };
}

function escape(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
