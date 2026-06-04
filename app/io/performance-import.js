import { getState, update } from "../state.js";
import { METRICS } from "../schema.js";
import { PERF_INPUT_SHEET, PERF_INPUT_HEADERS, PERF_INPUT_METRICS, normalizeAdCode, toYmd } from "./sheets-schema.js";
import { getEffectiveSheetsUrl, getEffectiveSheetsToken } from "../lib/deploy-config.js";
import { formatAppsScriptNonJsonError } from "./apps-script-errors.js";

async function call(payload) {
  const s = getState();
  const url = getEffectiveSheetsUrl(s.settings);
  const token = getEffectiveSheetsToken(s.settings);
  if (!url) throw new Error("尚未設定 Apps Script Web App URL");
  if (!token) throw new Error("尚未設定 Token");

  const fd = new FormData();
  fd.append("payload", JSON.stringify({ ...payload, token }));
  const res = await fetch(url, { method: "POST", body: fd, redirect: "follow" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(formatAppsScriptNonJsonError(text, res.status)); }
  if (json.error) throw new Error(json.error);
  return json;
}

export async function ensurePerfInputSheet() {
  const r = await call({ action: "readTable", sheetName: PERF_INPUT_SHEET });
  const hasHeaders = r.headers && r.headers.length && r.headers[0] === PERF_INPUT_HEADERS[0];
  if (!hasHeaders) {
    await call({ action: "writeTable", sheetName: PERF_INPUT_SHEET, headers: PERF_INPUT_HEADERS, rows: [] });
    return { created: true };
  }
  return { created: false, rowCount: r.rows.length };
}

export async function fetchPerfInput() {
  const r = await call({ action: "readTable", sheetName: PERF_INPUT_SHEET });
  return { headers: r.headers || [], rows: r.rows || [] };
}

export async function clearPerfInput() {
  await call({ action: "writeTable", sheetName: PERF_INPUT_SHEET, headers: PERF_INPUT_HEADERS, rows: [] });
}

export async function pushPerfDataSheet() {
  const { TABLES } = await import("./sheets-schema.js");
  const perfTable = TABLES.find((t) => t.name === "成效資料");
  const s = getState();
  return await call({
    action: "writeTable",
    sheetName: perfTable.name,
    headers: perfTable.headers,
    rows: perfTable.toRows(s),
  });
}

// YYYY-MM-DD 字串 +1 天(避開 timezone:用 UTC 解析 + 加日)
function addOneDayYmd(ymd) {
  if (!ymd) return ymd;
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// 計算一筆廣告 (含多段) 在 perf 期間內貢獻給某產品的花費（台幣）。
//
// 兩種期間在 inclusivity 上不同:
//   - 廣告本身:start inclusive、end exclusive(§2.1「結束日當天不算錢」)
//   - perf 資料:start / end 兩端都 inclusive — 使用者貼週資料時把 5/3~5/9 視為 7 天的一週,
//     5/10~5/16 又是下一週,中間不可能少一天。所以 end 必須當 inclusive。
//
// 內部把 perf end 換算成 exclusive(+1 day)後再跟廣告期間取交集,天數用 (e - s) / day_ms 算。
function computeSpend(ad, productId, start, end) {
  const w = Number(ad.weights?.[productId]) || 0;
  if (w <= 0) return 0;
  const periodEndExclusive = addOneDayYmd(end);
  const s = ad.start_date > start ? ad.start_date : start;
  const e = ad.end_date < periodEndExclusive ? ad.end_date : periodEndExclusive;
  if (s >= e) return 0;
  const days = (Date.parse(e) - Date.parse(s)) / 86400000;
  if (!Number.isFinite(days) || days <= 0) return 0;
  return (Number(ad.daily_amort_twd) || 0) * (w / 100) * days;
}

// 解析成效輸入列。每列：(資料起始日, 資料結束日, 廣告代碼, 對應產品, 廣告分組, ...13 指標)。
// 匹配規則：把輸入代碼正規化（去 dh 前綴 + 去英文字尾）後與 state.ads 的代碼正規化結果比對；
// 同基本碼下挑「對應產品有權重 + 期間 [start, end) 重疊最大者」勝。
// 重複多筆同重疊段 → conflicts，讓 modal 讓使用者選。
export function parsePerfInputRows(headers, rows) {
  const state = getState();
  const productSet = new Set(state.products.map((p) => p.id));
  const productByName = Object.fromEntries(state.products.map((p) => [p.name, p.id]));

  const idx = Object.fromEntries(PERF_INPUT_HEADERS.map((h) => [h, headers.indexOf(h)]));
  const missingCols = ["資料起始日", "資料結束日", "廣告代碼", "對應產品", "廣告分組"]
    .filter((h) => idx[h] < 0);
  if (missingCols.length) {
    throw new Error(`成效輸入分頁缺欄位：${missingCols.join("、")}（請先按「初始化」建表頭）`);
  }

  const valid = [];
  const errors = [];
  const conflicts = [];

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const get = (h) => (idx[h] >= 0 ? r[idx[h]] : "");
    // 用 toYmd 處理 Apps Script cell value（可能是純日期、ISO 字串、或 Date），
    // 一律以台北時區還原 — 直接 slice(0,10) 拿 UTC 部分會少 1 天。
    const periodStart = toYmd(get("資料起始日"));
    const periodEnd = toYmd(get("資料結束日"));
    const adCodeRaw = String(get("廣告代碼") || "").trim();
    let productKey = String(get("對應產品") || "").trim();
    const groupIn = String(get("廣告分組") || "").trim();

    if (!adCodeRaw) { errors.push({ row: rowNum, msg: "廣告代碼空白" }); return; }
    if (!periodStart || !periodEnd) { errors.push({ row: rowNum, msg: `期間缺漏 (${adCodeRaw})` }); return; }
    if (!(periodStart < periodEnd)) { errors.push({ row: rowNum, msg: `期間起迄顛倒：${periodStart} → ${periodEnd} (${adCodeRaw})` }); return; }

    if (!productSet.has(productKey)) {
      if (productByName[productKey]) productKey = productByName[productKey];
      else { errors.push({ row: rowNum, msg: `對應產品「${productKey}」不存在 (${adCodeRaw})` }); return; }
    }

    const inputBase = normalizeAdCode(adCodeRaw);
    if (!inputBase) {
      errors.push({ row: rowNum, msg: `代碼「${adCodeRaw}」正規化後為空` });
      return;
    }

    // fuzzy match：基本碼相同、對應產品有權重、期間重疊
    const candidates = state.ads.filter(
      (a) => normalizeAdCode(a.ad_code) === inputBase
        && Number(a.weights?.[productKey]) > 0
        && a.start_date < periodEnd
        && a.end_date > periodStart
    );
    if (candidates.length === 0) {
      // 多診斷一點：是否有同基本碼但無此產品權重、或無期間重疊？
      const sameBase = state.ads.filter((a) => normalizeAdCode(a.ad_code) === inputBase);
      let detail = "";
      if (sameBase.length === 0) detail = "（系統內找不到同基本碼的廣告）";
      else detail = `（同基本碼找到 ${sameBase.length} 筆，但無對應產品「${productKey}」權重或期間不重疊）`;
      errors.push({ row: rowNum, msg: `代碼「${adCodeRaw}」→ 基本碼「${inputBase}」在期間 ${periodStart}~${periodEnd} 內找不到匹配段 ${detail}` });
      return;
    }

    // 同 ad_code 視為同一支廣告的不同段(初始 / 續費 / 權重調整 …),按 ad_code 分組;
    // 同 code 的多段在時間上是接續的,不算「競爭」候選,花費要橫跨所有段加總。
    // 只有真正不同 ad_code(例 fuzzy match 撈到 st215 vs dh999st215X)的組重疊打平時,才需要使用者挑。
    const byCode = new Map();
    candidates.forEach((a) => {
      if (!byCode.has(a.ad_code)) byCode.set(a.ad_code, []);
      byCode.get(a.ad_code).push(a);
    });

    const groupStats = [...byCode.entries()].map(([code, segs]) => {
      const overlap = segs.reduce((sum, a) => {
        const os = a.start_date > periodStart ? a.start_date : periodStart;
        const oe = a.end_date < periodEnd ? a.end_date : periodEnd;
        const d = (Date.parse(oe) - Date.parse(os)) / 86400000;
        return sum + (Number.isFinite(d) && d > 0 ? d : 0);
      }, 0);
      // 代表段:end_date 最大者(最新);相同則 start_date 最晚
      const representative = segs.slice().sort((a, b) => {
        if (a.end_date !== b.end_date) return b.end_date.localeCompare(a.end_date);
        return b.start_date.localeCompare(a.start_date);
      })[0];
      return { code, segs, overlap, representative };
    }).sort((a, b) => b.overlap - a.overlap);

    const topOverlap = groupStats[0].overlap;
    const tiedGroups = groupStats.filter((g) => Math.abs(g.overlap - topOverlap) < 0.001);

    if (tiedGroups.length > 1) {
      // 真衝突:多個不同 ad_code 並列重疊第一
      conflicts.push({
        rowNum,
        adCodeRaw,
        adName: tiedGroups[0].representative.ad_name,
        productKey,
        periodStart,
        periodEnd,
        candidates: tiedGroups.map((g) => g.representative),
        // 解析衝突時用的 group → segs 對照(以代表段 id 為 key,resolve 時累加組內所有段花費)
        candidateGroups: tiedGroups.map((g) => ({ repId: g.representative.id, segs: g.segs })),
        groupIn,
        metrics: Object.fromEntries(PERF_INPUT_METRICS.map((m) => [m, Number(get(m)) || 0])),
      });
      return;
    }

    // 自動選定:勝出組(同 ad_code 的所有段)花費加總、用最新段當代表
    const winning = groupStats[0];
    const ad = winning.representative;
    const spend = winning.segs.reduce(
      (sum, a) => sum + computeSpend(a, productKey, periodStart, periodEnd),
      0
    );
    const rec = {
      ad_id: ad.id,
      ad_code: ad.ad_code,           // 統一用 state 的標準代碼，不存外部變體
      ad_name: ad.ad_name,
      product_id: productKey,
      group: groupIn || ad.group || "",
      period_start: periodStart,
      period_end: periodEnd,
      "花費": Math.round(spend),
    };
    PERF_INPUT_METRICS.forEach((m) => { rec[m] = Number(get(m)) || 0; });
    valid.push({ rowNum, rec, adCodeRaw, adName: ad.ad_name, productKey });
  });

  return { valid, errors, conflicts };
}

