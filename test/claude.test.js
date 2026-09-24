/* Ask Claude, against a stand-in for Anthropic's API.
   No real key and no real request: the official SDK is pointed at a local
   server that records what it was sent and answers the way the API does.
   Nothing here spends anybody's credit. */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./harness.js');
const C = require('../desktop/claude.js');

const GOOD = 'sk-ant-api03-' + 'a'.repeat(60) + 'WXYZ';
const sdk = C.loadSdk();

/* A reversible stand-in for safeStorage: enough to prove the file never
   holds the key as typed. */
const fakeCrypto = (on = true) => ({
  available: () => on,
  encrypt: s => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
  decrypt: b => {
    const t = Buffer.from(b).toString();
    if (!t.startsWith('ENC:')) throw new Error('not ours');
    return Buffer.from(t.slice(4), 'hex').toString();
  },
});

const seen = [];
let mode = 'ok';
const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'req_test' });
  for (const [name, data] of events) res.write('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n');
  res.end();
};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const key = req.headers['x-api-key'];
    if (key !== GOOD) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    }
    if (req.method === 'GET' && req.url.startsWith('/v1/models/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ type: 'model', id: C.MODEL, display_name: 'Claude Opus 5', created_at: '2026-01-01T00:00:00Z' }));
    }
    if (req.method === 'POST' && req.url.startsWith('/v1/messages')) {
      if (mode === 'credit') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'Your credit balance is too low to access the Anthropic API.' } }));
      }
      const start = { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
        model: C.MODEL, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5210, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 4800 } } };
      if (mode === 'refusal') {
        return sse(res, [['message_start', start],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null,
            stop_details: { type: 'refusal', category: null, explanation: 'Policy.' } }, usage: { output_tokens: 1 } }],
          ['message_stop', { type: 'message_stop' }]]);
      }
      return sse(res, [
        ['message_start', start],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'You can request ' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '$8,200.00 today.' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 380 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    res.writeHead(404); res.end();
  });
});

