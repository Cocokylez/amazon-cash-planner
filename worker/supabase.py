"""The mirror: a read-only copy of this machine's figures, somewhere else.

WHY IT IS SHAPED THIS WAY

SQLite stays the source of truth. The worker can only run where the Amazon
session lives, so there is a local component no matter what, and making a
hosted database primary would buy nothing while costing an app that stops
working when the internet does.

So the mirror is PUSH-ONLY. This computer writes; a phone or a laptop reads.
That is not a limitation to apologise for - it is what removes the hard part.
Only one place ever writes, so there are no conflicts to resolve, and the
"last write wins and silently loses an edit" failure cannot happen at all.

CREDENTIALS

Not embedded in the installer. They are pasted once, here, and kept in a file
this program never packages and never commits. An installer carrying a key
would put that key in every copy anyone downloads, and rotating it would mean
rebuilding rather than editing a file.

WHAT IS NEVER CLAIMED

"Connected" is only ever said after a request actually succeeded and came back
recognisable. A saved URL is not a connection, a well-formed key is not a
connection, and neither is the absence of an error.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from pathlib import Path

import secretbox

CONFIG_NAME = "supabase.json"

# A request that has not answered in this long is not going to. The app must
# never sit waiting on a mirror: it is a copy, not the work.
TIMEOUT_S = 10


def _read(here: Path) -> dict:
    """The stored settings, with secrets decrypted.

    Anything still in plain text is re-written protected on the way past, so
    an existing install is upgraded the first time it is read rather than
    needing the keys pasted again.
    """
    p = config_path(here)
    if not p.is_file():
        return {}
    try:
        raw = json.loads(p.read_text("utf-8"))
    except Exception:
        return {}

    bare = False
    for field in ("key", "writeKey"):
        val = raw.get(field) or ""
        if not val:
            continue
        if secretbox.is_protected(val):
            raw[field] = secretbox.unprotect(val)
        else:
            bare = True

    if bare and secretbox.available():
        try:
            _write(here, raw)
        except Exception:
            pass  # Readable either way; it will be tried again next time.
    return raw


def _write(here: Path, data: dict) -> None:
    """Store the settings, protecting the secrets on the way in."""
    out = dict(data)
    for field in ("key", "writeKey"):
        if out.get(field):
            out[field] = secretbox.protect(out[field])
    config_path(here).write_text(json.dumps(out, indent=2), encoding="utf-8")


def config_path(here: Path) -> Path:
    return here / CONFIG_NAME


def load(here: Path) -> dict:
    """What has been configured, with the key never returned in full."""
    if not config_path(here).is_file():
        return {"configured": False}
    raw = _read(here)

    url = (raw.get("url") or "").strip()
    key = (raw.get("key") or "").strip()
    if not url or not key:
        return {"configured": False}

    write = (raw.get("writeKey") or "").strip()
    return {
        "configured": True,
        "url": url,
        # Enough to recognise which key is in use, never enough to use it.
        "keyHint": _hint(key),
        # The push needs a key that RLS does not apply to. Whether one is
        # present is reported; the key itself is not, on the same terms as
        # the other one.
        "canWrite": bool(write),
        "writeKeyHint": _hint(write) if write else None,
        # Automatic sending after each download. On unless turned off: the
        # point of a copy is that it stays current without being remembered.
        "autoPush": raw.get("autoPush") is not False,
        "lastTestedAt": raw.get("lastTestedAt"),
        "lastResult": raw.get("lastResult"),
        # What is actually protecting these on disk. Stated, never assumed:
        # a security measure that quietly did nothing would be worse than
        # none at all.
        "atRest": secretbox.say_state(),
        "encrypted": secretbox.available(),
    }


def _hint(key: str) -> str:
    """Enough of a key to recognise which one it is. Never enough to use."""
    key = (key or "").strip()
    if not key:
        return ""
    return key[:6] + "…" + key[-4:] if len(key) > 12 else "set"


def _secret(here: Path) -> tuple[str, str] | None:
    raw = _read(here)
    url = (raw.get("url") or "").strip().rstrip("/")
    key = (raw.get("key") or "").strip()
    return (url, key) if url and key else None


def check_shape(url: str, key: str) -> str | None:
    """Obvious mistakes, caught before anything is sent anywhere.

    Not validation theatre: each of these is a real thing people paste. Saying
    which one it is beats a network error that means nothing.
    """
    url = (url or "").strip()
    key = (key or "").strip()

    if not url:
        return "The project URL is empty."
    if not url.startswith("https://"):
        return ("The project URL must start with https:// - it is the address "
                "Supabase shows as 'Project URL'.")
    if " " in url:
        return "The project URL has a space in it."

    # The dashboard address instead of the project's own.
    #
    # This is the easiest field in the app to get wrong, because the page
    # somebody copies from IS the dashboard - the address bar is right there
    # and it looks like a project URL. It is not: it is the website that shows
    # you the project, and no API call will ever work against it.
    #
    # The project ref is sitting inside it, so the correct URL can be handed
    # back exactly rather than described in the abstract.
    ref = re.search(r"supabase\.(?:com|co|green)/dashboard/project/([A-Za-z0-9]+)",
                    url)
    if ref:
        return ("That is the dashboard address - the page you are looking at, "
                "not the project itself. Yours is "
                "https://%s.supabase.co" % ref.group(1))
    if "/dashboard" in url or re.match(r"^https://(www\.)?supabase\.(com|io)/?$", url):
        return ("That is the Supabase website, not your project. The Project "
                "URL looks like https://yourproject.supabase.co and is shown "
                "under Project Settings > API.")
    if not key:
        return "The key is empty."
    if key.startswith("http"):
        return "That looks like a URL, not a key. The two fields are swapped."
    if len(key) < 30:
        return ("That key looks too short. Copy the whole value - they are "
                "long.")

    # The secret key, in BOTH shapes Supabase has used.
    #
    # Older projects issue JWTs, where the role is in the payload. Newer ones
    # issue sb_publishable_... and sb_secret_..., which are not JWTs at all -
    # so decoding was the only check, and a modern secret key sailed straight
    # through it. Either one hands full read and write to anything holding it.
    if key.startswith("sb_secret_") or key.startswith("service_role"):
        return ("That is the secret key, which ignores every access rule in "
                "the project. Use the publishable key instead - it starts "
                "with sb_publishable_.")
    if re.search(r'"role"\s*:\s*"service_role"', _peek(key) or ""):
        return ("That is the service_role key, which bypasses every access "
                "rule in the project. Use the anon key here instead - it is "
                "the one labelled anon public.")
    return None


def _peek(jwt: str) -> str | None:
    """The middle of a JWT, decoded. Used only to tell key types apart."""
    import base64
    try:
        part = jwt.split(".")[1]
        part += "=" * (-len(part) % 4)
        return base64.urlsafe_b64decode(part).decode("utf-8", "replace")
    except Exception:
        return None


def _not_a_database(res, body: str) -> str | None:
    """Did a database answer, or merely *something*?

    A 200 proves nothing. Paste the dashboard address here and the request
    lands on Supabase's own website: it redirects, serves its single-page app
    from Vercel with status 200 and text/html, and a status-code check calls
    that "a real connection, not a saved setting". It is a web page. That
    false success is exactly what this module exists to refuse, so the reply
    now has to look like the thing it claims to be.

    PostgREST names itself in the Server header and answers in JSON either
    way: the project root returns its OpenAPI document, and a key it dislikes
    returns a JSON error (handled above as the failure it is). HTML is never
    a database.
    """
    server = (res.headers.get("server") or "").lower()
    ctype = (res.headers.get("content-type") or "").lower()

    if "postgrest" in server:
        return None
    if "json" in ctype:
        return None
    if "html" in ctype or body.lstrip()[:1] == "<":
        return ("That address answered with a web page, not a database - it "
                "is a website, not a project API endpoint. The Project URL "
                "looks like https://yourproject.supabase.co and is shown "
                "under Project Settings > API. Nothing was connected.")
    return ("That address answered, but not like a Supabase project (it sent "
            "%s). Check the Project URL. Nothing was connected."
            % (ctype or "no content type"))


def is_secret_key(key: str) -> bool:
    """Is this a key that Row Level Security does not apply to?

    Both shapes Supabase has issued: the sb_secret_ prefix on newer projects,
    and a JWT carrying role service_role on older ones.
    """
    key = (key or "").strip()
    if key.startswith("sb_secret_") or key.startswith("service_role"):
        return True
    return bool(re.search(r'"role"\s*:\s*"service_role"', _peek(key) or ""))


def check_write_key(key: str) -> str | None:
    """The key the push writes with - which has to be the privileged one.

    This is the exact key the other field refuses, and for the same reason:
    it ignores every access rule. Here that is the point. The tables are
    locked with no policy, so nothing can read or write them by accident, and
    the one thing permitted to write is a secret that stays on this computer.

    Refusing the publishable key here matters as much as refusing the secret
    one there: pasted in this box it would simply fail on every push, with an
    RLS error that reads like a broken account.
    """
    key = (key or "").strip()
    if not key:
        return "The write key is empty."
    if key.startswith("http"):
        return "That looks like a URL, not a key."
    if len(key) < 30:
        return "That key looks too short. Copy the whole value."
    if not is_secret_key(key):
        return ("That is the publishable key - the one in the box above. "
                "Writing needs the secret key: Project Settings > API, the "
                "one marked secret or service_role. It stays on this "
                "computer and is never sent anywhere but your own project.")
    return None


def save_write_key(here: Path, key: str) -> dict:
    """Store the write key beside the rest. Never packaged, never committed."""
    raw = _read(here)
    raw["writeKey"] = key.strip()
    _write(here, raw)
    return load(here)


def set_auto_push(here: Path, enabled: bool) -> dict:
    """Turn automatic sending on or off. Manual sending is unaffected."""
    raw = _read(here)
    if not raw:
        return load(here)
    raw["autoPush"] = bool(enabled)
    _write(here, raw)
    return load(here)


def forget_write_key(here: Path) -> bool:
    """Drop the write key, keeping the connection. Pushing stops; reading
    settings and testing the connection carry on."""
    if not config_path(here).is_file():
        return False
    raw = _read(here)
    if not raw.pop("writeKey", None):
        return False
    _write(here, raw)
    return True


def _write_secret(here: Path) -> tuple[str, str] | None:
    raw = _read(here)
    url = (raw.get("url") or "").strip().rstrip("/")
    key = (raw.get("writeKey") or "").strip()
    return (url, key) if url and key else None


def is_jwt(key: str) -> bool:
    """Three dot-separated parts with a decodable middle. Not a guess."""
    key = (key or "").strip()
    return key.count(".") == 2 and _peek(key) is not None


def _headers(key: str, bearer: bool) -> dict:
    """The headers for one attempt.

    Authorization: Bearer carries a USER's access token. Supabase's older anon
    keys happened to be JWTs, so putting one there worked by accident and the
    habit stuck. The newer sb_publishable_ keys are not JWTs: the auth layer
    tries to parse one as a token, fails, and rejects the request as "Invalid
    API key" - which reads exactly like a mistyped key and sends people off to
    copy it again and again. It was never the key.

    apikey alone identifies the project and is always correct.
    """
    h = {"apikey": key.strip(), "Accept": "application/json"}
    if bearer:
        h["Authorization"] = "Bearer " + key.strip()
    return h


def _attempt(endpoint: str, key: str, bearer: bool) -> dict:
    """One request. Reports what came back without deciding what it means."""
    req = urllib.request.Request(endpoint, headers=_headers(key, bearer))
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            return {"status": res.status,
                    "ctype": res.headers.get("content-type") or "",
                    "server": res.headers.get("server") or "",
                    "body": res.read(2048).decode("utf-8", "replace")}
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(512).decode("utf-8", "replace")
        except Exception:
            pass
        return {"status": exc.code, "ctype": exc.headers.get("content-type")
                or "", "server": exc.headers.get("server") or "", "body": body}
    except urllib.error.URLError as exc:
        return {"unreachable":
                "Could not reach %s (%s). Nothing was saved or sent."
                % (endpoint, str(getattr(exc, "reason", exc))[:120])}
    except Exception as exc:
        return {"unreachable": "The connection could not be tested (%s)."
                              % str(exc)[:120]}


class _Reply:
    """What _not_a_database inspects: just the headers, by name."""

    def __init__(self, got):
        self._h = {"server": got.get("server", ""),
                   "content-type": got.get("ctype", "")}

    @property
    def headers(self):
        return self

    def get(self, name, default=None):
        return self._h.get(str(name).lower(), default)


# What the connection test asks for.
#
# NOT "/rest/v1/". That is PostgREST's OpenAPI root, and Supabase restricts it
# to secret keys: a publishable key gets 401 "Secret API key required" there,
# always, no matter how correct it is. Testing against it meant the one key
# people are told to paste was the one key guaranteed to fail.
#
# A real table is the honest question anyway - it is what the mirror will
# actually do, and Row Level Security answers it with an empty list rather
# than an error, so a locked table still proves the connection.
PROBE_TABLE = "reports"
PROBE = "/rest/v1/" + PROBE_TABLE + "?select=report_id&limit=1"


def test(url: str, key: str) -> dict:
    """Actually talk to the project. This is the only thing that proves it.

    Returns {ok, detail, needsSchema} - and ok is True only when a request
    went out and came back from a database.
    """
    problem = check_shape(url, key)
    if problem:
        return {"ok": False, "detail": problem}

    key = key.strip()
    endpoint = url.strip().rstrip("/") + PROBE

    # The right header shape for this kind of key first, then the other one.
    # Both are tried rather than assumed: being wrong there produces "Invalid
    # API key", a message that blames the key and hides the cause.
    got = None
    for bearer in (is_jwt(key), not is_jwt(key)):
        got = _attempt(endpoint, key, bearer)
        if got.get("unreachable"):
            return {"ok": False, "detail": got["unreachable"]}
        if got["status"] < 400:
            break

    if got["status"] < 400:
        wrong = _not_a_database(_Reply(got), got["body"])
        if wrong:
            return {"ok": False, "detail": wrong}
        return {"ok": True, "needsSchema": False, "detail":
                "The project answered. This is a real connection, not a "
                "saved setting."}

    code, body = got["status"], got["body"]
    said = ""
    try:
        said = (json.loads(body) or {}).get("message") or ""
    except Exception:
        said = body[:160]

    # The tables are not there yet. The credentials are fine - this answer
    # could only have come from the project - so this is a connection, with
    # one thing left to do. Reporting it as a failure would send somebody off
    # to re-copy a key that was never wrong.
    if code == 404 or "PGRST205" in body or "Could not find the table" in body:
        return {"ok": True, "needsSchema": True, "detail":
                "Connected - the project answered. Its tables are not there "
                "yet: run the setup SQL below in Supabase > SQL Editor, then "
                "figures can be sent."}

    if code in (401, 403):
        shape = "%d characters, starts %s" % (len(key), key[:15] or "?")
        return {"ok": False, "detail":
                "The project rejected that key (%d)%s You sent %s. Copy it "
                "with the button beside the key in Project Settings > API "
                "Keys - selecting the masked text gives a cut-off key that "
                "looks right."
                % (code, (": " + said + ".") if said else ".", shape)}
    return {"ok": False, "detail":
            "The project answered with %d. %s" % (code, body[:160])}


def save(here: Path, url: str, key: str, result: dict) -> dict:
    """Store the credentials, together with what the test actually found.

    The result is written alongside them so the app can say "tested at 10:42
    and it worked" rather than "configured", which says nothing about whether
    it works.
    """
    from datetime import datetime, timezone
    keep = _read(here)
    _write(here, {
        "url": url.strip().rstrip("/"),
        "key": key.strip(),
        # A write key already granted is not revoked by re-testing the
        # connection: they are two separate decisions.
        "writeKey": keep.get("writeKey") or "",
        "lastTestedAt": datetime.now(timezone.utc).isoformat(),
        "lastResult": {"ok": bool(result.get("ok")),
                       "detail": result.get("detail")},
    })
    return load(here)


def forget(here: Path) -> bool:
    """Remove the credentials. Nothing already mirrored is touched."""
    p = config_path(here)
    if not p.is_file():
        return False
    try:
        p.unlink()
        return True
    except Exception:
        return False


# The tables the mirror needs, as SQL to paste into Supabase's editor.
#
# Row Level Security is ON and there is no permissive policy: with the anon
# key alone nobody can read or write anything. That is deliberate - the policy
# that opens it up is written once the sign-in shape is decided, and an
# open-by-default table holding somebody's fee data is not a state to pass
# through on the way there.
SCHEMA_SQL = """-- Amazon Cash Planner: the mirror.
-- Paste this into Supabase > SQL Editor > New query > Run.

