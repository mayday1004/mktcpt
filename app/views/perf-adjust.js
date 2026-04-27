import { getState, update, uid } from "../state.js";
import { NO_BAND_PIDS } from "../schema.js";
import { buildAdPivot, previewImpact } from "../domain/perf-adjust.js";
import { buildWeightAdjust, buildEndEarly } from "../domain/lifecycle.js";

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

export function render(root) {
  const s = getState();
  const ym = s.settings.current_month;

  const pivot = buildAdPivot(s, ym);
  if (pivot.length === 0) {
    root.innerHTML = `
      <div class="view-head">
        <div><h1>權重調整</h1></div>
      </div>
      <div class="card"><p class="ink-2">尚無任何廣告。</p></div>
    `;
    return;
  }

  // 計算各 ad 的最終權重（pending > suggested > old）
  const newWeightsByAd = {};
  for (const e of pivot) {
    const final = { ...e.oldWeights };
    for (const pp of e.perProduct) {
      const key = `${e.ad.id}|${pp.product.id}`;
      const overridden = pending.get(key);
      const w = overridden != null ? overridden : pp.new;
      if (w > 0) final[pp.product.id] = w;
      else delete final[pp.product.id];
    }
    newWeightsByAd[e.ad.id] = final;
  }

  const impact = previewImpact(s, ym, newWeightsByAd);

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

  root.innerHTML = `
    <div class="view-head">
      <div>
        <h1>權重調整</h1>
        <div class="desc">以廣告為主：左欄原權重、右欄系統建議；可手動覆寫或鎖定整支廣告不調。<br>建議的雙重 cap：未來日峰值 ≤ band 上緣（破圈跳過）+ 月攤提合計 ≤ 月預算（破圈/小島/APP 一律強制）。月攤提＝過去實際攤提 + 未來權重計算值。</div>
      </div>
    </div>

    ${renderImpactSummary(impact)}

    <div class="card">
      <div class="card-head">
        <h2>廣告調整建議</h2>
        <div class="ink-3">勾選「✓套用」表示同意這筆建議，最後批量送出；🔒 = 鎖定，永久排除自動建議</div>
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
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th title="勾選＝同意套用此建議；最後一起批量送出">套用</th>
                <th title="鎖定後該廣告不會被自動建議影響">🔒</th>
                <th>代碼</th>
                <th>名稱</th>
                <th>原權重</th>
                <th>建議權重（可改）</th>
                <th>說明</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.map((e) => renderAdRow(e, s, newWeightsByAd)).join("")}
            </tbody>
          </table>
        </div>
      `}

      <div class="modal-actions" style="margin-top:16px">
        <button id="btn-reset">重置為系統建議</button>
        <button class="primary" id="btn-apply">套用已勾選的 ${countAgreedChanges(pivot, newWeightsByAd)} 筆 → 開新權重段</button>
      </div>
    </div>
  `;

  bindHandlers(root, pivot, newWeightsByAd);
}

function renderImpactSummary(impacts) {
  const islands = impacts.filter((c) => c.product.type === "island");
  const apps = impacts.filter((c) => c.product.type === "app");
  const visible = collapseApp ? islands : impacts;

  const rows = visible.map((c) => {
    const { product, budget, band, oldTotal, newTotal, oldDailyPeak, newDailyPeak, oldPeakDay, newPeakDay } = c;
    const totalDelta = newTotal - oldTotal;
    const peakDelta = newDailyPeak - oldDailyPeak;
    const isIsland = product.type === "island";
    const checkBand = !NO_BAND_PIDS.has(product.id);
    const totalCls = budget == null ? "ink-3" :
      Math.abs(newTotal - budget) <= 5000 ? "ok" :
      newTotal - budget > 10000 ? "bad" :
      newTotal - budget < -20000 ? "warn" : "warn";

    // 評估：新日花費對照建議日花費區間
    let evalCell;
    if (!checkBand) {
      evalCell = `<span class="ink-3">不檢查（破圈）</span>`;
    } else if (band.upper <= 0 || budget == null) {
      evalCell = `<span class="ink-3">未設預算</span>`;
    } else if (newDailyPeak > band.upper) {
      const over = newDailyPeak - band.upper;
      evalCell = `<span class="bad">✗ 超出上緣 +${Math.round(over).toLocaleString()}</span>
        <div class="ink-3" style="font-size:11px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    } else if (newDailyPeak < band.lower && newDailyPeak > 0) {
      const under = band.lower - newDailyPeak;
      evalCell = `<span class="warn">⚠ 低於下緣 -${Math.round(under).toLocaleString()}</span>
        <div class="ink-3" style="font-size:11px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    } else {
      evalCell = `<span class="ok">✓ 在區間內</span>
        <div class="ink-3" style="font-size:11px">區間 ${Math.round(band.lower).toLocaleString()}~${Math.round(band.upper).toLocaleString()}</div>`;
    }

    return `
      <tr class="${isIsland ? "island-row" : ""}">
        <td>
          <strong>${esc(product.name)}</strong>
          <span class="pill ${product.type}" style="margin-left:6px;font-size:10px">${product.type === "app" ? "APP" : "小島"}</span>
        </td>
        <td class="num">${budget != null ? Math.round(budget).toLocaleString() : "<span class='ink-3'>未設</span>"}</td>
        <td class="num">${Math.round(oldTotal).toLocaleString()}</td>
        <td class="num ${totalCls}"><strong>${Math.round(newTotal).toLocaleString()}</strong>
          <div class="ink-3" style="font-size:11px">${totalDelta >= 0 ? "+" : ""}${Math.round(totalDelta).toLocaleString()}${budget != null ? ` / 預算差 ${Math.round(newTotal - budget) >= 0 ? "+" : ""}${Math.round(newTotal - budget).toLocaleString()}` : ""}</div>
        </td>
        <td class="num">${Math.round(oldDailyPeak).toLocaleString()}
          ${oldPeakDay ? `<div class="ink-3" style="font-size:10px">於 ${oldPeakDay.slice(5)}</div>` : ""}
        </td>
        <td class="num"><strong>${Math.round(newDailyPeak).toLocaleString()}</strong>
          ${peakDelta !== 0 ? `<div class="ink-3" style="font-size:11px">${peakDelta >= 0 ? "+" : ""}${Math.round(peakDelta).toLocaleString()}</div>` : ""}
          ${newPeakDay ? `<div class="ink-3" style="font-size:10px">於 ${newPeakDay.slice(5)}</div>` : ""}
        </td>
        <td>${evalCell}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="card">
      <div class="card-head">
        <h2>套用後預估</h2>
        <div class="ink-3" style="font-size:12px">
          顯示套用建議調整後，每個產品月攤提與日花費的變化
          ${apps.length > 0 ? `<button id="btn-toggle-app" class="link-btn" style="margin-left:8px">${collapseApp ? `展開 APP（${apps.length}）` : "只看小島"}</button>` : ""}
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>產品</th>
              <th class="num">月預算</th>
              <th class="num">原月攤提</th>
              <th class="num">新月攤提</th>
              <th class="num">原日花費</th>
              <th class="num">新日花費</th>
              <th>評估</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

