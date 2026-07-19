// Flow drivers for record.mjs: each drives one cloud Create function in the
// running exe (cheapest variant, minimal length) while the screencast rolls,
// sets the create-clicked / render-done markers and returns the result URL.
// Everything works through the real UI (hidden file inputs included) so the
// recording shows exactly what a user does.

/* eslint-disable no-await-in-loop */

import fs from 'node:fs'
import path from 'node:path'

export const helpers = {
  async nav(page, label) {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.innerText || '').trim() === l && x.getBoundingClientRect().y < 100,
      )
      b?.click()
    }, label)
    await page.waitForTimeout(900)
  },

  async pickIntent(page, label) {
    await page.evaluate((l) => {
      const r = [...document.querySelectorAll('[role="radio"]')].find(
        (x) => (x.getAttribute('aria-label') || '') === l,
      )
      r?.click()
    }, label)
    await page.waitForTimeout(900)
  },

  /** Human-ish typing into the composer textarea (visible in the recording). */
  async typePrompt(page, text) {
    const ta = page.locator('textarea').first()
    await ta.click()
    await ta.pressSequentially(text, { delay: 18 })
    await page.waitForTimeout(300)
  },

  /** Type into a specific field found by its placeholder (voice maker,
   *  trigger word) — .first() would hit the composer prompt instead. Clears
   *  first: the trigger word persists across app restarts, so take-02 typed
   *  'lumi' onto the surviving 'lumi' and trained 'lumilumi'. */
  async typeInto(page, placeholderRe, text) {
    const field = page.locator(`textarea[placeholder*="${placeholderRe}"], input[placeholder*="${placeholderRe}"]`).first()
    await field.click()
    await field.fill('')
    await field.pressSequentially(text, { delay: 18 })
    await page.waitForTimeout(300)
  },

  async setSlider(page, value) {
    await page.evaluate((v) => {
      const s = document.querySelector('input[type="range"]')
      if (!s) return
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(s, String(v))
      s.dispatchEvent(new Event('input', { bubbles: true }))
      s.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
    await page.waitForTimeout(300)
  },

  /** Remaining-credits figure from the composer's CreditsMeter (null if the
   *  meter isn't mounted, e.g. quota still loading). */
  async credits(page) {
    return page.evaluate(() => {
      const box = [...document.querySelectorAll('div')].find(
        (d) => d.querySelector(':scope > div.w-12') && d.querySelector(':scope > span.tabular-nums'),
      )
      const n = box?.querySelector(':scope > span.tabular-nums')?.textContent?.trim()
      return n && /^\d+$/.test(n) ? parseInt(n, 10) : null
    })
  },

  /** All current media srcs for a selector (http + blob) — the waitDone
   *  baseline, taken right before Create so old gallery items never match. */
  async mediaSrcs(page, selector) {
    return page.evaluate(
      (sel) => [...document.querySelectorAll(sel)]
        .map((m) => m.currentSrc || m.src || '')
        .filter((u) => /^(https?|blob):/.test(u)),
      selector,
    )
  },

  /** Ensure the composer's model Select shows `wantRe`; pick it if not.
   *  On a miss the error lists what the picker actually offered. */
  async ensureModel(page, wantRe) {
    const state = await page.evaluate((re) => {
      const rx = new RegExp(re, 'i')
      const trigger = [...document.querySelectorAll('button')].find(
        (b) => b.closest('[class*="min-w-"]') && b.querySelector('svg.lucide-chevron-down'),
      ) ?? [...document.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-chevron-down'))
      if (!trigger) return { found: false }
      const label = trigger.textContent || ''
      if (rx.test(label)) return { found: true, ok: true, label }
      trigger.click()
      return { found: true, ok: false, label }
    }, wantRe.source)
    if (!state.found) throw new Error('model select trigger not found')
    if (state.ok) return state.label
    await page.waitForTimeout(500)
    const picked = await page.evaluate((re) => {
      const rx = new RegExp(re, 'i')
      const opts = [...document.querySelectorAll('[role="option"], [role="listbox"] button, .lu-elevated button')]
      const opt = opts.find((o) => rx.test(o.textContent || ''))
      if (!opt) return { miss: opts.map((o) => (o.textContent || '').trim()).filter(Boolean) }
      opt.click()
      return { label: (opt.textContent || '').trim() }
    }, wantRe.source)
    if (!picked.label) throw new Error(`model matching ${wantRe} not in picker; options: ${JSON.stringify(picked.miss)}`)
    await page.waitForTimeout(500)
    return picked.label
  },

  /** Click the composer's Create submit (NOT the nav tab of the same name —
   *  the tab sits in the header, the submit in the bottom half) and confirm
   *  the run actually started (Cancel appears). */
  async clickCreate(page) {
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.textContent || '').trim() === 'Create' && !x.disabled &&
          x.getBoundingClientRect().y > 200,
      )
      if (!b) return false
      b.click()
      return true
    })
    if (!clicked) throw new Error('composer Create button not found or disabled')
    const t0 = Date.now()
    for (;;) {
      const started = await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('button')].some(
          (b) => (b.textContent || '').trim() === 'Cancel',
        )
        const err = [...document.querySelectorAll('div,p,span')].find(
          (n) => n.children.length === 0 &&
            /failed|error|not supported|invalid|exceeded|too large|rejected|denied/i.test(n.textContent || '') &&
            (n.textContent || '').length < 220,
        )
        return { cancel, err: err ? err.textContent.trim().slice(0, 200) : null }
      })
      if (started.cancel) return
      if (started.err) throw new Error(`run rejected: ${started.err}`)
      if (Date.now() - t0 > 12_000) return // fast run may already be done; waitDone decides
      await page.waitForTimeout(250)
    }
  },

  /** Click any button by exact-or-contained text (topmost match). */
  async clickButton(page, text) {
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.textContent || '').trim().includes(t) && !x.disabled,
      )
      if (!b) return false
      b.click()
      return true
    }, text)
    if (!ok) throw new Error(`button "${text}" not found`)
    await page.waitForTimeout(600)
  },

  /** Wait until the run finished: Cancel gone again + a media element whose
   *  src is NOT in `baseline` exists. Returns that new src. */
  async waitDone(page, selector, { baseline = [], timeoutMs = 10 * 60_000 } = {}) {
    const base = new Set(baseline)
    const t0 = Date.now()
    for (;;) {
      const st = await page.evaluate((sel) => {
        const cancel = [...document.querySelectorAll('button')].some(
          (b) => (b.textContent || '').trim() === 'Cancel',
        )
        const srcs = [...document.querySelectorAll(sel)]
          .map((m) => m.currentSrc || m.src || '')
          .filter((u) => /^(https?|blob):/.test(u))
        const err = [...document.querySelectorAll('div,p,span')].find(
          (n) => n.children.length === 0 &&
            /failed|error|not supported|invalid|exceeded|too large|rejected|denied/i.test(n.textContent || '') &&
            (n.textContent || '').length < 220,
        )
        return { cancel, srcs, err: err ? err.textContent.trim().slice(0, 200) : null }
      }, selector)
      const fresh = st.srcs.find((u) => !base.has(u))
      if (fresh && !st.cancel) return fresh
      if (!st.cancel && st.err && Date.now() - t0 > 20_000) throw new Error(`run failed: ${st.err}`)
      if (Date.now() - t0 > timeoutMs) throw new Error('run timed out')
      await page.waitForTimeout(2500)
    }
  },

  /** Download a result URL from INSIDE the page (carries the session's auth
   *  and also handles blob: URLs) and write it to takeDir. */
  async saveResult(page, url, takeDir, ext, basename = 'result') {
    const b64 = await page.evaluate(async (u) => {
      const res = await fetch(u)
      const buf = await res.arrayBuffer()
      let s = ''
      const bytes = new Uint8Array(buf)
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      return btoa(s)
    }, url)
    const file = path.join(takeDir, `${basename}${ext}`)
    fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    return file
  },

  /** Set a hidden <input type=file> whose accept matches, via Playwright.
   *  `multiple: true` targets the multi-file input (the Character-Studio
   *  training board); default prefers a single-file input. */
  async setFile(page, acceptRe, files, { multiple = false } = {}) {
    const handle = await page.evaluateHandle((args) => {
      const rx = new RegExp(args.re, 'i')
      const ins = [...document.querySelectorAll('input[type="file"]')].filter((i) => rx.test(i.accept || ''))
      return args.multiple
        ? ins.find((i) => i.multiple)
        : (ins.find((i) => !i.multiple) ?? ins[0])
    }, { re: acceptRe.source, multiple })
    const el = handle.asElement()
    if (!el) throw new Error(`no file input matching ${acceptRe}${multiple ? ' (multiple)' : ''}`)
    await el.setInputFiles(files)
    await page.waitForTimeout(800)
  },

  /** Newest result.* from a previous take of `fn` (the t2i output feeds the
   *  upscale + eraser runs). */
  priorResult(fn) {
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', 'assets-src', 'teasers-raw', fn)
    if (!fs.existsSync(dir)) throw new Error(`no takes for "${fn}" yet, record it first`)
    const takes = fs.readdirSync(dir).filter((d) => d.startsWith('take-')).sort().reverse()
    for (const t of takes) {
      const hit = fs.readdirSync(path.join(dir, t)).find((f) => f.startsWith('result.'))
      if (hit) return path.join(dir, t, hit)
    }
    throw new Error(`no result.* in any "${fn}" take, record it first`)
  },

  /** A named file from the newest prep take (portraits / driving clip that the
   *  lipsync, motion and character takes reuse). */
  prepFile(name) {
    const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', 'assets-src', 'teasers-raw', 'prep')
    if (!fs.existsSync(dir)) throw new Error('no prep take yet, run --fn=prep first')
    const takes = fs.readdirSync(dir).filter((d) => d.startsWith('take-')).sort().reverse()
    for (const t of takes) {
      const p = path.join(dir, t, name)
      if (fs.existsSync(p)) return p
    }
    throw new Error(`"${name}" not found in any prep take`)
  },
}

