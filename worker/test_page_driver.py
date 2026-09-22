"""Drives the SKU Economics form against a stand-in page built like the real one.

Run:  python worker/test_page_driver.py

WHAT THIS PROVES, AND WHAT IT DOES NOT

testdata/cepreport-shape.html is not a copy of Amazon's page and holds no
Amazon data. It reproduces the one thing that kept breaking the driver: Seller
Central is built from web components, so the controls a person sees are
wrappers, and the real <input> lives inside each wrapper's shadow root. Four
separate bugs hid there, and every one of them looked like "the control could
not be found" on a page where the control was plainly visible:

  1. a shadow walk that never entered the root element's OWN shadow root, so
     every component looked empty;
  2. clicks aimed at the wrapper, which does not listen for them;
  3. each tick box counted twice - once as the component, once as the input
     inside it - so ticking it turned it back OFF;
  4. a block of tick boxes looked for ABOVE its heading, when it sits below.

The stand-in also copies the page's most useful habit: Generate Report stays
disabled until every option is ticked. That makes the button's own state the
end-to-end check, exactly as on the real page.

It proves the driver can work the SHAPE. It proves nothing about Amazon's live
markup, which needs a real login and is listed separately.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PAGE = (HERE / "testdata" / "cepreport-shape.html").as_uri()

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


def main() -> int:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        print("\n  NOT TESTED  Playwright is not installed, so the page driver "
              "was not exercised.\n  This is not a pass. Run: "
              "pip install -r worker/requirements.txt\n")
        return 0

    import tempfile

    import sku_economics as SKU

    notes: list[str] = []

    def progress(_status: str, detail: str) -> None:
        notes.append(detail)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(PAGE)
        page.wait_for_timeout(500)

        print("\n-- Every marketplace is ticked " + "-" * 29)
        count = SKU.pick_marketplace(page, progress, country="United States")
        check("one country chosen, not all of them", count, 1)

        print("\n-- The named range is chosen and read back " + "-" * 18)
        SKU.pick_date_range(page, "Next 30 days", progress)
        check("the control shows what was asked for",
              "next 30 days" in SKU._read_control(page, "Date Range").lower(),
              True)

        print("\n-- A range the page does not offer is refused " + "-" * 15)
        try:
            SKU.pick_date_range(page, "Next 3 weeks", progress)
            refused, why = False, ""
        except RuntimeError as exc:
            refused, why = True, str(exc)
        check("it stops rather than pick something else", refused, True)
        check("and it lists what the page does offer",
              "next 7 days" in why.lower(), True)

        print("\n-- Every configuration option is ticked " + "-" * 21)
        res = SKU.tick_every_option(page, progress)
        check("all six ticked", (res["total"], res["ticked"]), (6, 6))

        print("\n-- The right boxes, and only those " + "-" * 26)
        # Read the real inputs, not the driver's own report. Two things matter:
        # nothing was ticked twice (which would turn it back off and quietly
        # drop a column), and nothing outside the form was touched at all.
        states = page.evaluate("""() => {
          const out = {};
          const walk = (n, owner) => {
            for (const e of n.querySelectorAll('*')) {
              const mine = e.tagName === 'KAT-CHECKBOX'
                ? (e.closest('#feedback') ? 'decoy' : 'form') : owner;
              if (e.tagName === 'INPUT' && e.type === 'checkbox') {
                (out[owner] = out[owner] || []).push(e.checked);
              }
              if (e.shadowRoot) walk(e.shadowRoot, mine);
            }
          };
          walk(document, 'form');
          return out;
        }""")
        form = states.get("form", [])
        decoy = states.get("decoy", [])
        check("the six report options are all ticked",
              (len(form), all(form)), (6, True))
        check("the feedback widget's four were never touched",
              (len(decoy), any(decoy)), (4, False))

        # The countries hide behind a CLOSED shadow root, so there is no input
        # to look at from out here. Their state lives in a property, which is
        # the only thing a page like that exposes - and the only thing the
        # driver can set.
        countries = page.evaluate("""() => {
          const out = [];
          const walk = n => {
            for (const e of n.querySelectorAll('*')) {
              if (e.tagName === 'KAT-CLOSED-CHECKBOX') out.push(e.checked === true);
              if (e.shadowRoot) walk(e.shadowRoot);
            }
          };
          walk(document);
          return out;
        }""")
        # ONE country, because this page reports on one marketplace at a
        # time. Ticking all four was a misreading; the page will not accept it.
        check("exactly one closed-shadow country is ticked",
              (len(countries), countries.count(True)), (4, 1))

        print("\n-- The page itself confirms the form is valid " + "-" * 15)
        # The stand-in only enables Generate once all six are ticked, the same
        # way the real page does. So this is the end-to-end check.
        state = page.evaluate(SKU.GENERATE_JS, {"click": False})
        check("Generate Report is found", state.get("found"), True)
        check("and Amazon's own button says the form is complete",
              state.get("enabled"), True)

        print("\n-- The failure report describes the page, not the data " + "-" * 6)
        dump = SKU._dump(page)
        check("it names the section it saw",
              "Simplified Report Configuration Options" in dump, True)
        check("and it names the controls by their labels",
              "Marketplace" in dump and "Date Range" in dump, True)
        check("it carries no notes field contents",
              "acp-" in dump, False)

        browser.close()

    # ── the other shape the same page can take ─────────────────────────────
    # Marketplace as a SINGLE dropdown listing country codes. The driver has to
    # notice it cannot have every country, fall back to the configured one, and
    # match "United States" against an option that reads "US" - neither string
    # contains the other.
    print("\n-- When the page allows only one country " + "-" * 20)
    single = (HERE / "testdata" / "cepreport-single-marketplace.html").as_uri()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(single)
        page.wait_for_timeout(500)

        before = len(notes)
        count = SKU.pick_marketplace(page, progress, country="United States")
        said = " ".join(notes[before:])
        chosen = page.evaluate("""() => {
          const d = document.getElementById('mp');
          const s = d.shadowRoot && d.shadowRoot.querySelector('select');
          return s ? s.value : null;
        }""")
        check("it selects the configured country", chosen, "US")
        check("and reports one country", count, 1)
        check("and names the country it chose", "US" in said, True)
        browser.close()

    # ── the shape the real page turned out to have ───────────────────
    # Built from the failure report Seller Central produced: a component whose
    # choices live in an `options` property and whose selection lives in
    # `value`. Nothing in its markup is clickable, so this is the case that
    # defeated every earlier attempt.
    print("\n-- A control with no clickable choices " + "-" * 22)
    katal = (HERE / "testdata" / "cepreport-katal.html").as_uri()
    real_url2, real_poll2 = SKU.URL, SKU.POLL_SECONDS
    real_build = SKU.BUILD_TIMEOUT_S
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = katal, 1, 45
    try:
        out2 = Path(tempfile.mkdtemp())
        r2 = SKU.download(
            out_dir=out2 / "files", date_range="Next 30 days",
            profile_dir=out2 / "profile", progress=progress, headless=True,
            marketplace="United States",
        )
        # This stand-in only enables Generate once a marketplace, a date range
        # AND all six options are set, so a file coming back at all proves the
        # whole form was filled in.
        check("it drives a control that has no clickable parts",
              Path(r2["path"]).exists(), True)
        check("exactly one marketplace", r2["marketplaces"], 1)
        check("every option ticked", r2["options"], 6)
        check("and the file has real contents", r2["bytes"] > 100, True)
    except Exception as exc:                      # noqa: BLE001
        check("the component-interface page works",
              "raised: " + str(exc)[:200], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = real_url2, real_poll2, real_build

    # ── a list that arrives after the page does ──────────────────────
    # The seller's marketplaces are fetched after load. Reading the control on
    # arrival found an empty list and reported that it "offers nothing" - on a
    # page that was still filling it in.
    print("\n-- A list that loads late " + "-" * 35)
    late = (HERE / "testdata" / "cepreport-late-options.html").as_uri()
    keep = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = late, 1, 45
    try:
        out3 = Path(tempfile.mkdtemp())
        r3 = SKU.download(
            out_dir=out3 / "files", date_range="Next 30 days",
            profile_dir=out3 / "profile", progress=progress, headless=True,
            marketplace="United States",
        )
        check("it waits for the list instead of giving up",
              Path(r3["path"]).exists(), True)
        check("and still chooses the configured country",
              r3.get("marketplace"), "United States")
    except Exception as exc:                      # noqa: BLE001
        check("a late-loading list works",
              "raised: " + str(exc)[:200], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep

    # ── the page as the seller actually sees it ──────────────────
    # Built from their screenshots: a marketplace list of tick boxes against
    # country CODES, and a Date Range whose fourth choice reveals From and To
    # boxes. Those boxes are how this app's own reporting period reaches the
    # report, so they are the point of the whole exercise.
    print("\n-- Country codes, and a custom period " + "-" * 22)
    cd = (HERE / "testdata" / "cepreport-custom-dates.html").as_uri()
    keep2 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = cd, 1, 45
    try:
        out4 = Path(tempfile.mkdtemp())
        r4 = SKU.download(
            out_dir=out4 / "files", date_range="Custom date range",
            profile_dir=out4 / "profile", progress=progress, headless=True,
            marketplace="United States",
            date_from="2026-09-18", date_to="2026-11-12",
        )
        # The stand-in keeps Generate disabled until a country, a range AND
        # both dates are set, so a file at all proves every one of them landed.
        check("it matches 'United States' to a box labelled 'US'",
              Path(r4["path"]).exists(), True)
        check("and records the period it actually asked for",
              (r4["coverageFrom"], r4["coverageTo"]),
              ("2026-09-18", "2026-11-12"))
    except Exception as exc:                      # noqa: BLE001
        check("the custom-period page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep2

    # A custom range with no dates must stop, not invent a period.
    print("\n-- A custom range with no dates is refused " + "-" * 17)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(cd)
        page.wait_for_timeout(400)
        try:
            SKU.pick_date_range(page, "Custom date range", progress)
            refused2, why2 = False, ""
        except RuntimeError as exc:
            refused2, why2 = True, str(exc)
        check("it stops rather than guess a period", refused2, True)
        check("and says nothing was requested",
              "nothing was requested" in why2.lower(), True)
        browser.close()

    # ── the component exactly as the real page reported itself ───────
    # kat-dropdown[multiple, multiple-hide-select, values] holding
    # kat-checkbox[id, tabindex] whose country code is readable only inside its
    # own shadow root. Two things failed here and nowhere else: the choices
    # live in `values` rather than `options`, and the boxes have no label
    # attribute at all, so reading attributes reported four choices named ''.
    print("\n-- Choices in `values`, labels in the shadow " + "-" * 14)
    va = (HERE / "testdata" / "cepreport-values-attr.html").as_uri()
    keep3 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = va, 1, 45
    try:
        out5 = Path(tempfile.mkdtemp())
        r5 = SKU.download(
            out_dir=out5 / "files", date_range="Custom date range",
            profile_dir=out5 / "profile", progress=progress, headless=True,
            marketplace="United States",
            date_from="2026-09-18", date_to="2026-11-12",
        )
        check("it reads choices from a values attribute",
              Path(r5["path"]).exists(), True)
        check("and the period it asked for is the app's",
              (r5["coverageFrom"], r5["coverageTo"]),
              ("2026-09-18", "2026-11-12"))
    except Exception as exc:                      # noqa: BLE001
        check("the values-attribute page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep3

    # ── a list that opens into a banner ────────────────────────
    # The marketplace list opens UPWARDS, into the page's surcharge notice. A
    # click then lands on the notice: it registers nothing while looking like
    # it worked, and the form is submitted empty. Two things have to hold - the
    # notice is closed first, and a click is verified against the control
    # rather than taken on trust.
    print("\n-- A list that opens into a banner " + "-" * 24)
    fp = (HERE / "testdata" / "cepreport-floating-panel.html").as_uri()
    keep4 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = fp, 1, 45
    try:
        out6 = Path(tempfile.mkdtemp())
        r6 = SKU.download(
            out_dir=out6 / "files", date_range="Custom date range",
            profile_dir=out6 / "profile", progress=progress, headless=True,
            marketplace="United States",
            date_from="2026-09-18", date_to="2026-11-12",
        )
        check("it closes the notice and gets through",
              Path(r6["path"]).exists(), True)
    except Exception as exc:                      # noqa: BLE001
        check("the covered-list page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep4

    # And when the cover CANNOT be closed, it must stop - not submit an empty
    # form. This is the case that used to pass silently.
    # A choice that cannot be made must stop the run - it must NOT reach
    # Generate Report with an empty marketplace. The earlier version of this
    # test asserted WHERE it stopped, which made it a test of the banner's
    # exact geometry rather than of the guarantee that matters.
    # A control that accepts clicks and selects nothing must not reach Generate
    # Report with an empty marketplace.
    #
    # An earlier version of this test sabotaged the stand-in from outside, by
    # stripping its click handlers. That proved nothing: the control rebuilt
    # its own markup on the next render and put them straight back. The
    # swallowing behaviour belongs in the page, so it lives in its own file.
    print("\n-- A control that swallows clicks requests nothing " + "-" * 9)
    sw = (HERE / "testdata" / "cepreport-swallows-clicks.html").as_uri()
    keep6 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = sw, 1, 20
    try:
        out8 = Path(tempfile.mkdtemp())
        SKU.download(
            out_dir=out8 / "files", date_range="Custom date range",
            profile_dir=out8 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-21", date_to="2026-11-16",
        )
        stopped, said = False, ""
    except RuntimeError as exc:
        stopped, said = True, str(exc)
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep6

    check("it stops rather than submit a half-filled form", stopped, True)
    check("and says nothing was requested",
          "nothing was requested" in said.lower(), True)
    check("and no file came back",
          (out8 / "files").exists() and any((out8 / "files").iterdir()), False)

    # ── the page as its own error report described it ─────────────
    # A control that publishes NO list of choices, and tick boxes whose country
    # code is a sibling rather than a label. Between them those two facts
    # defeated every earlier approach: the list read as empty, and asking each
    # box its name returned '', '', '', ''. What works is plain - open it, find
    # the letters on screen, click the box beside them, check it took.
    print("\n-- No published list, labels beside the boxes " + "-" * 11)
    nl = (HERE / "testdata" / "cepreport-no-list.html").as_uri()
    keep5 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = nl, 1, 45
    try:
        out7 = Path(tempfile.mkdtemp())
        r7 = SKU.download(
            out_dir=out7 / "files", date_range="Custom date range",
            profile_dir=out7 / "profile", progress=progress, headless=True,
            marketplace="United States",
            date_from="2026-09-18", date_to="2026-11-12",
        )
        # This stand-in needs a country AND a range AND both dates AND all six
        # options before Generate works, so a file proves the lot.
        check("it works with no published list of choices",
              Path(r7["path"]).exists(), True)
        check("and the period is the app's own",
              (r7["coverageFrom"], r7["coverageTo"]),
              ("2026-09-18", "2026-11-12"))
    except Exception as exc:                      # noqa: BLE001
        check("the no-list page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep5

    # ── date boxes that own themselves ────────────────────────
    # The From and To boxes carry a calendar, and it puts TODAY back over
    # anything merely assigned to them. Both boxes came back reading today
    # after being filled with dates two months apart - and the run carried on.
    # Only real keystrokes survive.
    print("\n-- Date boxes with a calendar of their own " + "-" * 15)
    cal = (HERE / "testdata" / "cepreport-calendar.html").as_uri()
    keep7 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = cal, 1, 45
    try:
        out9 = Path(tempfile.mkdtemp())
        r9 = SKU.download(
            out_dir=out9 / "files", date_range="Custom date range",
            profile_dir=out9 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-21", date_to="2026-11-16",
        )
        check("the typed period survives the calendar",
              (r9["coverageFrom"], r9["coverageTo"]),
              ("2026-09-21", "2026-11-16"))
    except Exception as exc:                      # noqa: BLE001
        check("the calendar page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep7

    # And that this stand-in is worth having: assigning the value IS defeated
    # by it, which is what the real page did.
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(cal)
        page.wait_for_timeout(400)
        page.evaluate("() => { document.getElementById('dates').style.display = 'inline'; }")
        page.evaluate("""() => {
          const f = document.getElementById('from');
          const set = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(f), 'value').set;
          set.call(f, '09/21/2026');
          for (const n of ['input', 'change', 'blur']) {
            f.dispatchEvent(new Event(n, { bubbles: true }));
          }
        }""")
        page.wait_for_timeout(300)
        overwritten = page.evaluate("() => document.getElementById('from').value")
        check("and a value merely assigned is overwritten, as it was for real",
              overwritten, "09/22/2026")
        browser.close()

    # ── boxes that only a real mouse can tick ──────────────────
    # The six option boxes here reject a click dispatched from page script:
    # the tick is drawn and then undone. That is what the real page did, and
    # why Generate Report stayed greyed out over a form that looked complete.
    print("\n-- Tick boxes that only a real mouse can tick " + "-" * 12)
    tr = (HERE / "testdata" / "cepreport-trusted-only.html").as_uri()
    keep8 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = tr, 1, 45
    try:
        out10 = Path(tempfile.mkdtemp())
        r10 = SKU.download(
            out_dir=out10 / "files", date_range="Custom date range",
            profile_dir=out10 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-23", date_to="2026-11-17",
        )
        # Generate is gated on all six, so a file proves every one registered.
        check("all six tick on a page that ignores scripted clicks",
              Path(r10["path"]).exists(), True)
        check("and the period went in with them",
              (r10["coverageFrom"], r10["coverageTo"]),
              ("2026-09-23", "2026-11-17"))
    except Exception as exc:                      # noqa: BLE001
        check("the trusted-click page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep8

    # And that this stand-in is worth having: a scripted click IS refused by
    # it, which is what the real page did.
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(tr)
        page.wait_for_timeout(400)
        page.evaluate("""() => {
          const box = document.querySelector('#opts kat-checkbox');
          box.shadowRoot.querySelector('input').click();
        }""")
        page.wait_for_timeout(300)
        stuck = page.evaluate("""() => document.querySelector('#opts kat-checkbox')
          .shadowRoot.querySelector('input').checked""")
        check("and a scripted click is refused by it, as it was for real",
              stuck, False)
        browser.close()

    # ── a notes box that submits only what was typed ───────────
    # The tag is written into Add Notes so the finished report can be picked
    # out of the list exactly. A value ASSIGNED to that box shows in it and
    # reads back correctly - which is what made this look fine - while the
    # request is submitted with no note at all, and reports came back untagged.
    print("\n-- A notes box that submits only typing " + "-" * 17)
    tn = (HERE / "testdata" / "cepreport-typed-note.html").as_uri()
    keep9 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = tn, 1, 45
    try:
        out11 = Path(tempfile.mkdtemp())
        r11 = SKU.download(
            out_dir=out11 / "files", date_range="Custom date range",
            profile_dir=out11 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-23", date_to="2026-11-17",
        )
        check("the tag reaches the submitted report",
              bool(r11.get("tag")) and r11["tag"].startswith("acp-"), True)
        check("so the report is found by its tag, not by its dates",
              r11.get("matchedOn"), "notes tag")
    except Exception as exc:                      # noqa: BLE001
        check("the typed-note page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep9

    # And that this stand-in is worth having: assigning the value LOOKS right
    # and submits nothing, which is exactly what happened for real.
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(tn)
        page.wait_for_timeout(400)
        page.evaluate(
            "() => { document.getElementById('notes').value = 'acp-deadbeef'; }")
        reads = page.evaluate("() => document.getElementById('notes').value")
        submits = page.evaluate("""() => {
          const box = document.getElementById('notes');
          return box.dataset.typed ? box.value : '';
        }""")
        check("an assigned note reads back correctly", reads, "acp-deadbeef")
        check("and is submitted as nothing at all, as it was for real",
              submits, "")
        browser.close()

    # ── another tab's Generate button ───────────────────────
    # The page has tabs, and each carries its own Generate Report button. The
    # hidden one comes LAST in the document, so taking the last match pressed
    # it: a report was generated from the other tab's empty form - untagged,
    # default dates - while the form on screen stayed filled in and nothing
    # said anything was wrong.
    print("\n-- A second tab with its own Generate button " + "-" * 12)
    tt = (HERE / "testdata" / "cepreport-two-tabs.html").as_uri()
    keep10 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = tt, 1, 45
    try:
        out12 = Path(tempfile.mkdtemp())
        r12 = SKU.download(
            out_dir=out12 / "files", date_range="Custom date range",
            profile_dir=out12 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-23", date_to="2026-11-17",
        )
        # The other tab's button produces an untagged report, so being found
        # BY THE TAG proves the right button was pressed.
        check("the visible tab's button is the one pressed",
              r12.get("matchedOn"), "notes tag")
        check("and the file is the one this form asked for",
              Path(r12["path"]).read_text(encoding="utf-8").startswith("MSKU"),
              True)
    except Exception as exc:                      # noqa: BLE001
        check("the two-tab page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep10

    # And that this stand-in is worth having: the hidden button really is the
    # last one in the document, which is what the old code would have taken.
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(tt)
        page.wait_for_timeout(400)
        found = page.evaluate("""() => {
          const out = [];
          const walk = n => {
            for (const e of n.querySelectorAll('*')) {
              const t = ((e.getAttribute && e.getAttribute('label'))
                || e.textContent || '').trim();
              if (/^Generate Report$/i.test(t)
                  && (e.tagName === 'KAT-BUTTON' || e.tagName === 'BUTTON')) {
                const r = e.getBoundingClientRect();
                out.push(r.width > 0 && r.height > 0);
              }
              if (e.shadowRoot) walk(e.shadowRoot);
            }
          };
          walk(document);
          return out;
        }""")
        check("the page carries more than one Generate button",
              len(found) > 1, True)
        check("and the LAST one is hidden, as it was for real",
              found[-1], False)
        browser.close()

    # ── a notes box that commits on blur ────────────────────
    # Typing fills the field; only LEAVING it makes the page take the value.
    # Generate used to be pressed from page script, which never blurs
    # anything - so the tag sat in the box and never reached the request.
    # Pressing it by hand worked, for exactly that reason.
    print("\n-- A notes box that commits on blur " + "-" * 19)
    cb = (HERE / "testdata" / "cepreport-commit-on-blur.html").as_uri()
    keep11 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = cb, 1, 45
    try:
        out13 = Path(tempfile.mkdtemp())
        r13 = SKU.download(
            out_dir=out13 / "files", date_range="Custom date range",
            profile_dir=out13 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-23", date_to="2026-11-17",
        )
        check("the tag survives to the submitted report",
              r13.get("matchedOn"), "notes tag")
    except Exception as exc:                      # noqa: BLE001
        check("the blur-commit page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep11

    # And that this stand-in is worth having: without leaving the field, the
    # value really is not submitted - which is what happened for real.
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(cb)
        page.wait_for_timeout(400)
        page.locator("#notes").click()
        page.keyboard.type("acp-testtag", delay=15)
        still = page.evaluate(
            "() => document.getElementById('notes').dataset.committed || ''")
        page.keyboard.press("Tab")
        page.wait_for_timeout(300)
        after = page.evaluate(
            "() => document.getElementById('notes').dataset.committed || ''")
        check("typed but not left: submits nothing, as it did for real",
              still, "")
        check("and leaving the field is what commits it", after, "acp-testtag")
        browser.close()

    # ── no notes box at all ─────────────────────────────
    # A report that cannot be tagged must still be found and downloaded. It is
    # identified by its dates AND by being new, and the job says which was
    # used, because that is weaker than a tag and should not be silent.
    print("\n-- No notes box: download anyway " + "-" * 22)
    nn = (HERE / "testdata" / "cepreport-no-notes.html").as_uri()
    keep12 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = nn, 1, 45
    try:
        out14 = Path(tempfile.mkdtemp())
        r14 = SKU.download(
            out_dir=out14 / "files", date_range="Custom date range",
            profile_dir=out14 / "profile", progress=progress, headless=True,
            marketplace="US", date_from="2026-09-23", date_to="2026-11-17",
        )
        check("it downloads with no tag at all",
              Path(r14["path"]).exists(), True)
        check("and says so rather than implying a tag",
              r14.get("matchedOn"), "date range (no notes box)")
        check("and the file has real contents", r14["bytes"] > 100, True)
    except Exception as exc:                      # noqa: BLE001
        check("the no-notes page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep12

    # ── a retry collects; it does not ask again ───────────────
    # Every retry used to fill the form and press Generate afresh, so a job
    # that failed AFTER the report was requested - a restart, a lost download -
    # left another copy of the same period in the Generated Reports list. The
    # ticket is saved the moment the request goes in, and a retry goes straight
    # back to watching for that report.
    print("\n-- A retry collects, it does not ask again " + "-" * 15)
    rs = (HERE / "testdata" / "cepreport-commit-on-blur.html").as_uri()
    keep13 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = rs, 1, 45
    saved_ticket: dict = {}
    try:
        out15 = Path(tempfile.mkdtemp())
        first_notes: list[str] = []
        SKU.download(
            out_dir=out15 / "one", date_range="Custom date range",
            profile_dir=out15 / "profile", headless=True, marketplace="US",
            date_from="2026-09-23", date_to="2026-11-17",
            progress=lambda a, b: first_notes.append(b),
            save_ticket=lambda t: saved_ticket.update(t),
        )
        check("the first run asks Amazon for the report",
              any("Generating" in n for n in first_notes), True)
        check("and remembers that it did",
              bool(saved_ticket.get("requestedAt")), True)

        retry_notes: list[str] = []
        r15 = SKU.download(
            out_dir=out15 / "two", date_range="Custom date range",
            profile_dir=out15 / "profile", headless=True, marketplace="US",
            date_from="2026-09-23", date_to="2026-11-17",
            progress=lambda a, b: retry_notes.append(b),
            ticket=saved_ticket,
        )
        check("the retry does NOT ask for another one",
              any("Generating" in n for n in retry_notes), False)
        check("it says it is collecting the one already asked for",
              any("already requested" in n for n in retry_notes), True)
        check("and it still comes back with the file",
              r15["bytes"] > 100, True)
    except Exception as exc:                      # noqa: BLE001
        check("the resume path works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep13

    # ── a download whose window closes early ────────────────
    # The Download link opens a window that shuts itself once the transfer
    # starts. Playwright cannot hand over a download whose owning page has
    # gone - "Target page, context or browser has been closed" - even though
    # the file is complete. Chromium writes it into the download folder
    # regardless, so it is collected from there.
    print("\n-- A download window that closes early " + "-" * 18)
    cw = (HERE / "testdata" / "cepreport-closing-window.html").as_uri()
    keep14 = (SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S)
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = cw, 1, 45

    # Force the hand-over to fail, exactly as it does for real.
    import playwright.sync_api as _pw
    real_save = _pw.Download.save_as

    def _closed(self, path):
        raise Exception("Target page, context or browser has been closed")

    _pw.Download.save_as = _closed
    try:
        out16 = Path(tempfile.mkdtemp())
        dl_notes: list[str] = []
        r16 = SKU.download(
            out_dir=out16 / "files", date_range="Custom date range",
            profile_dir=out16 / "profile", headless=True, marketplace="US",
            date_from="2026-09-23", date_to="2026-11-17",
            progress=lambda a, b: dl_notes.append(b),
        )
        check("the file is collected even when the window has closed",
              Path(r16["path"]).exists(), True)
        check("and it has real contents", r16["bytes"] > 100, True)
        check("and it says how it was recovered",
              any("download folder" in n for n in dl_notes), True)
    except Exception as exc:                      # noqa: BLE001
        check("the closing-window page works",
              "raised: " + str(exc)[:220], "no error")
    finally:
        _pw.Download.save_as = real_save
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = keep14

    # ── options that are off screen when their turn comes ───────
    # A click goes to a point in the VIEWPORT. A box scrolled past either edge
    # still has a position, but not one the mouse can reach: the click lands on
    # whatever is there, or on nothing. By the time the form above had been
    # filled in the page had moved, so some options were off screen - and which
    # ones depended only on where the page happened to be sitting.
    print("\n-- Options that are off screen when their turn comes " + "-" * 4)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 420})
        page.goto((HERE / "testdata" / "cepreport-no-list.html").as_uri())
        page.wait_for_timeout(400)

        # Tall options and a scrolled page: the list cannot all be on screen.
        setup = """() => {
          for (const el of document.querySelectorAll('#opts kat-checkbox')) {
            el.style.display = 'block'; el.style.height = '90px';
          }
          window.scrollTo(0, document.body.scrollHeight);
        }"""
        read_real = """() => [...document.querySelectorAll('#opts kat-checkbox')]
          .map(x => { const i = x.shadowRoot && x.shadowRoot.querySelector('input');
                      return i ? i.checked : false; })"""

        # First: measure once and click blind, the way it used to work.
        page.evaluate(setup)
        pts = page.evaluate(SKU.OPTION_POINTS_JS,
                            {"heading": SKU.OPTIONS_HEADING, "min": 4})
        for b in (pts.get("boxes") or []):
            try:
                page.mouse.click(b["x"], b["y"])
            except Exception:
                pass
            page.wait_for_timeout(120)
        blind = page.evaluate(read_real)
        check("clicking without scrolling first misses the off-screen ones",
              sum(1 for v in blind if v) < 6, True)

        browser.close()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1200, "height": 420})
        page.goto((HERE / "testdata" / "cepreport-no-list.html").as_uri())
        page.wait_for_timeout(400)
        page.evaluate(setup)

        res = SKU.tick_every_option(page, progress)
        real = page.evaluate(read_real)
        check("scrolling each one into view first ticks them all",
              (res["total"], sum(1 for v in real if v)), (6, 6))
        browser.close()

    # ── the whole chain, in one call ───────────────────────────────────────
    # Everything above tests a step. This tests download() itself: fill the
    # form, tag it, press Generate, wait for the row to finish building,
    # download the file, and check what came back.
    print("\n-- The whole run, end to end " + "-" * 32)
    import tempfile
    real_url, real_poll = SKU.URL, SKU.POLL_SECONDS
    real_build1 = SKU.BUILD_TIMEOUT_S
    SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = PAGE, 1, 45          # the stand-in, polled quickly
    try:
        out = Path(tempfile.mkdtemp())
        result = SKU.download(
            out_dir=out / "files",
            date_range="Next 30 days",
            profile_dir=out / "profile",
            progress=progress,
            headless=True,
        )
        check("a file was downloaded", Path(result["path"]).exists(), True)
        check("it is not empty", result["bytes"] > 0, True)
        check("exactly one marketplace", result["marketplaces"], 1)
        check("every option was included", result["options"], 6)
        check("the range is recorded by name, not as invented dates",
              (result["coverageRange"], result["coverageFrom"]),
              ("Next 30 days", None))
        check("it was found by its own tag, not by guessing",
              result["matchedOn"], "notes tag")
        check("and the tag is the one it wrote",
              bool(result["tag"]) and result["tag"].startswith("acp-"), True)
    except Exception as exc:                      # noqa: BLE001
        check("the whole run completes", "raised: " + str(exc)[:160], "no error")
    finally:
        SKU.URL, SKU.POLL_SECONDS, SKU.BUILD_TIMEOUT_S = real_url, real_poll, real_build1

    print("\n-- what the driver reported " + "-" * 33)
    for n in notes:
        print("   " + n)

    print("\n" + "=" * 68)
    print("passed %d   failed %d" % (PASS, FAIL))
    if FAILURES:
        print("\nFAILURES")
        for f in FAILURES:
            print("  " + f)
    print("=" * 68)
    print("\nThis drives a stand-in page with the same component shape.")
    print("A real Amazon download is NOT covered and needs your login.\n")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
