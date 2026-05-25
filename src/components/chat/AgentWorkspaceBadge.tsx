import { useState } from 'react'
import { Folder, Shield } from 'lucide-react'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { useChatStore } from '../../stores/chatStore'
import { AgentWorkspaceDialog } from './AgentWorkspaceDialog'
import type { AgentWorkspace } from '../../types/agent-workspace'

/**
 * Tiny pill next to the agent toggle that shows where the active chat
 * operates: "Sandbox" or the basename of the picked folder. Click to
 * change — re-opens AgentWorkspaceDialog so the user can swap mid-chat.
 *
 * Renders nothing unless agent mode is enabled for the active chat AND
 * a workspace has been chosen. The initial-choice flow is owned by
 * AgentModeToggle.
 */
export function AgentWorkspaceBadge() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const activeId = useChatStore((s) => s.activeConversationId)
  const isActive = useAgentModeStore((s) =>
    activeId ? s.agentModeActive[activeId] ?? false : false,
  )
  const workspace = useAgentModeStore((s) =>
    activeId ? s.workspaces[activeId] : undefined,
  )

  if (!activeId || !isActive || !workspace) return null

  const extras = workspace.kind === 'folder' ? workspace.extraPaths ?? [] : []
  const label =
    workspace.kind === 'folder'
      ? extras.length > 0
        ? `${basename(workspace.path)} +${extras.length}`
        : basename(workspace.path)
      : 'Sandbox'
  const Icon = workspace.kind === 'folder' ? Folder : Shield
  const tone =
    workspace.kind === 'folder'
      ? 'text-amber-500 border-amber-500/30'
      : 'text-emerald-500 border-emerald-500/30'

  const handleChoose = (next: AgentWorkspace) => {
    useAgentModeStore.getState().setWorkspace(activeId, next)
    setDialogOpen(false)
  }

  return (
    <>
      <button
        onClick={() => setDialogOpen(true)}
        title={
          workspace.kind === 'folder'
            ? `Agent working in ${workspace.path}. Click to change.`
            : 'Agent working in isolated sandbox. Click to switch to a real folder.'
        }
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors text-[0.55rem] bg-transparent hover:bg-white/5 ${tone}`}
      >
        <Icon size={10} />
        <span className="font-mono max-w-[120px] truncate">{label}</span>
      </button>

      {dialogOpen && (
        <AgentWorkspaceDialog
          open={true}
          conversationId={activeId}
          onChoose={handleChoose}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  )
}

function basename(p?: string): string {
  if (!p) return 'folder'
  const cleaned = p.replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}
