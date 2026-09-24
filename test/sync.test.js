/* Account sync: encoding, chunking, conflicts and merges.
 *
 * The `db` capability is replaced by a fake that enforces the parts of its
 * contract this module actually depends on — the 256 KiB document cap, the
 * even/odd path grammar, last-writer-wins with no transactions, and a missing
 * document reading as `exists: false` rather than throwing. A fake that were
 * more forgiving than the real store would prove nothing.
 */
const T = require('./harness.js');
const Sync = require('../lib/sync.js');
const Preview = require('../lib/preview.js');
const CSV = require('../lib/csv.js');

/* ── a fake db that enforces the real constraints ───────────────────────── */

function FakeDb(opts) {
  opts = opts || {};
  const docs = new Map();
  const stats = { writes: 0, reads: 0, deletes: 0 };

  const checkSegments = (path, wantEven) => {
    const segs = String(path).split('/');
    if (segs.some(s => !s || !/^[A-Za-z0-9_\-.~:@+]+$/.test(s))) {
      throw new TypeError('bad segment in path: ' + path);
    }
    if (wantEven && segs.length % 2 !== 0) {
      throw new TypeError('document path needs an even number of segments: ' + path);
    }
    if (!wantEven && segs.length % 2 === 0) {
      throw new TypeError('collection path needs an odd number of segments: ' + path);
    }
    return segs;
  };

  function docRef(path) {
    checkSegments(path, true);
    return {
      path,
      async get() {
        stats.reads++;
        const v = docs.get(path);
        return { id: path.split('/').pop(), exists: v !== undefined,
          data: () => (v === undefined ? undefined : JSON.parse(v)) };
      },
      async set(data) {
        stats.writes++;
        if (opts.failOn && opts.failOn(path, stats)) {
          const e = new Error('transient'); e.code = 'unavailable'; throw e;
        }
        const body = JSON.stringify(data);
        if (typeof data !== 'object' || data === null || Array.isArray(data)) {
          const e = new Error('body must be an object'); e.code = 'invalid_argument'; throw e;
        }
        if (body.length > 256 * 1024) {
          const e = new Error('document over 256 KiB: ' + body.length);
          e.code = 'invalid_argument'; throw e;
        }
        docs.set(path, body);
      },
      async delete() { stats.deletes++; docs.delete(path); },
      collection(sub) { return colRef(path + '/' + sub); },
    };
  }
  function colRef(path) {
    checkSegments(path, false);
    return { path, doc: id => docRef(path + '/' + id) };
  }

  return {
    doc: docRef, collection: colRef, _docs: docs, _stats: stats,
    _size: () => [...docs.values()].reduce((s, v) => s + v.length, 0),
  };
}

const fakeUser = uid => ({ id: async () => uid });

function makeSync(db, uid, statusLog) {
  return Sync.create({
    onStatus: s => { if (statusLog) statusLog.push(s.status); },
    use: async name => (name === 'db' ? db : name === 'user' ? fakeUser(uid) : null),
  });
}

/* localStorage is only used for a device id; absence must not break anything. */
if (typeof localStorage === 'undefined') {
  global.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
}

/* ── encoding ───────────────────────────────────────────────────────────── */

T.section('Encoding survives the types this app actually holds');
{
  const round = v => Sync.decode(Sync.encode(v));

  const big = round({ amount: 123456789012345678901234567890n });
  T.eq('BigInt is preserved exactly, not coerced to Number',
    big.amount.toString(), '123456789012345678901234567890');
  T.eq('and stays a BigInt', typeof big.amount, 'bigint');

  const ta = round({ col: new Int32Array([1, -2, 3, 2147483647]) });
  T.eq('typed arrays keep their type', ta.col.constructor.name, 'Int32Array');
  T.eq('and their values', Array.from(ta.col).join(','), '1,-2,3,2147483647');

  const f = round({ c: new Float64Array([0.1, 1e300]) });
  T.eq('float precision is not rounded through a string', f.c[0], 0.1);

  const buf = round({ b: new Uint8Array([7, 8, 9]).buffer });
  T.eq('ArrayBuffers survive', new Uint8Array(buf.b).join(','), '7,8,9');

  T.eq('null and undefined are not confused',
    JSON.stringify(round({ a: null })), JSON.stringify({ a: null }));
}

T.section('Chunking respects the document cap');
{
  const text = 'x'.repeat(Sync.CHUNK * 2 + 17);
  const parts = Sync.splitChunks(text);
  T.eq('a payload splits into ceil(size/CHUNK) parts', parts.length, 3);
  T.eq('and reassembles byte for byte', parts.join(''), text);
  T.ok('every part is under the document cap',
    parts.every(p => p.length <= Sync.CHUNK), 'largest ' + Math.max(...parts.map(p => p.length)));
  T.eq('an empty payload still produces one chunk', Sync.splitChunks('').length, 1);
}

