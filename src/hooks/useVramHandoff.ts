/**
 * Feature EE (v2.5.0) — React listener for VRAM hand-off phase events.
 *
 * Subscribes to the orchestrator's EventTarget channel (src/api/vram-handoff.ts
 * `onHandoff`) and maps the latest phase into component state for VramSwitchCard.
 *
 * The card shows an HONEST per-generation status. Two cases:
 *   - An actual VRAM swap (heavy video, or image on a tight card): the
 *     orchestrator fires `freeing_vram` first → `evicted` becomes true → the
 *     card uses "freeing VRAM / VRAM swap in progress / restoring chat" copy.
 *   - No eviction (the common image case — the small chat model and the SDXL
 *     checkpoint co-exist): no `freeing_vram` fires, so `evicted` stays false,
 *     but the card STILL shows from `loading_image_model` onward with plain
 *     "loading the image model / generating" copy and NO false "freeing VRAM"
 *     claim (David 2026-06-16: the image tool should show status too, honestly).
 * `done`/`error` are terminal and reset the state.
 */

import { useEffect, useRef, useState } from 'react'
import { onHandoff, type HandoffPhase } from '../api/vram-handoff'

export interface VramHandoffState {
  /** True while a generation status card should show (loading the gen model →
   *  generating → restoring), regardless of whether a VRAM swap happened. */
  active: boolean
  /** True once an actual VRAM eviction happened this cycle (`freeing_vram`
   *  observed). Drives the "swap" wording vs. plain loading/generating copy. */
  evicted: boolean
  /** Latest phase seen. */
  phase: HandoffPhase | null
  /** 'image' | 'video' for copy tailoring. */
  kind: 'image' | 'video' | null
  /** Free-text detail (model name / error message). */
  detail: string | null
}

const INITIAL: VramHandoffState = { active: false, evicted: false, phase: null, kind: null, detail: null }

export function useVramHandoff(): VramHandoffState {
  const [state, setState] = useState<VramHandoffState>(INITIAL)
  // Pending terminal-reset timer. Stored so a NEW generation that starts within
  // the 1200ms window cancels the previous gen's reset — otherwise the orphaned
  // timer fires mid-gen-#2 and blanks the live card (back-to-back image→video).
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const unsub = onHandoff((d) => {
      // Any new event means a gen is in flight — cancel a pending reset from a
      // prior gen so it can't clobber this one.
      if (resetTimer.current) { clearTimeout(resetTimer.current); resetTimer.current = null }
      setState((prev) => {
        let active = prev.active
        let evicted = prev.evicted
        // `deciding` is the orchestrator's first emit for every generation, so
        // re-arm the per-cycle flags here. Without this, gen #2 inherits gen #1's
        // `evicted` and shows a false "VRAM swap" / "restoring chat model" copy.
        if (d.phase === 'deciding') { active = false; evicted = false }
        // A real swap is marked by `freeing_vram`; the card becomes visible as
        // soon as the gen starts loading its model, so a no-eviction image gen
        // still gets an honest "loading / generating" banner.
        if (d.phase === 'freeing_vram') { active = true; evicted = true }
        if (d.phase === 'loading_image_model' || d.phase === 'generating') active = true
        if (d.terminal) active = false
        return {
          active,
          evicted,
          phase: d.phase,
          kind: d.kind ?? prev.kind,
          detail: d.detail ?? null,
        }
      })
      // After a terminal event, fully reset shortly so a fresh generation starts
      // from a clean slate (and the card unmounts cleanly).
      if (d.terminal) {
        resetTimer.current = setTimeout(() => { resetTimer.current = null; setState(INITIAL) }, 1200)
      }
    })
    return () => { if (resetTimer.current) clearTimeout(resetTimer.current); unsub() }
  }, [])

  return state
}
