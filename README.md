# Amazon Cash & Payout Planner

An Amazon cash-availability and early-payout planning tool. It answers one question first:

> **If I request a payout on this date, how much should be available, when should it reach the
> bank, and how much is left for the next one?**

Profitability, Amazon expense analysis and SKU economics are supporting functions, deliberately
placed below cash planning.

```
app.html            the page that gets published (no doctype/html/head/body — the platform adds those)
lib/money.js        exact money: integer cents for the ledger, BigInt decimals for forecast inputs
lib/provenance.js   every figure carries origin, as-of, completeness — and "Unavailable" is a value
lib/csv.js          streaming parser, dynamic header detection, account-local timestamps
lib/taxonomy.js     component-level expense classification, versioned rules
lib/ledger.js       columnar store for the Payments export — 180,658 rows in ~30 MB
lib/preview.js      Fees & Economics Preview, with the fee parent/child hierarchy
lib/cash.js         the availability and early-request engine
lib/forecast.js     the 56-day event forecast
lib/profit.js       the profit engine, with cost-coverage gating
lib/recon.js        settlement, bank matching, forecast scoring, rolling-origin baselines
lib/store.js        IndexedDB persistence, snapshots, the prioritised data checklist
lib/app.js          the interface
test/               396 assertions, run against the real exports
gen-preview.js      wraps app.html the way the platform does, for local viewing
server.js           static server on :5178
```

## Running it locally

```bash
node gen-preview.js && node server.js
```

Then open <http://localhost:5178>. Drop the CSVs on the Data screen.

## Running the tests

```bash
node test/run.js
```

The suites read the real exports. Point them elsewhere with `FBA_PAYMENTS_CSV` and
`FBA_PREVIEW_DIR`. A control whose source was never supplied reports **Not tested** — never Pass.

## The one rule

Every figure on screen either comes from a source and says which, or it is **Unavailable** and
names the specific input it needs. There is no third state. In particular there is no `$0`
standing in for "we do not know", and no average, demo figure or plausible-looking placeholder
anywhere in a live result.

`amount()` in `lib/app.js` is the only path a number takes to the DOM, and it enforces this.

## The three events that are never conflated

| Event | What it means |
|---|---|
| **Release** | funds stop being deferred and become eligible |
| **Request** | a payout is requested and Amazon initiates a transfer |
| **Receipt** | the money arrives in the bank |

Requesting early moves the second and third. It does not create sales, does not make deferred
money eligible sooner, and does not change profit. **A payout already requested reduces the
balance every later forecast starts from** — the invariant that stops "$30,000 now *and* $40,000
later". It is asserted in `test/cash.test.js` using the specification's own illustration.

## What is deliberately not assumed

The recent run of frequent payouts is the owner's own early requests, not a schedule Amazon set.
So the app never infers a payout cadence from historical transfer spacing. Likewise none of these
are assumed — each starts unverified, and any figure depending on one stays Unavailable:

- request cooldown
- whether partial requests are supported
- whether an early request resets the next scheduled date
- bank transit time (there is no "usually two days" default presented as fact)
- the next scheduled payout date, which must be read from the account

## Money precision

Two representations, because the sources genuinely differ:

- **The Payments ledger is exactly 2dp** on all 180,658 rows, so integer cents is lossless and
  fast. The importer counts any cell with more precision rather than truncating silently.
- **The preview carries up to 10 decimal places** on Net sales, Sales and Average sales price
  (e.g. `9551.4733333297`). Truncating those to cents shifts a file total by a few cents, so
  forecast inputs keep full precision until one documented rounding step at display.

Daily splits use largest-remainder allocation, so the parts sum to the whole exactly.

## Fee hierarchy

Preview fee columns are a hierarchy, not a list. `FBA fulfillment fees total` is the **parent** of
base fulfilment, fuel surcharge and low-inventory-level. `Monthly inventory storage fee total` is
the parent of base monthly storage and storage utilisation — and base storage *equals* its parent
on every populated row, so adding both doubles storage outright.

The parent is used for totals. Children are shown to explain it and are marked non-additive. The
parent is also **short of its visible children by $209.30 to $522.07 per file**; that signed
difference is displayed rather than allocated away or treated as an extra charge.

## Storage and persistence

IndexedDB, with availability **verified at runtime** rather than assumed. The columnar ledger
(~30 MB) is stored as ArrayBuffers, so a returning visit restores 180,658 rows in about two
seconds instead of re-reading a 78 MB CSV. Where storage is blocked the app says so plainly and
runs in memory for the session.

If saved data cannot be restored, the import list drops those rows and says so. The app never
claims to hold data it cannot calculate with.

## Publishing

Publish `app.html` with the eleven `lib/*.js` files as supporting files.

## Privacy

CSVs are parsed in the viewer's own tab and stored in that browser on that device. Nothing is
uploaded and no `db` capability is declared. **Export a backup** writes everything entered by
hand, every snapshot and every immutable forecast run to one JSON file.
