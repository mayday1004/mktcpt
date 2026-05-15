#!/usr/bin/env node
// 開發期工具:把 CPT 共用同步層(sync engine / conflict store / conflict resolver /
// sync log / sync banner / deploy config / dates / Apps Script Code.gs)同步到 cpa/。
//
// 用法:CPT 改了 app/io/sync.js 或其他共用檔之後跑這個腳本,確保 cpa/ 那邊不會飄移。
//   node scripts/sync-shared.cjs
//
// 哪些檔是「結構性骨架共用、namespace 不同」:
//   - app/io/sync.js                → cpa/app/io/sync.js     (改 META_KEY / VERSION_KEY)
//   - app/io/conflict-store.js      → cpa/app/io/conflict-store.js (改 STORAGE_KEY)
//   - app/io/conflict-resolver.js   → cpa/app/io/conflict-resolver.js (無 namespace)
//   - app/lib/sync-log.js           → cpa/app/lib/sync-log.js (改 PREFIX + window.__cpaLog)
//   - app/lib/sync-banner.js        → cpa/app/lib/sync-banner.js (無 namespace)
//   - app/lib/deploy-config.js      → cpa/app/lib/deploy-config.js (改 __BUYADS_* → __CPA_*)
//   - app/lib/dates.js              → cpa/app/lib/dates.js (無 namespace)
//   - apps-script/Code.gs           → cpa/apps-script/Code.gs (無差異,使用者各自改 SECRET)

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");

// [src, dest, transform?] — transform 是套用 namespace 的 string replacer
const SYNC_PAIRS = [
  ["app/io/sync.js",              "cpa/app/io/sync.js", (s) => s
    .replace(/"buyads_sync_meta_v1"/g,    `"cpa_sync_meta_v1"`)
    .replace(/"buyads_server_version_v1"/g, `"cpa_server_version_v1"`),
  ],
  ["app/io/conflict-store.js",    "cpa/app/io/conflict-store.js", (s) => s
    .replace(/"buyads_conflicts_v1"/g, `"cpa_conflicts_v1"`),
  ],
  ["app/io/conflict-resolver.js", "cpa/app/io/conflict-resolver.js"],
  ["app/lib/sync-log.js",         "cpa/app/lib/sync-log.js", (s) => s
    .replace(/"\[buyads-sync\]"/g, `"[cpa-sync]"`)
    .replace(/window\.__buyadsLog/g, `window.__cpaLog`)
    .replace(/window\.__cpaLog\(\)/g, `window.__cpaLog()`),  // 註解裡的範例調用
  ],
  ["app/lib/sync-banner.js",      "cpa/app/lib/sync-banner.js"],
  ["app/lib/deploy-config.js",    "cpa/app/lib/deploy-config.js", (s) => s
    .replace(/__BUYADS_CONFIG__/g,      `__CPA_CONFIG__`)
    .replace(/__BUYADS_SHEETS_URL__/g,  `__CPA_SHEETS_URL__`)
    .replace(/__BUYADS_SHEETS_TOKEN__/g, `__CPA_SHEETS_TOKEN__`),
  ],
  ["app/lib/dates.js",            "cpa/app/lib/dates.js"],
  // update-banner.js:UI 元件,無 namespace 差異
  ["app/lib/update-banner.js",    "cpa/app/lib/update-banner.js"],
  // 注意:version-gate.js 跟 build-info.js 不在這裡同步:
  //   - build-info.js:CPT 由 esbuild `define` 在 bundle 時注入;CPA 由 build-version.cjs 產生。
  //   - version-gate.js:CPT 走 `buyads_*` namespace、CPA 走 `cpa_*` namespace,
  //     兩邊各自維護;若改邏輯記得兩邊一起改。
  ["apps-script/Code.gs",         "cpa/apps-script/Code.gs"],
];

let changed = 0;
let identical = 0;

for (const [src, dest, transform] of SYNC_PAIRS) {
  const srcPath = path.join(repoRoot, src);
  const destPath = path.join(repoRoot, dest);
  if (!fs.existsSync(srcPath)) {
    console.warn(`⚠️  跳過(來源不存在):${src}`);
    continue;
  }
  let content = fs.readFileSync(srcPath, "utf8");
  if (transform) content = transform(content);
  const existing = fs.existsSync(destPath) ? fs.readFileSync(destPath, "utf8") : "";
  if (existing === content) {
    identical++;
    continue;
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, content, "utf8");
  console.log(`✓ ${src} → ${dest}`);
  changed++;
}

console.log("");
console.log(`完成:${changed} 個檔同步,${identical} 個檔無變動`);
if (changed === 0) console.log("(全部已是最新)");