create table if not exists reports (
  report_id      text primary key,
  report_type    text,
  marketplace    text,
  date_range     text,
  period_start   date,
  period_end     date,
  downloaded_at  timestamptz,
  row_count      integer,
  option_groups  jsonb,
  money_scale    integer,
  mirrored_at    timestamptz not null default now()
);

create table if not exists report_rows (
  row_id            text primary key,
  report_id         text not null references reports(report_id) on delete cascade,
  marketplace       text,
  msku              text,
  asin              text,
  period_start      date,
  period_end        date,
  currency          text,
  -- Counts. Whole things, so a plain integer is honest.
  units_sold        integer,
  units_returned    integer,
  net_units         integer,
  -- Money is a scaled integer, at the report's money_scale. 9551.4733333297
  -- is stored as 95514733333297, never as a float that is nearly that.
  avg_price_scaled  bigint,
  sales_scaled      bigint,
  net_sales_scaled  bigint,
  source_line       integer,
  -- The complete original row. Amazon's exports have carried 20, 50 and 53
  -- columns in one week; the typed columns above are the ones worth querying,
  -- this is everything, so nothing is lost.
  raw               jsonb not null
);

create index if not exists report_rows_key
  on report_rows (marketplace, msku, period_start, period_end);
create index if not exists report_rows_report on report_rows (report_id);

