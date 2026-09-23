"""Tests for the two pieces of logic that decide whether the right file lands.

Run:  python worker/test_matching.py

These are AUTOMATED tests of the matching and navigation rules. They do not
touch Amazon and prove nothing about a live download — that needs a real login
and is listed separately.
"""

from __future__ import annotations

import sys
import json
import time
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Importing worker now decides where this computer keeps its data, and moves
# anything an older installation left behind. A test run must never do that to
# the real folder: it would migrate a live installation as a side effect of
# running the suite. So the data directory is redirected BEFORE the import.
import os                            # noqa: E402
os.environ["FBA_DATA_DIR"] = tempfile.mkdtemp(prefix="fba-test-data-")

import seller_central as SC          # noqa: E402

PASS, FAIL = 0, 0
FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    global PASS, FAIL
    if got == want:
        PASS += 1
        print("  PASS  " + label)
    else:
        FAIL += 1
        FAILURES.append(label)
        print("  FAIL  " + label + "\n          got " + repr(got)
              + "   want " + repr(want))


def section(name: str) -> None:
    print("\n-- " + name + " " + "-" * max(0, 58 - len(name)))


# ── dates ───────────────────────────────────────────────────────────────────

section("Dates are written the way the page expects")
check("US format", SC.fmt_date("2026-09-17", "MM/DD/YYYY"), "09/17/2026")
check("ISO passthrough", SC.fmt_date("2026-09-17", "YYYY-MM-DD"), "2026-09-17")
check("EU format", SC.fmt_date("2026-09-17", "DD/MM/YYYY"), "17/09/2026")
try:
    SC.fmt_date("2026-09-17", "nonsense")
    check("an unknown format is refused", "no error", "RuntimeError")
except RuntimeError:
    check("an unknown format is refused", "RuntimeError", "RuntimeError")

section("A row's date may be printed differently from the input box")
v = SC.date_variants("2026-09-17")
for want in ("2026-09-17", "09/17/2026", "9/17/2026", "17/09/2026",
             "Sep 17, 2026", "17 Sep 2026"):
    check("recognises " + want, want in v, True)


# ── the row state words ─────────────────────────────────────────────────────

section("Report status is read from the row's own words")
check("Ready", SC.row_state("Transaction  01/08/2026  Ready  Download"), "ready")
check("Download alone counts as ready",
      SC.row_state("Custom transaction  Download CSV"), "ready")
check("In Progress", SC.row_state("Transaction  In Progress"), "pending")
check("Requested", SC.row_state("Transaction  Requested  --"), "pending")
check("pending wins over a stray 'download' word",
      SC.row_state("Transaction  In Progress  Download unavailable"), "pending")
check("unknown stays unknown", SC.row_state("Transaction  --"), "unknown")


# ── matching OUR report ─────────────────────────────────────────────────────

TICKET = {
    "tag": None,
    "from": "2026-08-03", "to": "2026-09-17",
    "fromText": "08/03/2026", "toText": "09/17/2026",
    "accountType": "All (Unified Reports)",
    "before": set(),
}

section("A row is ours only when both dates are on it")
check("both dates present",
      SC.row_matches("Transaction  08/03/2026 - 09/17/2026  Ready  Download", TICKET),
      True)
check("only the start date is not enough",
      SC.row_matches("Transaction  08/03/2026 - 08/31/2026  Ready", TICKET), False)
check("neither date, no match",
      SC.row_matches("Transaction  01/01/2026 - 02/01/2026  Ready", TICKET), False)
check("a differently formatted row still matches",
      SC.row_matches("Transaction  Aug 3, 2026 to Sep 17, 2026  Ready", TICKET),
      True)

section("Account type narrows it when it is discriminating")
STANDARD = dict(TICKET, accountType="Standard Orders")
check("Standard Orders row matches a Standard Orders request",
      SC.row_matches("Standard Orders  08/03/2026 - 09/17/2026  Ready", STANDARD),
      True)
check("an Invoiced row does NOT match a Standard request",
      SC.row_matches("Invoiced Orders  08/03/2026 - 09/17/2026  Ready", STANDARD),
      False)
check("'All' is too short to filter on, so dates carry it",
      SC.row_matches("08/03/2026 - 09/17/2026  Ready  Download", TICKET), True)

section("A tag, when the page supports one, is exact")
TAGGED = dict(TICKET, tag="acp-1234abcd")
check("the tagged row matches",
      SC.row_matches("my report acp-1234abcd  Ready  Download", TAGGED), True)
check("the right dates WITHOUT our tag do not match",
      SC.row_matches("Transaction 08/03/2026 - 09/17/2026 Ready", TAGGED), False)


# ── the guard against grabbing an old report ────────────────────────────────

section("A row that existed before we asked is never ours")


class FakeLocator:
    def __init__(self, texts): self._t = texts

    def count(self): return len(self._t)

    def nth(self, i): return FakeRow(self._t[i])


class FakeRow:
    def __init__(self, text): self._text = text

    def inner_text(self, timeout=0): return self._text


class FakePage:
    def __init__(self, texts): self._texts = texts

    def locator(self, _sel): return FakeLocator(self._texts)


SELECTORS = {"reportRow": {"selector": "tr"}}

OLD_ROW = "Transaction  08/03/2026 - 09/17/2026  Ready  Download"
rows = [OLD_ROW, "Transaction  01/01/2026 - 01/31/2026  Ready  Download"]

# Exactly the dangerous case: an OLD report with the same dates is sitting at
# the top of the list, ready to download, when we ask for a new one.
ticket = dict(TICKET, before={SC._norm(OLD_ROW): 1})
row, state = SC.find_our_row(FakePage(rows), SELECTORS, ticket)
check("the pre-existing identical row is skipped", row, None)

# Once Amazon adds OUR row, it is found.
NEW_ROW = "Transaction  08/03/2026 - 09/17/2026  In Progress"
row, state = SC.find_our_row(FakePage([NEW_ROW] + rows), SELECTORS, ticket)
check("a new but indistinguishable row is refused", row, None)
check("ambiguous status is not reported as our report", state, None)

READY_ROW = "Transaction  08/03/2026 - 09/17/2026  Ready  Download"
# It is textually identical to the old one once ready, so the fingerprint set
# is what keeps them apart; a second copy in the list means ours is there.
row, state = SC.find_our_row(FakePage([READY_ROW, OLD_ROW]), SELECTORS,
                             dict(TICKET, before={SC._norm(OLD_ROW): 1}))
check("identical ready rows cannot prove which one is ours", state, None)

section("With a tag, even a pre-existing row is matched safely")
tagged_rows = ["old thing  Ready", "acp-1234abcd  08/03/2026 - 09/17/2026  Ready"]
row, state = SC.find_our_row(FakePage(tagged_rows), SELECTORS,
                             dict(TAGGED, before={SC._norm(tagged_rows[1]): 1}))
check("a tagged row is ours even if it was fingerprinted", state, "ready")


# ── navigation validation ───────────────────────────────────────────────────

section("Login and error pages are recognised")
check("sign-in URL", SC.looks_like_login(
    "https://sellercentral.amazon.com/ap/signin?openid..."), True)
