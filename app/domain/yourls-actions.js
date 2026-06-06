export const YOURLS_ACTION_SHEET = "YOURLS\u64cd\u4f5c\u4f47\u5217";
export const YOURLS_EXEC_LOG_SHEET = "YOURLS\u57f7\u884c\u7d00\u9304";

export const YOURLS_STATUSES = {
  queued: "queued",
  running: "running",
  applied: "applied",
  failed: "failed",
};

export const YOURLS_PRODUCT_ID_MAP = {
  av9_poquan: "AV9-\u7834\u5708",
  jk_poquan: "JK-\u7834\u5708",
};

export function parseShortUrlSlot(value) {
  const parts = String(value || "").split("+").map((p) => p.trim()).filter(Boolean);
  return parts.find((part) => /^L\d+$/i.test(part))?.toUpperCase() || "";
}

export function isL1YourlsAd(ad) {
  return parseShortUrlSlot(ad?.short_url_type) === "L1" && !!String(ad?.short_url_param || "").trim();
}

export function normalizeWeightsForYourls(weights, products = []) {
  const productName = new Map((products || []).map((p) => [p.id, p.name || p.id]));
  const entries = Object.entries(weights || {})
    .map(([pid, raw]) => ({ pid, raw: Number(raw) || 0 }))
    .filter((entry) => entry.raw > 0);
  const rawSum = entries.reduce((sum, entry) => sum + entry.raw, 0);
  if (rawSum <= 0) return [];

  const scaled = entries.map((entry) => {
    const value = entry.raw / rawSum * 100;
    const floor = Math.floor(value);
    return { ...entry, value, floor, remainder: value - floor };
  });
  let assigned = scaled.reduce((sum, entry) => sum + entry.floor, 0);
  let deficit = 100 - assigned;
  scaled.sort((a, b) => b.remainder - a.remainder || String(a.pid).localeCompare(String(b.pid)));
  for (let i = 0; i < scaled.length && deficit > 0; i++) {
    scaled[i].floor += 1;
    deficit -= 1;
  }

  return scaled
    .filter((entry) => entry.floor > 0)
    .sort((a, b) => b.floor - a.floor || String(a.pid).localeCompare(String(b.pid)))
    .map((entry) => ({
      product_id: entry.pid,
      product_name: productName.get(entry.pid) || entry.pid,
      yourls_product_id: YOURLS_PRODUCT_ID_MAP[entry.pid] || entry.pid,
      weight_pct: entry.floor,
    }));
}

export function weightSummaryFromList(weights) {
  return (weights || [])
    .filter((w) => Number(w.weight_pct) > 0)
    .map((w) => `${w.yourls_product_id || w.product_id} ${Number(w.weight_pct)}`)
    .join(" / ");
}

export function buildYourlsActionPayload({ kind, ad, weights, products, actionType = "", effectiveDate = "" }) {
  if (!isL1YourlsAd(ad)) return null;
  const normalized = normalizeWeightsForYourls(weights || ad.weights, products);
  const total = normalized.reduce((sum, w) => sum + Number(w.weight_pct || 0), 0);
  if (normalized.length === 0 || total !== 100) return null;

  const shortUrlParam = String(ad.short_url_param || "").trim();
  return {
    kind,
    short_url_param: shortUrlParam,
    source_ad_code: String(ad.ad_code || ""),
    source_ad_id: String(ad.id || ""),
    ad_name: String(ad.ad_name || ""),
    action_type: actionType,
    effective_date: effectiveDate || ad.start_date || "",
    weights: normalized,
    weight_summary: weightSummaryFromList(normalized),
  };
}

export function todoYourlsPayloads(todo) {
  if (Array.isArray(todo?.yourls_actions)) return todo.yourls_actions.filter(Boolean);
  if (todo?.yourls_action) return [todo.yourls_action];
  return [];
}

export function isYourlsTodo(todo) {
  return todoYourlsPayloads(todo).length > 0;
}

