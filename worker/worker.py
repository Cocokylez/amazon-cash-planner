"""Local worker: serves the web app and runs Seller Central downloads.

WHY THE WORKER SERVES THE APP

A page on https://claude.ai cannot call http://localhost — browsers block it as
mixed content, and no CORS header fixes that. So instead of trying to bridge two
origins, the worker serves the app itself. The page and the API are then the
same origin, which removes CORS, mixed content and cookie problems in one go.

    http://127.0.0.1:8765/            the app
    http://127.0.0.1:8765/api/...     the job API

WHAT RUNS WHERE

Everything here runs on YOUR machine. Playwright drives a real Chromium against
Seller Central using a browser profile stored beside this file. Nothing is sent
anywhere except to Amazon, and no Amazon password is ever typed by this program
or entered in the web app: you sign in yourself, in the browser window it opens.

    worker/profile/     the logged-in browser profile (gitignored)
    worker/downloads/   CSVs, until they are imported

The worker only runs while this process runs. It cannot download anything while
your computer is off.
"""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import shutil
import sys
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import archive                  # local; stdlib only, so not deferred

# Windows consoles default to a legacy codepage, which turns any non-ASCII
# character in a message into a "?" — exactly the messages people are asked
# to read when something has gone wrong.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent
PROFILE_DIR = HERE / "profile"
MAX_BODY = 64 << 20          # a request body this program will accept


DOWNLOAD_DIR = HERE / "downloads"
# Every report ever downloaded, in one file that outlives the CSV and
# the browser that imported it. See archive.py for why it exists.
ARCHIVE_DB = HERE / "reports.db"
SELECTORS_PATH = HERE / "selectors.json"
# The parsed dataset the local app publishes here, which the MCP bridge serves
# to an artifact. Financial figures only — never credentials.
DATASET_PATH = HERE / "data" / "dataset.json"

# Bumped whenever the app needs a helper new enough to talk to. The app
# compares this against what it expects and says plainly when they differ,
# because "it is running but it is the old code" was the hardest failure to
# see from the outside.
HELPER_VERSION = "4.8.0"

HOST = "127.0.0.1"          # loopback only: never exposed to the network
PORT = int(os.environ.get("FBA_WORKER_PORT") or 0) or None  # resolved after config

# A token required on every /api call, so another page in your browser cannot
# drive the worker behind your back. install.py writes a stable one to
# config.json so the bookmark keeps working; the environment still wins, and a
# throwaway is generated when there is neither.
CONFIG_PATH = HERE / "config.json"


def _config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text("utf-8"))
    except Exception:
        return {}


_CFG = _config()
PORT = PORT or int(_CFG.get("port") or 8765)
TOKEN = os.environ.get("FBA_WORKER_TOKEN") or _CFG.get("token") or uuid.uuid4().hex

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}

STATUSES = [
    "queued", "login-required", "requesting", "generating",
    "downloading", "validating", "importing", "complete", "failed", "cancelled",
]


LOG_DIR = HERE / "logs"
LOG_PATH = LOG_DIR / "helper.log"


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def redact(text: str) -> str:
    """Never write the token or an Amazon cookie into a file the user will
    paste into a chat window."""
    out = str(text)
    import re
    out = re.sub(r'(?im)(authorization|cookie|set-cookie)\s*:[^\r\n]*', r'\1: <redacted>', out)
    out = re.sub(r'(?i)([?&](?:token|code|access_token|refresh_token|signature|password)=)[^\s&]+', r'\1<redacted>', out)
    out = out.replace(str(Path.home()), '<home>')
    if TOKEN:
        out = out.replace(TOKEN, "<token-redacted>")
    for key in ("token=", "Cookie:", "set-cookie", "session-id", "x-amz-"):
        idx = 0
        while True:
            i = out.lower().find(key.lower(), idx)
            if i < 0:
                break
            end = i + len(key)
            stop = end
            while stop < len(out) and out[stop] not in " \r\n\"\'&;":
                stop += 1
            out = out[:end] + "<redacted>" + out[stop:]
            idx = end + 10
    return out


def log(line: str) -> None:
    try:
        LOG_DIR.mkdir(exist_ok=True)
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write("%s  %s\n" % (now(), redact(line)))
    except Exception:
        pass


def port_owner(host: str, port: int) -> str:
    """Who is on this port: us, something else, or nobody."""
    import socket
    import urllib.request

    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect((host, port))
    except Exception:
        return "free"
    finally:
        try:
            s.close()
        except Exception:
            pass

    try:
        with urllib.request.urlopen(
                "http://%s:%d/api/health" % (host, port), timeout=2) as r:
            body = r.read(400).decode("utf-8", "replace")
        if "fba-local-worker" in body:
            return "ours"
    except Exception:
        pass
    return "other"


