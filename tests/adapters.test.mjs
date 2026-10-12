import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { id, makeEvent, codexNotify, hookEvent, safeId } from '../adapters/core.mjs';
import { installNotify, installHooks, uninstall, shellQuote, detectAgent } from '../adapters/install.mjs';
import { enqueue, flush, LIMITS, readToken, validateServer, deliveryStatus } from '../adapters/storage.mjs';

const CLI = fileURLToPath(new URL('../adapters/amc.mjs', import.meta.url));
const CONFIG = { host_id: 'test-host', metadata: { name: 'Synthetic fixture', project: 'test-project', repo: 'example/repo', branch: 'main' } };
const TOKEN = 'amc_synthetic_test_only_token_1234567890';
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amc adapter 'space' ")); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
async function fixture(t, server = 'http://127.0.0.1:1') {
  const dir = await temp(t), state = path.join(dir, 'state folder'); await fs.mkdir(state, { mode: 0o700 });
  const tokenFile = path.join(state, 'token'); await fs.writeFile(tokenFile, TOKEN, { mode: 0o600 });
  const config = { ...CONFIG, server, token_file: tokenFile, version: 1 };
  await fs.writeFile(path.join(state, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  return { dir, state, config };
}
function cli(args, input = '', options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, AMC_TASK_ID: '', PATH: '/nonexistent', ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
async function server(t, handler) {
  const instance = http.createServer(handler); await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return `http://127.0.0.1:${instance.address().port}`;
}
async function queued(state) {
  const names = (await fs.readdir(path.join(state, 'queue'))).filter(name => name.endsWith('.json'));
  return Promise.all(names.map(name => fs.readFile(path.join(state, 'queue', name), 'utf8').then(JSON.parse)));
}

test('Codex real notify contract: argv event, turn-finished only, stable run, dedupe', () => {
  const input = { type: 'agent-turn-complete', 'thread-id': 'native-thread', 'turn-id': 'native-turn', cwd: '/private/path', 'input-messages': ['TOP SECRET PROMPT'], 'last-assistant-message': 'PRIVATE ANSWER', tool_input: { command: 'SECRET COMMAND' } };
  const event = codexNotify(CONFIG, input);
  assert.equal(event.event_type, 'turn_finished'); assert.ok(event.task_id); assert.ok(event.run_id);
  assert.equal(event.event_id, codexNotify(CONFIG, input).event_id);
  const next = codexNotify(CONFIG, { ...input, 'turn-id': 'other-turn' }); assert.equal(next.run_id, event.run_id); assert.notEqual(next.event_id, event.event_id);
  const raw = JSON.stringify(event); for (const forbidden of ['SECRET', 'PRIVATE', '/private/path', 'native-thread', 'native-turn', 'tool_input']) assert.ok(!raw.includes(forbidden));
  assert.equal(codexNotify(CONFIG, { ...input, type: 'approval-requested' }), null);
  assert.equal(codexNotify(CONFIG, { type: 'agent-turn-complete' }), null);
});

test('Identifiers isolate hosts, agents and native sessions; explicit task joins sessions', () => {
  const base = codexNotify(CONFIG, { type: 'agent-turn-complete', 'thread-id': 'one' });
  const second = codexNotify(CONFIG, { type: 'agent-turn-complete', 'thread-id': 'two' });
  assert.notEqual(base.task_id, second.task_id); assert.notEqual(base.run_id, second.run_id); assert.notEqual(base.session_id, second.session_id);
  assert.notEqual(base.session_id, codexNotify({ ...CONFIG, host_id: 'another-host' }, { type: 'agent-turn-complete', 'thread-id': 'one' }).session_id);
  const joined = codexNotify(CONFIG, { type: 'agent-turn-complete', 'thread-id': 'two' }, { taskId: 'intentional-task' }); assert.equal(joined.task_id, 'intentional-task'); assert.notEqual(joined.run_id, base.run_id);
  assert.throws(() => safeId('../escape')); assert.throws(() => safeId('_bad-first-character'));
});

test('Claude lifecycle observations never decide approval or treat Stop as task completion', () => {
  const input = { session_id: 'claude-session', hook_event_name: 'PermissionRequest', tool_input: { command: 'SECRET' }, transcript_path: '/secret/log', prompt: 'PRIVATE' };
  const permission = hookEvent(CONFIG, 'claude', input);
  assert.equal(permission.event_type, 'approval_required');
  assert.equal(hookEvent(CONFIG, 'claude', { ...input, hook_event_name: 'Stop' }).event_type, 'turn_finished');
  assert.equal(hookEvent(CONFIG, 'claude', { ...input, hook_event_name: 'SessionEnd' }).event_type, 'session_ended');
  assert.equal(hookEvent(CONFIG, 'claude', { ...input, hook_event_name: 'Notification', notification_type: 'idle_prompt' }), null);
  assert.equal(hookEvent(CONFIG, 'claude', { ...input, hook_event_name: 'Notification', notification_type: 'permission_prompt' }).event_type, 'approval_required');
  for (const word of ['SECRET', 'PRIVATE', '/secret/log', 'decision', 'allow', 'deny']) assert.ok(!JSON.stringify(permission).includes(word));
  assert.deepEqual(Object.keys(permission.payload).sort(), ['branch', 'name', 'project', 'repo', 'summary']);
});

test('Codex install is idempotent, top-level safe, backs up and precisely uninstalls', async t => {
  const dir = await temp(t), state = path.join(dir, 'state'), home = path.join(dir, 'codex'); await fs.mkdir(home);
  const file = path.join(home, 'config.toml'), original = '# retained comment\nmodel = "custom"\n[features]\nexisting = true\n'; await fs.writeFile(file, original);
  await installNotify(state, home); const first = await fs.readFile(file, 'utf8'); await installNotify(state, home);
  assert.equal(await fs.readFile(file, 'utf8'), first); assert.equal(await fs.readFile(`${file}.amc-backup`, 'utf8'), original);
  const arrayLine = first.split('\n').find(line => line.startsWith('notify = ')); const command = JSON.parse(arrayLine.slice(9));
  assert.equal(command[0], process.execPath); assert.equal(command[1], CLI); assert.equal(command[4], state);
  await fs.appendFile(file, '# user added afterwards\n'); await uninstall(state, 'codex-notify');
  assert.equal(await fs.readFile(file, 'utf8'), original + '# user added afterwards\n');
  await uninstall(state, 'codex-notify'); assert.equal(await fs.readFile(file, 'utf8'), original + '# user added afterwards\n');
});

test('Codex notify conflicts, edited blocks and escaped keys never overwrite user config', async t => {
  const dir = await temp(t);
  for (const [index, text] of ['notify = ["existing"]\n', '"notify" = ["existing"]\n', '"not\\u0069fy" = ["existing"]\n', '[table]\nnotify = ["nested"]\n'].entries()) {
    const home = path.join(dir, `codex-${index}`); await fs.mkdir(home); const file = path.join(home, 'config.toml'); await fs.writeFile(file, text);
    await assert.rejects(installNotify(path.join(dir, `state-${index}`), home)); assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  const home = path.join(dir, 'codex-managed'), state = path.join(dir, 'state-managed'); await installNotify(state, home);
  const file = path.join(home, 'config.toml'); let text = await fs.readFile(file, 'utf8'); text = text.replace('"notify"', '"notify-edited"'); await fs.writeFile(file, text);
  await assert.rejects(installNotify(state, home)); const result = await uninstall(state, 'codex-notify'); assert.equal(result.preserved.length, 1); assert.equal(await fs.readFile(file, 'utf8'), text);
});

test('Claude hook merging and uninstall preserve unrelated settings and handlers', async t => {
  const dir = await temp(t), state = path.join(dir, 'state'), home = path.join(dir, 'claude'); await fs.mkdir(home);
  const file = path.join(home, 'settings.json'), original = { model: 'custom', permissions: { allow: ['Read'] }, hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'existing command' }] }] } };
  await fs.writeFile(file, JSON.stringify(original)); await installHooks(state, 'claude', home); await installHooks(state, 'claude', home);
  const value = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(value.hooks.Stop.length, 2); assert.deepEqual(value.permissions, original.permissions);
  const own = value.hooks.Stop[1].hooks[0]; assert.ok(own.command.includes("'\"'\"'")); assert.equal(own.timeout, 4); assert.ok(!own.command.includes(TOKEN));
  await uninstall(state, 'claude-hooks'); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), original);
});