// 計算「會被批量送出」的廣告筆數：使用者勾選同意 + 沒鎖 + 沒過期 + 不是淘汰建議 + 權重真有變動
function countAgreedChanges(pivot, newWeightsByAd) {
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const e of pivot) {
    if (!agreedAdIds.has(e.ad.id)) continue;
    if (e.ad.lock_perf_adjust) continue;
    if (!e.ad.end_date || e.ad.end_date <= today) continue;
    if (e.suggestEliminate) continue;
    if (sameWeights(e.oldWeights || {}, newWeightsByAd[e.ad.id] || {})) continue;
    n++;
  }
  return n;
}

function renderAdRow(entry, state, newWeightsByAd) {
  const { ad, oldWeights, perProduct, suggestEliminate } = entry;
  const productNameOf = Object.fromEntries(state.products.map((p) => [p.id, p.name]));
  const products = state.products.filter((p) => oldWeights[p.id] > 0);
  const locked = !!ad.lock_perf_adjust;
  const lockBtn = `
    <button class="lock-btn ${locked ? "locked" : ""}" data-lock-adid="${esc(ad.id)}"
            title="${locked ? "已鎖定（點擊解鎖）" : "鎖定 — 永久排除自動建議"}">🔒</button>
  `;

  const oldSum = products.reduce((s, p) => s + (Number(oldWeights[p.id]) || 0), 0);
  const oldCells = products.map((p) =>
    `<span class="weight-pill">${esc(p.name)} <strong>${oldWeights[p.id]}%</strong></span>`
  ).join(" ");

  // 建議淘汰 — 整列以「淘汰建議」呈現，不顯示權重輸入
  if (suggestEliminate) {
    const reasons = perProduct.map((pp) => {
      const ratio = pp.score?.ratio;
      const ratioPct = ratio == null ? "—" : `${Math.round(ratio * 100)}%`;
      return `<div class="bad" style="font-size:11px">${esc(productNameOf[pp.product.id] || pp.product.id)}：${ratioPct} 達成 — 削 ${pp.old}%</div>`;
    }).join("");
    return `
      <tr class="row-eliminate">
        <td class="ink-3" style="text-align:center" title="淘汰建議不走批量送出，請點下方「立即提前結束」">—</td>
        <td>${lockBtn}</td>
        <td class="mono">${esc(ad.ad_code)}</td>
        <td><strong>${esc(ad.ad_name)}</strong><div class="ink-3" style="font-size:11px">${ad.start_date} ~ ${ad.end_date}</div></td>
        <td>${oldCells || `<span class="ink-3">—</span>`}</td>
        <td colspan="2">
          <div class="eliminate-banner">
            <strong>❌ 建議淘汰</strong>
            <span class="ink-2" style="font-size:12px">所有產品成效都最差。</span>
            <button class="primary danger eliminate-action" data-end-now="${esc(ad.id)}" ${locked ? "disabled title='已鎖定'" : ""}>立即提前結束</button>
          </div>
          <div style="margin-top:6px">${reasons}</div>
        </td>
      </tr>
    `;
  }

  // 計算新權重合計（用 pending override 蓋過建議）
  let newSum = 0;
  let anyCappedByAdSum = false;
  const newCells = products.map((p) => {
    const key = `${ad.id}|${p.id}`;
    const pp = perProduct.find((x) => x.product.id === p.id);
    const suggestedW = pp ? pp.new : oldWeights[p.id];
    const overridden = pending.get(key);
    const finalW = overridden != null ? overridden : suggestedW;
    newSum += Number(finalW) || 0;
    if (pp?.cappedByAdSum) anyCappedByAdSum = true;
    const delta = finalW - (oldWeights[p.id] || 0);
    const deltaCls = delta > 0 ? "ok" : delta < 0 ? "bad" : "ink-3";
    const locked = !!ad.lock_perf_adjust;
    return `
      <span class="weight-edit">
        ${esc(p.name)}
        <input type="number" min="0" max="100" step="1" class="w-input"
          data-adid="${esc(ad.id)}" data-pid="${esc(p.id)}"
          value="${finalW}" ${locked ? "disabled" : ""} />
        <span class="${deltaCls}" style="font-size:11px;font-family:var(--mono)">${delta > 0 ? "+" : ""}${delta}</span>
      </span>
    `;
  }).join("");

  // 合計 badge：=100 綠、<100 黃（手動覆寫造成）、>100 紅（手動覆寫造成）；
  // 系統自動建議經 per-ad scale 後一定 = 100%，只有使用者手改才會偏離
  const sumCls = newSum === 100 ? "ok" : newSum > 100 ? "bad" : newSum > 0 ? "warn" : "ink-3";
  const sumBadge = `<div class="weight-sum-badge ${sumCls}">合計 <strong>${newSum}%</strong>${
    anyCappedByAdSum ? `<span class="band-cap-badge" style="margin-left:6px" title="系統已等比例縮放使合計=100%">已校準至 100</span>` : ""
  }</div>`;
  const oldSumBadge = oldSum !== 100 ? `<div class="weight-sum-badge ink-3" style="background:transparent;border:1px solid var(--line)">原合計 ${oldSum}%</div>` : "";

  // 各產品建議：「最終 delta% — 成效狀態」統一格式（不再拆解 削／縮回／接收／補滿，避免混亂）
  const reasons = perProduct.map((pp) => {
    const cls = pp.locked ? "ink-3"
      : pp.score?.ratio == null ? "ink-3"
      : pp.score.ratio >= 0.66 ? "ok"
      : pp.score.ratio < 0.33 ? "bad"
      : "ink-2";
    const cap = pp.cappedByBand ? ` <span class="band-cap-badge" title="此產品建議已削至建議日花費上緣">⤓ 削至上緣</span>` : "";
    return `<div class="${cls}" style="font-size:11px">${esc(productNameOf[pp.product.id] || pp.product.id)}：${formatReason(pp)}${cap}</div>`;
  }).join("");

  // 「套用」勾選框：鎖定 / 過期 / 無變動 → 禁用
  const today = new Date().toISOString().slice(0, 10);
  const isPast = !ad.end_date || ad.end_date <= today;
  const noChange = sameWeights(oldWeights || {}, (newWeightsByAd && newWeightsByAd[ad.id]) || {});
  const agreeDisabled = locked || isPast || noChange;
  const agreeChecked = !agreeDisabled && agreedAdIds.has(ad.id);
  const agreeTitle = locked ? "已鎖定，無法套用"
    : isPast ? "已過期，無法套用"
    : noChange ? "無變動"
    : "勾選同意套用此建議";
  const agreeBox = `<input type="checkbox" class="agree-toggle" data-agree-adid="${esc(ad.id)}" ${agreeChecked ? "checked" : ""} ${agreeDisabled ? "disabled" : ""} title="${agreeTitle}" />`;

  return `
    <tr class="${agreeChecked ? "row-agreed" : ""}">
      <td>${agreeBox}</td>
      <td>${lockBtn}</td>
      <td class="mono">${esc(ad.ad_code)}</td>
      <td><strong>${esc(ad.ad_name)}</strong><div class="ink-3" style="font-size:11px">${ad.start_date} ~ ${ad.end_date}</div></td>
      <td>${oldCells || `<span class="ink-3">—</span>`}${oldSumBadge}</td>
      <td>${newCells || `<span class="ink-3">—</span>`}${sumBadge}</td>
      <td>${reasons || `<span class="ink-3" style="font-size:11px">—</span>`}</td>
    </tr>
  `;
}

