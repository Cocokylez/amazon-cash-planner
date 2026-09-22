"""In-app report setup, so daily use never touches a terminal.

Recording what a report page actually looks like still needs a human to point
at the controls once — Amazon's pages differ by account and marketplace and
change over time, and a guessed selector eventually downloads the wrong report
quietly. What this removes is the *terminal*: the browser opens, the app shows
the prompts, and the clicks happen in the Amazon window.

TWO THINGS THIS FIXES FROM THE FIRST VERSION

1. The URL that gets SAVED is the one navigation actually landed on, read from
   the page after it settles. Saving the starting link meant a redirect (or a
   moved page) was baked in for ever.
2. The page is validated before anything is recorded. A "not found" page used
   to be recorded as though it were the report page.

Playwright's sync API is single-threaded, so the session lives in its own
thread and the HTTP handlers talk to it through a command queue.
"""

from __future__ import annotations

import queue
import threading
import time
from pathlib import Path
from typing import Any

# Login detection, "not found" detection and the launch-error explanation all
# live with the automation, so there is one implementation of each.
import seller_central as SC


PICKER_JS = r"""
() => new Promise(resolve => {
  const prev = document.body.style.cursor;
  document.body.style.cursor = 'crosshair';
  const hi = document.createElement('div');
  hi.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
    'border:2px solid #0F766E;background:rgba(15,118,110,.12);border-radius:3px';
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
    'left:12px;top:12px;background:#0F766E;color:#fff;padding:8px 12px;' +
    'border-radius:6px;font:600 14px system-ui;max-width:60vw';
  tip.textContent = window.__acpPrompt || 'Click the control the app asked for';
  document.body.appendChild(hi); document.body.appendChild(tip);
  const move = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const r = el.getBoundingClientRect();
    hi.style.left = r.left + 'px'; hi.style.top = r.top + 'px';
    hi.style.width = r.width + 'px'; hi.style.height = r.height + 'px';
  };
  const cssPath = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const bits = [];
    while (el && el.nodeType === 1 && bits.length < 6) {
      let part = el.tagName.toLowerCase();
      const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (dt) { bits.unshift(part + '[data-testid="' + dt + '"]'); break; }
      const nm = el.getAttribute('name');
      if (nm) part += '[name="' + nm + '"]';
      else if (el.classList.length) {
        const c = [...el.classList].filter(x => !/\d/.test(x))[0];
        if (c) part += '.' + CSS.escape(c);
      }
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter(x => x.tagName === el.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      bits.unshift(part);
      if (el.id) { bits[0] = '#' + CSS.escape(el.id); break; }
      el = parent;
    }
    return bits.join(' > ');
  };
  const click = e => {
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    hi.remove(); tip.remove(); document.body.style.cursor = prev;
    /* A row is recorded as a REPEATING selector, not this one row: the list
       has many and we must be able to look at all of them. */
    const tag = el.tagName.toLowerCase();
    resolve({
      selector: cssPath(el),
      generic: cssPath(el).replace(/:nth-of-type\(\d+\)/g, ''),
      tag,
      isSelect: tag === 'select',
      type: el.getAttribute('type') || null,
      text: (el.innerText || el.value || '').slice(0, 80),
    });
  };
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
})
"""


