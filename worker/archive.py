"""Every report ever downloaded, kept in one file.

WHY THIS EXISTS

Until now a report existed in two fragile places: a CSV in worker/downloads
that is deleted once it has been imported, and parsed rows in whichever
browser happened to do the importing. Open the app in a different browser and
it showed "Nothing imported yet" over a job that said it imported 208 rows.
Delete the file and last month's figures were gone for good. There was no way
to ask what fees looked like in August.

This is the third place, and the durable one: one SQLite file that outlives
the CSV, the browser and the machine's choice of browser profile.

WHAT IT DOES NOT DO

It does not parse financial data. The worker has never had a CSV parser and
must not grow one - two parsers means the archive and the app can disagree
about the same file, and then neither can be trusted. So:

    the helper  records the REPORT: where it came from, when, its hash
    the app     parses the file, and pushes back the rows it decided on

One parser, and the archive holds exactly what the app believes.

SHAPE

Rows carry their own UUIDs rather than autoincrement integers, and every table
carries updated_at. Neither is needed today. Both are needed the moment these
rows are mirrored somewhere else, and retrofitting identity onto rows that
already exist is a great deal harder than starting with it.

Nothing here raises into the caller. An archive that fails to write must never
be the reason a download fails to import - it is a record of the work, not the
work.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS reports (
  report_id       TEXT PRIMARY KEY,
  job_id          TEXT,
  report_type     TEXT NOT NULL,
  marketplace     TEXT,
  date_range      TEXT,
  period_start    TEXT,
  period_end      TEXT,
  requested_at    TEXT,
  downloaded_at   TEXT NOT NULL,
  tag             TEXT,
  file_name       TEXT,
  content_hash    TEXT UNIQUE,
  byte_size       INTEGER,
  row_count       INTEGER,
  option_groups   TEXT,
  missing_groups  TEXT,
  -- Money below is an integer scaled by 10^money_scale. Recorded per
  -- report so a future change of scale is detectable rather than a
  -- silent factor-of-ten error in somebody's fees.
  money_scale     INTEGER,
  rows_stored     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- The app's state document. One row, normally: doc_id 'state'.
CREATE TABLE IF NOT EXISTS app_state (
  doc_id      TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

-- Each saved revision, kept. A document this small (a few hundred KB) is worth
-- far less than the ability to say what it looked like before a save that
-- turned out to be wrong.
CREATE TABLE IF NOT EXISTS app_state_history (
  doc_id      TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (doc_id, revision)
);

CREATE TABLE IF NOT EXISTS report_rows (
  row_id          TEXT PRIMARY KEY,
  report_id       TEXT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  marketplace     TEXT,
  msku            TEXT,
  asin            TEXT,
  parent_asin     TEXT,
  fnsku           TEXT,
  period_start    TEXT,
  period_end      TEXT,
  currency        TEXT,
  -- Counts. Whole things, so a plain number is honest.
  units_sold      INTEGER,
  units_returned  INTEGER,
  net_units       INTEGER,
  -- Money. Scaled integers at the report's money_scale: 9551.4733333297 is
  -- stored as 95514733333297, not as a double that is nearly that.
  avg_price_scaled  INTEGER,
  sales_scaled      INTEGER,
  net_sales_scaled  INTEGER,
  source_line     INTEGER,
  -- The app's complete row, verbatim. Amazon's exports have carried 20, 50 and
  -- 53 columns in one week; a fixed set of typed columns would either break on
  -- a new one or drop it silently. The columns above are the ones worth
  -- querying; this is everything, so nothing is ever lost.
  raw             TEXT NOT NULL,
  created_at      TEXT NOT NULL
);

-- The same bytes can arrive from more than one job: ask for the same period
-- twice and Amazon may hand back an identical file. That is ONE report, but
-- deleting either job must not take the other's history with it.
CREATE TABLE IF NOT EXISTS report_jobs (
  report_id  TEXT NOT NULL REFERENCES reports(report_id) ON DELETE CASCADE,
  job_id     TEXT NOT NULL,
  linked_at  TEXT NOT NULL,
  PRIMARY KEY (report_id, job_id)
);
CREATE INDEX IF NOT EXISTS report_jobs_job ON report_jobs (job_id);

CREATE INDEX IF NOT EXISTS report_rows_key
  ON report_rows (marketplace, msku, period_start, period_end);
CREATE INDEX IF NOT EXISTS report_rows_report ON report_rows (report_id);
CREATE INDEX IF NOT EXISTS reports_period ON reports (period_start, period_end);
CREATE INDEX IF NOT EXISTS reports_job ON reports (job_id);

-- Overlapping reports are KEPT, never overwritten: asking for 23 Sep - 5 Oct
-- and then 23 Sep - 17 Nov gives two readings of the same days, and throwing
-- one away would be throwing away evidence. This picks the most recent reading
-- of each SKU-period, so double counting is impossible by construction rather
-- than by remembering to filter.
CREATE VIEW IF NOT EXISTS current_report_rows AS
SELECT * FROM (
  SELECT r.*, rep.downloaded_at AS report_downloaded_at,
         ROW_NUMBER() OVER (
           PARTITION BY r.marketplace, r.msku, r.period_start, r.period_end
           ORDER BY rep.downloaded_at DESC, r.row_id
         ) AS recency
  FROM report_rows r
  JOIN reports rep ON rep.report_id = r.report_id
)
WHERE recency = 1;
"""


