// Fetch wrapper for the lu-labs.ai cloud APIs: prefixes CLOUD_BASE and
// injects the Supabase bearer token. Direct HTTPS from the WebView (no Tauri
// proxy — the CSP allowlists the cloud hosts, and the server side speaks
// CORS for Tauri origins).

import { CLOUD_BASE } from './config'
import { getAccessToken } from './supabase'

export class CloudJobError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CloudJobError'
    this.status = status
  }
}

export async function jsonOrError<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg =
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `request failed (${res.status})`
    throw new CloudJobError(msg, res.status)
  }
  return body as T
}

export async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken()
  if (!token) throw new CloudJobError('not signed in', 401)
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  return fetch(`${CLOUD_BASE}${path}`, { ...init, headers })
}
