// 全系統 TZ：台北（UTC+8，無 DST）。
// 所有「今天」「now timestamp」一律用台北時區，避免 toISOString() 給 UTC 跟使用者本地差時。
const TZ = "Asia/Taipei";

function _taipeiParts(date) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return o;
}

// 今日（台北）"YYYY-MM-DD"
export function todayTaipei() {
  const p = _taipeiParts(new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

// 現在（台北）"YYYY-MM-DD HH:MM:SS" — 給 created_at 等時間戳用
export function nowTaipeiStamp() {
  const p = _taipeiParts(new Date());
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

// 現在（台北）"HH:MM:SS"
export function nowTaipeiTime() {
  const p = _taipeiParts(new Date());
  return `${p.hour}:${p.minute}:${p.second}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthStart(ym) {
  return `${ym}-01`;
}

export function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m, 0).getDate();
  return `${ym}-${String(d).padStart(2, "0")}`;
}

// addDays / nextDay 使用 UTC 算術，避免使用者瀏覽器若不在台北時區時 setDate+toISOString 有 ±1 day bug。
// 內部用 UTC noon 做基準，setUTCDate 跟 getUTCDate 不會跨時區漂移。
export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function nextDay(ymd) {
  return addDays(ymd, 1);
}

export function diffDays(a, b) {
  // a, b 是 YYYY-MM-DD；用 UTC noon 對減，跨時區安全
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ta = Date.UTC(ay, am - 1, ad, 12, 0, 0);
  const tb = Date.UTC(by, bm - 1, bd, 12, 0, 0);
  return Math.round((tb - ta) / 86400000);
}

// 從 Date 對象格式化 YYYY-MM-DD（用 local 時區，主要給已知 local Date 對象用）
export function fmt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isInRange(ymd, startInclusive, endExclusive) {
  return ymd >= startInclusive && ymd < endExclusive;
}

export function* daysBetween(startInclusive, endExclusive) {
  let cur = startInclusive;
  while (cur < endExclusive) {
    yield cur;
    cur = nextDay(cur);
  }
}

export function* daysOfMonth(ym) {
  yield* daysBetween(monthStart(ym), nextDay(monthEnd(ym)));
}

export function monthOf(ymd) {
  return ymd.slice(0, 7);
}
