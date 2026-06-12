// Runtime config comes from config.js, generated when the container starts.
// If config.js exists, trust it completely so stale values baked into an older
// bundle cannot mask changed Railway variables.
const RUNTIME_CONFIG =
  globalThis.__BUYADS_CONFIG__ && typeof globalThis.__BUYADS_CONFIG__ === "object"
    ? globalThis.__BUYADS_CONFIG__
    : null;

function hasRuntimeKey(key) {
  return !!RUNTIME_CONFIG && Object.prototype.hasOwnProperty.call(RUNTIME_CONFIG, key);
}

function configValue(key, bundledValue = "") {
  const value = hasRuntimeKey(key) ? RUNTIME_CONFIG[key] : bundledValue;
  return String(value || "").trim();
}

export const DEPLOY_SHEETS_URL = configValue(
  "sheetsWebappUrl",
  typeof __BUYADS_SHEETS_URL__ !== "undefined" ? __BUYADS_SHEETS_URL__ : "",
);
export const DEPLOY_SHEETS_TOKEN = configValue(
  "sheetsToken",
  typeof __BUYADS_SHEETS_TOKEN__ !== "undefined" ? __BUYADS_SHEETS_TOKEN__ : "",
);
export const DEPLOY_YOURLS_WAKE_URL = configValue(
  "yourlsWakeUrl",
  typeof __BUYADS_YOURLS_WAKE_URL__ !== "undefined" ? __BUYADS_YOURLS_WAKE_URL__ : "",
);
export const DEPLOY_YOURLS_WAKE_TOKEN = configValue(
  "yourlsWakeToken",
  typeof __BUYADS_YOURLS_WAKE_TOKEN__ !== "undefined" ? __BUYADS_YOURLS_WAKE_TOKEN__ : "",
);

export const DEPLOY_CONFIG_SOURCE = RUNTIME_CONFIG
  ? "runtime config.js"
  : (DEPLOY_SHEETS_URL || DEPLOY_SHEETS_TOKEN || DEPLOY_YOURLS_WAKE_URL || DEPLOY_YOURLS_WAKE_TOKEN)
    ? "bundle fallback"
    : "local settings";

export const isDeployManaged = () => !!(DEPLOY_SHEETS_URL && DEPLOY_SHEETS_TOKEN);
export const isYourlsWakeDeployManaged = () => !!(DEPLOY_YOURLS_WAKE_URL && DEPLOY_YOURLS_WAKE_TOKEN);

export function getEffectiveSheetsUrl(settings) {
  return DEPLOY_SHEETS_URL || settings?.sheets_webapp_url || "";
}
export function getEffectiveSheetsToken(settings) {
  return DEPLOY_SHEETS_TOKEN || settings?.sheets_token || "";
}
export function getEffectiveYourlsWakeUrl(settings) {
  return DEPLOY_YOURLS_WAKE_URL || settings?.yourls_wake_url || "";
}
export function getEffectiveYourlsWakeToken(settings) {
  return DEPLOY_YOURLS_WAKE_TOKEN || settings?.yourls_wake_token || "";
}

export function describeSheetsUrlProblem(url) {
  const value = String(url || "").trim();
  if (!value) return "";

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "Apps Script Web App URL 格式不正確。請貼上 Apps Script 部署產生、結尾是 /exec 的網址。";
  }

  if (parsed.protocol !== "https:") {
    return "Apps Script Web App URL 必須是 https:// 開頭。請重新複製部署產生的 /exec 網址。";
  }
  if (parsed.hostname !== "script.google.com" || !parsed.pathname.startsWith("/macros/s/")) {
    return "Web App URL 看起來不是 Apps Script 網頁應用程式網址。請不要貼試算表網址或 Apps Script 編輯器網址，請貼部署後結尾是 /exec 的網址。";
  }
  if (!parsed.pathname.endsWith("/exec")) {
    return "Web App URL 必須是 Apps Script 網頁應用程式 URL，網址結尾要是 /exec。請到「部署 > 管理部署」複製目前的 Web App URL。";
  }
  return "";
}

export function assertValidSheetsUrl(url) {
  const problem = describeSheetsUrlProblem(url);
  if (problem) throw new Error(problem);
}

export function describeYourlsWakeUrlProblem(url, pageProtocol = globalThis.location?.protocol || "") {
  const value = String(url || "").trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//")) return "";

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "yourls帕魯 Wake URL 格式不正確。請填完整網址,或同站路徑 /api/yourls-wake/notify。";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "yourls帕魯 Wake URL 只支援 http:// 或 https://。";
  }
  if (pageProtocol === "https:" && parsed.protocol === "http:") {
    return "目前 buyads 是 HTTPS 頁面,瀏覽器會阻擋呼叫 HTTP wake URL。Railway 正式站請使用同站路徑 /api/yourls-wake/notify,並讓 Mac B 用 WAKE_RELAY_URL 等 Railway 通知。";
  }
  return "";
}
