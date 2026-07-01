import { useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { useChatStore } from '../../stores/chatStore'
import { exportAllConversations, parseImportedChats } from '../../lib/chat-export'

/**
 * Chat Backup (konata 2026-06-28) — export ALL conversations to one JSON file
 * and re-import them. The web build has no store_backup.json, so a web user on
 * an SSH tunnel loses chats when the origin (host/port) changes; this is their
 * manual backup + restore path. Works on desktop too (native Save As dialog).
 */
export function ChatBackupSettings() {
  const conversations = useChatStore((s) => s.conversations)
  const importConversations = useChatStore((s) => s.importConversations)
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string>('')

  const handleExport = async () => {
    if (conversations.length === 0) {
      setMsg('No chats to export yet.')
      return
    }
    const res = await exportAllConversations(conversations)
    if (res.status === 'cancelled') return
    if (res.status === 'saved') {
      setMsg(`Saved ${res.count} chat${res.count === 1 ? '' : 's'} to ${res.path}`)
    } else {
      setMsg(`Downloaded ${res.count} chat${res.count === 1 ? '' : 's'} as JSON.`)
    }
  }

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const content = ev.target?.result as string
      if (!content) {
        setMsg('Could not read that file.')
        return
      }
      try {
        const convs = parseImportedChats(content)
        const { added, skipped } = importConversations(convs, 'merge')
        setMsg(
          added > 0
            ? `Imported ${added} chat${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already present` : ''}.`
            : `Nothing new — all ${skipped} chat${skipped === 1 ? '' : 's'} were already here.`,
        )
      } catch (err) {
        setMsg(err instanceof Error ? err.message : 'Could not import that file.')
      }
    }
    reader.onerror = () => setMsg('Could not read that file.')
    reader.readAsText(file)
  }

  return (
    <div className="space-y-2">
      <div className="text-[0.6rem] text-gray-500 dark:text-gray-500 leading-relaxed">
        Save all your chats to a single JSON file, or restore them from one. On the web version your chats live in the
        browser, so this is your backup if you ever open LU from a different address (e.g. after a tunnel reconnect).
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleExport}
          className="flex-1 text-[0.65rem] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors"
        >
          <Download size={12} /> Export all chats
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex-1 text-[0.65rem] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded border border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-white/20 transition-colors"
        >
          <Upload size={12} /> Import chats
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" onChange={handleImport} className="hidden" />
      </div>
      {msg && <div className="text-[0.6rem] text-gray-500 dark:text-gray-400">{msg}</div>}
    </div>
  )
}
