"""Where this installation keeps things that are YOURS.

THE PROBLEM THIS SOLVES

Everything the helper builds or is given used to live inside the folder the
app is installed into: the Python environment, the access token, the signed-in
Amazon session, the reports database. An installer replaces that folder. So
every update threatened to delete a 400 MB environment, a browser session that
took a sign-in to create, and the database holding every report ever
downloaded - and the only way back was running setup again.

Nobody should re-run setup because a version number changed.

So the code lives in the install folder, where an installer may freely replace
it, and everything else lives here, where no installer will look:

    Windows   %LOCALAPPDATA%\\Amazon Cash Planner
    macOS     ~/Library/Application Support/Amazon Cash Planner
    Linux     ~/.local/share/amazon-cash-planner

MOVING WHAT IS ALREADY THERE

An installation that predates this has its data in the old place. It is MOVED,
once, and only when the new place does not already hold that item - so a move
can never overwrite something newer. If a move fails, the old copy is left
exactly where it is and the caller is told, because losing somebody's Amazon
session to a tidying-up step would be far worse than leaving it untidy.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_FOLDER = "Amazon Cash Planner"

# The things that belong to this computer rather than to this version.
#
# The virtual environment is DELIBERATELY not here. It is the one item that
# can be rebuilt without losing anything - setup makes a new one in the data
# folder and pythonPath still finds an old one beside the code meanwhile - and
# it is the one that went wrong every time it was moved: half-copied across
# drives once, and silently taken from a second installation twice, because
# anything importing this module adopts from wherever it happens to live.
#
# Everything that IS here is irreplaceable: a session that took a sign-in, a
# token, a database of downloaded reports.
OWNED = [
    "profile",          # the signed-in Amazon session
    "downloads",        # reports that have not been imported yet
    "logs",
    "config.json",      # this installation's access token
    "reports.db", "reports.db-wal", "reports.db-shm",
    "jobs.json",
    "settings.json",
    "dataset.json",
    "supabase.json",
]


def data_dir() -> Path:
    """The folder that survives updates. Created if it is not there yet."""
    override = os.environ.get("FBA_DATA_DIR")
    if override:
        d = Path(override)
    elif os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        d = Path(base) / APP_FOLDER
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / APP_FOLDER
    else:
        base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
        d = Path(base) / "amazon-cash-planner"

    d.mkdir(parents=True, exist_ok=True)
    return d


def _copy_then_swap(src: Path, dst: Path) -> None:
    """Copy into place under a temporary name, then make it the real one.

    shutil.move across two drives copies and then deletes, and a single locked
    file part-way through leaves the data split between both places while
    reporting success. That happened to a virtual environment: 124 MB arrived,
    11 files stayed behind, and neither copy was announced as incomplete.

    So the copy lands beside the destination and is only renamed into place
    once it has finished. A failure leaves nothing half-built for anything
    else to find.
    """
    staging = dst.with_name(dst.name + ".incoming")
    if staging.is_dir():
        shutil.rmtree(staging, ignore_errors=True)
    elif staging.exists():
        staging.unlink()

    try:
        if src.is_dir():
            shutil.copytree(src, staging)
        else:
            shutil.copy2(src, staging)
        staging.rename(dst)
    except Exception:
        if staging.is_dir():
            shutil.rmtree(staging, ignore_errors=True)
        elif staging.exists():
            try:
                staging.unlink()
            except Exception:
                pass
        raise


def running_inside(folder: Path) -> bool:
    """Is this very interpreter running out of that folder?

    Moving the environment you are executing from cannot work, and trying is
    how the partial copy happened.
    """
    try:
        return Path(sys.executable).resolve().is_relative_to(folder.resolve())
    except Exception:
        return False


def venv_python(code_home: Path) -> Path | None:
    """The interpreter, wherever it actually ended up.

    ONE answer to this question, for everything that needs it. There used to
    be several: install.py built the environment in the data folder while
    launch.py looked for it beside the code, so setup succeeded and the
    launcher then said "Python environment is missing. Run SETUP.cmd." - which
    is a loop with no exit, because running setup again put it right back where
    the launcher was not looking.

    The data folder first, then beside the code. The second is not politeness
    to old installations: one part-way through moving still has a perfectly
    good environment there, and refusing to use it would break a copy that
    works.
    """
    rel = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    for base in (data_dir(), code_home):
        candidate = base / "venv" / rel
        if candidate.exists():
            return candidate
    return None


def adopt(old_home: Path) -> dict:
    """Move anything still living beside the code.

    Returns {moved, kept, skipped} - never a bare success. 'kept' means the
    data arrived at the new place but the old copy could not be removed, which
    is safe but worth saying rather than leaving someone to find two of
    something later.

    Never overwrites: an item already in the new place is left alone rather
    than replaced by one that may be older.
    """
    result = {"moved": [], "kept": [], "skipped": []}
    new_home = data_dir()
    try:
        if old_home.resolve() == new_home.resolve():
            return result
    except Exception:
        return result

    for name in OWNED:
        src = old_home / name
        dst = new_home / name
        if not src.exists() or dst.exists():
            continue

        if src.is_dir() and running_inside(src):
            result["skipped"].append(name)
            continue

        try:
            _copy_then_swap(src, dst)
        except Exception:
            # Nothing was changed anywhere. A failed tidy-up must never be the
            # reason somebody loses a browser session.
            result["skipped"].append(name)
            continue

        # The copy is complete and in place, so the original is now surplus.
        # If it will not go, the data is still safe - say so rather than
        # leaving a duplicate nobody knows about.
        try:
            if src.is_dir():
                shutil.rmtree(src)
            else:
                src.unlink()
            result["moved"].append(name)
        except Exception:
            result["kept"].append(name)

    return result