class JobStore:
    """In-memory job records. Deliberately not the financial store: jobs are
    operational state, and they carry no credentials."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, dict] = {}
        self._order: list[str] = []
        self.path = HERE / 'jobs.json'
        if self.path.exists():
            rows = json.loads(self.path.read_text('utf-8'))
            for job in rows:
                if job['status'] not in ('complete', 'failed', 'cancelled', 'importing'):
                    job.update(status='failed', lastError='Helper restarted. Retry will reuse the saved report ticket.')
                self._jobs[job['jobId']] = job
                self._order.append(job['jobId'])

    def _save(self):
        temp = self.path.with_suffix('.tmp')
        temp.write_text(json.dumps([self._jobs[k] for k in self._order]), 'utf-8')
        temp.replace(self.path)

    def create(self, report_type: str, date_from: str, date_to: str,
               marketplace: str | None = None,
               account_type: str | None = None,
               date_range: str | None = None) -> dict:
        with self._lock:
            # Never request a report that is already pending. Marketplace and
            # account type are part of the identity: the same dates for two
            # countries are two different reports.
            for jid in reversed(self._order):
                j = self._jobs[jid]
                if (j["reportType"] == report_type
                        and j["requestedFrom"] == date_from
                        and j["requestedTo"] == date_to
                        and j.get("marketplace") == marketplace
                        and j.get("accountType") == account_type
                        and j.get("dateRange") == date_range
                        and (j["status"] not in ("complete", "failed", "cancelled")
                             or j.get('ticket'))):
                    # Two very different situations, and reporting them the
                    # same way told the seller "already running" while nothing
                    # was running at all - no browser, no progress, no way
                    # forward.
                    #
                    #   still going    leave it alone
                    #   failed, but a report WAS requested (it has a ticket)
                    #                  pick that report up rather than
                    #                  asking Amazon for another one
                    live = j["status"] not in ("complete", "failed", "cancelled")
                    return dict(j, reused=True, resumable=not live)

            job = {
                "jobId": "job-" + uuid.uuid4().hex[:12],
                "reportType": report_type,
                "requestedFrom": date_from,
                "requestedTo": date_to,
                "marketplace": marketplace,
                "accountType": account_type,
                "dateRange": date_range,
                "status": "queued",
                "statusDetail": "Waiting for the worker to pick this up.",
                "attempt": 1,
                "queuedAt": now(),
                "startedAt": None,
                "finishedAt": None,
                "lastError": None,
                "filePath": None,
                "fileName": None,
                "rowCount": None,
                "reused": False,
            }
            self._jobs[job["jobId"]] = job
            self._order.append(job["jobId"])
            self._save()
            return job

    def update(self, job_id: str, **fields) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            job.update(fields)
            self._save()
            return dict(job)

    def remove(self, job_id: str) -> dict | None:
        """Forget a job. A job still working is left alone.

        Returns the record as it was, so the caller can decide what to do
        with the file it downloaded, or None if there was nothing to forget.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            if job["status"] not in ("complete", "failed", "cancelled"):
                return {"busy": job["status"]}
            gone = dict(job)
            del self._jobs[job_id]
            self._order = [j for j in self._order if j != job_id]
            self._save()
            return gone

    def get(self, job_id: str) -> dict | None:
        with self._lock:
            j = self._jobs.get(job_id)
            return dict(j) if j else None

    def list(self) -> list[dict]:
        with self._lock:
            return [dict(self._jobs[j]) for j in reversed(self._order)]


JOBS = JobStore()
SETUP: dict = {"session": None}

SETTINGS_PATH = HERE / "settings.json"
DEFAULT_SETTINGS = {
    # Amazon's own names, as they appear in the marketplace switcher.
    "marketplaces": ["United States"],
    "accountType": "All (Unified Reports)",
    # Which named range to ask the SKU Economics page for. One of ITS choices,
    # verified against the live dropdown before anything is requested - this is
    # a forecast page, so the useful ranges look forward.
    # The custom range is the default because it is the one that carries THIS
    # app's reporting period into the report. The named windows are Amazon's
    # own and ignore the dates on screen.
    "skuDateRange": "Custom date range",
    # This page reports on ONE marketplace at a time, chosen by its code. Kept
    # separate from the country list above, which belongs to the transaction
    # report and means something different there.
    "skuMarketplace": "US",
}


def load_settings() -> dict:
    try:
        data = json.loads(SETTINGS_PATH.read_text("utf-8"))
        return {**DEFAULT_SETTINGS, **data}
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_settings(data: dict) -> dict:
    merged = {**load_settings(), **(data or {})}
    mkts = merged.get("marketplaces") or []
    merged["marketplaces"] = [m for m in mkts if isinstance(m, str) and m.strip()]

    # A blank or non-text range would be typed at the page and fail only at the
    # moment of asking, after the browser had opened. Kept to the last good one.
    mkt = merged.get("skuMarketplace")
    if not isinstance(mkt, str) or not mkt.strip():
        merged["skuMarketplace"] = DEFAULT_SETTINGS["skuMarketplace"]
    else:
        merged["skuMarketplace"] = mkt.strip()

    rng = merged.get("skuDateRange")
    if not isinstance(rng, str) or not rng.strip():
        merged["skuDateRange"] = DEFAULT_SETTINGS["skuDateRange"]
    else:
        merged["skuDateRange"] = rng.strip()

    SETTINGS_PATH.write_text(json.dumps(merged, indent=2), "utf-8")
    return merged
WORK_QUEUE: "queue.Queue[str]" = queue.Queue()


# ── report definitions ──────────────────────────────────────────────────────
#
# Selectors are NOT guessed. Each report starts unverified; `discover.py` opens
# the real page and records what is actually there, and a job refuses to run
# until that has happened. An invented selector that half-works is worse than a
# refusal, because it produces a file that looks right and is not.

def load_selectors() -> dict:
    if SELECTORS_PATH.exists():
        try:
            return json.loads(SELECTORS_PATH.read_text("utf-8"))
        except Exception:
            return {}
    return {}


