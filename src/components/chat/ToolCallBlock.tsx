import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, Globe, FileText, FileEdit, Terminal, Image, Film, Loader2, Check, X, Clock, AlertCircle, FolderOpen, Cpu, Monitor, GitBranch, Database } from 'lucide-react'
import type { AgentToolCall } from '../../types/agent-mode'

// F1 (konata3602 commitment 2026-05-23) — when image_generate / screenshot
// produce an output URL the agent surfaces, we want the user to actually
// SEE the picture rather than a path string. ComfyUI serves output via
// http://localhost:8188/view?…; this regex pulls the URL out of the
// result so we can render an <img> below the raw text. Only fires for
// images we generated ourselves — third-party URLs in a tool result
// must NOT be auto-loaded (CSP + privacy).
// Exported for unit testing (see __tests__/ToolCallBlock-image.test.ts).
export const INLINE_IMAGE_RE = /(http:\/\/(?:localhost|127\.0\.0\.1):\d+\/view\?[^\s)\]]+)/i

// Feature EE (v2.5.0): video_generate can produce .mp4 (VHS_VideoCombine) or
// .webm outputs. We render those in a <video> element instead of an <img>.
// Animated .webp (SaveAnimatedWEBP) animates fine inside <img>, so it stays on
// the image path. The output filename rides in the `filename=` query param of
// the /view URL, so we inspect THAT, not the URL tail (which ends in `&t=…`).
// Exported for unit testing.
export function isInlineVideoUrl(url: string): boolean {
  try {
    const m = /[?&]filename=([^&]+)/i.exec(url)
    const name = m ? decodeURIComponent(m[1]) : url
    return /\.(mp4|webm)$/i.test(name)
  } catch {
    return /\.(mp4|webm)(?=[?&]|$)/i.test(url)
  }
}

interface Props {
  toolCall: AgentToolCall
  onApprove?: () => void
  onReject?: () => void
}

const TOOL_ICONS: Record<string, typeof Search> = {
  web_search: Search,
  web_fetch: Globe,
  file_read: FileText,
  file_write: FileEdit,
  file_list: FolderOpen,
  file_search: Search,
  code_execute: Terminal,
  shell_execute: Terminal,
  system_info: Cpu,
  process_list: Cpu,
  screenshot: Monitor,
  image_generate: Image,
  video_generate: Film,
  run_workflow: GitBranch,
}

const STATUS_ICONS = {
  pending_approval: Clock,
  running: Loader2,
  completed: Check,
  failed: AlertCircle,
  rejected: X,
  // Phase 6 (v2.4.0): cached result from in-turn cache, no re-execution.
  cached: Database,
}

export function ToolCallBlock({ toolCall, onApprove, onReject }: Props) {
  // Default: collapsed (closed)
  const [open, setOpen] = useState(toolCall.status === 'pending_approval')

  const ToolIcon = TOOL_ICONS[toolCall.toolName] || Terminal
  const StatusIcon = STATUS_ICONS[toolCall.status]
  const isRunning = toolCall.status === 'running'
  const isPending = toolCall.status === 'pending_approval'
  const isFailed = toolCall.status === 'failed' || toolCall.status === 'rejected'

  return (
    <div className="mb-0.5">
      {/* Header line — monochrome, only status icon has subtle color */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity w-full"
      >
        <ToolIcon size={10} className="text-gray-500 dark:text-gray-500 shrink-0" />
        <span className="text-[0.65rem] text-gray-600 dark:text-gray-400">{toolCall.toolName}</span>
        <StatusIcon size={9} className={`shrink-0 ${
          toolCall.status === 'completed' ? 'text-gray-400 dark:text-gray-500' :
          isFailed ? 'text-red-400/60' :
          isPending ? 'text-amber-400/60' :
          'text-gray-500'
        } ${isRunning ? 'animate-spin' : ''}`} />
        {toolCall.duration != null && (
          <span className="text-[0.5rem] text-gray-500 dark:text-gray-600">
            {toolCall.duration < 1000 ? `${toolCall.duration}ms` : `${(toolCall.duration / 1000).toFixed(1)}s`}
          </span>
        )}
      </button>

      {/* Expandable details */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="pl-5 pb-1.5 space-y-1">
              {/* Arguments */}
              <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-x-auto scrollbar-thin">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>

              {/* Result */}
              {toolCall.result && (
                <>
                  <pre className="text-[0.55rem] leading-relaxed text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1 overflow-auto scrollbar-thin max-h-[300px]">
                    {toolCall.result}
                  </pre>
                  {/* Inline preview (F1 + Feature EE) — only when the result
                      contains a ComfyUI view URL. Bounded to localhost so we
                      never auto-load arbitrary tool output. A .mp4/.webm output
                      (video_generate via VHS_VideoCombine) renders in a
                      <video>; everything else — including animated .webp — in
                      an <img>. */}
                  {(() => {
                    const m = toolCall.result?.match(INLINE_IMAGE_RE)
                    if (!m) return null
                    const url = m[1]
                    if (isInlineVideoUrl(url)) {
                      return (
                        <video
                          src={url}
                          controls
                          loop
                          className="block mt-1 max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
                        />
                      )
                    }
                    return (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block mt-1"
                      >
                        <img
                          src={url}
                          alt="Generated image"
                          className="max-w-full max-h-[320px] rounded border border-gray-200 dark:border-white/[0.06]"
                          loading="lazy"
                        />
                      </a>
                    )
                  })()}
                </>
              )}

              {/* Error */}
              {toolCall.error && (
                <pre className="text-[0.55rem] leading-relaxed text-gray-500 dark:text-gray-500 bg-gray-50 dark:bg-white/[0.02] rounded px-2 py-1">
                  {toolCall.error}
                </pre>
              )}

              {/* Approval buttons — subtle green / red as the user
                  asked for ("approve grün, reject rot, sauber, keine
                  Neonfarben"). Sits inline in the pending tool block
                  instead of a popup over the input. Enter / Esc still
                  trigger the head-of-queue approval (handled in
                  ChatView). */}
              {isPending && onApprove && onReject && (
                <div className="flex items-center gap-1.5 pt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); onApprove() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/15 dark:hover:bg-emerald-500/15 border border-emerald-500/20 dark:border-emerald-500/25 transition-colors"
                  >
                    <Check size={10} /> Approve
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); onReject() }}
                    className="flex items-center gap-1 px-2.5 py-1 rounded text-[0.6rem] font-medium text-red-700 dark:text-red-300 bg-red-500/10 dark:bg-red-500/10 hover:bg-red-500/15 dark:hover:bg-red-500/15 border border-red-500/20 dark:border-red-500/25 transition-colors"
                  >
                    <X size={10} /> Reject
                  </button>
                  <span className="ml-1 text-[0.5rem] text-gray-400 dark:text-gray-600 font-mono">⏎ / Esc</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
