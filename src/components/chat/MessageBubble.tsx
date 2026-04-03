import { motion } from 'framer-motion'
import { User, Bot, Copy, Check, Pencil, RefreshCw, X } from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallBlock } from './ToolCallBlock'
import { SpeakerButton } from './SpeakerButton'
import type { Message } from '../../types/chat'

interface Props {
  message: Message
  onRegenerate?: () => void
  onEdit?: (messageId: string, newContent: string) => void
}

export function MessageBubble({ message, onRegenerate, onEdit }: Props) {
  const [copied, setCopied] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  const isUser = message.role === 'user'

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus()
      editRef.current.style.height = 'auto'
      editRef.current.style.height = editRef.current.scrollHeight + 'px'
    }
  }, [isEditing])

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const startEdit = () => {
    setEditContent(message.content)
    setIsEditing(true)
  }

  const confirmEdit = () => {
    if (editContent.trim() && editContent !== message.content && onEdit) {
      onEdit(message.id, editContent.trim())
    }
    setIsEditing(false)
  }

  const cancelEdit = () => {
    setIsEditing(false)
    setEditContent('')
  }

  return (
    <motion.div
      className={'flex gap-2.5 px-3 py-2 group ' + (isUser ? 'flex-row-reverse' : '')}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <div
        className={
          'w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ' +
          (isUser
            ? 'bg-gray-200 dark:bg-white/10 border border-gray-300 dark:border-white/15'
            : 'bg-gray-100 dark:bg-[#2f2f2f] border border-gray-200 dark:border-white/10')
        }
      >
        {isUser ? <User size={13} className="text-gray-600 dark:text-gray-300" /> : <Bot size={13} className="text-gray-500 dark:text-gray-400" />}
      </div>

      <div className="max-w-[80%] space-y-1.5">
        {/* Thinking block (collapsible, lighter blue, italic, smaller) */}
        {!isUser && message.thinking && (
          <ThinkingBlock thinking={message.thinking} />
        )}

        {/* Agent Mode: Tool call blocks */}
        {!isUser && message.agentBlocks && message.agentBlocks.length > 0 && (
          <>
            {message.agentBlocks
              .filter((b) => b.phase === 'tool_call' && b.toolCall)
              .map((block) => (
                <ToolCallBlock key={block.id} toolCall={block.toolCall!} />
              ))}
          </>
        )}

        {/* Main answer bubble */}
        <div
          className={
            'rounded-xl px-3 py-2 relative ' +
            (isUser
              ? 'bg-gray-100 dark:bg-[#2f2f2f] border border-gray-200 dark:border-white/10'
              : 'bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-white/5')
          }
        >
          {isUser && isEditing ? (
            <div className="space-y-1.5">
              <textarea
                ref={editRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = e.target.scrollHeight + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmEdit() }
                  if (e.key === 'Escape') cancelEdit()
                }}
                className="w-full bg-transparent text-[0.8rem] leading-relaxed text-gray-800 dark:text-gray-200 resize-none focus:outline-none"
              />
              <div className="flex items-center gap-1 justify-end">
                <button onClick={confirmEdit} className="p-0.5 rounded hover:bg-green-500/20 text-green-500 transition-colors" title="Save & resend">
                  <Check size={12} />
                </button>
                <button onClick={cancelEdit} className="p-0.5 rounded hover:bg-red-500/20 text-red-400 transition-colors" title="Cancel">
                  <X size={12} />
                </button>
              </div>
            </div>
          ) : isUser ? (
            <p className="text-[0.8rem] leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="text-[0.8rem] leading-relaxed">
              <MarkdownRenderer content={message.content} />
            </div>
          )}

          {!isEditing && (
            <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
              {/* Edit (user messages only) */}
              {isUser && onEdit && (
                <button
                  onClick={startEdit}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-all"
                  aria-label="Edit message"
                >
                  <Pencil size={12} />
                </button>
              )}
              {/* Regenerate (assistant messages only) */}
              {!isUser && onRegenerate && (
                <button
                  onClick={onRegenerate}
                  className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-all"
                  aria-label="Regenerate response"
                >
                  <RefreshCw size={12} />
                </button>
              )}
              <button
                onClick={handleCopy}
                className="p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-gray-200 dark:hover:bg-white/10 text-gray-400 hover:text-gray-700 dark:hover:text-white transition-all"
                aria-label="Copy message"
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
              </button>
              {!isUser && <SpeakerButton text={message.content} />}
            </div>
          )}
        </div>

        {/* Sources section for RAG citations */}
        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="mt-2 pt-2 border-t border-gray-100 dark:border-white/5">
            <p className="text-[0.6rem] text-gray-400 mb-1">Sources:</p>
            {message.sources.map((s, i) => (
              <p key={i} className="text-[0.6rem] text-gray-500 dark:text-gray-400 truncate">
                [{i + 1}] {s.documentName} — {s.preview.slice(0, 60)}...
              </p>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}
