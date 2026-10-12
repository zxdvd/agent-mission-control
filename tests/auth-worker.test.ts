import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { sha256 } from '../worker/protocol';
// @ts-expect-error The offline helper is plain Node ESM.
import { passwordHash } from '../scripts/password-hash.mjs';

let mf: Miniflare;
let script: string;
const origin = 'https://console.example';
const password = 'synthetic-workerd-test-password';
const token = 'amc_' + '8'.repeat(64);

beforeAll(async () => {
  const output = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  script = output.outputFiles[0].text;
  // Installed local workerd supports dates through 2026-08-06. This exercises
  // the full deployed-module code path, not Hono running inside Node.
  mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-08-01', d1Databases: ['DB'], bindings: {
    LOCAL_DEV: 'false', DASHBOARD_PASSWORD_HASH: await passwordHash(password), SESSION_SECRET: 'synthetic-workerd-signing-key-0123456789',
    AGENT_TOKENS_JSON: JSON.stringify([{ host_id: 'native-host', name: 'Native host', token_hash: await sha256(token) }]),
  } });
  const db = await mf.getD1Database('DB');
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort()) {
    const text = await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    let current = ''; let trigger = false;
    for (const line of text.split('\n')) {
      if (line.trim().startsWith('--') || !line.trim()) continue;
      if (line.trim().startsWith('CREATE TRIGGER')) trigger = true;
      current += `${line}\n`;
      if ((trigger && line.trim() === 'END;') || (!trigger && line.trim().endsWith(';'))) { await db.prepare(current).run(); current = ''; trigger = false; }
    }
  }
}, 30_000);
afterAll(async () => { await mf?.dispose(); });

describe('full Worker module in workerd', () => {
  it('boots successfully, renders only an HTTPS login form, and protects private APIs', async () => {
    const login = await mf.dispatchFetch(`${origin}/login`);
    expect(login.status).toBe(200); expect(await login.text()).toContain('type="password"');
    expect(login.headers.get('cache-control')).toBe('no-store');
    expect((await mf.dispatchFetch(`${origin}/api/me`)).status).toBe(401);
    const insecure = await mf.dispatchFetch('http://console.example/login');
    expect(insecure.status).toBe(403); expect(await insecure.text()).not.toContain('type="password"');
  });
  it('verifies a Node-generated password, issues a signed cookie, checks CSRF and revokes logout', async () => {
    const login = await mf.dispatchFetch(`${origin}/api/auth/login`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }).toString() });
    expect(login.status).toBe(302);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const me = await mf.dispatchFetch(`${origin}/api/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    const identity = await me.json() as { csrf_token: string; role: string };
    expect(identity.role).toBe('admin'); expect(identity.csrf_token).toHaveLength(43);
    expect((await mf.dispatchFetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } })).status).toBe(403);
    const logout = await mf.dispatchFetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': identity.csrf_token } });
    expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await mf.dispatchFetch(`${origin}/api/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it('authenticates fixed host credentials and retains native D1 idempotence', async () => {
    const body = JSON.stringify({ event_id: 'native-event', timestamp: new Date().toISOString(), host_id: 'native-host', session_id: 'host:native-host', agent_type: 'codex', event_type: 'heartbeat', payload: {} });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body };
    expect((await mf.dispatchFetch(`${origin}/api/events`, init)).status).toBe(201);
    expect((await mf.dispatchFetch(`${origin}/api/events`, init)).status).toBe(200);
    expect((await mf.dispatchFetch('http://console.example/api/events', init)).status).toBe(403);
    expect(await (await mf.getD1Database('DB')).prepare('SELECT name FROM hosts WHERE id=?').bind('native-host').first()).toMatchObject({ name: 'Native host' });
  });
  it('creates a local-development CSRF token only inside a request handler', async () => {
    const local = new Miniflare({ modules: true, script, compatibilityDate: '2026-08-01', bindings: { LOCAL_DEV: 'true', AGENT_TOKENS_JSON: '[]' } });
    try {
      const response = await local.dispatchFetch(new URL('/api/me',await local.ready));
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ local: true, role: 'admin', csrf_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    } finally { await local.dispose(); }
  });
});
