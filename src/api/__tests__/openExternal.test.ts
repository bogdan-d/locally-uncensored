import { describe, it, expect } from 'vitest'
import { isSafeExternalUrl } from '../backend'

// C3: openExternal hands the URL to the OS shell (`plugin:shell|open`). A
// model- or web-content-supplied markdown link must only ever be a web/mail
// link — never file://, a custom protocol handler, a UNC path, or javascript:.
describe('isSafeExternalUrl', () => {
  it('allows http / https / mailto', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(true)
    expect(isSafeExternalUrl('https://example.com/path?q=1#frag')).toBe(true)
    expect(isSafeExternalUrl('mailto:foo@bar.com')).toBe(true)
  })

  it('blocks file / custom-protocol / data / javascript / UNC / relative / garbage', () => {
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeExternalUrl('vscode://foo/bar')).toBe(false)
    expect(isSafeExternalUrl('\\\\server\\share\\x')).toBe(false)
    expect(isSafeExternalUrl('/etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})
