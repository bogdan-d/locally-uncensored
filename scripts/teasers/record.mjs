// Teaser take recorder: attaches to the running desktop exe over CDP
// (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222),
// captures a JPEG frame stream via Page.startScreencast and drives the
// requested Create flow. Output contract per take (consumed by render.mjs):
//   assets-src/teasers-raw/<fn>/take-NN/
//     f_000001.jpg ...            repaint-driven frames
//     frames.json                 { frames:[{i,t}], markers:[{name,t}], viewport }
//     input.* / result.*          the media that went in / came out
//
// Usage: node scripts/teasers/record.mjs --fn=music [--take=01] [--no-drive]
// Flow drivers live in flows.mjs; --no-drive just records until Ctrl+C.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const { chromium } = require('@playwright/test')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const FN = arg('fn')
if (!FN) { console.error('need --fn=<intent>'); process.exit(1) }
const TAKE = arg('take', '01')
const DRIVE = !process.argv.includes('--no-drive')

const takeDir = path.join(ROOT, 'assets-src', 'teasers-raw', FN, `take-${TAKE}`)
fs.mkdirSync(takeDir, { recursive: true })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('tauri.localhost'))
if (!page) { console.error('app page not found on :9222'); process.exit(1) }
const cdp = await ctx.newCDPSession(page)

// The Tauri window is transparent:true; force an opaque app-canvas background
// so JPEG frames never composite garbage into the rounded corners.
await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
  color: { r: 32, g: 32, b: 32, a: 255 },
})

const meta = {
  frames: [],
  markers: [],
  viewport: await page.evaluate(() => ({
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
  })),
}
let i = 0
cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
  i += 1
  fs.writeFileSync(path.join(takeDir, `f_${String(i).padStart(6, '0')}.jpg`), Buffer.from(data, 'base64'))
  meta.frames.push({ i, t: metadata.timestamp })
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', {
  format: 'jpeg', quality: 85, maxWidth: 2560, maxHeight: 1600, everyNthFrame: 1,
})
const mark = (name) => {
  meta.markers.push({ name, t: Date.now() / 1000 })
  console.log(`[mark] ${name}`)
}

const finalize = async () => {
  try { await cdp.send('Page.stopScreencast') } catch { /* already gone */ }
  fs.writeFileSync(path.join(takeDir, 'frames.json'), JSON.stringify(meta))
  console.log(`take done: ${meta.frames.length} frames -> ${takeDir}`)
  await browser.close()
  process.exit(0)
}
process.on('SIGINT', finalize)

if (DRIVE) {
  const { FLOWS } = await import('./flows.mjs')
  const flow = FLOWS[FN]
  if (!flow) { console.error(`no flow driver for ${FN} (flows.mjs)`); await finalize() }
  try {
    const out = await flow({ page, mark, takeDir })
    if (out?.resultUrl) {
      const res = await fetch(out.resultUrl)
      const buf = Buffer.from(await res.arrayBuffer())
      const ext = out.resultExt ?? path.extname(new URL(out.resultUrl).pathname) ?? '.bin'
      fs.writeFileSync(path.join(takeDir, `result${ext.startsWith('.') ? ext : `.${ext}`}`), buf)
      console.log(`result saved (${buf.length} bytes)`)
    }
    if (out?.inputCopy) {
      fs.copyFileSync(out.inputCopy, path.join(takeDir, `input${path.extname(out.inputCopy)}`))
    }
  } catch (err) {
    console.error('flow failed:', err)
  }
  await finalize()
} else {
  console.log('recording... Ctrl+C to stop')
}