test('Codex hook preparation installs/trusts nothing; explicit install preserves existing hooks', async t => {
  const dir = await temp(t), state = path.join(dir, 'state'), home = path.join(dir, 'codex');
  await installHooks(state, 'codex', home, { prepareOnly: true }); await assert.rejects(fs.access(path.join(home, 'hooks.json')));
  const candidate = JSON.parse(await fs.readFile(path.join(state, 'codex-hooks.candidate.json'), 'utf8'));
  assert.ok(candidate.hooks.PermissionRequest); assert.ok(!JSON.stringify(candidate).includes('dangerously'));
  await installHooks(state, 'codex', home); const text = await fs.readFile(path.join(home, 'hooks.json'), 'utf8'); assert.ok(!text.includes('trust')); await assert.rejects(fs.access(path.join(home, 'config.toml')));
});

test('Capability detection is bounded and conservative, with no invented version floor', () => {
  const calls = [];
  const detected = detectAgent('codex', (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0, stdout: args[0] === '--version' ? 'codex-cli 1.2.3' : args[0] === 'features' ? 'hooks stable true\n' : '' }; });
  assert.equal(detected.version, '1.2.3'); assert.equal(detected.hook_capability, 'detected-review-required'); assert.equal(calls.length, 3); assert.ok(calls.every(call => call.opts.timeout <= 1000));
  assert.equal(detectAgent('codex', () => ({ status: 1 })).hook_capability, 'unknown');
});