// 把使用者在 modal 解決的衝突（conflict → chosen ad_id）併入 valid
export function resolveConflicts(conflicts, chosenByRowNum) {
  const out = [];
  for (const c of conflicts) {
    const chosenId = chosenByRowNum[c.rowNum];
    if (!chosenId) continue;
    const ad = c.candidates.find((a) => a.id === chosenId);
    if (!ad) continue;
    // 若 conflict 帶有 candidateGroups(同 ad_code 的多段已合組),花費要累加組內所有段
    const grp = c.candidateGroups?.find((g) => g.repId === chosenId);
    const segs = grp?.segs || [ad];
    const spend = segs.reduce(
      (sum, a) => sum + computeSpend(a, c.productKey, c.periodStart, c.periodEnd),
      0
    );
    const rec = {
      ad_id: ad.id,
      ad_code: ad.ad_code,
      ad_name: ad.ad_name,
      product_id: c.productKey,
      group: c.groupIn || ad.group || "",
      period_start: c.periodStart,
      period_end: c.periodEnd,
      "花費": Math.round(spend),
      ...c.metrics,
    };
    out.push({ rowNum: c.rowNum, rec, adCodeRaw: c.adCodeRaw, adName: ad.ad_name, productKey: c.productKey });
  }
  return out;
}

