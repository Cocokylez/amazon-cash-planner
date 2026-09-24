/* Ask Claude, from the desktop shell.
 *
 * The page never holds the API key. It is pasted once, checked against
 * Anthropic, encrypted for this Windows account (Electron's safeStorage,
 * which is DPAPI on Windows) and kept beside the helper's other settings.
 * The page can ask a question and be told whether a key is connected; it
 * cannot read the key back, and neither can anything it loads.
 *
 * No Electron in here, so every path - a refused key, a refusal, a network
 * failure - is tested against a stand-in server without a window or a real
 * key, and without spending anybody's credit.
 *
 * The rules Claude answers by live here too, not in the page: whatever asks,
 * the answer is built from the figures the app hands over and nothing else.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* The model, and the refusal fallback beside it. "default" lets Anthropic
   route a declined request to the right substitute by category, rather than
   this file pinning a model that will one day be retired. */
const MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const LIMITS = {
  brief: 200000,        // characters - the whole brief is a few thousand
  question: 4000,
  turns: 12,            // earlier question/answer pairs sent back as context
  turnText: 8000,
};

const ASK_SYSTEM =
  'You explain an Amazon cash-planning app to its owner. You are given a BRIEF containing '
  + 'every figure the application has computed, plus the inputs it is missing.\n\n'
  + 'Rules you must follow:\n'
  + '1. Use ONLY numbers that appear in the BRIEF. Never calculate a new figure, never '
  + 'estimate, never fill a gap with a plausible number.\n'
  + '2. If the BRIEF says a value is UNAVAILABLE or NOT VERIFIED, say so plainly and name the '
  + 'input needed. Do not guess around it.\n'
  + '3. Name the origin of figures you cite (actual, current, Amazon forecast, model forecast, '
  + 'assumption) and point to where in the app they come from.\n'
  + '4. Requesting a payout early moves cash forward. It never creates revenue, never releases '
  + 'deferred funds sooner, and never changes profit. Do not imply otherwise.\n'
  + '5. Be concise and concrete. Plain language, no hedging filler.\n'
  + 'Latency-sensitive; begin your visible answer immediately.';

/* ── the key ─────────────────────────────────────────────────────────── */

/* Shape only - whether it WORKS is asked of Anthropic. Catches the paste
   of something else entirely (a Supabase key, half a key, a sentence). */
function checkKey(key) {
  const k = String(key || '').trim();
  if (!k) return 'Paste your Anthropic API key.';
  if (/\s/.test(k)) return 'That has spaces in it - copy the key again, on its own.';
  if (/^sb_(secret|publishable)_/.test(k)) {
    return 'That is a Supabase key. This needs an Anthropic API key, which starts with sk-ant-.';
  }
  if (!/^sk-ant-/.test(k)) return 'An Anthropic API key starts with sk-ant-. That does not.';
  if (k.length < 40) return 'That key is too short - it may have been cut off when copied.';
  return null;
}

const hintOf = k => 'sk-ant-…' + String(k).slice(-4);

/* Where the key lives, encrypted. `crypto` is Electron's safeStorage in the
   app ({ available, encrypt, decrypt }) and a stand-in in tests. A computer
   that cannot encrypt does not get a plain-text key written instead: the key
   spends money, and a copy readable by anything that finds the file is not a
   trade to make quietly. */
function keyStore({ file, crypto }) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  };
  return {
    file,
    canEncrypt() {
      try { return !!crypto.available(); } catch (e) { return false; }
    },
    save(key) {
      if (!this.canEncrypt()) {
        return { ok: false, error: 'This computer cannot encrypt the key for your account, '
          + 'so it was not saved. Nothing was written.' };
      }
      const box = crypto.encrypt(String(key));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        v: 1, key: Buffer.from(box).toString('base64'), hint: hintOf(key),
        savedAt: new Date().toISOString(),
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      return { ok: true };
    },
    /* The key, or null. A file copied from another account or computer will
       not decrypt - that reads as "not connected", never as a broken key. */
    load() {
      const raw = read();
      if (!raw || !raw.key) return null;
      try {
        const k = crypto.decrypt(Buffer.from(raw.key, 'base64'));
        return checkKey(k) ? null : k;
      } catch (e) { return null; }
    },
    meta() {
      const raw = read();
      return raw && raw.key ? { hint: raw.hint || null, savedAt: raw.savedAt || null } : null;
    },
    forget() {
      try { fs.unlinkSync(file); return true; } catch (e) { return false; }
    },
  };
}

