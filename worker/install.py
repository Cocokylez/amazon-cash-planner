"""One-time setup for the Amazon data helper.

Run this once. It creates an isolated Python environment, installs Playwright
and a browser, writes a fixed access token, and registers the helper to start
with your computer. After that the helper is simply there, and the app's
"Get today's Amazon data" button works with no terminal.

    python worker/install.py

Nothing is installed system-wide, nothing is purchased, and no account is
created. Everything lives under worker/.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
VENV = HERE / "venv"
CONFIG = HERE / "config.json"
IS_WIN = os.name == "nt"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if IS_WIN else "bin/python")


def step(n: int, text: str) -> None:
    print("\n[%d/5] %s" % (n, text))


def run(cmd: list[str], **kw) -> None:
    print("      $ " + " ".join(str(c) for c in cmd))
    subprocess.check_call(cmd, **kw)


def main() -> None:
    print("\n  Amazon data helper — one-time setup")
    print("  " + "-" * 46)
    print("  Everything installs under: %s" % HERE)

    # 1 ── an isolated environment, so nothing touches your system Python
    step(1, "Creating an isolated Python environment")
    if not venv_python().exists():
        run([sys.executable, "-m", "venv", str(VENV)])
    else:
        print("      already there, reusing it")

    # 2 ── dependencies
    step(2, "Installing Playwright")

    # Checked BEFORE pip is asked for it. A missing requirements.txt used to
    # surface as pip's own error inside SETUP.cmd's catch-all, which guesses
    # "no internet or antivirus" - so an incomplete installation read as a
    # network problem and sent people looking in the wrong place entirely.
    needs = HERE / "requirements.txt"
    if not needs.is_file():
        raise SystemExit(
            "\n  This installation is incomplete: requirements.txt is missing"
            "\n  from %s"
            "\n"
            "\n  Nothing is wrong with your computer or your connection."
            "\n  Install the app again with a newer installer, then run this"
            "\n  setup once more.\n" % HERE)
    run([str(venv_python()), "-m", "pip", "install", "--quiet", "--upgrade", "pip"])
    run([str(venv_python()), "-m", "pip", "install", "--quiet",
         "-r", str(needs)])

    # 3 ── the browser Playwright drives
    step(3, "Downloading the browser it drives (this is the slow one)")
    run([str(venv_python()), "-m", "playwright", "install", "chromium"])

    # 4 ── a stable token, so the app does not need a fresh link each start
    step(4, "Writing local configuration")
    cfg = {}
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text("utf-8"))
        except Exception as exc:
            raise RuntimeError("config.json is unreadable; repair it before installing. It was not overwritten.") from exc
    if not cfg.get("token"):
        cfg["token"] = uuid.uuid4().hex
    cfg.setdefault("port", 8765)
    CONFIG.write_text(json.dumps(cfg, indent=2), "utf-8")
    print("      token written to %s" % CONFIG)
    print("      (this file is your key to the helper - keep it local)")

    # 5 ── start with the computer, plus a launcher you can double-click
    step(5, "Registering the helper to start with your computer")
    try:
        if IS_WIN:
            install_windows(cfg)
        elif sys.platform == "darwin":
            install_macos(cfg)
        else:
            install_linux(cfg)
    except Exception as exc:
        print("      could not register it: %s" % exc)
        print("      That is not fatal - use the desktop launcher instead.")

    make_launcher()

    url = "http://127.0.0.1:%d/?token=%s" % (cfg["port"], cfg["token"])
    print("\n  Done.")
    print("  " + "-" * 46)
    print("  Open the app with worker/open-app.cmd (the token stays local).")
    print("")
    print("  The helper starts automatically when you log in. To start it now")
    print("  without restarting, double-click:")
    print("      %s" % (HERE / ("start-helper." + ("cmd" if IS_WIN else "sh"))))
    print("")
    print("  First time only: in the app, open Data & assumptions and run")
    print("  'Set up a report' once for each report. After that the daily")
    print("  button needs nothing else.\n")


# ── autostart, per platform ─────────────────────────────────────────────────

def install_windows(cfg: dict) -> None:
    """A .cmd in the Startup folder. No admin rights, no scheduled task, and
    trivially removable by deleting the file."""
    startup = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/Startup"
    startup.mkdir(parents=True, exist_ok=True)
    target = startup / "amazon-data-helper.cmd"
    # python.exe minimised, NOT pythonw.exe: pythonw has no stdio handles
    # and Playwright needs them to spawn Chromium over a pipe.
    exe = venv_python()
    # No token in here: worker.py reads config.json itself, so this file is not
    # a secret and deleting it simply turns autostart off.
    target.write_bytes(('@echo off\r\ncall "' + str(HERE / 'open-app.cmd') + '" --no-browser\r\n').encode('utf-8'))
    print("      %s" % target)


def install_macos(cfg: dict) -> None:
    plist = Path.home() / "Library/LaunchAgents/com.local.amazon-data-helper.plist"
    plist.parent.mkdir(parents=True, exist_ok=True)
    plist.write_text("""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.amazon-data-helper</string>
  <key>ProgramArguments</key>
  <array><string>%s</string><string>%s</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>FBA_WORKER_TOKEN</key><string>%s</string>
        <key>FBA_WORKER_PORT</key><string>%d</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict></plist>
""" % (venv_python(), HERE / "worker.py", cfg["token"], cfg["port"]), "utf-8")
    subprocess.call(["launchctl", "unload", str(plist)],
                    stderr=subprocess.DEVNULL)
    subprocess.call(["launchctl", "load", str(plist)])
    print("      %s" % plist)


def install_linux(cfg: dict) -> None:
    unit = Path.home() / ".config/systemd/user/amazon-data-helper.service"
    unit.parent.mkdir(parents=True, exist_ok=True)
    unit.write_text("""[Unit]
Description=Amazon data helper

[Service]
ExecStart=%s %s
Environment=FBA_WORKER_TOKEN=%s
Environment=FBA_WORKER_PORT=%d
Restart=on-failure

[Install]
WantedBy=default.target
""" % (venv_python(), HERE / "worker.py", cfg["token"], cfg["port"]), "utf-8")
    subprocess.call(["systemctl", "--user", "daemon-reload"])
    subprocess.call(["systemctl", "--user", "enable", "--now",
                     "amazon-data-helper.service"])
    print("      %s" % unit)


def make_launcher() -> None:
    """The fallback: something to double-click if autostart is not wanted.
    No token in here — worker.py reads config.json itself."""
    from make_shortcut import make_open_script
    path = make_open_script({})
    print("      launcher: %s" % path)


if __name__ == "__main__":
    main()
