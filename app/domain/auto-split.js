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

// 兩側段集合(parent 側 / t-variant 側)是否構成「真正的同家族碰撞」:
// t 側任一段的破圈產品,其母產品出現在 parent 側任一段的一般權重中。
// 這是 split pair(金額連動 carve-out)唯一合法的存在理由;
// 同基碼但各自獨立採買的 1012 / 1012t(例:黃油圈 + 兩個破圈)不構成碰撞。
export function sidesHaveFamilyCollision(parentSegs, tSegs, products) {
  const normalPids = new Set();
  for (const seg of parentSegs || []) {
    for (const [pid, w] of Object.entries(seg?.weights || {})) {
      if (Number(w) > 0 && !isPoquanPid(products, pid)) normalPids.add(pid);
    }
  }
  if (normalPids.size === 0) return false;
  for (const seg of tSegs || []) {
    for (const [pid, w] of Object.entries(seg?.weights || {})) {
      if (Number(w) <= 0 || !isPoquanPid(products, pid)) continue;
      const family = parentFamilyOf(products, pid);
      if (family && normalPids.has(family)) return true;
    }
  }
  return false;
}

// 獨立採買單列多產品全 100%(例:1012t 一列 {av9_poquan:100, jk_poquan:100})
// 只可能來自表單外的輸入(表單強制加總 = 100)。§2.3 的 canonical 形是
// 「每個產品自己一筆、各 100%」,否則 dailySpendForAd 的 w/100 會把權重當共購比例算錯。
// 語意:單列多產品各 100% = 每個產品**各買一份完整的**(金額就是每份的價格),
// 所以拆出的每份副本保留完整金額;第一份保留原 id(讓既有 renewal_of 指標不斷鏈)。
// 副本 id 用「原 id + 產品代碼」的確定性組合:多台 client 同時跑整理會拆出完全相同的列,
// row-level 同步合併時自然收斂,不會產生重複副本。
function splitAll100IndependentRows(state) {
  const ads = Array.isArray(state?.ads) ? state.ads : [];
  if (ads.length === 0) return 0;
  const copiesByOrig = new Map(); // 原 id → Map(pid → 副本 row)
  const out = [];
  let changed = 0;

  for (const a of ads) {
    const entries = Object.entries(a?.weights || {})
      .filter(([, w]) => Number(w) > 0)
      .sort(([p1], [p2]) => p1.localeCompare(p2));
    const isAll100Multi = !a?.split_pair_id && entries.length >= 2 &&
      entries.every(([, w]) => Number(w) === 100);
    if (!isAll100Multi) { out.push(a); continue; }

    const n = entries.length;
    const byPid = new Map();
    entries.forEach(([pid], index) => {
      const copy = {
        ...a,
        id: index === 0 ? a.id : `${a.id}__${pid}`,
        weights: { [pid]: 100 },
        purchase_mode: "independent",
        notes: [a.notes, `獨立採買自動拆分(原單列 ${n} 產品各 100%,各為一份完整採買)`]
          .filter((s) => s && String(s).trim()).join(" | "),
      };
      byPid.set(pid, copy);
      out.push(copy);
      changed++;
    });
    copiesByOrig.set(a.id, byPid);
  }

  if (changed === 0) return 0;
  // renewal_of 重接:後段若是單產品,改指向前段「同產品」的副本(前段第一份保留原 id,指標本就有效)
  for (const row of out) {
    if (!row?.renewal_of || !copiesByOrig.has(row.renewal_of)) continue;
    const pids = Object.keys(row.weights || {}).filter((pid) => Number(row.weights[pid]) > 0);
    if (pids.length !== 1) continue;
    const copy = copiesByOrig.get(row.renewal_of).get(pids[0]);
    if (copy) row.renewal_of = copy.id;
  }
  state.ads = out;
  return changed;
}

// X / Xt 同基碼配對整理(2026-07,kisuacg 1012/1012t 案例):
//   1. 解除「非同家族碰撞」的既有配對 — 舊版依代碼 t 尾綴硬配,把獨立採買的
//      1012(黃油圈)+ 1012t(破圈)綁成 carve-out,權重與金額被跨支縮放。
//   2. 自動配對 X + Xt:只在兩側真正同家族碰撞時才綁(取代「同基碼就配」)。
//   3. 拆分獨立採買的單列全 100% 資料(見 splitAll100IndependentRows)。
// 沒配對的同基碼廣告走「兄弟廣告」畫法:視覺放同一組、權重各自如實 100%、金額不縮放。
// 回傳異動筆數;在 state.update() / 同步 pull 完成後 / migrate() 各跑一次(冪等)。
export function reconcileSplitPairs(state) {
  const products = state?.products || [];
  const ads = Array.isArray(state?.ads) ? state.ads : [];
  if (ads.length === 0) return 0;
  let changed = 0;

  // 產品主檔還沒拉回破圈標記(冷啟動半套狀態)時,不做配對判斷,避免誤拆真配對
  const hasPoquanInfo = products.some((p) => p?.is_poquan);
  if (hasPoquanInfo) {
    // 1) 解除非同家族碰撞的配對
    const byPair = new Map();
    for (const a of ads) {
      if (!a?.split_pair_id) continue;
      if (!byPair.has(a.split_pair_id)) byPair.set(a.split_pair_id, []);
      byPair.get(a.split_pair_id).push(a);
    }
    for (const members of byPair.values()) {
      const codes = new Set(members.map((a) => a.ad_code));
      if (codes.size < 2) continue;
      const parentSegs = members.filter((a) => a.split_role !== "t_variant");
      const tSegs = members.filter((a) => a.split_role === "t_variant");
      if (parentSegs.length === 0 || tSegs.length === 0) continue;
      if (sidesHaveFamilyCollision(parentSegs, tSegs, products)) continue;
      for (const a of members) {
        a.split_pair_id = null;
        a.split_role = null;
        changed++;
      }
    }

    // 2) 自動配對 X + Xt(僅限真正同家族碰撞;沿用舊版的代碼樣式判斷)
    const codeSet = new Set();
    for (const a of ads) if (a.ad_code) codeSet.add(a.ad_code);
    for (const code of codeSet) {
      const lower = code.toLowerCase();
      if (!lower.endsWith("t") || lower.endsWith("dh")) continue;
      const parentCode = code.slice(0, -1);
      if (!codeSet.has(parentCode)) continue;
      const tAds = ads.filter((a) => a.ad_code === code);
      const pAds = ads.filter((a) => a.ad_code === parentCode);
      if (tAds.some((a) => a.split_pair_id) || pAds.some((a) => a.split_pair_id)) continue;
      if (!sidesHaveFamilyCollision(pAds, tAds, products)) continue;
      const pairId = `pair_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${code}`;
      for (const a of pAds) { a.split_pair_id = pairId; a.split_role = "parent"; changed++; }
      for (const a of tAds) { a.split_pair_id = pairId; a.split_role = "t_variant"; changed++; }
    }
  }

  // 3) 獨立採買單列全 100% 拆分(不依賴產品主檔)
  changed += splitAll100IndependentRows(state);
  return changed;
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
