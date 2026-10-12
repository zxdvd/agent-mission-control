import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

export const LIMITS = { maxFiles: 200, maxBytes: 512 * 1024, maxEventBytes: 8192, maxAgeMs: 7 * 86400000, networkTimeoutMs: 550, deliveryBudgetMs: 1700, maxSends: 3, inputBytes: 1024 * 1024 };
export const defaultStateDir = () => path.join(os.homedir(), '.agent-mission-control');
export async function ensurePrivate(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('State directory must be a real directory.');
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
}
export async function atomicWrite(file, contents, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Refusing to replace a symlink.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, contents, { mode, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export function validateServer(value) {
  const url = new URL(value);
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback.has(url.hostname))) throw new Error('Use HTTPS, or HTTP on loopback for development.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Server must be a plain origin without credentials, query, or path.');
  return url.origin;
}
export async function readConfig(stateDir) {
  const config = await readJson(path.join(stateDir, 'config.json'));
  config.server = validateServer(config.server);
  if (typeof config.token_file !== 'string' || !path.isAbsolute(config.token_file)) throw new Error('Invalid token file.');
  return config;
}
export async function readToken(config) {
  const stat = await fs.lstat(config.token_file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Token file must be a private regular file (chmod 600).');
  const token = (await fs.readFile(config.token_file, 'utf8')).trim();
  if (!/^[A-Za-z0-9_.-]{32,256}$/.test(token)) throw new Error('Host token is missing or invalid.');
  return token;
}
export async function withLock(dir, name, callback) {
  await ensurePrivate(dir);
  const lock = path.join(dir, `${name}.lock`);
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Recover only our own stale lock. Bounded retries; hooks never wait on it.
    const stat = await fs.lstat(lock).catch(() => null);
    if (stat?.isDirectory() && Date.now() - stat.mtimeMs > 30000) {
      await fs.rmdir(lock).catch(() => {});
      try { await fs.mkdir(lock, { mode: 0o700 }); } catch { return { busy: true }; }
    } else return { busy: true };
  }
  try { return await callback(); } finally { await fs.rmdir(lock).catch(() => {}); }
}
async function listQueue(dir) {
  const names = (await fs.readdir(dir)).filter(name => /^\d{13}-[a-zA-Z0-9_-]+\.json$/.test(name)).sort();
  const files = [];
  for (const name of names) {
    const file = path.join(dir, name); const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    files.push({ file, name, size: stat.size, timestamp: Number(name.slice(0, 13)) });
  }
  return files;
}
async function pruneQueue(dir) {
  let files = await listQueue(dir), bytes = files.reduce((sum, item) => sum + item.size, 0);
  let count = files.length, dropped = 0;
  for (const item of files) {
    if (count > LIMITS.maxFiles || bytes > LIMITS.maxBytes || Date.now() - item.timestamp > LIMITS.maxAgeMs || item.size > LIMITS.maxEventBytes) {
      await fs.rm(item.file, { force: true }); count--; bytes -= item.size; dropped++;
    }
  }
  return dropped;
}
export async function enqueue(stateDir, event) {
  if (typeof event?.event_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.event_id)) throw new Error('Invalid event ID.');
  let data = JSON.stringify(event);
  if (Buffer.byteLength(data) > LIMITS.maxEventBytes) throw new Error('Event exceeds metadata size limit.');
  const dir = path.join(stateDir, 'queue'); await ensurePrivate(dir);
  return withLock(stateDir, 'queue-write', async () => {
    // Codex can replay the same turn notification. Preserve its entire original
    // envelope so backend idempotency fingerprints (including timestamp) match.
    if (/^event_[a-f0-9]{32}$/.test(event.event_id)) {
      const cacheFile = path.join(stateDir, 'notify-dedupe.json');
      const cache = await readJson(cacheFile, {});
      if (cache[event.event_id]?.body) data = cache[event.event_id].body;
      else cache[event.event_id] = { at: Date.now(), body: data };
      const entries = Object.entries(cache).filter(([, value]) => Date.now() - value.at <= LIMITS.maxAgeMs).sort((a, b) => b[1].at - a[1].at);
      const retained = {}; let bytes = 0;
      for (const [key, value] of entries.slice(0, 128)) {
        bytes += Buffer.byteLength(value.body);
        if (bytes > LIMITS.maxBytes) break;
        retained[key] = value;
      }
      await atomicWrite(cacheFile, JSON.stringify(retained));
    }
    await atomicWrite(path.join(dir, `${Date.now()}-${event.event_id}.json`), data);
    const dropped = await pruneQueue(dir);
    return { queued: true, dropped };
  });
}
export async function flush(stateDir, config, options = {}) {
  return withLock(stateDir, 'delivery', async () => {
    const dir = path.join(stateDir, 'queue'); await ensurePrivate(dir);
    const token = await readToken(config);
    const started = Date.now(); let sent = 0, attempts = 0, rejected = 0, lastStatus = null, lastRejectedStatus = null;
    const fetcher = options.fetcher || fetch;
    const files = (await listQueue(dir)).slice(0, LIMITS.maxSends);
    for (const item of files) {
      if (Date.now() - started >= LIMITS.deliveryBudgetMs) break;
      if (item.size > LIMITS.maxEventBytes || Date.now() - item.timestamp > LIMITS.maxAgeMs) { await fs.rm(item.file, { force: true }); continue; }
      const body = await fs.readFile(item.file, 'utf8').catch(() => null); if (!body) continue;
      // No redirects: a redirect must never forward the host credential elsewhere.
      let response;
      for (let retry = 0; retry < 2; retry++) {
        const remaining = LIMITS.deliveryBudgetMs - (Date.now() - started); if (remaining <= 0) break;
        attempts++;
        try { response = await fetcher(`${config.server}/api/events`, {
          method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body,
          signal: AbortSignal.timeout(Math.min(LIMITS.networkTimeoutMs, remaining)),
        }); } catch { response = null; }
        if (response?.body) await response.body.cancel().catch(() => {});
        if (response && response.status < 500) break;
      }
      lastStatus = response?.status || null;
      if (response?.ok) { await fs.rm(item.file, { force: true }); sent++; }
      else if (response && [400, 409, 413, 422].includes(response.status)) { await fs.rm(item.file, { force: true }); rejected++; lastRejectedStatus = response.status; }
      else break; // 401/403/redirect/rate-limit/network: retain safely for later.
    }
    const pending = (await listQueue(dir)).length;
    const previous = await readJson(path.join(stateDir, 'delivery-status.json'), {}).catch(() => ({}));
    // Only counters/status codes; never retain response bodies, headers or credentials.
    await atomicWrite(path.join(stateDir, 'delivery-status.json'), JSON.stringify({
      last_attempt_at: new Date().toISOString(),
      total_sent: Math.max(0, Number(previous.total_sent) || 0) + sent,
      total_rejected: Math.max(0, Number(previous.total_rejected) || 0) + rejected,
      last_http_status: lastStatus, last_rejected_http_status: lastRejectedStatus || previous.last_rejected_http_status || null, pending,
    }));
    return { sent, attempts, rejected, pending };
  });
}
export async function deliver(stateDir, config, events, options = {}) {
  for (const event of events.filter(Boolean)) await enqueue(stateDir, event);
  return flush(stateDir, config, options);
}

export async function deliveryStatus(stateDir) {
  const value = await readJson(path.join(stateDir, 'delivery-status.json'), {}).catch(() => ({}));
  return {
    last_attempt_at: typeof value.last_attempt_at === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(value.last_attempt_at) ? value.last_attempt_at : null,
    total_sent: Number.isSafeInteger(value.total_sent) && value.total_sent >= 0 ? value.total_sent : 0,
    total_rejected: Number.isSafeInteger(value.total_rejected) && value.total_rejected >= 0 ? value.total_rejected : 0,
    last_http_status: Number.isInteger(value.last_http_status) && value.last_http_status >= 100 && value.last_http_status <= 599 ? value.last_http_status : null,
    last_rejected_http_status: [400, 409, 413, 422].includes(value.last_rejected_http_status) ? value.last_rejected_http_status : null,
    pending: Number.isSafeInteger(value.pending) && value.pending >= 0 ? value.pending : 0,
  };
}
