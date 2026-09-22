"""Playwright automation for Seller Central's Reports Repository.

THE WORKFLOW

  switch marketplace  ->  verify it took
  Account Type  ->  Transaction  ->  Custom Date Range
  fill From / To  ->  verify the boxes kept what we typed
  Request Report
  wait for THAT report to become Ready
  download THAT report's CSV

THE PART THAT MATTERS MOST

Never click the first download button on the page. The repository lists every
report you have ever requested, newest first, and the newest is often not yours
yet — Amazon takes minutes to build one. Clicking the first button fetches an
older export, and the app imports it as though it were today's.

So a request is tracked. Before asking, existing rows are fingerprinted; after
asking, only a row that is NEW and carries the requested date range (and
account type, where recorded) can be ours. If the page offers a report-name
field, a unique tag is written into it and matching keys on that instead, which
is exact rather than inferred.

WHAT IS NOT GUESSED

Every selector comes from selectors.json, recorded by walking the real page.
Amazon's markup differs by account and marketplace and changes over time, so a
selector invented from memory would eventually download the wrong thing
quietly. A missing recording raises instead of improvising.

NO PASSWORD IS HANDLED HERE. You sign in yourself, in the window that opens.
"""

from __future__ import annotations

import re
import time
import uuid
from pathlib import Path
from typing import Callable

LOGIN_MARKERS = (
    "signin", "/ap/signin", "ap/mfa", "two-step", "verification",
    "authportal", "captcha",
)

NOT_FOUND_MARKERS = (
    "page not found", "we couldn't find that page", "this page isn't available",
    "sorry, we couldn't find",
)

READY_WORDS = ("ready", "download", "complete", "available")
PENDING_WORDS = ("in progress", "pending", "processing", "requested", "queued",
                 "generating")

GENERATION_TIMEOUT_S = 20 * 60
POLL_S = 10

def profile_args(profile_dir):
    import json
    try:
        name = json.loads((profile_dir / 'Local State').read_text('utf-8')).get('profile', {}).get('last_used', 'Default')
        if not re.fullmatch(r'Default|Profile \d+', name):
            raise ValueError('Unexpected profile name')
        return ['--profile-directory=' + name]
    except (FileNotFoundError, KeyError):
        return ['--profile-directory=Default']


def explain_launch_error(exc: Exception) -> str:
    """`spawn UNKNOWN` tells nobody anything. These are the causes that
    actually produce it."""
    msg = str(exc)
    if "spawn UNKNOWN" in msg or "Failed to launch" in msg:
        return (
            "The browser could not be opened. This step needs a VISIBLE browser "
            "window, so it only works while you are signed in at the computer's "
            "own desktop — not over a service, a scheduled task with no "
            "desktop, or a remote session that has been disconnected. "
            "If the helper was started automatically at login, try starting it "
            "yourself with start-helper, then run setup again. "
            "If Chromium is missing, reinstall it with: "
            "venv/bin/python -m playwright install chromium. "
            "(Original error: " + msg.splitlines()[0][:120] + ")")
    return msg


def looks_like_login(url: str) -> bool:
    u = (url or "").lower()
    return any(m in u for m in LOGIN_MARKERS)


def page_not_found(page) -> str | None:
    """A reason string when the page is an error page, else None."""
    try:
        title = (page.title() or "").lower()
    except Exception:
        title = ""
    try:
        head = (page.inner_text("body", timeout=10_000) or "")[:1500].lower()
    except Exception:
        head = ""
    for marker in NOT_FOUND_MARKERS:
        if marker in title or marker in head:
            return ("Amazon returned a “not found” page for this address. "
                    "The report page has moved. Re-run setup for this report so "
                    "the working address is recorded.")
    return None


def fmt_date(iso_date: str, fmt: str | None) -> str:
    y, m, d = iso_date.split("-")
    if not fmt or fmt == "YYYY-MM-DD":
        return iso_date
    if fmt == "MM/DD/YYYY":
        return "%s/%s/%s" % (m, d, y)
    if fmt == "DD/MM/YYYY":
        return "%s/%s/%s" % (d, m, y)
    raise RuntimeError("Unknown recorded date format: %r" % fmt)