(async () => {
  if (!sdk) { T.notTested('Ask Claude', 'the @anthropic-ai/sdk package is not installed'); T.report(); process.exit(0); }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const opts = { baseURL: 'http://127.0.0.1:' + server.address().port, maxRetries: 0 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askclaude-'));
  const store = C.keyStore({ file: path.join(dir, 'claude.json'), crypto: fakeCrypto() });

  T.section('What counts as an Anthropic key');
  T.ok('a real-shaped key passes', C.checkKey(GOOD) === null);
  T.ok('blank is refused', !!C.checkKey(''));
  T.ok('a Supabase key is named as one', /Supabase/.test(C.checkKey('sb_secret_' + 'x'.repeat(40))));
  T.ok('something else is refused', /sk-ant-/.test(C.checkKey('hello-there-this-is-not-a-key-at-all-000000')));
  T.ok('half a key is refused', /too short/.test(C.checkKey('sk-ant-api03-abc')));

  T.section('Connecting a key');
  const bad = await C.connect(store, 'sk-ant-api03-' + 'b'.repeat(60), sdk, opts);
  T.ok('a key Anthropic refuses is not saved', bad.ok === false && !fs.existsSync(store.file));
  T.ok('and the reason is plain', bad.code === 'auth' && /refused this API key/.test(bad.error));
  const noEnc = C.keyStore({ file: path.join(dir, 'x.json'), crypto: fakeCrypto(false) });
  const plain = await C.connect(noEnc, GOOD, sdk, opts);
  T.ok('with no way to encrypt, nothing is written', plain.ok === false && !fs.existsSync(noEnc.file));
  seen.length = 0;
  const good = await C.connect(store, GOOD, sdk, opts);
  T.ok('a key Anthropic accepts is saved', good.ok === true && good.connected === true);
  T.ok('checked with a call that costs nothing', seen.length === 1 && seen[0].method === 'GET'
    && seen[0].url.startsWith('/v1/models/' + C.MODEL));
  T.ok('it says credit is not proven yet', /first question/.test(good.detail));
  const onDisk = fs.readFileSync(store.file, 'utf8');
  T.ok('the file does not hold the key as typed', !onDisk.includes(GOOD) && !onDisk.includes('a'.repeat(60)));
  T.ok('nothing handed back contains the key', !JSON.stringify(good).includes(GOOD)
    && !JSON.stringify(C.status(store, sdk)).includes(GOOD));
  T.eq('only a hint of it', C.status(store, sdk).keyHint, 'sk-ant-…WXYZ');
  const other = C.keyStore({ file: store.file, crypto: Object.assign(fakeCrypto(), { decrypt: () => { throw new Error('other account'); } }) });
  T.ok('a file that will not decrypt reads as not connected', C.status(other, sdk).connected === false);

  T.section('Asking');
  seen.length = 0;
  const partial = [];
  const r = await C.ask(store, { brief: 'ELIGIBLE TO REQUEST: $8,200.00', question: 'How much can I request?',
    history: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello.' }] }, sdk, t => partial.push(t), opts);
  T.ok('an answer comes back', r.ok === true && r.text === 'You can request $8,200.00 today.');
  T.ok('and streams as it arrives', partial.length >= 2 && partial[0] === 'You can request ');
  T.eq('usage is reported', r.usage.input + '/' + r.usage.output, '5210/380');
  const sent = seen.find(s => s.method === 'POST');
  T.eq('the model is Opus 5', sent.body.model, 'claude-opus-5');
  T.eq('refusal fallbacks are on, by category', sent.body.fallbacks, 'default');
  T.ok('with their beta header', String(sent.headers['anthropic-beta'] || '').includes('server-side-fallback-2026-07-01'));
  T.eq('thinking is adaptive', sent.body.thinking && sent.body.thinking.type, 'adaptive');
  T.ok('it streams', sent.body.stream === true);
  T.ok('the rules come first, then the figures', sent.body.system[0].text === C.ASK_SYSTEM
    && sent.body.system[1].text.includes('ELIGIBLE TO REQUEST: $8,200.00'));
  T.ok('the rules forbid inventing figures', /Use ONLY numbers that appear in the BRIEF/.test(C.ASK_SYSTEM));
  T.ok('the prefix is cached', sent.body.cache_control && sent.body.cache_control.type === 'ephemeral');
  T.eq('earlier turns go back in order, then the question',
    sent.body.messages.map(m => m.role).join(','), 'user,assistant,user');
  T.eq('the key travels only as the API key header', sent.headers['x-api-key'], GOOD);

  mode = 'refusal';
  const ref = await C.ask(store, { brief: 'x', question: 'q' }, sdk, null, opts);
  T.ok('a refusal is said, not shown as an empty answer', ref.ok === false && ref.code === 'refusal');
  mode = 'credit';
  const cr = await C.ask(store, { brief: 'x', question: 'q' }, sdk, null, opts);
  T.ok('no credit: Anthropic’s own words come through', cr.ok === false && /credit balance is too low/.test(cr.error));
  mode = 'ok';
  const noBrief = await C.ask(store, { brief: '', question: 'q' }, sdk, null, opts);
  T.ok('without the figures, nothing is sent', noBrief.ok === false && noBrief.code === 'brief');
  const long = await C.ask(store, { brief: 'x', question: 'q'.repeat(5000) }, sdk, null, opts);
  T.ok('an over-long question is refused before sending', long.code === 'too_long');

  T.section('The conversation sent back is always valid');
  T.eq('it starts with the person, alternates, and ends before the new question',
    C.historyOf([{ role: 'assistant', text: 'stray' }, { role: 'user', text: 'a' }, { role: 'user', text: 'b' },
      { role: 'assistant', text: 'c' }, { role: 'user', text: 'unanswered' }]).map(m => m.role + ':' + m.content).join(' '),
    'user:b assistant:c');
  T.ok('it is capped', C.historyOf(Array.from({ length: 80 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 't' + i })))
    .length <= C.LIMITS.turns * 2);

  T.section('Disconnecting');
  T.ok('forgetting removes the file', store.forget() && !fs.existsSync(store.file));
  const after = await C.ask(store, { brief: 'x', question: 'q' }, sdk, null, opts);
  T.ok('and nothing can be asked until a key is connected again', after.code === 'not_connected');

  server.close();
  process.exit(T.report() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
