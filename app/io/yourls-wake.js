import { getState } from "../state.js";
import {
  describeYourlsWakeUrlProblem,
  getEffectiveYourlsWakeToken,
  getEffectiveYourlsWakeUrl,
} from "../lib/deploy-config.js";
import { logError, logInfo, logWarn } from "../lib/sync-log.js";

function normalizeWakeUrl(rawUrl, token) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  const url = new URL(value);
  if (!url.pathname || url.pathname === "/") url.pathname = "/wake";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export function getYourlsWakeConfig(settings = getState().settings) {
  const wakeUrl = getEffectiveYourlsWakeUrl(settings).trim();
  const wakeToken = getEffectiveYourlsWakeToken(settings).trim();
  return { wakeUrl, wakeToken };
}

export function hasYourlsWakeConfig(settings = getState().settings) {
  const { wakeUrl, wakeToken } = getYourlsWakeConfig(settings);
  return !!(wakeUrl && wakeToken);
}

export async function wakeYourlsWorker() {
  const { wakeUrl, wakeToken } = getYourlsWakeConfig();
  if (!wakeUrl && !wakeToken) {
    logWarn("yourlsWake.skipped", { reason: "not_configured" });
    return { ok: true, skipped: true, reason: "not_configured" };
  }
  if (!wakeUrl) throw new Error("尚未設定 yourls帕魯 wake URL");
  if (!wakeToken) throw new Error("尚未設定 yourls帕魯 wake token");

  const configProblem = describeYourlsWakeUrlProblem(wakeUrl);
  if (configProblem) {
    logWarn("yourlsWake.configBlocked", { url: wakeUrl, reason: configProblem });
    throw new Error(configProblem);
  }

  const url = normalizeWakeUrl(wakeUrl, wakeToken);
  let res;
  try {
    res = await fetch(url, { method: "POST", mode: "cors" });
  } catch (e) {
    logError("yourlsWake.fetchFailed", { url: wakeUrl, error: String(e?.message || e) });
    throw new Error(`無法喚醒 yourls帕魯：${e?.message || e}。若 buyads 在 HTTPS 網域,請確認 YOURLS_WAKE_URL 也是 HTTPS 且瀏覽器可連到 Mac B。`);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw preview below */ }

  if (!res.ok || json?.ok === false) {
    const message = json?.error || text.slice(0, 160) || `HTTP ${res.status}`;
    logError("yourlsWake.failed", { status: res.status, error: message });
    throw new Error(`yourls帕魯喚醒失敗：${message}`);
  }

  logInfo("yourlsWake.accepted", { status: res.status, response: json || text.slice(0, 160) });
  return { ok: true, skipped: false, response: json };
}
