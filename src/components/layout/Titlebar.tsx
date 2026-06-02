import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { LuLogo } from './LuLogo'

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri) return

    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      // Check initial state
      win.isMaximized().then(setIsMaximized)

      // Listen for resize to update maximize state
      win.onResized(() => {
        win.isMaximized().then(setIsMaximized)
      }).then((fn) => { unlisten = fn })
    })

    return () => { unlisten?.() }
  }, [])

  if (!isTauri) return null

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().minimize()
  }

  const handleToggleMaximize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().close()
  }

  const btnBase = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors'

  return (
    <div
      data-tauri-drag-region
      className="h-8 flex items-center justify-between bg-white dark:bg-[#141414] border-b border-gray-200 dark:border-white/[0.06] select-none"
    >
      {/* Left: App icon + title */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pl-3">
        <LuLogo size={21} className="pointer-events-none" />
      </div>

      {/* Right: Window controls */}
      <div className="flex items-center">
        <button
          onClick={handleMinimize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label="Minimize"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleToggleMaximize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={11} strokeWidth={1.5} /> : <Square size={11} strokeWidth={1.5} />}
        </button>
        <button
          onClick={handleClose}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-red-500 hover:text-white`}
          aria-label="Close"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
