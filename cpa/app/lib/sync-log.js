// 同步層結構化 logger。所有訊息走 console,前綴統一便於 grep / DevTools 過濾。
//
// 設計準則:
//   - 每筆 log 帶 timestamp(HH:MM:SS.mmm)+ level + event + structured data
//   - level: info(常規動作)/ warn(可恢復異常,如衝突)/ error(寫入失敗、解析失敗)
//   - data 物件直接給 console.log/.warn/.error,DevTools 可展開檢視
//   - 留紀錄環(in-memory ring buffer)讓使用者能在「設定」頁查看最近 N 筆,
//     當有人反映「我明明儲存了卻又被改回去」時,就有實證可看
//
// 用法:
//   import { logInfo, logWarn, logError, getRecentLogs } from "./lib/sync-log.js";
//   logInfo("push.success", { sheet: "廣告", count: 3 });
//   logWarn("push.conflict", { sheet: "廣告", id: "ad_xxx", expected: 4, actual: 7 });
//   logError("network.fail", { action: "upsertRows", error: e.message });

const PREFIX = "[cpa-sync]";
const MAX_RING = 200;

const ringBuffer = [];

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function pushRing(entry) {
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_RING) ringBuffer.shift();
}

function log(level, event, data) {
  const ts = new Date();
  const tsStr = formatTime(ts);
  const entry = { ts: ts.toISOString(), level, event, data: data || null };
  pushRing(entry);

  const tag = `${PREFIX} [${level.toUpperCase()}] ${tsStr} ${event}`;
  if (level === "error") {
    if (data) console.error(tag, data);
    else console.error(tag);
  } else if (level === "warn") {
    if (data) console.warn(tag, data);
    else console.warn(tag);
  } else {
    if (data) console.log(tag, data);
    else console.log(tag);
  }
}

export function logInfo(event, data) { log("info", event, data); }
export function logWarn(event, data) { log("warn", event, data); }
export function logError(event, data) { log("error", event, data); }

// 取最近 N 筆紀錄(預設整段 ring buffer)。給設定頁的「同步日誌」面板用,
// 也方便當有人回報問題時打 window.__cpaLog() 直接看。
export function getRecentLogs(n) {
  if (typeof n !== "number" || n <= 0) return ringBuffer.slice();
  return ringBuffer.slice(-n);
}

// 暴露到 window,方便團隊成員 F12 開 console 後直接看
if (typeof window !== "undefined") {
  window.__cpaLog = (n) => {
    const logs = getRecentLogs(n);
    console.table(logs.map((l) => ({
      time: l.ts.slice(11, 23),
      level: l.level,
      event: l.event,
      data: l.data ? JSON.stringify(l.data) : "",
    })));
    return logs;
  };
}