// 依 (廣告代碼, 對應產品, 期間起, 期間迄) 自動覆寫 — 同 key 只保留最新一筆（本次匯入為準）。
// 期間是 key 的一部分:不同週的資料會並存(「依廣告瀏覽」需要連續兩週才能算成本漲幅)。
// 選項：
//   replaceAll: true  — 清空 performance_data 後再匯入本批（避免歷史週期殘留)
//   clearOlderThan: "YYYY-MM-DD" — 在 merge 前刪除 period_end < 此日 的舊紀錄
export function mergeIntoState(validRecs, options = {}) {
  const { replaceAll = false, clearOlderThan = null } = options;
  const key = (r) => `${r.ad_code || r.ad_id}|${r.product_id}|${r.period_start || ""}|${r.period_end || ""}`;
  let kept = 0, replaced = 0, dropped = 0;
  update((st) => {
    let existing = st.performance_data || [];
    if (replaceAll) {
      dropped = existing.length;
      existing = [];
    } else if (clearOlderThan) {
      const filtered = existing.filter((r) => !r.period_end || r.period_end >= clearOlderThan);
      dropped = existing.length - filtered.length;
      existing = filtered;
    }
    const map = new Map(existing.map((r) => [key(r), r]));
    for (const { rec } of validRecs) {
      if (map.has(key(rec))) replaced++; else kept++;
      map.set(key(rec), rec);
    }
    st.performance_data = [...map.values()];
  }, "匯入成效資料");
  return { added: kept, overwritten: replaced, dropped };
}
