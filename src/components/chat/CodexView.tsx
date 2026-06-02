import { useCodex } from '../../hooks/useCodex'
import { useCodexStore } from '../../stores/codexStore'
import { useChatStore } from '../../stores/chatStore'
import { ChatInput } from './ChatInput'
import { ToolCallBlock } from './ToolCallBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TokenCounter } from './TokenCounter'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { RealtimeCounter } from './RealtimeCounter'
import { PluginsDropdown } from './PluginsDropdown'
import { TypingIndicator } from './TypingIndicator'
import { useSettingsStore } from '../../stores/settingsStore'
import { StagedChangesPanel } from './StagedChangesPanel'
import { User, Code, Brain, Eye, GitBranch, Download, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { checkGitInstalled, openExternal, type GitStatus } from '../../api/backend'

function stripChannelTags(text: string): string {
  return text
    .replace(/<\|?channel>?\s*thought\s*/gi, '')
    .replace(/<\|?channel\|?>/gi, '')
    .replace(/<channel\|>/gi, '')
    .trim()
}

export function CodexView() {
  const { sendInstruction, stopCodex, isRunning } = useCodex()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const thread = useCodexStore((s) => activeConversationId ? s.threads[activeConversationId] : undefined)
  const scrollRef = useRef<HTMLDivElement>(null)

  const conversation = conversations.find(c => c.id === activeConversationId)
  const messages = conversation?.messages || []

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, thread?.events])

  const thinkingEnabled = useSettingsStore((s) => s.settings.thinkingEnabled)
  const codexReviewMode = useSettingsStore((s) => s.settings.codexReviewMode)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Git availability for the Codex view (v2.5.0). Codex shells out to git for
  // git_status/diff/commit/log; if git is missing those tools fail. Probe on
  // open and surface a minimal install banner when it's not on PATH.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitChecking, setGitChecking] = useState(false)
  useEffect(() => {
    let cancelled = false
    setGitChecking(true)
    checkGitInstalled()
      .then((s) => { if (!cancelled) setGitStatus(s) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setGitChecking(false) })
    return () => { cancelled = true }
  }, [])
  const recheckGit = () => {
    setGitChecking(true)
    checkGitInstalled().then(setGitStatus).catch(() => {}).finally(() => setGitChecking(false))
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Main panel */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Codex header */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 border-b border-gray-200 dark:border-white/[0.04]">
          <Code size={9} className="text-gray-500" />
          <span className="text-[0.55rem] text-gray-600 dark:text-gray-400 font-medium">Coding Agent</span>
          {/* Code-Review Mode badge (B13) — makes it impossible to miss
              that the agent is read-only. The toggle itself lives in
              Settings → Codex Agent; clicking the badge jumps you there
              isn't worth a routing change in v2.5.0. */}
          {codexReviewMode && (
            <span
              className="flex items-center gap-1 px-1.5 py-0 rounded border border-amber-500/30 text-amber-500 text-[0.55rem] bg-amber-500/[0.04]"
              title="Code-Review Mode is active. The coding agent will inspect the codebase but won't write files or run commands. Disable in Settings → Coding Agent."
            >
              <Eye size={9} />
              <span>Review</span>
            </span>
          )}
          <div className="flex-1" />
          <TokenCounter />
          <MemoryDebugToggle />
          <PluginsDropdown />
        </div>

        {/* Git-missing banner (v2.5.0). Codex shells out to git for
            status/diff/commit/log — without it those tools fail. Minimal,
            dismiss-by-installing: an Install button (opens the platform git
            download page) + a Recheck button for after the install. */}
        {gitStatus && !gitStatus.installed && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/20 bg-amber-500/[0.06]">
            <GitBranch size={12} className="text-amber-500 shrink-0" />
            <span className="text-[0.6rem] text-amber-600 dark:text-amber-400/90 flex-1 leading-tight">
              Git isn't installed. The coding agent needs it for diffs, commits and history.
            </span>
            <button
              onClick={() => openExternal(gitStatus.download_url)}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 transition-colors"
            >
              <Download size={11} /> Install Git
            </button>
            <button
              onClick={recheckGit}
              disabled={gitChecking}
              title="Re-check after installing Git"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.6rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={11} className={gitChecking ? 'animate-spin' : ''} />
            </button>
          </div>
        )}

        {/* Stage-and-Approve queue (B10). Renders nothing when there
            are no pending changes for the active chat, so non-stage-mode
            users never see it. */}
        <StagedChangesPanel chatId={activeConversationId} />

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Code size={24} className="text-gray-300 dark:text-gray-700 mb-2" />
              <p className="text-[0.7rem] text-gray-500 font-medium">Coding Agent</p>
              <p className="text-[0.55rem] text-gray-400 dark:text-gray-600 mt-0.5 max-w-[300px]">
                Send a coding instruction. The coding agent will read your codebase, write code, and run commands.
              </p>
              {!thread?.workingDirectory && (
                <p className="text-[0.55rem] text-amber-500/70 mt-2">
                  Set a working directory in the file tree panel →
                </p>
              )}
            </div>
          ) : (
            <div className="py-1">
              {messages.filter(msg => !msg.hidden).map((msg) => {
                const cleanContent = msg.content ? stripChannelTags(msg.content) : ''
                return (
                  <div
                    key={msg.id}
                    className={`flex gap-2 px-3 py-1 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                  >
                    <div className={`w-5 h-5 rounded flex items-center justify-center shrink-0 ${
                      msg.role === 'user'
                        ? 'bg-gray-100 dark:bg-white/8'
                        : 'bg-gray-50 dark:bg-white/5'
                    }`}>
                      {msg.role === 'user'
                        ? <User size={9} className="text-gray-400" />
                        : <Code size={9} className="text-gray-500" />
                      }
                    </div>
                    <div className="max-w-[85%] space-y-0.5">
                      {/* Thinking */}
                      {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock thinking={msg.thinking} />
                      )}
                      {/* Reflection blocks (Architect plan, RepoMap
                          context, etc.) — rendered above the tool calls
                          in chronological order so the user can see what
                          context primed the editor model before it
                          started fetching tools. */}
                      {msg.role === 'assistant' && msg.agentBlocks && msg.agentBlocks.length > 0 && (
                        <div className="space-y-1">
                          {msg.agentBlocks
                            .filter((b) => b.phase === 'reflection' && b.content)
                            .map((block) => (
                              <div
                                key={block.id}
                                className="px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 bg-gray-50/60 dark:bg-white/[0.02] text-[0.7rem] text-gray-700 dark:text-gray-300"
                              >
                                <MarkdownRenderer content={block.content} />
                              </div>
                            ))}
                        </div>
                      )}
                      {/* Interleaved blocks (Codex 2026-05) — when the
                          assistant turn produced per-iteration 'answer'
                          blocks, render tool_call + answer blocks in
                          chronological order so commentary sits BETWEEN tool
                          calls instead of all text bunching at the bottom.
                          Falls back to the legacy split (tool-calls only,
                          full text below) for older chats that have only
                          tool_call blocks. */}
                      {msg.role === 'assistant' && msg.agentBlocks && msg.agentBlocks.length > 0
                        ? (() => {
                            const hasAnswerBlock = msg.agentBlocks!.some(
                              (b) => b.phase === 'answer' && b.content.trim(),
                            )
                            if (hasAnswerBlock) {
                              return (
                                <div className="space-y-1">
                                  {[...msg.agentBlocks!]
                                    .filter(
                                      (b) =>
                                        (b.phase === 'tool_call' && b.toolCall) ||
                                        (b.phase === 'answer' && b.content.trim()),
                                    )
                                    .sort((a, b) => a.timestamp - b.timestamp)
                                    .map((block) => {
                                      if (block.phase === 'tool_call' && block.toolCall) {
                                        return (
                                          <ToolCallBlock key={block.id} toolCall={block.toolCall} />
                                        )
                                      }
                                      if (block.phase === 'answer' && block.content.trim()) {
                                        return (
                                          <div key={block.id} className="px-1 py-0.5">
                                            <div className="text-[0.75rem] leading-relaxed">
                                              <MarkdownRenderer
                                                content={stripChannelTags(block.content)}
                                              />
                                            </div>
                                          </div>
                                        )
                                      }
                                      return null
                                    })}
                                </div>
                              )
                            }
                            return (
                              <div className="space-y-0">
                                {msg.agentBlocks!
                                  .filter((b) => b.phase === 'tool_call' && b.toolCall)
                                  .map((block) => (
                                    <ToolCallBlock key={block.id} toolCall={block.toolCall!} />
                                  ))}
                              </div>
                            )
                          })()
                        : null}

                      {/* Text content — user bubble always; assistant only
                          when there are no per-iteration answer blocks (the
                          interleave path above already rendered them inline).
                          Assistant drops the bubble entirely to match the
                          regular Chat view; user keeps theirs as the
                          right-aligned anchor. */}
                      {cleanContent && (msg.role === 'user' ||
                        !(msg.agentBlocks && msg.agentBlocks.some((b) => b.phase === 'answer' && b.content.trim()))) && (
                        <div className={
                          msg.role === 'user'
                            ? 'rounded-lg px-2.5 py-1.5 bg-gray-100 dark:bg-white/[0.06] border border-gray-200 dark:border-white/[0.08]'
                            : 'px-1 py-0.5'
                        }>
                          <div className="text-[0.75rem] leading-relaxed">
                            {msg.role === 'user' ? (
                              <p className="text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{cleanContent}</p>
                            ) : (
                              <MarkdownRenderer content={cleanContent} />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
              {/* 3-dot indicator while Codex is mid-loop — parity with
                  the Chat tab so users on long Gemma 4 / Codex runs
                  see "still thinking" instead of staring at a frozen
                  pane between iterations. */}
              {isRunning && (
                <TypingIndicator />
              )}
            </div>
          )}
        </div>

        {/* Realtime counter */}
        <RealtimeCounter isRunning={isRunning} />

        {/* Input */}
        <ChatInput
          onSend={(content) => sendInstruction(content)}
          onStop={stopCodex}
          isGenerating={isRunning}
        />
      </div>

      {/* Right sidebar: File Tree */}
      <div className="w-48 shrink-0">
        <FileTree />
      </div>
    </div>
  )
}

import { FileTree } from './FileTree'
