"""Use the Chrome profile you are ALREADY signed into Amazon with.

THE PROBLEM THIS SOLVES

Playwright's own Chromium starts blank. Setting up a report then meant signing
in to Amazon from scratch, through whatever verification Amazon decided to ask
for. If you are already signed in to Seller Central in Chrome, that is work for
nothing.

TWO WAYS TO USE AN EXISTING PROFILE, AND WHY THIS PICKS THE SECOND

  1. Point Chrome at your real profile directory.
     Chrome refuses to open a profile another Chrome already has open, so you
     would have to close every Chrome window first. It also means automation
     writes into the profile you browse with.

  2. COPY the parts that carry the session into the helper's own profile.
     Chrome can stay open, your real profile is never written to, and the copy
     lives beside the helper where it is already gitignored.

This does (2). The copy is taken once, when you choose a profile during setup.
If the session later expires, the helper pauses and asks you to sign in in its
own window, exactly as before.

WHAT IS COPIED

Only what carries a login: cookies, the encryption key that unlocks them, and
preferences. No history, no bookmarks, no passwords, no cache. Everything stays
on this computer; nothing is uploaded.

A NOTE ON THE ENCRYPTION

Chrome encrypts cookies with a key held in Local State and protected by
Windows DPAPI for YOUR user account. Copying both together on the same machine,
as the same user, keeps them readable. Copying them to a different machine or
user would not work — which is a privacy property, not a limitation to fix.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

# Only these. Anything not named here is not copied.
PROFILE_ITEMS = [
    "Cookies",                    # older Chrome
    "Cookies-journal",
    "Network/Cookies",            # current Chrome
    "Network/Cookies-journal",
    "Preferences",
    "Secure Preferences",
    "Local Storage",              # some sites keep session state here
]


def user_data_dir() -> Path | None:
    """Where Chrome keeps its profiles on this platform."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/User Data"
    elif os.sys.platform == "darwin":
        base = Path.home() / "Library/Application Support/Google/Chrome"
    else:
        base = Path.home() / ".config/google-chrome"
    return base if base.exists() else None


def list_profiles() -> list[dict]:
    """Every Chrome profile, with the name you see in Chrome's own menu."""
    base = user_data_dir()
    if not base:
        return []

    names: dict = {}
    ls = base / "Local State"
    if ls.exists():
        try:
            data = json.loads(ls.read_text("utf-8", errors="replace"))
            names = data.get("profile", {}).get("info_cache", {}) or {}
        except Exception:
            names = {}

    out = []
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        if d.name != "Default" and not d.name.startswith("Profile"):
            continue
        info = names.get(d.name, {})
        has_cookies = (d / "Network" / "Cookies").exists() or (d / "Cookies").exists()
        out.append({
            "id": d.name,
            "name": info.get("name") or d.name,
            "email": info.get("user_name") or None,
            "hasCookies": has_cookies,
        })
    return out


def chrome_running() -> bool:
    """Chrome holds a lock on a profile it has open. The copy does not need it
    closed, but a locked source file can still fail to read, so the caller is
    told."""
    if os.name != "nt":
        return False
    try:
        import subprocess
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-Process chrome -ErrorAction SilentlyContinue | "
             "Measure-Object).Count"],
            capture_output=True, text=True, timeout=20)
        return int((out.stdout or "0").strip() or 0) > 0
    except Exception:
        return False


def _copy_file(src: Path, dest: Path) -> bool:
    """A plain copy. When Chrome holds the file open this fails, and the caller
    falls back to launching Chrome against the real profile instead of trying
    to prise the file loose — which is both fragile and indistinguishable from
    credential theft."""
    try:
        shutil.copy2(src, dest)
        return True
    except Exception:
        return False


def clone_profile(profile_id: str, dest: Path) -> dict:
    """Copy the session-carrying parts of `profile_id` into `dest`, laid out as
    a Playwright user-data-dir. Returns a report of what was copied."""
    base = user_data_dir()
    if not base:
        raise RuntimeError("Google Chrome does not appear to be installed.")

    src = base / profile_id
    if not src.exists():
        raise RuntimeError("Chrome profile %r was not found." % profile_id)

    dest.mkdir(parents=True, exist_ok=True)
    if (dest / 'Local State').exists() or (dest / 'Default').exists():
        return {'cookiesCopied': False, 'note': 'Existing helper browser profile preserved. Sign in in that window if needed.'}
    default = dest / "Default"
    default.mkdir(exist_ok=True)

    copied, skipped = [], []

    # Local State holds the key that decrypts the cookies. Without it the
    # copied cookies are unreadable, and the sign-in does not come across.
    ls = base / "Local State"
    if ls.exists():
        if _copy_file(ls, dest / "Local State"):
            copied.append("Local State")
        else:
            skipped.append("Local State (locked)")

    for item in PROFILE_ITEMS:
        s = src / item
        d = default / item
        if not s.exists():
            continue
        try:
            d.parent.mkdir(parents=True, exist_ok=True)
            if s.is_dir():
                shutil.copytree(s, d, dirs_exist_ok=True)
            elif not _copy_file(s, d):
                skipped.append("%s (locked by Chrome)" % item)
                continue
            copied.append(item)
        except Exception as exc:
            # A file Chrome has open can refuse to copy. Not fatal on its own.
            skipped.append("%s (%s)" % (item, type(exc).__name__))

    got_cookies = any("Cookies" in c for c in copied)
    return {
        "profile": profile_id,
        "copied": copied,
        "skipped": skipped,
        "cookiesCopied": got_cookies,
        "chromeWasRunning": chrome_running(),
        "note": (
            "Cookie files copied; Amazon login is not verified." if got_cookies else
            "No cookie file could be copied, so you will still need to sign in "
            "in the helper's own browser window. Closing Chrome first usually "
            "fixes this."),
    }