check("MFA URL", SC.looks_like_login("https://amazon.com/ap/mfa"), True)
check("the repository URL is not a login",
      SC.looks_like_login(
          "https://sellercentral.amazon.com/payments/reports-repository"), False)


class FakeErrorPage:
    def __init__(self, title, body): self._t, self._b = title, body

    def title(self): return self._t

    def inner_text(self, _sel, timeout=0): return self._b


check("a not-found page is caught",
      SC.page_not_found(FakeErrorPage(
          "Page Not Found", "Sorry, we couldn't find that page")) is not None,
      True)
check("the real repository page passes",
      SC.page_not_found(FakeErrorPage(
          "Reports Repository",
          "Request a report  Account Type  Transaction  Custom Date Range")),
      None)


# ── report definitions ──────────────────────────────────────────────────────

section("The broken URL is gone")
import worker as W                                    # noqa: E402
check("transactions points at the repository",
      W.REPORTS["date-range-transactions"]["url"],
      "https://sellercentral.amazon.com/payments/reports-repository")
check("no report still uses the old request path",
      any("/payments/reports/custom/request" in r["url"] for r in W.REPORTS.values()),
      False)
check("the transaction report asks for an account type",
      W.REPORTS["date-range-transactions"]["needsAccountType"], True)
check("All (Unified Reports) is offered first",
      W.REPORTS["date-range-transactions"]["accountTypes"][0],
      "All (Unified Reports)")
check("the forecast has no account type",
      W.REPORTS["fees-preview"]["needsAccountType"], False)
check("forecast and historical are separate kinds",
      (W.REPORTS["fees-preview"]["kind"],
       W.REPORTS["date-range-transactions"]["kind"]),
      ("forecast", "historical"))

section("Each report asks for its own dates")
frm, to = W.range_for("fees-preview")
check("the forecast looks forward", frm < to and frm >= "2026-01-01", True)
hfrm, hto = W.range_for("date-range-transactions")
check("the transaction report looks back", hfrm < hto, True)
check("and they are different windows", (frm, to) != (hfrm, hto), True)



# ── ticking every box ──────────────────────────────────────────

class FakeBox:
    """One tick box. Records every attempt made on it, so a test can prove
    that an already-ticked box was never clicked."""

    def __init__(self, checked=False, stubborn=False, aria=False):
        self.checked = checked
        self.stubborn = stubborn          # refuses to change, like a disabled one
        self.aria = aria                  # an ARIA widget, not a real <input>
        self.clicks = 0

    # -- what Playwright's locator offers -----------------------------------
    def is_checked(self, timeout=None):
        if self.aria:
            raise RuntimeError("not an input element")
        return self.checked

    def get_attribute(self, name):
        if name == "aria-checked" and self.aria:
            return "true" if self.checked else "false"
        if name == "id":
            return None
        if name == "name":
            return "box"
        return None

    def check(self, timeout=None):
        self.clicks += 1
        if not self.stubborn:
            self.checked = True

    def evaluate(self, _js):
        self.clicks += 1
        if not self.stubborn:
            self.checked = True


class FakeLocator:
    def __init__(self, boxes):
        self.boxes = boxes

    def count(self):
        return len(self.boxes)

    def nth(self, i):
        return self.boxes[i]

    def first(self):
        return self.boxes[0]


class FakePage:
    def __init__(self, boxes):
        self.boxes = boxes
        self.waits = 0

    def locator(self, _sel):
        return FakeLocator(self.boxes)

    def wait_for_timeout(self, _ms):
        self.waits += 1


NOTES = []


def note(_phase, msg):
    NOTES.append(msg)


section("Every box gets ticked")

boxes = [FakeBox(), FakeBox(), FakeBox(), FakeBox(), FakeBox(), FakeBox()]
res = SC.check_all_in(FakePage(boxes), "#opts", "Report options", note, expect_min=2)
check("all six are ticked", all(b.checked for b in boxes), True)
check("and it says so", (res["total"], res["ticked"], res["already"]), (6, 6, 0))

section("A box already ticked is left alone")

boxes = [FakeBox(checked=True), FakeBox(), FakeBox(checked=True)]
res = SC.check_all_in(FakePage(boxes), "#opts", "Report options", note, expect_min=2)
check("all end up ticked", all(b.checked for b in boxes), True)
check("the ticked ones were never clicked",
      [b.clicks for b in boxes], [0, 1, 0])
check("the count separates them", (res["ticked"], res["already"]), (1, 2))

section("An ARIA tick box counts too")

boxes = [FakeBox(aria=True), FakeBox(aria=True, checked=True)]
res = SC.check_all_in(FakePage(boxes), "#mp", "Marketplace", note, expect_min=1)
check("both end up ticked", all(b.checked for b in boxes), True)
check("the already-ticked ARIA box was not clicked", boxes[1].clicks, 0)

section("A box that will not tick stops the job")

boxes = [FakeBox(), FakeBox(stubborn=True), FakeBox()]
try:
    SC.check_all_in(FakePage(boxes), "#opts", "Report options", note, expect_min=2)
    stopped = False
    why = ""
except RuntimeError as exc:
    stopped, why = True, str(exc)
check("it stops rather than request a short export", stopped, True)
check("and says nothing was requested", "nothing was requested" in why.lower(), True)

section("A page that changed shape stops the job")

try:
    SC.check_all_in(FakePage([FakeBox()]), "#opts", "Report options", note,
                    expect_min=6)
    stopped = False
    why = ""
except RuntimeError as exc:
    stopped, why = True, str(exc)
check("too few boxes is refused", stopped, True)
check("and it names re-running setup", "re-run setup" in why.lower(), True)


section("The SKU Economics page is the one Amazon actually serves")

check("fees-preview points at cepreport",
      W.REPORTS["fees-preview"]["url"],
      "https://sellercentral.amazon.com/cepreport")
check("it is driven as a tick-box form",
      W.REPORTS["fees-preview"].get("formKind"), "checkbox-form")
check("the transactions report is NOT",
      W.REPORTS["date-range-transactions"].get("formKind"), None)


# ── the SKU Economics driver ──────────────────────────────────

import sku_economics as SKU               # noqa: E402

section("It knows which page it is on")

check("it targets the page Amazon actually serves",
      SKU.URL, "https://sellercentral.amazon.com/cepreport")
check("it expects the six printed options", len(SKU.KNOWN_OPTIONS), 6)
check("the configuration heading is the anchor",
      SKU.OPTIONS_HEADING, "simplified report configuration options")