/* ── talking to Anthropic ───────────────────────────────────────────── */

function loadSdk() {
  try {
    const mod = require('@anthropic-ai/sdk');
    const Anthropic = mod.default || mod;
    let version = null;
    try { version = require('@anthropic-ai/sdk/version').VERSION; } catch (e) { /* optional */ }
    return { Anthropic, version };
  } catch (e) {
    return null;
  }
}

function client(sdk, key, opts) {
  return new sdk.Anthropic(Object.assign({
    apiKey: key,
    timeout: 120 * 1000,
    maxRetries: 2,
  }, opts || {}));
}

const scrub = s => String(s == null ? '' : s)
  .replace(/sk-ant-[A-Za-z0-9_\-]+/g, 'sk-ant-<redacted>').slice(0, 400);

/* What went wrong, in words someone can act on. The SDK's typed errors,
   most specific first - never a match on the message text. */
function explain(sdk, e) {
  const A = sdk.Anthropic;
  const said = () => {
    const inner = e && e.error && e.error.error && e.error.error.message;
    return scrub(inner || (e && e.message) || '');
  };
  if (A.AuthenticationError && e instanceof A.AuthenticationError) {
    return { code: 'auth', error: 'Anthropic refused this API key. It may have been revoked or '
      + 'mistyped - create a new one in the Anthropic Console and connect it again.' };
  }
  if (A.PermissionDeniedError && e instanceof A.PermissionDeniedError) {
    return { code: 'permission', error: 'This API key is not allowed to use ' + MODEL
      + '. Anthropic said: ' + said() };
  }
  if (A.NotFoundError && e instanceof A.NotFoundError) {
    return { code: 'not_found', error: 'Anthropic does not recognise the model ' + MODEL
      + ' for this key. Anthropic said: ' + said() };
  }
  if (A.RateLimitError && e instanceof A.RateLimitError) {
    return { code: 'rate_limited', error: 'Too many questions at once for this key. Wait a '
      + 'minute and ask again.' };
  }
  if (A.BadRequestError && e instanceof A.BadRequestError) {
    /* This is where "your credit balance is too low" arrives - Anthropic's
       own words are the most useful thing to show. */
    return { code: 'bad_request', error: 'Anthropic could not take this request: ' + said() };
  }
  if (A.APIConnectionTimeoutError && e instanceof A.APIConnectionTimeoutError) {
    return { code: 'timeout', error: 'Anthropic did not answer in time. Nothing was charged '
      + 'for an answer you did not get - try again.' };
  }
  if (A.APIConnectionError && e instanceof A.APIConnectionError) {
    return { code: 'offline', error: 'Could not reach Anthropic. Check the internet '
      + 'connection and ask again.' };
  }
  if (A.APIError && e instanceof A.APIError) {
    return { code: 'api', error: 'Anthropic had a problem (' + (e.status || 'no status')
      + '). Try again shortly. ' + said() };
  }
  return { code: 'unknown', error: 'The question could not be sent: ' + scrub(e && e.message) };
}

/* Check the key with a call that costs nothing: reading the model's own
   description. It proves the key is accepted - not that the account has
   credit, which only the first question can show, and the result says so. */
async function connect(store, key, sdk, clientOpts) {
  if (!sdk) return { ok: false, code: 'no_sdk', error: 'This copy of the app is missing the '
    + 'Anthropic library. Update the app, then try again.' };
  const problem = checkKey(key);
  if (problem) return { ok: false, code: 'shape', error: problem };
  const k = String(key).trim();
  if (!store.canEncrypt()) {
    return { ok: false, code: 'no_encryption', error: 'This computer cannot encrypt the key '
      + 'for your account, so it was not saved. Nothing was written.' };
  }
  try {
    await client(sdk, k, clientOpts).models.retrieve(MODEL);
  } catch (e) {
    return Object.assign({ ok: false }, explain(sdk, e));
  }
  const saved = store.save(k);
  if (!saved.ok) return Object.assign({ ok: false, code: 'save' }, saved);
  return Object.assign({ ok: true, detail: 'Anthropic accepted the key. Whether your account '
    + 'has credit shows on the first question.' }, status(store, sdk));
}

