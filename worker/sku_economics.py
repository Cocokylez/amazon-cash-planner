"""The SKU Economics report at sellercentral.amazon.com/cepreport, driven directly.

WHY THIS IS NOT RECORDED LIKE THE OTHER REPORT

The Payments reports repository differs between accounts, so its controls are
recorded from the seller's own page. This page does not: it is one fixed form
with printed headings - "Simplified Report Configuration Options", "Add Notes",
"Generate Report", "Generated Reports". Asking someone to point at six tick
boxes they can already read is work for no gain, and a recorded CSS path breaks
the next time Amazon reshuffles its markup, while a printed heading does not.

So this finds controls by what the page SAYS, and asks the seller for nothing
beyond which date range they want.

THE ORDER THE PAGE IMPOSES

    marketplace -> date range -> every configuration box -> notes
        -> Generate Report -> wait -> download from Generated Reports

Generate Report is DISABLED until the form is valid. That is the single most
useful thing on the page: it is Amazon's own confirmation that the selections
took. This waits for it to become enabled and refuses to continue if it never
does, rather than clicking a dead button and reporting success.

WHAT IT WILL NOT DO

It will not submit with boxes missing. A CSV short of a column is worse than a
job that stops, because the missing money looks like less money.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Callable

from seller_central import (          # the shared, tested pieces
    _norm,
    await_login,
    looks_like_login,
)

URL = "https://sellercentral.amazon.com/cepreport"

# The six options as the page prints them today. NOT a list of what to tick -
# every box in the block is ticked whatever it is called. This is the safety
# check: if fewer than four of these are recognisable, the page is not the one
# this code was written against and the job stops.
KNOWN_OPTIONS = (
    "fulfillment base rate",
    "sales data",
    "storage fee base rate",
    "return and refund",
    "referral and closing",
    "advertising spend",
)

OPTIONS_HEADING = "simplified report configuration options"
GENERATED_HEADING = "generated reports"

DEFAULT_RANGE = "Next 30 days"

# How long Amazon may take to build the file. Its own note says download links
# last 30 days, but building is minutes, not hours.
BUILD_TIMEOUT_S = 15 * 60

# How often to look at the Generated Reports list. Ten seconds is polite to
# Amazon and quick enough for a person; the test drops it so a run takes
# seconds instead of minutes.
POLL_SECONDS = 10

# How long the page may sit completely unchanged before it is refreshed once.
# The list updates itself, so a refresh is a last resort rather than a habit:
# reading the page mid-navigation used to fail the job outright.
STALE_SECONDS = 180

# How long to insist on finding our tag before falling back to the dates. Long
# enough for Amazon to finish building an ordinary report, short enough that a
# tag which never reached Amazon does not cost the whole wait.
TAG_PATIENCE_S = 150
MAX_RELOADS = 3

# An earlier build left the window open for 45 seconds after a failure so the
# page could be inspected. It only ever looked like the job had hung: the
# window sat there doing nothing while the status still read "requesting".
# The failure report describes the page in words instead.


# ── finding things through shadow DOM ─────────────────────────────

# Seller Central is built from web components - <kat-dropdown>, <kat-checkbox>
# and so on - and each one hides its real markup inside a shadow root.
# document.querySelectorAll() cannot see into those, which is why an earlier
# version of this file reported "the Marketplace control could not be found"
# while the control was plainly on screen.
#
# So every helper below walks shadow roots, and every one of them DOES the
# clicking in the page rather than handing a CSS path back to Python: a path
# that crosses a shadow boundary is not a valid selector on the other side.

DEEP_PRELUDE = r"""
  /* Everything in the document, shadow roots included. */
  const deepAll = (root, sel) => {
    const out = [];
    const walk = node => {
      try { out.push(...node.querySelectorAll(sel)); } catch (e) { /* bad sel */ }
      /* The node's OWN shadow root, first. Without this line a component was
         searched for its inner <input> and the search never went inside it,
         so every control looked empty and every click landed on a wrapper
         that does not listen. */
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const el of node.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  };

  const norm = s => (s || '').replace(/\s+/g, ' ').trim();

  const visible = el => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };

  /* A custom element is a WRAPPER. The thing that actually responds to a click
     - and actually holds the checked state - is the <input> inside its shadow
     root. Clicking the wrapper does nothing at all, which is why an earlier
     version reported six boxes that "would not tick". */
  const innerBox = el => {
    if (el.tagName === 'INPUT') return el;
    const inner = deepAll(el, 'input[type=checkbox]');
    return inner.length ? inner[inner.length - 1] : el;
  };

  /* Is this box ticked?

     Four places to look, because a component may use any of them and some use
     none of the obvious ones:
       * the real <input>, when its shadow root is open enough to reach;
       * a `checked` PROPERTY on the element - a custom element's usual home
         for its state, and invisible to getAttribute();
       * the attributes, for a plain or ARIA control;
       * the class list, for a component that only styles itself.
     A closed shadow root hides the first, which is why reading attributes
     alone reported four boxes as "would not tick" on a page where clicking
     them worked. */
  const isTicked = el => {
    const t = innerBox(el);
    if (t.tagName === 'INPUT') return !!t.checked;
    if (typeof el.checked === 'boolean') return el.checked;
    const a = (el.getAttribute('aria-checked') || el.getAttribute('checked')
      || '').toString().toLowerCase();
    if (a === 'true' || a === 'checked') return true;
    if (el.hasAttribute('checked')) return true;
    const cls = (el.className || '').toString().toLowerCase();
    if (/(^|[^n])\bchecked\b|\bselected\b/.test(cls)) return true;
    return false;
  };

  const BOXES = 'input[type=checkbox], [role=checkbox], kat-checkbox, kat-closed-checkbox, [class*=checkbox i]';

  /* Up through shadow boundaries, not just the light tree. */
  const deepParent = el => el.parentElement
    || (el.getRootNode && el.getRootNode() && el.getRootNode().host) || null;

  /* ONE entry per tick box.

     A web component is both a tick box and the host of a real <input> inside
     its shadow root, so a naive query returns each box twice. Ticking the same
     box twice turns it back OFF, which would have silently produced a report
     missing the very columns it was told to include. Only the outermost
     element of each nest is kept. */
  const boxesIn = root => {
    const all = deepAll(root, BOXES);
    const set = new Set(all);
    return all.filter(el => {
      let p = deepParent(el);
      while (p) { if (set.has(p)) return false; p = deepParent(p); }
      return true;
    });
  };

  const tick = el => {
    if (isTicked(el)) return 'already';
    const target = innerBox(el);

    /* In order of how close each is to what a person would actually click.
       The state is re-read after every attempt, so the first one that works
       stops the rest - two successful clicks would tick the box back off. */
    const tries = [];
    if (target.id) {
      const lab = deepAll(document, 'label[for="' + CSS.escape(target.id) + '"]')[0];
      if (lab) tries.push(lab);
    }
    try {
      const wrap = target.closest && target.closest('label');
      if (wrap) tries.push(wrap);
    } catch (e) { /* no closest on this node */ }
    tries.push(target);
    if (target !== el) tries.push(el);

    for (const t of tries) {
      try { t.click(); } catch (e) { continue; }
      if (isTicked(el)) return 'ticked';
    }
    /* Last resort: set the state directly and tell the page.

       For a component whose shadow root is closed there is no inner input to
       click, and the host may not forward a synthetic click to its own
       handler. Setting the property is how such a component is driven from
       outside, and the events are what make the page notice. */
    try {
      for (const t of [target, el]) {
        if (t.tagName === 'INPUT' || typeof t.checked === 'boolean') {
          t.checked = true;
        } else {
          t.setAttribute('checked', '');
          t.setAttribute('aria-checked', 'true');
        }
        for (const name of ['input', 'change', 'click']) {
          t.dispatchEvent(new Event(name, { bubbles: true, composed: true }));
        }
        if (isTicked(el)) return 'ticked';
      }
    } catch (e) { /* fall through to the failure report */ }
    return 'stuck';
  };

  /* textContent stops at a shadow boundary, so a component's visible text is
     invisible to it. This gathers what a person actually reads. */
  const deepText = el => {
    let t = '';
    const walk = n => {
      for (const c of n.childNodes || []) {
        if (c.nodeType === 3) t += c.nodeValue + ' ';
        else if (c.nodeType === 1) {
          if (c.shadowRoot) walk(c.shadowRoot);
          walk(c);
        }
      }
    };
    if (el.shadowRoot) walk(el.shadowRoot);
    walk(el);
    return norm(t);
  };

  /* What a tick box is called.

     deepText comes SECOND and matters most: these boxes are
     <kat-checkbox id tabindex> with no label attribute at all, and the word a
     person reads - "US" - is inside the component's shadow root. Reading only
     attributes reported four boxes offering '', '', '', '' on a list that
     plainly showed four countries. */
  const labelOf = el => norm(el.getAttribute && (el.getAttribute('label')
    || el.getAttribute('aria-label')) || '')
    || deepText(el)
    || norm(el.closest && el.closest('label') ? el.closest('label').textContent : '')
    || norm(el.parentElement ? el.parentElement.textContent : '');
"""


TICK_BLOCK_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* The block of tick boxes sitting under a printed heading, and every box in
     it ticked. Anchored on the words, because the words are the stable part. */
  const want = args.heading.toLowerCase();
  const heads = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    return t.startsWith(want) && t.length < want.length + 60;
  });
  if (!heads.length) {
    return { ok: false, reason: 'heading not found: ' + args.heading };
  }

  /* A heading does not CONTAIN its tick boxes - it sits above them. So each
     ancestor is checked, and at every level the things that FOLLOW the heading
     are checked too. Looking only upwards found nothing but <body>, which
     would have swept in the marketplace boxes as well. */
  const countIn = n => boxesIn(n).length;
  let block = null;
  for (const head of heads.reverse()) {          /* deepest match first */
    let node = head, hops = 0;
    while (node && hops < 12) {
      if (node.tagName !== 'BODY' && countIn(node) >= args.min) {
        block = node; break;
      }
      const after = [];
      let sib = node.nextElementSibling;
      while (sib) { after.push(sib); sib = sib.nextElementSibling; }
      const hit = after.find(x => countIn(x) >= args.min);
      if (hit) { block = hit; break; }
      node = deepParent(node);
      hops++;
    }
    if (block) break;
  }
  if (!block) {
    return { ok: false, reason: 'no block under "' + args.heading
      + '" held at least ' + args.min + ' tick boxes' };
  }

  const boxes = boxesIn(block);
  const labels = boxes.map(labelOf).filter(Boolean);
  if (args.inspectOnly) {
    return { ok: true, count: boxes.length, labels: labels.slice(0, 20) };
  }

  let ticked = 0, already = 0;
  const stuck = [];
  for (const b of boxes) {
    const r = tick(b);
    if (r === 'ticked') ticked++;
    else if (r === 'already') already++;
    else stuck.push(labelOf(b) || b.tagName.toLowerCase());
  }
  return { ok: true, count: boxes.length, ticked, already, stuck,
           labels: labels.slice(0, 20) };
}
"""


