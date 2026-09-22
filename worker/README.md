# Local worker — Amazon downloads

Downloads Seller Central reports with Playwright and hands them to the app's
normal import pipeline. It runs **on your computer**, not in the cloud.

## Where things run

| Piece | Runs | Notes |
|---|---|---|
| The web app | your browser | served by the worker at `http://127.0.0.1:8765` |
| The job API | the worker | same origin as the app — no CORS, no mixed content |
| Chromium | your computer | a real window, so you can sign in and pass 2FA yourself |
| Downloaded CSVs | `worker/downloads/` | until the app imports them |
| Amazon session | `worker/profile/` | a browser profile; never leaves your machine |

**A page on `https://claude.ai` cannot reach this worker.** Browsers block an
HTTPS page from calling `http://localhost`, and no server setting changes that.
That is why the worker serves the app itself — open the address it prints, and
the app and the API are the same origin. The published artifact still works for
everything else; it just has no downloader.

## Install (once)

```bash
pip install -r worker/requirements.txt
python -m playwright install chromium
```

## Run

```bash
python worker/worker.py
```

It prints a link like `http://127.0.0.1:8765/?token=…`. Open that. The token
stops other pages in your browser from driving the worker; it is removed from
the address bar once the app has it, and changes on every start unless you set
`FBA_WORKER_TOKEN`.

The worker listens on loopback only. Nothing on your network can reach it.

## Record the page steps (once per report)

Amazon's report pages differ by account and marketplace and change over time.
Nothing here ships guessed selectors, because a selector that half-works
produces the worst outcome: a file that downloads, imports, and is the wrong
report. So you record the real steps once:

```bash
python worker/discover.py fees-preview
```

A browser opens. Sign in to Amazon if it asks, then click each control the
script names — the From box, the To box, the Generate button if there is one,
and the Download control. It writes `worker/selectors.json`, and the worker
replays those steps from then on.

Until a report has been recorded, its button in the app is disabled and says
why. If Amazon later changes the page, the job fails with a clear error and you
re-run `discover.py`.

## Signing in

You sign in to Amazon yourself, in the window the worker opens. This program
never asks for, stores or types your password, and never tries to bypass
verification.

If Amazon asks for a login or 2FA partway through, the job stops at
**"Waiting for you to sign in to Amazon"** — not "complete". Finish the sign-in
in that window, then press **Retry** in the app. The job resumes; the report is
not requested twice.

## What it does not do

- It does not run while your computer is off, or while this process is stopped.
- It does not schedule anything yet. Daily syncing is designed
  (`syncSchedules` in `lib/schema.js`) but deliberately not switched on: a
  local worker cannot honestly promise a nightly run.
- It does not parse financial data. It downloads and structurally validates the
  file; the app parses it, so there is exactly one parser to trust.

## Files

| File | What it is |
|---|---|
| `worker.py` | HTTP server, job queue, job states |
| `seller_central.py` | Playwright automation, login pause, download capture |
| `discover.py` | records the real page steps, interactively |
| `selectors.json` | what it recorded (gitignored — it describes your account) |
| `profile/` | your Amazon browser session (gitignored) |
| `downloads/` | fetched CSVs (gitignored) |
