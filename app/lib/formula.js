import { METRICS } from "../schema.js";

// 報表自訂公式可額外使用的非 metric 變數（每月匯率等）
export const REPORT_EXTRA_VARS = ["收入匯率", "支出匯率"];

// 建公式可用變數對應表（vars 裡的每個 key 都會被替換成數值）
// vars 至少要含 METRICS（成效資料列），可額外加 REPORT_EXTRA_VARS 給報表自訂公式用
export function evalFormula(formula, vars) {
  if (!formula) return null;
  let expr = formula;
  // 取所有可替換變數名（METRICS + vars 額外提供的 key），按長度倒序避免子字串先被替換
  const allKeys = Array.from(new Set([...METRICS, ...Object.keys(vars || {})]));
  const sorted = allKeys.sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const val = vars[name];
    if (val === undefined || val === null || val === "") {
      expr = expr.replaceAll(name, "0");
    } else {
      expr = expr.replaceAll(name, `(${Number(val)})`);
    }
  }
  if (!/^[\d\s()+\-*/.]+$/.test(expr)) {
    throw new Error(`公式含不允許的字元: ${expr}`);
  }
  try {
    const fn = new Function(`"use strict"; return (${expr});`);
    const result = fn();
    if (!Number.isFinite(result)) return null;
    return result;
  } catch (e) {
    throw new Error(`公式計算失敗: ${e.message}`);
  }
}

// 驗證公式：用 METRICS + REPORT_EXTRA_VARS 都=1 試跑一次，能跑出有限值就過關
export function validateFormula(formula, extraVars = []) {
  try {
    const sample = Object.fromEntries(
      [...METRICS, ...REPORT_EXTRA_VARS, ...extraVars].map((m) => [m, 1])
    );
    evalFormula(formula, sample);
    return null;
  } catch (e) {
    return e.message;
  }
}