def date_variants(iso_date: str) -> list[str]:
    """A row may print a date in a different style from the input boxes, so
    matching accepts any of the usual renderings."""
    y, m, d = iso_date.split("-")
    mi, di = int(m), int(d)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    mon = months[mi - 1]
    return [
        iso_date,
        "%s/%s/%s" % (m, d, y), "%d/%d/%s" % (mi, di, y),
        "%s/%s/%s" % (d, m, y), "%d/%d/%s" % (di, mi, y),
        "%s %d, %s" % (mon, di, y), "%d %s %s" % (di, mon, y),
        "%s %d %s" % (mon, di, y),
    ]


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def row_identity(text):
    # Status changes must not turn an old pending row into a new ready row.
    words = '|'.join(re.escape(w) for w in PENDING_WORDS + READY_WORDS)
    return _norm(re.sub(r'\b(?:' + words + r')\b', '', text, flags=re.I))


def _need(selectors: dict, key: str, why: str):
    val = selectors.get(key)
    if not val:
        raise RuntimeError(
            "This report is not fully set up: %s was never recorded (%s). "
            "Re-run setup for it in the app." % (key, why))
    return val


# ── recorded controls ───────────────────────────────────────────────────────

def set_control(page, ctrl: dict, value: str) -> None:
    """A recorded dropdown. A native <select> uses select_option; anything else
    is treated as click-to-open, then the option is found by its text."""
    if not ctrl:
        return
    sel = ctrl["selector"]
    if ctrl.get("kind") == "select":
        try:
            page.select_option(sel, label=value, timeout=20_000)
        except Exception:
            page.select_option(sel, value=value, timeout=20_000)
        page.wait_for_timeout(300)
        return

    page.click(sel, timeout=20_000)
    page.wait_for_timeout(400)
    scope = ctrl.get("optionScope") or "body"
    try:
        page.locator("%s >> text=%s" % (scope, value)).first.click(timeout=10_000)
    except Exception as exc:
        raise RuntimeError(
            "Could not choose %r in %s. The page may word it differently now. "
            "(%s)" % (value, ctrl.get("label", "a dropdown"), str(exc)[:120])
        ) from exc
    page.wait_for_timeout(300)


def read_control(page, ctrl: dict) -> str:
    """What the control currently shows, for verification."""
    if not ctrl:
        return ""
    sel = ctrl["selector"]
    try:
        if ctrl.get("kind") == "select":
            return (page.eval_on_selector(
                sel,
                "e => e.options[e.selectedIndex] ? e.options[e.selectedIndex].text : ''"
            ) or "").strip()
        return (page.inner_text(sel, timeout=10_000) or "").strip()
    except Exception:
        return ""


# ── marketplace ─────────────────────────────────────────────────────────────

def switch_marketplace(page, selectors: dict, marketplace: str, progress) -> None:
    """Switch, then confirm. Requesting against the wrong country is
    indistinguishable from a quiet data error weeks later."""
    ctrl = selectors.get("marketplaceSwitcher")
    if not ctrl:
        raise RuntimeError(
            "No marketplace switcher was recorded for this report, so the "
            "country cannot be set. Re-run setup and record it.")

    progress("requesting", "Switching to %s…" % marketplace)
    set_control(page, ctrl, marketplace)
    try:
        page.wait_for_load_state("domcontentloaded", timeout=60_000)
    except Exception:
        pass
    page.wait_for_timeout(1500)

    shown = read_control(page, ctrl)
    if marketplace.lower() not in (shown or "").lower():
        raise RuntimeError('Marketplace selection could not be verified in its control. Nothing was requested. Re-run setup.')
    progress("requesting", "Marketplace confirmed: %s." % marketplace)


# ── checkbox groups ────────────────────────────────────────────