class OptBoxPage(FakePage):
    """A page that answers the driver's queries, and REMEMBERS what was clicked.

    Stateful on purpose. The driver now re-finds each box immediately before
    clicking it and stops when none are left unticked, so a fake that always
    reported every box as unticked never let it finish - it just clicked until
    it ran out of attempts.

    The ticking itself happens through the browser's own input pipeline, and
    that is covered end to end by test_page_driver.py against a live page.
    What is checked HERE, with no browser at all, is the decision layer:
    whether this is the right page, and what happens when a box will not tick.
    """

    def __init__(self, boxes, labels, ok=True, stuck=None):
        super().__init__(boxes)
        self.labels = labels
        self.stuck = set(stuck or [])
        self.ok = ok
        self.on = set()
        self.clicks = []

    # -- what Playwright's page offers --------------------------------------
    @property
    def mouse(self):
        page = self

        class _Mouse:
            def click(self, x, y):
                page.clicks.append((x, y))
                # y encodes which row was aimed at, the way the points say.
                idx = (y - 20) // 30
                if 0 <= idx < len(page.labels):
                    name = page.labels[idx]
                    if name not in page.stuck:
                        page.on.add(name)
        return _Mouse()

    def evaluate(self, js, args=None):
        if not self.ok:
            return {"ok": False, "reason": "heading not found"}

        # "Bring one option into view and tell me where it is." A real page
        # scrolls; this one has nowhere to scroll to, so the box is always
        # reachable and its position is wherever it already was.
        if "Bring one option into view" in str(js):
            name = (args or {}).get("label")
            if name not in self.labels:
                return {"ok": False}
            i = self.labels.index(name)
            return {"ok": True, "x": 10, "y": 20 + i * 30, "onScreen": True,
                    "ticked": name in self.on, "under": "input"}

        if "Which of them are ticked now" in str(js):
            return {"ok": True, "states": [
                {"label": name, "ticked": name in self.on}
                for name in self.labels]}
        return {"ok": True, "count": len(self.labels), "boxes": [
            {"label": name, "ticked": name in self.on, "x": 10,
             "y": 20 + i * 30, "sized": True}
            for i, name in enumerate(self.labels)]}



REAL_LABELS = [
    "Fulfillment base rate and surcharges",
    "Sales Data",
    "Storage Fee base rate and surcharges",
    "Return and refund fees",
    "Referral and closing fees",
    "Advertising Spend Data",
]

section("The real page is recognised and all six reported ticked")

boxes = [FakeBox() for _ in range(6)]
res = SKU.tick_every_option(OptBoxPage(boxes, REAL_LABELS), note)
check("it accepts the page", (res["total"], res["ticked"]), (6, 6))

section("A box that will not tick stops before requesting")

try:
    SKU.tick_every_option(
        OptBoxPage([FakeBox() for _ in range(6)], REAL_LABELS,
                   stuck=["Sales Data"]), note)
    stopped, why = False, ""
except RuntimeError as exc:
    stopped, why = True, str(exc)
check("a stuck box is fatal", stopped, True)
check("and the missing column is named", "Sales Data" in why, True)
check("and nothing was requested", "nothing was requested" in why.lower(), True)

section("A page wearing the same shape but different words is refused")

boxes = [FakeBox() for _ in range(6)]
try:
    SKU.tick_every_option(
        OptBoxPage(boxes, ["Send me email", "Remember me", "Accept cookies",
                           "Share data", "Opt in", "Agree"]), note)
    stopped, why = False, ""
except RuntimeError as exc:
    stopped, why = True, str(exc)
check("six tick boxes alone are not enough", stopped, True)
check("nothing was ticked", any(b.checked for b in boxes), False)
check("and it says nothing was requested",
      "nothing was requested" in why.lower(), True)

section("A missing heading stops the job")

try:
    SKU.tick_every_option(OptBoxPage([FakeBox()], [], ok=False), note)
    stopped = False
except RuntimeError as exc:
    stopped = "nothing was requested" in str(exc).lower()
check("a page without the heading is refused", stopped, True)

section("This report needs no recorded setup")

ready, why = W.report_ready("fees-preview")
check("it is ready without selectors.json", ready, True)
check("the transaction report still needs setup",
      W.report_ready("date-range-transactions")[0], False)
check("it is driven, not recorded",
      W.REPORTS["fees-preview"].get("driver"), "sku-economics")
check("so there is no single country to choose",
      W.REPORTS["fees-preview"]["needsMarketplace"], False)

section("The named range is part of a job's identity")

# A scratch store. The first version of this test wrote into the helper's real
# jobs.json, which put two invented jobs in front of the user.
import tempfile                                   # noqa: E402
_store = W.JobStore()
_store.path = Path(tempfile.mkdtemp()) / "jobs.json"
_store._jobs, _store._order = {}, []

j1 = _store.create("fees-preview", "2026-09-18", "2026-11-13",
                   date_range="Next 30 days")
j2 = _store.create("fees-preview", "2026-09-18", "2026-11-13",
                   date_range="Next 30 days")
j3 = _store.create("fees-preview", "2026-09-18", "2026-11-13",
                   date_range="Next 7 days")
check("the same range is not requested twice", j2.get("reused"), True)
check("a different range is a different report", j3.get("reused"), False)

section("A blank range falls back rather than reaching the page")

_before = W.load_settings()
saved = W.save_settings({"skuDateRange": "   "})
# Against the default itself, not a copy of it: a test that repeats the value
# only proves the string was typed twice.
check("blank falls back to the default",
      saved["skuDateRange"], W.DEFAULT_SETTINGS["skuDateRange"])
check("and the default is the one that carries the app's own dates",
      W.DEFAULT_SETTINGS["skuDateRange"], "Custom date range")
saved = W.save_settings({"skuDateRange": "Next 7 days"})
check("a real choice is kept", saved["skuDateRange"], "Next 7 days")
W.save_settings(_before)          # exactly as it was found

section("A forecast window starts tomorrow, not today")

import datetime as _dt                                   # noqa: E402
_t = _dt.date(2026, 9, 22)
_f, _to = W.range_for("fees-preview", _t)
check("it starts the day after today", _f, "2026-09-23")
check("and runs the full horizon from there", _to, "2026-11-17")
check("so today - already part-spent - is not a whole day in the forecast",
      _f > _t.isoformat(), True)

_hf, _ht = W.range_for("date-range-transactions", _t)
check("a HISTORICAL window still ends today", _ht, "2026-09-22")
check("and looks backwards", _hf < _ht, True)


section("Finding OUR row in the Generated Reports list")

# The list prints "9/22/26"; the form was given "09/22/2026". Neither string
# contains the other, which is why a finished report sat in the list unseen
# while the page was reloaded over and over.
_ROW = "9/22/26 - 10/5/26 9/21/2026, 22:31 GMT+8 Ready Download"

check("a row is recognised by the dates it prints",
      SKU._row_is_ours(_ROW, None, "Custom date range",
                       "2026-09-22", "2026-10-05"), True)
check("a row for other dates is not ours",
      SKU._row_is_ours(_ROW, None, "Custom date range",
                       "2026-11-01", "2026-11-30"), False)
check("a tag still decides when there is one",
      SKU._row_is_ours(_ROW + " acp-10c6819b", "acp-10c6819b",
                       "Custom date range", None, None), True)
check("and a tag that is not there means not ours",
      SKU._row_is_ours(_ROW, "acp-10c6819b", "Custom date range",
                       "2026-09-22", "2026-10-05"), False)
check("a NAMED range is still matched by its name",
      SKU._row_is_ours("Next 30 days Ready Download", None,
                       "Next 30 days", None, None), True)

section("An untagged row must also be NEW")

# Two runs for the same dates produce two rows with identical text. Downloading
# the older one would present figures from another day as today's.
check("a second identical row counts as new",
      SKU._is_new_row(_ROW, {_ROW: 1}, {_ROW: 2}), True)
check("the row that was already there does not",
      SKU._is_new_row(_ROW, {_ROW: 1}, {_ROW: 1}), False)
