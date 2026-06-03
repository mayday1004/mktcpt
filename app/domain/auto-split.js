// 自動拆 t / 配對偵測(2026-05 重訂規則,CLAUDE.md §5.3.5 / §5.7.2)
//
// 觸發條件:同支廣告 weights 同時含「某家族母 + 破圈」(AV9 + av9_poquan 或 JK + jk_poquan)
// 觸發時:
//   - 一般部分留在 parent (stXXX),代碼若無 t 則維持
//   - 破圈部分搬到 t-variant (stXXXt),共用 split_pair_id
//   - 「一旦拆 pair 觸發,所有破圈一律進 t-variant」(包括跨家族破圈,例 jk_poquan 在 AV9 碰撞情境下也進)
//
// 不觸發(維持單支,不加 t):
//   - 純一般(可多家族)
//   - 純破圈(可多家族,例 av9_poquan + jk_poquan,沒撞母)
//   - 跨家族混合不撞母(例 AV9 + jk_poquan,沒 av9_poquan)

// 判斷 pid 是否為破圈產品(以 state.products 為準)
export function isPoquanPid(products, pid) {
  return !!products?.find((p) => p.id === pid)?.is_poquan;
}

// 取得破圈產品的母家族 id;非破圈/找不到 → null
export function parentFamilyOf(products, pid) {
  const p = products?.find((x) => x.id === pid);
  if (!p || !p.is_poquan) return null;
  return p.parent_product_id || null;
}

// 偵測 weights 是否觸發同家族碰撞,回傳:
//   - { collision: false } 若沒觸發
//   - { collision: true, families: [parentId, ...] } 若有觸發(列出碰撞的家族 id)
export function detectFamilyCollision(weights, products) {
  const ws = weights || {};
  const activePids = Object.keys(ws).filter((k) => Number(ws[k]) > 0);
  if (activePids.length === 0) return { collision: false };

  const normalPidsSet = new Set();
  const poquanFamilies = new Set();  // 破圈所屬的母家族 id
  for (const pid of activePids) {
    if (isPoquanPid(products, pid)) {
      const parent = parentFamilyOf(products, pid);
      if (parent) poquanFamilies.add(parent);
    } else {
      normalPidsSet.add(pid);
    }
  }

  const collidingFamilies = [];
  for (const family of poquanFamilies) {
    if (normalPidsSet.has(family)) collidingFamilies.push(family);
  }
  return collidingFamilies.length > 0
    ? { collision: true, families: collidingFamilies }
    : { collision: false };
}

export function normalizeWeightsToTotal(weights, target = 100) {
  const entries = Object.entries(weights || {})
    .map(([pid, w], index) => ({ pid, value: Number(w) || 0, index }))
    .filter((e) => e.value > 0);
  if (entries.length === 0 || target <= 0) return {};

  const total = entries.reduce((sum, e) => sum + e.value, 0);
  if (total <= 0) return {};

  const scaled = entries.map((e) => {
    const raw = e.value / total * target;
    return { ...e, raw, floor: Math.floor(raw), rem: raw - Math.floor(raw) };
  });
  let assigned = scaled.reduce((sum, e) => sum + e.floor, 0);
  let diff = target - assigned;
  const order = scaled
    .slice()
    .sort((a, b) => b.rem - a.rem || b.value - a.value || a.index - b.index);
  for (const e of order) {
    if (diff <= 0) break;
    e.floor += 1;
    diff -= 1;
  }

  const out = {};
  for (const e of scaled) {
    if (e.floor > 0) out[e.pid] = e.floor;
  }
  return out;
}

// 根據 weights 拆成「一般側」與「破圈側」兩塊。
// normal / poquan 保留使用者輸入的整體合約 %,用於金額切分與 todo 顯示。
// normalInternal / poquanInternal 則各自 normalize 到 100%,用於 split pair 內部儲存。
export function splitWeightsByFamily(weights, products) {
  const normal = {};
  const poquan = {};
  for (const [pid, w] of Object.entries(weights || {})) {
    const v = Number(w) || 0;
    if (v <= 0) continue;
    if (isPoquanPid(products, pid)) poquan[pid] = v;
    else normal[pid] = v;
  }
  const normalSum = Object.values(normal).reduce((s, v) => s + v, 0);
  const poquanSum = Object.values(poquan).reduce((s, v) => s + v, 0);
  const normalInternal = normalizeWeightsToTotal(normal, 100);
  const poquanInternal = normalizeWeightsToTotal(poquan, 100);
  return { normal, poquan, normalSum, poquanSum, normalInternal, poquanInternal };
}

// 給定 base 代碼,推出 parent 代碼 與 t-variant 代碼:
//   - "st123"  → { parentCode: "st123",  tVariantCode: "st123t"  }
//   - "st123t" → { parentCode: "st123",  tVariantCode: "st123t"  }(語意尾綴 t 已存在,strip 後當 base)
// 大小寫保留(使用者輸入什麼就用什麼);只是若使用者輸入 stXXXT 我們依小寫 t 判定 strip。
export function deriveSplitCodes(baseInput) {
  const raw = String(baseInput || "").trim();
  if (!raw) return { parentCode: "", tVariantCode: "" };
  const stripped = raw.replace(/[tT]$/, "");
  return { parentCode: stripped, tVariantCode: stripped + "t" };
}

// 判斷一支廣告(weights + split_role)在家族卡片中應該被歸到「一般」還是「破圈」側
//   - 在 split pair 中:用 split_role 判定(canonical form 保證 parent=一般、t_variant=破圈)
//   - 不在 pair:純破圈權重 → 破圈;否則 → 一般(混合在新規則下會被自動拆,不應出現)
export function adFamilySide(ad, products) {
  if (ad?.split_role === "t_variant") return "poquan";
  if (ad?.split_role === "parent") return "normal";
  const weights = ad?.weights || {};
  const activePids = Object.keys(weights).filter((k) => Number(weights[k]) > 0);
  if (activePids.length === 0) return "normal";
  const allPoquan = activePids.every((pid) => isPoquanPid(products, pid));
  return allPoquan ? "poquan" : "normal";
}