# "Today's data" means different dates for different reports: a forecast looks
# forward, a transaction history looks back. Each report carries its own window
# so one button can ask for the right thing.
REPORTS = {
    "fees-preview": {
        "label": "SKU Economics Report",
        # The live page, confirmed from the seller's own screen. An earlier
        # build pointed at /revcal/feepreview, which is a different, older
        # surface: it has From/To boxes, where this one has a Date Range
        # dropdown and two groups of checkboxes.
        "url": "https://sellercentral.amazon.com/cepreport",
        "note": "Forecast sales and fees by MSKU.",
        "rangeKind": "forecast",
        "aheadDays": 56,          # the eight-week horizon the app forecasts over
        "coverage": "the next eight weeks",
        # Every marketplace on the page is ticked inside one report, so there
        # is no single country to choose and no per-country job to create.
        "needsMarketplace": False,
        "needsAccountType": False,
        # This page does not take typed dates and does not take one country.
        # It takes: every marketplace box ticked, every report-content box
        # ticked, and a date range picked from a list. See
        # request_checkbox_form() in seller_central.py.
        "formKind": "checkbox-form",
        # Driven by worker/sku_economics.py rather than recorded selectors.
        "driver": "sku-economics",
        # Which named range to ask the page for. It is a choice from Amazon's
        # own list ("Next 7 days", "Next 30 days", "Next 120 days"), not a pair
        # of dates, so it is stored by name and verified against the page.
        "dateRangeValue": "Next 30 days",
        # A FORECAST source. Configured and verified on its own; never mixed
        # with the historical transaction report.
        "kind": "forecast",
    },
    "date-range-transactions": {
        "label": "Payments date-range transactions",
        "url": "https://sellercentral.amazon.com/payments/reports-repository",
        "note": "Actual transactions, used for release timing and real fees.",
        "rangeKind": "historical",
        "kind": "historical",
        "backDays": 45,           # refunds and late postings land inside ~6 weeks
        "coverage": "the last 45 days",
        "needsMarketplace": True,
        "needsAccountType": True,
        # Amazon's own wording. "All (Unified Reports)" is what a seller with
        # more than one account stream normally wants, and is what the user's
        # previous export used, so it leads.
        "accountTypes": [
            "All (Unified Reports)",
            "Standard Orders",
            "Invoiced Orders",
        ],
    },
}


def range_for(report_type: str, today: date | None = None) -> tuple[str, str]:
    """The dates this report should be asked for, as of today."""
    spec = REPORTS[report_type]
    t = today or date.today()
    if spec["rangeKind"] == "forecast":
        # From TOMORROW. Today is already part-spent, and a forecast window
        # that includes it counts a half-finished day as a whole one. This
        # matches the app's own forward ranges.
        start = t + timedelta(days=1)
        return start.isoformat(), (start + timedelta(days=spec["aheadDays"] - 1)).isoformat()
    return (t - timedelta(days=spec["backDays"])).isoformat(), t.isoformat()


def report_ready(report_type: str) -> tuple[bool, str]:
    # A report with its own driver needs nothing recorded: it finds the
    # controls from the words printed on the page. Asking someone to point at
    # six tick boxes they can already read is work for no gain, and a recorded
    # CSS path breaks when Amazon reshuffles its markup while a heading does not.
    if REPORTS.get(report_type, {}).get("driver") == "sku-economics":
        return True, ""

    sels = load_selectors().get(report_type)
    if not sels or not sels.get("verified"):
        return False, (
            "Not set up yet. In the app, open Data & assumptions and choose "
            "'Set up' for this report — a browser opens and you click the "
            "controls it names. It takes about a minute, once. Nothing is "
            "guessed: until the real page has been seen, this job will not run."
        )
    required = ['expectAccountText', 'sellerAccountControl', 'marketplaceSwitcher',
                'reportRow', 'rowDownload', 'fromDate', 'toDate', 'requestButton']
    if REPORTS[report_type].get('needsAccountType'):
        required += ['accountTypeControl', 'reportTypeControl']
    missing = [key for key in required if not sels.get(key)]
    if missing:
        return False, 'Re-run setup: missing ' + ', '.join(missing)
    return True, ""


# ── the job runner ──────────────────────────────────────────────────────────

