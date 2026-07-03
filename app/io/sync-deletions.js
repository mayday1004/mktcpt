let memoryStore = {};

function normalizeIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [ids])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
}

function sanitize(store) {
  const out = {};
  if (!store || typeof store !== "object") return out;
  for (const [sheetName, ids] of Object.entries(store)) {
    const clean = normalizeIds(ids);
    if (sheetName && clean.length > 0) out[sheetName] = clean;
  }
  return out;
}

function readStore() {
  return sanitize(memoryStore);
}

function writeStore(store) {
  memoryStore = sanitize(store);
}

export function loadPendingSyncDeletions() {
  return readStore();
}

export function getPendingSyncDeletedIds(sheetName) {
  return readStore()[sheetName] || [];
}

export function markSyncDeleted(sheetName, ids) {
  const clean = normalizeIds(ids);
  if (!sheetName || clean.length === 0) return;
  const store = readStore();
  store[sheetName] = normalizeIds([...(store[sheetName] || []), ...clean]);
  writeStore(store);
}

export function clearSyncDeleted(sheetName, ids) {
  const clean = new Set(normalizeIds(ids));
  if (!sheetName || clean.size === 0) return;
  const store = readStore();
  const next = (store[sheetName] || []).filter((id) => !clean.has(id));
  if (next.length > 0) store[sheetName] = next;
  else delete store[sheetName];
  writeStore(store);
}

export function hasPendingSyncDeletions() {
  return Object.values(readStore()).some((ids) => ids.length > 0);
}