const h = helpers

export const FLOWS = {
  /** Classic t2i on the deployed lane, cheapest model — also produces the
   *  source image the upscale + eraser takes reuse. */
  async image({ page, mark, takeDir }) {
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Image')
    await h.ensureModel(page, /flux.?schnell/i)
    await h.typePrompt(page, 'a single red balloon in the center of the sky above a calm lake at sunrise')
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'img')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'img', { baseline, timeoutMs: 4 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3000)
    const saved = await h.saveResult(page, src, takeDir, '.png')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return {}
  },

  /** Utility op: image upscale to 2K (no model, no prompt). */
  async upscale({ page, mark, takeDir }) {
    const input = h.priorResult('image')
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Upscale')
    await h.setFile(page, /image/i, [input])
    await h.clickButton(page, '2K')
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'img')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'img', { baseline, timeoutMs: 4 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3000)
    const saved = await h.saveResult(page, src, takeDir, '.png')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return { inputCopy: input }
  },

  /** Utility op: object eraser — paint a mask over the balloon, then run. */
  async eraser({ page, mark, takeDir }) {
    const input = h.priorResult('image')
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Erase Object')
    await h.setFile(page, /image/i, [input])
    await h.clickButton(page, 'Paint mask')
    await page.waitForTimeout(900)
    // Paint strokes over the upper-center region (where the balloon is):
    // real mouse drags on the visible canvas stack, exactly like a user.
    const box = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')]
      const top = cs[cs.length - 1]
      if (!top) return null
      const r = top.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    })
    if (!box) throw new Error('mask canvas not found')
    // Two regions: the balloon + string (upper center) and its reflection in
    // the lake (lower center) — leaving the mirror image would look broken.
    const paint = async (x0, x1, y0, y1, rows) => {
      for (let row = 0; row < rows; row += 1) {
        const y = box.y + box.h * (y0 + ((y1 - y0) * row) / (rows - 1))
        await page.mouse.move(box.x + box.w * x0, y)
        await page.mouse.down()
        for (let s = 0; s <= 10; s += 1) {
          await page.mouse.move(box.x + box.w * (x0 + ((x1 - x0) / 10) * s), y, { steps: 2 })
          await page.waitForTimeout(14)
        }
        await page.mouse.up()
        await page.waitForTimeout(70)
      }
    }
    await paint(0.38, 0.63, 0.22, 0.58, 9)
    await paint(0.39, 0.60, 0.76, 0.94, 5)
    await h.clickButton(page, 'Apply mask')
    await page.waitForTimeout(600)
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'img')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'img', { baseline, timeoutMs: 4 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3000)
    const saved = await h.saveResult(page, src, takeDir, '.png')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return { inputCopy: input }
  },

  /** Classic t2v, cheapest clip model on the deployed lane. */
  async video({ page, mark, takeDir }) {
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Video')
    await h.ensureModel(page, /ltx/i)
    await h.typePrompt(page, 'a wave breaking on rocks in slow motion, golden hour')
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'video')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'video', { baseline })
    mark('render-done')
    await page.waitForTimeout(3500)
    const saved = await h.saveResult(page, src, takeDir, '.mp4')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return {}
  },

  /** Music (ace-step, 5 s) on the ops-aware catalog (?v=2, live since the
   *  2026-07-18 deploy) — also proves the per-second music billing. */
  async music({ page, mark, takeDir }) {
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Music')
    await h.setSlider(page, 5)
    await h.ensureModel(page, /ace.?step/i)
    await h.typePrompt(page, 'dreamy lofi hip hop, vinyl crackle, mellow keys')
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'audio')
    await page.waitForTimeout(600)
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'audio', { baseline })
    mark('render-done')
    await page.waitForTimeout(3500)
    const saved = await h.saveResult(page, src, takeDir, '.mp3')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return {}
  },

  /** Prep run (not turned into a teaser): renders the reusable inputs — four
   *  portraits of one consistent character (the lipsync/motion portrait + the
   *  Character-Studio training set) and one dancing clip (the extend source in
   *  the gallery + the motion driving video). Cheapest models throughout. */
  async prep({ page, mark, takeDir }) {
    await h.nav(page, 'Create')
    const BASE = 'a woman in her 30s with short silver hair, freckles and green eyes, wearing a dark turtleneck'
    const SHOTS = [
      `studio portrait of ${BASE}, soft key light, looking at camera`,
      `portrait of ${BASE}, smiling, warm cafe light`,
      `side profile portrait of ${BASE}, window light`,
      `outdoor portrait of ${BASE}, golden hour, shallow depth of field`,
    ]
    const t0 = await h.credits(page)
    for (const [i, prompt] of SHOTS.entries()) {
      await h.pickIntent(page, 'Image')
      if (i === 0) await h.ensureModel(page, /flux.?schnell/i)
      const ta = page.locator('textarea').first()
      await ta.click()
      await ta.fill('')
      await ta.pressSequentially(prompt, { delay: 4 })
      const baseline = await h.mediaSrcs(page, 'img')
      mark(`portrait-${i + 1}`)
      await h.clickCreate(page)
      const src = await h.waitDone(page, 'img', { baseline, timeoutMs: 4 * 60_000 })
      await h.saveResult(page, src, takeDir, '.png', `portrait-${i + 1}`)
    }
    // The driving/extend clip: a full-body dance so the motion models have an
    // actual pose performance to transfer.
    await h.pickIntent(page, 'Video')
    await h.ensureModel(page, /ltx/i)
    const ta = page.locator('textarea').first()
    await ta.click()
    await ta.fill('')
    await ta.pressSequentially('a young woman dancing in a bright studio, full body shot, smooth flowing motion', { delay: 4 })
    const baseline = await h.mediaSrcs(page, 'video')
    mark('dance-clip')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'video', { baseline })
    await page.waitForTimeout(3000)
    await h.saveResult(page, src, takeDir, '.mp4', 'dance')
    const t1 = await h.credits(page)
    console.log(JSON.stringify({ credits: { before: t0, after: t1 } }))
    return {}
  },

  /** Talking character: photo avatar + a voice MADE IN-FLOW via the qwen3-tts
   *  maker (proves the tts lane too), then the lipsync render. */
  async lipsync({ page, mark, takeDir }) {
    const portrait = h.prepFile('portrait-1.png')
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Talking Character')
    // cheapest live lipsync: p-video-avatar 2500 (infinitetalk-fast is 7500)
    await h.ensureModel(page, /p.?video avatar/i)
    await h.setFile(page, /image/i, [portrait])
    const beforeTts = await h.credits(page)
    await h.clickButton(page, 'Add voice')
    await h.clickButton(page, 'Generate a voice (AI)')
    await h.typeInto(page, 'What should the character say', 'Hey there! Welcome to LU Cloud. Let me show you around.')
    mark('make-voice')
    await h.clickButton(page, 'Make voice')
    // The tts run flips isGenerating; done when Cancel is gone and the voice
    // chip carries the pick (makeVoice wires voiceFromJob itself).
    const t0 = Date.now()
    for (;;) {
      const st = await page.evaluate(() => ({
        cancel: [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Cancel'),
        picked: /Generated audio|Hey there/.test(document.body.textContent || ''),
      }))
      if (!st.cancel && st.picked) break
      if (Date.now() - t0 > 5 * 60_000) throw new Error('voice make timed out')
      await page.waitForTimeout(1500)
    }
    const afterTts = await h.credits(page)
    // lipsync has no prompt field — portrait + voice are the whole input
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'video')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'video', { baseline, timeoutMs: 20 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3500)
    const saved = await h.saveResult(page, src, takeDir, '.mp4')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { tts: { beforeTts, afterTts }, lipsync: { before, after } }, src: src.slice(0, 120), saved }))
    return { inputCopy: portrait }
  },

  /** Extend: pick the dance clip rendered on this account and continue it. */
  async extend({ page, mark, takeDir }) {
    const dance = h.prepFile('dance.mp4')
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Extend Video')
    // cheapest live extend: pixverse 2500 (ltx 10000, wan spicy 15000)
    await h.ensureModel(page, /pixverse/i)
    await h.clickButton(page, 'Pick one of your cloud videos')
    await page.waitForTimeout(600)
    await h.clickButton(page, 'dancing')
    await h.typePrompt(page, 'she keeps dancing as the camera slowly circles around her')
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'video')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'video', { baseline, timeoutMs: 20 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3500)
    const saved = await h.saveResult(page, src, takeDir, '.mp4')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return { inputCopy: dance }
  },

  /** Motion control: portrait + the dance clip as the driving performance. */
  async motion({ page, mark, takeDir }) {
    const portrait = h.prepFile('portrait-1.png')
    const dance = h.prepFile('dance.mp4')
    // the teaser composites the driving clip as a PiP next to the result
    fs.copyFileSync(dance, path.join(takeDir, 'driving.mp4'))
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Motion Control')
    // cheapest live motion: p-video-animate 3000 (dreamactor 5000, wan/steady 20000)
    await h.ensureModel(page, /p.?video animate/i)
    await h.setFile(page, /image/i, [portrait])
    await h.setFile(page, /video/i, [dance])
    // motion has no prompt field — image + driving clip are the whole input
    const before = await h.credits(page)
    const baseline = await h.mediaSrcs(page, 'video')
    mark('create-clicked')
    await h.clickCreate(page)
    const src = await h.waitDone(page, 'video', { baseline, timeoutMs: 20 * 60_000 })
    mark('render-done')
    await page.waitForTimeout(3500)
    const saved = await h.saveResult(page, src, takeDir, '.mp4')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { before, after }, src: src.slice(0, 120), saved }))
    return { inputCopy: portrait }
  },

  /** Character Studio, full lane: train a Flux LoRA on the four prep
   *  portraits (cheapest IMAGE trainer live: flux 100000; the 35000 one is the
   *  LTX video trainer whose character can't feed the image teaser), then
   *  generate two scenes with the fresh character for the image cuts. */
  async character({ page, mark, takeDir }) {
    const photos = [1, 2, 3, 4].map((i) => h.prepFile(`portrait-${i}.png`))
    await h.nav(page, 'Create')
    await h.pickIntent(page, 'Character Studio')
    await h.clickButton(page, 'Train new')
    await h.ensureModel(page, /flux character training/i)
    await h.typeInto(page, 'Trigger word', 'lumi')
    await h.setFile(page, /image/i, photos, { multiple: true })
    const beforeTrain = await h.credits(page)
    mark('create-clicked')
    await h.clickCreate(page)
    // Training yields a shelf entry, not a media item: done when the run ended
    // and the store flipped to the use-surface with the fresh character chip.
    const t0 = Date.now()
    for (;;) {
      const st = await page.evaluate(() => {
        const cancel = [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Cancel')
        const chip = [...document.querySelectorAll('button')].some((b) => /lumi/.test(b.textContent || ''))
        const err = [...document.querySelectorAll('div,p,span')].find(
          (n) => n.children.length === 0 &&
            /failed|error|not supported|invalid|exceeded|too large|rejected|denied/i.test(n.textContent || '') &&
            (n.textContent || '').length < 220,
        )
        return { cancel, chip, err: err ? err.textContent.trim().slice(0, 200) : null }
      })
      if (!st.cancel && st.chip) break
      if (!st.cancel && st.err && Date.now() - t0 > 30_000) throw new Error(`training failed: ${st.err}`)
      // 45 min: take-03 hit the 30 min cap while the render worker restarted
      // mid-train (deploy window) — the job refunded, the client just waited.
      if (Date.now() - t0 > 45 * 60_000) throw new Error('training timed out')
      if (Math.floor((Date.now() - t0) / 120_000) !== Math.floor((Date.now() - t0 - 4000) / 120_000)) {
        console.log(`[character] training wait ${Math.round((Date.now() - t0) / 60_000)}min, cancel=${st.cancel}`)
      }
      await page.waitForTimeout(4000)
    }
    mark('trained')
    const afterTrain = await h.credits(page)
    // Generate two scenes with the character (the use-surface is active now).
    await h.clickButton(page, 'lumi')
    const scenes = [
      'lumi drinking coffee in a paris cafe, golden morning light',
      'lumi hiking on a mountain ridge at sunset, wide shot',
    ]
    const gens = []
    for (const [i, prompt] of scenes.entries()) {
      const ta = page.locator('textarea').first()
      await ta.click()
      await ta.fill('')
      await ta.pressSequentially(prompt, { delay: 10 })
      const baseline = await h.mediaSrcs(page, 'img')
      mark(`gen-${i + 1}`)
      await h.clickCreate(page)
      const src = await h.waitDone(page, 'img', { baseline, timeoutMs: 6 * 60_000 })
      await page.waitForTimeout(2500)
      gens.push(await h.saveResult(page, src, takeDir, '.png', i === 0 ? 'result' : `result-${i + 1}`))
    }
    mark('render-done')
    const after = await h.credits(page)
    console.log(JSON.stringify({ credits: { train: { beforeTrain, afterTrain }, final: after }, gens }))
    return { inputCopy: photos[0] }
  },
}
