// 端末内の保存（IndexedDB）

const DB_NAME = 'cycle-app';
const DB_VERSION = 2;

let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('periods', { keyPath: 'id', autoIncrement: true });
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // 2: 体調メモ（1日1件、日付がキー）
      if (e.oldVersion < 2) db.createObjectStore('notes', { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listPeriods = () => run('periods', 'readonly', s => s.getAll());
export const putPeriod = p => run('periods', 'readwrite', s => s.put(p));
export const deletePeriod = id => run('periods', 'readwrite', s => s.delete(id));

export async function replacePeriods(periods) {
  await run('periods', 'readwrite', s => {
    s.clear();
    for (const p of periods) s.put(p);
  });
}

export const listNotes = () => run('notes', 'readonly', s => s.getAll());
export const putNote = n => run('notes', 'readwrite', s => s.put(n));
export const deleteNote = date => run('notes', 'readwrite', s => s.delete(date));

export async function replaceNotes(notes) {
  await run('notes', 'readwrite', s => {
    s.clear();
    for (const n of notes) s.put(n);
  });
}

export async function getMeta(key) {
  const row = await run('meta', 'readonly', s => s.get(key));
  return row?.value;
}

export const setMeta = (key, value) => run('meta', 'readwrite', s => s.put({ key, value }));