GROUP_JS = r"""
(args) => {
  /* Given ONE tick box the person clicked, find the block that holds the whole
     group of them.

     Asking someone to click "the container" is asking them to read the DOM.
     They click a box they can see; this walks up from it to the smallest
     ancestor that holds at least `min` boxes, which is the visual group. The
     walk stops at <form> or <body> so it can never widen to the whole page. */
  const el = document.querySelector(args.selector);
  if (!el) return { ok: false, reason: 'that element is no longer on the page' };

  const countIn = n => n.querySelectorAll(
    'input[type=checkbox], [role=checkbox]').length;

  const cssPath = el => {
    if (el.id) return '#' + CSS.escape(el.id);
    const bits = [];
    while (el && el.nodeType === 1 && bits.length < 8) {
      let part = el.tagName.toLowerCase();
      const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (dt) { bits.unshift(part + '[data-testid="' + dt + '"]'); break; }
      const nm = el.getAttribute('name');
      if (nm) part += '[name="' + nm + '"]';
      else if (el.classList.length) {
        const c = [...el.classList].filter(x => !/\d/.test(x))[0];
        if (c) part += '.' + CSS.escape(c);
      }
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter(x => x.tagName === el.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      bits.unshift(part);
      if (el.id) { bits[0] = '#' + CSS.escape(el.id); break; }
      el = parent;
    }
    return bits.join(' > ');
  };

  let node = el, hops = 0;
  while (node && hops < 12) {
    if (node.tagName === 'BODY') break;
    if (countIn(node) >= args.min) {
      const sel = cssPath(node);
      /* A path is only useful if it finds this same block again, and only this
         one. Verified here rather than discovered to be wrong at 6am. */
      let found = [];
      try { found = [...document.querySelectorAll(sel)]; } catch (e) {
        return { ok: false, reason: 'the address for that block is not valid CSS' };
      }
      if (found.length !== 1 || found[0] !== node) {
        node = node.parentElement; hops++; continue;
      }
      return { ok: true, selector: sel, count: countIn(node),
               text: (node.innerText || '').slice(0, 160) };
    }
    if (node.tagName === 'FORM') break;
    node = node.parentElement; hops++;
  }
  return { ok: false, count: countIn(el.closest('form') || document.body),
           reason: 'no block around that box held at least ' + args.min +
                   ' tick boxes' };
}
"""


