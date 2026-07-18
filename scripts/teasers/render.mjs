// Teaser renderer: takes a recorded take (frames.json + JPEGs + result media),
// composes the 12s motion template deterministically (frame-stepped __SEEK in
// a Playwright-launched chromium, viewport 640x360 @2x = 1280x720 masters)
// and encodes the final VP9/Opus webm + webp poster into public/teasers/.
//
// Usage: node scripts/teasers/render.mjs --fn=music
// Manifest: scripts/teasers/manifests/<fn>.json

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(path.join(ROOT, 'package.json'))
const { chromium } = require('@playwright/test')

const FFMPEG = process.env.FFMPEG ?? 'C:\\ffmpeg\\bin\\ffmpeg.exe'
const FPS = 30
const FRAMES = 360 // 12.0s
const S1 = { from: 1.4, to: 6.8, splitA: 3.2 } // virtual flow window, A=pre-click
const S2 = { from: 6.6, to: 10.8, playFrom: 6.9 }

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const FN = arg('fn')
if (!FN) { console.error('need --fn=<intent>'); process.exit(1) }

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'teasers', 'manifests', `${FN}.json`), 'utf8'))
const takeDir = path.join(ROOT, manifest.flow.take)
const scratch = path.join(ROOT, 'assets-src', 'teasers-scratch', FN)
const framesOut = path.join(scratch, 'frames')
fs.mkdirSync(framesOut, { recursive: true })
const outDir = path.join(ROOT, 'public', 'teasers')
fs.mkdirSync(outDir, { recursive: true })

