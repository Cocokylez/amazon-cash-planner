"""Secrets at rest, tied to this Windows account.

WHY

A secret key that bypasses every access rule in a database should not sit in
a JSON file in plain text. Anything running as this user can read it: a
backup tool, a cloud-sync folder, a script somebody pasted from a forum, or
anyone who copies the file off the machine.

WHAT THIS IS, AND IS NOT

This uses DPAPI - the same per-user protection Windows uses for saved browser
passwords. Ciphertext is bound to this Windows account: copied to another
machine, or read by another user, it will not decrypt.

It is NOT protection against someone already running code AS this user. That
is not a solvable problem here: whatever can decrypt for the app can decrypt
for them. What it does remove is the much likelier accident - the key ending
up somewhere it was never meant to go, readable by anyone who finds it.

NOT WINDOWS, OR DPAPI UNAVAILABLE

The value is stored as it was, and say_state() reports it plainly, because a
security measure that quietly did nothing would be worse than none at all.
"""

from __future__ import annotations

import base64
import ctypes
import sys
from ctypes import wintypes

PREFIX = "dpapi:v1:"


class _BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char))]


def available() -> bool:
    """Can secrets actually be protected on this machine?"""
    if sys.platform != "win32":
        return False
    try:
        ctypes.windll.crypt32  # noqa: B018 - presence is the test
        return True
    except Exception:
        return False


def _blob(data: bytes) -> _BLOB:
    buf = ctypes.create_string_buffer(data, len(data))
    return _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))


def _out(blob: _BLOB) -> bytes:
    out = ctypes.string_at(blob.pbData, blob.cbData)
    ctypes.windll.kernel32.LocalFree(blob.pbData)
    return out


def protect(value: str) -> str:
    """Encrypt for this account. Returns the original on any failure.

    Never raises: a secret that cannot be stored is worse than one stored
    the old way, and the caller is told which happened by is_protected().
    """
    if not value or value.startswith(PREFIX) or not available():
        return value
    try:
        src = _blob(value.encode("utf-8"))
        dst = _BLOB()
        ok = ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst))
        if not ok:
            return value
        return PREFIX + base64.b64encode(_out(dst)).decode("ascii")
    except Exception:
        return value


def unprotect(value: str) -> str:
    """Decrypt if it is protected. A value stored in the clear passes through.

    Returns "" when protected data cannot be read - which happens when the
    file has been copied from another machine or another user. Handing back
    the ciphertext would send it to Supabase as if it were a key, and the
    resulting "invalid key" would send somebody hunting for the wrong fault.
    """
    if not value or not value.startswith(PREFIX):
        return value
    if not available():
        return ""
    try:
        raw = base64.b64decode(value[len(PREFIX):])
        src = _blob(raw)
        dst = _BLOB()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(src), None, None, None, None, 0, ctypes.byref(dst))
        if not ok:
            return ""
        return _out(dst).decode("utf-8", "replace")
    except Exception:
        return ""


def is_protected(value: str) -> bool:
    return bool(value) and value.startswith(PREFIX)


def say_state() -> str:
    """One sentence on what protection is actually in force. Never a claim."""
    if available():
        return ("Encrypted for this Windows account. Copied to another "
                "computer or another user, it will not open.")
    return ("Stored as plain text: this system has no per-account encryption "
            "available. Keep the file where only you can read it.")
