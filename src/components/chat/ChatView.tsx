import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useChat } from '../../hooks/useChat'
import { useChatStore } from '../../stores/chatStore'
import { useModelStore } from '../../stores/modelStore'
import { useRAGStore } from '../../stores/ragStore'
import { useAgentModeStore } from '../../stores/agentModeStore'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { RAGPanel } from './RAGPanel'
import { AgentModeToggle } from './AgentModeToggle'
import { ModelRecommendation } from '../models/ModelRecommendation'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useSettingsStore } from '../../stores/settingsStore'
import { FEATURE_FLAGS } from '../../lib/constants'
import { isAgentCompatible } from '../../lib/model-compatibility'
import { FileText, Bot, User, ChevronDown, Download, GitCompareArrows } from 'lucide-react'
import { TokenCounter } from './TokenCounter'
import { MemoryDebugToggle } from './MemoryDebugPanel'
import { ABCompare } from './ABCompare'
import { useCompareStore } from '../../stores/compareStore'
import { exportConversation } from '../../lib/chat-export'

export function ChatView() {
  const { sendMessage, stopGeneration, isGenerating, isLoadingModel, regenerateMessage, editAndResend, pendingApproval, approveToolCall, rejectToolCall } = useChat()
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const activeModel = useModelStore((s) => s.activeModel)
  const models = useModelStore((s) => s.models)
  const [ragPanelOpen, setRagPanelOpen] = useState(false)
  const [personaOpen, setPersonaOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { getActivePersona, setActivePersona } = useSettingsStore()
  const activePersona = getActivePersona()
  const allPersonas = useSettingsStore((s) => s.personas)

  const docCount = useRAGStore((s) =>
    activeConversationId ? (s.documents[activeConversationId] || []).length : 0
  )
  const ragEnabled = useRAGStore((s) =>
    activeConversationId ? s.ragEnabled[activeConversationId] ?? false : false
  )
  const isAgentActive = useAgentModeStore((s) =>
    activeConversationId ? s.agentModeActive[activeConversationId] ?? false : false
  )
  const isComparing = useCompareStore((s) => s.isComparing)
  const setComparing = useCompareStore((s) => s.setComparing)

  // A/B Compare mode takes over the entire view
  if (isComparing) {
    return <ABCompare />
  }

  return (
    <div className="h-full flex flex-col min-w-0">
      <AnimatePresence mode="wait">
        {!activeConversationId ? (
          // ── Homepage: just logo, no prompt ──
          <motion.div
            key="home"
            className="flex-1 flex flex-col items-center justify-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.2 }}
          >
            <img src="/LU-monogram-bw.png" alt="" width={46} height={46} className="dark:invert-0 invert opacity-20 mb-3" />
            <h1 className="text-[0.95rem] font-semibold text-gray-400 mb-0.5 tracking-wide">LUncensored</h1>
            <p className="text-[0.72rem] text-gray-600">No filters, no limits.</p>

            {models.length === 0 && <div className="mt-4"><ModelRecommendation /></div>}
            {models.length > 0 && !activeModel && (
              <p className="text-[0.6rem] text-amber-500/60 mt-3">Select a model above.</p>
            )}
          </motion.div>
        ) : (
          // ── Active chat ──
          <motion.div
            key="chat"
            className="flex-1 flex overflow-hidden"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <div className="flex-1 flex flex-col min-w-0">
              {/* Top bar: Token Counter + Documents + Agent Mode */}
              <div className="flex items-center justify-end gap-2 px-3 pt-1">
                {/* Token Counter */}
                <TokenCounter />

                {/* Memory Debug */}
                <MemoryDebugToggle />

                {/* Export */}
                <div className="relative">
                  <button
                    onClick={() => setExportOpen(!exportOpen)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-300 dark:border-white/15 hover:border-gray-400 dark:hover:border-white/25 text-gray-500 dark:text-gray-400 transition-colors text-xs"
                    title="Export chat"
                  >
                    <Download size={13} />
                  </button>
                  {exportOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setExportOpen(false)} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-36 rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1">
                        {(['markdown', 'json'] as const).map(fmt => (
                          <button
                            key={fmt}
                            onClick={() => {
                              const conv = conversations.find(c => c.id === activeConversationId)
                              if (conv) exportConversation(conv, fmt)
                              setExportOpen(false)
                            }}
                            className="w-full text-left px-3 py-1.5 text-[0.65rem] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
                          >
                            Export as .{fmt === 'markdown' ? 'md' : fmt}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Persona selector */}
                <div className="relative">
                  <button
                    onClick={() => setPersonaOpen(!personaOpen)}
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-300 dark:border-white/15 hover:border-gray-400 dark:hover:border-white/25 text-gray-500 dark:text-gray-400 transition-colors text-xs"
                  >
                    <User size={13} />
                    <span className="font-medium max-w-[80px] truncate">{activePersona?.name || 'No Persona'}</span>
                    <ChevronDown size={10} className={`transition-transform ${personaOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {personaOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setPersonaOpen(false)} />
                      <div className="absolute right-0 top-full mt-1 z-50 w-48 max-h-[250px] overflow-y-auto scrollbar-thin rounded-lg bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-white/10 shadow-xl py-1">
                        {/* Active persona pinned at top */}
                        {activePersona && (
                          <div className="px-2 pb-1 mb-1 border-b border-white/[0.06]">
                            <div className="px-2 py-1.5 rounded-md bg-white/[0.06] border border-white/10 text-[0.65rem] text-white font-medium flex items-center gap-1.5">
                              <div className="w-1 h-1 rounded-full bg-green-400 shrink-0" />
                              {activePersona.name}
                            </div>
                          </div>
                        )}
                        {/* Other personas */}
                        {allPersonas.filter(p => p.id !== activePersona?.id).map(p => (
                          <button
                            key={p.id}
                            onClick={() => { setActivePersona(p.id); setPersonaOpen(false) }}
                            className="w-full text-left px-3 py-1.5 text-[0.65rem] text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/5 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
                          >
                            {p.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Documents (RAG) */}
                <button
                  onClick={() => setRagPanelOpen(!ragPanelOpen)}
                  className={
                    'flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors text-xs ' +
                    (ragPanelOpen || ragEnabled
                      ? 'border-green-400 dark:border-green-500/40 text-green-600 dark:text-green-300'
                      : 'border-gray-300 dark:border-white/15 hover:border-gray-400 dark:hover:border-white/25 text-gray-500 dark:text-gray-400')
                  }
                  title="Document Chat (RAG)"
                >
                  <FileText size={13} />
                  <span className="font-medium">Documents</span>
                  {docCount > 0 && (
                    <span className={
                      'min-w-[16px] h-[16px] flex items-center justify-center rounded-full text-[0.55rem] font-bold ' +
                      (ragEnabled ? 'bg-green-500 text-white' : 'bg-gray-200 dark:bg-white/15 text-gray-600 dark:text-gray-300')
                    }>
                      {docCount}
                    </span>
                  )}
                </button>

                {/* A/B Compare */}
                <button
                  onClick={() => setComparing(true)}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-gray-300 dark:border-white/15 hover:border-gray-400 dark:hover:border-white/25 text-gray-500 dark:text-gray-400 transition-colors text-xs"
                  title="A/B Compare — test two models side by side"
                >
                  <GitCompareArrows size={13} />
                  <span className="font-medium">A/B</span>
                </button>

                {/* Agent Mode (Beta) */}
                {FEATURE_FLAGS.AGENT_MODE && (
                  <div className={
                    'flex items-center gap-1.5 px-3 py-1 rounded-full border transition-colors text-xs ' +
                    (isAgentActive
                      ? 'border-green-400 dark:border-green-500/40 text-green-600 dark:text-green-300'
                      : activeModel && !isAgentCompatible(activeModel)
                        ? 'border-gray-300/50 dark:border-white/8 text-gray-400 dark:text-gray-600 opacity-50'
                        : 'border-gray-300 dark:border-white/15 text-gray-500 dark:text-gray-400')
                  }>
                    <Bot size={13} />
                    <div className="flex flex-col items-start leading-none">
                      <span className="text-[0.45rem] text-amber-400 font-bold uppercase tracking-widest">Beta</span>
                      <span className="font-medium">Agent</span>
                    </div>
                    <AgentModeToggle />
                  </div>
                )}
              </div>

              <MessageList
                isGenerating={isGenerating}
                isLoadingModel={isLoadingModel}
                onRegenerate={regenerateMessage}
                onEdit={editAndResend}
              />
              <ChatInput
                onSend={sendMessage}
                onStop={stopGeneration}
                isGenerating={isGenerating}
                pendingApproval={pendingApproval}
                onApprove={approveToolCall}
                onReject={rejectToolCall}
              />
            </div>

            {/* RAG Panel */}
            <AnimatePresence>
              {ragPanelOpen && (
                <ErrorBoundary fallbackClassName="w-[280px] shrink-0 h-full border-l border-white/5 bg-[#2a2a2a] flex flex-col items-center justify-center p-6 gap-3">
                  <RAGPanel conversationId={activeConversationId} />
                </ErrorBoundary>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
