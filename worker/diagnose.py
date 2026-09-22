"""Write a sanitised report of what is installed and what is running.

Deliberately paranoid about what it includes: no helper token, no Amazon
cookies, no browser profile contents, no downloaded financial data. Paths are
included because a wrong path is the most common cause of the helper not
starting, and user names inside them are shortened.
"""

from __future__ import annotations

import json
import os
import platform
import socket
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "diagnostic-report.txt"

lines: list[str] = []


def w(text: str = "") -> None:
    lines.append(text)


def short(p) -> str:
    """Keep the shape of a path without publishing the account name."""
    s = str(p)
    home = str(Path.home())
    if s.startswith(home):
        s = "<home>" + s[len(home):]
    return s


def section(name: str) -> None:
    w("")
    w("-- " + name + " " + "-" * max(0, 58 - len(name)))


def config() -> dict:
    try:
        return json.loads((HERE / "config.json").read_text("utf-8"))
    except Exception:
        return {}


def port_state(port: int) -> str:
    s = socket.socket()
    s.settimeout(1.0)
    try:
        s.connect(("127.0.0.1", port))
    except Exception:
        return "nothing is listening"
    finally:
        try:
            s.close()
        except Exception:
            pass
    try:
        req = urllib.request.Request("http://127.0.0.1:%d/api/health" % port, headers={"X-Worker-Token": config().get("token", "")})
        with urllib.request.urlopen(req, timeout=3) as r:
            body = r.read(100000).decode("utf-8", "replace")
        if "fba-local-worker" in body:
            data = json.loads(body)
            return ("OUR HELPER is listening and healthy "
                    "(setupComplete=%s, reports=%d)"
                    % (data.get("setupComplete"), len(data.get("reports", []))))
        return "SOMETHING ELSE is listening (it answered, but not as our helper)"
    except Exception as exc:
        return ("SOMETHING ELSE is listening (it accepted a connection but did "
                "not answer as our helper: %s)" % type(exc).__name__)


# ── report ──────────────────────────────────────────────────────────────────

w("Amazon Cash Planner - diagnostic report")
w("generated " + datetime.now().isoformat(timespec="seconds"))
w("")
w("This file contains NO passwords, NO Amazon cookies, NO helper token")
w("and NO financial data.")

section("Computer")
w("OS            : %s %s" % (platform.system(), platform.release()))
w("Python running: %s" % sys.version.split()[0])
w("Python path   : %s" % short(sys.executable))

section("Installation")
w("Helper folder : %s" % short(HERE))
w("App folder    : %s" % short(HERE.parent))
w("Path has space: %s" % ("YES" if " " in str(HERE) else "no"))
for name in ("worker.py", "seller_central.py", "setup_flow.py", "install.py",
             "make_shortcut.py", "open-app.cmd", "start-helper.cmd",
             "SETUP.cmd", "UPDATE.cmd"):
    p = HERE / name
    w("  %-20s %s" % (name, ("present, %d bytes" % p.stat().st_size)
                       if p.exists() else "MISSING"))

venv_py = HERE / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
w("")
w("venv python   : %s" % ("present" if venv_py.exists() else "MISSING"))
if venv_py.exists():
    try:
        v = subprocess.run([str(venv_py), "--version"], capture_output=True,
                           text=True, timeout=20)
        w("venv version  : %s" % (v.stdout or v.stderr).strip())
    except Exception as exc:
        w("venv version  : could not run it (%s)" % exc)
    try:
        v = subprocess.run([str(venv_py), "-c",
                            "import playwright,sys;print(playwright.__version__)"],
                           capture_output=True, text=True, timeout=40)
        w("playwright    : %s" % ((v.stdout or v.stderr).strip() or "not installed"))
    except Exception as exc:
        w("playwright    : could not check (%s)" % exc)

browsers = Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright"
w("chromium      : %s" % ("present" if browsers.exists() else "not found at "
                          + short(browsers)))

section("Configuration")
cfg = config()
w("config.json   : %s" % ("present" if cfg else "MISSING or unreadable"))
w("  port        : %s" % cfg.get("port", "(not set, defaults to 8765)"))
w("  token       : %s" % ("set, not shown" if cfg.get("token") else "NOT SET"))
try:
    st = json.loads((HERE / "settings.json").read_text("utf-8"))
    w("settings.json : marketplaces=%s accountType=%s"
      % (st.get("marketplaces"), st.get("accountType")))
except Exception:
    w("settings.json : not written yet (normal before first use)")

try:
    sel = json.loads((HERE / "selectors.json").read_text("utf-8"))
    for k, v in sel.items():
        w("report setup  : %-26s verified=%s  url=%s"
          % (k, v.get("verified"), "[recorded locally]"))
except Exception:
    w("report setup  : none recorded yet")

w("profile dir   : %s" % ("present (your Amazon session; contents not read)"
                          if (HERE / "profile").exists() else "not created yet"))

section("Is the helper running?")
port = int(cfg.get("port") or 8765)
w("port %d      : %s" % (port, port_state(port)))
if os.name == "nt":
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR "
             "Name='pythonw.exe'\" | Where-Object { $_.CommandLine -like "
             "'*worker.py*' } | ForEach-Object { $_.ProcessId }"],
            capture_output=True, text=True, timeout=30)
        pids = [x for x in (out.stdout or "").split() if x.strip()]
        w("helper procs  : %s" % (", ".join(pids) if pids else "none running"))
    except Exception as exc:
        w("helper procs  : could not check (%s)" % exc)

section("Desktop shortcut")
for cand in (Path(os.environ.get("USERPROFILE", "")) / "Desktop",
             Path(os.environ.get("OneDrive", "_")) / "Desktop"):
    lnk = cand / "Amazon Cash Planner.lnk"
    if str(cand) != "_" and cand.exists():
        w("%-40s %s" % (short(lnk), "present" if lnk.exists() else "not there"))

startup = (Path(os.environ.get("APPDATA", ""))
           / "Microsoft/Windows/Start Menu/Programs/Startup"
           / "amazon-data-helper.cmd")
w("autostart     : %s" % ("registered" if startup.exists() else "not registered"))

section("Last 60 log lines (already sanitised by the helper)")
log = HERE / "logs" / "helper.log"
if log.exists():
    try:
        tail = log.read_text("utf-8", errors="replace").splitlines()[-60:]
        for line in tail:
            from worker import redact
            w("  " + short(redact(line)))
    except Exception as exc:
        w("  could not read the log: %s" % exc)
else:
    w("  no log yet - the helper has never started, or never got far enough")

section("What this usually means")
w("  'nothing is listening' + 'helper procs: none'")
w("      the helper is not running. Double-click open-app or the")
w("      Desktop shortcut and watch for an error window.")
w("  'SOMETHING ELSE is listening'")
w("      another program owns the port. Change \"port\" in config.json.")
w("  'venv python: MISSING'")
w("      setup did not finish. Run SETUP again.")
w("  'chromium: not found'")
w("      run SETUP again; it downloads the browser.")

OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("")
print("  Report written to:")
print("  %s" % OUT)
print("")
print("  Summary:")
print("    helper folder : %s" % short(HERE))
print("    port %-9d: %s" % (port, port_state(port)))
print("    venv python   : %s" % ("present" if venv_py.exists() else "MISSING"))
