// 版本 gate:每次 deploy 改 build id 都要走的兩道檢查
//   A. 冷啟動 gate (runColdStartGate):在 state.js load 本機 state 之前同步執行。
//      本機 build id ≠ 目前 build id → 清掉 state / sync_meta / undo / conflicts,
//      讓 sync 從零拉雲端,避免舊版寫進去的 state shape 餵給新版邏輯 → 推爛資料。
//   B. 長 tab 偵測 (initLongTabWatch):每 30 秒 fetch /version.txt,
//      不等於目前 build id → 顯示「點此重整」banner,使用者自己挑時間 reload
//      (不自動 reload 避免吞掉沒推上去的改動)。
//
// dev 模式 (BUILD === "dev") 完全跳過,避免本機 hot reload 一直清 localStorage。

import { BUILD, IS_DEV_BUILD } from "./build-info.js";
import { showUpdateBanner } from "./update-banner.js";
import { logInfo, logWarn } from "./sync-log.js";

const BUILD_KEY = "buyads_build";
const LAST_GATE_MSG_KEY = "buyads_version_gate_msg";

// 要在版本 mismatch 時清掉的 key 清單。新增 localStorage namespace 時記得補進來。
const PURGE_KEYS = [
  "buyads_state_v1",
  "buyads_undo_v1",
  "buyads_sync_meta_v1",
  "buyads_server_version_v1",
  "buyads_conflicts_v1",
];

// 同步,必須在 state.js load 之前呼叫(main.js 的最頂端 import 鏈)。
export function runColdStartGate() {
  if (IS_DEV_BUILD) return { changed: false, reason: "dev" };
  let stored;
  try { stored = localStorage.getItem(BUILD_KEY); } catch { return { changed: false, reason: "no-storage" }; }
  if (stored === BUILD) return { changed: false, reason: "match" };

  if (stored) {
    // 真的有舊版 → 清資料
    for (const k of PURGE_KEYS) { try { localStorage.removeItem(k); } catch {} }
    try {
      sessionStorage.setItem(
        LAST_GATE_MSG_KEY,
        `偵測到新版本 (${stored} → ${BUILD}),本地資料已重置,稍後將從雲端拉取最新資料。`,
      );
    } catch {}
    logWarn("versionGate.coldStartReset", { from: stored, to: BUILD });
  } else {
    // 第一次開,沒舊版可比 — 純粹寫入。
    logInfo("versionGate.coldStartFirstRun", { build: BUILD });
  }
  try { localStorage.setItem(BUILD_KEY, BUILD); } catch {}
  return { changed: !!stored, reason: stored ? "reset" : "first-run" };
}

// app 啟動完才呼叫:把冷啟動的訊息(如有)以 toast 顯示。
export function showColdStartGateToast() {
  let msg;
  try { msg = sessionStorage.getItem(LAST_GATE_MSG_KEY); } catch { return; }
  if (!msg) return;
  try { sessionStorage.removeItem(LAST_GATE_MSG_KEY); } catch {}
  // toast host 由 main.js 註冊;這裡用 lazy 引用避免循環依賴
  const host = document.getElementById("toast-host");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast toast-info";
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

let longTabTimer = null;
let bannerShown = false;

// 每 intervalMs ms fetch 一次 version.txt 看 server 有沒有新 deploy。
export function initLongTabWatch({ intervalMs = 30000 } = {}) {
  if (IS_DEV_BUILD) return;
  if (longTabTimer) return;
  const tick = async () => {
    if (bannerShown) return; // 已經提示就不再 fetch
    try {
      const r = await fetch("./version.txt?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const serverBuild = (await r.text()).trim();
      if (!serverBuild || serverBuild === BUILD) return;
      bannerShown = true;
      logInfo("versionGate.newVersionDetected", { running: BUILD, server: serverBuild });
      showUpdateBanner({
        runningBuild: BUILD,
        serverBuild,
        onReload: () => location.reload(),
      });
    } catch {
      // 網路錯誤就忽略,下一輪再試
    }
  };
  // 啟動後 5 秒先試一次(讓 app 渲染完),之後每 intervalMs
  setTimeout(tick, 5000);
  longTabTimer = setInterval(tick, intervalMs);
}
