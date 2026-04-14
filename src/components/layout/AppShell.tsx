import { useEffect, useState } from 'react'
import { Header } from './Header'
import { Sidebar } from './Sidebar'
import { ChatView } from '../chat/ChatView'
import { ModelManager } from '../models/ModelManager'
import { SettingsPage } from '../settings/SettingsPage'
import { CreateView } from '../create/CreateView'
import { BenchmarkView } from '../models/BenchmarkView'
import { Onboarding } from '../onboarding/Onboarding'
import { BackendSelector } from '../onboarding/BackendSelector'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useUIStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useProviderStore } from '../../stores/providerStore'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRemoteStore } from '../../stores/remoteStore'
import { extractMemoriesFromPair } from '../../hooks/useMemory'
import { detectLocalBackends, type DetectedBackend } from '../../lib/backend-detector'
import { backendCall, isTauri } from '../../api/backend'
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts'
import { ShortcutsModal } from './ShortcutsModal'
import { Titlebar } from './Titlebar'

export function AppShell() {
  const { currentView } = useUIStore()
  const { settings, updateSettings } = useSettingsStore()
  const onboardingDone = useSettingsStore((s) => s.settings.onboardingDone)
  const [restoring, setRestoring] = useState(false)

  const [detectedBackends, setDetectedBackends] = useState<DetectedBackend[]>([])
  const [showSelector, setShowSelector] = useState(false)

  useKeyboardShortcuts()

  // ── Store backup/restore: survive NSIS updates that wipe WebView2 data ──
  const STORE_KEYS = [
    'chat-conversations', 'chat-settings', 'chat-models', 'lu-providers',
    'create-store', 'locally-uncensored-codex', 'locally-uncensored-claude-code',
    'locally-uncensored-permissions', 'locally-uncensored-mcp-servers',
    'locally-uncensored-agent-mode', 'locally-uncensored-memory',
    'locally-uncensored-agent-workflows', 'locally-uncensored-agent',
    'locally-uncensored-voice', 'lu-benchmark-store', 'lu-update-checker-v2',
    'rag-store', 'workflow-store',
  ]
  const STORE_KEYS_SET = new Set(STORE_KEYS)

  // On startup: if localStorage was wiped, restore from %APPDATA% backup
  useEffect(() => {
    if (!isTauri()) return
    const hasStores = STORE_KEYS.some(k => localStorage.getItem(k))
    const restoreComplete = localStorage.getItem('lu-restore-complete')
    if (hasStores && restoreComplete) return // localStorage intact, no restore needed

    setRestoring(true)

    // 1. Fast path: check onboarding marker to prevent flash
    backendCall<boolean>('is_onboarding_done').catch(() => false).then(async (markerExists) => {
      // 2. Try full store restore
      try {
        const data = await backendCall<string | null>('restore_stores')
        if (data) {
          const parsed = JSON.parse(data)
          // Validate: must be a plain object with string values, only known keys
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            let restored = 0
            for (const [key, value] of Object.entries(parsed)) {
              if (STORE_KEYS_SET.has(key) && typeof value === 'string' && value) {
                localStorage.setItem(key, value)
                restored++
              }
            }
            if (restored > 0) {
              localStorage.setItem('lu-restore-complete', '1')
              window.location.reload()
              return
            }
          }
        }
      } catch {}

      // 3. No backup available — at least recover onboarding from marker file
      if (markerExists) {
        updateSettings({ onboardingDone: true })
      }
      setRestoring(false)
    })
  }, [])

  // Periodically backup stores to %APPDATA% (every 30s)
  useEffect(() => {
    if (!isTauri() || !onboardingDone) return
    // Migration: legacy users with localStorage onboardingDone=true but missing
    // marker file → write marker so NSIS update can recover without re-onboarding.
    backendCall<boolean>('is_onboarding_done').catch(() => false).then((markerExists) => {
      if (!markerExists) {
        backendCall('set_onboarding_done').catch(() => {})
      }
    })
    const doBackup = () => {
      const snapshot: Record<string, string> = {}
      for (const key of STORE_KEYS) {
        const val = localStorage.getItem(key)
        if (val) snapshot[key] = val
      }
      if (Object.keys(snapshot).length > 0) {
        localStorage.setItem('lu-restore-complete', '1') // sentinel for partial-restore detection
        backendCall('backup_stores', { data: JSON.stringify(snapshot) }).catch(() => {})
      }
    }
    doBackup() // immediate first backup
    const interval = setInterval(doBackup, 30_000)
    return () => clearInterval(interval)
  }, [onboardingDone])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings.theme === 'dark')
    document.documentElement.classList.toggle('light', settings.theme === 'light')
  }, [settings.theme])

  // ── Mirror remote mobile chat into the dispatched desktop conversation ──
  useEffect(() => {
    if (!isTauri()) return
    let unlisten: (() => void) | undefined
    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten = await listen<{ role: string; content: string; model?: string; mode?: string; chat_id?: string; chat_title?: string }>(
        'remote-chat-message',
        (event) => {
          const { role, content, mode, chat_id, chat_title, model } = event.payload || ({} as any)
          if (!role || !content) return
          const chat = useChatStore.getState()

          // ── Codex route ──────────────────────────────────────────────
          // Find or create a Codex desktop conversation keyed by the mobile
          // chat_id so successive messages from the same mobile Codex chat
          // land in the same desktop conversation. Marked with `mode: 'codex'`
          // so the Code sidebar tab picks them up.
          if (mode === 'codex') {
            const mobileChatId = chat_id || 'mobile-codex'
            const tagged = `[mobile:${mobileChatId}]`
            let conv = chat.conversations.find((c) =>
              c.mode === 'codex' && (c.title.includes(tagged) || (c as any).remoteChatId === mobileChatId),
            )
            let convId = conv?.id
            if (!convId) {
              const title = (chat_title && chat_title.trim())
                ? `${chat_title}  ${tagged}`
                : `Mobile Codex  ${tagged}`
              const activeModel = useModelStore.getState().activeModel || model || ''
              convId = chat.createConversation(activeModel, '', 'codex')
              chat.renameConversation(convId, title)
            }
            // Dedup
            const refreshed = useChatStore.getState().conversations.find((c) => c.id === convId)
            const last = refreshed?.messages[refreshed.messages.length - 1]
            if (last && last.role === role && last.content === content) return
            useChatStore.getState().addMessage(convId, {
              id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              role: role as any,
              content,
              timestamp: Date.now(),
            })
            return
          }

          // ── Default LU route: dispatched conversation ────────────────
          const { dispatchedConversationId } = useRemoteStore.getState()
          if (!dispatchedConversationId) return
          const conv = chat.conversations.find((c) => c.id === dispatchedConversationId)
          const last = conv?.messages[conv.messages.length - 1]
          if (last && last.role === role && last.content === content) return
          chat.addMessage(dispatchedConversationId, {
            id: `remote-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            role: role as any,
            content,
            timestamp: Date.now(),
          })

          // Auto-extract memories from remote user/assistant pairs so Remote
          // sessions contribute to the same cross-chat memory as desktop.
          if (role === 'assistant' && content.trim()) {
            const afterAdd = useChatStore
              .getState()
              .conversations.find((c) => c.id === dispatchedConversationId)
            const msgs = afterAdd?.messages || []
            let userMsg = ''
            for (let i = msgs.length - 2; i >= 0; i--) {
              if (msgs[i].role === 'user') {
                userMsg = msgs[i].content
                break
              }
            }
            if (userMsg) {
              extractMemoriesFromPair(userMsg, content, dispatchedConversationId).catch(
                () => {},
              )
            }
          }
        },
      )
    })()
    return () => {
      if (unlisten) unlisten()
    }
  }, [])

  // Auto-detect local backends on startup (once per session)
  useEffect(() => {
    if (!onboardingDone) return
    if (sessionStorage.getItem('lu-backend-detection-done')) return

    sessionStorage.setItem('lu-backend-detection-done', '1')

    detectLocalBackends().then((backends) => {
      if (backends.length === 0) return

      // Only 1 backend (any) → auto-enable it silently
      if (backends.length === 1) {
        const backend = backends[0]
        if (backend.id !== 'ollama') {
          useProviderStore.getState().setProviderConfig('openai', {
            enabled: true,
            name: backend.name,
            baseUrl: backend.baseUrl,
            isLocal: true,
          })
        }
        return
      }

      // Multiple backends detected → show selection dialog
      setDetectedBackends(backends)
      setShowSelector(true)
    })
  }, [onboardingDone])

  // While restoring from backup, show nothing (prevents onboarding flash)
  if (restoring) return null

  if (!onboardingDone) {
    return <Onboarding />
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100">
      <div className="h-full flex flex-col">
        <Titlebar />
        <Header />
        <div className="flex-1 flex overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-hidden">
            {currentView === 'chat' && <ErrorBoundary><ChatView /></ErrorBoundary>}
            {currentView === 'models' && <ErrorBoundary><ModelManager /></ErrorBoundary>}
            {currentView === 'benchmark' && <ErrorBoundary><BenchmarkView /></ErrorBoundary>}
            {currentView === 'settings' && <ErrorBoundary><SettingsPage /></ErrorBoundary>}
            {currentView === 'create' && <ErrorBoundary><CreateView /></ErrorBoundary>}
          </main>
        </div>
      </div>

      {/* Backend selection dialog (shown when multiple local backends detected) */}
      <BackendSelector
        open={showSelector}
        backends={detectedBackends}
        onClose={() => setShowSelector(false)}
      />
      <ShortcutsModal />
    </div>
  )
}
