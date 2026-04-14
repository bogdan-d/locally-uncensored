import type { AgentBlock } from './agent-mode'

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ImageAttachment {
  data: string       // base64 encoded
  mimeType: string   // e.g. 'image/png', 'image/jpeg'
  name: string       // filename
}

export interface Message {
  id: string
  role: Role
  content: string
  thinking?: string
  timestamp: number
  images?: ImageAttachment[]
  sources?: { documentName: string; chunkIndex: number; preview: string }[]
  // Agent Mode fields
  agentBlocks?: AgentBlock[]
  toolCallSummary?: string
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'claude-code' | 'remote'
  createdAt: number
  updatedAt: number
}
