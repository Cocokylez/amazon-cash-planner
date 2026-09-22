"""Health-gated local launcher. No secrets in shortcuts or command lines."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error
import webbrowser

HERE = Path(__file__).resolve().parent

def instance_id():
    return hashlib.sha256(str(HERE).lower().encode()).hexdigest()[:20]

def config():
    cfg = json.loads((HERE / 'config.json').read_text('utf-8'))
    if not cfg.get('token') or not 1024 <= int(cfg.get('port', 8765)) <= 65535:
        raise RuntimeError('Invalid config.json. Keep the existing token; set port to 1024..65535.')
    return cfg

def request(cfg, path, method='GET'):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (int(cfg.get('port', 8765)), path),
        headers={'X-Worker-Token': cfg['token']}, method=method,
        data=b'{}' if method == 'POST' else None)
    with urllib.request.urlopen(req, timeout=2) as r:
        return json.load(r)

def health(cfg):
    try:
        value = request(cfg, '/api/health')
    except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
        if isinstance(exc, urllib.error.HTTPError):
            raise RuntimeError('Port answered with an HTTP error. Run DIAGNOSE.cmd; no process was stopped.') from None
        return None
    if value.get('worker') != 'fba-local-worker' or value.get('instance') != instance_id() or not value.get('authorized'):
        raise RuntimeError('Port belongs to another app or installation. Close that installation yourself or change config.json port. No process was stopped.')
    return value

def serve():
    import worker
    class SafeStream:
        def __init__(self, stream): self.stream = stream
        def write(self, value): return self.stream.write(worker.redact(value))
        def flush(self): self.stream.flush()
    sys.stdout = SafeStream(sys.stdout)
    sys.stderr = SafeStream(sys.stderr)
    try:
        worker.main()
    except Exception as exc:
        worker.log('Startup failed: ' + type(exc).__name__)
        print('Startup failed: ' + type(exc).__name__ + '. Run DIAGNOSE.cmd.')
        return 1
    return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--serve', action='store_true')
    ap.add_argument('--no-browser', action='store_true')
    ap.add_argument('--update', action='store_true')
    args = ap.parse_args()
    if args.serve: return serve()
    cfg = config()
    current = health(cfg)
    if args.update:
        # Refresh dependencies before stopping a working helper.
        subprocess.check_call([sys.executable, str(HERE / 'install.py')], cwd=HERE)
        if current:
            request(cfg, '/api/shutdown', 'POST')
            for _ in range(40):
                if health(cfg) is None: break
                time.sleep(.25)
            else: raise RuntimeError('This helper did not stop. Update aborted; no processes were killed.')
        subprocess.check_call([sys.executable, str(HERE / 'make_shortcut.py')], cwd=HERE)
        current = None
    if not current:
        py = HERE / ('venv/Scripts/python.exe' if os.name == 'nt' else 'venv/bin/python')
        if not py.exists(): raise RuntimeError('Python environment is missing. Run SETUP.cmd.')
        logs = HERE / 'logs'
        logs.mkdir(exist_ok=True)
        with (logs / 'startup.log').open('a', encoding='utf-8') as out:
            child = subprocess.Popen([str(py), '-u', str(Path(__file__).resolve()), '--serve'],
                cwd=HERE, stdin=subprocess.DEVNULL, stdout=out, stderr=out,
                creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0)
        for _ in range(60):
            if child.poll() is not None:
                raise RuntimeError('Helper exited before becoming healthy. See worker/logs/startup.log and run DIAGNOSE.cmd.')
            current = health(cfg)
            if current: break
            time.sleep(.5)
        else: raise RuntimeError('Health check timed out. See worker/logs/startup.log. Browser was not opened.')
    print('Healthy: http://127.0.0.1:%d (version %s)' % (cfg.get('port', 8765), current['version']))
    if not args.no_browser:
        webbrowser.open('http://127.0.0.1:%d/#token=%s' % (cfg.get('port', 8765), cfg['token']))
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        # Do not print external exception bodies, which can contain credentials.
        message = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__ + ': run SETUP.cmd or DIAGNOSE.cmd.'
        print('ERROR: ' + message)
        (HERE / 'logs').mkdir(exist_ok=True)
        with (HERE / 'logs/launcher.log').open('a', encoding='utf-8') as log:
            log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message + '\n')
        sys.exit(1)
