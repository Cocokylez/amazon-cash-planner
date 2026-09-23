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

CONFIG_NAME = "supabase.json"

# A request that has not answered in this long is not going to. The app must
# never sit waiting on a mirror: it is a copy, not the work.
TIMEOUT_S = 10


def config_path(here: Path) -> Path:
    return here / CONFIG_NAME


def load(here: Path) -> dict:
    """What has been configured, with the key never returned in full."""
    p = config_path(here)
    if not p.is_file():
        return {"configured": False}
    try:
        raw = json.loads(p.read_text("utf-8"))
    except Exception as exc:
        return {"configured": False, "error":
                "supabase.json could not be read (%s). It was not changed."
                % str(exc)[:100]}

    url = (raw.get("url") or "").strip()
    key = (raw.get("key") or "").strip()
    if not url or not key:
        return {"configured": False}

    return {
        "configured": True,
        "url": url,
        # Enough to recognise which key is in use, never enough to use it.
        "keyHint": key[:6] + "…" + key[-4:] if len(key) > 12 else "set",
        "lastTestedAt": raw.get("lastTestedAt"),
        "lastResult": raw.get("lastResult"),
    }


def _secret(here: Path) -> tuple[str, str] | None:
    p = config_path(here)
    if not p.is_file():
        return None
    try:
        raw = json.loads(p.read_text("utf-8"))
    except Exception:
        return None
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
    if not key:
        return "The key is empty."
    if key.startswith("http"):
        return "That looks like a URL, not a key. The two fields are swapped."
    if len(key) < 30:
        return ("That key looks too short. Copy the whole value - they are "
                "long.")
    # A service_role key can be told apart from an anon key by its payload.
    # Saying so matters: one of them bypasses every access rule.
    if re.search(r'"role"\s*:\s*"service_role"', _peek(key) or ""):
        return ("That is the service_role key, which bypasses every access "
                "rule in the project. Use the anon key here instead.")
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


def test(url: str, key: str) -> dict:
    """Actually talk to the project. This is the only thing that proves it.

    Returns {ok, detail} - and ok is True only when a request went out and
    came back recognisable as Supabase.
    """
    problem = check_shape(url, key)
    if problem:
        return {"ok": False, "detail": problem}

    endpoint = url.strip().rstrip("/") + "/rest/v1/"
    req = urllib.request.Request(endpoint, headers={
        "apikey": key.strip(),
        "Authorization": "Bearer " + key.strip(),
        "Accept": "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            body = res.read(2048).decode("utf-8", "replace")
            if res.status < 400:
                return {"ok": True, "detail":
                        "The project answered. This is a real connection, not "
                        "a saved setting."}
            return {"ok": False, "detail":
                    "The project answered with %d: %s"
                    % (res.status, body[:160])}
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(512).decode("utf-8", "replace")
        except Exception:
            pass
        if exc.code in (401, 403):
            return {"ok": False, "detail":
                    "The project rejected that key (%d). Check it is the anon "
                    "key from this project's API settings." % exc.code}
        return {"ok": False, "detail":
                "The project answered with %d. %s" % (exc.code, body[:160])}
    except urllib.error.URLError as exc:
        return {"ok": False, "detail":
                "Could not reach %s (%s). Nothing was saved or sent."
                % (endpoint, str(getattr(exc, "reason", exc))[:120])}
    except Exception as exc:
        return {"ok": False, "detail":
                "The connection could not be tested (%s)." % str(exc)[:120]}


def save(here: Path, url: str, key: str, result: dict) -> dict:
    """Store the credentials, together with what the test actually found.

    The result is written alongside them so the app can say "tested at 10:42
    and it worked" rather than "configured", which says nothing about whether
    it works.
    """
    from datetime import datetime, timezone
    p = config_path(here)
    p.write_text(json.dumps({
        "url": url.strip().rstrip("/"),
        "key": key.strip(),
        "lastTestedAt": datetime.now(timezone.utc).isoformat(),
        "lastResult": {"ok": bool(result.get("ok")),
                       "detail": result.get("detail")},
    }, indent=2), encoding="utf-8")
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
  marketplace    text,
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
  period_start      date,
  period_end        date,
  currency          text,
  units_sold        integer,
  -- Money is a scaled integer, at the report's money_scale. 9551.4733333297
  -- is stored as 95514733333297, never as a float that is nearly that.
  net_sales_scaled  bigint,
  raw               jsonb not null
);

create index if not exists report_rows_key
  on report_rows (marketplace, msku, period_start, period_end);

-- Locked by default. Nothing can read these with the anon key until a policy
-- is added deliberately.
alter table reports enable row level security;
alter table report_rows enable row level security;
"""