check("a row that did not exist before is new",
      SKU._is_new_row(_ROW, {}, {_ROW: 1}), True)


section("A failed job that already asked Amazon is RESUMABLE")

# Saving a ticket made every failed attempt block the next request: pressing
# the button said "Already running" with no browser open and nothing running.
# A job that is genuinely going is left alone; one that stopped after the
# report was requested is picked up instead.
import tempfile as _tf                                   # noqa: E402
_s = W.JobStore()
_s.path = Path(_tf.mkdtemp()) / "jobs.json"
_s._jobs, _s._order = {}, []

_a = _s.create("fees-preview", "2026-09-23", "2026-11-17",
               date_range="Custom date range")
check("the first request is new", _a.get("reused"), False)

_live = _s.create("fees-preview", "2026-09-23", "2026-11-17",
                  date_range="Custom date range")
check("while it is running, a second is refused", _live.get("reused"), True)
check("and it is NOT offered as resumable", _live.get("resumable"), False)

# It fails, but a report was requested before it did.
_s.update(_a["jobId"], status="failed", ticket={"tag": "acp-1", "requestedAt": 1})
_after = _s.create("fees-preview", "2026-09-23", "2026-11-17",
                   date_range="Custom date range")
check("afterwards it is still matched", _after.get("reused"), True)
check("and IS offered as resumable, so the report can be collected",
      _after.get("resumable"), True)

# A failure with no ticket never reached Amazon, so a fresh request is right.
_b = _s.create("fees-preview", "2026-01-01", "2026-01-31",
               date_range="Custom date range")
_s.update(_b["jobId"], status="failed")
_fresh = _s.create("fees-preview", "2026-01-01", "2026-01-31",
                   date_range="Custom date range")
check("a failure with no ticket does not block a new request",
      _fresh.get("reused"), False)


section("Which of the six options a report actually contains")

# The driver ticks all six. A tick that does not register produces a file short
# of whole groups of columns, and nothing said so: the app showed "Needs a
# required input" against Net sales, Advertising and Storage with no way to
# tell the cause was a box that never took.
import tempfile as _tf2                                  # noqa: E402

def _csv_with(header_cols):
    f = Path(_tf2.mkdtemp()) / "r.csv"
    f.write_text(",".join(header_cols) + "\nUS,09/22/2026,10/05/2026\n",
                 encoding="utf-8")
    return f

_full = _csv_with([
    "Amazon store", "Start date", "End date", "MSKU",
    "Base fulfillment fee total", "Net sales", "Monthly inventory storage fee total",
    "Returns processing fee for Apparel and Shoes total", "Referral fee total",
    "Sponsored Products charge total"])
_p, _a = W.option_groups_in(_full)
check("a complete report shows all six", len(_p), 6)
check("and nothing absent", _a, [])

_thin = _csv_with([
    "Amazon store", "Start date", "End date", "MSKU",
    "Base fulfillment fee total", "FBA fulfillment fees total"])
_p2, _a2 = W.option_groups_in(_thin)
check("a fulfilment-only report shows one", _p2, ["Fulfillment base rate and surcharges"])
check("and names the five that are missing", len(_a2), 5)
check("including Sales Data, which Net sales depends on",
      "Sales Data" in _a2, True)

_missing = W.option_groups_in(Path(_tf2.mkdtemp()) / "not-there.csv")
check("an unreadable file claims nothing is present", _missing[0], [])
check("and reports every group as absent", len(_missing[1]), 6)


section("A download the browser finished but never handed over")

# The transfer completes, the window that started it closes, and Playwright has
# no page left to hand the file through. The bytes are on disk the whole time -
# under a bare GUID with a .tmp suffix, in whatever folder the profile happens
# to point at, which is the account's own Downloads and not this one.
import json as _json                                     # noqa: E402
import os as _os                                         # noqa: E402
import tempfile as _tmp                                  # noqa: E402
import time as _time                                     # noqa: E402
import sku_economics as SKU                              # noqa: E402

_HEADER = """Amazon store,Start date,End date,Currency code,Parent ASIN,Child ASIN,MSKU,Net sales
"""
_ROW = """US,09/23/2026,10/05/2026,USD,A,B,SKU-1,12.50
"""

_dl = Path(_tmp.mkdtemp())
_old = _dl / "an-older-export.csv"
_old.write_text(_HEADER + _ROW, encoding="utf-8")
_os.utime(_old, (1_000_000, 1_000_000))       # long before the button

_cut = _time.time()
_time.sleep(0.05)

# Things that appeared since, but are not the report.
(_dl / "shopping-list.csv").write_text("""item,qty
milk,2
""", encoding="utf-8")
(_dl / "9f2c.tmp.crdownload").write_text(_HEADER, encoding="utf-8")

# And the report itself, named after nothing at all.
_real = _dl / "dcf3aea5-1482-4a0d-ab3a-49963e64371e.tmp"
_real.write_text(_HEADER + _ROW, encoding="utf-8")

check("a bare GUID with the report's header is recognised",
      SKU._reads_like_the_report(_real), True)
check("and a CSV that is not the report is not",
      SKU._reads_like_the_report(_dl / "shopping-list.csv"), False)

_want = Path(_tmp.mkdtemp()) / "sku-economics-collected.csv"
_got = SKU._claim_stray([_dl], _cut, _want)
check("the stray is collected", _got, _want)
check("with its contents intact",
      "SKU-1" in _want.read_text(encoding="utf-8"), True)
check("and is not left lying in the download folder", _real.exists(), False)
check("a part-written transfer is never taken",
      (_dl / "9f2c.tmp.crdownload").exists(), True)
check("and the older export is left alone", _old.exists(), True)

check("an empty folder yields nothing",
      SKU._claim_stray([Path(_tmp.mkdtemp())], _time.time(), _want), None)

# How sure it has to be depends on WHERE it is looking. Insisting on the
# report's header everywhere threw away a download that had arrived perfectly
# well into this program's own folder - a browser test caught it.
_mine = Path(_tmp.mkdtemp())
_cut2 = _time.time()
_time.sleep(0.05)
_plain = _mine / "whatever-chromium-called-it"
_plain.write_text("""a,b
1,2
""", encoding="utf-8")

_dest = Path(_tmp.mkdtemp()) / "taken.csv"
check("in this program's own folder, anything new is the download",
      SKU._claim_stray([_mine], _cut2, _dest, own=_mine), _dest)

_plain2 = _mine / "whatever-chromium-called-it"
_plain2.write_text("""a,b
1,2
""", encoding="utf-8")
check("but in a folder shared with the seller it must prove what it is",
      SKU._claim_stray([_mine], _cut2, _dest.with_name("no.csv")), None)
check("and their file is left exactly where it was", _plain2.exists(), True)

_stale = Path(_tmp.mkdtemp())
(_stale / "yesterdays.tmp").write_text(_HEADER + _ROW, encoding="utf-8")
check("a report older than the click is not claimed",
      SKU._claim_stray([_stale], _time.time() + 60, _stale / "x.csv"), None)


section("Where the browser was told to put its downloads")

