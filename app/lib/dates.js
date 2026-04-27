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

export function nextDay(ymd) {
  const d = new Date(ymd);
  d.setDate(d.getDate() + 1);
  return fmt(d);
}

export function addDays(ymd, n) {
  const d = new Date(ymd);
  d.setDate(d.getDate() + n);
  return fmt(d);
}

export function diffDays(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

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
