// Build-time injected via esbuild `define` (build.js 讀 Railway env vars
// SHEETS_WEBAPP_URL / SHEETS_TOKEN)。dev 模式（瀏覽器直接載 main.js 不經 bundle）
// 兩個常數都未宣告，typeof 會回 "undefined"，安全 fallback 為空字串。
export const DEPLOY_SHEETS_URL =
  globalThis.__BUYADS_CONFIG__?.sheetsWebappUrl ||
  (typeof __BUYADS_SHEETS_URL__ !== "undefined" ? __BUYADS_SHEETS_URL__ : "");
export const DEPLOY_SHEETS_TOKEN =
  globalThis.__BUYADS_CONFIG__?.sheetsToken ||
  (typeof __BUYADS_SHEETS_TOKEN__ !== "undefined" ? __BUYADS_SHEETS_TOKEN__ : "");

export const isDeployManaged = () => !!(DEPLOY_SHEETS_URL && DEPLOY_SHEETS_TOKEN);

export function getEffectiveSheetsUrl(settings) {
  return DEPLOY_SHEETS_URL || settings?.sheets_webapp_url || "";
}
export function getEffectiveSheetsToken(settings) {
  return DEPLOY_SHEETS_TOKEN || settings?.sheets_token || "";
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
