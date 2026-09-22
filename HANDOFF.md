# Handoff — Amazon Cash & Payout Planner

Rebuilt 16 September 2026, replacing the FBA Profit Organizer. The previous app and every one of
its `.bak` files are preserved in `backup/pre-rebuild-2026-09-16/`.

---

## 1. What changed, and why

The old app answered "am I making money?" from the Fees & Economics Preview alone. It had **no
parser for the Payments transaction export at all** — `lib/analysis.js` explicitly sniffed the
header so it could *reject* a transaction report before parsing it.

That made the central question unanswerable. The rebuild is organised around cash availability
and early-payout planning, with profitability underneath it.

Two concrete defects in the old fee model, now fixed:

- **`Fuel and Logistics-related surcharge` was absent entirely** from the `FEES` table, so that
  cost was invisible.
- **`Low-inventory-level fee` was counted on top of the FBA parent** with a comment asserting it
  sits outside the fulfilment fee. Measured against the real files, base + fuel + low-inventory
  *exceeds* the parent by $209.30–$522.07 per file, so adding it double-counted.

## 2. Everything was verified against the real exports first

Before writing code I re-derived every figure in the audit from the source bytes. All of it
reproduced exactly:

| Control | Result |
|---|---|
| Row count | 180,658 |
| Component sum vs `total` | balances to the cent on **every** row |
| Transfers | 144 events, $1,729,491.40 (Standard 114 / $1,707,263.55, Invoiced 30 / $22,227.85) |
| Exact-duplicate extra rows | 942, net $11,980.28 — retained, never deduplicated |
| Settlement groups | 151, **none** balancing; residuals −$57,213.61 … $40,972.13 |
| Deferred rows | 98, $2,070.05 — *not* today's held balance |
| Released after period end | 3,617 rows, $54,692.92 — so statuses are not an Aug 31 snapshot |
| Net revenue proxy | $4,060,115.14 |
| Tax clearing | $0.00 |
| Non-transfer net activity | $1,759,919.93 |
| Extract net movement | $30,428.53 — **not** a current balance |
| Preview MSKUs / ASINs | 202 / 149 in all seven files |
| Preview MSKUs with no historical match | 47 — listed, never auto-mapped |
| Rolling-origin baselines | MAE/WAPE/MAPE/bias reproduce the audit **exactly** |

Two things did *not* reproduce, and both are stated rather than tuned away:

