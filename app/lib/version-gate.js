// 版本 gate:每次 deploy 改 build id 時只做長 tab 偵測。
//   initLongTabWatch:每 30 秒 fetch /version.txt,
//      不等於目前 build id → 顯示「點此重整」banner,使用者自己挑時間 reload
//      (不自動 reload 避免吞掉沒推上去的改動)。

import { BUILD, IS_DEV_BUILD } from "./build-info.js";
import { showUpdateBanner } from "./update-banner.js";
import { logInfo } from "./sync-log.js";

export function runColdStartGate() {
  return { changed: false, reason: "memory-only" };
}

// app 啟動完才呼叫:把冷啟動的訊息(如有)以 toast 顯示。
export function showColdStartGateToast() {
  // No-op: state/sync metadata no longer persist in browser storage.
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
