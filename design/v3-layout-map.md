# Redesign v3 — measured layout map

Measured from the rendered mockup at 1440×900 (content column 1122px wide,
28px side padding, 20px gaps). Positions are x/y/width/height inside the
scrolling content area. Source of truth: `Cash Planner Redesign v3.dc.html`.

## Tokens (computed, not estimated)

| thing | value |
|---|---|
| page / content bg | `#F6F7F9` (window chrome `#E9ECF0`) |
| surface | `#FFFFFF` |
| ink / ink-2 / ink-3 | `#172B4D` / `#344158` / `#56637A` (currency prefix `#46546C`) |
| accent / accent-hover | `#0F766E` / `#0B5F58`; chart teal `#0D9488` |
| line / line-soft / control border | `#E2E8F0` / `#EEF1F5` / `#D3DAE3`; sidebar edge `#E4E8EE` |
| ok tag | bg `#F3FAF8`, ink `#0F766E` |
| warn tag | bg `#FFFBEB`, ink `#92400E`, dot `#D97706` |
| neutral dot | `#AEB8C5` |
| font | Inter → "Segoe UI Variable" → "Segoe UI" → system-ui; 16px / 1.5 |
| sidebar | 252px, bg `#F6F7F9`, right border `#E4E8EE` |
| brand row | pad 14/16/12, gap 9 |
| nav item | h40, pad 0 10, radius 7, gap 11, 16px; idle `#344158`/500; active white, 600, ring `0 0 0 1px #E2E8F0, 0 1px 2px rgba(23,43,77,.04)` |
| nav group label | 14px/500 `#56637A`, pad 16 10 4 |
| data status card | white, border `#E4E8EE`, radius 8, pad 10, margin 0 8 8, gap 6 |
| header | white, pad 10 28, bottom border `#E4E8EE`, gap 14 |
| h1 | 22px/600, lh 1.5, ls -0.22px |
| subtitle | 15px `#344158` |
| select / secondary button | h36, radius 6, border `#D3DAE3`, 15px (button 500) |
| balance pill | h36, pad 0 9, radius 6, bg `#F3FAF8`, `#0F766E`, 15px |
| chip | h30, pad 0 8, radius 5, border `#E2E8F0`, 15px `#344158` |
| card | white, radius 12, pad 22 24, border `#E2E8F0` |
| primary card | border `#B7DDD6`, shadow `0 1px 2px rgba(15,118,110,.06)` |
| card title | 18px/600 |
| hero number | 40px/650, ls -1px; currency prefix 18px/500 `#46546C` |
| big date | 28px/600, lh 1.2 |
| dl rows | dt `#344158`, dd 500; pad 8 0; top border `#EEF1F5` |
| tags | pad 3 9, radius 6, 14px/500, gap 6, 6px dot |
| "Show as table" | summary, 15px/500 teal |

## Sidebar groups
- **Cash**: Cash Dashboard, Payout Forecast, Cash Plan
- **Analysis**: Amazon Expenses, Profitability, Reconciliation
- **Setup**: Data & Assumptions (amber count badge = inputs needing attention)
- bottom: **Data status** card (Transactions / Forecast / Balance / Bank deposits, coloured dots), then Ask Claude + `Ctrl J`

## Screens (title = nav name; header controls on the right)

### Cash Dashboard — "What you can request, when it lands, and what is left"
header: Account select · Balance today pill · Update balance
1. toolbar (full): Request date ‹ date › weekday · Tomorrow · Next scheduled · scope text
2. row of 3: **Available to request** (primary card, hero number) · Expected bank arrival (big date) · Remaining after the request (dl)
3. 2-col: Available to request over time (chart, 727) · Recorded balance (dl, 376)
4. Request on <date>, or wait for the scheduled payout (chart + table, full)
5. Expected bank receipts (table, full)
6. Calculations and assumptions (collapsed disclosure, "Reconciles" tag)
7. Planned requests (table + Add to plan)
8. Would sharpen these figures (actions)

### Payout Forecast — "Eight weeks of releases, requests and bank arrivals"
header: Account select · Save forecast run
1. 4 stat tiles: Becoming eligible · Reaches your bank · Forecast coverage · Available now
2. coverage gap banner (Import preview)
3. Available to request over time (chart)
4. Expected bank receipts (table)
5. Week-by-week breakdown (table)
6. What limits this forecast
7. Assumptions in force · N (collapsed)

### Cash Plan — "What is safe to spend after commitments and your buffer"
header: Add commitment
1. 3 tiles: Safe to spend through <date> · Lowest projected bank balance · Buffer to keep (input)
2. Bank cash today strip
3. Cash flow by date (table + Add commitment)

### Amazon Expenses — "Every fee Amazon charged, grouped by what it was for"
header: two selects
1. 4 stat tiles: Gross platform charges · Credits received · Net platform cost · Unresolved
2. By category (chart + table, Collapse all)
3. gap banner (Add billing)
4. Fee types this export can't show · N (collapsed)

### Profitability — "What you kept after the costs recorded here"
header: two selects
1. 2-col: Contribution after recorded costs (table, 669) · Cost coverage (426, Add missing cost)
2. By product (table, filter chips: All · N | Missing cost · N)

### Reconciliation — "Checks that tie the figures back to Amazon's files"
header: select
1. one card with tabs: Checks · Settlements · Bank & transfers · Forecast vs actual · Baselines (counts on each tab)

### Data & Assumptions — "Imports, freshness and the inputs each figure needs"
header: Import files
1. 3 tiles: Report readiness (N of 7 ready) · Data freshness · Needs attention
2. 3-col grid of input cards, each with status tag + one action: Payments transaction history · Fees & Economics Preview · Current Amazon balance · Bank deposit history · Payout rules · Product costs · Advertising billing · drop zone
3. Payout rules (form, N not verified)
4. Recorded balances (table)
5. Imported files (table)
6. Technical details (collapsed)