function bindHandlers(root, pivot, newWeightsByAd) {
  root.querySelectorAll("[data-filter]").forEach((el) => {
    el.onclick = () => { filterMode = el.dataset.filter; render(root); };
  });
  const tg = root.querySelector("#btn-toggle-app");
  if (tg) tg.onclick = () => { collapseApp = !collapseApp; render(root); };

  root.querySelectorAll("input.w-input").forEach((inp) => {
    inp.onchange = () => {
      const v = inp.value === "" ? 0 : Number(inp.value) || 0;
      pending.set(`${inp.dataset.adid}|${inp.dataset.pid}`, v);
      render(root);
    };
  });

  // 🔒 鎖定按鈕
  root.querySelectorAll("button.lock-btn").forEach((btn) => {
    btn.onclick = () => {
      const adId = btn.dataset.lockAdid;
      const willLock = !root.querySelector(`button.lock-btn[data-lock-adid="${adId}"]`).classList.contains("locked");
      update((st) => {
        const a = st.ads.find((x) => x.id === adId);
        if (a) a.lock_perf_adjust = willLock;
      });
      // 鎖定 → 同步取消「同意套用」並清掉手動覆寫
      if (willLock) {
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
    const today = new Date().toISOString().slice(0, 10);
    for (const e of pivot) {
      if (e.ad.lock_perf_adjust) continue;
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

  // 「立即提前結束」— 直接在淘汰 banner 內結束該段，不必跨頁
  root.querySelectorAll("[data-end-now]").forEach((btn) => {
    btn.onclick = () => endAdNow(btn.dataset.endNow, root);
  });
}

async function endAdNow(adId, root) {
  const s = getState();
  const ad = s.ads.find((a) => a.id === adId);
  if (!ad) { toast("找不到該廣告", "bad"); return; }
  const today = new Date().toISOString().slice(0, 10);
  const endDate = today > ad.start_date ? today : ad.start_date;
  // buildEndEarly 要求 endDate < 原 end_date
  if (endDate >= ad.end_date) {
    toast("此段已過期，無需結束", "warn");
    return;
  }
  const ok = await confirmAsync({
    title: "提前結束廣告段",
    body: `將把這支廣告的結束日改為 ${endDate}（今日），不再繼續攤提。已扣台幣不追溯。`,
    details: [
      `${ad.ad_code} ${ad.ad_name}`,
      `原起訖 ${ad.start_date} ~ ${ad.end_date}`,
      `每日攤提 ${Math.round(ad.daily_amort_twd || 0).toLocaleString()} TWD`,
    ],
    okText: "結束", danger: true,
  });
  if (!ok) return;

  let okFlag = false;
  update((st) => {
    const seg = st.ads.find((x) => x.id === adId);
    if (!seg) return;
    try {
      const r = buildEndEarly(seg, endDate);
      const i = st.ads.findIndex((x) => x.id === adId);
      if (i >= 0) st.ads[i] = r.closed;
      st.todos.push({
        id: uid("todo"),
        created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        action_type: "提前結束（成效淘汰）",
        description: `${seg.ad_code} ${seg.ad_name}：因成效全線最差，於 ${endDate} 提前結束`,
        status: "pending",
      });
      okFlag = true;
    } catch (e) {
      console.error(e);
    }
  }, "提前結束廣告");

  if (okFlag) {
    toast("已提前結束，並建立待辦", "ok");
    render(root);
  } else {
    toast("結束失敗", "bad");
  }
}

async function applyAll(pivot, newWeightsByAd, root) {
  const today = new Date().toISOString().slice(0, 10);
  const changes = [];
  const eliminateCount = pivot.filter((e) => e.suggestEliminate && !e.ad.lock_perf_adjust).length;
  for (const e of pivot) {
    if (!agreedAdIds.has(e.ad.id)) continue;  // 必須使用者明確勾選「同意套用」
    if (e.ad.lock_perf_adjust) continue;
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
  update((st) => {
    for (const ch of changes) {
      const seg = st.ads.find((a) => a.id === ch.ad.id);
      if (!seg) { errCount++; continue; }
      const effective = today > seg.start_date && today < seg.end_date ? today : seg.start_date;
      try {
        if (effective <= seg.start_date) {
          seg.weights = { ...ch.newW };
          okCount++;
        } else {
          const r = buildWeightAdjust(seg, effective, { ...ch.newW });
          const i = st.ads.findIndex((a) => a.id === seg.id);
          if (i >= 0) st.ads[i] = r.closed;
          st.ads.push(...r.segments);
          okCount++;
        }
      } catch { errCount++; }
    }
    if (okCount > 0) {
      st.todos.push({
        id: uid("todo"),
        created_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        action_type: "成效驅動權重調整",
        description: `成效調整套用至 ${okCount} 筆廣告${errCount ? `（${errCount} 筆失敗）` : ""}`,
        status: "pending",
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
