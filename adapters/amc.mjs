#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AGENTS, safeId, id, makeEvent, codexNotify, hookEvent, hookEventType } from './core.mjs';
import { LIMITS, defaultStateDir, ensurePrivate, atomicWrite, readJson, readConfig, readToken, validateServer, withLock, deliver, flush, deliveryStatus } from './storage.mjs';
import { detectAgent, installNotify, installHooks, uninstall } from './install.mjs';

const HELP = `Agent Mission Control local adapter (Node.js 20+; macOS/Linux/WSL)

init --server ORIGIN --host-id ID --token-file PATH [--agent codex|claude]
     [--state-dir DIR] [--codex-home DIR] [--claude-home DIR] [--codex-hooks]
     Use --token-stdin instead of --token-file to explicitly save a piped token.
install [--agent codex|claude] [--codex-hooks] [--state-dir DIR]
prepare-codex-hooks [--state-dir DIR]  Write candidate JSON only; installs nothing.
uninstall [--target codex-notify|codex-hooks|claude-hooks|all] [--state-dir DIR]
doctor [--agent codex|claude] [--state-dir DIR]
heartbeat [--agent codex|claude] [--state-dir DIR]
flush [--state-dir DIR]
run --agent codex|claude --task-id ID [--state-dir DIR] -- PROGRAM [ARGS...]
complete --agent codex|claude --task-id ID --session-id ID --run-id ID [--state-dir DIR]
fail --agent codex|claude --task-id ID --session-id ID --run-id ID [--state-dir DIR]

Internal: notify receives Codex JSON as its final argv; hook reads JSON on stdin.
Stop / turn completion / exit 0 never means task completion. Only complete does.
No daemon, transcript scanning, approval action, trust bypass or secret logging.
`;
export function parseArgs(args) {
  const command = args[0] || 'help', options = {}, positional = [], child = [];
  const flags = new Set(['codex-hooks', 'token-stdin', 'amc-managed-v1']);
  const values = new Set(['agent', 'server', 'host-id', 'token-file', 'state-dir', 'codex-home', 'claude-home', 'target', 'task-id', 'session-id', 'run-id', 'name', 'project', 'repo', 'branch']);
  for (let i = 1; i < args.length; i++) {
    const value = args[i];
    if (value === '--') { child.push(...args.slice(i + 1)); break; }
    if (value.startsWith('--')) {
      const key = value.slice(2);
      if (flags.has(key)) options[key] = true;
      else if (values.has(key) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) options[key] = args[++i];
      else throw new Error('Unknown or incomplete option. Run with help.');
    } else positional.push(value);
  }
  return { command, options, positional, child };
}
async function readStdin(limit = LIMITS.inputBytes, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0;
    const cleanup = () => { clearTimeout(timer); process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.off('error', error); process.stdin.pause(); };
    const data = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > limit) { cleanup(); reject(new Error('Input exceeds the size limit.')); } else chunks.push(chunk); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    const error = err => { cleanup(); reject(err); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Input timed out.')); }, timeoutMs);
    process.stdin.on('data', data); process.stdin.on('end', end); process.stdin.on('error', error); process.stdin.resume();
  });
}
function agentOption(options) { const agent = options.agent || 'codex'; if (!AGENTS.has(agent)) throw new Error('Agent must be codex or claude.'); return agent; }
function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
async function installFromOptions(stateDir, options) {
  const agent = agentOption(options);
  if (agent === 'claude') return installHooks(stateDir, agent, options['claude-home']);
  if (options['codex-hooks']) return installHooks(stateDir, 'codex', options['codex-home']);
  return installNotify(stateDir, options['codex-home']);
}
async function initialize(stateDir, options) {
  if (!options.server || !options['host-id'] || (!options['token-file'] && !options['token-stdin'])) throw new Error('init requires --server, --host-id, and --token-file (or --token-stdin).');
  if (options['token-file'] && options['token-stdin']) throw new Error('Choose one token source.');
  await ensurePrivate(stateDir);
  const tokenFile = options['token-stdin'] ? path.join(stateDir, 'host-token') : path.resolve(options['token-file']);
  const config = { version: 1, server: validateServer(options.server), host_id: safeId(options['host-id'], 'host ID'), token_file: tokenFile, metadata: {} };
  for (const key of ['name', 'project', 'repo', 'branch']) if (options[key]) {
    if (/[\x00-\x1f\x7f]/.test(options[key]) || options[key].length > 160) throw new Error('Metadata labels must be short and contain no control characters.');
    if (key === 'repo' && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options[key])) throw new Error('Repository must be owner/name without a remote URL or credentials.');
    config.metadata[key] = options[key];
  }
  const existing = await readJson(path.join(stateDir, 'config.json'), null);
  if (existing && (existing.server !== config.server || existing.host_id !== config.host_id || existing.token_file !== config.token_file)) throw new Error('Connection already exists with a different server, host ID, or token path. Use a separate --state-dir or review the local config manually.');
  if (options['token-stdin']) {
    const token = (await readStdin(8192, 30000)).trim();
    if (!/^[A-Za-z0-9_.-]{32,256}$/.test(token)) throw new Error('Host token is missing or invalid.');
    await atomicWrite(tokenFile, `${token}\n`);
  }
  await readToken(config); // Validate locally; initialization never sends a credential.
  if (existing && !Object.keys(config.metadata).length) config.metadata = existing.metadata || {};
  await atomicWrite(path.join(stateDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const installed = await installFromOptions(stateDir, options);
  return { ...installed, connection: 'Configured locally. No network request made.', detected: detectAgent(agentOption(options)) };
}
async function eventContext(stateDir, config, agent, input, type, options) {
  const native = input.session_id;
  if (typeof native !== 'string' || !native || native.length > 1024) return {};
  const sessionId = id('session', config.host_id, agent, native);
  const taskId = options['task-id'] || process.env.AMC_TASK_ID;
  if (taskId) safeId(taskId, 'task ID');
  let runId;
  const dir = path.join(stateDir, 'sessions'); await ensurePrivate(dir);
  const locked = await withLock(stateDir, `session-${sessionId}`, async () => {
    const file = path.join(dir, `${sessionId}.json`);
    let record = await readJson(file, {});
    // A run is a session attempt, not a turn. New turns retain the same run ID.
    const resolvedTask = taskId || record.task_id || id('task', config.host_id, agent, native);
    runId = record.task_id === resolvedTask && record.run_id ? record.run_id : id('run', config.host_id, agent, native, resolvedTask, 'session-run');
    record = { run_id: runId, task_id: resolvedTask, seen_at: Date.now() };
    await atomicWrite(file, JSON.stringify(record));
    // Keep only small metadata records, at most 500 sessions and 30 days.
    const names = (await fs.readdir(dir)).filter(name => /^session_[a-f0-9]{32}\.json$/.test(name));
    const stats = await Promise.all(names.map(async name => ({ name, stat: await fs.stat(path.join(dir, name)).catch(() => null) })));
    stats.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));
    for (let index = 0; index < stats.length; index++) if (index >= 500 || Date.now() - (stats[index].stat?.mtimeMs || 0) > 30 * 86400000) await fs.rm(path.join(dir, stats[index].name), { force: true });
    if (!taskId && record.task_id) options['task-id'] = record.task_id;
    return { updated: true };
  });
  if (locked?.busy) throw new Error('Session association is busy; skipping telemetry rather than guessing identifiers.');
  const resolvedTask = taskId || options['task-id'] || id('task', config.host_id, agent, native);
  return { taskId: resolvedTask, runId: runId || id('run', config.host_id, agent, native, resolvedTask, 'session-run') };
}
async function handleNotify(stateDir, options, positional) {
  const raw = positional.at(-1); if (!raw || Buffer.byteLength(raw) > LIMITS.inputBytes) return;
  const input = JSON.parse(raw), config = await readConfig(stateDir);
  const context = await eventContext(stateDir, config, 'codex', { session_id: input['thread-id'] }, 'turn_finished', options);
  const event = codexNotify(config, input, context);
  if (event) await deliver(stateDir, config, [event]);
}
async function handleHook(stateDir, options) {
  const input = JSON.parse(await readStdin()), agent = agentOption(options), config = await readConfig(stateDir);
  const type = hookEventType(agent, input); if (!type) return;
  const context = await eventContext(stateDir, config, agent, input, type, options);
  const event = hookEvent(config, agent, input, context);
  if (event) await deliver(stateDir, config, [event]);
}
function heartbeat(config, agent) { return makeEvent(config, agent, 'heartbeat', 'host', { sessionId: `host:${config.host_id}`, source: 'heartbeat' }); }
async function runWrapped(stateDir, options, command) {
  if (!command.length || !options['task-id']) throw new Error('run requires --task-id and -- PROGRAM [ARGS...].');
  const agent = agentOption(options), taskId = safeId(options['task-id'], 'task ID');
  let config; try { config = await readConfig(stateDir); } catch { /* Telemetry misconfiguration must not prevent the user's command. */ }
  const nativeSession = `wrapper-${randomUUID()}`, runId = `run_${randomUUID()}`;
  const emit = async (type, extra = {}) => {
    if (!config) return;
    try { await deliver(stateDir, config, [type === 'heartbeat' ? heartbeat(config, agent) : makeEvent(config, agent, type, nativeSession, { taskId, runId, source: 'wrapper', inferred: true, ...extra })]); } catch {}
  };
  // Reports process activity, not model activity. This is a separate launcher session.
  await emit('session_started'); await emit('turn_started');
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false, env: { ...process.env, AMC_TASK_ID: taskId } });
  let beatPending = false;
  const timer = setInterval(async () => { if (beatPending) return; beatPending = true; try { await emit('heartbeat'); } finally { beatPending = false; } }, 30000);
  const signalHandlers = new Map();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { const fn = () => { if (!child.killed) child.kill(sig); }; signalHandlers.set(sig, fn); process.on(sig, fn); }
  const result = await new Promise(resolve => { child.once('error', () => resolve({ code: 127 })); child.once('exit', (code, signal) => resolve({ code: code ?? (signal === 'SIGINT' ? 130 : 143) })); });
  clearInterval(timer); for (const [sig, fn] of signalHandlers) process.off(sig, fn);
  // A normal process exit, even exit 0, is not evidence that a user task is complete.
  await emit('turn_finished', { exitCode: result.code }); await emit('session_ended', { exitCode: result.code });
  process.stderr.write(`Mission Control launcher ended (exit ${result.code}). Task remains open; mark complete explicitly after review.\n`);
  return result.code;
}
export async function main(args = process.argv.slice(2)) {
  const parsed = parseArgs(args), { command, options, positional, child } = parsed;
  const stateDir = path.resolve(options['state-dir'] || process.env.AMC_STATE_DIR || defaultStateDir());
  if (command === 'help' || command === '--help') { process.stdout.write(HELP); return 0; }
  if (command === 'init') output(await initialize(stateDir, options));
  else if (command === 'install') { await readConfig(stateDir); output(await installFromOptions(stateDir, options)); }
  else if (command === 'prepare-codex-hooks') output(await installHooks(stateDir, 'codex', options['codex-home'], { prepareOnly: true }));
  else if (command === 'uninstall') output(await uninstall(stateDir, options.target || 'all'));
  else if (command === 'doctor') {
    let configured = false, tokenReadable = false;
    try { const config = await readConfig(stateDir); configured = true; await readToken(config); tokenReadable = true; } catch {}
    output({ ...detectAgent(agentOption(options)), configured, token_readable: tokenReadable, delivery: await deliveryStatus(stateDir), permissions: 'Observe only. This adapter cannot approve, reject, send input, or control an agent.', heartbeat: 'No daemon. Run heartbeat via an OS scheduler for host presence while agents are idle.' });
  }
  else if (command === 'notify') await handleNotify(stateDir, options, positional);
  else if (command === 'hook') await handleHook(stateDir, options);
  else if (command === 'heartbeat' || command === 'flush') {
    const config = await readConfig(stateDir);
    output(command === 'flush' ? await flush(stateDir, config) : await deliver(stateDir, config, [heartbeat(config, agentOption(options))]));
  }
  else if (command === 'complete' || command === 'fail') {
    const config = await readConfig(stateDir), agent = agentOption(options);
    for (const key of ['task-id', 'session-id', 'run-id']) if (!options[key]) throw new Error(`${command} requires --${key}. Copy identifiers from the task detail page.`);
    const event = makeEvent(config, agent, command === 'complete' ? 'task_completed' : 'task_failed', 'manual', {
      sessionId: safeId(options['session-id'], 'session ID'), taskId: safeId(options['task-id'], 'task ID'), runId: safeId(options['run-id'], 'run ID'), source: 'manual', explicit: true,
    });
    output(await deliver(stateDir, config, [event]));
  }
  else if (command === 'run') return runWrapped(stateDir, options, child);
  else throw new Error('Unknown command. Run with help.');
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const hookMode = process.argv[2] === 'hook', notifyMode = process.argv[2] === 'notify';
  // A telemetry hook must always finish promptly and fail open, even on malformed config,
  // malformed input, an unavailable server, a full queue or a credential failure.
  const timeout = hookMode || notifyMode ? setTimeout(() => { if (hookMode) process.stdout.write('{}\n'); process.exit(0); }, 2800) : null;
  try { const code = await main(); if (timeout) clearTimeout(timeout); if (hookMode) process.stdout.write('{}\n'); process.exitCode = code; }
  catch (error) {
    if (timeout) clearTimeout(timeout);
    if (hookMode) process.stdout.write('{}\n');
    if (hookMode || notifyMode) process.exitCode = 0;
    else { process.stderr.write(`Mission Control: ${error.message || 'Command failed.'}\n`); process.exitCode = 1; }
  }
}
