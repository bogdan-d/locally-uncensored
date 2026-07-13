import { describe, it, expect } from 'vitest'
import { CLOUD_INTRO_KEY, shouldShowCloudIntro } from '../CloudIntroPopup'

//  CloudIntroPopup — the once-ever "LU Cloud is live" hello (2.5.7)

describe('shouldShowCloudIntro', () => {
  it('shows for a first launch in local mode (updater or fresh install)', () => {
    expect(shouldShowCloudIntro(false, 'local')).toBe(true)
  })

  it('never shows again once the flag is set', () => {
    expect(shouldShowCloudIntro(true, 'local')).toBe(false)
    expect(shouldShowCloudIntro(true, 'cloud')).toBe(false)
  })

  it('never pitches users already running in cloud mode', () => {
    expect(shouldShowCloudIntro(false, 'cloud')).toBe(false)
  })
})

describe('CLOUD_INTRO_KEY', () => {
  // The exact string is load-bearing: AppShell's store-backup list and
  // fatal-error's preserve list both carry it, so "seen once" survives an
  // NSIS update that wipes WebView2 localStorage. Renaming it silently would
  // re-show the popup to every updater.
  it('stays the string the backup lists reference', () => {
    expect(CLOUD_INTRO_KEY).toBe('lu_cloud_intro_seen')
  })
})
