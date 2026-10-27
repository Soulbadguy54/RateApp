/** A single signal for protected API requests that discover an expired login.
 * Bootstrap/login handle anonymous 401 themselves. Never retry a failed mutation.
 */
export const SESSION_EXPIRED_EVENT = 'rateapp:session-expired'

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
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
  }
  return response
}