# downloads_path tells Playwright where to KEEP a download once it has been
# handed over. It does not tell Chromium where to write one: a profile that has
# been used before carries its own download folder, and that is where the bytes
# land. Every real download so far went to the account's Downloads folder under
# a GUID, which is why none of them were ever found.
_prof = Path(_tmp.mkdtemp())
(_prof / "Default").mkdir()
_prefs = _prof / "Default" / "Preferences"
_prefs.write_text(_json.dumps({"download": {"default_directory": str(_dl),
                                            "prompt_for_download": True}}),
                  encoding="utf-8")
_out = Path(_tmp.mkdtemp())

_dirs = SKU._download_dirs(_prof, _out)
check("the folder the profile actually uses is searched", _dl in _dirs, True)
check("and so is the one this program asked for", _out in _dirs, True)

SKU._point_downloads_at(_prof, _out)
_after = _json.loads(_prefs.read_text(encoding="utf-8"))
check("the profile is repointed at this program's folder",
      _after["download"]["default_directory"], str(_out))
check("and is not asked where to save each time",
      _after["download"]["prompt_for_download"], False)

_fresh = Path(_tmp.mkdtemp())
SKU._point_downloads_at(_fresh, _out)
check("a profile with no preferences yet is left alone",
      (_fresh / "Default" / "Preferences").exists(), False)


section("Deleting a report")

# The reports table fills up with attempts, most of them failures, and there
# was no way to clear any of them out. Deleting one has to remove the record,
# remove the file the helper saved, and touch nothing else.
import tempfile as _t3                                   # noqa: E402
from unittest.mock import patch as _patch                 # noqa: E402

_home = Path(_t3.mkdtemp())
with _patch.object(W, "HERE", _home):
    _st = W.JobStore()
    _a = _st.create("fees-preview", "2026-09-23", "2026-10-05",
                    marketplace="US", date_range="Custom date range")
    _b = _st.create("fees-preview", "2026-11-01", "2026-11-14",
                    marketplace="US", date_range="Custom date range")

    check("two reports to start with", len(_st.list()), 2)

    # A report that has just been asked for is still running. The guard caught
    # this when the test tried to delete one, which is what it is for.
    check("a report that has only just been queued cannot be deleted",
          (_st.remove(_a["jobId"]) or {}).get("busy"), "queued")
    check("and is still there", len(_st.list()), 2)

    _st.update(_a["jobId"], status="complete")
    _gone = _st.remove(_a["jobId"])
    check("the record comes back so its file can be dealt with",
          _gone["jobId"], _a["jobId"])
    check("and is no longer listed", len(_st.list()), 1)
    check("the other one is untouched", _st.list()[0]["jobId"], _b["jobId"])
    check("deleting it twice is not an error, just nothing",
          _st.remove(_a["jobId"]), None)

    # And again once it is properly under way, not merely queued.
    _st.update(_b["jobId"], status="generating")
    _busy = _st.remove(_b["jobId"])
    check("a report still running is refused", _busy.get("busy"), "generating")
    check("and it survives", len(_st.list()), 1)

    # It survives a restart, which is the whole point of writing the file.
    _st.update(_b["jobId"], status="failed")
    _st.remove(_b["jobId"])
    check("an empty list is written out, not just held in memory",
          len(W.JobStore().list()), 0)


section("Which file a delete is allowed to remove")

_ours = Path(_t3.mkdtemp())
_theirs = Path(_t3.mkdtemp())

with _patch.object(W, "DOWNLOAD_DIR", _ours):
    _mine = _ours / "sku-economics-custom-date-range-20260922-161900.csv"
    _mine.write_text("Amazon store,MSKU\n", encoding="utf-8")
    _d, _k = W.delete_downloaded_file({"filePath": str(_mine)})
    check("a file this program saved is deleted", _d, _mine.name)
    check("and nothing is reported as kept", _k, None)
    check("it really is gone", _mine.exists(), False)

    # The seller's own Downloads folder. A rescued report still names its
    # original home, and that file is not this program's to delete.
    _yours = _theirs / "dcf3aea5-1482-4a0d-ab3a-49963e64371e.tmp"
    _yours.write_text("Amazon store,MSKU\n", encoding="utf-8")
    _d2, _k2 = W.delete_downloaded_file({"filePath": str(_yours)})
    check("a file somewhere else is not deleted", _d2, None)
    check("it is still there", _yours.exists(), True)
    check("and the reason is given", "left alone" in (_k2 or ""), True)

    check("a report that never downloaded anything deletes cleanly",
          W.delete_downloaded_file({"filePath": None}), (None, None))
    check("a file already gone is not an error",
          W.delete_downloaded_file({"filePath": str(_ours / "not-there.csv")}),
          (None, None))


section("Deleting a report, over the wire")

import threading as _th                                   # noqa: E402
import urllib.error as _uerr                              # noqa: E402
import urllib.request as _ureq                            # noqa: E402
from http.server import ThreadingHTTPServer as _THS       # noqa: E402

_srv_home = Path(_t3.mkdtemp())
_srv_dl = Path(_t3.mkdtemp())

with _patch.object(W, "HERE", _srv_home), \
     _patch.object(W, "DOWNLOAD_DIR", _srv_dl), \
     _patch.object(W, "JOBS", W.JobStore()), \
     _patch.object(W, "TOKEN", "test-token-not-the-real-one"):

    _httpd = _THS(("127.0.0.1", 0), W.Handler)
    _port = _httpd.server_address[1]
    _t = _th.Thread(target=_httpd.serve_forever, daemon=True)
    _t.start()

    def _post(path, token="test-token-not-the-real-one"):
        req = _ureq.Request("http://127.0.0.1:%d%s" % (_port, path),
                            data=b"{}", method="POST",
                            headers={"Content-Type": "application/json",
                                     "X-Worker-Token": token})
        try:
            with _ureq.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except _uerr.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(body)
            except Exception:
                return e.code, {"raw": body[:120]}

    try:
        _j = W.JOBS.create("fees-preview", "2026-09-23", "2026-10-05",
                           marketplace="US", date_range="Custom date range")
        _f = _srv_dl / "sku-economics-custom-date-range-20260922-161900.csv"
        _f.write_text("""Amazon store,MSKU
US,SKU-1
""", encoding="utf-8")
        W.JOBS.update(_j["jobId"], status="complete",
                      filePath=str(_f), fileName=_f.name)

        _code, _body = _post("/api/jobs/%s/delete" % _j["jobId"], token="wrong")
        check("a delete without the right token is refused", _code, 401)
        check("and nothing was deleted", _f.exists(), True)

        _code, _body = _post("/api/jobs/does-not-exist/delete")
        check("deleting a report that is not there says so", _code, 404)

        W.JOBS.update(_j["jobId"], status="generating")
        _code, _body = _post("/api/jobs/%s/delete" % _j["jobId"])
        check("a report still generating is refused", _code, 409)
        check("with a reason the app can show",
              "generating" in _body.get("error", ""), True)
        check("and its file is untouched", _f.exists(), True)

        W.JOBS.update(_j["jobId"], status="failed")
        _code, _body = _post("/api/jobs/%s/delete" % _j["jobId"])
        check("a finished report is deleted", _code, 200)
        check("the file goes with it", _body.get("fileDeleted"), _f.name)
        check("and it really is off the disk", _f.exists(), False)
        check("the report is no longer listed", len(W.JOBS.list()), 0)
        check("and the reply says imported figures are a separate thing",
              "still in the app" in _body.get("note", ""), True)
    finally:
        _httpd.shutdown()
        _httpd.server_close()