def connect(path: Path) -> sqlite3.Connection:
    """Open the archive, creating it if this is the first time."""
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    db.row_factory = sqlite3.Row
    # WAL so a read while the worker is writing does not block, and a crash
    # mid-write leaves the file readable rather than truncated.
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA)
    have = db.execute("SELECT version FROM schema_version").fetchone()
    if have is None:
        db.execute("INSERT INTO schema_version (version) VALUES (?)",
                   (SCHEMA_VERSION,))
    return db


def _count(value):
    """A whole count, or nothing. Never 0 standing in for "we do not know"."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _scaled(value):
    """An exact money value as its scaled integer, or nothing.

    Arrives as {"$dec": "95514733333297"} - the app's BigInt, tagged so it
    cannot be mistaken for a number that has already lost precision. A bare
    number is accepted too, but only because refusing it would drop real data;
    it means something upstream stopped sending exact values and that is worth
    finding rather than hiding.
    """
    if value is None or value == "":
        return None
    if isinstance(value, dict):
        raw = value.get("$dec")
        try:
            return int(raw) if raw is not None else None
        except (TypeError, ValueError):
            return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def record_report(path: Path, job: dict, present=None, absent=None,
                  content_hash: str | None = None,
                  money_scale: int | None = None) -> str | None:
    """Record that this report exists. Returns its id, or None if it could not.

    The same file recorded twice keeps its first id: re-importing a report is
    not a new report, and the archive should not grow a duplicate every time
    someone presses Retry.
    """
    try:
        with _LOCK:
            db = connect(path)
            try:
                digest = content_hash or file_hash(job.get("filePath"))
                existing = None
                if digest:
                    existing = db.execute(
                        "SELECT report_id FROM reports WHERE content_hash = ?",
                        (digest,)).fetchone()

                report_id = existing["report_id"] if existing else _new_id()
                now = _now()
                f = Path(job["filePath"]) if job.get("filePath") else None
                size = f.stat().st_size if (f and f.is_file()) else None

                db.execute("""
                    INSERT INTO reports (
                      report_id, job_id, report_type, marketplace, date_range,
                      period_start, period_end, requested_at, downloaded_at,
                      tag, file_name, content_hash, byte_size, row_count,
                      option_groups, missing_groups, money_scale,
                      created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(report_id) DO UPDATE SET
                      job_id=excluded.job_id,
                      marketplace=excluded.marketplace,
                      period_start=excluded.period_start,
                      period_end=excluded.period_end,
                      row_count=excluded.row_count,
                      option_groups=excluded.option_groups,
                      missing_groups=excluded.missing_groups,
                      money_scale=COALESCE(excluded.money_scale, reports.money_scale),
                      updated_at=excluded.updated_at
                """, (
                    report_id, job.get("jobId"), job.get("reportType") or "unknown",
                    job.get("marketplace"), job.get("dateRange"),
                    job.get("coverageFrom") or job.get("requestedFrom"),
                    job.get("coverageTo") or job.get("requestedTo"),
                    job.get("queuedAt"), job.get("finishedAt") or now,
                    job.get("reportTag"), job.get("fileName"),
                    digest, size, job.get("rowCount"),
                    json.dumps(present or []), json.dumps(absent or []),
                    money_scale,
                    now, now,
                ))
                if job.get("jobId"):
                    db.execute(
                        "INSERT OR IGNORE INTO report_jobs "
                        "(report_id, job_id, linked_at) VALUES (?,?,?)",
                        (report_id, job["jobId"], now))
                return report_id
            finally:
                db.close()
    except Exception:
        return None                 # a record of the work, never the work


def record_rows(path: Path, report_id: str, rows: list[dict],
                money_scale: int | None = None) -> int:
    """Store the rows the APP parsed out of this report. Returns how many.

    Replaces whatever was there for this report, so importing the same file
    again corrects the archive rather than doubling it.
    """
    try:
        with _LOCK:
            db = connect(path)
            try:
                if not db.execute("SELECT 1 FROM reports WHERE report_id = ?",
                                  (report_id,)).fetchone():
                    return 0        # no such report; refuse to orphan rows

                now = _now()
                db.execute("BEGIN")
                db.execute("DELETE FROM report_rows WHERE report_id = ?",
                           (report_id,))
                db.executemany("""
                    INSERT INTO report_rows (
                      row_id, report_id, marketplace, msku, asin, parent_asin,
                      fnsku, period_start, period_end, currency,
                      units_sold, units_returned, net_units,
                      avg_price_scaled, sales_scaled, net_sales_scaled,
                      source_line, raw, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, [(
                    _new_id(), report_id,
                    r.get("store") or r.get("marketplace"),
                    r.get("msku"), r.get("asin"), r.get("parentAsin"),
                    r.get("fnsku"), r.get("start"), r.get("end"),
                    r.get("currency"),
                    _count(r.get("unitsSold")), _count(r.get("unitsReturned")),
                    _count(r.get("netUnits")),
                    _scaled(r.get("avgPrice")), _scaled(r.get("sales")),
                    _scaled(r.get("netSales")),
                    r.get("sourceLine"),
                    # Stored exactly as it arrived, tags and all, so the exact
                    # value can always be rebuilt even for a column with no
                    # dedicated place above.
                    json.dumps(r, separators=(",", ":")), now,
                ) for r in rows])
                db.execute(
                    "UPDATE reports SET rows_stored = ?, updated_at = ?, "
                    "money_scale = COALESCE(?, money_scale) "
                    "WHERE report_id = ?",
                    (len(rows), now, money_scale, report_id))
                db.execute("COMMIT")
                return len(rows)
            finally:
                db.close()
    except Exception:
        return 0


def forget_report(path: Path, job_id: str) -> bool:
    """Unlink a job, and forget the report once no job refers to it.

    Delete means delete - but only of what that job actually owns. Two jobs
    can share one archived report when Amazon hands back identical bytes, and
    deleting one of them must not take the other's history away.
    """
    try:
        with _LOCK:
            db = connect(path)
            try:
                linked = [r["report_id"] for r in db.execute(
                    "SELECT report_id FROM report_jobs WHERE job_id = ?",
                    (job_id,))]
                db.execute("BEGIN")
                db.execute("DELETE FROM report_jobs WHERE job_id = ?", (job_id,))

                removed = 0
                for report_id in linked:
                    still = db.execute(
                        "SELECT COUNT(*) FROM report_jobs WHERE report_id = ?",
                        (report_id,)).fetchone()[0]
                    if not still:
                        db.execute("DELETE FROM reports WHERE report_id = ?",
                                   (report_id,))
                        removed += 1

                if not linked:
                    # A report recorded without a job id to link, or one from
                    # before this table existed. Its own column is the only
                    # thing pointing at it.
                    cur = db.execute(
                        "DELETE FROM reports WHERE job_id = ? AND report_id "
                        "NOT IN (SELECT report_id FROM report_jobs)", (job_id,))
                    removed += cur.rowcount

                db.execute("COMMIT")
                return removed > 0
            finally:
                db.close()
    except Exception:
        return False


def jobs_for_report(path: Path, report_id: str) -> list[str]:
    """Which jobs produced this report. More than one is normal."""
    try:
        with _LOCK:
            db = connect(path)
            try:
                return [r["job_id"] for r in db.execute(
                    "SELECT job_id FROM report_jobs WHERE report_id = ? "
                    "ORDER BY linked_at", (report_id,))]
            finally:
                db.close()
    except Exception:
        return []


def file_hash(file_path) -> str | None:
    """Content hash, so the same file is never recorded as two reports."""
    import hashlib
    if not file_path:
        return None
    f = Path(file_path)
    if not f.is_file():
        return None
    try:
        h = hashlib.sha256()
        with f.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


HISTORY_KEPT = 30


def read_state(path: Path, doc_id: str = "state") -> dict:
    """The current document, or an empty one at revision 0."""
    try:
        with _LOCK:
            db = connect(path)
            try:
                row = db.execute(
                    "SELECT revision, body, updated_at, updated_by FROM "
                    "app_state WHERE doc_id = ?", (doc_id,)).fetchone()
                if not row:
                    return {"revision": 0, "body": None, "updatedAt": None}
                return {"revision": row["revision"],
                        "body": json.loads(row["body"]),
                        "updatedAt": row["updated_at"],
                        "updatedBy": row["updated_by"]}
            finally:
                db.close()
    except Exception as exc:
        return {"revision": None, "body": None, "error": str(exc)[:160]}


def write_state(path: Path, body, expected: int, doc_id: str = "state",
                by: str | None = None) -> dict:
    """Save the document, but only on top of the revision the caller read.

    A caller holding an older revision has not seen someone else's save. It is
    told so, and handed what is actually stored, rather than having its own
    copy written over the top as if nothing happened.
    """
    try:
        with _LOCK:
            db = connect(path)
            try:
                db.execute("BEGIN IMMEDIATE")
                row = db.execute(
                    "SELECT revision, body FROM app_state WHERE doc_id = ?",
                    (doc_id,)).fetchone()
                current = row["revision"] if row else 0

                if expected != current:
                    db.execute("ROLLBACK")
                    return {"ok": False, "conflict": True,
                            "revision": current,
                            "body": json.loads(row["body"]) if row else None}

                nxt = current + 1
                now = _now()
                blob = json.dumps(body, separators=(",", ":"))
                db.execute(
                    "INSERT INTO app_state (doc_id, revision, body, updated_at,"
                    " updated_by) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(doc_id) DO UPDATE SET revision=excluded.revision,"
                    " body=excluded.body, updated_at=excluded.updated_at,"
                    " updated_by=excluded.updated_by",
                    (doc_id, nxt, blob, now, by))
                db.execute(
                    "INSERT OR REPLACE INTO app_state_history "
                    "(doc_id, revision, body, updated_at, updated_by) "
                    "VALUES (?,?,?,?,?)", (doc_id, nxt, blob, now, by))
                db.execute(
                    "DELETE FROM app_state_history WHERE doc_id = ? AND "
                    "revision <= ?", (doc_id, nxt - HISTORY_KEPT))
                db.execute("COMMIT")
                return {"ok": True, "revision": nxt, "bytes": len(blob)}
            finally:
                db.close()
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:160]}


