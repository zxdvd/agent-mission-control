// Synthetic live integration check. This script is intentionally outside the unit-test glob.
// Run only against the local-development Worker; it refuses non-loopback/non-local targets.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { id } from '../adapters/core.mjs';

const origin = new URL(process.env.AMC_URL || 'http://127.0.0.1:8787');
if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) throw new Error('Live adapter test only supports loopback development servers.');
const base = origin.origin, cliPath = fileURLToPath(new URL('../adapters/amc.mjs', import.meta.url));
async function api(route, options = {}) {
  const response = await fetch(base + route, { ...options, headers: { origin: base, 'content-type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Local API ${route} returned ${response.status}`);
  return response.json();
}
function cli(args, input = '') {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, AMC_TASK_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; processChild.stdout.on('data', data => stdout += data); processChild.stderr.on('data', data => stderr += data);
    processChild.on('error', reject); processChild.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`Adapter exited ${code}: ${stderr.slice(0, 200)}`))); processChild.stdin.end(input);
  });
}
const me = await api('/api/me'); if (!me.local) throw new Error('Refusing to create synthetic credentials outside local development mode.');
const hostId = `adapter-live-${Date.now().toString(36)}`;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amc-live-'));
try {
  const { token } = await api('/api/admin/hosts', { method: 'POST', body: JSON.stringify({ host_id: hostId, name: 'Synthetic adapter integration host' }) });
  const tokenFile = path.join(dir, 'host-token'); await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 1, host_id: hostId, server: base, token_file: tokenFile, metadata: { name: 'Synthetic live adapter test', project: 'integration-fixture' } }), { mode: 0o600 });
  const notify = { type: 'agent-turn-complete', 'thread-id': 'synthetic-codex-thread', 'turn-id': 'turn-1', 'input-messages': ['ADAPTER_TEST_PRIVATE_PROMPT'], 'last-assistant-message': 'ADAPTER_TEST_PRIVATE_ANSWER', cwd: '/private/not-transmitted' };
  await cli(['notify', '--state-dir', dir, JSON.stringify(notify)]);
  await cli(['notify', '--state-dir', dir, JSON.stringify(notify)]); // real replay path
  await cli(['notify', '--state-dir', dir, JSON.stringify({ ...notify, 'turn-id': 'turn-2' })]);
  const codexTaskId = id('task', hostId, 'codex', notify['thread-id']);
  const codex = await api(`/api/tasks/${codexTaskId}`);
  assert.equal(codex.task.status, 'active'); assert.equal(codex.runs.length, 1); assert.equal(codex.events.filter(event => event.event_type === 'turn_finished').length, 2);
  assert.ok(!JSON.stringify(codex).includes('ADAPTER_TEST_PRIVATE')); assert.ok(!JSON.stringify(codex).includes('/private/not-transmitted'));
  const session = 'synthetic-claude-session';
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop']) {
    const result = await cli(['hook', '--agent', 'claude', '--state-dir', dir], JSON.stringify({ hook_event_name: event, session_id: session, prompt: 'ADAPTER_TEST_PRIVATE_PROMPT', tool_input: { command: 'ADAPTER_TEST_PRIVATE_COMMAND' }, transcript_path: '/private/transcript' }));
    assert.equal(result, '{}\n');
  }
  const claude = await api(`/api/tasks/${id('task', hostId, 'claude', session)}`);
  assert.equal(claude.task.status, 'active'); assert.ok(claude.events.some(event => event.event_type === 'approval_required')); assert.ok(claude.attention.some(item => item.kind === 'approval' && item.state === 'open'));
  assert.ok(!JSON.stringify(claude).includes('ADAPTER_TEST_PRIVATE'));
  const run = codex.runs[0], nativeSessionId = id('session', hostId, 'codex', notify['thread-id']);
  await cli(['complete', '--agent', 'codex', '--task-id', codexTaskId, '--session-id', nativeSessionId, '--run-id', run.id, '--state-dir', dir]);
  assert.equal((await api(`/api/tasks/${codexTaskId}`)).task.status, 'completed');
  await cli(['heartbeat', '--state-dir', dir]);
  const hosts = await api('/api/hosts'); assert.equal(hosts.hosts.find(host => host.id === hostId).online, true);
  const queue = (await fs.readdir(path.join(dir, 'queue'))).filter(name => name.endsWith('.json')); assert.equal(queue.length, 0);
  process.stdout.write('PASS: real adapter CLI → local Worker → D1. Notify replay, run grouping, privacy allowlist, Claude observations, explicit completion and heartbeat verified. Native agents were not launched.\n');
} finally {
  await api(`/api/admin/hosts/${hostId}/credential`, { method: 'DELETE' }).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
}