section("The archive: every report ever downloaded")

import archive as AR                                      # noqa: E402

_arc_home = Path(_t3.mkdtemp())
_arc = _arc_home / "reports.db"

# The app keeps money as a BigInt scaled by 10^10, because the Fees & Economics
# Preview carries ten decimal places and truncating to cents shifts a file
# total. It crosses to the helper tagged, so nothing can read it back as a
# float that merely looks close.
_SCALE = 10

def _money(amount):
    from decimal import Decimal
    return {"$dec": str(int(Decimal(str(amount)) * (10 ** _SCALE)))}

def _mkreport(name, when, sales, job_id=None):
    f = _arc_home / name
    # DIFFERENT bytes per report. Writing identical files made two downloads
    # dedupe into one, which quietly turned the overlap test into a test of
    # nothing - and then uncovered a real bug underneath it.
    f.write_text("Amazon store,MSKU,Net sales\nUS,SKU-1,%s\n" % sales,
                 encoding="utf-8")
    job = {"jobId": job_id or ("job-" + name), "reportType": "fees-preview",
           "marketplace": "US", "dateRange": "Custom date range",
           "coverageFrom": "2026-09-23", "coverageTo": "2026-10-05",
           "filePath": str(f), "fileName": name, "finishedAt": when}
    rid = AR.record_report(_arc, job, ["Sales Data"], [], money_scale=10)
    AR.record_rows(_arc, rid, [
        {"store": "US", "msku": "SKU-1", "start": "2026-09-23",
         "end": "2026-10-05", "currency": "USD", "unitsSold": 10,
         "netSales": _money(sales), "sourceLine": 2,
         "fees": {"Referral fee": {"total": _money(150)}}}], money_scale=10)
    return rid

_r1 = _mkreport("first.csv", "2026-09-22T08:00:00+00:00", 1000.0)
check("a report is recorded", bool(_r1), True)

# Pressing Retry re-imports the same file. That is not a second report.
_again = AR.record_report(
    _arc, {"jobId": "job-first.csv", "reportType": "fees-preview",
           "filePath": str(_arc_home / "first.csv"), "fileName": "first.csv",
           "finishedAt": "2026-09-22T09:00:00+00:00"}, [], [])
check("the same file keeps its first id", _again, _r1)

_db = AR.connect(_arc)
check("so there is one report, not two",
      _db.execute("SELECT COUNT(*) FROM reports").fetchone()[0], 1)
_db.close()

# Re-pushing rows corrects the archive; it must not double it.
AR.record_rows(_arc, _r1, [
    {"store": "US", "msku": "SKU-1", "start": "2026-09-23",
     "end": "2026-10-05", "netSales": _money(1000)}], money_scale=10)
_db = AR.connect(_arc)
check("re-sending rows replaces rather than appends",
      _db.execute("SELECT COUNT(*) FROM report_rows").fetchone()[0], 1)
_db.close()


section("Overlapping reports keep every reading")

_r2 = _mkreport("second.csv", "2026-09-22T16:00:00+00:00", 1111.0)
_db = AR.connect(_arc)
check("both readings of the same days are kept",
      _db.execute("SELECT COUNT(*) FROM report_rows").fetchone()[0], 2)
check("but the current view shows one",
      _db.execute("SELECT COUNT(*) FROM current_report_rows").fetchone()[0], 1)
check("and it is the newer download",
      _db.execute("SELECT net_sales_scaled FROM current_report_rows").fetchone()[0],
      11110000000000)
check("the older reading is still there to ask about",
      sorted(r[0] for r in _db.execute("SELECT net_sales_scaled FROM report_rows")),
      [10000000000000, 11110000000000])
_db.close()

# Deleting the newer must fall back to the older, not leave a hole.
check("a report can be forgotten by job id",
      AR.forget_report(_arc, "job-second.csv"), True)
_db = AR.connect(_arc)
check("its rows go with it",
      _db.execute("SELECT COUNT(*) FROM report_rows").fetchone()[0], 1)
check("and the view falls back to the earlier reading",
      _db.execute("SELECT net_sales_scaled FROM current_report_rows").fetchone()[0],
      10000000000000)
_db.close()


section("One report, several jobs")

# Ask for the same period twice and Amazon can hand back identical bytes. That
# is one report - but it was linked to whichever job recorded it LAST, so
# deleting that job deleted the archived report out from under the other job
# that still pointed at it. Both lost their history.
_shared = _arc_home / "identical.csv"
_shared.write_text("""Amazon store,MSKU,Net sales
US,SKU-7,42.00
""", encoding="utf-8")

def _link(job_id):
    return AR.record_report(_arc, {
        "jobId": job_id, "reportType": "fees-preview", "marketplace": "US",
        "coverageFrom": "2026-11-01", "coverageTo": "2026-11-14",
        "filePath": str(_shared), "fileName": "identical.csv",
        "finishedAt": "2026-09-22T20:00:00+00:00"}, [], [])

_a = _link("job-alpha")
_b = _link("job-beta")
check("identical bytes are one report, not two", _a, _b)
check("but both jobs are remembered",
      sorted(AR.jobs_for_report(_arc, _a)), ["job-alpha", "job-beta"])

AR.record_rows(_arc, _a, [
    {"store": "US", "msku": "SKU-7", "start": "2026-11-01",
     "end": "2026-11-14", "netSales": 42.0}])

check("deleting one job does not forget the report",
      AR.forget_report(_arc, "job-alpha"), False)
_db = AR.connect(_arc)
check("the rows are still there for the other job",
      _db.execute("SELECT COUNT(*) FROM report_rows WHERE msku = 'SKU-7'")
         .fetchone()[0], 1)
_db.close()
check("only one job is left pointing at it",
      AR.jobs_for_report(_arc, _a), ["job-beta"])

check("deleting the last one does forget it",
      AR.forget_report(_arc, "job-beta"), True)
_db = AR.connect(_arc)
check("and now the rows are gone",
      _db.execute("SELECT COUNT(*) FROM report_rows WHERE msku = 'SKU-7'")
         .fetchone()[0], 0)
_db.close()


section("The archive never becomes the reason an import fails")

check("rows for a report that is not there are refused, not orphaned",
      AR.record_rows(_arc, "no-such-report", [{"msku": "X"}]), 0)
check("an unwritable path reports failure rather than raising",
      AR.record_report(Path("Z:/nowhere/at/all/reports.db"),
                       {"jobId": "j", "reportType": "t"}, [], []), None)
check("and a summary of nothing is not an error",
      AR.summary(Path(_t3.mkdtemp()) / "absent.db")["available"], False)

# Amazon's exports have carried 20, 50 and 53 columns in one week. Whatever the
# app parsed is kept whole, so a column nobody anticipated is still there.
_r3 = _mkreport("wide.csv", "2026-09-22T18:00:00+00:00", 1.0, job_id="job-wide")
AR.record_rows(_arc, _r3, [{
    "store": "US", "msku": "SKU-9", "start": "2026-09-23", "end": "2026-10-05",
    "netSales": _money("9551.4733333297"),
    "fees": {"A brand new Amazon fee": {"total": _money("3.5")}},
    "somethingNobodyPlannedFor": "kept anyway"}], money_scale=10)
