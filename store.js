'use strict';
/* ═══════════════════════════════════════════════════════════
   保存(この端末の中だけ。外には送らない)
   proj: 案件のデータ(JSON) / file: 図面(PDF・画像)の中身
═══════════════════════════════════════════════════════════ */
const Store = (() => {
  let _db = null;
  function db() {
    return _db || (_db = new Promise((res, rej) => {
      const r = indexedDB.open('hiroicho-m', 1);
      r.onupgradeneeded = () => { const d = r.result;
        if (!d.objectStoreNames.contains('proj')) d.createObjectStore('proj');
        if (!d.objectStoreNames.contains('file')) d.createObjectStore('file'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store); let out;
      const q = fn(s); if (q) q.onsuccess = () => { out = q.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  }
  const api = {
    getProj: id => tx('proj', 'readonly', s => s.get(id)),
    putProj: P => tx('proj', 'readwrite', s => s.put(JSON.parse(JSON.stringify(P)), P.id)),
    delProj: async P => { for (const f of P.files || []) await api.delFile(P.id, f.id); return tx('proj', 'readwrite', s => s.delete(P.id)); },
    listProj: () => tx('proj', 'readonly', s => s.getAll()),
    getFile: (pid, fid) => tx('file', 'readonly', s => s.get(pid + '/' + fid)),
    putFile: (pid, fid, v) => tx('file', 'readwrite', s => s.put(v, pid + '/' + fid)),
    delFile: (pid, fid) => tx('file', 'readwrite', s => s.delete(pid + '/' + fid)),
  };

  /* 案件ファイル(.hiroicho): 案件のデータ + 図面の中身。iPhone ⇄ PC の受け渡し・控えに使う */
  function b64(buf) {
    const u = new Uint8Array(buf); let s = ''; const C = 0x8000;
    for (let i = 0; i < u.length; i += C) s += String.fromCharCode.apply(null, u.subarray(i, i + C));
    return btoa(s);
  }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
  api.exportProj = async P => {
    // 図面1つずつ Blob にして、大きな文字列を一度に作らない(iPhone のメモリ対策)
    const parts = [new Blob(['{"format":"hiroicho","ver":1,"exportedAt":' + Date.now() + ',"project":' + JSON.stringify(P) + ',"files":['])];
    let first = true;
    for (const f of P.files) { const v = await api.getFile(P.id, f.id); if (!v) continue;
      parts.push(new Blob([(first ? '' : ',') + JSON.stringify({ id: f.id, type: v.type, data: b64(v.data) })])); first = false; }
    parts.push(new Blob([']}']));
    return new Blob(parts, { type: 'application/json' });
  };
  api.parseImport = async file => {
    const txt = await file.text(); let o;
    try { o = JSON.parse(txt); } catch (e) { throw new Error('拾い帳の案件ファイルではありません'); }
    if (!o || o.format !== 'hiroicho' || !o.project) throw new Error('拾い帳の案件ファイルではありません');
    return o;
  };
  api.saveImported = async (o, asNew) => {
    const P = o.project;
    const old = asNew ? null : await api.getProj(P.id);
    if (asNew) { const old = P.id; P.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); P.name = P.name + '(コピー)'; }
    for (const f of o.files || []) await api.putFile(P.id, f.id, { type: f.type, data: unb64(f.data) });
    P.updatedAt = Date.now();
    await api.putProj(P);
    if (old) for (const f of old.files || []) if (!(P.files || []).some(g => g.id === f.id)) await api.delFile(P.id, f.id).catch(() => {});   // 置き換えで使わなくなった図面
    return P;
  };
  api.persist = async () => { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; };
  api.estimate = async () => { try { if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate(); } catch (e) {} return null; };
  return api;
})();