def run_job(job_id: str) -> None:
    job = JOBS.get(job_id)
    if not job:
        return

    JOBS.update(job_id, status="requesting", startedAt=now(),
                statusDetail="Opening Seller Central.")

    ok, why = report_ready(job["reportType"])
    if not ok:
        JOBS.update(job_id, status="failed", finishedAt=now(),
                    lastError=why, statusDetail="Page steps not recorded.")
        return

    try:
        from seller_central import download_report      # noqa: WPS433
    except Exception as exc:                            # pragma: no cover
        JOBS.update(job_id, status="failed", finishedAt=now(),
                    lastError="Playwright is not installed: %s" % exc,
                    statusDetail="Run: pip install -r worker/requirements.txt "
                                 "&& python -m playwright install chromium")
        return

    def progress(status: str, detail: str) -> None:
        if status not in STATUSES:
            status = "requesting"
        JOBS.update(job_id, status=status, statusDetail=detail)

    spec = REPORTS.get(job["reportType"], {})
    try:
        if spec.get("driver") == "sku-economics":
            # One fixed page with printed headings, so it is driven directly
            # instead of through recorded selectors. It takes a NAMED range
            # from Amazon's own list, not the pair of dates the other report
            # takes, so no dates are passed to it.
            from sku_economics import download as sku_download   # noqa: WPS433
            settings = load_settings()
            result = sku_download(
                out_dir=DOWNLOAD_DIR,
                date_range=job.get("dateRange") or spec.get("dateRangeValue")
                or "Next 30 days",
                profile_dir=PROFILE_DIR,
                progress=progress,
                # Used only if the page turns out to take ONE country. When it
                # takes several, every one of them is selected.
                # The ONE marketplace this report covers, chosen in the app
                # by the code the page uses. Not the country list, which is
                # the transaction report's and means something else there.
                marketplace=settings.get("skuMarketplace") or "US",
                # Only used when the range is the custom one: then these are
                # typed into the From and To boxes the page reveals.
                date_from=job["requestedFrom"],
                date_to=job["requestedTo"],
                # A report already requested is collected, not requested
                # again. Without this every retry generated a fresh report
                # and the Generated Reports list filled with duplicates of
                # the same period.
                ticket=job.get("ticket"),
                save_ticket=lambda t: JOBS.update(job_id, ticket=t),
            )
        else:
            result = download_report(
                report_type=job["reportType"],
                date_from=job["requestedFrom"],
                date_to=job["requestedTo"],
                profile_dir=PROFILE_DIR,
                download_dir=DOWNLOAD_DIR,
                selectors=load_selectors().get(job["reportType"], {}),
                progress=progress,
                marketplace=job.get("marketplace"),
                account_type=job.get("accountType"),
                ticket=job.get('ticket'),
                save_ticket=lambda ticket: JOBS.update(job_id, ticket=ticket),
            )
    except Exception as exc:
        JOBS.update(job_id, status="failed", finishedAt=now(),
                    lastError=str(exc),
                    statusDetail="The download did not complete.")
        return

    if result.get("loginRequired"):
        # Spec 7: a job waiting for a login stays waiting. It is never complete.
        JOBS.update(
            job_id, status="login-required",
            statusDetail="Please sign in to Amazon in the browser window that "
                         "opened, then press Retry. Your place is kept; the "
                         "report is not requested twice.")
        return

    path = Path(result["path"])
    JOBS.update(job_id, status="validating",
                statusDetail="Checking the downloaded file.")

    problem = validate_csv(path)
    if problem:
        JOBS.update(job_id, status="failed", finishedAt=now(), lastError=problem,
                    statusDetail="The downloaded file did not validate.")
        return

    # What the report actually contains. A file short of whole option groups is
    # still worth importing - the columns it does have are real - but the
    # shortfall is recorded so it is not a mystery later.
    present, absent = option_groups_in(path)
    note = ""
    if absent and spec.get("driver") == "sku-economics":
        note = (" The report carries %d of the %d option groups; %s %s absent, "
                "so figures that depend on them cannot be shown. Running it "
                "again may pick them up."
                % (len(present), len(present) + len(absent),
                   ", ".join(absent),
                   "is" if len(absent) == 1 else "are"))

    # Into the archive BEFORE the app is told to import. If the browser never
    # comes back - closed tab, cleared storage, a different machine - the
    # report is still recorded, and its rows can be pushed later.
    #
    # The helper records the report. It does NOT read the figures: the app
    # parses the file and pushes back the rows it decided on, so there is one
    # parser and the archive holds exactly what the app believes.
    archive_id = archive.record_report(
        ARCHIVE_DB,
        dict(JOBS.get(job_id) or {}, filePath=str(path), fileName=path.name,
             rowCount=result.get("rowCount"), reportTag=result.get("tag"),
             coverageFrom=result.get("coverageFrom"),
             coverageTo=result.get("coverageTo"), finishedAt=now()),
        present, absent)

    JOBS.update(
        job_id, optionGroups=present, optionGroupsMissing=absent,
        archiveId=archive_id,
        status="importing", filePath=str(path), fileName=path.name,
        rowCount=result.get("rowCount"),
        reportTag=result.get("tag"),
        coverageFrom=result.get("coverageFrom"),
        coverageTo=result.get("coverageTo"),
        statusDetail="Ready for the app to import." + note)
    # The app fetches the file and runs it through the SAME import pipeline as a
    # manual upload, then marks the job complete. The worker never parses
    # financial data itself, so there is only one parser to trust.


# The six tick boxes on the SKU Economics page, and the columns each one puts
# in the export. Named by the words on the page so the connection is readable.
OPTION_GROUPS = {
    "Fulfillment base rate and surcharges": [
        "Base fulfillment fee", "FBA fulfillment fees",
        "Fuel and Logistics-related surcharge", "Low-inventory-level fee",
    ],
    "Sales Data": [
        "Units sold", "Net units sold", "Net sales", "Average sales price",
    ],
    "Storage Fee base rate and surcharges": [
        "Base monthly storage fee", "Monthly inventory storage fee",
        "Storage utilization surcharge", "Aged inventory surcharge",
    ],
    "Return and refund fees": [
        "Returns processing fee",
    ],
    "Referral and closing fees": [
        "Referral fee", "Closing fee", "Per-item selling fee",
    ],
    "Advertising Spend Data": [
        "Sponsored Products charge",
    ],
}


def delete_downloaded_file(job: dict) -> tuple[str | None, str | None]:
    """Delete the CSV a job downloaded. Returns (deleted, kept-and-why).

    ONLY a file this program saved is deleted. A path pointing anywhere else
    belongs to the seller - the browser's own Downloads folder is the usual
    case, and a report rescued from there still names its original home - and
    deleting from there is not this program's business.
    """
    raw = job.get("filePath")
    if not raw:
        return None, None

    f = Path(raw)
    try:
        inside = f.resolve().parent == DOWNLOAD_DIR.resolve()
    except Exception:
        inside = False

    if not f.is_file():
        return None, None                   # already gone; nothing to report
    if not inside:
        return None, ("%s was left alone: it is outside %s, so it is yours "
                      "rather than this program's." % (f.name, DOWNLOAD_DIR))
    try:
        f.unlink()
        return f.name, None
    except Exception as exc:
        return None, "%s could not be deleted (%s)." % (f.name, str(exc)[:80])


def option_groups_in(path: Path) -> tuple[list[str], list[str]]:
    """Which of the six options this export actually contains.

    The driver ticks all six, but a tick that does not register produces a file
    that is short of whole groups of columns - and nothing said so. The app
    then showed "Needs a required input" against Net sales, Advertising and
    Storage with no way to tell that the cause was a box that never took.
    """
    try:
        header = path.read_bytes()[:16384].decode("utf-8-sig", "replace")
        header = header.splitlines()[0] if header.splitlines() else ""
    except Exception:
        return [], list(OPTION_GROUPS)

    cols = [c.strip().strip('"').lower() for c in header.split(",")]
    present, absent = [], []
    for group, markers in OPTION_GROUPS.items():
        if any(any(c.startswith(m.lower()) for c in cols) for m in markers):
            present.append(group)
        else:
            absent.append(group)
    return present, absent


def validate_csv(path: Path) -> str | None:
    """Cheap structural checks. The real parsing and validation is the app's,
    so there is exactly one implementation of it."""
    if not path.exists():
        return "The file was not written to disk."
    size = path.stat().st_size
    if size == 0:
        return "The downloaded file is empty (0 bytes)."
    try:
        head = path.read_bytes()[:65536].decode("utf-8-sig", errors="replace")
    except Exception as exc:
        return "The file could not be read: %s" % exc
    if "," not in head and "\t" not in head:
        return "The file does not look like a CSV."
    if "<html" in head[:400].lower():
        return ("Amazon returned a web page instead of a report — usually a "
                "sign-in or verification screen.")
    return None


