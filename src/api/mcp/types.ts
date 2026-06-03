// MCP-shaped tool definitions and permission types

export type ToolCategory = 'filesystem' | 'terminal' | 'desktop' | 'web' | 'system' | 'image' | 'video' | 'workflow'

export type PermissionLevel = 'blocked' | 'confirm' | 'auto'

export type PermissionMap = Record<ToolCategory, PermissionLevel>

export const DEFAULT_PERMISSIONS: PermissionMap = {
  filesystem: 'confirm',
  terminal: 'confirm',
  desktop: 'confirm',
  web: 'auto',
  system: 'auto',
  image: 'confirm',
  video: 'confirm',
  workflow: 'confirm',
}

export interface MCPToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, {
      type: string
      description: string
      enum?: string[]
    }>
    required: string[]
  }
  category: ToolCategory
  source: 'builtin' | 'external'
  serverId?: string // for external MCP server tools
}

export interface MCPServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}
