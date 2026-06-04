import { usePermissionStore } from '../../stores/permissionStore'
import { useChatStore } from '../../stores/chatStore'
import type { ToolCategory } from '../../api/mcp/types'
import { FolderOpen, Terminal, Monitor, Globe, Cpu, Image, Film, GitBranch, Lock } from 'lucide-react'

// Image generation is LIVE (chat agent → ComfyUI). Video generation is turned
// OFF for now (David 2026-06-04): it stays in the menu but greyed-out,
// struck-through and not clickable via the LOCKED set, and `video` defaults to
// 'blocked' in DEFAULT_PERMISSIONS so the tool is never offered to the model.
const LOCKED: Set<ToolCategory> = new Set(['video'])

const CATEGORIES: { key: ToolCategory; icon: typeof Globe; label: string }[] = [
  { key: 'web', icon: Globe, label: 'Web' },
  { key: 'system', icon: Cpu, label: 'System' },
  { key: 'filesystem', icon: FolderOpen, label: 'Files' },
  { key: 'terminal', icon: Terminal, label: 'Shell' },
  { key: 'desktop', icon: Monitor, label: 'Screenshot' },
  { key: 'image', icon: Image, label: 'Image' },
  { key: 'video', icon: Film, label: 'Video' },
  { key: 'workflow', icon: GitBranch, label: 'Workflows' },
]

export function PermissionOverrideBar() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const { getEffectivePermissions, setConversationOverride } = usePermissionStore()

  if (!activeConversationId) return null

  const permissions = getEffectivePermissions(activeConversationId)

  const toggleTool = (cat: ToolCategory) => {
    if (LOCKED.has(cat)) return
    const current = permissions[cat]
    setConversationOverride(activeConversationId, cat, current === 'blocked' ? 'auto' : 'blocked')
  }

  return (
    <div>
      {CATEGORIES.map(({ key, icon: Icon, label }) => {
        const isLocked = LOCKED.has(key)
        const isOn = !isLocked && permissions[key] !== 'blocked'
        return (
          <button
            key={key}
            onClick={() => toggleTool(key)}
            disabled={isLocked}
            className={`flex items-center gap-1.5 w-full px-1.5 py-[3px] text-[0.5rem] transition-colors ${
              isLocked
                ? 'text-gray-400 dark:text-gray-700 cursor-default'
                : isOn
                  ? 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5'
                  : 'text-gray-400 dark:text-gray-600 hover:bg-gray-100 dark:hover:bg-white/5'
            }`}
          >
            {isLocked ? (
              <Lock size={7} className="text-gray-700" />
            ) : (
              <Icon size={8} className={isOn ? 'text-green-400' : 'text-gray-600'} />
            )}
            <span className={`flex-1 text-left ${isLocked ? 'line-through' : ''}`}>{label}</span>
            {isLocked ? (
              <span className="text-[0.4rem] text-gray-700">soon</span>
            ) : (
              <div className={`w-1 h-1 rounded-full ${isOn ? 'bg-green-400' : 'bg-gray-700'}`} />
            )}
          </button>
        )
      })}
    </div>
  )
}