def _box_checked(box) -> bool:
    """True / False. Covers a real <input> and an ARIA widget, because this
    page renders both."""
    try:
        return bool(box.is_checked(timeout=3_000))
    except Exception:
        pass
    try:
        return (box.get_attribute("aria-checked") or "").lower() == "true"
    except Exception:
        return False


def _tick(page, box) -> bool:
    """Tick one box. Returns whether it ended up ticked.

    Three attempts, because the same page mixes plain inputs with inputs that
    are visually hidden behind a styled label:
      1. check() - Playwright's own, which waits and then verifies;
      2. the <label> that points at it, for a hidden input;
      3. a direct DOM click, last resort.
    A box that is already ticked is left alone: clicking it would untick it.
    """
    if _box_checked(box):
        return True
    try:
        box.check(timeout=8_000)
        if _box_checked(box):
            return True
    except Exception:
        pass
    try:
        bid = box.get_attribute("id")
        if bid:
            lab = page.locator('label[for="%s"]' % bid).first
            if lab.count():
                lab.click(timeout=5_000)
                if _box_checked(box):
                    return True
    except Exception:
        pass
    try:
        box.evaluate("e => e.click()")
    except Exception:
        return False
    return _box_checked(box)


def check_all_in(page, scope: str, what: str, progress, expect_min: int = 1) -> dict:
    """Tick EVERY box inside one area of the form, and prove it.

    The instruction is "check all the boxes", so this deliberately carries no
    list of box names: a name Amazon renames would silently drop a column from
    the export, and a column that is quietly missing is worse than a job that
    stops. It ticks what is there and counts what it did.

    Ticking every content box is also what makes the export match what the app
    parses - the six options are the fulfilment, sales, storage, refund,
    referral and advertising columns, and the fee hierarchy expects all of them.
    """
    boxes = page.locator(
        "%s input[type=checkbox]:not([disabled]), %s [role=checkbox]" % (scope, scope))
    try:
        total = boxes.count()
    except Exception:
        total = 0

    if total < expect_min:
        raise RuntimeError(
            "Expected at least %d tick box%s under %s but found %d. The page has "
            "changed shape. Nothing was requested - re-run setup for this report."
            % (expect_min, "" if expect_min == 1 else "es", what, total))

    already = ticked = failed = 0
    stubborn = []
    for i in range(total):
        box = boxes.nth(i)
        if _box_checked(box):
            already += 1
            continue
        if _tick(page, box):
            ticked += 1
            page.wait_for_timeout(120)
        else:
            failed += 1
            try:
                stubborn.append(box.get_attribute("name")
                                or box.get_attribute("id") or "#%d" % (i + 1))
            except Exception:
                stubborn.append("#%d" % (i + 1))

    if failed:
        raise RuntimeError(
            "%d of %d boxes under %s would not tick (%s). The export would be "
            "missing those columns, so nothing was requested."
            % (failed, total, what, ", ".join(stubborn[:5])))

    progress("requesting", "%s: %d of %d ticked (%d already were)."
             % (what, ticked + already, total, already))
    return {"total": total, "ticked": ticked, "already": already}


def open_and_check_all(page, ctrl: dict, what: str, progress,
                       expect_min: int = 1) -> dict:
    """A dropdown whose panel holds tick boxes - the Marketplace list.

    Opened, every box inside ticked, then closed: a panel left hanging open
    covers the controls underneath it.
    """
    if not ctrl:
        raise RuntimeError(
            "No %s control was recorded for this report. Re-run setup." % what)
    page.click(ctrl["selector"], timeout=20_000)
    page.wait_for_timeout(600)
    scope = ctrl.get("optionScope") or "body"
    try:
        result = check_all_in(page, scope, what, progress, expect_min=expect_min)
    finally:
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception:
            pass
    return result


