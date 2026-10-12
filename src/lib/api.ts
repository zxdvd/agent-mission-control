export class ApiError extends Error { constructor(message: string, public status: number) { super(message); this.name = 'ApiError' } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 15000)
  try {
  const response = await fetch(path, { ...options, signal: controller.signal, credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) throw new ApiError(response.status === 401 || response.status === 403 ? 'Your session needs authentication. Sign in through your configured access provider, then retry.' : 'The API did not return JSON. Check that the application and API are served from the same origin.', response.status)
  const data = await response.json() as Record<string, unknown>
  if (!response.ok) {
    const error = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `Request failed (${response.status})`
    throw new ApiError(error, response.status)
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
