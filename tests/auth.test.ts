import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { app } from '../worker/index';
import { authenticate, configuredHosts, createSession, limitLogin, parsePasswordHash, requireAuthConfig, SESSION_SECONDS, verifyCredentials, verifyPassword } from '../worker/auth';
import { sha256 } from '../worker/protocol';
import type { Env } from '../worker/types';
// @ts-expect-error The offline helper is plain Node ESM.
import { passwordHash } from '../scripts/password-hash.mjs';

let mf: Miniflare;
let db: D1Database;
let env: Env;
let verifier: string;
const username = 'test.admin';
const password = 'synthetic-test-password-only-2026';
const hostToken = 'amc_' + 'f'.repeat(64);
const origin = 'https://console.example';
const cookiePair = (cookie: string) => cookie.split(';')[0];
async function request(path: string, init: RequestInit = {}, settings = env) {
  return app.request(`${origin}${path}`, init, settings);
}
async function login(init: RequestInit = {}, settings = env) {
  return request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify({ username, password }), ...init }, settings);
}
async function signedIn() {
  const response = await login();
  expect(response.status).toBe(200);
  const cookie = cookiePair(response.headers.get('set-cookie')!);
  const me = await request('/api/me', { headers: { Cookie: cookie } });
  const identity = await me.json() as { csrf_token: string; role: string; local: boolean };
  return { cookie, identity };
}
beforeAll(async () => {
  verifier = await passwordHash(password);
  mf = new Miniflare({ modules: true, script: `export default { async fetch(request) { const {password,salt}=await request.json();const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:Uint8Array.from(atob(salt.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)),iterations:100000},key,256);return new Response(btoa(String.fromCharCode(...new Uint8Array(bits))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''));} }`, compatibilityDate: '2026-08-01', d1Databases: ['AUTH_DB'] });
  db = await mf.getD1Database('AUTH_DB') as unknown as D1Database;
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    const migration = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
    let current = ''; let trigger = false;
    for (const line of migration.split('\n')) {
      if (line.trim().startsWith('--') || !line.trim()) continue;
      if (line.trim().startsWith('CREATE TRIGGER')) trigger = true;
      current += line + '\n';
      if ((trigger && line.trim() === 'END;') || (!trigger && line.trim().endsWith(';'))) {
        await db.prepare(current).run(); current = ''; trigger = false;
      }
    }
  }
}, 30_000);
beforeEach(async () => {
  await db.batch([db.prepare('DELETE FROM dashboard_sessions'), db.prepare('DELETE FROM login_attempts')]);
  env = { DB: db, LOCAL_DEV: 'false', DASHBOARD_USERNAME: username, DASHBOARD_PASSWORD_HASH: verifier, SESSION_SECRET: 'synthetic-session-key-not-for-deployment-0123456789', SESSION_VERSION: 'v1', AGENT_TOKENS_JSON: JSON.stringify([{ host_id: 'secure-host', name: 'Secure host', token_hash: await sha256(hostToken) }]), ASSETS: { fetch: async () => new Response('private app') } as unknown as Fetcher };
});
afterAll(async () => { await mf?.dispose(); });