test('Delivery uses bearer auth, never redirects, retries boundedly, and deletes acknowledged events', async t => {
  let received;
  const origin = await server(t, (req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { received = { authorization: req.headers.authorization, url: req.url, event: JSON.parse(body) }; res.writeHead(201); res.end('{}'); }); });
  const { state, config } = await fixture(t, origin); const event = codexNotify(config, { type: 'agent-turn-complete', 'thread-id': 'test', 'turn-id': 'turn', prompt: 'SECRET' });
  await enqueue(state, event); const result = await flush(state, config); assert.equal(result.sent, 1); assert.equal(result.pending, 0);
  assert.equal(received.authorization, `Bearer ${TOKEN}`); assert.equal(received.url, '/api/events'); assert.deepEqual(received.event, event);
  await enqueue(state, { ...event, event_id: 'test-retry' }); let requests = 0;
  const retry = await flush(state, config, { fetcher: async (url, options) => { requests++; assert.equal(options.redirect, 'manual'); throw new Error('network unavailable'); } });
  assert.equal(requests, 2); assert.equal(retry.pending, 1);
  const unauthorized = await flush(state, config, { fetcher: async () => ({ status: 401, ok: false }) }); assert.equal(unauthorized.attempts, 1); assert.equal(unauthorized.pending, 1);
});

test('Disk buffer is capped; rejected oversized/path events do not escape queue', async t => {
  const { state, config } = await fixture(t); const base = makeEvent(config, 'codex', 'heartbeat', 'host');
  for (let index = 0; index < LIMITS.maxFiles + 7; index++) await enqueue(state, { ...base, event_id: `event-${index}` });
  const files = await queued(state); assert.equal(files.length, LIMITS.maxFiles);
  const bytes = (await Promise.all((await fs.readdir(path.join(state, 'queue'))).map(name => fs.stat(path.join(state, 'queue', name))))).reduce((sum, stat) => sum + stat.size, 0); assert.ok(bytes <= LIMITS.maxBytes);
  await assert.rejects(enqueue(state, { ...base, event_id: '../escape' }));
  await assert.rejects(enqueue(state, { ...base, payload: { summary: 'x'.repeat(LIMITS.maxEventBytes) } }));
});

test('CLI notify accepts real argv JSON; Claude hook always returns empty observation JSON', async t => {
  const { state } = await fixture(t);
  const result = await cli(['notify', '--state-dir', state, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'real-native', 'turn-id': 'one', 'input-messages': ['SECRET PROMPT'] })]);
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const hook = await cli(['hook', '--agent', 'claude', '--state-dir', state], JSON.stringify({ session_id: 'real-claude', hook_event_name: 'PermissionRequest', tool_input: { command: 'SECRET' } }));
  assert.equal(hook.code, 0); assert.equal(hook.stdout, '{}\n'); assert.equal(hook.stderr, '');
  const events = await queued(state); assert.equal(events.length, 2); assert.ok(events.some(event => event.event_type === 'approval_required')); assert.ok(!JSON.stringify(events).includes('SECRET'));
});

test('Malformed input, unavailable config, and missing token fail open without leaking data', async t => {
  const { state, config } = await fixture(t); await fs.rm(config.token_file);
  const inputs = ['{malformed', JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }), 'x'.repeat(LIMITS.inputBytes + 100)];
  for (const input of inputs) { const start = Date.now(); const result = await cli(['hook', '--agent', 'claude', '--state-dir', state], input); assert.equal(result.code, 0); assert.equal(result.stdout, '{}\n'); assert.equal(result.stderr, ''); assert.ok(Date.now() - start < 3500); }
});

test('Init accepts token file locally, is idempotent, never changes real home', async t => {
  const { state, config, dir } = await fixture(t); const home = path.join(dir, 'isolated-codex');
  const args = ['init', '--server', config.server, '--host-id', config.host_id, '--token-file', config.token_file, '--state-dir', state, '--codex-home', home];
  const one = await cli(args); const two = await cli(args); assert.equal(one.code, 0, one.stderr); assert.equal(two.code, 0, two.stderr); assert.ok(!one.stdout.includes(TOKEN)); assert.ok(!two.stdout.includes(TOKEN));
  assert.ok((await fs.readFile(path.join(home, 'config.toml'), 'utf8')).includes('notify = '));
});