export function canApproveYourlsTodo(todo) {
  if (!isYourlsTodo(todo) || (todo.status || "pending") !== "pending") return false;
  return !["queued", "running", "applied"].includes(String(todo.yourls_status || ""));
}

export function approveYourlsTodo(state, todoId, { makeId, now, approvedBy = "" }) {
  const todo = (state.todos || []).find((t) => t.id === todoId);
  if (!todo || !canApproveYourlsTodo(todo)) return { ok: false, created: 0 };
  state.yourls_actions = Array.isArray(state.yourls_actions) ? state.yourls_actions : [];

  const createdIds = [];
  const payloads = todoYourlsPayloads(todo);
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    const actionId = makeId ? makeId(i, payload) : `${todo.id}_${i + 1}_${Date.now().toString(36)}`;
    state.yourls_actions.push({
      action_id: actionId,
      todo_id: todo.id,
      created_at: todo.created_at || now,
      approved_at: now,
      approved_by: approvedBy,
      kind: payload.kind,
      short_url_param: payload.short_url_param,
      source_ad_code: payload.source_ad_code || "",
      ad_name: payload.ad_name || "",
      weight_summary: payload.weight_summary || weightSummaryFromList(payload.weights),
      payload,
      status: YOURLS_STATUSES.queued,
      worker_id: "",
      claimed_at: "",
      completed_at: "",
      last_error: "",
      attempts: 0,
      updated_at: now,
    });
    createdIds.push(actionId);
  }

  todo.yourls_status = YOURLS_STATUSES.queued;
  todo.yourls_action_ids = createdIds;
  todo.yourls_approved_at = now;
  todo.yourls_last_error = "";
  return { ok: true, created: createdIds.length, actionIds: createdIds };
}

export function parsePayloadJson(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function stableJson(value) {
  return JSON.stringify(value || {});
}

export function reconcileYourlsTodos(state) {
  if (!Array.isArray(state.todos)) state.todos = [];
  if (!Array.isArray(state.yourls_actions)) state.yourls_actions = [];
  if (!Array.isArray(state.yourls_execution_logs)) state.yourls_execution_logs = [];

  const actionsByTodo = new Map();
  for (const action of state.yourls_actions) {
    if (!action?.todo_id) continue;
    if (!actionsByTodo.has(action.todo_id)) actionsByTodo.set(action.todo_id, []);
    actionsByTodo.get(action.todo_id).push(action);
  }

  for (const todo of state.todos) {
    const rawActions = actionsByTodo.get(todo.id) || [];
    const currentIds = new Set((todo.yourls_action_ids || []).filter(Boolean));
    const actions = currentIds.size > 0
      ? rawActions.filter((a) => currentIds.has(a.action_id))
      : rawActions;
    if (actions.length === 0) continue;
    const statuses = actions.map((a) => String(a.status || YOURLS_STATUSES.queued));
    const hasRunning = statuses.includes(YOURLS_STATUSES.running);
    const hasQueued = statuses.includes(YOURLS_STATUSES.queued);
    const hasFailed = statuses.includes(YOURLS_STATUSES.failed);
    const allApplied = statuses.length > 0 && statuses.every((s) => s === YOURLS_STATUSES.applied);
    todo.yourls_action_ids = actions.map((a) => a.action_id);
    if (allApplied) {
      todo.status = "done";
      todo.yourls_status = YOURLS_STATUSES.applied;
      todo.yourls_applied_at = actions.map((a) => a.completed_at).filter(Boolean).sort().at(-1) || "";
      todo.yourls_last_error = "";
    } else if (hasRunning) {
      todo.status = "pending";
      todo.yourls_status = YOURLS_STATUSES.running;
    } else if (hasQueued) {
      todo.status = "pending";
      todo.yourls_status = YOURLS_STATUSES.queued;
    } else if (hasFailed) {
      todo.status = "pending";
      todo.yourls_status = YOURLS_STATUSES.failed;
      todo.yourls_last_error = actions.map((a) => a.last_error).filter(Boolean).join(" / ");
    }
  }
}