def request_checkbox_form(page, selectors: dict, date_range_value: str,
                          progress, save_ticket=None) -> dict:
    """The SKU Economics form at /cepreport.

    Shape, taken from the page itself: a Marketplace dropdown holding one tick
    box per country; a data aggregation level; a Date Range dropdown of named
    ranges rather than typed dates; a block of report-content tick boxes; a
    Notes box; a Generate button.

    Every box is ticked, the range is picked by name and verified, and the
    Notes box carries a one-off tag so the finished file is identified as ours
    rather than by matching dates an earlier report may also carry.
    """
    ticket_extra = {}

    mp = open_and_check_all(
        page, selectors.get("marketplaceList"), "Marketplace", progress,
        expect_min=1)
    ticket_extra["marketplaces"] = mp["total"]

    if selectors.get("aggregationControl"):
        want = selectors.get("aggregationValue") or "MSKU"
        progress("requesting", "Aggregation level: %s." % want)
        set_control(page, selectors["aggregationControl"], want)

    range_ctrl = _need(selectors, "dateRangeControl", "the Date Range dropdown")
    progress("requesting", "Choosing date range: %s." % date_range_value)
    set_control(page, range_ctrl, date_range_value)
    shown = read_control(page, range_ctrl)
    # Asking for the wrong window is the failure that looks like real data.
    if shown and date_range_value.lower() not in shown.lower():
        raise RuntimeError(
            "Asked for the date range %r but the form shows %r. Nothing was "
            "requested." % (date_range_value, shown))

    opts = check_all_in(
        page,
        _need(selectors, "optionsGroup", "the report options block")["selector"],
        "Report options", progress, expect_min=2)
    ticket_extra["options"] = opts["total"]

    tag = None
    tag_ctrl = selectors.get("reportTagInput")
    if tag_ctrl:
        # The notes box caps at 50 characters on this page; this is 12.
        tag = "acp-" + uuid.uuid4().hex[:8]
        page.fill(tag_ctrl["selector"], tag, timeout=20_000)
        got = (page.input_value(tag_ctrl["selector"], timeout=10_000) or "").strip()
        if got != tag:
            raise RuntimeError(
                "The notes box did not keep the tag (it shows %r). Without it "
                "the finished report cannot be told apart from an older one, so "
                "nothing was requested." % got)
        progress("requesting", "Tagged this request %s." % tag)

    before = row_fingerprints(page, selectors)

    ticket = {
        "tag": tag,
        "dateRange": date_range_value,
        "from": None, "to": None,
        "fromText": None, "toText": None,
        "accountType": None,
        "before": before,
        "requestedAt": time.time(),
        "reportType": selectors.get("reportTypeValue") or "SKU Economics",
        "formKind": "checkbox-form",
    }
    ticket.update(ticket_extra)
    # Persisted BEFORE the click, so an ambiguous timeout cannot submit twice.
    if save_ticket:
        save_ticket(ticket)
    progress("requesting", "Generating the report.")
    page.click(_need(selectors, "requestButton",
                     "the Generate Report button")["selector"], timeout=30_000)
    page.wait_for_timeout(2500)
    return ticket


# ── the request ─────────────────────────────────────────────────────────────

def row_locator(page, selectors: dict):
    return page.locator(_need(selectors, "reportRow",
                              "a row in the report list")["selector"])


def row_fingerprints(page, selectors: dict):
    """How many rows carry each text right now.

    A COUNT, not a set. Re-requesting the same dates produces a row whose text
    is identical to the old one, and a set would then hide both: the old row
    and ours. Counting means "two rows now where there was one" correctly
    identifies the second as new."""
    out: dict[str, int] = {}
    try:
        rows = row_locator(page, selectors)
        for i in range(min(rows.count(), 80)):
            try:
                key = row_identity(rows.nth(i).inner_text(timeout=4_000))
            except Exception:
                continue
            out[key] = out.get(key, 0) + 1
    except Exception:
        pass
    return out


