#!/usr/bin/env python3
"""Exercise an installed release over HTTP using a disposable database."""
import json
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

binary = pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='workbench-smoke-') as tmp:
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    def call(path, data=None, expected=200):
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(url + path, data=body, headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                code, payload = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, payload = e.code, e.read()
        assert code == expected, (path, code, payload)
        return json.loads(payload) if payload else None
    def start(demo=True):
        p = subprocess.Popen([str(binary), '-addr', f'127.0.0.1:{port}', '-db', tmp+('/demo.db' if demo else '/real.db')] + (['-demo'] if demo else []), stdout=subprocess.DEVNULL)
        for _ in range(100):
            try:
                call('/api/tasks')
                return p
            except (OSError, urllib.error.URLError):
                if p.poll() is not None:
                    raise RuntimeError('server exited')
                time.sleep(.05)
        p.terminate()
        p.wait()
        raise RuntimeError('server startup timed out')
    p = start()
    try:
        assert len(call('/api/tasks')) == 4
        observation = call('/api/herdr')
        assert observation['mode'] == 'read_only'
        assert 'data' not in observation  # No raw CLI payload.
        try:
            urllib.request.urlopen(url + '/api/herdr/managed-test')
        except urllib.error.HTTPError as error:
            assert error.code == 404
        else:
            raise AssertionError('experimental managed route leaked into release')
        with urllib.request.urlopen(url) as r:
            html = r.read().decode()
            assert '<div id="root"></div>' in html and '/assets/' in html
        t = call('/api/tasks/t2')
        answer = {'run_id': t['run_id'], 'answer': t['decision']['options'][0]}
        out = call('/api/tasks/t2/decisions', answer)
        assert out['status'] == 'needs_decision'
        assert out['commands'][-1]['status'] == 'recorded'
        call('/api/tasks/t2/decisions', answer, 409)
        follow = {'run_id':'t3-run-1'}
        out = call('/api/tasks/t3/follow-up', follow)
        assert out['status'] == 'needs_evidence'
        call('/api/tasks/t3/follow-up', follow, 409)
        call('/api/tasks/t1/reports', {'run_id':'stale','kind':'progress','message':'x'}, 409)
        call('/api/tasks/t1/reports', {'run_id':'t1-run-1','kind':'completed','message':'x'}, 400)
        empty = {'run_id':'t1-run-1','kind':'completed','message':'empty evidence','evidence':[{}]}
        call('/api/tasks/t1/reports', empty, 400)
        assert call('/api/tasks/t1')['status'] == 'working'
        empty['kind'] = 'ready'
        assert call('/api/tasks/t1/reports', empty)['status'] == 'needs_evidence'
        inline = {'run_id':'t1-run-1','kind':'completed','message':'synthetic smoke result',
                  'evidence':[{'excerpt':'Before: one regression failed. After: eight tests passed.',
                               'origin':'synthetic packaging smoke'}]}
        completed = call('/api/tasks/t1/reports', inline)
        assert completed['status'] == 'done'
        assert completed['evidence'][0]['excerpt'] == inline['evidence'][0]['excerpt']
    finally:
        p.terminate(); p.wait(timeout=5)
    p = start()
    try:
        assert call('/api/tasks/t3')['follow_up_count'] == 1
        assert len(call('/api/tasks/t2')['commands']) == 1
        assert call('/api/tasks/t1')['evidence'][0]['origin'] == 'synthetic packaging smoke'
    finally:
        p.terminate(); p.wait(timeout=5)
    p = start(demo=False)
    try:
        assert call('/api/tasks') == []
        task = call('/api/tasks', {'title':'Synthetic real-work capture trial','goal':'Check explicit reports without starting an agent','origin':'packaging smoke'}, 201)
        assert task['status'] == 'not_started' and task['source'] == 'local'
        assert not task['commands']
        def cli(kind, excerpt='', run=None, extra=()):
            args=[str(binary),'report','-addr',f'127.0.0.1:{port}','-task',task['id'],'-run',run or task['run_id'],
                  '-kind',kind,'-message','Synthetic packaging trial','-origin','packaging smoke CLI']
            if excerpt: args.extend(['-excerpt',excerpt])
            args.extend(extra)
            return subprocess.run(args,capture_output=True,text=True)
        assert cli('progress', run='stale').returncode != 0
        progress = cli('progress')
        assert progress.returncode == 0, progress.stderr
        assert 'Recorded locally only' in progress.stdout
        assert call('/api/tasks/'+task['id'])['status'] == 'working'
        decision_args = ['-question','Which scope should this synthetic trial use?', '-option','Minimal fix', '-option','Gather evidence first']
        assert cli('needs_decision', run='stale', extra=decision_args).returncode != 0
        decision = cli('needs_decision', extra=decision_args)
        assert decision.returncode == 0, decision.stderr
        waiting = call('/api/tasks/'+task['id'])
        assert waiting['status'] == 'needs_decision'
        assert waiting['decision']['options'] == ['Minimal fix', 'Gather evidence first']
        assert waiting['commands'] == []  # Reporting a question never dispatches work.
        def read_decision(run=None):
            return subprocess.run([str(binary),'decision','-addr',f'127.0.0.1:{port}',
                                   '-task',task['id'],'-run',run or task['run_id']],capture_output=True,text=True)
        pending = read_decision()
        assert pending.returncode == 0 and 'Waiting for answer:' in pending.stdout
        assert call('/api/tasks/'+task['id']) == waiting
        assert read_decision('stale').returncode != 0
        recorded = call('/api/tasks/'+task['id']+'/decisions', {'run_id':task['run_id'], 'answer':'Minimal fix'})
        assert recorded['status'] == 'needs_decision'
        assert recorded['commands'][-1]['status'] == 'recorded'
        assert recorded['run_id'] == task['run_id']
        answer_snapshot = read_decision()
        assert answer_snapshot.returncode == 0 and 'Recorded answer:' in answer_snapshot.stdout
        assert 'Read-only snapshot' in answer_snapshot.stdout and 'Minimal fix' in answer_snapshot.stdout
        assert call('/api/tasks/'+task['id']) == recorded  # No receipt, mutation, or dispatch.
        assert cli('needs_decision', extra=decision_args).returncode != 0
        assert call('/api/tasks/'+task['id']) == recorded
        missing = cli('ready')
        assert missing.returncode == 0
        assert call('/api/tasks/'+task['id'])['status'] == 'needs_evidence'
        assert cli('completed').returncode != 0
        completed = cli('completed', 'Synthetic fixture: 8 tests passed.')
        assert completed.returncode == 0, completed.stderr
        assert call('/api/tasks/'+task['id'])['status'] == 'done'
    finally:
        p.terminate(); p.wait(timeout=5)
    p = start(demo=False)
    try:
        saved = call('/api/tasks/'+task['id'])
        assert saved['status'] == 'done'
        assert saved['evidence'][0]['excerpt'] == 'Synthetic fixture: 8 tests passed.'
        assert saved['evidence'][0]['origin'] == 'packaging smoke CLI'
        assert len(call('/api/tasks')) == 1
    finally:
        p.terminate(); p.wait(timeout=5)
print('PASS: blank default, explicit demo, real-work capture/report CLI, persisted evidence; embedded SPA, seeded API, recorded-not-executed decisions, duplicate rejection, stale run rejection, completion evidence requirement, restart persistence')