def worker_loop() -> None:
    while True:
        job_id = WORK_QUEUE.get()
        try:
            run_job(job_id)
        except Exception as exc:                        # pragma: no cover
            JOBS.update(job_id, status="failed", finishedAt=now(),
                        lastError=str(exc))
        finally:
            WORK_QUEUE.task_done()


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "FbaWorker/1.0"

    def log_message(self, fmt, *args):                  # quieter, and no paths
        return

    # -- helpers ------------------------------------------------------------

    def _json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        import hmac
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'):
            return False
        return hmac.compare_digest(self.headers.get('X-Worker-Token', ''), TOKEN)

    # -- routes -------------------------------------------------------------

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            from launch import instance_id
            if not self._authed():
                return self._json({'ok': True, 'worker': 'fba-local-worker',
                                   'version': HELPER_VERSION, 'authorized': False})
            return self._json({
                "ok": True,
                "authorized": True,
                "instance": instance_id(),
                "worker": "fba-local-worker",
                "version": HELPER_VERSION,
                "schema": 1,
                # `url` is where setup STARTS. `resolvedUrl` is where a
                # completed setup actually landed, and is what a download opens.
                # Both are reported so the app can show the real one rather
                # than the intended one - a report set up against an old
                # address would otherwise look correct on screen.
                "reports": [
                    dict(REPORTS[k], id=k, ready=report_ready(k)[0],
                         reason=report_ready(k)[1] or None,
                         resolvedUrl=(load_selectors().get(k) or {}).get("resolvedUrl"),
                         todayRange=dict(zip(("from", "to"), range_for(k))))
                    for k in REPORTS
                ],
                "setupComplete": all(report_ready(k)[0] for k in REPORTS),
                "settings": load_settings(),
                "profileExists": PROFILE_DIR.exists(),
                "startedAt": STARTED_AT,
            })

        if path.startswith("/api/"):
            if not self._authed():
                return self._json({"error": "bad or missing worker token"}, 401)

            if path == "/api/archive":
                return self._json(archive.summary(ARCHIVE_DB))

            # The app's own state, which used to live in whichever browser
            # happened to be open. Every browser on this machine now reads the
            # same document.
            if path == "/api/state":
                return self._json(archive.read_state(ARCHIVE_DB))

            if path == "/api/state/history":
                return self._json({"revisions": archive.state_history(ARCHIVE_DB)})

            if path == "/api/jobs":
                return self._json({"jobs": JOBS.list()})

            if path == "/api/dataset":
                try:
                    d = json.loads(DATASET_PATH.read_text("utf-8"))
                    return self._json({
                        "present": True,
                        "pushedAt": d.get("pushedAt"),
                        "bytes": DATASET_PATH.stat().st_size,
                        "hasForecast": bool((d.get("forecast") or {}).get("present")),
                        "hasActual": bool((d.get("actual") or {}).get("present")),
                    })
                except Exception:
                    return self._json({"present": False})

            if path == "/api/chrome/profiles":
                try:
                    import chrome_profiles as CP
                    return self._json({
                        "chromeFound": CP.user_data_dir() is not None,
                        "chromeRunning": CP.chrome_running(),
                        "profiles": CP.list_profiles(),
                        "chosen": load_settings().get("chromeProfile"),
                    })
                except Exception as exc:
                    return self._json({"error": str(exc), "profiles": []})

            if path == "/api/setup/state":
                sess = SETUP.get("session")
                return self._json(sess.snapshot() if sess else {"phase": "idle"})

            if path == "/api/session":
                # Is the Amazon session still good? Answered from the profile's
                # age, not by opening a browser: probing on every page load
                # would be a download nobody asked for.
                from seller_central import profile_args
                prof = PROFILE_DIR / profile_args(PROFILE_DIR)[0].split("=", 1)[1]
                ever = prof.exists()
                return self._json({
                    "everSignedIn": ever,
                    "lastTouched": (
                        datetime.fromtimestamp(prof.stat().st_mtime,
                                               timezone.utc).isoformat()
                        if ever else None),
                    "note": "Whether Amazon still accepts it is only known when "
                            "a job runs; a stale session pauses that job for "
                            "sign-in rather than failing it.",
                })

            if path.startswith("/api/jobs/") and path.endswith("/file"):
                job_id = path.split("/")[3]
                job = JOBS.get(job_id)
                if not job or not job.get("filePath"):
                    return self._json({"error": "no file for that job"}, 404)
                # A file that cannot be read must SAY so. Letting the read
                # raise killed the connection with no response at all, and the
                # app could only report "Failed to fetch" - which says nothing
                # about a download sitting on disk under a bad path.
                try:
                    data = Path(job["filePath"]).read_bytes()
                except Exception as exc:
                    return self._json({
                        "error": "The downloaded file could not be read: %s"
                                 % exc,
                        "path": job.get("fileName") or job.get("filePath"),
                    }, 409)
                if not data:
                    return self._json({
                        "error": "The downloaded file is empty (0 bytes).",
                        "path": job.get("fileName"),
                    }, 409)

                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition",
                                 'attachment; filename="%s"' % job["fileName"])
                self.end_headers()
                self.wfile.write(data)
                return

            if path.startswith("/api/jobs/"):
                job = JOBS.get(path.split("/")[3])
                return self._json(job or {"error": "not found"}, 200 if job else 404)

            return self._json({"error": "unknown endpoint"}, 404)

        # -- static: the app itself, same origin as the API ------------------
        rel = "app.html" if path in ("/", "") else path.lstrip("/")
        target = (APP_DIR / rel).resolve()
        public = rel == 'app.html' or (rel.startswith('lib/') and target.suffix == '.js' and target.parent == APP_DIR / 'lib')
        if not public or not target.is_relative_to(APP_DIR) or not target.is_file():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"not found")
            return
        # Explicit, not mimetypes.guess_type: on Windows that reads the
        # registry, where .js is mapped to text/html on some machines. And
        # without a charset the browser guesses, turning an en dash into
        # mojibake.
        ctype = TYPES.get(target.suffix.lower(), "application/octet-stream")
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(data)

    def do_HEAD(self) -> None:
        # Without this, `curl -I` gets a 501 error page and its text/html
        # content type, which reads as a bug in the server that is not there.
        self._head_only = True
        try:
            self.do_GET()
        finally:
            self._head_only = False

    def _drain(self) -> None:
        """Read and discard the body of a request that is being refused.

        Without this the client is still writing when the socket closes, and
        the reset it gets in return is reported as a network failure instead
        of the status that was sent.
        """
        try:
            left = min(int(self.headers.get("Content-Length") or 0), MAX_BODY)
        except ValueError:
            return
        while left > 0:
            chunk = self.rfile.read(min(left, 1 << 16))
            if not chunk:
                break
            left -= len(chunk)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self._drain()
            return self._json({"error": "not found"}, 404)
        if not self._authed():
            self._drain()
            return self._json({"error": "bad or missing worker token"}, 401)
        if parsed.path == '/api/shutdown':
            self._drain()
            if (SETUP.get('session') and not SETUP['session'].snapshot().get('done')) or any(j['status'] not in ('complete', 'failed', 'cancelled') for j in JOBS.list()):
                return self._json({'error': 'A report is active. Finish it before updating.'}, 409)
            self._json({'ok': True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        # A cap, because archive pushes carry whole reports now and an
        # unbounded read is a promise to allocate whatever a caller claims.
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            # Not drained: that is the point, the body is too big to read. The
            # connection closes, which for an oversized request is honest.
            return self._json(
                {"error": "That request is %d MB; the limit is %d MB. Nothing "
                          "was stored." % (length >> 20, MAX_BODY >> 20)}, 413)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._json({"error": "bad JSON"}, 400)

        if parsed.path == "/api/refresh":
            # THE one-button endpoint. Every configured report, over its own
            # natural range, for every selected marketplace — each as its own
            # job, because Amazon reports one country at a time.
            settings = load_settings()
            mkts = payload.get("marketplaces") or settings["marketplaces"] or [None]
            acct = payload.get("accountType") or settings.get("accountType")
            override_from = payload.get("from")
            override_to = payload.get("to")

            created, skipped, blocked = [], [], []
            for rt in REPORTS:
                ready, why = report_ready(rt)
                if not ready:
                    blocked.append({"reportType": rt, "reason": why})
                    continue
                spec = REPORTS[rt]
                dfrom, dto = range_for(rt)
                if override_from and override_to and spec["rangeKind"] == "historical":
                    dfrom, dto = override_from, override_to

                # The SKU Economics page ticks every marketplace in ONE report,
                # so it gets one job. Looping countries here would request the
                # same all-countries file over and over.
                drange = None
                if spec.get("driver") == "sku-economics":
                    countries = [None]
                    drange = (settings.get("skuDateRange")
                              or spec.get("dateRangeValue") or "Next 30 days")
                    # A CUSTOM range means the dates on screen in the app - the
                    # whole point of choosing it. Without this the app promised
                    # the reporting period would be used and then quietly sent
                    # its own calculated window instead.
                    if drange.strip().lower() == "custom date range"                             and override_from and override_to:
                        dfrom, dto = override_from, override_to
                else:
                    countries = mkts if spec.get("needsMarketplace") else [None]

                for mkt in countries:
                    job = JOBS.create(
                        rt, dfrom, dto, marketplace=mkt,
                        account_type=acct if spec.get("needsAccountType") else None,
                        date_range=drange)
                    if job.get("resumable"):
                        # A report that was already asked for. Collect it.
                        JOBS.update(job["jobId"], status="queued",
                                    lastError=None,
                                    statusDetail="Collecting the report that "
                                                 "was already requested.")
                        WORK_QUEUE.put(job["jobId"])
                        created.append(JOBS.get(job["jobId"]))
                    elif job.get("reused"):
                        skipped.append(job)
                    else:
                        WORK_QUEUE.put(job["jobId"])
                        created.append(job)
            return self._json({"created": created, "alreadyRunning": skipped,
                               "notConfigured": blocked,
                               "marketplaces": mkts, "accountType": acct})

        if parsed.path == "/api/dataset":
            # The app parses reports in JavaScript; those parsers are the
            # tested ones. Re-implementing them in Python would mean two
            # answers to the same question, so the result is pushed here
            # instead and simply stored.
            try:
                DATASET_PATH.parent.mkdir(parents=True, exist_ok=True)
                body = dict(payload or {})
                body["pushedAt"] = now()
                body["helperVersion"] = HELPER_VERSION
                DATASET_PATH.write_text(json.dumps(body), "utf-8")
                log("dataset published: %d bytes" % DATASET_PATH.stat().st_size)
                return self._json({"ok": True, "bytes": DATASET_PATH.stat().st_size,
                                   "pushedAt": body["pushedAt"]})
            except Exception as exc:
                return self._json({"error": str(exc)}, 500)

        if parsed.path == "/api/settings":
            return self._json(save_settings(payload))

        if parsed.path == "/api/setup/start":
            rt = payload.get("reportType")
            if rt not in REPORTS:
                return self._json({"error": "unknown reportType"}, 400)
            if any(j['status'] not in ('complete', 'failed', 'cancelled', 'importing') for j in JOBS.list()):
                return self._json({'error': 'A report is using the browser. Wait for it to finish before setup.'}, 409)
            sess = SETUP.get("session")
            if sess and not sess.snapshot().get("done"):
                return self._json({"error": "setup already running"}, 409)
            from setup_flow import SetupSession          # noqa: WPS433
            chosen = payload.get("chromeProfile") or load_settings().get("chromeProfile")
            old = load_selectors().get(rt, {})
            working_url = old.get('resolvedUrl') or old.get('url') or REPORTS[rt]['url']
            SETUP["session"] = SetupSession(rt, working_url, PROFILE_DIR,
                                            REPORTS[rt], chrome_profile=chosen)
            return self._json(SETUP["session"].snapshot(), 201)

        if parsed.path == "/api/setup/answer":
            sess = SETUP.get("session")
            if not sess:
                return self._json({"error": "no setup running"}, 404)
            sess.send("answer", payload.get("value"))
            time.sleep(0.35)          # let the session advance before replying
            return self._json(sess.snapshot())

        if parsed.path == "/api/setup/cancel":
            sess = SETUP.get("session")
            if sess:
                sess.cancel()
            return self._json({"ok": True})

        if parsed.path == "/api/setup/save":
            sess = SETUP.get("session")
            snap = sess.snapshot() if sess else {}
            result = snap.get("result")
            if not result:
                return self._json({"error": "setup has not finished"}, 409)
            data = load_selectors()
            data[snap["reportType"]] = result
            SELECTORS_PATH.write_text(json.dumps(data, indent=2), "utf-8")
            SETUP["session"] = None
            return self._json({"ok": True, "reportType": snap["reportType"]})

        if parsed.path == "/api/jobs":
            report = payload.get("reportType")
            if report not in REPORTS:
                return self._json({"error": "unknown reportType"}, 400)
            try:
                begin, end = date.fromisoformat(payload.get('from', '')), date.fromisoformat(payload.get('to', ''))
                if begin > end or not payload.get('marketplace'):
                    raise ValueError()
                if REPORTS[report].get('needsAccountType') and payload.get('accountType') not in REPORTS[report]['accountTypes']:
                    raise ValueError()
            except (ValueError, TypeError):
                return self._json({'error': 'Choose a marketplace, valid account type and ordered ISO From/To dates.'}, 400)
            job = JOBS.create(report, payload.get("from"), payload.get("to"),
                              marketplace=payload.get("marketplace"),
                              account_type=payload.get("accountType"))
            if not job.get("reused"):
                WORK_QUEUE.put(job["jobId"])
            return self._json(job, 201)

        if parsed.path == "/api/state":
            body = payload.get("body")
            if body is None:
                return self._json({"error": "body is required"}, 400)

            revision = payload.get("revision")
            if not isinstance(revision, int) or revision < 0:
                return self._json(
                    {"error": "revision must be the number this caller read; "
                              "without it a save cannot tell whether it is "
                              "about to overwrite someone else's."}, 400)

            result = archive.write_state(
                ARCHIVE_DB, body, revision, by=payload.get("by"))

            if result.get("conflict"):
                # 409, and the caller is HANDED what is actually stored. It can
                # then show both rather than guessing which to keep: whichever
                # way that decision goes, it should not be made silently.
                return self._json({
                    "error": "Another window saved changes after this one "
                             "loaded. Nothing was overwritten.",
                    "conflict": True,
                    "revision": result.get("revision"),
                    "body": result.get("body"),
                }, 409)

            if not result.get("ok"):
                return self._json(
                    {"error": result.get("error") or "The state could not be "
                                                     "saved."}, 500)
            return self._json(result)

        if parsed.path.endswith("/archive-rows"):
            job_id = parsed.path.split("/")[3]
            job = JOBS.get(job_id)
            if not job:
                return self._json({"error": "not found"}, 404)

            # The payload is checked BEFORE anything is written. Recording the
            # report first meant a malformed push still left a report behind
            # with no rows under it - a test caught exactly that.
            rows = payload.get("rows")
            if not isinstance(rows, list):
                return self._json({"error": "rows must be a list"}, 400)

            report_id = job.get("archiveId")
            if not report_id:
                # The report predates the archive, or recording it failed.
                # Record it now rather than dropping the rows on the floor.
                report_id = archive.record_report(
                    ARCHIVE_DB, job,
                    job.get("optionGroups") or [],
                    job.get("optionGroupsMissing") or [])
                if report_id:
                    JOBS.update(job_id, archiveId=report_id)
            if not report_id:
                return self._json(
                    {"error": "This report could not be archived, so its rows "
                              "were not stored. The import itself is "
                              "unaffected."}, 503)

            # The scale the app's exact money was written at travels with the
            # rows, so a future change is detectable rather than a silent
            # factor-of-ten error in somebody's fees.
            scale = payload.get("moneyScale")
            scale = scale if isinstance(scale, int) else None
            stored = archive.record_rows(ARCHIVE_DB, report_id, rows, scale)
            return self._json({"reportId": report_id, "rowsStored": stored,
                               "rowsSent": len(rows)})

        if parsed.path.endswith("/delete"):
            job_id = parsed.path.split("/")[3]
            job = JOBS.remove(job_id)
            if job is None:
                return self._json({"error": "not found"}, 404)
            if job.get("busy"):
                return self._json(
                    {"error": "This report is %s. Let it finish or cancel it "
                              "first; nothing was deleted." % job["busy"]}, 409)

            removed_file, kept_file = delete_downloaded_file(job)
            # Delete means delete, here as well. An archive that quietly kept
            # what someone asked to remove would be a worse surprise than an
            # archive that loses history they chose to lose.
            forgotten = archive.forget_report(ARCHIVE_DB, job_id)

            return self._json({
                "archived": forgotten,
                "deleted": job_id,
                "fileDeleted": removed_file,
                "fileKept": kept_file,
                # Said plainly: this removes the REQUEST, not the figures. Data
                # already imported lives in the browser and is removed there.
                "note": "The report record is gone. Anything already imported "
                        "from it is still in the app and is removed from "
                        "Imported files.",
            })

        if parsed.path.endswith("/retry"):
            job_id = parsed.path.split("/")[3]
            job = JOBS.get(job_id)
            if not job:
                return self._json({"error": "not found"}, 404)
            if job['status'] not in ('failed', 'cancelled'):
                return self._json({'error': 'Job is active or already complete; a second attempt was not queued.'}, 409)
            if job.get('filePath') and Path(job['filePath']).is_file():
                return self._json(JOBS.update(job_id, status='importing', lastError=None,
                    statusDetail='Retrying import of the retained file; Amazon is not contacted.'))
            JOBS.update(job_id, status="queued", lastError=None,
                        attempt=(job.get("attempt") or 1) + 1,
                        statusDetail="Retrying.")
            WORK_QUEUE.put(job_id)
            return self._json(JOBS.get(job_id))

        if parsed.path.endswith('/import-failed'):
            job_id = parsed.path.split('/')[3]
            job = JOBS.get(job_id)
            if not job or job['status'] != 'importing':
                return self._json({'error': 'No pending import'}, 409)
            # The REASON, not just the fact. The app knows exactly why the
            # file would not import - wrong columns, storage refused, a parse
            # error - and burying that behind one fixed sentence meant every
            # different failure read the same and none of them could be acted
            # on.
            why = (payload or {}).get('reason')
            why = why.strip() if isinstance(why, str) and why.strip() else None
            return self._json(JOBS.update(job_id, status='failed',
                lastError=('Downloaded, but the app could not import it: %s' % why)
                if why else
                'Browser could not verify the imported data in storage. See its import receipt, then Retry.',
                statusDetail='Downloaded file retained. Retry imports it without requesting again.'))

        if parsed.path.endswith("/imported"):
            # The app confirms it has parsed and stored the file.
            job_id = parsed.path.split("/")[3]
            job = JOBS.get(job_id)
            if not job or job['status'] != 'importing' or not job.get('filePath'):
                return self._json({'error': 'No downloaded file awaiting import'}, 409)
            upd = JOBS.update(
                job_id, status="complete", finishedAt=now(),
                rowCount=payload.get("rowsAccepted"),
                statusDetail="Imported %s of %s rows." % (
                    payload.get("rowsAccepted"), payload.get("rowsProcessed")))
            return self._json(upd or {"error": "not found"},
                              200 if upd else 404)

        return self._json({"error": "unknown endpoint"}, 404)


STARTED_AT = now()


def preflight() -> None:
    """Fail loudly and specifically, before anything claims to be running."""
    owner = port_owner(HOST, PORT)
    if owner == "ours":
        raise SystemExit(
            "\n  The helper is ALREADY RUNNING on port %d.\n"
            "  Nothing to do \u2014 open the app with the Desktop shortcut.\n"
            "  (If you meant to restart it, close the other one first.)\n" % PORT)
    if owner == "other":
        raise SystemExit(
            "\n  PORT %d IS IN USE by another program.\n"
            "\n  Something that is not this helper is already listening on\n"
            "  127.0.0.1:%d, so the helper cannot start there. That other\n"
            "  program has NOT been touched.\n"
            "\n  To see what it is, run this in a terminal:\n"
            "      netstat -ano | findstr :%d\n"
            "  then look up the last number (the PID) in Task Manager.\n"
            "\n  To use a different port instead, edit config.json in this\n"
            "  folder and change \"port\" to, for example, 8766. Then run the\n"
            "  Desktop shortcut again.\n" % (PORT, PORT, PORT))


def main() -> None:
    PROFILE_DIR.mkdir(exist_ok=True)
    DOWNLOAD_DIR.mkdir(exist_ok=True)
    LOG_DIR.mkdir(exist_ok=True)
    log("starting: port=%d appdir=%s" % (PORT, APP_DIR))

    preflight()

    threading.Thread(target=worker_loop, daemon=True).start()

    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        log("bind failed: %s" % exc)
        raise SystemExit(
            "\n  The helper could not open port %d.\n"
            "\n  %s\n"
            "\n  Edit config.json in this folder and change \"port\" to a\n"
            "  different number (for example 8766), then try again.\n"
            % (PORT, exc))
    url = "http://%s:%d/?token=%s" % (HOST, PORT, TOKEN)
    print("")
    print("  Amazon cash planner — local worker")
    print("  " + "-" * 52)
    print("  App and API:  http://%s:%d" % (HOST, PORT))
    print("  Open this:    %s" % url)
    print("")
    print("  The token keeps other pages in your browser from driving this")
    print("  worker. It changes each time you start it unless you set")
    print("  FBA_WORKER_TOKEN.")
    print("")
    print("  Downloads:    %s" % DOWNLOAD_DIR)
    print("  Browser data: %s   (your Amazon session; not shared)" % PROFILE_DIR)
    print("")
    print("  Ctrl+C to stop. Nothing runs while this process is stopped.")
    print("")
    print("  A log of this session is written to:")
    print("  %s" % LOG_PATH)
    print("")
    log("listening on http://%s:%d" % (HOST, PORT))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("stopped by user")
        print("\n  stopped.\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        # A deliberate, explained stop. Show it and hold the window open so a
        # minimised launcher does not swallow the only useful message.
        msg = str(exc)
        if msg and msg != "0":
            print(msg)
            log("stopped: " + msg.strip().replace("\n", " | "))
        try:
            input("  Press Enter to close this window. ")
        except Exception:
            pass
        raise
    except Exception as exc:                          # noqa: BLE001
        import traceback
        detail = traceback.format_exc()
        log("CRASH: " + detail.replace("\n", " | "))
        print("\n  The helper stopped because of an unexpected error:\n")
        print("  " + str(exc))
        print("\n  The full detail was written to:")
        print("  %s" % LOG_PATH)
        print("\n  Run DIAGNOSE in this folder and send the file it makes.\n")
        try:
            input("  Press Enter to close this window. ")
        except Exception:
            pass
        raise