OPEN_CONTROL_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* The control that belongs to a printed label such as "Marketplace" or
     "Date Range", opened. */
  const want = args.label.toLowerCase();
  const CONTROL = 'select,[role=combobox],[role=listbox],[aria-haspopup],button,'
    + 'kat-dropdown,kat-select,[class*=dropdown i],[class*=select i]';

  /* FIRST: the component that carries the name itself.

     On this page the control is <kat-dropdown label="Marketplace"> - the name
     is an attribute, and there is no text anywhere on the page reading
     "Marketplace" beside it. Searching for the words found nothing while the
     control sat in plain sight. */
  const direct = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === want || l === want + ':';
  }).filter(visible);

  if (direct.length) {
    const ctl = direct[direct.length - 1];
    const before = deepText(ctl);
    const inner = deepAll(ctl, 'button,[role=button],input,select,a').filter(visible);
    const targets = inner.length ? [inner[inner.length - 1], ctl] : [ctl];
    for (const t of targets) {
      try { t.click(); } catch (e) { continue; }
      return { ok: true, text: before.slice(0, 80), by: 'label attribute',
               tag: t.tagName.toLowerCase() };
    }
  }

  /* Otherwise a leaf whose whole text IS the label - not an outer box that
     merely contains the word somewhere. */
  const labels = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    if (t !== want && t !== want + ':' && t !== want + ' *') return false;
    return !e.querySelector('*') || norm(e.textContent) === norm(e.innerText || '');
  });

  const tried = [];
  for (const lab of labels) {
    let scope = lab, hops = 0;
    while (scope && hops < 4) {
      const ctl = deepAll(scope, CONTROL).find(c => visible(c) && !c.contains(lab));
      if (ctl) {
        const before = norm(ctl.textContent);
        /* The wrapper does not listen for clicks; the button inside its shadow
           root does. Deepest first, then the wrapper as a fallback. */
        const inner = deepAll(ctl, 'button,[role=button],input,select,a')
          .filter(visible);
        const targets = inner.length ? [inner[inner.length - 1], ctl] : [ctl];
        for (const t of targets) {
          try { t.click(); } catch (e) { continue; }
          return { ok: true, text: before.slice(0, 80),
                   tag: t.tagName.toLowerCase() };
        }
        tried.push('found but could not click');
        break;
      }
      tried.push(scope.tagName.toLowerCase());
      scope = scope.parentElement
        || (scope.getRootNode() && scope.getRootNode().host) || null;
      hops++;
    }
  }
  return { ok: false, labelsFound: labels.length,
           reason: labels.length
             ? 'the label "' + args.label + '" is on the page but no control '
               + 'was found beside it (looked in: ' + tried.slice(0, 6).join(', ') + ')'
             : 'no element on the page reads exactly "' + args.label + '"' };
}
"""


TICK_IN_CONTROL_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Every tick box inside one named control - the country list.

     Scoped to the control itself rather than to "whatever appeared when it
     opened", because the countries are already in the page before the list is
     opened; they are merely hidden. Scoping also keeps this away from the
     unrelated tick boxes a feedback widget leaves lying around the page. */
  const want = args.label.toLowerCase();
  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === want;
  }).pop();
  if (!ctl) return { ok: false, reason: 'no control is named "' + args.label + '"' };

  const boxes = boxesIn(ctl);
  if (!boxes.length) {
    return { ok: false, reason: 'the "' + args.label + '" control holds no tick boxes' };
  }

  let ticked = 0, already = 0;
  const stuck = [], names = [];
  for (const b of boxes) {
    names.push(labelOf(b));
    const r = tick(b);
    if (r === 'ticked') ticked++;
    else if (r === 'already') already++;
    else stuck.push(labelOf(b) || b.tagName.toLowerCase());
  }
  return { ok: true, count: boxes.length, ticked, already, stuck,
           labels: names.filter(Boolean).slice(0, 25) };
}
"""


MARK_BOXES_JS = r"""
() => {
""" + DEEP_PRELUDE + r"""
  /* Mark every tick box that exists right now.

     The marketplace panel is a floating list that may render anywhere in the
     document, so there is no reliable container to scope to. Instead the boxes
     already on the page are marked, and after the list opens only the UNMARKED
     ones - the ones that appeared because it opened - are ticked. That cannot
     accidentally sweep in the report options further down the page. */
  const boxes = boxesIn(document);
  for (const b of boxes) b.setAttribute('data-acp-seen', '1');
  return { marked: boxes.length };
}
"""


TICK_NEW_JS = r"""
() => {
""" + DEEP_PRELUDE + r"""
  /* Tick only the boxes that appeared since the marking. */
  const fresh = boxesIn(document).filter(b => !b.hasAttribute('data-acp-seen'));
  if (!fresh.length) return { ok: false, reason: 'the list opened but no new tick boxes appeared' };

  let ticked = 0, already = 0;
  const stuck = [], names = [];
  for (const b of fresh) {
    names.push(labelOf(b));
    const r = tick(b);
    if (r === 'ticked') ticked++;
    else if (r === 'already') already++;
    else stuck.push(labelOf(b) || b.tagName.toLowerCase());
  }
  return { ok: true, count: fresh.length, ticked, already, stuck,
           labels: names.filter(Boolean).slice(0, 25) };
}
"""


PICK_OPTION_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* One option in an open list, chosen by its printed text. */
  const want = norm(args.text).toLowerCase();
  const hits = deepAll(document, '*').filter(e => {
    if (!visible(e)) return false;
    if (e.querySelector('*')) return false;         /* leaf text only */
    return norm(e.textContent).toLowerCase() === want;
  });
  if (!hits.length) {
    const near = deepAll(document, '[role=option],li,kat-option')
      .filter(visible).map(e => norm(e.textContent)).filter(Boolean).slice(0, 12);
    return { ok: false, reason: 'no visible choice reads "' + args.text + '"',
             offered: near };
  }
  const el = hits[hits.length - 1];
  const target = el.closest('[role=option],li,kat-option,button,a') || el;
  try { target.click(); } catch (e) { return { ok: false, reason: 'could not click it' }; }
  return { ok: true };
}
"""


READ_CONTROL_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* What a labelled control currently shows. */
  const want = args.label.toLowerCase();
  const CONTROL = 'select,[role=combobox],[role=listbox],[aria-haspopup],button,'
    + 'kat-dropdown,kat-select,[class*=dropdown i],[class*=select i]';
  const direct = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === want;
  }).filter(visible);
  if (direct.length) {
    const ctl = direct[direct.length - 1];
    /* Its own name would otherwise be read back as its value. */
    const shown = deepText(ctl).replace(new RegExp('^' + args.label + '\\s*', 'i'), '');
    return { ok: true, text: norm(shown).slice(0, 120) };
  }

  const labels = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    return t === want || t === want + ':';
  });
  for (const lab of labels) {
    let scope = lab, hops = 0;
    while (scope && hops < 4) {
      const ctl = deepAll(scope, CONTROL).find(c => visible(c) && !c.contains(lab));
      if (ctl) {
        const shown = deepText(ctl)
          || norm(ctl.value || ctl.getAttribute('value') || '');
        return { ok: true, text: shown.slice(0, 120) };
      }
      scope = scope.parentElement
        || (scope.getRootNode() && scope.getRootNode().host) || null;
      hops++;
    }
  }
  return { ok: false };
}
"""


DUMP_JS = r"""
() => {
""" + DEEP_PRELUDE + r"""
  /* A STRUCTURAL description of the page for a failure report.
     Headings, control labels and tick-box labels only - no figures, no account
     details, nothing from a form field. This goes in a log the seller may send
     on, so it carries the shape of the page and none of their business. */
  /* Section titles on this page are styled <div>s, not <h> tags, so a dump
     that looked only at headings came back empty on the very page it was
     meant to describe. Any short standalone line counts. */
  const seen = new Set();
  const headings = deepAll(document, 'h1,h2,h3,h4,h5,legend,div,span,p,label')
    .filter(el => {
      if (!visible(el) || el.querySelector('*')) return false;
      const t = norm(el.textContent);
      if (t.length < 6 || t.length > 70 || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .map(el => norm(el.textContent))
    .slice(0, 30);
  const boxes = boxesIn(document);
  const controls = deepAll(document,
    'select,[role=combobox],kat-dropdown,kat-select,[aria-haspopup]')
    .filter(visible)
    .map(e => e.tagName.toLowerCase() + ':' + norm(e.getAttribute('label')
      || e.getAttribute('aria-label') || e.textContent).slice(0, 40))
    .slice(0, 20);
  const buttons = deepAll(document, 'button,kat-button,[role=button]')
    .filter(visible).map(e => norm(e.getAttribute('label')
      || e.textContent).slice(0, 40)).filter(Boolean).slice(0, 20);
  return {
    url: location.href,
    headings,
    checkboxCount: boxes.length,
    checkboxLabels: boxes.map(labelOf).filter(Boolean).slice(0, 20),
    controls,
    buttons,
  };
}
"""


SHAPE_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* The STRUCTURE of one control: tag names, attribute names, and whether a
     shadow root can be reached. No text values, no figures, nothing typed into
     a field - this goes into a log the seller may send on. */
  const want = args.label.toLowerCase();
  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === want;
  }).pop();
  if (!ctl) return { found: false };

  const describe = el => ({
    tag: el.tagName.toLowerCase(),
    attrs: [...el.attributes].map(a => a.name).join(','),
    shadow: el.shadowRoot ? 'open' : (el.attachShadow ? 'closed-or-none' : 'n/a'),
    props: ['checked', 'value', 'selected', 'disabled']
      .filter(k => typeof el[k] !== 'undefined')
      .map(k => k + '=' + JSON.stringify(el[k])).join(' '),
  });

  /* What the component says it offers. This is the single most useful line in
     a failure report: it is the list the value has to match. */
  let offered = null;
  try {
    let o = ctl.options;
    if (!Array.isArray(o)) o = JSON.parse(ctl.getAttribute('options') || 'null');
    if (Array.isArray(o)) {
      offered = o.slice(0, 12).map(x => norm(
        (x && (x.name != null ? x.name : (x.label != null ? x.label : x.value)))
      ) + '=' + JSON.stringify(x && x.value));
    }
  } catch (e) { offered = null; }

  return {
    found: true,
    control: describe(ctl),
    offered,
    value: (() => { try { return JSON.stringify(ctl.value); } catch (e) { return null; } })(),
    boxes: boxesIn(ctl).slice(0, 6).map(describe),
  };
}
"""


def _shape(page, label: str) -> str:
    """How one control is actually built, for a failure message."""
    try:
        d = page.evaluate(SHAPE_JS, {"label": label})
    except Exception:
        return ""
    if not d.get("found"):
        return ""
    bits = [" The %s control is <%s %s> (shadow: %s), currently %s."
            % (label, d["control"].get("tag"), d["control"].get("attrs"),
               d["control"].get("shadow"), d.get("value") or "unset")]
    if d.get("offered"):
        bits.append(" It offers: %s." % "; ".join(d["offered"]))
    box = (d.get("boxes") or [{}])[0]
    if box.get("tag"):
        bits.append(" Its tick boxes are <%s %s> (shadow: %s, properties: %s)."
                    % (box.get("tag"), box.get("attrs"), box.get("shadow"),
                       box.get("props") or "none"))
    return "".join(bits)


def _dump(page) -> str:
    """One line describing the page's shape, for a failure message."""
    try:
        d = page.evaluate(DUMP_JS)
    except Exception:
        return "(the page could not be inspected)"
    return (
        "page shows headings %r; %d tick boxes %r; controls %r; buttons %r"
        % (d.get("headings", [])[:8], d.get("checkboxCount", 0),
           d.get("checkboxLabels", [])[:8], d.get("controls", [])[:8],
           d.get("buttons", [])[:8]))


def _open_control(page, label: str, progress):
    """Open a labelled dropdown, or say precisely what was on the page."""
    res = page.evaluate(OPEN_CONTROL_JS, {"label": label})
    if not res.get("ok"):
        raise RuntimeError(
            "The %s control could not be opened: %s. Nothing was requested. "
            "For reference, the %s"
            % (label, res.get("reason", "unknown"), _dump(page)))
    page.wait_for_timeout(800)
    return res


def _read_control(page, label: str) -> str:
    try:
        res = page.evaluate(READ_CONTROL_JS, {"label": label})
    except Exception:
        return ""
    return res.get("text", "") if res.get("ok") else ""