def request_report(page, selectors: dict, date_from: str, date_to: str,
                   account_type: str | None, progress, save_ticket=None) -> dict:
    """Drive the request form. Returns the ticket used to find the result.

    Two shapes exist, and they are not variations of one form:

      "repository"     the Payments reports repository - From and To boxes
                       that take typed dates, plus report and account type.
      "checkbox-form"  the SKU Economics page at /cepreport - tick boxes for
                       marketplaces and report contents, and a Date Range
                       chosen from a list. It has no boxes to type dates into.

    Routed on the recorded shape rather than sniffed from what is on screen,
    so a page that half-loads cannot be driven as if it were the other one.
    """
    if selectors.get("formKind") == "checkbox-form":
        return request_checkbox_form(
            page, selectors,
            selectors.get("dateRangeValue") or "Last 30 days",
            progress, save_ticket)

    fmt = selectors.get("dateFormat") or "MM/DD/YYYY"
    tag = None
    tag_ctrl = selectors.get("reportTagInput")

    if selectors.get("reportTypeControl"):
        want = selectors.get("reportTypeValue") or "Transaction"
        progress("requesting", "Choosing report type: %s." % want)
        set_control(page, selectors["reportTypeControl"], want)
        if read_control(page, selectors['reportTypeControl']).strip().lower() != want.lower():
            raise RuntimeError('Report type could not be verified. Nothing was requested.')

    if account_type and selectors.get("accountTypeControl"):
        progress("requesting", "Choosing account type: %s." % account_type)
        set_control(page, selectors["accountTypeControl"], account_type)

    if selectors.get("dateRangeModeControl"):
        want = selectors.get("dateRangeModeValue") or "Custom Date Range"
        progress("requesting", "Choosing %s." % want)
        set_control(page, selectors["dateRangeModeControl"], want)

    from_ctrl = _need(selectors, "fromDate", "the From box")
    to_ctrl = _need(selectors, "toDate", "the To box")
    from_text = fmt_date(date_from, fmt)
    to_text = fmt_date(date_to, fmt)

    progress("requesting", "Entering %s to %s." % (from_text, to_text))
    page.fill(from_ctrl["selector"], from_text, timeout=30_000)
    page.fill(to_ctrl["selector"], to_text, timeout=30_000)

    if tag_ctrl:
        tag = "acp-" + uuid.uuid4().hex[:8]
        page.fill(tag_ctrl["selector"], tag, timeout=20_000)
        progress("requesting", "Tagged this request %s." % tag)

    # -- verify before committing -------------------------------------------
    got_from = (page.input_value(from_ctrl["selector"], timeout=10_000) or "").strip()
    got_to = (page.input_value(to_ctrl["selector"], timeout=10_000) or "").strip()
    if from_text != got_from or to_text != got_to:
        raise RuntimeError(
            "The date boxes did not keep what was typed (From shows %r, To "
            "shows %r). Nothing was requested." % (got_from, got_to))

    if account_type and selectors.get("accountTypeControl"):
        shown = read_control(page, selectors["accountTypeControl"])
        stem = account_type.split(" (")[0].strip().lower()
        if not shown or (stem and stem not in shown.lower()):
            raise RuntimeError(
                "Asked for account type %r but the form shows %r. Nothing was "
                "requested." % (account_type, shown))

    before = row_fingerprints(page, selectors)

    ticket = {
        "tag": tag,
        "from": date_from, "to": date_to,
        "fromText": from_text, "toText": to_text,
        "accountType": account_type,
        "before": before,
        "requestedAt": time.time(),
        "reportType": selectors.get('reportTypeValue', 'Transaction'),
    }
    # Persist BEFORE clicking: even an ambiguous click timeout must not submit twice.
    if save_ticket:
        save_ticket(ticket)
    progress('requesting', 'Requesting the report.')
    page.click(_need(selectors, 'requestButton', 'the Request Report button')['selector'], timeout=30_000)
    page.wait_for_timeout(2500)
    return ticket


# ── finding OUR report ──────────────────────────────────────────────────────

