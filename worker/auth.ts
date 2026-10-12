import { safeText, sha256, validateId } from './protocol';
import type { Env, Identity } from './types';

// Workers' production PBKDF2 ceiling is 100,000 iterations. Keep this standard
// PBKDF2 construction (never chain custom KDFs); use a long random password.
// https://github.com/cloudflare/workerd/issues/1346
export const PASSWORD_ITERATIONS = 100_000;
export const SESSION_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE = '__Host-amc_session';
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
let localCsrf: string | undefined;
const encoder = new TextEncoder();
export class AuthConfigError extends Error {}
export class AuthError extends Error {}
export class LoginRateLimitError extends Error {
  constructor(readonly retryAfter: number) { super('Too many login attempts. Try again later.'); }
}
export type HostCredential = { host_id: string; name: string; token_hash: string };
type PasswordHash = { salt: Uint8Array<ArrayBuffer>; hash: Uint8Array<ArrayBuffer> };
type SessionClaims = { sid: string; exp: number; version: string };

function encode64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decode64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new AuthError('Invalid encoding');
  const result = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (encode64(result) !== value) throw new AuthError('Invalid encoding');
  return result;
}
function randomToken(): string { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
export function isLoopbackRequest(request: Request, enabled?: string): boolean {
  if (enabled !== 'true') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'http:') return false;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  const loopback = new Set(['127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']);
  const connecting = request.headers.get('CF-Connecting-IP');
  if (connecting && !loopback.has(connecting)) return false;
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor && !forwardedFor.split(',').every(ip => loopback.has(ip.trim()))) return false;
  if (request.headers.has('Forwarded')) return false;
  const host = request.headers.get('host');
  return !host || host === url.host;
}
export function parsePasswordHash(value?: string): PasswordHash {
  try {
    const parts = (value ?? '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256' || parts[1] !== String(PASSWORD_ITERATIONS)) throw new Error();
    const salt = decode64(parts[2]); const hash = decode64(parts[3]);
    if (salt.length !== 16 || hash.length !== 32) throw new Error();
    return { salt, hash };
  } catch { throw new AuthConfigError('Dashboard password verifier is not configured correctly'); }
}
export function configuredHosts(env: Env): HostCredential[] {
  try {
    if (!env.AGENT_TOKENS_JSON || env.AGENT_TOKENS_JSON.length > 64_000) throw new Error();
    const hosts: unknown = JSON.parse(env.AGENT_TOKENS_JSON);
    if (!Array.isArray(hosts) || hosts.length > 100) throw new Error();
    const ids = new Set<string>(); const hashes = new Set<string>();
    return hosts.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 || Object.keys(value).some(k => !['host_id', 'name', 'token_hash'].includes(k))) throw new Error();
      validateId(value.host_id, 'host_id');
      const name = safeText(value.name, 'name');
      if (!name.trim() || typeof value.token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.token_hash) || ids.has(value.host_id) || hashes.has(value.token_hash)) throw new Error();
      ids.add(value.host_id); hashes.add(value.token_hash);
      return { host_id: value.host_id, name, token_hash: value.token_hash };
    });
  } catch { throw new AuthConfigError('Host credentials are not configured correctly'); }
}
export function requireAuthConfig(env: Env): void {
  if (typeof env.DASHBOARD_USERNAME !== 'string' || env.DASHBOARD_USERNAME.trim() !== env.DASHBOARD_USERNAME || !USERNAME_PATTERN.test(env.DASHBOARD_USERNAME)) throw new AuthConfigError('Dashboard username is not configured correctly');
  parsePasswordHash(env.DASHBOARD_PASSWORD_HASH);
  if (!env.SESSION_SECRET || encoder.encode(env.SESSION_SECRET).length < 32 || env.SESSION_SECRET.length > 1024) throw new AuthConfigError('Session signing secret is not configured correctly');
  if (env.SESSION_VERSION !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(env.SESSION_VERSION)) throw new AuthConfigError('Invalid session version');
  configuredHosts(env);
}
export async function verifyPassword(password: string, verifier: string): Promise<boolean> {
  const { salt, hash } = parsePasswordHash(verifier);
  if (encoder.encode(password).length > 1024 || password.length < 8) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS }, key, 256));
  return equal(derived, hash);
}
export async function verifyCredentials(username: string, password: string, env: Env): Promise<boolean> {
  requireAuthConfig(env);
  // Never skip password derivation because the username is wrong. Fixed-length
  // digests also keep the account comparison independent of its prefix/length.
  const [providedName, expectedName, validPassword] = await Promise.all([
    sha256(username), sha256(env.DASHBOARD_USERNAME!), verifyPassword(password, env.DASHBOARD_PASSWORD_HASH!),
  ]);
  const validUsername = equal(encoder.encode(providedName), encoder.encode(expectedName));
  return validUsername && validPassword;
}
async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(env.SESSION_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function configVersion(env: Env): Promise<string> {
  // Changing either credential invalidates every existing session. Structured
  // encoding keeps boundaries unambiguous as configuration evolves.
  return sha256(JSON.stringify([env.SESSION_VERSION ?? '1', env.DASHBOARD_USERNAME, env.DASHBOARD_PASSWORD_HASH]));
}
async function csrfToken(sid: string, env: Env): Promise<string> {
  return encode64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(`csrf:${sid}`))));
}
export async function createSession(env: Env, now = Date.now()): Promise<string> {
  requireAuthConfig(env);
  const claims: SessionClaims = { sid: randomToken(), exp: Math.floor(now / 1000) + SESSION_SECONDS, version: await configVersion(env) };
  const payload = encode64(encoder.encode(JSON.stringify(claims)));
  const signature = encode64(new Uint8Array(await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload))));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?').bind(Math.floor(now / 1000)),
    env.DB.prepare('INSERT INTO dashboard_sessions (id_hash,expires_at,config_version,created_at) VALUES (?,?,?,?)').bind(await sha256(claims.sid), claims.exp, claims.version, new Date(now).toISOString()),
  ]);
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}
export function clearSessionCookie(): string { return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
export async function authenticate(request: Request, env: Env, now = Date.now()): Promise<Identity> {
  if (isLoopbackRequest(request, env.LOCAL_DEV)) return { role: 'admin', email: 'local@localhost', local: true, csrf_token: localCsrf ??= randomToken() };
  requireAuthConfig(env);
  if (new URL(request.url).protocol !== 'https:') throw new AuthError('HTTPS required');
  const cookies = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${SESSION_COOKIE}=`));
  if (cookies.length !== 1 || cookies[0].length > 2048) throw new AuthError('Authentication required');
  let claims: SessionClaims;
  try {
    const pieces = cookies[0].slice(SESSION_COOKIE.length + 1).split('.');
    if (pieces.length !== 2 || !await crypto.subtle.verify('HMAC', await signingKey(env), decode64(pieces[1]), encoder.encode(pieces[0]))) throw new Error();
    claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode64(pieces[0])));
    if (!claims || !/^[A-Za-z0-9_-]{43}$/.test(claims.sid) || !Number.isInteger(claims.exp) || claims.exp <= now / 1000 || claims.exp > Math.floor(now / 1000) + SESSION_SECONDS || claims.version !== await configVersion(env)) throw new Error();
  } catch { throw new AuthError('Invalid or expired session'); }
  const sessionHash = await sha256(claims.sid);
  const stored = await env.DB.prepare('SELECT expires_at FROM dashboard_sessions WHERE id_hash=? AND expires_at=? AND config_version=?').bind(sessionHash, claims.exp, claims.version).first();
  if (!stored) throw new AuthError('Session was revoked');
  return { role: 'admin', local: false, csrf_token: await csrfToken(claims.sid, env), sessionHash };
}
export async function revokeSession(identity: Identity, env: Env): Promise<void> {
  if (identity.sessionHash) await env.DB.prepare('DELETE FROM dashboard_sessions WHERE id_hash=?').bind(identity.sessionHash).run();
}
export function sameOriginMutation(request: Request): boolean {
  return request.headers.get('origin') === new URL(request.url).origin && !['cross-site', 'same-site'].includes(request.headers.get('sec-fetch-site') ?? '');
}
export function validCsrf(request: Request, identity: Identity): boolean {
  const token = request.headers.get('X-CSRF-Token');
  return sameOriginMutation(request) && !!token && equal(encoder.encode(token), encoder.encode(identity.csrf_token));
}
export async function limitLogin(request: Request, env: Env, now = Date.now()): Promise<void> {
  const windowSeconds = 15 * 60;
  const bucket = Math.floor(now / 1000 / windowSeconds);
  const expires = (bucket + 1) * windowSeconds;
  // Only Cloudflare's edge-provided IP is trusted. Missing IPs share one bucket;
  // X-Forwarded-For never creates attacker-controlled fresh rate-limit buckets.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const ipKey = `ip:${await sha256(ip)}`;
  const queries = [
    env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(Math.floor(now / 1000)),
    ...[['global', 100], [ipKey, 10]].map(([key, limit]) => env.DB.prepare(`INSERT INTO login_attempts (bucket_key,window_id,attempts,expires_at) VALUES (?,?,1,?)
      ON CONFLICT(bucket_key,window_id) DO UPDATE SET attempts=min(attempts+1,?) RETURNING attempts`).bind(key, bucket, expires, Number(limit) + 1)),
  ];
  // D1 batch executes serially in one transaction, so concurrent attempts cannot
  // all pass a read-before-write counter check. Successes also consume budget.
  const result = await env.DB.batch<{ attempts: number }>(queries);
  if (result[1].results[0].attempts > 100 || result[2].results[0].attempts > 10) throw new LoginRateLimitError(Math.max(1, expires - Math.floor(now / 1000)));
}
export function loginHtml(message = ''): string {
  // Only hardcoded server messages reach this document; no user input is echoed.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Agent Mission Control</title><style>body{margin:0;background:#10131a;color:#eef2ff;font:16px system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:360px;width:calc(100% - 64px);padding:32px;background:#191f2b;border:1px solid #343d50;border-radius:18px}h1{font-size:24px}p{line-height:1.5;color:#b8c1d7}label{display:block;margin:20px 0 8px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;font:inherit}input{background:#10131a;color:#fff;border:1px solid #65728e}button{margin-top:16px;background:#b6c6ff;border:0;cursor:pointer;font-weight:600}.error{color:#ffb0b0}</style></head><body><main><h1>Agent Mission Control</h1><p>Sign in with your dashboard username and password.</p>${message ? `<p class="error" role="alert">${message}</p>` : ''}<form method="post" action="/api/auth/login"><label for="username">Username</label><input id="username" name="username" type="text" required autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" autofocus><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password" minlength="8" maxlength="1024"><button type="submit">Sign in</button></form><p>Single-account MVP: this account has administrator access.</p></main></body></html>`;
}