SET_CONTROL_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Set a labelled control, whatever it turns out to be built from.

     Three shapes appear on this page and they are driven differently. Guessing
     which one a control is has failed repeatedly, so this looks:

       1. a native <select> - possibly inside a component's shadow root. Its
          <option>s are drawn by the operating system, NOT the page, so they
          cannot be clicked. The value is SET and a change event fired. An
          earlier version tried to click them, matched some navigation links
          by text instead, and reported that the page offered "Finance" and
          "Profit analytics" as date ranges.
       2. tick boxes inside the control - a multi-select panel.
       3. a list of [role=option] items - a custom dropdown.

     Whichever it finds, it reports back which shape it was and what the
     control offered, so a mismatch is legible instead of mysterious. */
  /* Several spellings of the same answer. A dropdown may list "US" where the
     app stores "United States", and neither string contains the other, so one
     value matched nothing. */
  const wants = (args.values || [args.value || ''])
    .map(v => norm(v).toLowerCase()).filter(Boolean);
  const want = wants[0] || '';
  const lbl = args.label.toLowerCase();

  const matches = text => {
    const t = norm(text).toLowerCase();
    if (!t) return false;
    return wants.some(w => t === w)
        || wants.some(w => t.indexOf(w) >= 0 || w.indexOf(t) >= 0);
  };

  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === lbl;
  }).pop() || deepAll(document, '*').filter(e => {
    /* No label attribute: a plain <label> or heading sitting beside it. */
    const t = norm(e.textContent).toLowerCase();
    return (t === lbl || t === lbl + ':') && !e.querySelector('*');
  }).map(e => {
    let scope = e, hops = 0;
    while (scope && hops < 4) {
      const c = deepAll(scope, 'select,[role=listbox],[role=combobox],kat-dropdown')
        .find(x => !x.contains(e));
      if (c) return c;
      scope = deepParent(scope); hops++;
    }
    return null;
  }).filter(Boolean).pop();

  if (!ctl) return { ok: false, reason: 'no control named "' + args.label + '"' };

  const fire = el => {
    for (const n of ['input', 'change']) {
      el.dispatchEvent(new Event(n, { bubbles: true, composed: true }));
    }
  };

  /* ---- 1. a component with its own options/value interface ---------------
     <kat-dropdown> carries `options` and `value`. That is an interface, not
     markup, and it is the thing to call: the choices are never in the DOM to
     be clicked, so every attempt to find and click them failed while the
     control sat there perfectly operable. */
  const readOptions = el => {
    let o = null;
    try { o = el.options; } catch (e) { o = null; }
    if (!Array.isArray(o)) {
      try { o = JSON.parse(el.getAttribute('options') || 'null'); } catch (e) { o = null; }
    }
    return Array.isArray(o) ? o : null;
  };
  const nameOf = o => norm(o && (o.name != null ? o.name
    : (o.label != null ? o.label : (o.text != null ? o.text : o.value))));

  const katOpts = readOptions(ctl);
  if (katOpts && katOpts.length) {
    const offered = katOpts.map(nameOf).filter(Boolean);

    if (args.all) {
      /* A multi-select takes an array. If it will not hold one, it is a
         single-choice control and says so by keeping a single value. */
      const values = katOpts.map(o => (o && o.value !== undefined) ? o.value : nameOf(o));
      try {
        ctl.value = values;
        fire(ctl);
      } catch (e) { /* reported below */ }
      const now = ctl.value;
      if (Array.isArray(now) && now.length > 1) {
        return { ok: true, kind: 'component list (multiple)',
                 chosen: offered, offered };
      }
      return { ok: false, kind: 'component list', offered,
               reason: 'this control takes one choice, not all of them' };
    }

    const hit = katOpts.find(o => wants.indexOf(nameOf(o).toLowerCase()) >= 0
        || wants.indexOf(norm(o && o.value).toLowerCase()) >= 0)
      || katOpts.find(o => matches(nameOf(o)) || matches(o && o.value));

    if (!hit) {
      return { ok: false, kind: 'component list', offered,
               reason: 'no choice matches' };
    }
    const value = (hit.value !== undefined) ? hit.value : nameOf(hit);
    try {
      ctl.value = value;
      ctl.setAttribute('value', String(value));
      fire(ctl);
    } catch (e) {
      return { ok: false, kind: 'component list', offered,
               reason: 'the control refused the value' };
    }
    /* Read it back off the component, not off the screen. */
    const now = norm(String(ctl.value !== undefined ? ctl.value
      : ctl.getAttribute('value') || '')).toLowerCase();
    if (now && now !== norm(String(value)).toLowerCase()) {
      return { ok: false, kind: 'component list', offered,
               reason: 'the value did not stay set' };
    }
    return { ok: true, kind: 'component list', chosen: [nameOf(hit)], offered };
  }

  /* ---- 2. a native <select> ---------------------------------------------- */
  const selects = deepAll(ctl, 'select');
  if (ctl.tagName === 'SELECT') selects.push(ctl);
  if (selects.length) {
    const sel = selects[selects.length - 1];
    const opts = [...sel.options];
    const offered = opts.map(o => norm(o.textContent)).filter(Boolean);

    if (args.all && sel.multiple) {
      for (const o of opts) o.selected = true;
      fire(sel);
      return { ok: true, kind: 'select (multiple)', chosen: offered, offered };
    }

    const pick = opts.find(o => wants.indexOf(norm(o.textContent).toLowerCase()) >= 0
                             || wants.indexOf(norm(o.value).toLowerCase()) >= 0)
      || opts.find(o => matches(o.textContent) || matches(o.value));

    if (!pick) return { ok: false, kind: 'select', offered,
                        reason: 'no option matches' };
    sel.value = pick.value;
    if (typeof sel.selectedIndex === 'number') sel.selectedIndex = pick.index;
    fire(sel);
    /* A component may mirror the value onto itself. */
    try { if (typeof ctl.value !== 'undefined') { ctl.value = pick.value; fire(ctl); } }
    catch (e) { /* not that kind of component */ }
    return { ok: true, kind: 'select', chosen: [norm(pick.textContent)], offered };
  }

  /* ---- 3 & 4. a panel that has to be opened first ------------------------- */
  const opener = deepAll(ctl, 'button,[role=button],[aria-haspopup]').filter(visible);
  for (const t of (opener.length ? [opener[opener.length - 1], ctl] : [ctl])) {
    try { t.click(); break; } catch (e) { continue; }
  }

  const boxes = boxesIn(ctl);
  if (boxes.length) {
    const names = boxes.map(labelOf);
    if (args.all) {
      let ticked = 0, already = 0;
      const stuck = [];
      for (const b of boxes) {
        const r = tick(b);
        if (r === 'ticked') ticked++;
        else if (r === 'already') already++;
        else stuck.push(labelOf(b) || b.tagName.toLowerCase());
      }
      return { ok: !stuck.length, kind: 'tick boxes', chosen: names,
               offered: names, ticked, already, stuck,
               reason: stuck.length ? 'some boxes would not tick' : '' };
    }
    const hit = boxes.find(b => matches(labelOf(b)));
    if (!hit) return { ok: false, kind: 'tick boxes', offered: names,
                       reason: 'no box matches' };
    const r = tick(hit);
    return { ok: r !== 'stuck', kind: 'tick boxes', chosen: [labelOf(hit)],
             offered: names, reason: r === 'stuck' ? 'the box would not tick' : '' };
  }

  /* A custom option list, scoped to this control so navigation links elsewhere
     on the page cannot be mistaken for choices. */
  const items = deepAll(ctl, '[role=option],li,kat-option').filter(visible);
  const offered = items.map(i => norm(i.textContent)).filter(Boolean);
  if (args.all) {
    return { ok: false, kind: 'option list', offered,
             reason: 'this control takes one choice, not all of them' };
  }
  const hit = items.find(i => norm(i.textContent).toLowerCase() === want)
    || items.find(i => matches(i.textContent));
  if (!hit) return { ok: false, kind: 'option list', offered,
                     reason: 'no choice matches' };
  try { hit.click(); } catch (e) {
    return { ok: false, kind: 'option list', offered, reason: 'could not click it' };
  }
  return { ok: true, kind: 'option list', chosen: [norm(hit.textContent)], offered };
}
"""


# Amazon writes a marketplace as a country name in one place and a two-letter
# code in another. Neither string contains the other, so a single spelling
# matched nothing. Every spelling of the wanted answer is offered instead.
COUNTRY_ALIASES = {
    "united states": ["united states", "us", "usa", "amazon.com"],
    "canada": ["canada", "ca", "amazon.ca"],
    "mexico": ["mexico", "m\u00e9xico", "mx", "amazon.com.mx"],
    "brazil": ["brazil", "brasil", "br", "amazon.com.br"],
    "united kingdom": ["united kingdom", "uk", "gb", "amazon.co.uk"],
    "germany": ["germany", "deutschland", "de", "amazon.de"],
    "france": ["france", "fr", "amazon.fr"],
    "italy": ["italy", "italia", "it", "amazon.it"],
    "spain": ["spain", "espa\u00f1a", "es", "amazon.es"],
    "japan": ["japan", "jp", "amazon.co.jp"],
    "australia": ["australia", "au", "amazon.com.au"],
    "india": ["india", "in", "amazon.in"],
}


def spellings(value: str | None) -> list[str]:
    """Every way the page might write this answer.

    Both directions. The app stores "US" because that is what the page prints,
    but another page writes "United States"; looking up only by the long name
    meant a stored code matched nothing at all.
    """
    if not value:
        return []
    v = value.strip()
    low = v.lower()

    group = COUNTRY_ALIASES.get(low)
    if group is None:
        for name, aliases in COUNTRY_ALIASES.items():
            if low in [a.lower() for a in aliases]:
                group = [name] + list(aliases)
                break
    if not group:
        return [v]

    out = [v]
    for a in group:
        if a.lower() != low and a not in out:
            out.append(a)
    return out


def _set_control(page, label: str, value: str | None, progress,
                 every: bool = False) -> dict:
    """Set one labelled control, and say what it turned out to be."""
    res = page.evaluate(SET_CONTROL_JS,
                        {"label": label, "value": value or "",
                         "values": spellings(value), "all": every})

    if not res.get("ok"):
        offered = res.get("offered") or []
        raise RuntimeError(
            "%s could not be set%s: %s.%s Nothing was requested.%s"
            % (label,
               "" if every else " to %r" % value,
               res.get("reason", "unknown"),
               (" It is a %s offering %s." % (res["kind"], ", ".join(
                   repr(o) for o in offered[:8]))) if res.get("kind") else "",
               _shape(page, label)))

    # A control whose boxes carry no readable name still deserves a count.
    # "Marketplace: , , ," told the reader nothing at all.
    chosen = [c for c in (res.get("chosen") or []) if c and c.strip()]
    total = len(res.get("chosen") or [])
    if chosen:
        what = ", ".join(chosen)
    elif total:
        what = "%d selected (the page gives them no readable names)" % total
    else:
        what = "set"
    progress("requesting", "%s: %s - %s."
             % (label, what, res.get("kind", "a control")))
    return res


OPTIONS_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* What a control offers, read from the component rather than the markup.

     This read has always worked - <kat-dropdown> keeps its choices in an
     `options` property. What did NOT work was writing `value` back: the
     component then SHOWS the new value while the page's own validation never
     hears a selection, so Generate Report stays greyed out and the form is
     quietly invalid. So this reads only, and the choosing is done by clicking. */
  const lbl = args.label.toLowerCase();
  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === lbl;
  }).pop();
  if (!ctl) return { ok: false, reason: 'no control named "' + args.label + '"' };

  /* Two names for the same idea. This control keeps its choices in `values`;
     others use `options`. Both are tried, as a property and as a JSON
     attribute, because a component may expose either. */
  const readList = el => {
    for (const key of ['options', 'values']) {
      let o = null;
      try { o = el[key]; } catch (e) { o = null; }
      if (!Array.isArray(o)) {
        try { o = JSON.parse(el.getAttribute(key) || 'null'); } catch (e) { o = null; }
      }
      if (Array.isArray(o) && o.length) return o;
    }
    return null;
  };
  let opts = readList(ctl);

  /* A native <select> keeps them somewhere else again. */
  if (!Array.isArray(opts)) {
    const sel = deepAll(ctl, 'select').pop() || (ctl.tagName === 'SELECT' ? ctl : null);
    if (sel) {
      return { ok: true, native: true,
               options: [...sel.options].map(o => ({ name: norm(o.textContent),
                                                     value: o.value })) };
    }
  }

  if (!Array.isArray(opts)) return { ok: false, reason: 'it lists no choices' };

  return {
    ok: true,
    native: false,
    multiple: !!(ctl.multiple || ctl.hasAttribute('multiple')
                 || ctl.hasAttribute('multiple-hide-select')
                 || Array.isArray(ctl.value)),
    value: (() => { try { return ctl.value; } catch (e) { return null; } })(),
    options: opts.map(o => (typeof o === 'string' || typeof o === 'number')
      ? { name: norm(String(o)), value: o }
      : {
          name: norm(o && (o.name != null ? o.name
            : (o.label != null ? o.label
              : (o.text != null ? o.text : o.value)))),
          value: (o && o.value !== undefined) ? o.value : null,
        }),
  };
}
"""


