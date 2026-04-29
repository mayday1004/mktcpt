// Build-time injected via esbuild `define` (build.js 讀 Railway env vars
// SHEETS_WEBAPP_URL / SHEETS_TOKEN)。dev 模式（瀏覽器直接載 main.js 不經 bundle）
// 兩個常數都未宣告，typeof 會回 "undefined"，安全 fallback 為空字串。
export const DEPLOY_SHEETS_URL =
  typeof __BUYADS_SHEETS_URL__ !== "undefined" ? __BUYADS_SHEETS_URL__ : "";
export const DEPLOY_SHEETS_TOKEN =
  typeof __BUYADS_SHEETS_TOKEN__ !== "undefined" ? __BUYADS_SHEETS_TOKEN__ : "";

export const isDeployManaged = () => !!(DEPLOY_SHEETS_URL && DEPLOY_SHEETS_TOKEN);

export function getEffectiveSheetsUrl(settings) {
  return DEPLOY_SHEETS_URL || settings?.sheets_webapp_url || "";
}
export function getEffectiveSheetsToken(settings) {
  return DEPLOY_SHEETS_TOKEN || settings?.sheets_token || "";
}
