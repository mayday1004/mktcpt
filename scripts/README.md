# 一次性轉換腳本

> 這裡放「需要對既有 JSON 資料做一次性修正/升級」的小工具。日常操作不會用到,放這裡備查。

## fix_state.cjs

通用升級腳本。**新版本上線後第一次匯入舊 JSON 時跑這個**,會做兩件事:

1. **產品補欄位** — `is_poquan` / `parent_product_id`(av9_poquan → AV9、jk_poquan → JK)
2. **廣告配對** — 用代碼結尾 `t`(`st287` ↔ `st287t`)自動寫上 `split_pair_id` + `split_role`
3. **金額回流** — 對 t-variant 已結束(parent 後續段沒有對應 t-variant)的歷史段,把 t-variant 金額自動加回 parent

用法:
```bash
node scripts/fix_state.cjs <輸入 JSON> <輸出 JSON>
# 例:
node scripts/fix_state.cjs ./buyads_old.json ./buyads_fixed.json
```

## fix_st287_st289.cjs

針對特定 st287 / st289 兩組廣告,依**人工提供的權重表**重新校正每段的 RMB 拆分與權重。這是專案歷史上的**一次性修正**(2026-05),不是通用工具。

如果你之後遇到類似情境(發現某支廣告的歷史段拆分錯了,想用同樣的「總額 → 一般% / 破圈% → carve-out」方式重算),可以複製這份來改。

用法跟上面一樣:
```bash
node scripts/fix_st287_st289.cjs <輸入 JSON> <輸出 JSON>
```

---

## 為什麼這些腳本不放 samples/

`samples/` 是 git 忽略的歷史資料工作區(.xlsx 解析 / 一次性匯入腳本 / 中間檔案)。
`scripts/` 是會 commit 進 repo 的轉換工具,供未來參考。