-- Locked by default: RLS on, and no policy at all. Nothing can read or write
-- these tables with the publishable key until a policy is added deliberately.
-- An open table holding somebody's fee data is not a state to pass through on
-- the way to getting the policies right.
alter table reports enable row level security;
alter table report_rows enable row level security;
"""
# ---------------------------------------------------------------------------
# The push itself.
# ---------------------------------------------------------------------------

# Rows per request. Amazon reports run to thousands of lines and each carries
# its verbatim original, so one request per report would be a several-megabyte
# POST that fails as a whole. Small enough to retry cheaply, large enough that
# a big report is not a thousand round trips.
BATCH = 250

# Longer than TIMEOUT_S: a credential check should give up quickly, but an
# upload of real data deserves the time it actually takes.
PUSH_TIMEOUT_S = 60


def _date(value):
    """An ISO date, or nothing. Postgres rejects '' where it accepts null."""
    v = (value or "").strip()
    return v or None


def _json_col(value):
    """A TEXT column holding JSON, handed over as JSON rather than as a string.

    Posting the string would store a quoted blob in a jsonb column - readable,
    but not queryable, which defeats the column's whole purpose.
    """
    if value in (None, ""):
        return None
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        # Not JSON after all. Keep it rather than drop it; something upstream
        # changed and silently losing it would hide that.
        return {"unparsed": str(value)[:4000]}


def _report_payload(r: dict) -> dict:
    return {
        "report_id": r.get("report_id"),
        "report_type": r.get("report_type"),
        "marketplace": r.get("marketplace"),
        "date_range": r.get("date_range"),
        "period_start": _date(r.get("period_start")),
        "period_end": _date(r.get("period_end")),
        "downloaded_at": r.get("downloaded_at"),
        "row_count": r.get("row_count"),
        "option_groups": _json_col(r.get("option_groups")),
        "money_scale": r.get("money_scale"),
    }


def _row_payload(r: dict) -> dict:
    return {
        "row_id": r.get("row_id"),
        "report_id": r.get("report_id"),
        "marketplace": r.get("marketplace"),
        "msku": r.get("msku"),
        "asin": r.get("asin"),
        "period_start": _date(r.get("period_start")),
        "period_end": _date(r.get("period_end")),
        "currency": r.get("currency"),
        "units_sold": r.get("units_sold"),
        "units_returned": r.get("units_returned"),
        "net_units": r.get("net_units"),
        # Money stays an integer the whole way. A float here would undo the
        # entire point of storing it scaled.
        "avg_price_scaled": r.get("avg_price_scaled"),
        "sales_scaled": r.get("sales_scaled"),
        "net_sales_scaled": r.get("net_sales_scaled"),
        "source_line": r.get("source_line"),
        "raw": _json_col(r.get("raw")),
    }


def _explain_write_failure(table: str, code: int, detail: str) -> str:
    """Turn PostgREST's answer into something that names the actual fix.

    The two failures that will actually happen are a missing table (the schema
    was never run) and Row Level Security refusing the write (it is on, with
    no policy, by design). Both are an opaque 4xx otherwise.
    """
    low = (detail or "").lower()

    if "row-level security" in low or "42501" in low:
        return ("The project refused the write: Row Level Security is on for "
                "'%s' and no policy lets this key write. That is the schema's "
                "default and it is deliberate - nothing is wrong with your "
                "key. Run the 'Letting this computer write' part of the setup "
                "SQL." % table)
    if "does not exist" in low or code == 404:
        return ("The table '%s' is not in the project yet. Run the setup SQL "
                "from this panel in Supabase > SQL Editor first." % table)
    if "column" in low and ("schema cache" in low or "does not exist" in low):
        return ("The '%s' table in the project does not match what this "
                "version sends (%s). Re-run the setup SQL from this panel."
                % (table, detail[:120]))
    if code in (401, 403):
        return ("The project rejected the key when writing to '%s' (%d). %s"
                % (table, code, detail[:160]))
    return "Writing to '%s' failed (%d). %s" % (table, code, detail[:200])


def _upsert(url: str, key: str, table: str, payload: list) -> str | None:
    """Send one batch. Returns None on success, or why it failed.

    merge-duplicates makes this an upsert on the primary key, so sending the
    same report twice corrects the copy rather than failing on it - which is
    what makes a half-finished push safe to simply run again.
    """
    if not payload:
        return None
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/" + table,
        data=body, method="POST",
        # Same header rule as the connection test, for the same reason: a
        # non-JWT key in Authorization is rejected as an invalid token.
        headers=dict(_headers(key, is_jwt(key)), **{
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }))
    try:
        with urllib.request.urlopen(req, timeout=PUSH_TIMEOUT_S) as res:
            if res.status < 300:
                return None
            return "%s answered with %d" % (table, res.status)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read(1000).decode("utf-8", "replace")
        except Exception:
            pass
        return _explain_write_failure(table, exc.code, detail)
    except urllib.error.URLError as exc:
        return ("Could not reach the project (%s). Nothing further was sent."
                % str(getattr(exc, "reason", exc))[:120])
    except Exception as exc:
        return "The upload failed (%s)." % str(exc)[:160]


def push(here: Path, db_path: Path, archive=None, log=None) -> dict:
    """Send everything the mirror does not already have.

    Returns {ok, reports, rows, detail} - and ok is True only when every batch
    was accepted. A partial push is reported as a failure carrying the count
    that did land, because "3 of 11 reports" is the useful thing to know and
    "finished" would be a lie.
    """
    if archive is None:
        import archive as archive_mod
        archive = archive_mod

    if not _secret(here):
        return {"ok": False, "reports": 0, "rows": 0,
                "detail": "No project is connected yet."}
    creds = _write_secret(here)
    if not creds:
        return {"ok": False, "reports": 0, "rows": 0,
                "detail": "Connected, but nothing may write yet. The tables "
                          "are locked and the push needs the project's secret "
                          "key, which stays on this computer. Add it in the "
                          "mirror panel."}
    url, key = creds

    try:
        pending = archive.pending_reports(db_path)
    except Exception as exc:
        return {"ok": False, "reports": 0, "rows": 0,
                "detail": "The local archive could not be read (%s)."
                          % str(exc)[:120]}

    if not pending:
        return {"ok": True, "reports": 0, "rows": 0,
                "detail": "The mirror already has every report. Nothing to "
                          "send."}

    sent_reports = 0
    sent_rows = 0
    for rep in pending:
        rid = rep.get("report_id")
        problem = _upsert(url, key, "reports", [_report_payload(rep)])
        if problem:
            return {"ok": False, "reports": sent_reports, "rows": sent_rows,
                    "detail": problem}

        rows = archive.rows_for_report(db_path, rid)
        for i in range(0, len(rows), BATCH):
            chunk = [_row_payload(r) for r in rows[i:i + BATCH]]
            problem = _upsert(url, key, "report_rows", chunk)
            if problem:
                # The report landed and some of its lines did. Deliberately
                # NOT marked as pushed, so the next run sends it again in full
                # rather than leaving half a report that looks complete.
                return {"ok": False, "reports": sent_reports,
                        "rows": sent_rows, "detail": problem}
            sent_rows += len(chunk)
            if log:
                log("mirror: %s %d/%d rows"
                    % (rid, min(i + BATCH, len(rows)), len(rows)))

        archive.mark_pushed(db_path, rid, rep.get("updated_at"),
                            rep.get("rows_stored"))
        sent_reports += 1

    return {"ok": True, "reports": sent_reports, "rows": sent_rows,
            "detail": "Sent %d report%s (%d rows) to the mirror."
                      % (sent_reports, "" if sent_reports == 1 else "s",
                         sent_rows)}


# ---------------------------------------------------------------------------
# Deletions, and the whole sync.
# ---------------------------------------------------------------------------

def _delete_remote(url: str, key: str, report_id: str) -> str | None:
    """Remove one report from the mirror. Its rows go with it (the schema's
    foreign key cascades). A report already absent counts as done: the goal
    is that the mirror does not hold it, and it does not."""
    from urllib.parse import quote
    req = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/reports?report_id=eq." + quote(report_id, safe=""),
        method="DELETE",
        headers=dict(_headers(key, is_jwt(key)), **{"Prefer": "return=minimal"}))
    try:
        with urllib.request.urlopen(req, timeout=PUSH_TIMEOUT_S) as res:
            return None if res.status < 300 else "reports answered with %d" % res.status
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        detail = ""
        try:
            detail = exc.read(1000).decode("utf-8", "replace")
        except Exception:
            pass
        return _explain_write_failure("reports", exc.code, detail)
    except urllib.error.URLError as exc:
        return ("Could not reach the project (%s). Nothing further was sent."
                % str(getattr(exc, "reason", exc))[:120])
    except Exception as exc:
        return "The delete failed (%s)." % str(exc)[:160]


def sync(here: Path, db_path: Path, archive=None, log=None) -> dict:
    """Bring the mirror in line with this computer: deletions first, then
    everything new or changed.

    Deletions go first so a report deleted and re-downloaded is never briefly
    doubled, and so a failed push cannot leave the mirror holding something
    this computer has already let go of.
    """
    if archive is None:
        import archive as archive_mod
        archive = archive_mod
    creds = _write_secret(here)
    if not _secret(here) or not creds:
        return {"ok": False, "reports": 0, "rows": 0, "deleted": 0,
                "detail": "Nothing may write yet - no write key on this computer."}
    url, key = creds

    deleted = 0
    try:
        doomed = archive.pending_deletes(db_path)
    except Exception as exc:
        return {"ok": False, "reports": 0, "rows": 0, "deleted": 0,
                "detail": "The local archive could not be read (%s)." % str(exc)[:120]}
    for rid in doomed:
        problem = _delete_remote(url, key, rid)
        if problem:
            return {"ok": False, "reports": 0, "rows": 0, "deleted": deleted,
                    "detail": problem}
        archive.clear_delete(db_path, rid)
        deleted += 1
        if log:
            log("mirror: deleted %s" % rid)

    result = push(here, db_path, archive=archive, log=log)
    result["deleted"] = deleted
    if deleted:
        result["detail"] = ("Removed %d deleted report%s from the mirror. "
                            % (deleted, "" if deleted == 1 else "s")) + result["detail"]
    return result
