export type ChatMode = 'lu' | 'codex' | 'openclaw' | 'claude-code'

export type CodexEventType = 'instruction' | 'file_change' | 'terminal_output' | 'reasoning' | 'error' | 'done'

export interface CodexEvent {
  id: string
  type: CodexEventType
  content: string
  timestamp: number
  filePath?: string
  diff?: string
}

export interface CodexThread {
  id: string
  conversationId: string
  events: CodexEvent[]
  status: 'idle' | 'running' | 'error'
  workingDirectory: string
}

export interface FileTreeNode {
  name: string
  path: string
  isDirectory: boolean
  size?: number
  children?: FileTreeNode[]
}
