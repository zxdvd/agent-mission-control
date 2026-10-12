// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let client: typeof import('../src/lib/api')
let navigation: typeof import('../src/lib/navigation')['navigation']
const csrf = 'synthetic-csrf-token'
const identity = { role: 'admin', local: false, csrf_token: csrf }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(async () => {
  vi.resetModules()
  client = await import('../src/lib/api')
  navigation = (await import('../src/lib/navigation')).navigation
  vi.spyOn(navigation, 'toLogin').mockImplementation(() => {})
  window.history.replaceState({}, '', '/')
  localStorage.clear()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('same-origin session API client', () => {
  it('obtains CSRF before a mutation and preserves Headers values', async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => json(path === '/api/me' ? identity : { ok: true }))
    vi.stubGlobal('fetch', fetcher)
    await client.api('/api/tasks/one', { method: 'PATCH', headers: new Headers({ 'X-Test': 'kept' }), body: JSON.stringify({ name: 'Renamed' }) })
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/me', '/api/tasks/one'])
    const request = vi.mocked(fetch).mock.calls[1][1]
    const headers = new Headers(request?.headers)
    expect(headers.get('X-CSRF-Token')).toBe(csrf)
    expect(headers.get('X-Test')).toBe('kept')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(request?.credentials).toBe('same-origin')
    expect(localStorage.length).toBe(0)
  })

  it('shares a single identity lookup across concurrent mutations', async () => {
    const fetcher = vi.fn(async (path: RequestInfo | URL) => json(path === '/api/me' ? identity : { ok: true }))
    vi.stubGlobal('fetch', fetcher)
    await Promise.all([client.api('/api/tasks/one', { method: 'PATCH' }), client.api('/api/tasks/two', { method: 'DELETE' })])
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/me')).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls.slice(1).every(([, init]) => new Headers(init?.headers).get('X-CSRF-Token') === csrf)).toBe(true)
  })

  it('uses the latest identity token and does not attach it to reads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (path: RequestInfo | URL) => json(path === '/api/me' ? { ...identity, csrf_token: 'updated-token' } : { ok: true })))
    await client.api('/api/me')
    await client.api('/api/overview')
    await client.api('/api/auth/logout', { method: 'post' })
    expect(new Headers(vi.mocked(fetch).mock.calls[1][1]?.headers).has('X-CSRF-Token')).toBe(false)
    expect(new Headers(vi.mocked(fetch).mock.calls[2][1]?.headers).get('X-CSRF-Token')).toBe('updated-token')
  })

  it('fails closed when the identity response has no CSRF token', async () => {
    const fetcher = vi.fn(async () => json({ role: 'admin', local: false }))
    vi.stubGlobal('fetch', fetcher)
    await expect(client.api('/api/tasks/one', { method: 'PATCH' })).rejects.toMatchObject({ status: 403 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/me')
  })

  it('redirects JSON and HTML 401 responses only once per expired session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: 'expired' }, 401)).mockResolvedValueOnce(new Response('Sign in', { status: 401 })))
    await expect(client.api('/api/me')).rejects.toMatchObject({ status: 401 })
    await expect(client.api('/api/overview')).rejects.toMatchObject({ status: 401 })
    expect(navigation.toLogin).toHaveBeenCalledOnce()
  })

  it('redirects an unauthenticated mutation without transmitting the mutation', async () => {
    const fetcher = vi.fn(async () => json({ error: 'expired' }, 401))
    vi.stubGlobal('fetch', fetcher)
    await expect(client.api('/api/tasks/one', { method: 'PATCH' })).rejects.toMatchObject({ status: 401 })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(navigation.toLogin).toHaveBeenCalledOnce()
  })

  it('fetches a new token after a forbidden mutation without automatically retrying it', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(json({ error: 'Invalid CSRF token' }, 403)).mockResolvedValueOnce(json({ ...identity, csrf_token: 'fresh-token' })).mockResolvedValueOnce(json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(client.api('/api/tasks/one', { method: 'PATCH' })).rejects.toMatchObject({ status: 403 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(navigation.toLogin).not.toHaveBeenCalled()
    await client.api('/api/tasks/one', { method: 'PATCH' })
    expect(new Headers(fetcher.mock.calls[3][1]?.headers).get('X-CSRF-Token')).toBe('fresh-token')
  })

  it('rejects cross-origin and non-API destinations before fetching identity or sending a token', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(client.api('https://untrusted.example/api/tasks', { method: 'POST' })).rejects.toMatchObject({ status: 0 })
    await expect(client.api('/outside-api', { method: 'POST' })).rejects.toMatchObject({ status: 0 })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('does not navigate when already on the login page', () => {
    vi.restoreAllMocks()
    window.history.replaceState({}, '', '/login')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    navigation.toLogin()
    expect(window.location.pathname).toBe('/login')
    expect(errors).not.toHaveBeenCalled()
  })
})