1. **Baseline date MAE.** Amounts match to the cent; timing MAE differs by 0.05–0.16 days
   (mine 0.65/0.74/0.77/1.67 vs the audit's 0.60/0.68/0.85/1.83). The last-four-gaps window is
   clearly the right method — every alternative I tried was further off — but some unstated
   detail of the audit's median convention differs. It affects a baseline the audit itself says
   is the wrong core model.
2. **Invoiced last-transfer MAE** is exactly $350.655. The audit rounds the tie down to 350.65;
   this code rounds half-up to 350.66. Same number.

## 3. Architecture

Twelve modules, each UMD so every one is testable from plain node.

The dependency order matters and is the order they load in `app.html`:

```
money → provenance → csv → taxonomy → ledger → preview → cash → forecast → profit → recon → store → app
```

### The columnar ledger

180,658 rows as JS objects is roughly a gigabyte and freezes the tab. Instead every column is a
typed array and every repeated string is a dictionary index. Result: **~30 MB, and 39 MB of heap
with the whole ledger live in the browser.** `rowAt(i)` reconstructs any source row exactly,
including the original `Aug 1, 2025 12:00:36 AM PDT` text.

Classification is cached per `(type, description)` family rather than per row — about 400 × 15
lookups instead of 2.7 million.

### Timestamps

Parsed into account-local calendar parts with the `PDT`/`PST` abbreviation kept, and **never
converted to UTC**. Every period boundary is an account-local date, so a timezone conversion can
never slide a posting across a cutoff.

## 4. The taxonomy

Classification happens **per monetary component, not per row**. One row can carry revenue, tax, a
selling fee and an FBA fee at once, and `type` alone cannot tell you what `other` means — in this
file `other` holds transfers, storage, reimbursements, subscriptions and adjustments.

Rules were written against the **51 distinct (type, description) families actually present**, not
from the audit's summary. Precedence is array order: specific description rules first, generic
column rules last. Nothing falls through to a catch-all — that is asserted.

Rules that would be easy to get wrong, and are tested:

- Storage is recognised under **both** `FBA storage fee` and `FBA Inventory Storage Fee` (Amazon
  renamed it in July 2026). Together: $60,187.08. An importer matching only the old label would
  miss July and August entirely.
- Inbound placement posts under **two different type/column combinations** and is classified once:
  $39,388.17.
- Legacy deal fees have a **blank `type`**; the description still identifies them: $5,500.00.
- `MCF Preferred Pricing Seller Credit` stays a **credit** despite its type being `Amazon Charges`.
- Reimbursement **reversals** keep their sign and stay in the reimbursement family, so they never
  inflate platform charges.
- Charges and reversals are shown separately — inbound defect is $2,077.60 each way, which is not
  the same as zero activity.

## 5. The cash engine — read this before changing it

`lib/cash.js` holds the invariant the whole app exists to protect.

Three events are kept strictly apart: **release**, **request**, **receipt**. A request moves cash
out of `available` into `inTransit` immediately, so every later calculation starts from the
reduced balance.

The specification's illustration is a test: $30,000 available → request it all → $10,000 releases
→ later available is **$10,000**, combined payouts **$40,000**. Never $70,000.

Other enforced behaviours:

- Events at or before the opening snapshot's `includesActivityThrough` are **rejected**, so a
  charge already inside the opening balance cannot be applied twice.
- Deferred funds are shown beside the bridge and **never subtracted from it** — they were never
  added to available in the first place.
- A negative balance is a **shortfall**, never a negative payout.
- `run()` throws a typed `Unavailable` carrying the specific missing input rather than returning
  a plausible number.

### The event walk

`run()` buckets events by date and picks the next unprocessed date from a set each turn, because
bank receipts are discovered *during* the walk as requests execute. An earlier version sorted and
appended to the array it was iterating with an index — that was a real bug and is why it looks
the way it does now. Do not turn it back into a `for` loop over a mutating array.

## 6. What the app refuses to do

These are features, not gaps:

- No payout is submitted and no money is moved. It plans and records.
- No cadence is inferred from historical transfer spacing.
- No bank transit default. Unknown until deposits are supplied.
- No partial-request mode unless the account is confirmed to support it. A cash target is a
  planning goal, not evidence of permission.
- No net profit or net margin without complete cost coverage; the line is named
  "contribution after recorded costs" instead.
- No preview gap is interpolated. 16–31 October produces no forecast activity and says so.
- No SKU suffix stripping to force a match. The 47 unmatched MSKUs are listed.

## 7. Verification performed

`node test/run.js` → **396 passed, 0 failed, 4 not tested.**

The four "not tested" are settlement bridge, independent expense tie, bank matching and current
balances — all blocked on sources that were never supplied. They report Not tested, never Pass.

In-browser, against the real files:

- All seven previews imported through the real drop handler.
- The **78 MB export imported in the browser**: 180,658 rows, every row balancing, 39 MB heap.
- Persisted to IndexedDB and **restored on reload in ~2.5 s** with identical figures.
- Expense tiles reconcile exactly: gross $1,941,813.42 + unresolved $3,733.47 = the audit's
  $1,945,546.89; credits $25,247.68 + $395.06 = $25,642.74.
- Profit statement's operating result = **$1,759,919.93**, matching the ledger bridge independently.
- Three planned requests on real data: $42,500 → $11,250.03 → $46,184.39. The second takes only
  what released since the first, and both policies reconcile to $235,488.56 with **$0.00**
  difference.
- Mobile 375px: no horizontal overflow. Light and dark both checked.

## 7a. Import and display fix, 17 September 2026

A single Fees & Economics Preview imported cleanly — parsed, stored, read back — and every
screen stayed empty. The file was never the problem. Five defects sat downstream of a
successful parse:

| Defect | Where | Effect |
|---|---|---|
| Forecast required the ledger | `app.js` `currentForecast` | A preview-only import produced `null`, so nothing rendered |
| Forecast screen bailed without the ledger | `app.js` `screens.forecast` | The one screen a preview feeds refused to draw |
| Economics blocked on the account mix | `forecast.js` `buildDailyEconomics` | Returned `days: []` before computing figures that need no mix |
| Measurement window hard-coded to `2026-04-01..2026-08-31` | `app.js` `buildForecastUncached` | Any history outside those dates yielded no mix, so no forecast |
| Success reported before the write | `app.js` `importFile` | "Loaded" was claimed, then `persist()` ran unchecked |

The rule now: **a valid report displays what it supports.** The preview carries Amazon's own
economics; history only adds release timing and the account split on top. Those are separable,
so they are separated. A preview alone renders net receivable, coverage, per-window fee parents
and the daily series, and says plainly that the dated payout schedule needs the transaction CSV.

Two things found while fixing it, both of which mattered more than the original bug:

- **A one-sided projection.** An economics-only forecast carries the preview's period CHARGES
  but none of its receipts. Feeding that to the cash engine walked a recorded $30,000 balance
  down to $13,793.11 on real data — storage subtracted, no sales ever arriving. A plausible
  number built from half the evidence is exactly what this app exists not to produce, so
  `buildEngine` now applies nothing at all while `economicsOnly` is set, and the dashboard says
  why. Regression-tested in `test/import.test.js`.
- **`probeStorage` claimed `durable: true` on any successful write**, without ever calling
  `navigator.storage.persist()`. It now requests the grant and reports what was actually
  granted; an ungranted store is evictable and says so.

Also: rejected rows are captured with line numbers and reasons rather than `continue`d past;
`importFile` catches instead of leaving an unhandled rejection; a period outside the active
filter or horizon is named with a **View imported period** button; and an export missing an
optional column (`account type`, absent from every Monthly Transaction report) reports that
absence for as long as the file is loaded.

`test/import.test.js` — 54 assertions, fixtures built inline so it runs anywhere node does.
`test/run.js` now distinguishes exit code 2 ("source export not supplied on this machine") from
a real failure, so a missing optional source reads as *not tested* rather than red.

---

## 7b. Readability, organization and account sync, 17 September 2026

**Type and contrast.** A named scale on `:root` replaces scattered magic numbers: body and table
text 16px/1.6, secondary labels 15px, page headings 28px (24px on a phone), section headings
19px, stat figures 30px, the hero 44px. Table rows went from 11px to 14px vertical padding.
Both grey inks were failing or borderline and were darkened — `--ink-3` was **3.1:1** on the
surface, below AA for normal text, and is now 5.3:1; `--ink-2` went from 4.9:1 to 7.6:1.

**Grids now measure the right thing.** `.g2`/`.g3`/`.g4` had viewport breakpoints while the
sidebar was taking a third of the window, so at 1024px four stat cards were being packed into
**158px each**. They are container queries on `#view` now, and grid children are containers
themselves so a `.dl` inside a half-width column measures that column rather than the page.
Verified at 360/500/560/700/760/900/1000px of container width.

**Organization.** Every screen carries a one-line plain-language purpose under its title.
Provenance labels were renamed for people rather than accountants (`MODEL FORECAST` reads
"Projected", `CURRENT` reads "Current balance"), each carries a hover explanation, and a
foldable legend sits on every screen that shows tagged figures. Explanatory blocks — the
estimate waterfall, the assumptions table — moved into `<details>`; warnings and
missing-data notices deliberately did not.

**Recorded balances** can now be listed, seen (the row actually driving the figures is marked
"In use") and removed. Previously a snapshot could be entered but never corrected, and a typo
in `available` was permanent.

### Account sync — `lib/sync.js`

IndexedDB is device-local, so "cross-device" needed real server-side storage. The artifact `db`
capability provides it: per-viewer private documents under `data/users/<id>/`, enforced
platform-side rather than by convention. Declared alongside `user` (for `id()`) and `sample`
(which the Ask Claude panel had always called but never declared, so it had never worked in a
published build).

Measured first, because the limits are real: a db document caps at **256 KiB** and an artifact's
database at **5,000 documents**. One preview is ~320 KiB of JSON; the 180k-row transaction export
is ~36 MiB as base64, or 185 chunks. So bulk data is chunked under a manifest that is written
**last** — until it lands the previous version is still the live one, and a torn blob reads as
absent rather than as corrupt data.

Deliberate choices:

- **Local storage was not replaced.** Every local save still happens; sync is a second copy.
  Nothing in the sync path may delete local data on the strength of what the server says.
- **`persist()` triggers the push**, not the fourteen call sites that call it, so a new one
  cannot forget to.
- **Conflicts are refused, never resolved silently.** Each state document carries a monotonic
  `rev`; a push whose base has moved refuses, hands back both sides, and the person chooses
  (combine / account / this device). Imports are the one thing merged automatically, by content
  hash — two devices importing two different files is an addition, not a collision.
- **Imports are deduplicated by a streamed content hash**, so the same export dropped on a
  second device is recognised rather than imported twice.
- **"Saved" means a write happened and was confirmed.** A reachable account with nothing to save
  says "Account connected". Running outside claude.ai says "This device only" with the reason.

## 8. Known limitations

- **Bank arrival is unavailable everywhere.** No deposit history exists.
- **The Cash Plan shows no spendable figure** until opening bank cash and commitments are entered.
- **Advertising is currently in neither engine's cash path.** Settlement deductions are zero from
  June 2026 while the preview forecasts ~$23k per fortnight. Until the billing method is recorded
  the expense is visible in profitability but is not deducted from Amazon cash — and the screen
  says exactly that.
- **Cross-device sync needs the published artifact.** Account storage is the artifact `db`
  capability, which only exists inside claude.ai. Opened as a local file or from a dev server
  there is no account, and the app says "This device only" rather than implying otherwise.
- **A transaction export over ~70 MB of encoded data will not sync.** `MAX_CHUNKS_PER_BLOB`
  refuses it up front with a message rather than spending an hour on writes that will be rate
  limited; it stays saved on the device that imported it and is listed as such.
- **The conflict path is unit-tested, not yet exercised live** across two real devices. The
  refuse-and-ask behaviour, the merge, and the explicit override are covered in
  `test/sync.test.js` against a fake that enforces the store's real constraints.
- The `partial` request mode is implemented but gated off until the account confirms support.
- Forecast-vs-actual has no history to score yet. That starts accumulating from the first saved
  run and the first recorded balance snapshot.

## 9. Where to start

The prioritised list lives in `lib/store.js` as `CHECKLIST` and renders on **Data & Assumptions**.
The three that unblock the most, in order:

1. **Current Amazon balances**, all at one timestamp. This alone turns the dashboard on.
2. **The account's request rules** and the confirmed next scheduled payout date.
3. **Bank deposit history**, even two months, which is what makes arrival dates possible.
