"""Desktop shortcut that starts the helper AND opens the app.

One double-click has to do both: a shortcut that starts a background process
and leaves you staring at nothing is not a shortcut to anything.

Batch scripts are full of % signs (%~dp0, %ERRORLEVEL%), so nothing here uses
%-formatting — f-strings and concatenation only. That collision is exactly what
broke the first version of this file.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"


def config() -> dict:
    try:
        return json.loads((HERE / "config.json").read_text("utf-8"))
    except Exception:
        return {"port": 8765, "token": ""}


def make_open_script(cfg: dict) -> Path:
    """Start the helper if it is not already answering, wait until it is, then
    open the browser. The wait matters: opening too early shows a dead page."""
    path = HERE / ('open-app.cmd' if IS_WIN else 'open-app.sh')
    if IS_WIN:
        lines = ['@echo off', 'setlocal', 'cd /d "%~dp0"',
                 '"%~dp0venv\\Scripts\\python.exe" "%~dp0launch.py" %*',
                 'if not errorlevel 1 exit /b 0',
                 'echo Launch failed. Run SETUP.cmd or DIAGNOSE.cmd. See logs\\launcher.log.',
                 'if not defined FBA_NONINTERACTIVE pause', 'exit /b 1']
        path.write_bytes(('\r\n'.join(lines)+'\r\n').encode('utf-8'))
    else:
        path.write_text('#!/bin/sh\ncd "$(dirname "$0")"\nexec venv/bin/python launch.py "$@"\n')
        path.chmod(0o755)
    return path


def desktop_dir() -> Path | None:
    for candidate in (
        Path(os.environ.get("USERPROFILE", "")) / "Desktop",
        Path(os.environ.get("OneDrive", "_")) / "Desktop",
        Path.home() / "Desktop",
    ):
        if str(candidate) != "_" and candidate.exists():
            return candidate
    return None


def main() -> int:
    cfg = config()
    opener = make_open_script(cfg)

    if not IS_WIN:
        print("      launcher: " + str(opener))
        print("      (drag it to your dock or desktop if you want it there)")
        return 0

    desk = desktop_dir()
    if desk is None:
        print("      could not find your Desktop.")
        print("      Double-click this instead: " + str(opener))
        return 1

    lnk = desk / "Amazon Cash Planner.lnk"
    ps = (
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + str(lnk).replace("'", "''") + "');"
        "$s.TargetPath='" + str(opener).replace("'", "''") + "';"
        "$s.WorkingDirectory='" + str(HERE).replace("'", "''") + "';"
        "$s.Description='Start the helper and open the Amazon Cash Planner';"
        "$s.WindowStyle=1;"
        "$s.IconLocation='shell32.dll,13';"
        "$s.Save()"
    )
    try:
        subprocess.check_call(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    except Exception as exc:
        print("      could not create the shortcut: " + str(exc))
        print("      Double-click this instead: " + str(opener))
        return 1

    if not lnk.exists():
        print("      the shortcut did not appear on your Desktop.")
        print("      Double-click this instead: " + str(opener))
        return 1

    print("      shortcut: " + str(lnk))
    return 0


if __name__ == "__main__":
    sys.exit(main())
