/* Account-scoped persistence and cross-device sync.
 *
 * IndexedDB is device-local: it never leaves the browser it was written in.
 * This module puts the same data in the artifact's `db` store, which is
 * server-side and keyed to the signed-in viewer, so an import made on a laptop
 * is there on a phone after signing into the same account.
 *
 * WHERE THINGS GO
 *
 *   data/users/<uid>/state                      the small stuff: balances,
 *                                               policy, plans, costs, and one
 *                                               metadata row per import
 *   data/users/<uid>/blobs                      manifest: which blobs exist,
 *                                               how many chunks, their hashes
 *   data/users/<uid>/blobs/<key>/c<n>           the bulk: preview files and
 *                                               the transaction ledger
 *
 * A per-user path is NOT authorization. This legacy adapter is disabled in
 * the app until server-enforced access isolation and transport are deployed
 * and verified. Do not infer privacy from a successful storage round trip.
 *
 * WHY CHUNKS
 *
 * A db document caps at 256 KiB and an artifact's database at 5,000 documents.
 * One preview is ~320 KiB of JSON and a year of transactions is ~36 MiB as
 * base64, so bulk data is split across chunk documents under a manifest. The
 * manifest is written LAST, after every chunk lands: a half-written blob is
 * never referenced, so a failed sync leaves the previous version intact rather
 * than a corrupt one.
 *
 * CONFLICTS
 *
 * The store is last-writer-wins with no transactions, so this module never
 * relies on one. Every state document carries a monotonic `rev`. A push reads
 * the remote `rev` first and refuses when it has moved since the local copy
 * was based on it; the caller is handed both sides and asks. Imports are the
 * one thing merged automatically, by content hash — two devices importing two
 * different files is an addition, not a conflict.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.Sync = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* Chunk payload ceiling. The document cap is 256 KiB; this leaves room for
     the JSON envelope and for multi-byte escaping inside the string. */
  const CHUNK = 180 * 1024;

  /* Refuse rather than spend an hour writing chunks that will be rate-limited.
     185 chunks is the measured cost of a 180k-row transaction export. */
  const MAX_CHUNKS_PER_BLOB = 400;

  const STATE_KEYS = [
    'balanceSnapshots', 'deferredSnapshots', 'policy', 'requestPlans',
    'productCosts', 'operatingCosts', 'cashCommitments', 'settlements',
    'bankDeposits', 'advertisingBilling', 'forecastRuns', 'openingBankCash',
    'cashPlan', 'imports', 'removedImports', 'schedule',
  ];

  /* ── JSON that survives BigInt ───────────────────────────────────────────
     Preview amounts are BigInt for exact decimal arithmetic. JSON has no such
     type, so they are tagged on the way out and restored on the way back —
     never coerced to Number, which would lose cents at scale. */
  function encode(value) {
    return JSON.stringify(value, (k, v) => {
      if (typeof v === 'bigint') return { __big: v.toString() };
      if (v instanceof ArrayBuffer) return { __buf: bytesToB64(new Uint8Array(v)) };
      if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
        return { __ta: v.constructor.name, d: bytesToB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      }
      return v;
    });
  }

  const TYPED = {
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
  };

  function decode(text) {
    return JSON.parse(text, (k, v) => {
      if (v && typeof v === 'object') {
        if (typeof v.__big === 'string') return BigInt(v.__big);
        if (typeof v.__buf === 'string') return b64ToBytes(v.__buf).buffer;
        if (typeof v.__ta === 'string' && TYPED[v.__ta]) {
          return new TYPED[v.__ta](b64ToBytes(v.d).buffer);
        }
      }
      return v;
    });
  }

  /* Chunked both ways: String.fromCharCode.apply over a multi-megabyte array
     blows the argument stack. */
  function bytesToB64(bytes) {
    let out = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return btoa(out);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* Same FNV-1a shape the CSV importer uses: enough to tell two payloads
     apart, and labelled as a fingerprint rather than a checksum. */
  function fingerprint(str) {
    let a = 0x811c9dc5, b = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
      b = (b + c) >>> 0; b = Math.imul(b, 0x85ebca6b) >>> 0; b ^= b >>> 13;
    }
    return (a >>> 0).toString(16).padStart(8, '0')
      + (b >>> 0).toString(16).padStart(8, '0')
      + str.length.toString(16);
  }

  /* Blob keys become path segments, where only letters, digits and
     `_ - . ~ : @ +` are legal. */
  const safeKey = k => String(k).replace(/[^A-Za-z0-9_\-.~:@+]/g, '_').slice(0, 180);

  function splitChunks(text) {
    const parts = [];
    for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
    return parts.length ? parts : [''];
  }

  /* One retry for a transient platform condition, and none for anything else:
     a rejected write that cannot succeed must not be tried in a loop. */
  async function once(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e && e.code === 'unavailable') {
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        return fn();
      }
      throw e;
    }
  }

  /* `remoteOnly` means "this computer has the row but not yet the file". It is
     true of one computer, never of the data, so it never leaves: sent up, it
     would tell the computer that HAS the file not to send it. */
  function withoutLocal(imports) {
    return (imports || []).map(i => {
      if (!i || !('remoteOnly' in i)) return i;
      const c = Object.assign({}, i);
      delete c.remoteOnly;
      return c;
    });
  }

  /* Whether two saved states hold the same things, whatever order their lists
     are in. A computer that has just taken the project's copy and added
     nothing must not send it straight back - the other computer would take
     that as a change, send it back again, and the two would never stop. */
  function canonical(v) {
    if (Array.isArray(v)) {
      const items = v.map(canonical);
      const key = x => (x && typeof x === 'object' && !Array.isArray(x) && (x.id || x.contentHash)) || encode(x);
      return items.map(x => [String(key(x)), x]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(p => p[1]);
    }
    if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (k === 'remoteOnly' || v[k] === undefined) continue;
        out[k] = canonical(v[k]);
      }
      return out;
    }
    return v;
  }
  const importKey = i => (i && (i.contentHash || i.id)) || null;
  const importAt = i => (i && (i.fetchedAt || i.importedAt)) || '';
  function withoutRemoved(imports, removed) {
    const gone = new Map();
    for (const r of removed || []) {
      if (r && r.key && (!gone.has(r.key) || gone.get(r.key) < r.at)) gone.set(r.key, r.at || '');
    }
    if (!gone.size) return imports || [];
    return (imports || []).filter(i => {
      const at = gone.get(importKey(i));
      return at === undefined || importAt(i) > at;
    });
  }
  /* The record that a file was removed: which file, and when. Old records are
     dropped after 90 days so the list cannot grow without end. */
  function removal(imp, now) {
    const at = now || new Date().toISOString();
    return { id: importKey(imp) + '@' + at, key: importKey(imp), at };
  }
  function trimRemovals(list, now) {
    const cutoff = new Date(Date.parse(now || new Date().toISOString()) - 90 * 864e5).toISOString();
    return (list || []).filter(r => r && r.at && r.at >= cutoff);
  }

  function sameState(a, b) {
    const pick = s => {
      const o = {};
      for (const k of STATE_KEYS) o[k] = s && s[k] != null ? s[k] : null;
      return o;
    };
    return encode(canonical(pick(a))) === encode(canonical(pick(b)));
  }

  /* ── the module ──────────────────────────────────────────────────────── */

  function create(opts) {
    opts = opts || {};
    const onStatus = opts.onStatus || function () {};
    /* Only the store it is handed. The artifact store this once fell back to
       had no server-enforced isolation, so it is never picked up by default. */
    const useCap = opts.use || null;

    const S = {
      status: 'connecting',
      reason: null,
      uid: null,
      db: null,
      baseRev: 0,
      lastSyncedAt: null,
      progress: null,
      conflict: null,
      deviceId: null,
    };

    function set(status, extra) {
      S.status = status;
      Object.assign(S, extra || {});
      onStatus(snapshot());
    }
    function snapshot() {
      return {
        status: S.status, reason: S.reason, uid: S.uid,
        lastSyncedAt: S.lastSyncedAt, progress: S.progress,
        conflict: S.conflict, deviceId: S.deviceId,
      };
    }

    /* A stable per-device id, so a conflict can name the other side. Local on
       purpose: it identifies the browser, not the person. */
    function deviceId() {
      if (S.deviceId) return S.deviceId;
      let id = null;
      try { id = localStorage.getItem('fba-device-id'); } catch (e) { /* blocked */ }
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2, 10);
        try { localStorage.setItem('fba-device-id', id); } catch (e) { /* blocked */ }
      }
      S.deviceId = id;
      return id;
    }

    /* ── connection ──────────────────────────────────────────────────── */

    async function connect() {
      deviceId();
      if (!useCap) {
        set('unavailable', { reason: 'No place to sync to is set up, so everything is saved on '
          + 'this computer only.' });
        return false;
      }
      let db = null, user = null;
      try {
        db = await useCap('db');
        user = await useCap('user');
      } catch (e) {
        set('unavailable', { reason: 'The sync service could not be reached.' });
        return false;
      }
      if (!db) {
        set('unavailable', { reason: 'Account sync is not available in this view, so imports are '
          + 'saved on this device only.' });
        return false;
      }
      const uid = user ? await user.id() : null;
      if (!uid) {
        set('unavailable', { reason: 'Your account could not be identified, so there is no private '
          + 'place to sync to. Imports are saved on this device only.' });
        return false;
      }
      S.db = db;
      S.uid = uid;
      set('idle', { reason: null });
      return true;
    }

    const stateDoc = () => S.db.doc('data/users/' + S.uid + '/state');
    /* Which computer is running this morning's download. Last writer wins,
       so whoever writes it reads it back before trusting it (app.js). */
    const leaseDoc = () => S.db.doc('data/users/' + S.uid + '/lease');
    async function readLease() {
      const snap = await once(() => leaseDoc().get());
      return snap.exists ? snap.data() : null;
    }
    async function writeLease(obj) { await once(() => leaseDoc().set(obj)); }
    const blobsDoc = () => S.db.doc('data/users/' + S.uid + '/blobs');
    const chunkCol = key => blobsDoc().collection(safeKey(key));

    /* ── blobs ───────────────────────────────────────────────────────── */

    async function readManifest() {
      const snap = await once(() => blobsDoc().get());
      return snap.exists ? (snap.data().items || {}) : {};
    }

    async function putBlob(key, value, meta) {
      const text = encode(value);
      const fp = fingerprint(text);
      const manifest = await readManifest();
      const existing = manifest[safeKey(key)];
      if (existing && existing.fingerprint === fp) {
        return { key: safeKey(key), skipped: true, chunks: existing.chunks, fingerprint: fp };
      }

      const parts = splitChunks(text);
      if (parts.length > MAX_CHUNKS_PER_BLOB) {
        const err = new Error('This file is ' + Math.round(text.length / 1048576)
          + ' MB once encoded, which is past what account sync can hold ('
          + Math.round(MAX_CHUNKS_PER_BLOB * CHUNK / 1048576) + ' MB). '
          + 'It stays saved on this device.');
        err.code = 'too_large';
        throw err;
      }

      const col = chunkCol(key);
      for (let i = 0; i < parts.length; i++) {
        await once(() => col.doc('c' + i).set({ d: parts[i], i, of: parts.length }));
        if (S.progress) {
          S.progress = Object.assign({}, S.progress, { chunk: i + 1, chunks: parts.length });
          onStatus(snapshot());
        }
      }
      /* Sweep chunks left over from a longer previous version, so a shorter
         blob cannot be read back with a stale tail. */
      if (existing && existing.chunks > parts.length) {
        for (let i = parts.length; i < existing.chunks; i++) {
          try { await col.doc('c' + i).delete(); } catch (e) { /* already gone */ }
        }
      }

      /* Manifest last: until this lands, the old blob is still the live one. */
      manifest[safeKey(key)] = {
        chunks: parts.length, bytes: text.length, fingerprint: fp,
        kind: (meta && meta.kind) || null, name: (meta && meta.name) || null,
        updatedAt: new Date().toISOString(),
      };
      await once(() => blobsDoc().set({ items: manifest, updatedAt: new Date().toISOString() }));
      return { key: safeKey(key), skipped: false, chunks: parts.length, fingerprint: fp };
    }

    async function getBlob(key) {
      const manifest = await readManifest();
      const entry = manifest[safeKey(key)];
      if (!entry) return null;
      const col = chunkCol(key);
      let text = '';
      for (let i = 0; i < entry.chunks; i++) {
        const snap = await once(() => col.doc('c' + i).get());
        if (!snap.exists) return null;                 // torn: treat as absent
        text += snap.data().d || '';
      }
      if (fingerprint(text) !== entry.fingerprint) return null;
      return decode(text);
    }

    async function deleteBlob(key) {
      const manifest = await readManifest();
      const entry = manifest[safeKey(key)];
      if (!entry) return;
      delete manifest[safeKey(key)];
      await once(() => blobsDoc().set({ items: manifest, updatedAt: new Date().toISOString() }));
      const col = chunkCol(key);
      for (let i = 0; i < entry.chunks; i++) {
        try { await col.doc('c' + i).delete(); } catch (e) { /* already gone */ }
      }
    }

    /* ── state ───────────────────────────────────────────────────────── */

    async function pullState() {
      const snap = await once(() => stateDoc().get());
      if (!snap.exists) return null;
      const d = snap.data();
      return {
        rev: d.rev || 0,
        updatedAt: d.updatedAt || null,
        device: d.device || null,
        payload: d.payload ? decode(d.payload) : null,
      };
    }

    /* Refuses when the remote has moved on. `force` is only ever passed after
       the person has been shown both sides and chosen. */
    async function pushState(localState, force) {
      const remote = await pullState();
      if (remote && !force && remote.rev !== S.baseRev) {
        const conflict = {
          remoteRev: remote.rev, localBaseRev: S.baseRev,
          remoteAt: remote.updatedAt, remoteDevice: remote.device,
          remotePayload: remote.payload,
        };
        set('conflict', { conflict });
        const err = new Error('changed on another device');
        err.code = 'conflict';
        err.conflict = conflict;
        throw err;
      }
      const rev = (remote ? remote.rev : 0) + 1;
      const payload = {};
      for (const k of STATE_KEYS) payload[k] = k === 'imports' ? withoutLocal(localState[k]) : localState[k];
      const text = encode(payload);
      if (text.length > 240 * 1024) {
        const err = new Error('Saved settings are too large for one document.');
        err.code = 'too_large';
        throw err;
      }
      await once(() => stateDoc().set({
        rev, payload: text, device: deviceId(), updatedAt: new Date().toISOString(),
        app: 'fba-cash-organizer', schema: 1,
      }));
      S.baseRev = rev;
      return rev;
    }

    /* ── merging ─────────────────────────────────────────────────────── */

    /* Two devices importing two different files is an addition, not a
       collision. Identity is the file's content hash where there is one, and
       the coverage period otherwise, so the same export dropped twice on two
       machines converges to one row. */
    function mergeImports(mine, theirs) {
      const key = i => i.contentHash || (i.family + '|' + i.coverage);
      const out = new Map();
      for (const i of theirs || []) out.set(key(i), i);
      for (const i of mine || []) {
        const k = key(i);
        const prev = out.get(k);
        if (!prev) { out.set(k, i); continue; }
        /* Same file on both sides: keep whichever was imported first, so the
           id that other records point at stays stable. */
        out.set(k, (prev.importedAt || '') <= (i.importedAt || '') ? prev : i);
      }
      return [...out.values()].sort((a, b) => (a.importedAt || '') < (b.importedAt || '') ? -1 : 1);
    }

    /* Everything else: the side edited more recently wins the whole list,
       because a half-merged policy is worse than a chosen one. Lists that are
       pure accumulations are unioned instead. */
    function mergeState(mine, theirs, preferLocal) {
      const out = {};
      const ACCUMULATED = ['balanceSnapshots', 'deferredSnapshots', 'settlements',
        'bankDeposits', 'forecastRuns', 'requestPlans', 'cashCommitments', 'removedImports'];
      for (const k of STATE_KEYS) {
        if (k === 'imports') { out[k] = mergeImports(mine[k], theirs ? theirs[k] : []); continue; }
        if (ACCUMULATED.indexOf(k) >= 0) {
          out[k] = unionBy(mine[k] || [], (theirs && theirs[k]) || []);
          continue;
        }
        const t = theirs ? theirs[k] : undefined;
        out[k] = preferLocal || t === undefined || t === null ? mine[k] : t;
      }
      /* A file removed on one computer stays removed on the others: without
         this, the other computer's copy would add it straight back, and the
         two would pass it back and forth for ever. A removal only covers the
         copy it removed - the same file downloaded again afterwards is new. */
      out.imports = withoutRemoved(out.imports, out.removedImports);
      return out;
    }

    function unionBy(a, b) {
      const seen = new Set();
      const out = [];
      for (const x of [].concat(b, a)) {
        if (!x) continue;
        const k = x.id || JSON.stringify(x);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(x);
      }
      return out;
    }

    return {
      connect,
      get state() { return snapshot(); },
      get available() { return S.status !== 'unavailable' && S.status !== 'connecting'; },
      setStatus: set,
      setBaseRev(r) { S.baseRev = r; },
      get baseRev() { return S.baseRev; },
      pullState, pushState, readLease, writeLease,
      putBlob, getBlob, deleteBlob, readManifest,
      mergeState, mergeImports,
      /* exported for tests */
      encode, decode, fingerprint, splitChunks, safeKey, CHUNK, MAX_CHUNKS_PER_BLOB, STATE_KEYS,
    };
  }

  /* The document store, through the local helper, into the owner's own
     Supabase project. What the old adapter lacked was access control a
     server enforces; this has it. The table has Row Level Security on and
     no policy, so only the project's secret key reaches it - and that key
     never leaves the helper. The page sees documents, never the key.

     One owner per project, so the user id is fixed: the isolation is the
     project, not a path name. Errors keep the helper's code, so a busy
     project ('unavailable') gets the module's one retry and nothing else
     does. */
  function helperStore(worker) {
    const wrap = e => {
      const err = new Error((e && e.message) || 'The helper did not answer.');
      err.code = (e && e.payload && e.payload.code) || (e && e.code === 'unauthorised' ? 'revoked' : 'unavailable');
      return err;
    };
    const docRef = path => ({
      async get() {
        let r;
        try { r = await worker.cloudGet(path); } catch (e) { throw wrap(e); }
        return { id: path.split('/').pop(), exists: !!(r && r.exists), data: () => (r ? r.data : undefined) };
      },
      async set(obj) {
        try { await worker.cloudSet(path, obj); } catch (e) { throw wrap(e); }
      },
      async delete() {
        try { await worker.cloudDelete(path); } catch (e) { throw wrap(e); }
      },
      collection(sub) { return { doc: id => docRef(path + '/' + sub + '/' + id) }; },
    });
    const db = { doc: docRef };
    const user = { id: async () => 'owner' };
    return async what => (what === 'db' ? db : what === 'user' ? user : null);
  }

  return { create, helperStore, encode, decode, fingerprint, splitChunks, safeKey,
    sameState, withoutLocal, withoutRemoved, removal, trimRemovals, CHUNK, MAX_CHUNKS_PER_BLOB, STATE_KEYS };
});