VALUE_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* The control's current selection, read off the component. */
  const lbl = args.label.toLowerCase();
  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === lbl;
  }).pop();
  if (!ctl) return null;
  try {
    const sel = deepAll(ctl, 'select').pop();
    if (sel) return sel.value;
    return ctl.value;
  } catch (e) { return null; }
}
"""


CHOSEN_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Has this control taken this choice? Judged on what is observable.

     The earlier check read a `value` property. This control has none, so the
     answer was "cannot tell" - and a click was then taken at face value. The
     form went on to be filled in perfectly with no marketplace selected.

     Two things are observable no matter how the component is built:
       * the face of the control now shows the choice, which is what a person
         reads;
       * the tick box on the row carrying those letters is now ticked. */
  const lbl = args.label.toLowerCase();
  const want = norm(args.name).toLowerCase();

  const ctl = deepAll(document, '[label],[aria-label]').filter(e => {
    const l = norm(e.getAttribute('label') || e.getAttribute('aria-label')).toLowerCase();
    return l === lbl;
  }).pop();

  const shown = ctl ? deepText(ctl).toLowerCase() : '';
  /* Does the face carry the answer?

     An earlier version stripped the control's own name out first, to
     avoid mistaking a placeholder for a selection. That removed
     "date range" from "Custom date range" - and the answer with it.
     Instead: the answer has to appear, and the face has to be more than
     the label alone. */
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const onFace = norm(shown) !== lbl
    && new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)').test(shown);

  let boxTicked = false;
  for (const box of boxesIn(document)) {
    /* Which box is this one? Its own name first - some carry it in an
       attribute and render nothing readable at all - then the row it sits on. */
    const own = norm(box.getAttribute('label') || box.getAttribute('aria-label')
      || '').toLowerCase();
    let mine = own === want || (!!own && own.indexOf(want) >= 0);

    if (!mine) {
      let row = box, hops = 0;
      while (row && hops < 3) {
        if (deepText(row).toLowerCase().indexOf(want) >= 0) { mine = true; break; }
        row = deepParent(row); hops++;
      }
    }
    if (!mine) continue;
    if (isTicked(box)) { boxTicked = true; break; }
  }

  return { ok: onFace || boxTicked, onFace: onFace, boxTicked: boxTicked,
           face: shown.slice(0, 80) };
}
"""


def _chosen(page, label: str, name: str) -> bool:
    """Is the choice visibly taken? Observable, not inferred."""
    try:
        res = page.evaluate(CHOSEN_JS, {"label": label, "name": name})
    except Exception:
        return False
    return bool(res and res.get("ok"))


def _options_of(page, label: str, wait_s: int = 25) -> dict:
    """What this control offers. A read, never a write.

    Polled, and the control opened once along the way. An empty list is not an
    answer: the marketplace list is filled in after the page loads - it came
    back empty and this reported that the control "offers nothing" while the
    page was still fetching it. A control that only fills its list when opened
    behaves the same way, so it gets opened too.
    """
    deadline = time.time() + wait_s
    opened = False
    last = None

    while True:
        try:
            res = page.evaluate(OPTIONS_JS, {"label": label})
        except Exception:
            res = None
        if res and res.get("ok") and res.get("options"):
            return res
        last = res

        if not opened:
            ctl = _control_locator(page, label)
            if ctl is not None:
                try:
                    ctl.scroll_into_view_if_needed(timeout=3_000)
                    ctl.click(timeout=5_000)
                    opened = True
                    page.wait_for_timeout(800)
                    continue
                except Exception:
                    opened = True          # do not keep retrying the click
        if time.time() >= deadline:
            break
        page.wait_for_timeout(1000)

    reason = (last or {}).get("reason")
    if not reason:
        reason = ("its list was still empty after %d seconds - the page may not "
                  "have finished loading it" % wait_s)
    raise RuntimeError(
        "%s could not be read: %s.%s Nothing was requested."
        % (label, reason, _shape(page, label)))


def _value_of(page, label: str):
    try:
        return page.evaluate(VALUE_JS, {"label": label})
    except Exception:
        return None


def _control_locator(page, label: str):
    """The component itself. Playwright's CSS pierces open shadow roots, so
    this reaches it wherever it lives."""
    for sel in ('[label="%s"]' % label, '[aria-label="%s"]' % label):
        loc = page.locator(sel).first
        try:
            if loc.count():
                return loc
        except Exception:
            continue
    return None


LOCATE_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* WHERE ON SCREEN is the tick box for this choice?

     Returns a point, not an element. Playwright's own relative selectors
     ("the parent of this") do not cross shadow boundaries, so walking from
     the words to the box beside them has to happen here, where the walk can
     step through a shadow root. The caller then clicks the point with a real
     mouse, which is what the component is listening for.

     The letters and the box are separate elements on the same row - that is
     the shape of this page, and the reason clicking the letters does nothing. */
  const want = norm(args.name).toLowerCase();

  const leaves = deepAll(document, '*').filter(e => {
    if (e.children && e.children.length) return false;   /* leaf text only */
    return norm(e.textContent).toLowerCase() === want && visible(e);
  });

  const out = [];
  for (const leaf of leaves) {
    /* Up from the words until a row that holds a tick box. */
    let node = leaf, hops = 0, box = null;
    while (node && hops < 4) {
      /* Only a TIGHT row counts. Walking up far enough eventually reaches a
         container that holds the whole form, and its first tick box is one of
         the report options - clicking that would tick the wrong thing while
         reporting the country as chosen. A real row reads about as long as
         the answer itself. */
      const text = norm(deepText(node));
      if (text.length > want.length + 40) break;
      const found = boxesIn(node);
      if (found.length) { box = found[0]; break; }
      node = deepParent(node); hops++;
    }

    const target = box || leaf;
    /* The innermost real control, so the point lands on the thing that
       listens rather than on a wrapper. */
    const inner = deepAll(target, 'input[type=checkbox]').filter(visible);
    const hit = inner.length ? inner[inner.length - 1] : target;

    const r = hit.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      kind: box ? 'tick box' : 'the words',
      tag: hit.tagName.toLowerCase(),
    });
  }
  return { points: out };
}
"""


def _points_for(page, name: str) -> list[dict]:
    """Where to click for this choice, in page coordinates."""
    try:
        res = page.evaluate(LOCATE_JS, {"name": name})
    except Exception:
        return []
    return res.get("points") or []


def _click_choice(page, label: str, name: str, why: list | None = None,
                  verify=None) -> bool:
    """Click the choice that reads `name`, and check the control took it.

    Deliberately plain. The list is open and the words are on screen, so this
    finds the words and clicks what is next to them.

    Two details earned their place the hard way:

      * the text is a SIBLING of the tick box, not inside it. Asking the box
        what it was called returned nothing, four times over - "a tick boxes
        offering '', '', '', ''". So the text is found first and the box is
        located from it.
      * a click that lands is not a choice. A forced click goes to whatever is
        on top, which can be a banner floating over the list: it succeeds,
        selects nothing, and the form is submitted empty. So the control is
        asked afterwards.
    """
    note = why if why is not None else []

    # A real mouse click at the box's own coordinates, first. Everything after
    # this is a fallback for pages shaped differently.
    for pt in _points_for(page, name)[:4]:
        try:
            page.mouse.click(pt["x"], pt["y"])
        except Exception as exc:
            note.append("mouse on %s: %s" % (pt["kind"], str(exc)[:70]))
            continue
        page.wait_for_timeout(350)
        if verify is None or verify():
            return True
        note.append("mouse on %s at (%d,%d): clicked, control did not change"
                    % (pt["kind"], pt["x"], pt["y"]))

    want = re.compile(r"^\s*" + re.escape(name) + r"\s*$", re.I)

    try:
        hits = page.get_by_text(want)
        n = hits.count()
    except Exception as exc:
        note.append("could not search for %r (%s)" % (name, str(exc)[:60]))
        return False

    if not n:
        # Nothing READS the name. Some controls put it in an attribute instead
        # and render only a box, so there is no text on screen to find.
        try:
            hits = page.locator(
                '[label="%s" i], [aria-label="%s" i], [title="%s" i], '
                '[value="%s" i]' % (name, name, name, name))
            n = hits.count()
        except Exception:
            n = 0
        if not n:
            note.append("nothing on the page reads or is labelled %r" % name)
            return False

    for i in range(min(n, 8)):
        item = hits.nth(i)
        try:
            if not item.is_visible(timeout=1_000):
                continue
            item.scroll_into_view_if_needed(timeout=2_000)
        except Exception:
            continue

        # The row holding those words, and the tick box in it.
        targets = []
        for up in ("", "xpath=..", "xpath=../.."):
            row = item if not up else item.locator(up)
            for what in ("input[type=checkbox]", "[role=checkbox]", "kat-checkbox"):
                try:
                    box = row.locator(what).first
                    if box.count():
                        targets.append(("the tick box beside it", box))
                        break
                except Exception:
                    continue
            if targets:
                break
        targets.append(("the words themselves", item))

        for what, target in targets:
            for forced in (False, True):
                try:
                    target.click(timeout=2_500, force=forced)
                except Exception as exc:
                    note.append("%s%s: %s" % (what, " (forced)" if forced else "",
                                              str(exc)[:70]))
                    continue
                page.wait_for_timeout(350)
                if verify is None or verify():
                    return True
                note.append("%s%s: clicked, but the control did not change"
                            % (what, " (forced)" if forced else ""))
    return False



def choose(page, label: str, wanted: str | None, progress,
           every: bool = False) -> list[str]:
    """Open a control and click what is wanted. Returns what was chosen.

    The list of choices is READ if the control will give it, but it is not
    required. An earlier version stopped with "it lists no choices" while the
    countries were on screen, because the control had not published them
    anywhere this code could see. What is wanted is already known - "US" - so
    the plain approach is to open the list and click those letters.
    """
    # What to look for, in order: whatever the control calls it, then the
    # ordinary spellings of the answer.
    candidates: list[str] = []
    offered: list[str] = []
    info = None
    try:
        info = _options_of(page, label, wait_s=8)
        offered = [o["name"] for o in info["options"] if o["name"]]
        candidates += _match(wanted, info["options"]) if not every else offered
    except RuntimeError:
        pass                       # the words on screen are enough

    if not every:
        for spelling in spellings(wanted):
            if spelling not in candidates:
                candidates.append(spelling)

    if not candidates:
        raise RuntimeError(
            "%s: nothing to look for - no value was configured. Nothing was "
            "requested." % label)

    if info and info.get("native"):
        # A native <select> is the one case where setting the value IS the
        # real interaction: its options are drawn by the operating system and
        # cannot be clicked at all.
        return _native_select(page, label, wanted, offered, progress, every)

    ctl = _control_locator(page, label)

    def toggle():
        if ctl is None:
            return
        try:
            ctl.scroll_into_view_if_needed(timeout=3_000)
            ctl.click(timeout=8_000)
            page.wait_for_timeout(700)
        except Exception:
            pass

    def verifier(text):
        """Has the control actually taken this choice?

        Never shrugs. An earlier version returned "cannot tell" when the
        control had no `value` property, and a click was then believed - the
        form was filled in perfectly with no marketplace selected and the
        failure was invisible. This looks at what is on screen instead.
        """
        wanted_set = {text.strip().lower()}
        if info:
            for o in info["options"]:
                if o["name"].strip().lower() == text.strip().lower():
                    if o.get("value") is not None:
                        wanted_set.add(str(o["value"]).strip().lower())

        def check():
            now = _value_of(page, label)
            if now is not None:
                items = now if isinstance(now, list) else [now]
                if any(str(x).strip().lower() in wanted_set for x in items):
                    return True
            # No usable value, or it did not match: ask the page.
            return _chosen(page, label, text)
        return check

    why: list[str] = []
    chosen: list[str] = []

    for text in (candidates if every else candidates[:6]):
        got = _click_choice(page, label, text, why, verifier(text))
        if not got:
            # It may simply not be open yet.
            toggle()
            got = _click_choice(page, label, text, why, verifier(text))
        if got:
            chosen.append(text)
            if not every:
                break

    try:
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    except Exception:
        pass

    if not chosen:
        tried = "; ".join(dict.fromkeys(why))[:500] or "no attempts recorded"
        raise RuntimeError(
            "%s could not be set to %r. Looked for %s. Tried: %s. Nothing was "
            "requested.%s"
            % (label, wanted, ", ".join(repr(c) for c in candidates[:6]),
               tried, _shape(page, label)))

    # As the page writes it. "us" is the spelling that matched; "US" is what a
    # person sees, and the log is for a person.
    shown = ", ".join(c.upper() if len(c) <= 3 else c for c in chosen)
    progress("requesting", "%s: %s." % (label, shown))
    return chosen



def _match(wanted: str | None, options: list[dict]) -> list[str]:
    """The option that means what was asked for, allowing for spellings."""
    wants = [w.lower() for w in spellings(wanted)]
    if not wants:
        return []
    for o in options:                                   # exact first
        if o["name"].lower() in wants or str(o.get("value") or "").lower() in wants:
            return [o["name"]]
    for o in options:                                   # then contained
        t = o["name"].lower()
        if t and any(w in t or t in w for w in wants):
            return [o["name"]]
    return []


def _native_select(page, label, wanted, offered, progress, every) -> list[str]:
    """A real <select>: its options cannot be clicked, so the value is set."""
    res = page.evaluate(SET_CONTROL_JS,
                        {"label": label, "value": wanted or "",
                         "values": spellings(wanted), "all": every})
    if not res.get("ok"):
        if every:
            raise RuntimeError("single")
        raise RuntimeError(
            "%s could not be set to %r: %s. It offers %s. Nothing was requested."
            % (label, wanted, res.get("reason", "unknown"),
               ", ".join(repr(o) for o in offered[:8])))
    chosen = [c for c in (res.get("chosen") or []) if c]
    progress("requesting", "%s: %s - a dropdown."
             % (label, ", ".join(chosen) or "set"))
    return chosen


CUSTOM_RANGE = "Custom date range"

# The date boxes that appear once a custom range is chosen. Amazon prints them
# US-style on this page; the value is read back, so a different format shows up
# as a mismatch rather than as a wrong report.
DATE_FORMAT = "%m/%d/%Y"


MARK_DATES_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Tag the From and To boxes so they can be typed into.

     Finding them has to happen here, because the walk from a label to its box
     crosses a shadow boundary. Once tagged, Playwright can address them by
     attribute and use the real keyboard - which is the point: this page
     attaches a calendar to these boxes, and a value merely assigned to them
     is thrown away when the calendar redraws. Both boxes showed today's date
     after being "filled" with next month's.

     The box belonging to a label is the one AFTER it, and never one already
     claimed: taking the first box in the block gave From and To the same one. */
  const taken = [];
  const BOX = 'input:not([type=checkbox]):not([type=radio])';

  const find = want => {
    const w = want.toLowerCase();
    const labels = deepAll(document, 'label,span,div,p').filter(e => {
      const t = norm(e.textContent).toLowerCase();
      return (t === w || t === w + ':') && !e.querySelector('*');
    });
    for (const lab of labels) {
      let scope = lab, hops = 0;
      while (scope && hops < 4) {
        const cands = deepAll(scope, BOX).filter(visible)
          .filter(i => !lab.contains(i) && taken.indexOf(i) < 0);
        const after = cands.filter(i => {
          try {
            return !!(lab.compareDocumentPosition(i)
                      & Node.DOCUMENT_POSITION_FOLLOWING);
          } catch (e) { return false; }
        });
        const box = after[0] || cands[0];
        if (box) { taken.push(box); return box; }
        scope = deepParent(scope); hops++;
      }
    }
    const named = deepAll(document,
      'input[name*="' + w + '" i],input[aria-label*="' + w + '" i],'
      + 'input[placeholder*="' + w + '" i]')
      .filter(visible).filter(i => taken.indexOf(i) < 0)[0] || null;
    if (named) taken.push(named);
    return named;
  };

  const out = {};
  for (const which of ['From', 'To']) {
    const box = find(which);
    if (box) {
      box.setAttribute('data-acp-' + which.toLowerCase(), '1');
      out[which] = true;
    } else {
      out[which] = false;
    }
  }
  return out;
}
"""


