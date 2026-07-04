
import { useEffect, type RefObject } from 'react'

export function useClickAway(ref: RefObject<HTMLElement | null>, onAway: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onAway() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, onAway, active])
}