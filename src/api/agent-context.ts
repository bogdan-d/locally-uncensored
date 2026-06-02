/**
 * Per-agent-run chat context — maps the currently executing agent loop
 * back to the conversation it belongs to. Lets the built-in tool
 * executors (`file_read`, `file_write`, `execute_code`, `shell_execute`)
 * thread a `chatId` through to the Rust side WITHOUT changing their
 * public args shape or polluting the tool JSON schema the model sees.
 *
 * How it flows:
 *   1. useAgentChat / useCodex → setActiveChatId(convId)
 *      at the start of their agent loop.
 *   2. Tool executors in `src/api/mcp/builtin-tools.ts` → backendCall
 *      includes `{ chatId: getActiveChatId() }` in the request body.
 *   3. Rust tool commands resolve relative paths against
 *      `~/agent-workspace/<chatId>/`, so every chat gets its own
 *      isolated workspace folder, created lazily on first write.
 *
 * When unset (standalone tool calls outside an agent loop), Rust falls
 * back to `~/agent-workspace/default/` so nothing ever lands in the
 * legacy shared folder.
 */

import type { AgentWorkspace } from '../types/agent-workspace'

let activeChatId: string | null = null
let activeWorkspace: AgentWorkspace | null = null

/**
 * The text model driving the current agent loop. Pinned by useAgentChat right
 * after setActiveWorkspace, read by the VRAM hand-off orchestrator (Feature EE)
 * to know which model to evict-then-reload around a ComfyUI generation.
 *
 *   - `name`       — the resolved model id actually sent to the provider (the
 *                    `-agent` variant when one exists), so a reload hits the
 *                    same runner the chat was using.
 *   - `providerId` — 'ollama' | 'openai' | 'anthropic' | … Cloud providers hold
 *                    no local VRAM, so the orchestrator skips all juggling.
 *   - `remote`     — true when the Ollama base points at a non-local host (LAN /
 *                    Docker / cluster). A remote Ollama also holds no LOCAL VRAM,
 *                    so likewise skip.
 */
export interface ActiveAgentModel {
  name: string
  providerId: string
  remote: boolean
}

let activeAgentModel: ActiveAgentModel | null = null

export function setActiveChatId(id: string | null | undefined): void {
  activeChatId = id ? String(id) : null
}

export function getActiveChatId(): string | null {
  return activeChatId
}

export function setActiveAgentModel(model: ActiveAgentModel | null | undefined): void {
  activeAgentModel = model && model.name ? { name: model.name, providerId: model.providerId, remote: !!model.remote } : null
}

export function getActiveAgentModel(): ActiveAgentModel | null {
  return activeAgentModel
}

export function clearActiveChatId(): void {
  activeChatId = null
  activeWorkspace = null
  activeAgentModel = null
}

// ── Multi-Repo Agent (Sprint C #8 from uselu) ──────────────────
//
// When the agent loop runs in a 'folder' workspace (vs the per-chat
// sandbox), the bridge resolves relative paths against `ws.path` and
// the system prompt advertises any additional repo paths in `extraPaths`
// so the model can address them by absolute path. Use case: "sync the
// API in repo-A with the client in repo-B" — primary = repo-A,
// extras = [repo-B].

/**
 * Pin the active workspace for the current agent loop. Called by
 * useAgentChat / useCodex right after setActiveChatId. Sandbox mode
 * passes null so the bridge falls back to ~/agent-workspace/<slug>/.
 */
export function setActiveWorkspace(ws: AgentWorkspace | null | undefined): void {
  if (ws && ws.kind === 'folder' && ws.path) {
    // Defensive: filter out blanks + dedupe extras + drop the primary if
    // a caller accidentally listed it as both. Keeps the public shape
    // stable for downstream readers (system prompt + chatCtx).
    const cleanedExtras = Array.isArray(ws.extraPaths)
      ? Array.from(
          new Set(
            ws.extraPaths
              .filter((p): p is string => typeof p === 'string' && p.length > 0)
              .filter((p) => p !== ws.path),
          ),
        )
      : []
    activeWorkspace = {
      kind: 'folder',
      path: ws.path,
      extraPaths: cleanedExtras.length > 0 ? cleanedExtras : undefined,
    }
  } else {
    // Sandbox (or unset) → leave pointer null so the bridge falls back
    // to its own per-chat sandbox path. Setting it to { kind: 'sandbox' }
    // would just duplicate state the bridge already owns.
    activeWorkspace = null
  }
}

export function getActiveWorkspace(): AgentWorkspace | null {
  return activeWorkspace
}

/**
 * Render the workspace section appended to the agent / Codex system
 * prompt. Empty string when the loop is in sandbox mode (the bridge
 * already knows its own sandbox path — no need to tell the model).
 */
export function renderWorkspaceSection(ws: AgentWorkspace | null): string {
  if (!ws || ws.kind !== 'folder' || !ws.path) return ''
  const extras = ws.extraPaths ?? []
  if (extras.length === 0) {
    return `\n\nPrimary workspace: ${ws.path}`
  }
  const lines = [
    '',
    '',
    'Workspaces (relative paths resolve against the primary; address extras by absolute path):',
    `- Primary:  ${ws.path}`,
    ...extras.map((p) => `- Extra:    ${p}`),
  ]
  return lines.join('\n')
}

/**
 * Build a human-readable workspace slug for a chat.
 *
 * Folders used to be named after the conversation UUID
 * (`~/agent-workspace/8f7c2a1b-…/`), which is technically unique but
 * useless to a human opening Explorer. Per user feedback, slug is now
 * `<title-kebabbed>-<6-char-id>` so the user can find their work.
 *
 * The 6-char id suffix keeps two chats with the same title from
 * colliding (e.g. two "Untitled" chats started in a row).
 *
 * Sanitisation: lowercase, ASCII alphanumerics + hyphen only, capped
 * at 40 chars. Empty / unprintable titles fall back to the UUID
 * suffix alone, which still gives a stable folder name. The Rust side
 * has its own paranoia layer (agent.rs::agent_workspace) so this is
 * defence in depth.
 */
export function chatWorkspaceSlug(id: string, title?: string | null): string {
  const idPart = (id || '').replace(/-/g, '').slice(0, 6) || 'noid'
  const rawTitle = (title || '').toLowerCase().trim()
  if (!rawTitle) return idPart
  const slug = rawTitle
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug ? `${slug}-${idPart}` : idPart
}