describe('configuration and password verifier', () => {
  it('matches the Node-generated verifier using native Workers WebCrypto',async()=>{
    const [, ,salt,expected]=verifier.split('$');
    const response=await mf.dispatchFetch('http://localhost/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,salt})});
    expect(response.status).toBe(200);expect(await response.text()).toBe(expected);
  });
  it('uses random salted standard PBKDF2-SHA256 matching the helper and Workers ceiling', async () => {
    expect(verifier).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await passwordHash(password)).not.toBe(verifier);
    expect(await verifyPassword(password, verifier)).toBe(true);
    expect(await verifyPassword('wrong-password', verifier)).toBe(false);
    expect(await verifyPassword('', verifier)).toBe(false);
    expect(await verifyPassword('x'.repeat(1025), verifier)).toBe(false);
    await expect(passwordHash('short')).rejects.toThrow();
    await expect(passwordHash('test123')).rejects.toThrow('at least 8');
    expect(await verifyPassword('test1234', await passwordHash('test1234'))).toBe(true);
    // Even a manually configured matching verifier must not accept <8 chars.
    const salt = Buffer.alloc(16, 1);
    const shortHash = `pbkdf2-sha256$100000$${salt.toString('base64url')}$${pbkdf2Sync('test123', salt, 100000, 32, 'sha256').toString('base64url')}`;
    expect(await verifyPassword('test123', shortHash)).toBe(false);
    expect(() => parsePasswordHash(verifier.replace('$100000$', '$600000$'))).toThrow();
    expect(() => parsePasswordHash(verifier.replace('$100000$', '$1$'))).toThrow();
    expect(() => parsePasswordHash('plaintext-password')).toThrow();
  });
  it.each(['DASHBOARD_USERNAME', 'DASHBOARD_PASSWORD_HASH', 'SESSION_SECRET', 'AGENT_TOKENS_JSON'] as const)('fails closed for missing %s on dashboard and ingest', async key => {
    const settings = { ...env, [key]: undefined };
    expect((await request('/api/me', {}, settings)).status).toBe(503);
    expect((await request('/api/events', { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` } }, settings)).status).toBe(503);
    expect((await login({}, settings)).status).toBe(503);
  });
  it('requires an explicit 1–64 character ASCII username without silently trimming it', () => {
    for (const value of ['a', 'Admin.user_1-2', 'a'.repeat(64)]) expect(() => requireAuthConfig({ ...env, DASHBOARD_USERNAME: value })).not.toThrow();
    for (const value of ['', 'a'.repeat(65), ' admin', 'admin ', 'admin\n', 'admin\r', 'admin user', '管理员', '-admin', '_admin', 'admin@example.com']) {
      expect(() => requireAuthConfig({ ...env, DASHBOARD_USERNAME: value })).toThrow('username');
    }
  });
  it('derives the password even for an incorrect username and compares usernames exactly', async () => {
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      expect(await verifyCredentials('wrong.user', password, env)).toBe(false);
      expect(derive).toHaveBeenCalledTimes(1);
      expect(await verifyCredentials(username.toUpperCase(), password, env)).toBe(false);
      expect(await verifyCredentials(` ${username}`, password, env)).toBe(false);
      expect(await verifyCredentials(username, password, env)).toBe(true);
      expect(derive).toHaveBeenCalledTimes(4);
    } finally { derive.mockRestore(); }
  });
  it('accepts an explicitly empty token list to disable ingest; rejects malformed/duplicate config', async () => {
    expect(() => requireAuthConfig({ ...env, AGENT_TOKENS_JSON: '[]' })).not.toThrow();
    for (const value of ['{}', 'null', '[{}]', JSON.stringify([{ host_id: 'h', name: 'Host', token: hostToken }])]) expect(() => configuredHosts({ ...env, AGENT_TOKENS_JSON: value })).toThrow();
    const host = JSON.parse(env.AGENT_TOKENS_JSON!)[0];
    expect(() => configuredHosts({ ...env, AGENT_TOKENS_JSON: JSON.stringify([host, host]) })).toThrow();
    expect(() => requireAuthConfig({ ...env, SESSION_SECRET: 'short' })).toThrow();
    expect(() => requireAuthConfig({ ...env, SESSION_VERSION: '\n' })).toThrow();
    const response = await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` }, body: JSON.stringify({ event_id: 'denied-event', timestamp: new Date().toISOString(), host_id: 'secure-host', agent_type: 'codex', session_id: 'host:secure-host', event_type: 'heartbeat', payload: {} }) }, { ...env, AGENT_TOKENS_JSON: '[]' });
    expect(response.status).toBe(401);
  });
});
describe('fixed-account login and private pages', () => {
  it('serves only login publicly and rejects old Access and host-token dashboard credentials', async () => {
    const page = await request('/login');
    expect(page.status).toBe(200); const html = await page.text(); expect(html).toContain('type="password"'); expect(html).toContain('autocomplete="username"'); expect(html).toContain('minlength="8"'); expect(html).not.toContain(username);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    const root = await request('/'); expect(root.status).toBe(302); expect(root.headers.get('location')).toBe('/login');
    expect((await request('/api/me')).status).toBe(401);
    expect((await request('/api/me', { headers: { 'Cf-Access-Jwt-Assertion': 'old-token', 'Cf-Access-Authenticated-User-Email': 'admin@example.com', Authorization: `Bearer ${hostToken}` } })).status).toBe(401);
  });
  it('overrides asset cache/CSP headers so authenticated content remains private',async()=>{
    const {cookie}=await signedIn();
    const settings={...env,ASSETS:{fetch:async()=>new Response('private asset',{headers:{'Cache-Control':'public, max-age=31536000','Content-Security-Policy':"default-src *",'Referrer-Policy':'unsafe-url'}})} as unknown as Fetcher};
    const response=await request('/assets/private.js',{headers:{Cookie:cookie}},settings);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('rejects missing/foreign/null Origin, sibling sites and insecure production transport', async () => {
    for (const requestOrigin of [undefined, 'null', 'https://evil.example', 'https://console.example.evil']) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (requestOrigin) headers.Origin = requestOrigin;
      expect((await login({ headers })).status).toBe(403);
    }
    expect((await login({ headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' } })).status).toBe(403);
    expect((await app.request('http://console.example/api/auth/login', { method: 'POST', headers: { Origin: 'http://console.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }, env)).status).toBe(403);
    expect((await app.request('http://console.example/api/events', { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` } }, env)).status).toBe(403);
    expect((await app.request('http://console.example/api/me', {}, env)).status).toBe(403);
    const insecureLogin=await app.request('http://console.example/login',{},env);expect(insecureLogin.status).toBe(403);expect(await insecureLogin.text()).not.toContain('type="password"');
  });
  it('validates wrong and malformed inputs without creating a session or echoing password', async () => {
    const response = await login({ body: JSON.stringify({ username, password: 'bad-password' }) });
    expect(response.status).toBe(401); expect(response.headers.has('set-cookie')).toBe(false); expect(await response.text()).not.toContain('bad-password');
    for (const body of ['null', '[]', '{}', JSON.stringify({ password }), JSON.stringify({ username }), JSON.stringify({ username: 12, password }), JSON.stringify({ username, password: 12 }), JSON.stringify({ username, password, extra: true })]) expect((await login({ body })).status).toBe(400);
    expect((await login({ body: 'x'.repeat(17_000) })).status).toBe(400);
    expect(await db.prepare('SELECT count(*) n FROM dashboard_sessions').first()).toMatchObject({ n: 0 });
  });
  it('returns identical credential errors for wrong username, wrong password and both wrong', async () => {
    for (const credentials of [
      { username: 'unknown.user', password },
      { username, password: 'bad-password' },
      { username: 'unknown.user', password: 'bad-password' },
      { username: '', password },
      { username: `${username} `, password },
    ]) {
      const response = await login({ body: JSON.stringify(credentials) });
      expect(response.status).toBe(401); expect(response.headers.has('set-cookie')).toBe(false);
      expect(await response.json()).toEqual({ error: 'Invalid credentials' });
    }
    expect(await db.prepare('SELECT count(*) n FROM dashboard_sessions').first()).toMatchObject({ n: 0 });
  });
  it('requires both unique form fields and gives a generic form credential error', async () => {
    const headers = { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' };
    for (const body of [new URLSearchParams({ password }).toString(), new URLSearchParams({ username }).toString(), `username=${username}&username=other&password=${password}`, `username=${username}&password=${password}&extra=true`]) {
      const response = await login({ headers, body });
      expect(response.status).toBe(400); expect(response.headers.has('set-cookie')).toBe(false);
      expect(await response.json()).toEqual({ error: 'Expected username and password' });
    }
    for (const credentials of [{ username: 'unknown.user', password }, { username, password: 'bad-password' }]) {
      const response = await login({ headers, body: new URLSearchParams(credentials).toString() });
      expect(response.status).toBe(401); expect(response.headers.has('set-cookie')).toBe(false);
      const html = await response.text(); expect(html).toContain('Invalid credentials.');
      expect(html).not.toContain(credentials.username); expect(html).not.toContain(credentials.password);
    }
    expect(await db.prepare('SELECT count(*) n FROM dashboard_sessions').first()).toMatchObject({ n: 0 });
  });
  it('supports an ordinary login form and emits a hardened host-only session cookie', async () => {
    const response = await login({ headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }).toString() });
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/');
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-amc_session=/); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('Secure'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/'); expect(cookie).not.toContain('Domain='); expect(cookie).toContain(`Max-Age=${SESSION_SECONDS}`);
    const me = await request('/api/me', { headers: { Cookie: cookiePair(cookie) } });
    expect(await me.json()).toEqual({ role: 'admin', local: false, csrf_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect((await request('/', { headers: { Cookie: cookiePair(cookie) } })).status).toBe(200);
    const stored = await db.prepare('SELECT * FROM dashboard_sessions').first();
    expect(stored?.id_hash).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(stored)).not.toContain(password); expect(JSON.stringify(stored)).not.toContain(verifier);
  });
});
describe('signed sessions, CSRF, expiry and revocation', () => {
  it('rejects altered/duplicate cookies, unsigned sessions and missing database sessions', async () => {
    const { cookie } = await signedIn();
    const [name, value] = cookie.split('='); const [payload, signature] = value.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); claims.exp += 100;
    const tampered = `${name}=${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
    for (const candidate of [tampered, `${name}=${payload}`, `${cookie}; ${cookie}`, `${name}=${payload}.${'a'.repeat(43)}`]) expect((await request('/api/me', { headers: { Cookie: candidate } })).status).toBe(401);
    await db.prepare('DELETE FROM dashboard_sessions').run();
    expect((await request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
  });
  it('rejects expired sessions, secret rotation, username/password changes and version rotation', async () => {
    const expired = cookiePair(await createSession(env, Date.now() - (SESSION_SECONDS + 10) * 1000));
    expect((await request('/api/me', { headers: { Cookie: expired } })).status).toBe(401);
    const { cookie } = await signedIn();
    for (const settings of [{ ...env, SESSION_SECRET: 'other-synthetic-signing-secret-0123456789' }, { ...env, SESSION_VERSION: 'v2' }, { ...env, DASHBOARD_USERNAME: 'new.admin' }, { ...env, DASHBOARD_PASSWORD_HASH: await passwordHash('different-synthetic-password') }]) {
      expect((await request('/api/me', { headers: { Cookie: cookie } }, settings)).status).toBe(401);
    }
  });
  it('requires both exact Origin and matching session CSRF token for every dashboard mutation', async () => {
    const { cookie, identity } = await signedIn();
    const other = await signedIn();
    for (const headers of ([{}, { Origin: origin }, { Origin: 'https://evil.example', 'X-CSRF-Token': identity.csrf_token }, { Origin: origin, 'X-CSRF-Token': 'wrong' }, { Origin: origin, 'X-CSRF-Token': other.identity.csrf_token }, { Origin: 'null', 'X-CSRF-Token': identity.csrf_token }] as Record<string,string>[])) {
      expect((await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, ...headers } })).status).toBe(403);
      expect((await request('/api/tasks/no-task', { method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: '{"archived":true}' })).status).toBe(403);
    }
    expect((await request('/api/me', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request('/api/auth/logout', { headers: { Cookie: cookie } })).status).toBe(404);
    const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': identity.csrf_token } });
    expect(logout.status).toBe(200); expect(await logout.json()).toEqual({ ok: true }); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await request('/api/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request('/api/me', { headers: { Cookie: other.cookie } })).status).toBe(200);
  });
  it('never treats local-development mode as bypass on a public or HTTPS origin', async () => {
    const settings = { ...env, LOCAL_DEV: 'true' };
    expect((await request('/api/me', {}, settings)).status).toBe(401);
    await expect(authenticate(new Request('http://localhost', { headers: { 'CF-Connecting-IP': '198.51.100.1' } }), settings)).rejects.toThrow();
  });
});
describe('database-backed login throttling', () => {
  it('limits concurrent IP attempts atomically across isolates and permits the next window', async () => {
    const now = 1_800_000_000_000;
    const req = new Request(`${origin}/api/auth/login`, { headers: { 'CF-Connecting-IP': '192.0.2.33' } });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => limitLogin(req, env, now)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(10);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2);
    await expect(limitLogin(req, env, now + 15 * 60 * 1000)).resolves.toBeUndefined();
  });
  it('applies a global budget even to many IPs and does not trust X-Forwarded-For', async () => {
    const now = 1_800_000_000_000;
    const bucket = Math.floor(now / 1000 / 900);
    await db.prepare('INSERT INTO login_attempts (bucket_key,window_id,attempts,expires_at) VALUES (?,?,?,?)').bind('global', bucket, 100, (bucket + 1) * 900).run();
    await expect(limitLogin(new Request(origin, { headers: { 'CF-Connecting-IP': '198.51.100.1' } }), env, now)).rejects.toMatchObject({ retryAfter: expect.any(Number) });
    await db.prepare('DELETE FROM login_attempts').run();
    for (let i = 0; i < 10; i++) await limitLogin(new Request(origin, { headers: { 'X-Forwarded-For': `198.51.100.${i}` } }), env, now);
    await expect(limitLogin(new Request(origin, { headers: { 'X-Forwarded-For': '198.51.100.99' } }), env, now)).rejects.toThrow();
  });
  it('returns Retry-After for blocked login attempts before password verification', async () => {
    const now = Date.now(); const bucket = Math.floor(now / 1000 / 900);
    await db.prepare('INSERT INTO login_attempts (bucket_key,window_id,attempts,expires_at) VALUES (?,?,?,?)').bind(`ip:${await sha256('192.0.2.1')}`, bucket, 10, (bucket + 1) * 900).run();
    const response = await login(); expect(response.status).toBe(429); expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0); expect(response.headers.has('set-cookie')).toBe(false);
  });
});