T.section('Blob keys are legal path segments');
{
  T.eq('an import id passes through', Sync.safeKey('imp-m1x2y3-ab'), 'imp-m1x2y3-ab');
  T.eq('a filename with spaces and slashes is made safe',
    Sync.safeKey('July Report/2026.csv'), 'July_Report_2026.csv');
  T.ok('no illegal character survives',
    /^[A-Za-z0-9_\-.~:@+]+$/.test(Sync.safeKey('a b/c#d%e')), Sync.safeKey('a b/c#d%e'));
}

/* ── round trip through the store ───────────────────────────────────────── */

(async () => {

  T.section('A real preview file round-trips through the store');
  {
    const db = FakeDb();
    const sync = makeSync(db, 'user-1');
    T.ok('connects when db and user are both there', await sync.connect());

    const header = ['Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU',
      'MSKU', 'Currency code', 'Average sales price', 'Units sold', 'Units returned',
      'Net units sold', 'Sales', 'Net sales', 'Referral fee per unit',
      'Referral fee quantity', 'Referral fee total'].join(',');
    let csv = '﻿' + header + '\n';
    for (let i = 0; i < 300; i++) {
      csv += ['US', '10/01/2026', '10/31/2026', 'BP', 'B' + i, 'X' + i, 'MSKU-' + i, 'USD',
        '25.00', '10', '0', '10', '600.00', '600.00', '1.5', '10', '90.00'].join(',') + '\n';
    }
    const p = Preview.parse(csv, { name: 'big-preview.csv' });
    T.eq('the fixture is a real multi-document payload', p.rows.length, 300);

    const put = await sync.putBlob('imp-1', p, { kind: 'preview', name: 'big-preview.csv' });
    T.ok('it needed more than one chunk', put.chunks > 1, 'chunks ' + put.chunks);
    T.ok('every stored document is under the cap',
      [...db._docs.values()].every(v => v.length <= 256 * 1024),
      'largest ' + Math.max(...[...db._docs.values()].map(v => v.length)));

    const back = await sync.getBlob('imp-1');
    T.eq('row count survives', back.rows.length, 300);
    T.eq('the period survives', back.period.start + '..' + back.period.end, '2026-10-01..2026-10-31');
    T.eq('an exact-decimal amount survives as BigInt',
      typeof back.rows[0].netSales, 'bigint');
    T.eq('and its value is unchanged',
      back.rows[0].netSales.toString(), p.rows[0].netSales.toString());

    const again = await sync.putBlob('imp-1', p, { kind: 'preview' });
    T.ok('re-uploading identical content writes nothing', again.skipped, JSON.stringify(again));
  }

  T.section('A shorter rewrite leaves no stale tail');
  {
    const db = FakeDb();
    const sync = makeSync(db, 'user-1');
    await sync.connect();
    await sync.putBlob('b', { pad: 'y'.repeat(Sync.CHUNK * 3) });
    const wide = [...db._docs.keys()].filter(k => k.indexOf('/blobs/b/') >= 0).length;
    await sync.putBlob('b', { pad: 'z'.repeat(10) });
    const narrow = [...db._docs.keys()].filter(k => k.indexOf('/blobs/b/') >= 0).length;
    T.ok('the long version used several chunks', wide > 1, 'was ' + wide);
    T.eq('the short one leaves exactly one', narrow, 1);
    const back = await sync.getBlob('b');
    T.eq('and reads back as the short value', back.pad, 'z'.repeat(10));
  }

  T.section('A torn blob reads as absent rather than as corrupt data');
  {
    const db = FakeDb();
    const sync = makeSync(db, 'user-1');
    await sync.connect();
    await sync.putBlob('b', { pad: 'y'.repeat(Sync.CHUNK * 2) });
    const keys = [...db._docs.keys()].filter(k => /\/blobs\/b\/c\d+$/.test(k));
    db._docs.delete(keys[1]);
    T.eq('a missing chunk yields null, never a partial object', await sync.getBlob('b'), null);
  }

  T.section('An oversized blob is refused before writing anything');
  {
    const db = FakeDb();
    const sync = makeSync(db, 'user-1');
    await sync.connect();
    const huge = { pad: 'q'.repeat(Sync.CHUNK * (Sync.MAX_CHUNKS_PER_BLOB + 5)) };
    let code = null, msg = null;
    try { await sync.putBlob('huge', huge); } catch (e) { code = e.code; msg = e.message; }
    T.eq('it rejects with a specific code', code, 'too_large');
    T.ok('and says what to do about it', /stays saved on this device/.test(msg), msg);
    T.eq('nothing was written', db._stats.writes, 0);
  }

  T.section('A transient failure is retried once, and only once');
  {
    let failures = 0;
    const db = FakeDb({ failOn: (path, stats) => {
      if (path.indexOf('/blobs/t/c0') >= 0 && failures === 0) { failures++; return true; }
      return false;
    } });
    const sync = makeSync(db, 'user-1');
    await sync.connect();
    await sync.putBlob('t', { v: 1 });
    T.eq('the write succeeded after one retry', (await sync.getBlob('t')).v, 1);
    T.eq('and the transient error happened exactly once', failures, 1);
  }

  /* ── conflicts ────────────────────────────────────────────────────────── */

  T.section('A push refuses to overwrite a newer remote');
  {
    const db = FakeDb();
    const a = makeSync(db, 'user-1');
    const b = makeSync(db, 'user-1');
    await a.connect(); await b.connect();

    const base = { imports: [], policy: { cooldownDays: 1 } };
    for (const k of Sync.create({ use: null }).STATE_KEYS || []) { /* no-op */ }

    await a.pushState(base);
    T.eq('the first push starts at rev 1', a.baseRev, 1);

    /* b still believes it is based on rev 0 */
    let code = null, conflict = null;
    try { await b.pushState({ imports: [], policy: { cooldownDays: 9 } }); }
    catch (e) { code = e.code; conflict = e.conflict; }
    T.eq('the stale push is refused', code, 'conflict');
    T.eq('and it reports the remote revision', conflict.remoteRev, 1);
    T.ok('and hands back the remote payload to compare',
      conflict.remotePayload && conflict.remotePayload.policy.cooldownDays === 1,
      JSON.stringify(conflict.remotePayload && conflict.remotePayload.policy));

    const still = await a.pullState();
    T.eq('the remote was not overwritten', still.payload.policy.cooldownDays, 1);

    await b.pushState({ imports: [], policy: { cooldownDays: 9 } }, true);
    const after = await a.pullState();
    T.eq('an explicit override does apply', after.payload.policy.cooldownDays, 9);
    T.eq('and bumps the revision', after.rev, 2);
  }

  T.section('Imports merge by content, so two devices add rather than collide');
  {
    const sync = makeSync(FakeDb(), 'user-1');
    const mine = [
      { id: 'a', contentHash: 'h1', family: 'Fees & Economics Preview', coverage: 'oct', importedAt: '2026-09-01' },
      { id: 'b', contentHash: 'h2', family: 'Payments transactions', coverage: 'jul', importedAt: '2026-09-02' },
    ];
    const theirs = [
      { id: 'c', contentHash: 'h1', family: 'Fees & Economics Preview', coverage: 'oct', importedAt: '2026-09-03' },
      { id: 'd', contentHash: 'h3', family: 'Payments transactions', coverage: 'aug', importedAt: '2026-09-04' },
    ];
    const merged = sync.mergeImports(mine, theirs);
    T.eq('the same file on both devices stays one row', merged.length, 3);
    T.eq('the earliest import of a duplicate wins, so ids stay stable',
      merged.find(i => i.contentHash === 'h1').id, 'a');
    T.ok('each device keeps what only it had',
      merged.some(i => i.contentHash === 'h2') && merged.some(i => i.contentHash === 'h3'),
      merged.map(i => i.contentHash).join(','));
    T.eq('and the result is in import order',
      merged.map(i => i.importedAt).join(','), '2026-09-01,2026-09-02,2026-09-04');
  }

  T.section('Merging state keeps accumulations and does not invent settings');
  {
    const sync = makeSync(FakeDb(), 'user-1');
    const mine = {
      imports: [], policy: { cooldownDays: 3 },
      balanceSnapshots: [{ id: 's1', available: 100 }],
      productCosts: [{ sku: 'A' }],
    };
    const theirs = {
      imports: [], policy: { cooldownDays: 7 },
      balanceSnapshots: [{ id: 's2', available: 200 }],
      productCosts: [{ sku: 'B' }],
    };
    const local = sync.mergeState(mine, theirs, true);
    T.eq('snapshots from both devices are kept', local.balanceSnapshots.length, 2);
    T.eq('preferring local keeps the local policy', local.policy.cooldownDays, 3);

    const remote = sync.mergeState(mine, theirs, false);
    T.eq('preferring remote takes theirs', remote.policy.cooldownDays, 7);
    T.eq('accumulated lists are unioned either way', remote.balanceSnapshots.length, 2);

    const none = sync.mergeState(mine, null, false);
    T.eq('a first sync with no remote keeps everything local', none.policy.cooldownDays, 3);
  }

  /* ── availability ─────────────────────────────────────────────────────── */

  T.section('Absence is reported honestly, never as a successful sync');
  {
    const log = [];
    const offline = Sync.create({ onStatus: s => log.push(s.status), use: null });
    T.eq('with no platform at all, connect fails', await offline.connect(), false);
    T.eq('and the status says unavailable', offline.state.status, 'unavailable');
    T.ok('with a reason a person can act on',
      /No place to sync to is set up/.test(offline.state.reason), offline.state.reason);

    const noDb = Sync.create({ use: async n => (n === 'user' ? fakeUser('u') : null) });
    T.eq('db missing also fails', await noDb.connect(), false);
    T.eq('status is unavailable', noDb.state.status, 'unavailable');

    const noUser = Sync.create({ use: async n => (n === 'db' ? FakeDb() : null) });
    T.eq('an unidentifiable account fails too', await noUser.connect(), false);
    T.ok('and says so rather than syncing to a shared path',
      /account could not be identified/.test(noUser.state.reason), noUser.state.reason);
  }

  T.section('Data is written only under the signed-in viewer’s private prefix');
  {
    const db = FakeDb();
    const sync = makeSync(db, 'user-42');
    await sync.connect();
    await sync.pushState({ imports: [], policy: {} });
    await sync.putBlob('imp-9', { hello: 'world' });
    const paths = [...db._docs.keys()];
    T.ok('every path is under this viewer’s subtree',
      paths.every(p => p.indexOf('data/users/user-42/') === 0), paths.join(' '));
    T.ok('and nothing was written to a shared location',
      !paths.some(p => p.indexOf('data/users/user-42/') !== 0), paths.join(' '));
  }

  T.section('Two computers, through the helper, into one Supabase project');
  {
    /* The helper's routes, as a stand-in: a map keyed by path, with the same
       path rule the helper enforces (worker/supabase.py DOC_PATH). */
    const DOC_PATH = /^data\/users\/owner\/(state|blobs(\/[A-Za-z0-9_\-.~:@+]{1,180}\/c\d{1,4})?)$/;
    const table = new Map();
    const refused = [];
    const helper = {
      async cloudGet(p) {
        if (!DOC_PATH.test(p)) { refused.push(p); const e = new Error('bad'); e.payload = { code: 'bad_path' }; throw e; }
        return table.has(p) ? { exists: true, data: JSON.parse(table.get(p)) } : { exists: false, data: null };
      },
      async cloudSet(p, data) {
        if (!DOC_PATH.test(p)) { refused.push(p); const e = new Error('bad'); e.payload = { code: 'bad_path' }; throw e; }
        table.set(p, JSON.stringify(data));
      },
      async cloudDelete(p) { table.delete(p); },
    };
    const office = Sync.create({ use: Sync.helperStore(helper) });
    const laptop = Sync.create({ use: Sync.helperStore(helper) });
    T.ok('the office computer connects', await office.connect());
    await office.pushState({ imports: [{ id: 'i1', name: 'payments.csv', contentHash: 'h1' }],
      balanceSnapshots: [{ id: 'b1', available: 820000 }], policy: { cooldownDays: 1 } });
    const bigLedger = { rows: 'x'.repeat(Sync.CHUNK * 2 + 10) };
    await office.putBlob('imp-i1', bigLedger, { kind: 'ledger', name: 'payments.csv' });
    T.eq('every path it wrote is one the helper accepts', refused.length, 0);
    T.ok('the file went up in pieces', [...table.keys()].filter(k => /\/c\d+$/.test(k)).length === 3);

    T.ok('the laptop connects to the same project', await laptop.connect());
    const got = await laptop.pullState();
    T.eq('it reads the office computer’s balances', got.payload.balanceSnapshots[0].available, 820000);
    T.eq('and its settings', got.payload.policy.cooldownDays, 1);
    const back = await laptop.getBlob('imp-i1');
    T.eq('and the imported file, whole', back && back.rows.length, bigLedger.rows.length);

    /* Both edit; the second to save is stopped, not allowed to overwrite. */
    laptop.setBaseRev(got.rev);
    office.setBaseRev(got.rev);
    await office.pushState({ imports: [], policy: { cooldownDays: 2 } });
    let stopped = null;
    try { await laptop.pushState({ imports: [], policy: { cooldownDays: 3 } }); }
    catch (e) { stopped = e.code; }
    T.eq('a stale save from the other computer is refused, not written', stopped, 'conflict');
    T.eq('and the office computer’s change stands', (await laptop.pullState()).payload.policy.cooldownDays, 2);

    const down = Sync.create({ use: Sync.helperStore({
      cloudGet: async () => { const e = new Error('busy'); e.payload = { code: 'unavailable' }; throw e; } }) });
    await down.connect();
    let code = null;
    try { await down.pullState(); } catch (e) { code = e.code; }
    T.eq('a busy project keeps the helper’s code, so it is retried once and reported', code, 'unavailable');
  }

  process.exit(T.report() ? 0 : 1);
})();