def state_history(path: Path, doc_id: str = "state") -> list[dict]:
    """What was saved, and when. Bodies are not included; this is a list."""
    try:
        with _LOCK:
            db = connect(path)
            try:
                return [{"revision": r["revision"], "updatedAt": r["updated_at"],
                         "updatedBy": r["updated_by"], "bytes": len(r["body"])}
                        for r in db.execute(
                            "SELECT revision, updated_at, updated_by, body FROM "
                            "app_state_history WHERE doc_id = ? "
                            "ORDER BY revision DESC", (doc_id,))]
            finally:
                db.close()
    except Exception:
        return []


def summary(path: Path) -> dict:
    """What the archive holds, for showing rather than guessing."""
    empty = {"reports": 0, "rows": 0, "earliest": None, "latest": None,
             "bytes": 0, "available": False}
    if not Path(path).exists():
        return empty
    try:
        with _LOCK:
            db = connect(path)
            try:
                r = db.execute(
                    "SELECT COUNT(*) n, MIN(period_start) a, MAX(period_end) b "
                    "FROM reports").fetchone()
                rows = db.execute("SELECT COUNT(*) n FROM report_rows").fetchone()
                return {
                    "reports": r["n"], "rows": rows["n"],
                    "earliest": r["a"], "latest": r["b"],
                    "bytes": Path(path).stat().st_size,
                    "available": True,
                }
            finally:
                db.close()
    except Exception:
        return empty