def row_matches(text: str, ticket: dict) -> bool:
    """Is this row the report we asked for?"""
    t = _norm(text).lower()
    if ticket.get("tag"):
        return ticket["tag"].lower() in t          # exact, when tagging works
    if ticket.get('reportType') and ticket['reportType'].lower() not in t:
        return False

    for iso in (ticket["from"], ticket["to"]):
        variants = date_variants(iso)
        recorded = ticket.get('fromText' if iso == ticket['from'] else 'toText')
        if recorded:
            variants = [recorded, iso] + variants[5:]
        if not any(re.search(r'(?<!\d)' + re.escape(v.lower()) + r'(?!\d)', t) for v in variants):
            return False

    acct = ticket.get("accountType")
    if acct:
        stem = acct.split(" (")[0].strip().lower()
        # "All" is too short to discriminate; the dates carry that case.
        if not re.search(r'\b' + re.escape(stem) + r'\b', t) and ticket.get('reportType'):
            return False
        if len(stem) > 3 and stem not in t:
            return False
    return True


def row_state(text: str) -> str:
    t = _norm(text).lower()
    if any(w in t for w in PENDING_WORDS):
        return "pending"
    if any(w in t for w in READY_WORDS):
        return "ready"
    return "unknown"


def find_our_row(page, selectors: dict, ticket: dict):
    """The row for this ticket, and its state. (None, None) when not visible.

    Rows identical to ones that existed before the request are allowed through
    only once the pre-existing count is used up, so an older report with the
    same dates can never be mistaken for this one."""
    rows = row_locator(page, selectors)
    before = ticket.get("before") or {}
    if isinstance(before, set):                    # tolerate an older ticket
        before = {k: 1 for k in before}
    seen: dict[str, int] = {}
    matches = []
    before = {row_identity(k): v for k, v in before.items()}

    for i in range(min(rows.count(), 80)):
        try:
            text = rows.nth(i).inner_text(timeout=4_000)
        except Exception:
            continue
        key = row_identity(text)

        if not ticket.get("tag"):
            allowance = before.get(key, 0)
            n = seen.get(key, 0)
            seen[key] = n + 1
            if allowance:
                continue                            # this one was already here
        if row_matches(text, ticket):
            matches.append((rows.nth(i), row_state(text)))
    if len(matches) > 1:
        raise RuntimeError('More than one report matches. Refusing an ambiguous download; inspect Amazon manually.')
    return matches[0] if matches else (None, None)


