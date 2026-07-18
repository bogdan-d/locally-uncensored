// Deterministic teaser timeline. render.mjs calls __INIT(payload) once, waits
// for __READY, then steps __SEEK(t) per output frame. All per-frame media
// decisions (which source JPEG shows when) are precomputed in Node and arrive
// as arrays indexed by output frame; this file only eases opacities and
// transforms and swaps <img>.src.
//
// Timeline (12.0s @30fps): S0 title 0-1.6 · S1 flow 1.4-6.8 · S2 result
// 6.6-10.8 · S3 outro 10.6-12.0; frame 359 matches frame 0 for a clean loop.

/* global window, document */
const $ = (sel) => document.querySelector(sel)
const clamp01 = (x) => Math.max(0, Math.min(1, x))
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3)
const easeInOut = (x) => { const t = clamp01(x); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 }
// fade helper: in over [a,b], out over [c,d]
const window01 = (t, a, b, c, d) => clamp01((t - a) / (b - a)) * (1 - clamp01((t - c) / (d - c)))

let P = null // payload

window.__INIT = async (payload) => {
  P = payload
  $('#s0 .title').textContent = payload.title
  $('#s0 .tagline').textContent = payload.tagline || ''
  $('#s1 .caption').textContent = payload.caption || ''
  $('#s3 img').src = payload.monogram

  const stage = $('#s2 .stage')
  stage.innerHTML = ''
  const s2 = payload.s2
  if (s2.type === 'image-compare') {
    stage.innerHTML = `
      <img class="fill before" /><img class="fill after" />
      <div class="divider"></div>
      <span class="tag" style="left:12px"></span>
      <span class="tag" style="right:12px"></span>
      <span class="pill">Generated with LU Cloud</span>`
    stage.querySelector('.before').src = s2.before
    stage.querySelector('.after').src = s2.after
    stage.querySelectorAll('.tag')[0].textContent = s2.beforeTag || 'Before'
    stage.querySelectorAll('.tag')[1].textContent = s2.afterTag || 'After'
  } else if (s2.type === 'image-crossfade') {
    stage.innerHTML = `
      <img class="fill before" /><img class="fill after" />
      <span class="pill">Generated with LU Cloud</span>`
    stage.querySelector('.before').src = s2.before
    stage.querySelector('.after').src = s2.after
  } else if (s2.type === 'image-cuts') {
    stage.innerHTML = `<img class="fill cut" /><span class="pill">Generated with LU Cloud</span>`
  } else if (s2.type === 'video' || s2.type === 'video-extend' || s2.type === 'video-pip') {
    stage.innerHTML = `<img class="fill vid" /><span class="pill">Generated with LU Cloud</span>`
    if (s2.type === 'video-extend') {
      stage.insertAdjacentHTML('beforeend', `
        <div class="timeline"><div class="orig"></div><div class="ext"></div></div>`)
      stage.querySelector('.orig').style.width = `${s2.boundaryPct}%`
      stage.querySelector('.ext').style.left = `${s2.boundaryPct}%`
    }
    if (s2.type === 'video-pip') {
      stage.insertAdjacentHTML('beforeend', `<div class="pip"><img /></div>`)
    }
  } else if (s2.type === 'audio-waveform') {
    const bars = (s2.peaks || []).map((p) => `<span style="height:${Math.max(3, Math.round(p * 150))}px"></span>`).join('')
    stage.innerHTML = `
      <div class="wtitle"></div>
      <div class="wave">${bars}</div>
      <div class="wavehead"></div>
      <span class="pill">Generated with LU Cloud</span>`
    stage.querySelector('.wtitle').textContent = s2.title || ''
  }

  // Preload every image the timeline will touch so seeking never races decode.
  const srcs = new Set()
  ;(payload.flowSrcByFrame || []).forEach((s) => s && srcs.add(s))
  ;(s2.imgsByFrame || []).forEach((s) => s && srcs.add(s))
  ;(s2.pipByFrame || []).forEach((s) => s && srcs.add(s))
  ;(s2.cuts || []).forEach((c) => srcs.add(c.src))
  ;[s2.before, s2.after, payload.monogram].forEach((s) => s && srcs.add(s))
  await Promise.all(
    [...srcs].map(
      (src) =>
        new Promise((res) => {
          const im = new Image()
          im.onload = res
          im.onerror = res
          im.src = src
        }),
    ),
  )
  window.__READY = true
}