const ff = (args) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`)
  return r
}
const furl = (p) => pathToFileURL(p).href
const findFile = (dir, base) => {
  const hit = fs.readdirSync(dir).find((f) => f.startsWith(base + '.'))
  return hit ? path.join(dir, hit) : null
}

// ── 1. flow mapping (virtual t -> source JPEG) ──────────────────────────────
const meta = JSON.parse(fs.readFileSync(path.join(takeDir, 'frames.json'), 'utf8'))
const srcFrames = meta.frames
const markers = Object.fromEntries(meta.markers.map((m) => [m.name, m.t]))
const tClick = markers['create-clicked'] ?? srcFrames[Math.floor(srcFrames.length / 2)].t
const tDone = markers['render-done'] ?? srcFrames[srcFrames.length - 1].t
const preClick = manifest.flow.preClick ?? 6
const postDone = manifest.flow.postDone ?? 2

const frameAt = (t) => {
  // last source frame with timestamp <= t (screencast frames are sparse)
  let lo = 0, hi = srcFrames.length - 1, ans = srcFrames[0]
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (srcFrames[mid].t <= t) { ans = srcFrames[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return path.join(takeDir, `f_${String(ans.i).padStart(6, '0')}.jpg`)
}
const flowSrcByFrame = Array.from({ length: FRAMES }, (_, f) => {
  const t = f / FPS
  if (t < S1.from - 0.1 || t > S1.to + 0.1) return null
  const v = t - S1.from
  if (v <= S1.splitA) {
    const srcT = tClick - preClick + (v / S1.splitA) * preClick
    return furl(frameAt(Math.max(srcFrames[0].t, srcT)))
  }
  const vb = v - S1.splitA
  const spanB = S1.to - S1.from - S1.splitA
  const srcT = tDone - 0.5 + (vb / spanB) * (0.5 + postDone)
  return furl(frameAt(Math.min(srcFrames[srcFrames.length - 1].t, srcT)))
})

// ── 2. S2 assets ────────────────────────────────────────────────────────────
const s2cfg = manifest.result
const s2 = { type: s2cfg.type }
const prepImage = (name) => {
  const src = path.join(takeDir, s2cfg[name])
  const out = path.join(scratch, `${name}.jpg`)
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
    ff(['-y', '-i', src, '-vf', 'scale=1280:-2', '-q:v', '3', out])
  }
  return furl(out)
}
const extractSeq = (srcName, sub) => {
  const src = path.join(takeDir, srcName)
  const dir = path.join(scratch, sub)
  const stamp = path.join(dir, '.stamp')
  if (!fs.existsSync(stamp) || fs.statSync(stamp).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    ff(['-y', '-i', src, '-vf', `fps=${FPS},scale=1280:-2`, '-q:v', '3', path.join(dir, 'r_%05d.jpg')])
    fs.writeFileSync(stamp, '')
  }
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => furl(path.join(dir, f)))
}
const seqByFrame = (seq) =>
  Array.from({ length: FRAMES }, (_, f) => {
    const t = f / FPS
    if (t < S2.from || t > S2.to) return null
    const idx = Math.max(0, Math.round((t - S2.playFrom) * FPS))
    return seq[seq.length ? idx % seq.length : 0] ?? seq[0]
  })

if (s2.type === 'image-compare') {
  s2.before = prepImage('before')
  s2.after = prepImage('after')
  s2.beforeTag = s2cfg.beforeTag
  s2.afterTag = s2cfg.afterTag
} else if (s2.type === 'image-crossfade') {
  s2.before = prepImage('before')
  s2.after = prepImage('after')
} else if (s2.type === 'image-cuts') {
  const span = S2.to - S2.playFrom
  const n = s2cfg.cuts.length
  s2.cuts = s2cfg.cuts.map((file, i) => {
    const src = path.join(takeDir, file)
    const out = path.join(scratch, `cut${i}.jpg`)
    if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
      ff(['-y', '-i', src, '-vf', 'scale=1280:-2', '-q:v', '3', out])
    }
    return { src: furl(out), from: S2.playFrom + (span * i) / n, to: S2.playFrom + (span * (i + 1)) / n }
  })
} else if (s2.type === 'video' || s2.type === 'video-extend' || s2.type === 'video-pip') {
  s2.imgsByFrame = seqByFrame(extractSeq(s2cfg.video, 'result-seq'))
  if (s2.type === 'video-extend') s2.boundaryPct = s2cfg.boundaryPct ?? 50
  if (s2.type === 'video-pip') s2.pipByFrame = seqByFrame(extractSeq(s2cfg.pip, 'pip-seq'))
} else if (s2.type === 'audio-waveform') {
  const audio = path.join(takeDir, s2cfg.audio)
  const raw = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', audio, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1 << 28 })
  if (raw.status !== 0) throw new Error('ffmpeg pcm decode failed')
  const pcm = raw.stdout
  const n = Math.floor(pcm.length / 2)
  const BUCKETS = 200
  const peaks = Array.from({ length: BUCKETS }, (_, b) => {
    const from = Math.floor((b * n) / BUCKETS), to = Math.floor(((b + 1) * n) / BUCKETS)
    let max = 0
    for (let i = from; i < to; i += 4) max = Math.max(max, Math.abs(pcm.readInt16LE(i * 2)))
    return max / 32768
  })
  s2.peaks = peaks
  s2.title = s2cfg.title ?? manifest.tagline
  // normalized 5.4s cut for the mux (starts at S2.from in the final clip)
  const cut = path.join(scratch, 'audio.flac')
  ff(['-y', '-ss', String(s2cfg.audioOffset ?? 0), '-t', '5.4', '-i', audio,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.5,afade=t=out:st=4.2:d=1.2', '-ar', '48000', cut])
  s2._audioCut = cut
}

// ── 3. frame-step capture ───────────────────────────────────────────────────
const payload = {
  title: manifest.title,
  tagline: manifest.tagline,
  caption: manifest.caption,
  monogram: furl(path.join(ROOT, 'public', 'LU-monogram-white.png')),
  flowSrcByFrame,
  s2,
}
// Prefer whatever headless-shell revision is already on disk over forcing a
// `playwright install` download; screenshot capture has no revision-sensitive
// surface for this template.
const findShell = () => {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
  try {
    const revs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort()
    for (const rev of revs.reverse()) {
      const exe = path.join(base, rev, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
      if (fs.existsSync(exe)) return exe
    }
  } catch { /* fall through to default resolution */ }
  return undefined
}
const shell = findShell()
const browser = await chromium.launch(shell ? { executablePath: shell } : {})
const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 })
await page.goto(furl(path.join(ROOT, 'scripts', 'teasers', 'template', 'template.html')))
await page.evaluate((p) => window.__INIT(p), payload)
await page.waitForFunction(() => window.__READY === true, null, { timeout: 60_000 })
for (let f = 0; f < FRAMES; f++) {
  await page.evaluate((t) => window.__SEEK(t), f / FPS)
  await page.screenshot({ path: path.join(framesOut, `f_${String(f).padStart(5, '0')}.png`) })
  if (f % 60 === 0) console.log(`frame ${f}/${FRAMES}`)
}
await browser.close()

// ── 4. encode ───────────────────────────────────────────────────────────────
const outFile = path.join(outDir, `${FN}.webm`)
const passlog = path.join(scratch, '2p')
const encode = (bitrateK) => {
  const vf = ['-framerate', String(FPS), '-i', path.join(framesOut, 'f_%05d.png')]
  const venc = ['-c:v', 'libvpx-vp9', '-b:v', `${bitrateK}k`, '-maxrate', `${Math.round(bitrateK * 1.5)}k`,
    '-minrate', `${Math.round(bitrateK / 4)}k`, '-crf', '36', '-deadline', 'good', '-row-mt', '1',
    '-tile-columns', '1', '-g', '240', '-pix_fmt', 'yuv420p']
  ff(['-y', ...vf, '-pass', '1', '-passlogfile', passlog, ...venc, '-an', '-f', 'null', '-'])
  if (s2.type === 'audio-waveform') {
    ff(['-y', ...vf, '-itsoffset', String(S2.from), '-i', s2._audioCut, '-pass', '2', '-passlogfile', passlog,
      '-map', '0:v', '-map', '1:a', ...venc, '-c:a', 'libopus', '-b:a', '96k', '-shortest', outFile])
  } else {
    ff(['-y', ...vf, '-pass', '2', '-passlogfile', passlog, ...venc, '-an', outFile])
  }
  return fs.statSync(outFile).size
}
let size = encode(480)
if (size > 870 * 1024) {
  const scaled = Math.max(200, Math.floor((480 * 800 * 1024) / size))
  console.log(`size ${Math.round(size / 1024)}KB over budget, retry at ${scaled}k`)
  size = encode(scaled)
}
ff(['-y', '-framerate', String(FPS), '-i', path.join(framesOut, 'f_%05d.png'),
  '-vf', "select=eq(n\\,20),scale=640:360", '-frames:v', '1', path.join(outDir, `${FN}-poster.webp`)])
console.log(`OK ${FN}: ${Math.round(size / 1024)}KB -> ${outFile}`)