_db = AR.connect(_arc)
_raw = json.loads(_db.execute(
    "SELECT raw FROM report_rows WHERE msku = 'SKU-9'").fetchone()[0])
check("an unanticipated column survives",
      _raw["somethingNobodyPlannedFor"], "kept anyway")
check("and so does a fee nobody has seen before",
      _raw["fees"]["A brand new Amazon fee"]["total"], _money("3.5"))

# Ten decimal places, which is the whole reason money is not a float here.
check("a ten-decimal amount is stored exactly, not nearly",
      _db.execute("SELECT net_sales_scaled FROM report_rows WHERE msku = 'SKU-9'")
         .fetchone()[0], 95514733333297)
check("and the scale it was written at is recorded",
      _db.execute("SELECT money_scale FROM reports WHERE report_id = ?",
                  (_r3,)).fetchone()[0], 10)

from decimal import Decimal as _D
_back = _D(_db.execute(
    "SELECT net_sales_scaled FROM report_rows WHERE msku = 'SKU-9'"
).fetchone()[0]) / (10 ** 10)
check("so the original amount comes back unchanged",
      str(_back), "9551.4733333297")
_db.close()

_sum = AR.summary(_arc)
check("the summary counts what is held", (_sum["reports"], _sum["rows"]), (2, 2))
check("and every report it counts has rows behind it",
      _sum["rows"] > 0 and _sum["reports"] > 0, True)
check("and says it is available", _sum["available"], True)


section("Pushing parsed rows to the archive, over the wire")

# The helper has no CSV parser and must not grow one, so the rows come from
# the app. This is that hand-off: the shape it sends, what comes back, and
# what happens when it is asked for something it cannot do.
_ah = Path(_t3.mkdtemp())
_adl = Path(_t3.mkdtemp())
_adb = _ah / "reports.db"

with _patch.object(W, "HERE", _ah), \
     _patch.object(W, "DOWNLOAD_DIR", _adl), \
     _patch.object(W, "ARCHIVE_DB", _adb), \
     _patch.object(W, "JOBS", W.JobStore()), \
     _patch.object(W, "TOKEN", "archive-test-token"):

    _srv = _THS(("127.0.0.1", 0), W.Handler)
    _aport = _srv.server_address[1]
    _th.Thread(target=_srv.serve_forever, daemon=True).start()

    def _apost(path, body, token="archive-test-token"):
        req = _ureq.Request("http://127.0.0.1:%d%s" % (_aport, path),
                            data=json.dumps(body).encode("utf-8"),
                            method="POST",
                            headers={"Content-Type": "application/json",
                                     "X-Worker-Token": token})
        try:
            with _ureq.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except _uerr.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": raw[:120]}

    def _aget(path, token="archive-test-token"):
        req = _ureq.Request("http://127.0.0.1:%d%s" % (_aport, path),
                            headers={"X-Worker-Token": token})
        with _ureq.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))

    try:
        _f = _adl / "sku-economics-over-the-wire.csv"
        _f.write_text("""Amazon store,MSKU,Net sales
US,SKU-1,1000.00
""", encoding="utf-8")
        _jb = W.JOBS.create("fees-preview", "2026-09-23", "2026-10-05",
                            marketplace="US", date_range="Custom date range")
        W.JOBS.update(_jb["jobId"], status="importing", filePath=str(_f),
                      fileName=_f.name, coverageFrom="2026-09-23",
                      coverageTo="2026-10-05")

        _rows = [{"store": "US", "msku": "SKU-1", "start": "2026-09-23",
                  "end": "2026-10-05", "currency": "USD", "unitsSold": 10,
                  "netSales": {"$dec": "95514733333297"},
                  "fees": {"Referral fee": {"total": {"$dec": "1500000000000"}}}}]

        _c, _b = _apost("/api/jobs/%s/archive-rows" % _jb["jobId"],
                        {"rows": _rows}, token="wrong")
        check("a push without the right token is refused", _c, 401)

        # A REFUSED request has to read the body it is refusing. Without that
        # the client is still writing when the socket closes, and the reset it
        # gets back is reported as a network failure rather than as the 401
        # that was actually sent - so a wrong token looks like a dead helper.
        # It only showed up once bodies grew past the socket buffer.
        _big = [dict(_rows[0], msku="SKU-%d" % i) for i in range(4000)]
        _c, _b = _apost("/api/jobs/%s/archive-rows" % _jb["jobId"],
                        {"rows": _big}, token="wrong")
        check("and a large one is refused cleanly, not by dropping the line",
              _c, 401)
        check("with the reason, which a reset connection could not carry",
              "token" in (_b.get("error") or ""), True)

        _c, _b = _apost("/api/jobs/nope/archive-rows", {"rows": _rows})
        check("a push for a report that is not there says so", _c, 404)

        _c, _b = _apost("/api/jobs/%s/archive-rows" % _jb["jobId"],
                        {"rows": "not a list"})
        check("rows that are not a list are refused", _c, 400)

        # A report recorded before the archive existed has no archive id. The
        # rows must not be dropped on the floor: record the report, then store.
        check("the job has no archive id yet",
              W.JOBS.get(_jb["jobId"]).get("archiveId"), None)
        _c, _b = _apost("/api/jobs/%s/archive-rows" % _jb["jobId"],
                        {"rows": _rows, "moneyScale": 10})
        check("the push succeeds anyway", _c, 200)
        check("by recording the report first",
              bool(W.JOBS.get(_jb["jobId"]).get("archiveId")), True)
        check("and it stores every row sent",
              (_b["rowsSent"], _b["rowsStored"]), (1, 1))

        _summary = _aget("/api/archive")
        check("the archive reports what it holds",
              (_summary["reports"], _summary["rows"]), (1, 1))

        # What the app sent is what came back out, fees and all.
        _db = AR.connect(_adb)
        _kept = json.loads(_db.execute("SELECT raw FROM report_rows").fetchone()[0])
        _db.close()
        check("the row survives the round trip intact", _kept, _rows[0])

        _db2 = AR.connect(_adb)
        check("and its money lands in the archive exactly",
              _db2.execute("SELECT net_sales_scaled FROM report_rows")
                  .fetchone()[0], 95514733333297)
        check("at the scale the app said it used",
              _db2.execute("SELECT money_scale FROM reports").fetchone()[0], 10)
        _db2.close()

        # And deleting the report forgets it here too.
        W.JOBS.update(_jb["jobId"], status="complete")
        _c, _b = _apost("/api/jobs/%s/delete" % _jb["jobId"], {})
        check("deleting the report reports the archive too", _b["archived"], True)
        check("and the archive is empty again",
              _aget("/api/archive")["reports"], 0)
    finally:
        _srv.shutdown()
        _srv.server_close()


section("The app's state, shared by every browser on the machine")

_sh = Path(_t3.mkdtemp())
_sdb = _sh / "reports.db"

check("an empty database offers revision 0, not an error",
      AR.read_state(_sdb), {"revision": 0, "body": None, "updatedAt": None})