window.__SEEK = (t) => {
  const f = Math.round(t * 30)
  const s2 = P.s2

  // S0 title card
  const s0 = window01(t, 0.05, 0.45, 1.35, 1.6)
  $('#s0').style.opacity = s0
  $('#s0 .underline').style.transform = `scaleX(${easeOut((t - 0.25) / 0.6)})`
  $('#s0 .title').style.transform = `translateY(${(1 - easeOut(t / 0.7)) * 8}px)`

  // S1 flow
  const s1 = window01(t, 1.4, 1.7, 6.55, 6.8)
  $('#s1').style.opacity = s1
  if (s1 > 0) {
    const src = P.flowSrcByFrame[Math.min(f, P.flowSrcByFrame.length - 1)]
    const img = $('#s1 img')
    if (src && img.getAttribute('src') !== src) img.src = src
    $('#s1 .frame').style.transform = `scale(${1 + 0.015 * easeInOut((t - 1.4) / 5.4)})`
  }

  // S2 result
  const s2op = window01(t, 6.6, 6.9, 10.55, 10.8)
  $('#s2').style.opacity = s2op
  if (s2op > 0) {
    const stage = $('#s2 .stage')
    if (s2.type === 'image-compare') {
      const x = 4 + 92 * easeInOut((t - 6.9) / 2.9)
      stage.querySelector('.after').style.clipPath = `inset(0 0 0 ${x}%)`
      stage.querySelector('.divider').style.left = `${x}%`
    } else if (s2.type === 'image-crossfade') {
      stage.querySelector('.before').style.opacity = 1 - easeInOut((t - 7.5) / 1.2)
    } else if (s2.type === 'image-cuts') {
      const cut = (s2.cuts || []).find((c) => t >= c.from && t < c.to) || s2.cuts[s2.cuts.length - 1]
      const img = stage.querySelector('.cut')
      if (img.getAttribute('src') !== cut.src) img.src = cut.src
      img.style.transform = `scale(${1.03 + 0.04 * clamp01((t - cut.from) / (cut.to - cut.from))})`
    } else if (s2.type === 'video' || s2.type === 'video-extend' || s2.type === 'video-pip') {
      const src = s2.imgsByFrame[Math.min(f, s2.imgsByFrame.length - 1)]
      const img = stage.querySelector('.vid')
      if (src && img.getAttribute('src') !== src) img.src = src
      if (s2.type === 'video-extend') {
        const prog = clamp01((t - 6.9) / 3.6)
        stage.querySelector('.ext').style.width = `${Math.max(0, prog * 100 - s2.boundaryPct) * (100 / (100 - s2.boundaryPct)) * ((100 - s2.boundaryPct) / 100)}%`
      }
      if (s2.type === 'video-pip') {
        const psrc = s2.pipByFrame[Math.min(f, s2.pipByFrame.length - 1)]
        const pimg = stage.querySelector('.pip img')
        if (psrc && pimg.getAttribute('src') !== psrc) pimg.src = psrc
      }
    } else if (s2.type === 'audio-waveform') {
      const prog = clamp01((t - 6.6) / 4.2)
      const x = 40 + (640 - 80) * prog
      stage.querySelector('.wavehead').style.left = `${x}px`
      const bars = stage.querySelectorAll('.wave span')
      const lit = Math.floor(prog * bars.length)
      bars.forEach((b, i) => {
        b.style.background = i <= lit ? '#a094f8' : 'rgba(255,255,255,0.22)'
      })
    }
  }

  // S3 outro
  const s3 = window01(t, 10.6, 10.95, 11.65, 12.0)
  $('#s3').style.opacity = s3
  $('#s3 .mark').style.transform = `scale(${0.85 + 0.15 * easeOut((t - 10.6) / 0.5)})`
  $('#s3 .ring').style.transform = `scale(${1 + 0.25 * easeInOut((t - 10.7) / 1.0)})`
  $('#s3 .ring').style.opacity = 1 - clamp01((t - 11.2) / 0.7)
}
