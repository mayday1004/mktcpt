// 本次載入已知的廣告刪除；重新載入時由伺服器 tombstone 重建。
// 與待推送佇列分離：同步成功清空佇列後，舊待辦仍不能復活廣告。
const deletedIds = new Set();

export function markAdDeleted(id) {
  if (id) deletedIds.add(String(id));
}

export function restoreAdId(id) {
  deletedIds.delete(String(id));
}

export function isAdDeleted(id) {
  return deletedIds.has(String(id));
}