function status(store, sdk) {
  const meta = store.meta();
  return {
    sdk: !!sdk, sdkVersion: sdk ? sdk.version : null,
    connected: !!(meta && store.load()),
    keyHint: meta ? meta.hint : null,
    savedAt: meta ? meta.savedAt : null,
    encrypted: store.canEncrypt(),
    model: MODEL,
    fallbacks: 'default',
  };
}

/* The earlier conversation, as plain text turns, trimmed to the limits.
   Anything that is not a clean alternation is dropped rather than repaired:
   the API wants user first and turns alternating, and a half-finished turn
   (an answer that failed) is not context worth paying for. */
function historyOf(turns) {
  const clean = [];
  for (const t of Array.isArray(turns) ? turns : []) {
    const role = t && t.role === 'assistant' ? 'assistant' : t && t.role === 'user' ? 'user' : null;
    const text = String((t && t.text) || '').trim().slice(0, LIMITS.turnText);
    if (!role || !text) continue;
    if (clean.length && clean[clean.length - 1].role === role) clean.pop();
    clean.push({ role, content: text });
  }
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (clean.length && clean[clean.length - 1].role === 'user') clean.pop();
  return clean.slice(-LIMITS.turns * 2);
}

/* One question. `onText` receives the answer so far, as it arrives.
   Resolves { ok, text, stopReason, model, fellBack, usage } or
   { ok: false, code, error } - never throws. */
async function ask(store, req, sdk, onText, clientOpts) {
  if (!sdk) return { ok: false, code: 'no_sdk', error: 'This copy of the app is missing the '
    + 'Anthropic library. Update the app, then try again.' };
  const key = store.load();
  if (!key) return { ok: false, code: 'not_connected', error: 'Connect an Anthropic API key first.' };
  const brief = String((req && req.brief) || '');
  const question = String((req && req.question) || '').trim();
  if (!question) return { ok: false, code: 'empty', error: 'Ask a question first.' };
  if (question.length > LIMITS.question) {
    return { ok: false, code: 'too_long', error: 'That question is longer than '
      + LIMITS.question + ' characters. Shorten it and ask again.' };
  }
  if (!brief || brief.length > LIMITS.brief) {
    return { ok: false, code: 'brief', error: 'The app’s figures could not be attached, so '
      + 'nothing was sent - an answer without them would be a guess.' };
  }

  const messages = historyOf(req.history).concat([{ role: 'user', content: question }]);
  try {
    const stream = client(sdk, key, clientOpts).beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      /* The rules, then the figures. Stable first, so repeated questions
         about the same data read the prefix from cache. */
      system: [
        { type: 'text', text: ASK_SYSTEM },
        { type: 'text', text: '=== BRIEF ===\n' + brief + '\n=== END BRIEF ===' },
      ],
      cache_control: { type: 'ephemeral' },
      messages,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
    if (typeof onText === 'function') {
      stream.on('text', (_delta, snapshot) => { try { onText(snapshot); } catch (e) { /* page gone */ } });
    }
    const msg = await stream.finalMessage();
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const fellBack = ((msg.usage && msg.usage.iterations) || [])
      .some(it => it && it.type === 'fallback_message');
    const u = msg.usage || {};
    const usage = {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
    };
    if (msg.stop_reason === 'refusal') {
      return { ok: false, code: 'refusal', usage, error: 'Claude declined to answer this one'
        + (msg.stop_details && msg.stop_details.explanation
          ? ': ' + scrub(msg.stop_details.explanation) : '.') + ' Try asking it differently.' };
    }
    return {
      ok: true, text, model: msg.model || MODEL, stopReason: msg.stop_reason, fellBack, usage,
      truncated: msg.stop_reason === 'max_tokens',
    };
  } catch (e) {
    return Object.assign({ ok: false }, explain(sdk, e));
  }
}

module.exports = { MODEL, FALLBACK_BETA, LIMITS, ASK_SYSTEM, checkKey, keyStore, loadSdk,
  connect, status, ask, historyOf, explain };
