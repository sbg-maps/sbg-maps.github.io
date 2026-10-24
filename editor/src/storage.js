// Small IndexedDB key-value store, kept in this browser only (golfer model, autosaved project).
const DB = "sbg-map-editor";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(key, value) {
  const d = await db();
  await new Promise((res, rej) => {
    const tx = d.transaction("files", "readwrite");
    tx.objectStore("files").put(value, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}

export async function get(key) {
  const d = await db();
  return new Promise((res, rej) => {
    const req = d.transaction("files").objectStore("files").get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror = () => rej(req.error);
  });
}
