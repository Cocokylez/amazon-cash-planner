"""Push parsed Amazon data into the artifact's own storage.

WHY THIS IS A BROWSER AND NOT AN HTTP CALL

A published artifact has no outbound network — measured, not assumed: fetches
to three unrelated public HTTPS endpoints all failed in under a millisecond,
which is a Content Security Policy refusal. It also cannot be reached at
http://127.0.0.1, because browsers block an HTTPS page from calling localhost.
And the artifact's data store has no public REST API, so nothing on this
computer can write to it directly.

What the store DOES have is `window.claude.use("db")`, available to the page
itself. So this opens the artifact in a real browser that is signed in as you,
and asks the page to write the data. Your account, your artifact, your data,
your browser — nothing here impersonates anyone or touches another account.

WHAT THIS COSTS IN ROBUSTNESS

It depends on the artifact page loading and exposing `window.claude`. That is a
documented, versioned interface, but it is still someone else's page: a change
there could break this push. Your data is never at risk from that — it stays on
disk and in the local app — only the automatic step would stop, and the backup
file remains as a manual route.

NO PASSWORD IS HANDLED HERE. If the browser is not signed in, this stops and
asks you to sign in yourself, in the window it opened.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Callable

LOGIN_MARKERS = ("/login", "/magic-link", "signin", "sign-in", "auth0", "oauth")

# The artifact renders inside a sandboxed frame on a different origin, so the
# page holding `window.claude` is a CHILD frame, not the top document.
FRAME_HINTS = ("claudeusercontent.com", "artifacts", "/artifact/")


def _looks_like_login(url: str) -> bool:
    u = (url or "").lower()
    if "claude.ai" not in u:
        return False
    return any(m in u for m in LOGIN_MARKERS)


def find_artifact_frame(page, timeout_s: int = 45):
    """The frame that has window.claude. Identified by asking, not by guessing
    which frame looks right — a page can have several."""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        for fr in page.frames:
            try:
                has = fr.evaluate(
                    "() => !!(window.claude && typeof window.claude.use === 'function')")
            except Exception:
                continue
            if has:
                return fr
        page.wait_for_timeout(1000)
    return None


PUSH_JS = """
async (payload) => {
  const out = { ok: false };
  try {
    const db = await window.claude.use('db');
    const user = await window.claude.use('user');
    if (!db) { out.reason = 'The artifact did not grant its data store.'; return out; }
    const uid = user ? await user.id() : null;
    if (!uid) { out.reason = 'The viewer could not be identified.'; return out; }

    /* One document, replaced whole. The artifact reads this on load and
       merges it into the same shared dataset a manual import produces, so
       there is one code path for figures however they arrived. */
    const doc = db.doc('data/users/' + uid + '/bridge');
    await doc.set(payload);

    /* Read back: a write that was not confirmed is not a push. */
    const back = await doc.get();
    out.ok = !!(back.exists && back.data()
      && back.data().pushedAt === payload.pushedAt);
    if (!out.ok) out.reason = 'The write completed but read back something else.';
    out.uid = uid;
  } catch (e) {
    out.reason = (e && e.message) ? e.message : String(e);
  }
  return out;
};
"""


def push_dataset(
    artifact_url: str,
    dataset: dict,
    profile_dir: Path,
    progress: Callable[[str, str], None],
    headless: bool = False,
) -> dict:
    """Returns {'ok': True, ...} or {'loginRequired': True} or raises."""
    from playwright.sync_api import sync_playwright

    if not artifact_url or "claude.ai" not in artifact_url:
        raise RuntimeError(
            "No artifact address is configured. Paste your artifact link into "
            "the local app first.")

    profile_dir.mkdir(parents=True, exist_ok=True)

    payload = dict(dataset or {})
    payload["pushedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    payload["source"] = "desktop-bridge"

    size = len(json.dumps(payload))
    # The store caps a document at 256 KiB. Rather than fail at the last step,
    # say so before opening a browser.
    if size > 240 * 1024:
        raise RuntimeError(
            "This dataset is %d KB, which is past the %d KB an artifact "
            "document can hold. The summary is pushed instead of every row; "
            "if you are seeing this, the summary itself has grown too large."
            % (size // 1024, 240))

    with sync_playwright() as pw:
        try:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=headless,
                viewport={"width": 1280, "height": 900},
            )
        except Exception as exc:
            raise RuntimeError(
                "The browser could not be opened for the push: %s" % exc) from exc

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        keep_open = False
        try:
            progress("pushing", "Opening your artifact.")
            page.goto(artifact_url, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(2500)

            if _looks_like_login(page.url):
                keep_open = True
                progress("login-required",
                         "Sign in to Claude in the window that opened, then "
                         "press Retry. Nothing was sent.")
                return {"loginRequired": True, "where": "claude"}

            progress("pushing", "Waiting for the artifact to load.")
            frame = find_artifact_frame(page)
            if frame is None:
                # Being signed out often presents as a page that simply never
                # renders the artifact, so say both possibilities.
                keep_open = True
                return {
                    "loginRequired": True, "where": "claude",
                    "note": "The artifact never exposed its data interface. "
                            "That usually means this browser is not signed in "
                            "to Claude. Sign in in the open window, then Retry.",
                }

            progress("pushing", "Writing %d KB into the artifact." % (size // 1024))
            result = frame.evaluate(PUSH_JS, payload)

            if not result.get("ok"):
                raise RuntimeError(
                    "The artifact refused the write: %s"
                    % result.get("reason", "no reason given"))

            progress("pushing", "Confirmed.")
            return {
                "ok": True,
                "bytes": size,
                "pushedAt": payload["pushedAt"],
                "artifact": artifact_url,
            }
        finally:
            if not keep_open:
                try:
                    ctx.close()
                except Exception:
                    pass