READ_DATES_JS = r"""
() => {
""" + DEEP_PRELUDE + r"""
  const get = which => {
    const b = deepAll(document, '[data-acp-' + which + ']')[0];
    return b ? norm(b.value) : null;
  };
  return { from: get('from'), to: get('to') };
}
"""


def _is_custom(range_name: str | None) -> bool:
    return bool(range_name) and range_name.strip().lower() == CUSTOM_RANGE.lower()


def _as_page_date(iso: str) -> str:
    """An ISO date, written the way the page writes dates."""
    from datetime import date as _date
    y, m, d = (int(x) for x in iso.split("-"))
    return _date(y, m, d).strftime(DATE_FORMAT)


def fill_custom_dates(page, date_from: str, date_to: str, progress) -> None:
    """Type the reporting period into the From and To boxes.

    TYPED, not assigned. These boxes carry a calendar, and a value written
    straight onto them is discarded the moment the calendar redraws - both
    boxes came back showing today's date after being "filled" with dates two
    months apart. Real keystrokes are what the calendar is listening for.

    The values are read back afterwards. A date the page quietly replaced with
    its own would otherwise produce a report for a period nobody asked for,
    which is the failure that looks exactly like real data.
    """
    want_from, want_to = _as_page_date(date_from), _as_page_date(date_to)

    # The boxes are drawn when the custom range is chosen, so give them a moment.
    # The boxes are drawn in response to the range being chosen, and that can
    # take a moment on a slow page. Four seconds was not always enough, and
    # the run then stopped saying the From box "is not on the page" when it
    # was about to appear.
    marked = {}
    for _ in range(15):
        try:
            marked = page.evaluate(MARK_DATES_JS) or {}
        except Exception:
            marked = {}
        if marked.get("From") and marked.get("To"):
            break
        page.wait_for_timeout(1000)

    missing = [w for w in ("From", "To") if not marked.get(w)]
    if missing:
        raise RuntimeError(
            "The custom date range needs a %s box and it is not on the page. "
            "Nothing was requested." % " and a ".join(missing))

    for which, value in (("from", want_from), ("to", want_to)):
        box = page.locator("[data-acp-%s]" % which).first
        try:
            box.scroll_into_view_if_needed(timeout=3_000)
            box.click(timeout=5_000)
            # Clear whatever the calendar put there, then type.
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.keyboard.type(value, delay=40)
            # Commit and close the calendar. Escape alone can revert it, so
            # the value is committed first.
            page.keyboard.press("Enter")
            page.wait_for_timeout(400)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
        except Exception as exc:
            raise RuntimeError(
                "The %s date could not be typed: %s. Nothing was requested."
                % (which.title(), str(exc)[:120])) from exc

    got = page.evaluate(READ_DATES_JS) or {}
    bad = []
    for which, value in (("from", want_from), ("to", want_to)):
        if (got.get(which) or "").strip() != value:
            bad.append("%s shows %r, not %r"
                       % (which.title(), got.get(which), value))
    if bad:
        raise RuntimeError(
            "The reporting period did not stay in the date boxes: %s. Nothing "
            "was requested - a report for the wrong dates is worse than none."
            % "; ".join(bad))

    progress("requesting",
             "Reporting period entered: %s to %s." % (want_from, want_to))


# ── the pieces of the form ──────────────────────────────────────────────────

DISMISS_JS = r"""
() => {
""" + DEEP_PRELUDE + r"""
  /* Close the notices that float over the form.

     The page carries an informational banner about a surcharge, and the
     marketplace list opens UPWARDS into it. A click then lands on the banner
     instead of the country, which registers nothing while appearing to work.
     Closing the notice first removes the problem rather than working round it.

     Only buttons that say they close something, and only inside something that
     looks like a notice. Nothing here submits, deletes or navigates. */
  const NOTICE = '[role=alert],[role=status],kat-alert,[class*=alert i],'
    + '[class*=banner i],[class*=notification i],[class*=notice i]';
  const CLOSE = 'button,[role=button],kat-button,a';
  const closed = [];

  for (const notice of deepAll(document, NOTICE)) {
    if (!visible(notice)) continue;
    for (const b of deepAll(notice, CLOSE)) {
      const name = norm((b.getAttribute('aria-label') || '')
        + ' ' + (b.getAttribute('title') || '')
        + ' ' + (b.getAttribute('label') || '')
        + ' ' + (b.textContent || '')).toLowerCase();
      const looksLikeClose = /close|dismiss/.test(name)
        || name === 'x' || name === '\u00d7' || name === '\u2715';
      if (!looksLikeClose || !visible(b)) continue;
      try {
        b.click();
        closed.push(norm(notice.textContent).slice(0, 40));
      } catch (e) { /* leave it; the click below may still get through */ }
      break;
    }
  }
  return { closed: closed };
}
"""


def dismiss_notices(page, progress) -> int:
    """Close banners floating over the form, so a click cannot land on one."""
    try:
        res = page.evaluate(DISMISS_JS)
    except Exception:
        return 0
    n = len(res.get("closed") or [])
    if n:
        progress("requesting",
                 "Closed %d notice%s covering the form."
                 % (n, "" if n == 1 else "s"))
        page.wait_for_timeout(500)
    return n


def pick_marketplace(page, progress, country: str = "United States") -> int:
    """Choose ONE marketplace - the country this report is for.

    One, not all. This page produces a report for a single marketplace, and
    Generate Report stays disabled until exactly one is chosen. An earlier
    version tried to select every country at once, which the page would not
    accept and which left the form looking filled while it was not.
    """
    chosen = choose(page, "Marketplace", country, progress)
    page.wait_for_timeout(600)
    return len(chosen) or 1


def pick_date_range(page, value: str, progress,
                    date_from: str | None = None,
                    date_to: str | None = None) -> None:
    """Choose the range, then read it back.

    Four choices: three named windows, and a custom one that reveals From and
    To boxes. The custom one is how the app's own reporting period reaches the
    report, so it is filled in here rather than left at whatever the page
    happened to be showing.
    """
    progress("requesting", "Choosing date range: %s." % value)
    choose(page, "Date Range", value, progress)
    page.wait_for_timeout(800)

    # Read back. Asking for the wrong window is the failure that looks like
    # real data, so it is checked rather than assumed.
    shown = _read_control(page, "Date Range")
    if shown and value.lower() not in shown.lower():
        raise RuntimeError(
            "Asked for the date range %r but the control shows %r. Nothing was "
            "requested." % (value, shown))
    # A custom range is only half-chosen until the dates are in it.
    if value.strip().lower() == CUSTOM_RANGE.lower():
        if not (date_from and date_to):
            raise RuntimeError(
                "The date range is set to %r, which needs a From and a To "
                "date, but none were given. Choose a named range in the app, "
                "or set a reporting period. Nothing was requested."
                % CUSTOM_RANGE)
        page.wait_for_timeout(900)          # the boxes are drawn on selection
        fill_custom_dates(page, date_from, date_to, progress)

    if shown:
        progress("requesting", "Date range confirmed: %s." % value)
    else:
        # An unreadable control is not a confirmed one. Saying "confirmed" here
        # would be this app inventing a check it did not perform. The Generate
        # Report button is still ahead, and it stays disabled on an invalid
        # form, so the run is not proceeding unguarded.
        progress("requesting",
                 "Chose %s, but the control could not be read back to confirm "
                 "it. Continuing \u2014 Generate Report stays greyed out if the "
                 "form is not valid." % value)


OPTION_POINTS_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Every configuration tick box under the printed heading: what it is
     called, whether it is already ticked, and WHERE IT IS ON SCREEN.

     A point, not an element. These boxes were ticked with a click dispatched
     from page script, which draws the tick but does not always reach the
     component's own handler - so the page never registered the change and
     Generate Report stayed greyed out over a form that looked complete. The
     caller clicks these points with a real mouse instead. */
  const want = args.heading.toLowerCase();
  const heads = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    return t.startsWith(want) && t.length < want.length + 60;
  });
  if (!heads.length) return { ok: false, reason: 'heading not found' };

  let block = null;
  for (const head of heads.reverse()) {
    let node = head, hops = 0;
    while (node && hops < 12) {
      if (node.tagName !== 'BODY' && boxesIn(node).length >= args.min) {
        block = node; break;
      }
      const after = [];
      let sib = node.nextElementSibling;
      while (sib) { after.push(sib); sib = sib.nextElementSibling; }
      const hit = after.find(x => boxesIn(x).length >= args.min);
      if (hit) { block = hit; break; }
      node = deepParent(node); hops++;
    }
    if (block) break;
  }
  if (!block) return { ok: false, reason: 'no block of tick boxes under it' };

  const out = [];
  for (const box of boxesIn(block)) {
    /* The innermost real control, so the point lands on the thing that
       listens rather than on a wrapper around it. */
    const inner = deepAll(box, 'input[type=checkbox]').filter(visible);
    const hit = inner.length ? inner[inner.length - 1] : box;
    const r = hit.getBoundingClientRect();

    /* WHERE to click.

       The middle of the element is right for a tick box. It is wrong for a
       whole ROW: a row is mostly its label, and clicking the words beside a
       tick box does nothing on this page. When no inner box could be reached,
       the element is the row, so aim near its left edge where the box sits -
       not at its centre, which is somewhere in the text. */
    const wide = !inner.length && r.width > 60;
    const x = wide ? Math.round(r.left + Math.min(12, r.width / 4))
                   : Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    /* What is actually at that point, so a click that does nothing can say
       what it landed on instead of just failing. */
    let at = '';
    try {
      const el = document.elementFromPoint(x, y);
      at = el ? (el.tagName.toLowerCase()
        + (el.id ? '#' + el.id : '')
        + ':' + norm(el.textContent).slice(0, 24)) : '(nothing)';
    } catch (e) { at = '(unknown)'; }

    out.push({
      label: labelOf(box),
      ticked: isTicked(box),
      x: x, y: y,
      sized: r.width >= 1 && r.height >= 1,
      aimedAt: inner.length ? 'the tick box itself' : 'the row, near its left edge',
      rect: [Math.round(r.left), Math.round(r.top),
             Math.round(r.width), Math.round(r.height)],
      under: at,
    });
  }
  return { ok: true, count: out.length, boxes: out };
}
"""


SHOW_OPTION_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Bring one option into view and say where it now is.

     A click goes to a point in the VIEWPORT. A box scrolled off the top or
     the bottom still has a position, but it is not a position the mouse can
     reach - the click lands on whatever happens to be there, or on nothing at
     all. That is why some options ticked and others did not: by the time the
     form above had been filled in, the page had moved, and the boxes at one
     end of the list were off screen. Which ones depended only on where the
     page happened to be sitting.

     So each box is scrolled into view immediately before it is clicked, and
     its position is read AFTER the scroll. */
  const want = norm(args.label).toLowerCase();
  const heads = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    return t.startsWith(args.heading) && t.length < args.heading.length + 60;
  });
  let block = null;
  for (const head of heads.reverse()) {
    let node = head, hops = 0;
    while (node && hops < 12) {
      if (node.tagName !== 'BODY' && boxesIn(node).length >= args.min) { block = node; break; }
      const after = [];
      let sib = node.nextElementSibling;
      while (sib) { after.push(sib); sib = sib.nextElementSibling; }
      const hit = after.find(x => boxesIn(x).length >= args.min);
      if (hit) { block = hit; break; }
      node = deepParent(node); hops++;
    }
    if (block) break;
  }
  if (!block) return { ok: false };

  const box = boxesIn(block).find(b => norm(labelOf(b)).toLowerCase() === want);
  if (!box) return { ok: false };

  try { box.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) { /* fine */ }

  const inner = deepAll(box, 'input[type=checkbox]').filter(visible);
  const hit = inner.length ? inner[inner.length - 1] : box;
  const r = hit.getBoundingClientRect();
  const wide = !inner.length && r.width > 60;
  const x = wide ? Math.round(r.left + Math.min(12, r.width / 4))
                 : Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);

  let at = '';
  try {
    const el = document.elementFromPoint(x, y);
    at = el ? el.tagName.toLowerCase() : '(nothing)';
  } catch (e) { at = '(unknown)'; }

  return {
    ok: true, x: x, y: y,
    /* Is that point actually reachable by a mouse now? */
    onScreen: y >= 0 && y <= (window.innerHeight || 0)
              && x >= 0 && x <= (window.innerWidth || 0),
    ticked: isTicked(box),
    under: at,
  };
}
"""


