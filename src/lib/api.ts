import { navigation } from './navigation'
import type { Identity } from './types'

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); this.name = 'ApiError' } }

let csrfToken: string | null = null
let identityRequest: Promise<Identity> | null = null
let loginRequired = false

export function requireLogin() {
  csrfToken = null
  if (!loginRequired) { loginRequired = true; navigation.toLogin() }
}

async function getCsrfToken() {
  if (csrfToken) return csrfToken
  if (!identityRequest) identityRequest = api<Identity>('/api/me').finally(() => { identityRequest = null })
  const identity = await identityRequest
  if (!identity.csrf_token) throw new ApiError('Could not verify your session. Refresh the page and try again.', 403)
  return identity.csrf_token
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Session tokens must never be sent to a different origin or non-API endpoint.
  const url = new URL(path, window.location.origin)
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) throw new ApiError('API requests must use this application’s origin.', 0)
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
  try {
    const headers = new Headers(options.headers)
    headers.set('Accept', 'application/json')
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
    if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase())) headers.set('X-CSRF-Token', await getCsrfToken())
    const response = await fetch(path, { ...options, signal: controller.signal, credentials: 'same-origin', headers })
    if (response.status === 401) {
      requireLogin()
      throw new ApiError('Your session has expired. Sign in again to continue.', 401)
    }
    const type = response.headers.get('content-type') || ''
    if (!type.includes('application/json')) throw new ApiError(response.status === 403 ? 'This request was not authorized. Refresh the page and try again.' : 'The API did not return JSON. Check that the application and API are served from the same origin.', response.status)
    const data = await response.json() as Record<string, unknown>
    if (!response.ok) {
      if (response.status === 403) csrfToken = null
      const error = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `Request failed (${response.status})`
      throw new ApiError(error, response.status)
    }
    if (url.pathname === '/api/me') {
      csrfToken = typeof data.csrf_token === 'string' && data.csrf_token ? data.csrf_token : null
      loginRequired = false
    }
    return data as T
  } catch (error) {
    if (timedOut) throw new ApiError('The API took too long to respond. Check your connection and retry.', 0)
    throw error
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
