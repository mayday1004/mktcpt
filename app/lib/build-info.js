// build-time 注入的 build id(build.js 用 esbuild `define`)。dev 模式直接打開 main.js
// 沒走 bundle 時 typeof 為 "undefined",fallback "dev" 代表「本機開發,不檢查版本」。
export const BUILD =
  (typeof __BUYADS_BUILD__ !== "undefined" ? __BUYADS_BUILD__ : "") || "dev";
export const IS_DEV_BUILD = BUILD === "dev";
