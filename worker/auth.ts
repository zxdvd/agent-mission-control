import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import type { Env, Identity } from './types';
const keySets = new Map<string, JWTVerifyGetKey>();
export function isLoopbackRequest(request: Request, enabled?: string): boolean {
  if (enabled !== 'true') return false;
  const url = new URL(request.url);
  if (url.protocol !== 'http:') return false;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false;
  // Wrangler may inject loopback forwarding headers. Never trust public values.
  const loopback = new Set(['127.0.0.1','::1','[::1]','::ffff:127.0.0.1']);
  const connecting = request.headers.get('CF-Connecting-IP');
  if (connecting && !loopback.has(connecting)) return false;
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor && !forwardedFor.split(',').every(ip=>loopback.has(ip.trim()))) return false;
  if (request.headers.has('Forwarded')) return false;
  const host = request.headers.get('host');
  return !host || host === url.host;
}
export function accessConfig(env: Env): { issuer: string; audience: string } {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error('Access is not configured');
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!/^[a-zA-Z0-9-]+\.cloudflareaccess\.com$/.test(domain)) throw new Error('Invalid Access team domain');
  return { issuer: `https://${domain}`, audience: env.ACCESS_AUD };
}
export async function verifyAccessToken(token: string, env: Env, overrideKey?: JWTVerifyGetKey): Promise<JWTPayload> {
  const { issuer, audience } = accessConfig(env);
  let key = overrideKey ?? keySets.get(issuer);
  if (!key) { key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, key); }
  const { payload } = await jwtVerify(token, key, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'email'], clockTolerance: 5 });
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) throw new Error('Access identity has no email');
  return payload;
}
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  if (isLoopbackRequest(request, env.LOCAL_DEV)) return { role: 'admin', email: 'local@localhost', local: true };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new Error('Authentication required');
  const payload = await verifyAccessToken(token, env);
  const email = (payload.email as string).toLowerCase();
  const admins = (env.ADMIN_EMAILS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  return { role: admins.includes(email) ? 'admin' : 'reader', email, local: false };
}
export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get('origin');
  // JSON + same-origin Origin (when browsers provide one) defeats cookie-based CSRF.
  if (origin && origin !== new URL(request.url).origin) return false;
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}
