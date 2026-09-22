"""Record the real steps for a report page, instead of guessing them.

Amazon's report pages differ by account and marketplace and change over time.
Rather than ship selectors from memory, this opens the actual page, lets you
sign in, and then records what is genuinely there — you point at each control
once, and the result is written to selectors.json for the worker to replay.

    python worker/discover.py fees-preview

Nothing is written until you confirm, and no password is handled here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELECTORS_PATH = HERE / "selectors.json"
PROFILE_DIR = HERE / "profile"

REPORTS = {
    "fees-preview": "https://sellercentral.amazon.com/cepreport",
    "date-range-transactions":
        "https://sellercentral.amazon.com/payments/reports-repository",
}

PICKER = """
() => {
  return new Promise(resolve => {
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'crosshair';
    const hi = document.createElement('div');
    hi.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;' +
      'border:2px solid #0F766E;background:rgba(15,118,110,.12);border-radius:3px';
    document.body.appendChild(hi);
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
        const nm = el.getAttribute('name');
        const dt = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        if (dt) { bits.unshift(part + '[data-testid="' + dt + '"]'); break; }
        if (nm) part += '[name="' + nm + '"]';
        else if (el.classList.length) {
          const c = [...el.classList].filter(x => !/\\d/.test(x))[0];
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
      hi.remove(); document.body.style.cursor = prev;
      resolve({
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        text: (el.innerText || el.value || '').slice(0, 60),
      });
    };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
  });
}
"""


def ask(prompt: str) -> str:
    print("\n  " + prompt)
    return input("  > ").strip()


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in REPORTS:
        print("usage: python worker/discover.py [%s]" % " | ".join(REPORTS))
        raise SystemExit(2)

    report = sys.argv[1]
    url = REPORTS[report]

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed. Run:")
        print("  pip install -r worker/requirements.txt")
        print("  python -m playwright install chromium")
        raise SystemExit(1)

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    steps: list[dict] = []

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR), headless=False,
            accept_downloads=True, viewport={"width": 1400, "height": 950})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=90_000)

        print("\n  A browser window is open at the report page.")
        print("  Sign in to Amazon there if it asks. Nothing is recorded until")
        print("  you answer the prompts below.")
        ask("Press Enter once the report page is showing.")

        print("\n  Current URL: %s" % page.url)
        expect = ask("Type a word that appears on the page and identifies the "
                     "right seller account (blank to skip):")

        def pick(what: str, kind: str, extra: dict | None = None) -> None:
            ask("Click the %s in the browser window, then come back here." % what)
            print("  waiting for your click...")
            got = page.evaluate(PICKER)
            print("  recorded: %s   (%s %r)" % (got["selector"], got["tag"],
                                                got["text"]))
            step = {"kind": kind, "selector": got["selector"], "label": what}
            if extra:
                step.update(extra)
            steps.append(step)

        fmt = ask("What date format do the date boxes use? "
                  "[YYYY-MM-DD | MM/DD/YYYY | DD/MM/YYYY]") or "MM/DD/YYYY"

        pick("FROM date box", "fill-from", {"format": fmt})
        pick("TO date box", "fill-to", {"format": fmt})

        if (ask("Is there a 'Generate'/'Request report' button? [y/N]")
                .lower().startswith("y")):
            pick("Generate / Request report button", "click")
            pick("something that only appears WHEN THE REPORT IS READY "
                 "(e.g. the Download button itself)", "wait-for")

        ask("Click the DOWNLOAD control next, then come back.")
        print("  waiting for your click...")
        dl = page.evaluate(PICKER)
        print("  recorded download control: %s" % dl["selector"])

        ctx.close()

    data = {}
    if SELECTORS_PATH.exists():
        data = json.loads(SELECTORS_PATH.read_text("utf-8"))

    data[report] = {
        "url": url,
        "verified": True,
        "verifiedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "expectAccountText": expect or None,
        "steps": steps,
        "downloadSelector": dl["selector"],
    }
    SELECTORS_PATH.write_text(json.dumps(data, indent=2), "utf-8")

    print("\n  Written to %s" % SELECTORS_PATH)
    print("  The worker will now run this report. If Amazon changes the page,")
    print("  the job fails with a clear error and you re-run this script.\n")


if __name__ == "__main__":
    main()