def wait_for_report(page, selectors: dict, ticket: dict, progress):
    """Poll until OUR row is ready. Returns the row locator."""
    deadline = time.time() + GENERATION_TIMEOUT_S
    refresh = selectors.get("refreshButton")
    waited = 0

    while time.time() < deadline:
        if looks_like_login(page.url):
            await_login(page, progress)
        row, state = find_our_row(page, selectors, ticket)
        if row is not None and state == "ready":
            progress("downloading", "Your report is ready.")
            return row
        if row is not None:
            progress("generating",
                     "Amazon is still building your report (%d min so far)."
                     % (waited // 60))
        else:
            progress("generating",
                     "Waiting for your report to appear in the list (%d min)."
                     % (waited // 60))

        time.sleep(POLL_S)
        waited += POLL_S
        try:
            if refresh:
                page.click(refresh["selector"], timeout=10_000)
            else:
                page.reload(wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_timeout(1500)
        except Exception:
            pass

    raise RuntimeError(
        "The report did not become ready within %d minutes. It WAS requested, "
        "so do not ask for it again — press Retry later and this will look for "
        "the same report rather than queueing a second one."
        % (GENERATION_TIMEOUT_S // 60))


# ── the whole job ───────────────────────────────────────────────────────────

def await_login(page, progress):
    progress('login-required', 'Sign in in the Amazon browser window. This job will resume automatically; do not request another report.')
    deadline = time.time() + 15 * 60
    while looks_like_login(page.url) and time.time() < deadline:
        page.wait_for_timeout(1000)
    if looks_like_login(page.url):
        raise RuntimeError('Sign-in timed out. Retry retains the original report ticket.')


def download_report(
    report_type: str,
    date_from: str,
    date_to: str,
    profile_dir: Path,
    download_dir: Path,
    selectors: dict,
    progress: Callable[[str, str], None],
    marketplace: str | None = None,
    account_type: str | None = None,
    ticket: dict | None = None,
    save_ticket=None,
) -> dict:
    """{'path','rowCount',...} or {'loginRequired': True}."""
    from playwright.sync_api import sync_playwright

    if not selectors.get("verified"):
        raise RuntimeError("This report is not set up yet.")

    profile_dir.mkdir(parents=True, exist_ok=True)
    download_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        try:
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                args=profile_args(profile_dir),
                headless=False,
                accept_downloads=True,
                viewport={"width": 1400, "height": 950},
            )
        except Exception as exc:
            raise RuntimeError(explain_launch_error(exc)) from exc

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        keep_open = False

        try:
            # The address recorded during setup, which is where navigation
            # actually LANDED — not the starting link, which may redirect.
            url = selectors.get("resolvedUrl") or selectors["url"]
            progress("requesting", "Opening the report page.")
            page.goto(url, wait_until="domcontentloaded", timeout=90_000)

            if looks_like_login(page.url):
                await_login(page, progress)
                page.goto(url, wait_until='domcontentloaded', timeout=90000)

            bad = page_not_found(page)
            if bad:
                raise RuntimeError(bad)

            expect = selectors.get("expectAccountText")
            seller = selectors.get('sellerAccountControl')
            if not expect or not seller:
                raise RuntimeError('Seller account selection and verification are not recorded. Re-run report setup.')
            set_control(page, seller, expect)
            if expect.lower() not in read_control(page, seller).lower():
                raise RuntimeError('Seller account could not be verified. Nothing was requested.')
            if expect:
                body = page.inner_text("body", timeout=15_000)
                if expect not in body:
                    raise RuntimeError(
                        "This does not look like the expected seller account "
                        "(could not find %r on the page). Nothing was "
                        "requested." % expect)

            # A form that ticks every marketplace has no single country to
            # switch to; switching would undo the selection it is about to make.
            if marketplace and selectors.get("formKind") != "checkbox-form":
                switch_marketplace(page, selectors, marketplace, progress)
                if looks_like_login(page.url):
                    await_login(page, progress)
                    switch_marketplace(page, selectors, marketplace, progress)
                if expect.lower() not in read_control(page, seller).lower():
                    raise RuntimeError('Seller changed while switching marketplace. Nothing was requested.')

            ticket = ticket or request_report(page, selectors, date_from, date_to,
                                    account_type, progress, save_ticket)
            row = wait_for_report(page, selectors, ticket, progress)

            dl_ctrl = _need(selectors, "rowDownload",
                            "the download control inside a report row")
            progress("downloading", "Downloading your report.")
            with page.expect_download(timeout=5 * 60 * 1000) as dl:
                row.locator(dl_ctrl["selector"]).first.click(timeout=60_000)
            download = dl.value

            stamp = time.strftime("%Y%m%d-%H%M%S")
            suggested = Path(download.suggested_filename or (report_type + '.csv')).name
            target = download_dir / ("%s-%s-%s-%s" % (
                report_type, (marketplace or "default").replace(" ", "_"),
                stamp, suggested))
            download.save_as(str(target))

            rows = 0
            try:
                with target.open("r", encoding="utf-8-sig", errors="replace") as fh:
                    rows = max(0, sum(1 for _ in fh) - 1)
            except Exception:
                rows = 0

            progress("validating", "Downloaded %s rows." % rows)
            return {
                "path": str(target), "rowCount": rows,
                "marketplace": marketplace, "accountType": account_type,
                "tag": ticket.get("tag"),
                # What this file actually covers.
                #
                # The repository form was given two dates, so it covers them.
                # The SKU Economics form was given a NAMED range - "Next 30
                # days" - and the page decides what that means. Reporting the
                # dates this program happened to calculate would be inventing a
                # period Amazon never agreed to, so the range is reported by
                # name and the real dates are read from the file's own columns
                # when it is parsed.
                **({"coverageRange": ticket.get("dateRange"),
                    "coverageFrom": None, "coverageTo": None}
                   if selectors.get("formKind") == "checkbox-form"
                   else {"coverageFrom": date_from, "coverageTo": date_to}),
            }

        finally:
            if not keep_open:
                try:
                    ctx.close()
                except Exception:
                    pass
