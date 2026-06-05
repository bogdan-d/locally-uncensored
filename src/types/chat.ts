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
  // Continue capability — tool-call history persisted between turns so
  // the model sees what it did before (parity with original Codex CLI).
  // Hidden messages are included in the API payload but not rendered.
  hidden?: boolean
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[]
  // Real token usage reported by the model (Ollama prompt_eval_count/eval_count,
  // OpenAI/LM-Studio usage.*). promptTokens = the FULL consumed context for that
  // turn (system prompt + tools + RAG + history + input), so it powers a
  // 100%-real context readout instead of a char/4 estimate.
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  systemPrompt: string
  mode?: 'lu' | 'codex' | 'openclaw' | 'remote'
  /** Per-chat persona toggle. Mirrors the mobile chat's `personaEnabled`
   *  flag so the user can flip the persona on/off for each chat
   *  individually without losing the selection in Settings. Undefined
   *  on legacy chats and treated as enabled. */
  personaEnabled?: boolean
  createdAt: number
  updatedAt: number
}
