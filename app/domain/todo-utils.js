const ELIMINATE_AD_ACTION = "\u6dd8\u6c70\u5ee3\u544a";
export const ELIMINATION_RESTORED_MARKER = "\u5df2\u53d6\u6d88\u6dd8\u6c70";

function restoredEliminationCodes(description) {
  const restored = new Set();
  const text = String(description || "");
  const re = new RegExp(`${ELIMINATION_RESTORED_MARKER}[^\\n\\uff09)]*\\u6062\\u5fa9\\u8ffd\\u8e64[:\\uff1a ]([^\\n\\uff09)]+)`, "g");
  let match;
  while ((match = re.exec(text))) {
    String(match[1] || "")
      .split(/[、,\s]+/)
      .map((code) => code.trim())
      .filter(Boolean)
      .forEach((code) => restored.add(code));
  }
  return restored;
}

function familyBaseOfCode(code) {
  let c = String(code || "").trim();
  if (/^h5dh/i.test(c)) c = c.slice(4);
  else if (/^dh/i.test(c)) c = c.slice(2);
  const lower = c.toLowerCase();
  if (lower.endsWith("t") && c.length > 1) return c.slice(0, -1);
  if (lower.endsWith("dh") && c.length > 2) return c.slice(0, -2);
  return c;
}

function tVariantCandidates(base) {
  const c = String(base || "").trim();
  if (!c) return [];
  return [`${c}t`, `${c}T`];
}

export function expandAdCodesToEliminationFamily(state, codes) {
  const ads = Array.isArray(state?.ads) ? state.ads : [];
  const out = new Set((Array.isArray(codes) ? codes : [codes])
    .map((code) => String(code || "").trim())
    .filter(Boolean));
  if (out.size === 0 || ads.length === 0) return [...out];

  let changed = true;
  while (changed) {
    changed = false;
    const pairIds = new Set();
    for (const ad of ads) {
      if (out.has(String(ad.ad_code || "")) && ad.split_pair_id) pairIds.add(ad.split_pair_id);
    }
    for (const ad of ads) {
      if (ad.split_pair_id && pairIds.has(ad.split_pair_id) && ad.ad_code && !out.has(ad.ad_code)) {
        out.add(ad.ad_code);
        changed = true;
      }
    }

    const existingCodes = new Set(ads.map((ad) => String(ad.ad_code || "")).filter(Boolean));
    for (const code of [...out]) {
      const lower = code.toLowerCase();
      const base = familyBaseOfCode(code);
      const siblings = lower.endsWith("t")
        ? [base]
        : lower.endsWith("dh")
          ? []
          : tVariantCandidates(base);
      for (const sibling of siblings) {
        if (existingCodes.has(sibling) && !out.has(sibling)) {
          out.add(sibling);
          changed = true;
        }
      }
    }
  }

  return [...out];
}

export function normalizeTodoCreatedAt(value) {
  const s = String(value || "").trim();
  if (!s) return "";

  const iso = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) return `${iso[1]} ${iso[2]}:${iso[3] || "00"}`;

  const space = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (space) return `${space[1]} ${space[2]}:${space[3] || "00"}`;

  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return `${dateOnly[1]} 00:00:00`;

  return s;
}

export function extractEliminatedAdCodes(todo, state = null) {
  if (todo?.action_type !== ELIMINATE_AD_ACTION) return [];

  const codes = new Set();
  for (const snap of (todo.undo_payload?.ad_snapshots || [])) {
    if (snap?.ad_code) codes.add(String(snap.ad_code));
  }

  const desc = String(todo.description || "").trim();
  if (desc) {
    const tokens = desc.split(/\s+/).filter(Boolean);
    const first = String(tokens[0] || "").split(/[：:]/)[0];
    const code = /^\d{1,2}\/\d{1,2}$/.test(first)
      ? String(tokens[1] || "").split(/[：:]/)[0]
      : first;
    if (code) codes.add(code);
  }

  const restored = state
    ? expandAdCodesToEliminationFamily(state, [...restoredEliminationCodes(desc)])
    : [...restoredEliminationCodes(desc)];
  for (const code of restored) codes.delete(code);

  return state ? expandAdCodesToEliminationFamily(state, [...codes]) : [...codes];
}

export function normalizeTodosInState(state) {
  if (!Array.isArray(state.todos)) {
    state.todos = [];
    return;
  }
  for (const todo of state.todos) {
    todo.created_at = normalizeTodoCreatedAt(todo.created_at);
    todo.status = todo.status === "done" ? "done" : "pending";
  }
}

export function applyDoneEliminateTodos(state) {
  const codes = new Set();
  for (const todo of (state.todos || [])) {
    if ((todo.status || "pending") !== "done") continue;
    for (const code of extractEliminatedAdCodes(todo, state)) codes.add(code);
  }
  if (codes.size === 0) return 0;

  let changed = 0;
  for (const ad of (state.ads || [])) {
    if (codes.has(ad.ad_code) && ad.eliminated !== true) {
      ad.eliminated = true;
      changed += 1;
    }
  }
  return changed;
}
