import { describe, it, expect, vi, beforeEach } from 'vitest'

// Cloud client: bearer injection, base-URL prefixing, error mapping, and the
// jobs wrappers on top. getAccessToken is mocked (no live Supabase); fetch is
// stubbed per test.

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock('../supabase', () => ({ getAccessToken }))

import { cloudFetch, jsonOrError, CloudJobError } from '../client'
import { submitCloudJob, uploadInput, getJob, getQuota } from '../jobs'
import { CLOUD_BASE } from '../config'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  getAccessToken.mockResolvedValue('tok-123')
})

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cloudFetch', () => {
  it('prefixes CLOUD_BASE and injects the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonRes({ ok: true }))
    await cloudFetch('/api/me')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/me`)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123')
  })

  it('throws a 401 CloudJobError when signed out (no network call)', async () => {
    getAccessToken.mockResolvedValue(null)
    await expect(cloudFetch('/api/me')).rejects.toMatchObject({
      name: 'CloudJobError',
      status: 401,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('preserves method, body and extra headers', async () => {
    fetchMock.mockResolvedValue(jsonRes({}))
    await cloudFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"x":1}',
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"x":1}')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })
})

describe('jsonOrError', () => {
  it('returns the parsed body on 2xx', async () => {
    await expect(jsonOrError(jsonRes({ id: 'j1' }, 202))).resolves.toEqual({ id: 'j1' })
  })

  it('maps { error } bodies to CloudJobError with the status', async () => {
    const err = await jsonOrError(jsonRes({ error: 'monthly credit budget exhausted' }, 429)).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CloudJobError)
    expect((err as CloudJobError).status).toBe(429)
    expect((err as CloudJobError).message).toBe('monthly credit budget exhausted')
  })

  it('falls back to a generic message on non-JSON error bodies', async () => {
    const res = new Response('gateway timeout', { status: 504 })
    const err = await jsonOrError(res).catch((e: unknown) => e)
    expect((err as CloudJobError).message).toBe('request failed (504)')
  })
})

describe('jobs wrappers', () => {
  it('submitCloudJob posts the submit payload and returns id + quota', async () => {
    fetchMock.mockResolvedValue(jsonRes({ id: 'j1', quota: { cost: 5, used: 10, limit: 800 } }, 202))
    const out = await submitCloudJob({
      kind: 'image',
      model: 'flux-schnell',
      prompt: 'a lighthouse',
      params: { op: 'generate' },
    })
    expect(out.id).toBe('j1')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/jobs`)
    expect(JSON.parse(String(init.body)).model).toBe('flux-schnell')
  })

  it('uploadInput sends raw bytes with the role in the query and returns the path', async () => {
    fetchMock.mockResolvedValue(jsonRes({ path: 'uid/abc.png', role: 'source' }, 201))
    const path = await uploadInput(new Blob(['x']), 'source')
    expect(path).toBe('uid/abc.png')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${CLOUD_BASE}/api/jobs/upload?role=source`)
    // WKWebView fails cross-origin FormData(Blob) bodies — the contract is a
    // bare ArrayBuffer with the octet-stream content type.
    expect(init.body).toBeInstanceOf(ArrayBuffer)
    expect((init.headers as Headers).get('content-type')).toBe('application/octet-stream')
  })

  it('getJob unwraps { job } and encodes the id', async () => {
    fetchMock.mockResolvedValue(jsonRes({ job: { id: 'j 1', status: 'queued' } }))
    const job = await getJob('j 1')
    expect(job.id).toBe('j 1')
    expect(fetchMock.mock.calls[0][0]).toBe(`${CLOUD_BASE}/api/jobs/j%201`)
  })

  it('getQuota surfaces 402 (no license) as CloudJobError', async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: 'no active license' }, 402))
    await expect(getQuota()).rejects.toMatchObject({ status: 402 })
  })
})
