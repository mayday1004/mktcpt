export function formatAppsScriptNonJsonError(text, status) {
  const raw = String(text || "");
  const preview = raw.slice(0, 200).replace(/\s+/g, " ").trim();
  const statusText = status ? `HTTP ${status}` : "HTTP unknown";
  const looksHtml = /^\s*<!doctype html/i.test(raw) || /^\s*<html[\s>]/i.test(raw);

  if (looksHtml) {
    return `Apps Script 回了 HTML 頁面(${statusText}),不是同步資料 JSON。通常是 Google/Apps Script 暫時錯誤、尚未授權、部署權限不是「任何人」,或 Web App URL 不是 /exec；同步會自動重試。前 200 字:${preview}`;
  }

  return `Apps Script 回應不是 JSON(${statusText})；同步會自動重試。前 200 字:${preview}`;
}
