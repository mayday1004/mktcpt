export function formatAppsScriptNonJsonError(text, status) {
  const raw = String(text || "");
  const preview = raw.slice(0, 120).replace(/\s+/g, " ").trim();
  const statusText = status ? `HTTP ${status}` : "HTTP unknown";
  const looksHtml = /^\s*<!doctype html/i.test(raw) || /^\s*<html[\s>]/i.test(raw);

  if (looksHtml) {
    if (status === 404) {
      return "Apps Script/Google 回了 HTTP 404 HTML，不是同步資料 JSON。若 URL 沒改，通常是 Google/Apps Script 暫時異常或部署服務短暫失效。自動同步會以退避重試，恢復後會自動接上；若持續 404，請確認 /exec 部署 URL 仍有效。";
    }
    if (status === 401 || status === 403) {
      return "Apps Script Web App 權限被拒。請確認部署權限是「任何人」、執行身分是「我」，並完成授權。";
    }
    return `Apps Script 回了 HTML 頁面(${statusText})，不是同步資料 JSON。請確認 Web App URL 是目前部署的 /exec，且 Apps Script 已授權。前 120 字：${preview}`;
  }

  return `Apps Script 回應不是 JSON(${statusText})。前 120 字：${preview}`;
}

export function formatAppsScriptJsonError(error) {
  const msg = String(error || "");
  if (msg === "invalid token") {
    return "Apps Script Token 不一致。請確認設定頁 Token 跟 Code.gs 裡的 SECRET 相同。";
  }
  return msg;
}

export function isAppsScriptConfigErrorMessage(message) {
  const msg = String(message || "");
  // 注意:HTTP 404 HTML 不算「設定錯誤」。它通常是 Google/Apps Script 暫時異常,
  // 應該走一般退避重試(恢復後自動接上),而不是永久暫停自動同步。
  return msg.includes("Web App URL")
    || msg.includes("不是 Apps Script 網頁應用程式網址")
    || msg.includes("網址結尾要是 /exec")
    || msg.includes("Token 不一致")
    || msg === "invalid token"
    || msg.includes("權限被拒");
}