_w1 = AR.write_state(_sdb, {"imports": [{"id": "a"}]}, 0, by="Edge")
check("the first save lands at revision 1", _w1["revision"], 1)
_w2 = AR.write_state(_sdb, {"imports": [{"id": "a"}, {"id": "b"}]}, 1, by="Edge")
check("and the next at revision 2", _w2["revision"], 2)

_read = AR.read_state(_sdb)
check("what comes back is what went in", len(_read["body"]["imports"]), 2)
check("and it says who wrote it", _read["updatedBy"], "Edge")


section("Two windows cannot overwrite each other in silence")

# Both windows loaded revision 2. Edge saves. Chrome then saves what it loaded
# - and without the revision, Edge's work would simply disappear.
AR.write_state(_sdb, {"imports": [{"id": "a"}, {"id": "b"}, {"id": "edge"}]},
               2, by="Edge")
_late = AR.write_state(_sdb, {"imports": [{"id": "a"}, {"id": "b"},
                                          {"id": "chrome"}]}, 2, by="Chrome")
check("the second window is refused", _late.get("conflict"), True)
check("nothing of the first window's was lost",
      [i["id"] for i in AR.read_state(_sdb)["body"]["imports"]],
      ["a", "b", "edge"])
check("and the refusal hands back what IS stored",
      [i["id"] for i in _late["body"]["imports"]], ["a", "b", "edge"])

# Having seen it, the second window can deliberately save on top.
_onTop = AR.write_state(_sdb, {"imports": [{"id": "merged"}]},
                        _late["revision"], by="Chrome")
check("a deliberate save on top of it succeeds", _onTop["ok"], True)
check("the replaced version is still in the history",
      any(h["revision"] == 3 for h in AR.state_history(_sdb)), True)
check("and the history says which window wrote each one",
      sorted({h["updatedBy"] for h in AR.state_history(_sdb)}),
      ["Chrome", "Edge"])


section("The state document, over the wire")

_stateHome = Path(_t3.mkdtemp())
with _patch.object(W, "HERE", _stateHome), \
     _patch.object(W, "ARCHIVE_DB", _stateHome / "reports.db"), \
     _patch.object(W, "JOBS", W.JobStore()), \
     _patch.object(W, "TOKEN", "state-test-token"):

    _ssrv = _THS(("127.0.0.1", 0), W.Handler)
    _sport = _ssrv.server_address[1]
    _th.Thread(target=_ssrv.serve_forever, daemon=True).start()

    def _sreq(method, path, body=None, token="state-test-token"):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = _ureq.Request("http://127.0.0.1:%d%s" % (_sport, path),
                            data=data, method=method,
                            headers={"Content-Type": "application/json",
                                     "X-Worker-Token": token})
        try:
            with _ureq.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except _uerr.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": raw[:120]}

    try:
        _c, _b = _sreq("GET", "/api/state", token="wrong")
        check("reading the state needs the token", _c, 401)

        _c, _b = _sreq("GET", "/api/state")
        check("a fresh install has an empty document", (_c, _b["revision"]), (200, 0))

        # The app's money is a BigInt, tagged for transport. It has to survive
        # the state document exactly as it survives the archive.
        _doc = {"imports": [{"id": "i1", "name": "r.csv"}],
                "previews": [{"importId": "i1", "rows": [
                    {"msku": "SKU-1", "netSales": {"$dec": "95514733333297"}}]}]}

        _c, _b = _sreq("POST", "/api/state", {"body": _doc, "revision": 0,
                                              "by": "Edge"})
        check("the first save is accepted", (_c, _b["revision"]), (200, 1))

        _c, _b = _sreq("GET", "/api/state")
        check("and reads back whole", _b["body"], _doc)
        check("with its exact money untouched",
              _b["body"]["previews"][0]["rows"][0]["netSales"]["$dec"],
              "95514733333297")

        _c, _b = _sreq("POST", "/api/state", {"body": {"imports": []},
                                              "revision": 0, "by": "Chrome"})
        check("a stale save is refused with 409", _c, 409)
        check("and says so plainly", _b.get("conflict"), True)
        check("handing back the version that is stored",
              len(_b["body"]["imports"]), 1)

        _c, _b = _sreq("GET", "/api/state")
        check("the stored document is untouched by the refusal",
              len(_b["body"]["imports"]), 1)

        _c, _b = _sreq("POST", "/api/state", {"body": _doc})
        check("a save with no revision at all is refused", _c, 400)

        _c, _b = _sreq("POST", "/api/state", {"revision": 1})
        check("and so is one with no body", _c, 400)
    finally:
        _ssrv.shutdown()
        _ssrv.server_close()


print("\n" + "=" * 68)
section("Where this computer keeps its own things")

# An installer owns the folder it installs into and replaces it. Everything
# the helper builds or is given used to live there, so an update deleted a
# 400 MB environment, the access token, the signed-in Amazon session and the
# reports database - and setup had to be run again. It happened, going from
# 4.9.0 to 4.9.1 on a real installation.
import paths as PATHS                                     # noqa: E402

_po = Path(_t3.mkdtemp())
_pn = Path(_t3.mkdtemp())
os.environ["FBA_DATA_DIR"] = str(_pn)

(_po / "config.json").write_text('{"token":"abc","port":8765}', encoding="utf-8")
(_po / "reports.db").write_text("not really sqlite", encoding="utf-8")
(_po / "profile").mkdir()
(_po / "profile" / "Cookies").write_text("session", encoding="utf-8")

_r = PATHS.adopt(_po)
check("the access token moves out of the install folder",
      "config.json" in _r["moved"], True)
check("so does the database", "reports.db" in _r["moved"], True)
check("and the signed-in browser session", "profile" in _r["moved"], True)
check("which arrives intact",
      (_pn / "profile" / "Cookies").read_text(encoding="utf-8"), "session")
check("the old copy is gone", (_po / "config.json").exists(), False)

# A part-finished copy is the failure that actually happened: moving across
# drives copies then deletes, and one locked file left 124 MB in the new place
# and 11 files in the old, reporting nothing wrong either way.
check("nothing is left half-copied", list(_pn.glob("*.incoming")), [])

(_po / "settings.json").write_text("old", encoding="utf-8")
(_pn / "settings.json").write_text("newer", encoding="utf-8")
_r2 = PATHS.adopt(_po)
check("something already there is never overwritten",
      (_pn / "settings.json").read_text(encoding="utf-8"), "newer")
check("and is not claimed as moved", "settings.json" in _r2["moved"], False)

check("a second run has nothing left to do", PATHS.adopt(_po)["moved"], [])

_ps = Path(_t3.mkdtemp())
os.environ["FBA_DATA_DIR"] = str(_ps)
(_ps / "config.json").write_text("keep me", encoding="utf-8")
check("adopting a folder into itself changes nothing",
      PATHS.adopt(_ps)["moved"], [])
check("and leaves the file alone",
      (_ps / "config.json").read_text(encoding="utf-8"), "keep me")

print("passed %d   failed %d" % (PASS, FAIL))
if FAILURES:
    print("\nFAILURES")
    for f in FAILURES:
        print("  " + f)
print("=" * 68)
print("\nThese are automated tests of matching and navigation rules only.")
print("A real Amazon download is NOT covered and needs your login.\n")
sys.exit(1 if FAIL else 0)