OPTION_STATES_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* Which of them are ticked now. Read back after clicking, because drawing a
     tick and the page accepting one are different things. */
  const want = args.heading.toLowerCase();
  const heads = deepAll(document, '*').filter(e => {
    const t = norm(e.textContent).toLowerCase();
    return t.startsWith(want) && t.length < want.length + 60;
  });
  let block = null;
  for (const head of heads.reverse()) {
    let node = head, hops = 0;
    while (node && hops < 12) {
      if (node.tagName !== 'BODY' && boxesIn(node).length >= args.min) {
        block = node; break;
      }
      const after = [];
      let sib = node.nextElementSibling;
      while (sib) { after.push(sib); sib = sib.nextElementSibling; }
      const hit = after.find(x => boxesIn(x).length >= args.min);
      if (hit) { block = hit; break; }
      node = deepParent(node); hops++;
    }
    if (block) break;
  }
  if (!block) return { ok: false };
  return {
    ok: true,
    states: boxesIn(block).map(b => ({ label: labelOf(b), ticked: isTicked(b) })),
  };
}
"""


def tick_every_option(page, progress) -> dict:
    """Tick every box under "Simplified Report Configuration Options".

    ONE AT A TIME, re-finding each box immediately before clicking it.

    Coordinates were read for all six up front and then clicked in sequence.
    Ticking a box moves the page - a description wraps, a message appears -
    so every later coordinate was stale by the time it was used, and a click
    could land on whatever had slid into that spot. On this page the thing
    below them is Generate Report, which is why the form was submitted early,
    before the note had been typed.

    Clicked with a real mouse, because a click dispatched from page script
    draws the tick without the page registering it.

    No list of box names is carried. The instruction is "tick all of them", and
    a name Amazon renames would silently drop a column from the export - which
    is worse than stopping, because the missing money just looks like less
    money.
    """
    look = page.evaluate(OPTION_POINTS_JS,
                         {"heading": OPTIONS_HEADING, "min": 4})
    if not look.get("ok"):
        raise RuntimeError(
            "This does not look like the SKU Economics page any more: %s. "
            "Nothing was requested. For reference, the %s"
            % (look.get("reason", "unknown"), _dump(page)))

    boxes = look.get("boxes") or []
    seen = " | ".join(b.get("label", "") for b in boxes).lower()
    recognised = [k for k in KNOWN_OPTIONS if k in seen]
    if len(recognised) < 4:
        raise RuntimeError(
            "Found %d tick boxes under the configuration heading, but only %d "
            "of the expected options were recognisable (%s). The report would "
            "not contain the columns this app reads, so nothing was requested."
            % (len(boxes), len(recognised), ", ".join(recognised) or "none"))

    total = len(boxes)
    already = sum(1 for b in boxes if b.get("ticked"))
    clicked = 0

    # Tracked by LABEL, never by position.
    #
    # Every box used to be identified by its index in the list. The list is
    # re-read before each click, and if the page re-renders between reads the
    # order can change - so the wrong box was checked afterwards, and a box
    # that was ALREADY ticked could be clicked again and turned back off. The
    # run then reported boxes as "would not tick" that had ticked perfectly
    # well a moment earlier.
    #
    # A label is what the box is; where it sits is incidental.
    tries: dict[str, int] = {}
    given_up: set[str] = set()
    ATTEMPTS = 3

    def unticked_now(rows):
        return [b for b in rows
                if b.get("label") and not b.get("ticked")
                and b.get("label") not in given_up]

    for _ in range(total * ATTEMPTS + 4):
        fresh = page.evaluate(OPTION_POINTS_JS,
                              {"heading": OPTIONS_HEADING, "min": 4})
        if not fresh.get("ok"):
            break

        waiting = [b for b in unticked_now(fresh.get("boxes") or [])
                   if b.get("sized")]
        if not waiting:
            break

        name = waiting[0]["label"]
        tries[name] = tries.get(name, 0) + 1

        # Bring it into view and take its position AFTER the scroll. A point
        # read before scrolling belongs to where the box used to be.
        spot = page.evaluate(SHOW_OPTION_JS,
                             {"label": name, "heading": OPTIONS_HEADING, "min": 4})
        if not spot.get("ok"):
            if tries[name] >= ATTEMPTS:
                given_up.add(name)
            continue
        if spot.get("ticked"):
            continue                      # the scroll revealed it was already on
        if not spot.get("onScreen"):
            # Scrolled, and still not reachable. Clicking would hit whatever is
            # at that spot, or nothing.
            if tries[name] >= ATTEMPTS:
                given_up.add(name)
            page.wait_for_timeout(200)
            continue

        page.wait_for_timeout(150)        # let the scroll settle
        try:
            page.mouse.click(spot["x"], spot["y"])
        except Exception:
            if tries[name] >= ATTEMPTS:
                given_up.add(name)
            continue

        # Let the page react - and move, if it is going to - before the next
        # box is located. Longer on a retry, in case the first was too early.
        page.wait_for_timeout(300 + 250 * (tries[name] - 1))

        check = page.evaluate(OPTION_STATES_JS,
                              {"heading": OPTIONS_HEADING, "min": 4})
        state = next((s for s in (check.get("states") or [])
                      if s.get("label") == name), None)
        if state and state.get("ticked"):
            clicked += 1
        elif tries[name] >= ATTEMPTS:
            given_up.add(name)      # move on; it is reported at the end


    # Read back. Anything still unticked is a column the report would not have.
    after = page.evaluate(OPTION_STATES_JS,
                          {"heading": OPTIONS_HEADING, "min": 4})
    states = after.get("states") or []
    missed = [st.get("label") or "(unnamed)" for st in states if not st.get("ticked")]
    if missed or not states:
        # WHERE each stubborn box was, what was aimed at, and what was actually
        # under that point. "Would not tick" on its own gave no way to tell a
        # box that ignores clicks from one being clicked in the wrong place.
        detail = []
        try:
            last = page.evaluate(OPTION_POINTS_JS,
                                 {"heading": OPTIONS_HEADING, "min": 4})
            for b in (last.get("boxes") or []):
                if b.get("label") in missed:
                    detail.append(
                        "%s: clicked (%d,%d) aiming at %s, box at %s, under the "
                        "pointer was %s"
                        % (b.get("label"), b.get("x", -1), b.get("y", -1),
                           b.get("aimedAt", "?"), b.get("rect"),
                           b.get("under", "?")))
        except Exception:
            pass

        raise RuntimeError(
            "%d of %d configuration options would not tick (%s). The export "
            "would be missing those columns, so nothing was requested.%s"
            % (len(missed), len(states) or total,
               ", ".join(missed[:6]) or "none could be read",
               (" " + "; ".join(detail)) if detail else ""))

    progress("requesting",
             "All %d configuration options ticked (%d already were)."
             % (len(states), already))
    return {"total": len(states), "ticked": clicked, "already": already}



def write_note(page, progress) -> str | None:
    """A one-off tag in Add Notes, so the finished file is identifiable.

    TYPED, not assigned. Every other control on this page ignores input that
    did not come from a keyboard or a mouse, and this box is no different: a
    value written into it SHOWS in the box - it reads back correctly, which is
    what made this look fine - while the page's own state never hears it and
    the request is submitted with no note at all. Reports came back untagged
    and had to be identified by their dates instead.

    Without a tag, our report is told apart from an older one only by its
    dates and by being new, which is weaker. So this matters.
    """
    tag = "acp-" + uuid.uuid4().hex[:8]        # 12 characters of the 50 allowed

    box = None
    for sel in ('textarea[placeholder*="notes" i]',
                'input[placeholder*="notes" i]',
                'textarea[placeholder*="Max 50" i]',
                'input[placeholder*="Max 50" i]'):
        loc = page.locator(sel).first
        try:
            if loc.count():
                box = loc
                break
        except Exception:
            continue
    if box is None:
        progress("requesting",
                 "No notes box found; the report will be matched on its date "
                 "range and on being new instead.")
        return None

    try:
        box.scroll_into_view_if_needed(timeout=3_000)
        box.click(timeout=8_000)
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        page.keyboard.type(tag, delay=30)
        page.wait_for_timeout(250)
    except Exception as exc:
        progress("requesting",
                 "The notes box would not accept the tag (%s); the report will "
                 "be matched on its date range and on being new instead."
                 % str(exc)[:80])
        return None

    try:
        got = (box.input_value(timeout=8_000) or "").strip()
    except Exception:
        got = ""
    if got != tag:
        # Not fatal. The dates plus "this row is new" still identify the
        # report, and refusing to run over a missing label would be worse
        # than running without one.
        progress("requesting",
                 "The notes box shows %r rather than the tag; the report will "
                 "be matched on its date range and on being new instead." % got)
        return None

    progress("requesting", "Tagged this request %s." % tag)
    return tag



GENERATE_JS = r"""
(args) => {
""" + DEEP_PRELUDE + r"""
  /* The Generate Report button, and whether Amazon has enabled it yet.

     Its disabled state is the whole point: this page greys the button out
     until the form is valid, so "enabled" is Amazon's own confirmation that
     every tick and every choice above actually registered. */
  /* VISIBLE ones only.

     This page has tabs - SKU Economics Report, Fees and Economics Preview
     Report - and each carries its own Generate Report button. Taking the last
     match in the document could press the button belonging to a tab that is
     not on screen: the form filled in here stayed filled, while a report was
     generated from the OTHER tab's empty form. That is exactly what an
     untagged report with default dates looks like. */
  const all = deepAll(document, 'button,kat-button,[role=button],input[type=submit]')
    .filter(e => {
      const t = norm(e.getAttribute('label') || e.textContent || e.value || '');
      return /generate report/i.test(t);
    });
  const hits = all.filter(visible);
  if (!hits.length) {
    return { found: false,
             hidden: all.length,
             reason: all.length
               ? 'the only Generate Report buttons on the page are hidden, '
                 + 'which usually means another tab is showing'
               : 'no Generate Report button is on the page' };
  }

  const btn = hits[hits.length - 1];

  /* Disabled where? A component is a wrapper round a real <button>, and only
     the WRAPPER carries `disabled`; the inner button never does. Asking the
     inner one produced "enabled" on a button that was plainly greyed out, so
     the click went to an element whose handler checks the wrapper and does
     nothing - and this reported that the report had been requested when it
     had not. Every representation of the button gets a say, and any one of
     them saying disabled means disabled. */
  const saysOff = el => el && (el.disabled === true
    || (el.hasAttribute && el.hasAttribute('disabled'))
    || (el.getAttribute && (el.getAttribute('aria-disabled') || '') === 'true'));

  let off = hits.some(saysOff);
  let up = deepParent(btn), hops = 0;
  while (!off && up && hops < 4) {
    if (saysOff(up)) off = true;
    up = deepParent(up); hops++;
  }

  try { btn.scrollIntoView({ block: 'center' }); } catch (e) { /* fine */ }

  /* A POINT, not a click.

     This used to press the button from page script. That never blurs
     anything, and this page commits the notes box on blur - so the tag was in
     the box and absent from the submission. Clicking it manually worked for
     exactly that reason. The caller uses a real mouse. */
  const r = btn.getBoundingClientRect();
  return {
    found: true,
    enabled: !off,
    tag: btn.tagName.toLowerCase(),
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    sized: r.width >= 1 && r.height >= 1,
  };
}
"""


def confirm_note(page, tag: str, progress) -> str | None:
    """Is the tag still in the notes box? Put it back once if not.

    Checked immediately before pressing Generate. Returns the tag when it is
    there, and None when it is not - a report that went out untagged has to be
    found by its dates, and saying so is better than hunting for a tag that
    was never submitted.
    """
    for sel in ('textarea[placeholder*="notes" i]',
                'input[placeholder*="notes" i]',
                'textarea[placeholder*="Max 50" i]',
                'input[placeholder*="Max 50" i]'):
        box = page.locator(sel).first
        try:
            if not box.count():
                continue
            got = (box.input_value(timeout=5_000) or "").strip()
        except Exception:
            continue

        if got == tag:
            return tag

        # Gone or changed. One attempt to put it back, typed as before.
        try:
            box.click(timeout=5_000)
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.keyboard.type(tag, delay=30)
            page.wait_for_timeout(250)
            again = (box.input_value(timeout=5_000) or "").strip()
        except Exception:
            again = ""

        if again == tag:
            progress("requesting",
                     "The tag had gone from the notes box; typed it again "
                     "before generating.")
            return tag

        progress("requesting",
                 "The notes box lost the tag (it shows %r). Generating anyway; "
                 "the report will be matched on its dates and on being new."
                 % again)
        return None

    return None


def generate(page, progress) -> None:
    """Wait for Generate Report to become enabled, then press it.

    The button is disabled until the form is valid, which makes it Amazon's own
    confirmation that every selection above actually registered. Waiting for it
    is a real check; clicking a dead button and reporting success is not.
    """
    deadline = time.time() + 45
    state = None
    while time.time() < deadline:
        state = page.evaluate(GENERATE_JS, {"click": False})
        if state.get("found") and state.get("enabled"):
            break
        page.wait_for_timeout(1000)

    if not (state or {}).get("found"):
        raise RuntimeError(
            "The Generate Report button could not be used: %s. Nothing was "
            "requested. For reference, the %s"
            % ((state or {}).get("reason", "it is not on the page"),
               _dump(page)))

    if not state.get("enabled"):
        raise RuntimeError(
            "Generate Report stayed greyed out for 45 seconds, which is "
            "Amazon saying it did not accept the selections above. Nothing was "
            "requested \u2014 a report generated from a half-filled form is "
            "worse than none. For reference, the %s" % _dump(page))

    # Take focus OUT of whatever was last typed into, so the page commits it.
    # The notes box commits on blur; without this the tag sat in the field and
    # never reached the request.
    try:
        page.keyboard.press("Tab")
        page.wait_for_timeout(400)
    except Exception:
        pass

    # Re-read: the button may have moved while the page settled.
    state = page.evaluate(GENERATE_JS, {"click": False})
    if not state.get("sized"):
        raise RuntimeError(
            "The Generate Report button has no position on screen, so it "
            "cannot be pressed. Nothing was requested.")

    progress("requesting", "Generating the report.")
    try:
        page.mouse.click(state["x"], state["y"])
    except Exception as exc:
        raise RuntimeError(
            "The Generate Report button would not accept a click (%s). "
            "Nothing was requested." % str(exc)[:100]) from exc
    page.wait_for_timeout(3000)


# ── waiting for the file ────────────────────────────────────────────────────

DOWNLOAD_WORDS = ("download", "ready", "complete", "completed")
PENDING_WORDS = ("pending", "processing", "in progress", "in-progress",
                 "generating", "queued", "submitted")


def _rows_under_generated(page):
    """The rows of the Generated Reports list."""
    # Playwright's own CSS engine pierces open shadow roots, so the rows are
    # reachable from here without walking them by hand.
    return page.locator("tr, [role=row], kat-table-row")


def _date_tokens(iso: str) -> list[str]:
    """Every way the list might print this date.

    The Generated Reports list writes "9/22/26" while the form was given
    "09/22/2026". Neither string contains the other, so a row was never
    recognised as ours.
    """
    y, m, d = (int(x) for x in iso.split("-"))
    return [
        "%d/%d/%02d" % (m, d, y % 100),        # 9/22/26
        "%d/%d/%d" % (m, d, y),                # 9/22/2026
        "%02d/%02d/%04d" % (m, d, y),          # 09/22/2026
        "%02d/%02d/%02d" % (m, d, y % 100),    # 09/22/26
        iso,                                    # 2026-09-22
    ]


def _row_counts(page) -> dict:
    """How many rows currently carry each text.

    A COUNT, not a set. Asking for the same dates twice produces a row whose
    text is identical to the older one, and a set would hide both - the old
    row and ours. "Two rows now where there was one" is the fact that matters.
    """
    out: dict[str, int] = {}
    try:
        rows = _rows_under_generated(page)
        for i in range(min(rows.count(), 60)):
            try:
                t = _norm(rows.nth(i).inner_text(timeout=3_000))
            except Exception:
                continue
            if t:
                out[t] = out.get(t, 0) + 1
    except Exception:
        pass
    return out


def _is_new_row(text: str, before: dict, now: dict) -> bool:
    """Did this row appear since the request was made?

    Compared by COUNT. Asking for the same dates twice produces a row whose
    text is identical to the older one, so "is this text present" cannot tell
    them apart - but "there are two of them now where there was one" can.
    Without this, an untagged run could download a report generated days ago
    and present it as today's figures.
    """
    return now.get(text, 0) > before.get(text, 0)


def _row_is_ours(text: str, tag: str | None, date_range: str,
                 date_from: str | None, date_to: str | None) -> bool:
    """Is this row the report we asked for?

    The tag is the reliable answer and is used whenever Amazon kept it. What
    follows is the fallback, and it has to compare like with like: a custom
    range is recognised by its DATES, because that is what the list prints -
    matching on the words "Custom date range" found nothing, forever, while
    the finished report sat in the list.
    """
    low = text.lower()
    if tag:
        return tag.lower() in low

    if _is_custom(date_range) and date_from and date_to:
        return all(any(tok in text for tok in _date_tokens(iso))
                   for iso in (date_from, date_to))

    return date_range.lower() in low


def wait_for_report(page, tag: str | None, date_range: str, progress,
                    date_from: str | None = None, date_to: str | None = None,
                    before: dict | None = None):
    """Watch the Generated Reports list until OUR row offers a download.

    WATCHES. It does not reload.

    Reloading every few seconds was doing real harm: reading the page while a
    navigation was in flight raised "Execution context was destroyed" and
    failed the job over nothing but timing, and each reload threw away and
    rebuilt the very list being watched. The page updates the list itself -
    Pending becomes Ready without help - so the right thing is to wait and
    look.

    A reload is kept as a last resort, for the case where the list genuinely
    does not refresh itself. It happens only after a long stretch with no
    change at all, not on a timer.

    With a tag, the row is identified exactly. Without one, it is identified by
    its dates AND by being NEW - a report for the same dates may already be
    sitting in the list from an earlier run, and downloading that one would
    quietly give figures from another day.
    """
    started = time.time()
    last_note = 0.0
    last_change = time.time()
    last_seen = None
    reloads = 0

    # A tag is the reliable way to find our report - when Amazon kept it. It
    # did not always: the notes box used to lose the tag before the request
    # went in. Hunting for a tag that was never submitted would search until
    # the whole wait ran out, so after a while the dates are tried instead,
    # and that is said rather than quietly done.
    tag_only_until = started + TAG_PATIENCE_S if tag else 0
    fell_back = False

    while time.time() - started < BUILD_TIMEOUT_S:
        if tag and not fell_back and time.time() > tag_only_until:
            fell_back = True
            tag = None
            progress("requesting",
                     "No report carrying our tag has appeared in %d seconds. "
                     "Looking for one matching the dates instead, and only one "
                     "that was not already in the list."
                     % TAG_PATIENCE_S)
        if looks_like_login(page.url):
            await_login(page, progress)

        rows = _rows_under_generated(page)
        try:
            n = rows.count()
        except Exception:
            n = 0
        seen_now = _row_counts(page) if (not tag and before is not None) else {}

        pending_ours = False
        for i in range(n):
            row = rows.nth(i)
            try:
                text = _norm(row.inner_text(timeout=4_000))
            except Exception:
                continue
            low = text.lower()

            if not _row_is_ours(text, tag, date_range, date_from, date_to):
                continue

            # Untagged: it also has to be one that was not there before.
            if not tag and before is not None:
                if not _is_new_row(text, before, seen_now):
                    continue

            if any(w in low for w in PENDING_WORDS):
                pending_ours = True
                break

            link = row.locator(
                'a:has-text("Download"), button:has-text("Download"), '
                'a[download], a[href*="download" i]').first
            try:
                if link.count():
                    progress("downloading", "The report is ready.")
                    return row, link
            except Exception:
                pass

        # Has anything on the page moved since the last look?
        try:
            fingerprint = (n, _norm(page.inner_text("body", timeout=5_000))[:4000])
        except Exception:
            fingerprint = (n, None)
        if fingerprint != last_seen:
            last_seen = fingerprint
            last_change = time.time()

        if time.time() - last_note > 20:
            mins = int((time.time() - started) // 60)
            progress("requesting",
                     "Amazon is still building the report (%d min). Watching "
                     "the list; the page is left alone." % mins
                     if pending_ours or not n else
                     "Waiting for the report to appear in the list (%d min)."
                     % mins)
            last_note = time.time()

        page.wait_for_timeout(POLL_SECONDS * 1000)

        # LAST RESORT. Only when the page has not changed at all for a long
        # stretch, which suggests the list is not refreshing itself.
        if time.time() - last_change > STALE_SECONDS and reloads < MAX_RELOADS:
            reloads += 1
            progress("requesting",
                     "Nothing has changed for %d minutes; refreshing the page "
                     "once (%d of %d)."
                     % (STALE_SECONDS // 60, reloads, MAX_RELOADS))
            try:
                page.reload(wait_until="domcontentloaded", timeout=60_000)
                # Let it settle before anything reads the page again. Reading
                # during a navigation raises "Execution context was destroyed".
                page.wait_for_load_state("domcontentloaded", timeout=30_000)
                page.wait_for_timeout(2500)
            except Exception:
                pass
            last_change = time.time()
            last_seen = None

    raise RuntimeError(
        "Amazon did not finish building the report within %d minutes. It was "
        "requested and may still appear in Generated Reports on the page; "
        "nothing was requested twice." % (BUILD_TIMEOUT_S // 60))



# ── the whole job ───────────────────────────────────────────────────────────

REPORT_IDENTITY = ("amazon store", "msku", "start date", "end date")


def _reads_like_the_report(f: Path) -> bool:
    """Does this file's first line look like a SKU Economics export?

    Chromium names a download in progress after nothing at all - a bare GUID
    with a .tmp suffix - so a stray file cannot be recognised by its name. Its
    header can be: these four columns identify the report and nothing else on
    the machine has them.
    """
    try:
        head = f.open("rb").read(8192).decode("utf-8-sig", "replace")
    except Exception:
        return False
    line = (head.splitlines() or [""])[0].lower()
    return all(c in line for c in REPORT_IDENTITY)


def _download_dirs(profile_dir: Path, out_dir: Path) -> list[Path]:
    """Everywhere Chromium might have put the file.

    downloads_path tells Playwright where to KEEP a download once it has been
    handed over. It does not tell Chromium where to write one: a profile that
    has been used before carries its own download folder in its preferences,
    and that is where the bytes actually land. Both are searched, plus the
    account's own Downloads folder, because that is the usual answer.
    """
    dirs = [out_dir]

    prefs = profile_dir / "Default" / "Preferences"
    try:
        saved = json.loads(prefs.read_text(encoding="utf-8", errors="replace"))
        chosen = (saved.get("download") or {}).get("default_directory")
        if chosen:
            dirs.append(Path(chosen))
    except Exception:
        pass

    home = Path(os.path.expanduser("~")) / "Downloads"
    dirs.append(home)

    out, seen = [], set()
    for d in dirs:
        try:
            key = str(d.resolve()).lower()
        except Exception:
            key = str(d).lower()
        if key not in seen and d.is_dir():
            seen.add(key)
            out.append(d)
    return out


def _point_downloads_at(profile_dir: Path, out_dir: Path) -> None:
    """Ask this profile to write its downloads where they can be found."""
    prefs = profile_dir / "Default" / "Preferences"
    if not prefs.is_file():
        return                      # a fresh profile; Playwright's path holds
    try:
        saved = json.loads(prefs.read_text(encoding="utf-8", errors="replace"))
        want = str(out_dir)
        dl = saved.setdefault("download", {})
        if dl.get("default_directory") == want:
            return
        dl["default_directory"] = want
        dl["prompt_for_download"] = False
        saved.setdefault("savefile", {})["default_directory"] = want
        prefs.write_text(json.dumps(saved), encoding="utf-8")
    except Exception:
        pass                        # not being able to ask is not a failure


def _claim_stray(dirs: list[Path], since: float, path: Path,
                 own: Path | None = None):
    """Take a report that was downloaded but never handed over.

    The transfer can finish perfectly and still be lost: the window that
    started it closes, Playwright has no page left to pass the file through,
    and the bytes sit on disk under a name nobody would recognise. This looks
    for a file that appeared AFTER the Download button was pressed, so an older
    file can never be taken.

    How sure it has to be depends on WHERE it is looking.

      this program's own download folder   anything new is the download;
                                           nothing else writes there

      the seller's Downloads folder        the header has to be this report.
                                           That folder is full of everything
                                           else they have ever saved, and
                                           guessing wrong means taking one of
                                           their files
    """
    try:
        own_key = str(own.resolve()).lower() if own else None
    except Exception:
        own_key = str(own).lower() if own else None

    best = None
    for _ in range(24):             # a transfer still finishing is normal
        for d in dirs:
            try:
                here = [f for f in d.iterdir() if f.is_file()]
            except Exception:
                continue
            try:
                ours = own_key is not None and str(d.resolve()).lower() == own_key
            except Exception:
                ours = False
            for f in here:
                if f.name.endswith((".crdownload", ".part")):
                    continue
                try:
                    when = f.stat().st_mtime
                except Exception:
                    continue
                if when < since - 2:
                    continue        # it was already there
                if not ours and not _reads_like_the_report(f):
                    continue
                if best is None or when > best[0]:
                    best = (when, f)
        if best:
            break
        time.sleep(0.5)

    if not best:
        return None

    found = best[1]
    try:
        shutil.move(str(found), str(path))
        return path
    except Exception:
        try:
            shutil.copy2(str(found), str(path))
            return path
        except Exception:
            return found            # readable where it lies


def _take_download(page, row, link, out_dir: Path, progress, *,
                   date_range: str, date_from: str | None, date_to: str | None,
                   marketplace: str, tag: str | None,
                   countries: int, options: int,
                   search_dirs: list[Path] | None = None) -> dict:
    """Click Download, save the file, and describe what came back.

    Kept apart from filling the form so that a report already requested can be
    collected without asking for it again.
    """
    progress("downloading", "Downloading your report.")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = "sku-economics-%s-%s.csv" % (
        re.sub(r"[^a-z0-9]+", "-", (date_range or "report").lower()).strip("-"),
        stamp)
    path = out_dir / name

    search_dirs = [d for d in (search_dirs or [out_dir]) if d]

    # Caught on the CONTEXT, not the page. The Download link can open a window
    # that closes itself the moment the transfer starts, and a download owned
    # by a closed page cannot be saved through it - "Target page, context or
    # browser has been closed", with the file sitting there complete.
    context = page.context
    pressed = time.time()
    download_obj = None
    never_arrived = ""
    try:
        with context.expect_event("download", timeout=5 * 60 * 1000) as dl:
            link.click(timeout=60_000)
        download_obj = dl.value
    except Exception as exc:
        # NOT the end of it. The button was pressed, so the file may well be on
        # disk already - this only means Playwright never got to say so.
        never_arrived = str(exc)[:120]

    saved = False
    how = ""
    if download_obj is not None:
        try:
            download_obj.save_as(str(path))
            saved, how = True, "saved directly"
        except Exception as first:
            how = str(first)[:80]

    if not saved:
        # Playwright could not hand it over, for whatever reason. Chromium
        # wrote the bytes somewhere regardless: its own download folder, which
        # a profile carries with it and which is usually the account's
        # Downloads folder rather than this one. Take the file that appeared
        # after the button was pressed and whose header is this report.
        rescued = _claim_stray(search_dirs, pressed, path, own=out_dir)
        if rescued is not None:
            moved = rescued == path
            saved = True
            how = ("collected from the download folder" if moved
                   else "read where the browser left it, in %s" % rescued.parent)
            path = rescued

    if not saved:
        if never_arrived:
            raise RuntimeError(
                "The Download button was pressed but no file came back (%s), "
                "and none of %s holds a new report. It is still in Generated "
                "Reports on the page; Retry will collect it without requesting "
                "another."
                % (never_arrived,
                   " or ".join(str(d) for d in search_dirs)))
        raise RuntimeError(
            "The report was downloaded but could not be saved (%s), and no "
            "new file appeared in %s. It is still in Generated Reports on the "
            "page; Retry will collect it without requesting another."
            % (how, " or ".join(str(d) for d in search_dirs)))

    if how != "saved directly":
        progress("downloading", "The download window closed early; the file "
                                "was %s." % how)

    # Tidy up any window the download opened. It was kept alive on purpose -
    # window.close() is taken away so a page cannot shut itself mid-transfer -
    # so closing it is this program's job now that the file is safe.
    try:
        for other in list(context.pages):
            if other is not page:
                try:
                    other.close()
                except Exception:
                    pass
    except Exception:
        pass

    size = path.stat().st_size
    if size < 64:
        raise RuntimeError(
            "The downloaded file is %d bytes, which is too small to be a "
            "report. It was not imported." % size)

    progress("importing", "Downloaded %s (%d KB)." % (name, size // 1024))
    return {
        "path": str(path),
        "name": name,
        "bytes": size,
        "tag": tag,
        "marketplaces": countries,
        # This page reports on ONE marketplace at a time, so the file covers
        # this country and no other. Said plainly, because a figure attributed
        # to the wrong country is worse than a missing one.
        "marketplace": marketplace,
        "options": options,
        "coverageRange": date_range,
        # A custom range HAS real dates, and they are the ones typed in. A
        # named range does not: Amazon decides what "Next 30 days" covers, so
        # those stay unset and the file's own columns are the authority.
        "coverageFrom": date_from if _is_custom(date_range) else None,
        "coverageTo": date_to if _is_custom(date_range) else None,
        "matchedOn": "notes tag" if tag else "date range (no notes box)",
    }


def download(
    out_dir: Path,
    date_range: str,
    profile_dir: Path,
    progress: Callable[[str, str], None],
    headless: bool = False,
    marketplace: str = "United States",
    date_from: str | None = None,
    date_to: str | None = None,
    ticket: dict | None = None,
    save_ticket=None,
) -> dict:
    """Open the page, fill it in, generate, wait, download. Returns the file."""
    from playwright.sync_api import sync_playwright

    out_dir.mkdir(parents=True, exist_ok=True)
    profile_dir.mkdir(parents=True, exist_ok=True)
    date_range = (date_range or DEFAULT_RANGE).strip()

    # Where the file may end up. Asked for first, searched for afterwards:
    # asking can be refused quietly, so the search is what actually matters.
    _point_downloads_at(profile_dir, out_dir)
    search_dirs = _download_dirs(profile_dir, out_dir)

    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=headless,
            accept_downloads=True,
            # Chromium writes downloads here itself. If the page that started
            # the download has gone by the time it is saved - the Download
            # link opens a window that closes itself the moment the transfer
            # begins - the file is still on disk and can be collected without
            # Playwright's help.
            downloads_path=str(out_dir),
            viewport={"width": 1440, "height": 950},
        )
        # A page cannot shut itself while a download is in flight.
        #
        # The Download link opens a window that calls window.close() the moment
        # the transfer starts. Playwright can only hand over a download through
        # the page that owns it, so the file was reported as complete and could
        # not be saved: "Target page, context or browser has been closed", and
        # nothing on disk either. Taking window.close() away keeps that page
        # alive long enough; the window is closed here afterwards instead.
        try:
            ctx.add_init_script(
                "window.close = function () { /* left open until the download "
                "has been saved */ };")
        except Exception:
            pass

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        keep_open = False
        try:
            progress("requesting", "Opening the SKU Economics page.")
            page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
            page.wait_for_timeout(2500)

            if looks_like_login(page.url):
                keep_open = True
                await_login(page, progress)
                keep_open = False
                page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
                page.wait_for_timeout(2500)

            # The form is only filled in once the page has drawn it. Without
            # this, an empty page looks exactly like a page with no options.
            try:
                page.get_by_text(re.compile(OPTIONS_HEADING, re.I)).first \
                    .wait_for(timeout=45_000)
            except Exception as exc:
                raise RuntimeError(
                    "The SKU Economics form did not load. Nothing was "
                    "requested. (%s)" % str(exc)[:140]) from exc

            # ---- already asked? -------------------------------------
            # A report that was requested before must not be requested
            # again. Every retry used to fill the form and press Generate
            # afresh, which is why the Generated Reports list filled up with
            # duplicates of the same period. If a ticket was saved, go
            # straight back to watching for that report.
            if ticket and ticket.get("requestedAt"):
                progress("requesting",
                         "This report was already requested%s; watching for it "
                         "rather than asking again."
                         % (" as %s" % ticket["tag"] if ticket.get("tag") else ""))
                row, link = wait_for_report(
                    page, ticket.get("tag"), ticket.get("dateRange") or date_range,
                    progress,
                    date_from=ticket.get("from") or date_from,
                    date_to=ticket.get("to") or date_to,
                    before=ticket.get("before"))
                return _take_download(
                    page, row, link, out_dir, progress,
                    date_range=ticket.get("dateRange") or date_range,
                    date_from=ticket.get("from") or date_from,
                    date_to=ticket.get("to") or date_to,
                    marketplace=marketplace, tag=ticket.get("tag"),
                    countries=ticket.get("marketplaces") or 1,
                    options=ticket.get("options") or 0,
                    search_dirs=search_dirs)

            # Anything floating over the form is closed BEFORE anything
            # is clicked: the marketplace list opens upwards into the
            # page's notice banner, and a click landing on the banner
            # selects nothing while appearing to work.
            dismiss_notices(page, progress)

            countries = pick_marketplace(page, progress, country=marketplace)
            pick_date_range(page, date_range, progress,
                            date_from=date_from, date_to=date_to)
            opts = tick_every_option(page, progress)
            tag = write_note(page, progress)

            # The tag has to still be there when the button is pressed.
            # Anything between filling the box and pressing it can disturb the
            # page, and a report submitted with an empty note has to be found
            # by its dates instead.
            if tag:
                tag = confirm_note(page, tag, progress)

            # What the list held BEFORE asking, so an untagged report cannot
            # be confused with one already sitting there.
            before_rows = _row_counts(page)

            # Persisted BEFORE the click, so an ambiguous timeout cannot lead
            # to the same report being requested twice.
            if save_ticket:
                save_ticket({
                    "tag": tag,
                    "dateRange": date_range,
                    "from": date_from,
                    "to": date_to,
                    "before": before_rows,
                    "marketplaces": countries,
                    "options": opts["total"],
                    "requestedAt": time.time(),
                })

            generate(page, progress)

            row, link = wait_for_report(page, tag, date_range, progress,
                                         date_from=date_from, date_to=date_to,
                                         before=before_rows)

            return _take_download(
                page, row, link, out_dir, progress,
                date_range=date_range, date_from=date_from, date_to=date_to,
                marketplace=marketplace, tag=tag, countries=countries,
                options=opts["total"], search_dirs=search_dirs)
        finally:
            if not keep_open:
                try:
                    ctx.close()
                except Exception:
                    pass