class SetupSession:
    """One report's setup, driven from the app."""

    def __init__(self, report_type: str, url: str, profile_dir: Path,
                 spec: dict | None = None, chrome_profile: str | None = None) -> None:
        self.report_type = report_type
        self.url = url
        self.profile_dir = profile_dir
        self.spec = spec or {}
        self.chrome_profile = chrome_profile

        self.state: dict[str, Any] = {
            "reportType": report_type,
            "phase": "starting",
            "prompt": "Opening a browser window…",
            "hint": None,
            "recorded": [],
            "needsLogin": False,
            "error": None,
            "done": False,
        }
        self._lock = threading.Lock()
        self._cmds: "queue.Queue[tuple[str, Any]]" = queue.Queue()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # -- called from HTTP handlers ----------------------------------------

    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def send(self, cmd: str, value: Any = None) -> None:
        self._cmds.put((cmd, value))

    def cancel(self) -> None:
        self._cmds.put(("cancel", None))

    # -- internals ---------------------------------------------------------

    def _set(self, **fields) -> None:
        with self._lock:
            self.state.update(fields)

    def _wait(self, timeout: float = 1800.0):
        try:
            return self._cmds.get(timeout=timeout)
        except queue.Empty:
            return ("cancel", None)

    def _run(self) -> None:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            self._set(phase="error", done=True,
                      error="Playwright is not installed in the worker.")
            return

        recorded: dict[str, Any] = {}

        # If a Chrome profile was chosen, copy its signed-in session into the
        # helper's profile so Amazon does not ask for a fresh login. A plain
        # copy only succeeds while Chrome is closed, so a lock is reported
        # rather than worked around.
        if self.chrome_profile:
            try:
                import chrome_profiles as CP
                if CP.chrome_running():
                    self._set(phase="close-chrome", needsLogin=False,
                              prompt="Close ALL Chrome windows, then choose "
                                     "Continue.",
                              hint="Your chosen profile (%s) is locked while "
                                   "Chrome is open, so its signed-in session "
                                   "cannot be copied. You can reopen Chrome "
                                   "straight after." % self.chrome_profile)
                    cmd, _ = self._wait()
                    if cmd == "cancel":
                        self._set(phase="cancelled", done=True); return
                rep = CP.clone_profile(self.chrome_profile, self.profile_dir)
                self._set(cloneReport=rep)
                if not rep.get("cookiesCopied"):
                    # Not fatal: they can still sign in in the helper window.
                    self._set(cloneWarning=rep.get("note"))
            except Exception as exc:
                self._set(cloneWarning="Could not use the Chrome profile: %s. "
                          "You can still sign in in the helper window." % exc)

        try:
            with sync_playwright() as pw:
                try:
                    ctx = pw.chromium.launch_persistent_context(
                        user_data_dir=str(self.profile_dir), headless=False,
                        args=SC.profile_args(self.profile_dir),
                        accept_downloads=True,
                        viewport={"width": 1400, "height": 950})
                except Exception as exc:
                    self._set(phase="error", done=True,
                              error=SC.explain_launch_error(exc))
                    return

                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                page.goto(self.url, wait_until="domcontentloaded", timeout=90_000)

                # ---- login ------------------------------------------------
                while SC.looks_like_login(page.url):
                    self._set(phase="login", needsLogin=True,
                              prompt="Sign in to Amazon in the browser window "
                                     "that just opened.",
                              hint="Then choose Continue here.")
                    cmd, _ = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    page.goto(self.url, wait_until="domcontentloaded",
                              timeout=90_000)

                # ---- validate the page BEFORE recording anything ----------
                page.wait_for_timeout(1500)
                bad = SC.page_not_found(page)
                if bad:
                    ctx.close()
                    self._set(phase="error", done=True, error=bad)
                    return

                # ---- the address navigation actually landed on ------------
                landed = page.url
                self._set(phase="confirm-page", landedUrl=landed,
                          prompt="Is the browser window showing the report "
                                 "page for the right seller account?",
                          hint="If Amazon redirected you, that is fine — the "
                               "address it landed on is what gets saved: "
                               + landed)
                cmd, account_text = self._wait()
                if cmd == "cancel":
                    ctx.close(); self._set(phase="cancelled", done=True); return

                # It may have moved again while they looked at it.
                landed = page.url

                def pick(label: str, hint: str | None = None) -> dict:
                    self._set(phase="pick", prompt="Click the %s." % label,
                              hint=hint or "Do it in the Amazon window — hover "
                                           "highlights what you are about to pick.")
                    try:
                        page.evaluate(
                            "p => { window.__acpPrompt = p; }", "Click: " + label)
                    except Exception:
                        pass
                    got = page.evaluate(PICKER_JS)
                    with self._lock:
                        self.state["recorded"] = self.state["recorded"] + [
                            {"label": label, "selector": got["selector"],
                             "text": got["text"]}]
                    return got

                def ctrl(got: dict, label: str) -> dict:
                    return {"selector": got["selector"], "label": label,
                            "kind": "select" if got.get("isSelect") else "combo"}

                if not isinstance(account_text, str) or not account_text.strip():
                    raise RuntimeError('Enter the exact seller account name during page confirmation, then repeat setup.')
                g = pick('seller account selector', 'Choose the control showing the active seller account, not text in the page body.')
                recorded['sellerAccountControl'] = ctrl(g, 'seller account')

                def group(label: str, min_boxes: int, hint: str) -> dict:
                    """Record a whole block of tick boxes from one click in it."""
                    g = pick(label, hint)
                    res = page.evaluate(GROUP_JS,
                                        {"selector": g["selector"], "min": min_boxes})
                    if not res.get("ok"):
                        raise RuntimeError(
                            "Could not work out the block of tick boxes around "
                            "what you clicked: %s. Click one of the tick boxes "
                            "itself, not a heading, and try setup again."
                            % res.get("reason", "unknown reason"))
                    return {"selector": res["selector"], "label": label,
                            "count": res["count"]}

                # ---- the SKU Economics form -------------------------------
                # A different page from the reports repository: tick boxes and
                # a named date range, with no boxes to type dates into. Its
                # controls are recorded here and nowhere else.
                if self.spec.get("formKind") == "checkbox-form":
                    g = pick("Marketplace dropdown",
                             "The control listing the countries. Click the "
                             "dropdown itself, not a country inside it.")
                    mp = ctrl(g, "marketplace list")
                    mp["kind"] = "combo"     # it opens a panel; it is not a <select>
                    recorded["marketplaceList"] = mp

                    self._set(phase="ask-scope",
                              prompt="Open that Marketplace dropdown in the "
                                     "Amazon window, then click one of the "
                                     "country tick boxes inside it.",
                              hint="Every country in that list will be ticked "
                                   "on each download. Leave the list open.")
                    cmd, _ = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    panel = group("a country tick box", 1,
                                  "Click one of the country tick boxes in the "
                                  "open list.")
                    recorded["marketplaceList"]["optionScope"] = panel["selector"]

                    self._set(phase="ask-aggregation",
                              prompt="Is there a 'Data aggregation level' "
                                     "control on this page?",
                              hint="On the seller's page it shows MSKU.")
                    cmd, has_agg = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if has_agg:
                        g = pick("Data aggregation level control")
                        recorded["aggregationControl"] = ctrl(g, "aggregation")
                        recorded["aggregationValue"] = "MSKU"

                    g = pick("Date Range dropdown",
                             "The list of named ranges. This page does not "
                             "take typed dates.")
                    recorded["dateRangeControl"] = ctrl(g, "date range")

                    self._set(phase="ask-date-range",
                              prompt="Which date range should every download "
                                     "ask for?",
                              hint="Type it exactly as the dropdown words it, "
                                   "for example 'Next 30 days'. The app picks "
                                   "this same range each time and stops if the "
                                   "page ever shows something else.")
                    cmd, range_value = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if not isinstance(range_value, str) or not range_value.strip():
                        raise RuntimeError(
                            "No date range was given. Setup stopped rather than "
                            "guess one, because the wrong range looks like real "
                            "data. Repeat setup.")
                    recorded["dateRangeValue"] = range_value.strip()

                    box = group("one of the report option tick boxes", 2,
                                "Click any one of the report content options "
                                "(Sales Data, Storage Fee, and so on). All of "
                                "them will be ticked on every download.")
                    recorded["optionsGroup"] = box

                    self._set(phase="ask-tag",
                              prompt="Is there an 'Add Notes' box on this page?",
                              hint="The app writes a short unique tag into it "
                                   "so it can pick out exactly the report it "
                                   "asked for instead of guessing by date.")
                    cmd, has_tag = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if has_tag:
                        g = pick("Add Notes box")
                        recorded["reportTagInput"] = {"selector": g["selector"],
                                                      "label": "notes"}

                    g = pick("Generate Report button",
                             "The button that submits. It will NOT be pressed "
                             "now.")
                    recorded["requestButton"] = {"selector": g["selector"],
                                                 "label": "request"}
                    recorded["formKind"] = "checkbox-form"

                # ---- marketplace ------------------------------------------
                elif self.spec.get("needsMarketplace", True):
                    g = pick("country / marketplace switcher",
                             "The control that shows which Amazon store you are "
                             "looking at.")
                    recorded["marketplaceSwitcher"] = ctrl(g, "marketplace")

                # Everything below belongs to the reports repository:
                # typed dates, report type, account type. The SKU
                # Economics form has none of them and recorded its own
                # controls above.
                if self.spec.get("formKind") != "checkbox-form":
                    # ---- report type / account type / range mode --------------
                    self._set(phase="ask-controls",
                              prompt="Does this page have a Report Type control "
                                     "(where you choose Transaction)?",
                              hint=None)
                    cmd, has_type = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if has_type:
                        g = pick("Report Type control")
                        recorded["reportTypeControl"] = ctrl(g, "report type")
                        recorded["reportTypeValue"] = "Transaction"

                    if self.spec.get("needsAccountType"):
                        g = pick("Account Type control",
                                 "Where you pick All (Unified Reports), Standard "
                                 "Orders, and so on.")
                        recorded["accountTypeControl"] = ctrl(g, "account type")

                    self._set(phase="ask-range-mode",
                              prompt="Is there a control for choosing a Custom "
                                     "Date Range?")
                    cmd, has_mode = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if has_mode:
                        g = pick("Custom Date Range control")
                        recorded["dateRangeModeControl"] = ctrl(g, "date range mode")
                        recorded["dateRangeModeValue"] = "Custom Date Range"

                    # ---- dates -------------------------------------------------
                    self._set(phase="date-format",
                              prompt="What date format do the From/To boxes use?",
                              hint="Look at them in the browser window.")
                    cmd, date_format = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    recorded["dateFormat"] = date_format or "MM/DD/YYYY"

                    g = pick("FROM date box")
                    recorded["fromDate"] = {"selector": g["selector"], "label": "from"}
                    g = pick("TO date box")
                    recorded["toDate"] = {"selector": g["selector"], "label": "to"}

                    # ---- optional report name / tag ---------------------------
                    self._set(phase="ask-tag",
                              prompt="Is there a box where you can name or tag the "
                                     "report?",
                              hint="If yes, this app writes a unique tag into it so "
                                   "it can find exactly the report it asked for. "
                                   "This is the most reliable option by far.")
                    cmd, has_tag = self._wait()
                    if cmd == "cancel":
                        ctx.close(); self._set(phase="cancelled", done=True); return
                    if has_tag:
                        g = pick("report name / tag box")
                        recorded["reportTagInput"] = {"selector": g["selector"],
                                                      "label": "tag"}

                    # ---- request ----------------------------------------------
                    g = pick("Request Report button",
                             "The button that submits the request. It will NOT be "
                             "pressed now.")
                    recorded["requestButton"] = {"selector": g["selector"],
                                                 "label": "request"}

                # ---- the results list -------------------------------------
                self._set(phase="explain-list",
                          prompt="Now the list of reports below the form.",
                          hint="This app has to find YOUR report in that list "
                               "rather than grabbing the first one, so it needs "
                               "to know what a row looks like.")
                cmd, _ = self._wait()
                if cmd == "cancel":
                    ctx.close(); self._set(phase="cancelled", done=True); return

                g = pick("any ROW in the list of reports",
                         "Click the row itself — the line for one report, not "
                         "a button inside it.")
                # Strip the positional part so the selector matches every row.
                recorded["reportRow"] = {
                    "selector": g.get("generic") or g["selector"],
                    "label": "report row"}

                g = pick("the Download control INSIDE that same row",
                         "The download link or button on that one row.")
                recorded["rowDownload"] = {
                    "selector": _relative(g.get("generic") or g["selector"],
                                          recorded["reportRow"]["selector"]),
                    "label": "row download"}

                self._set(phase="ask-refresh",
                          prompt="Is there a Refresh button for the list?",
                          hint="Optional. Without one the page is reloaded "
                               "while waiting, which works but is slower.")
                cmd, has_refresh = self._wait()
                if cmd == "cancel":
                    ctx.close(); self._set(phase="cancelled", done=True); return
                if has_refresh:
                    g = pick("Refresh button")
                    recorded["refreshButton"] = {"selector": g["selector"],
                                                 "label": "refresh"}

                ctx.close()

                recorded.update({
                    "url": self.url,
                    "resolvedUrl": landed,
                    "verified": True,
                    "verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "expectAccountText": account_text or None,
                })
                self._set(phase="done", done=True,
                          prompt="Setup recorded for this report.",
                          result=recorded)

        except Exception as exc:
            self._set(phase="error", done=True,
                      error=SC.explain_launch_error(exc))


def _relative(child: str, parent: str) -> str:
    """The download control is looked for INSIDE a row, so store the part of
    its path below the row. Falls back to the full path when they do not
    share a prefix, which still works because the search is scoped."""
    if child.startswith(parent):
        rest = child[len(parent):].strip()
        rest = rest.lstrip('> ').strip()
        if rest:
            return rest
    # Last resort: the leaf. Scoped to the row, a tag name is usually enough.
    leaf = child.split('>')[-1].strip()
    return leaf or child