test('Wrapper exit zero and nonzero retain open task; explicit complete is sole task completion path', async t => {
  const { state, config } = await fixture(t);
  const args = ['run', '--agent', 'codex', '--task-id', 'wrapped-task', '--state-dir', state, '--', process.execPath, '-e', 'process.exit(0)'];
  const run = await cli(args); assert.equal(run.code, 0); let events = await queued(state); assert.ok(events.some(event => event.event_type === 'session_ended')); assert.ok(!events.some(event => event.event_type === 'task_completed'));
  const failed = await cli([...args.slice(0, -1), 'process.exit(7)']); assert.equal(failed.code, 7); events = await queued(state); assert.ok(!events.some(event => event.event_type === 'task_completed'));
  const complete = await cli(['complete', '--agent', 'codex', '--task-id', 'wrapped-task', '--session-id', id('session', config.host_id, 'codex', 'session'), '--run-id', 'explicit-run', '--state-dir', state]); assert.equal(complete.code, 0); events = await queued(state); assert.equal(events.filter(event => event.event_type === 'task_completed').length, 1);
});

test('Credential and URL handling reject unsafe files/origins without printing credentials', async t => {
  assert.throws(() => validateServer('http://example.com')); assert.throws(() => validateServer('https://token@example.com')); assert.throws(() => validateServer('https://example.com/?secret=x'));
  assert.equal(validateServer('https://example.com/'), 'https://example.com'); assert.equal(validateServer('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  const { config } = await fixture(t); await fs.chmod(config.token_file, 0o644); if (process.platform !== 'win32') await assert.rejects(readToken(config));
  assert.equal(shellQuote("a b'c"), `'a b'"'"'c'`);
});

test('Notify replay preserves the full original envelope; permanent 409 cannot block the queue', async t => {
  const { state, config } = await fixture(t), input = { type: 'agent-turn-complete', 'thread-id': 'replayed', 'turn-id': 'same-turn' };
  const first = codexNotify(config, input); await enqueue(state, first);
  await flush(state, config, { fetcher: async () => ({ status: 201, ok: true }) });
  const replay = { ...codexNotify(config, input), timestamp: '2026-10-12T00:00:00.000Z', payload: { summary: 'changed after original delivery' } };
  await enqueue(state, replay); const [queuedReplay] = await queued(state); assert.deepEqual(queuedReplay, first);
  await enqueue(state, { ...first, event_id: 'next-event' }); let calls = 0;
  const result = await flush(state, config, { fetcher: async () => (++calls === 1 ? { status: 409, ok: false } : { status: 201, ok: true }) });
  assert.equal(result.rejected, 1); assert.equal(result.sent, 1); assert.equal(result.pending, 0);
  const status = await deliveryStatus(state); assert.equal(status.total_rejected, 1); assert.equal(status.total_sent, 2); assert.equal(status.last_http_status, 201); assert.equal(status.last_rejected_http_status, 409); assert.ok(!JSON.stringify(status).includes(TOKEN));
  const doctor = await cli(['doctor', '--state-dir', state]); assert.equal(JSON.parse(doctor.stdout).delivery.total_rejected, 1);
});

test('Changing an explicit task on the same native session creates a task-scoped run', async t => {
  const { state } = await fixture(t);
  const base = { type: 'agent-turn-complete', 'thread-id': 'resumed-session' };
  await cli(['notify', '--state-dir', state, JSON.stringify({ ...base, 'turn-id': 'turn-A' })], '', { env: { AMC_TASK_ID: 'task-A' } });
  await cli(['notify', '--state-dir', state, JSON.stringify({ ...base, 'turn-id': 'turn-B' })], '', { env: { AMC_TASK_ID: 'task-B' } });
  const events = await queued(state), a = events.find(event => event.task_id === 'task-A'), b = events.find(event => event.task_id === 'task-B');
  assert.ok(a && b); assert.equal(a.session_id, b.session_id); assert.notEqual(a.run_id, b.run_id);
  await cli(['notify', '--state-dir', state, JSON.stringify({ ...base, 'turn-id': 'turn-C' })]);
  const c = (await queued(state)).filter(event => event.task_id === 'task-B'); assert.equal(c.length, 2); assert.equal(c[0].run_id, c[1].run_id);
});

test('A busy session association skips observation rather than guessing a task identity', async t => {
  const { state, config } = await fixture(t), native = 'busy-session';
  await fs.mkdir(path.join(state, `session-${id('session', config.host_id, 'codex', native)}.lock`));
  const result = await cli(['notify', '--state-dir', state, JSON.stringify({ type: 'agent-turn-complete', 'thread-id': native, 'turn-id': 'busy-turn' })]);
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  await assert.rejects(fs.access(path.join(state, 'queue')));
});
