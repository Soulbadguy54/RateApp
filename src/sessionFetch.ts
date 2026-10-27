/** Track the first protected 401 even if a child request settles before
 * the App has finished attaching React effects (notably fast WebKit mocks).
 * Bootstrap/login handle anonymous 401 independently. Mutations are never retried.
 */
let sessionExpired = false
const listeners = new Set<() => void>()

export function subscribeSessionExpiry(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getSessionExpiredSnapshot(): boolean {
  return sessionExpired
}

export function resetSessionExpired(): void {
  sessionExpired = false
  listeners.forEach(listener => listener())
}

function markSessionExpired(): void {
  if (sessionExpired) return
  sessionExpired = true
  listeners.forEach(listener => listener())
}

export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)
  const path = new URL(
    typeof input === 'string' || input instanceof URL ? String(input) : input.url,
    window.location.origin,
  ).pathname
  if (
    response.status === 401
    && path.startsWith('/api/')
    && path !== '/api/bootstrap'
    && !path.startsWith('/api/auth/')
  ) {
    markSessionExpired()
  }
  return response
}
