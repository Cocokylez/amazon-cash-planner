"""Synthetic regression checks; never opens Amazon or reads financial files."""
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import urllib.request
import urllib.error
import worker as W
import launch
import seller_central as SC

def check(value, label):
    assert value, label
    print('PASS ' + label)

with tempfile.TemporaryDirectory() as tmp, patch.object(W, 'HERE', Path(tmp)):
    store = W.JobStore()
    job = store.create('date-range-transactions', '2026-09-01', '2026-09-02', 'United States', 'Standard Orders')
    store.update(job['jobId'], ticket={'tag':'synthetic-ticket'}, status='generating')
    restored = W.JobStore()
    same = restored.create('date-range-transactions', '2026-09-01', '2026-09-02', 'United States', 'Standard Orders')
    check(same['reused'] and same['ticket']['tag']=='synthetic-ticket', 'restart retains ticket and prevents resubmission')

check(SC.row_identity('Transaction Ready Download') == SC.row_identity('Transaction In Progress'), 'status changes do not identify a new report')
check(not SC.row_matches('Transaction 11/1/2026 11/2/2026', {'from':'2026-01-01','to':'2026-02-01'}), 'date matches have boundaries')
check('secret' not in W.redact('Cookie: session=secret; other=secret'), 'whole cookie header redacted')
check('secret' not in W.redact('Authorization: Bearer secret'), 'authorization header redacted')

cfg=launch.config()
check(launch.health(cfg)['authorized'], 'running helper authenticates this installation')
base='http://127.0.0.1:%d' % cfg.get('port',8765)
for route in ['/worker/config.json','/worker/profile/Local%20State','/worker/logs/helper.log','/backup/','/lib/../worker/config.json','/api/jobs']:
    try:
        urllib.request.urlopen(base+route,timeout=3)
        raise AssertionError('private route was accessible')
    except urllib.error.HTTPError as exc:
        check(exc.code in (401,404), 'private route blocked: '+route)
req=urllib.request.Request(base+'/api/jobs', headers={'X-Worker-Token':cfg['token'],'Origin':'https://untrusted.example'})
try:
    urllib.request.urlopen(req,timeout=3)
    raise AssertionError('foreign origin accepted')
except urllib.error.HTTPError as exc:
    check(exc.code==401,'foreign origin rejected even with a token')
public=json.load(urllib.request.urlopen(base+'/api/health'))
check('settings' not in public and public['authorized'] is False,'public health omits private settings')
print('All repair checks passed.')
