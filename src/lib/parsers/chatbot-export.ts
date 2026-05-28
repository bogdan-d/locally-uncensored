// Feature CC v2.5.0 — Chatbot export importer (MikeS++ Discord 2026-05-27).
// Parses ChatGPT / Claude / Gemini conversation exports and produces a
// normalised list of `{title, markdown}` items the rest of the importer can
// feed into the RAG pipeline as if they were ordinary text uploads.
//
// We accept either a raw JSON file (the user already unzipped the export)
// or a .zip (we walk it for conversations.json). The parsers are loose by
// design: each platform's export schema has churned multiple times, and
// failing to import a conversation is much better than crashing the whole
// import run. Unrecognised entries are skipped and counted in the result
// so the UI can surface a "skipped N items" hint.

import JSZip from 'jszip'

export type ChatbotPlatform = 'chatgpt' | 'claude' | 'gemini' | 'unknown'

export interface NormalisedConversation {
  /** Stable id for the import list (filename-safe). */
  id: string
  /** Human-readable title (falls back to "Untitled <date>"). */
  title: string
  /** Final markdown a RAG processor will consume. */
  markdown: string
  /** Best-guess platform — surfaced as the document's source field. */
  platform: ChatbotPlatform
  /** ISO timestamp of the conversation (creation or last update). */
  timestamp: string | null
  /** Message count, for the UI. */
  messageCount: number
}

export interface ParseResult {
  conversations: NormalisedConversation[]
  /** Number of items in the raw export we couldn't map to a conversation. */
  skipped: number
  /** Detected platform across the export (heuristic). */
  detectedPlatform: ChatbotPlatform
}

/** Read a File object as text. */
async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'))
    reader.readAsText(file)
  })
}

/** Detect platform from the parsed JSON shape. */
export function detectPlatform(parsed: unknown): ChatbotPlatform {
  if (!parsed) return 'unknown'
  if (Array.isArray(parsed) && parsed.length > 0) {
    const sample = parsed[0] as Record<string, unknown>
    // ChatGPT exports use `mapping` (id → message node).
    if (sample && typeof sample === 'object' && 'mapping' in sample) return 'chatgpt'
    // Claude uses `chat_messages` (array of { sender, text }).
    if (sample && typeof sample === 'object' && 'chat_messages' in sample) return 'claude'
    // Gemini Takeout activity exports use `title` + `messages` and `header` = "Gemini Apps"
    if (sample && typeof sample === 'object' && 'header' in sample && String((sample as any).header || '').toLowerCase().includes('gemini')) return 'gemini'
  }
  // Some Gemini bundles use a wrapper { activities: [...] }.
  if (typeof parsed === 'object' && parsed !== null && 'activities' in parsed) return 'gemini'
  return 'unknown'
}

/** Sanitise a string for use as a filename / id. */
function slugify(s: string, fallback: string): string {
  const cleaned = (s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
  return cleaned || fallback
}

// ── ChatGPT ────────────────────────────────────────────────────────────
// Schema (verified against OpenAI Data Export Aug 2024 + Apr 2026):
//   [
//     {
//       "title": "...",
//       "create_time": 1700000000.0,
//       "update_time": 1700001000.0,
//       "mapping": {
//         "<uuid>": {
//           "id": "<uuid>",
//           "message": null | {
//             "id": "...",
//             "author": { "role": "system" | "user" | "assistant" | "tool", ... },
//             "create_time": 1700000000.0,
//             "content": { "content_type": "text", "parts": ["..."] }
//           },
//           "parent": "<uuid>" | null,
//           "children": ["<uuid>", ...]
//         }
//       }
//     }
//   ]
function parseChatGpt(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue
    const c = conv as Record<string, unknown>
    const title = String(c.title || '').trim() || 'Untitled ChatGPT conversation'
    const createTime = typeof c.create_time === 'number' ? c.create_time : null
    const updateTime = typeof c.update_time === 'number' ? c.update_time : null
    const timestamp = updateTime ?? createTime
    const isoTimestamp = timestamp ? new Date(timestamp * 1000).toISOString() : null

    const mapping = c.mapping as Record<string, any> | undefined
    if (!mapping) continue

    // Linearise the message tree by walking from root following the first
    // child each time. That matches what the user actually saw in the UI
    // (alternative branches were never visible in the rendered conversation).
    const root = Object.values(mapping).find(n => n && n.parent == null) as any
    if (!root) continue
    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    let node = root
    let messageCount = 0
    while (node) {
      const msg = node.message
      if (msg && msg.author && msg.content) {
        const role = String(msg.author.role || 'unknown')
        const parts = Array.isArray(msg.content.parts) ? msg.content.parts : []
        const text = parts.map((p: any) => typeof p === 'string' ? p : (p?.text || '')).join('\n').trim()
        if (text && role !== 'tool' && role !== 'system') {
          const heading = role === 'user' ? '**You**' : (role === 'assistant' ? '**Assistant**' : `**${role}**`)
          lines.push(heading, '', text, '')
          messageCount++
        }
      }
      const children = Array.isArray(node.children) ? node.children : []
      const next = children[0]
      node = next ? mapping[next] : null
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `chatgpt_${createTime || out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'chatgpt',
      timestamp: isoTimestamp,
      messageCount,
    })
  }
  return out
}

// ── Claude ─────────────────────────────────────────────────────────────
// Schema (verified against Anthropic export Apr 2026):
//   [
//     {
//       "uuid": "...",
//       "name": "...",
//       "created_at": "2026-01-01T...",
//       "updated_at": "...",
//       "chat_messages": [
//         {
//           "uuid": "...",
//           "text": "...",
//           "sender": "human" | "assistant",
//           "created_at": "..."
//         }
//       ]
//     }
//   ]
function parseClaude(raw: unknown): NormalisedConversation[] {
  if (!Array.isArray(raw)) return []
  const out: NormalisedConversation[] = []
  for (const conv of raw) {
    if (!conv || typeof conv !== 'object') continue
    const c = conv as Record<string, unknown>
    const title = String(c.name || '').trim() || 'Untitled Claude conversation'
    const isoTimestamp = typeof c.updated_at === 'string'
      ? c.updated_at
      : (typeof c.created_at === 'string' ? c.created_at : null)
    const messages = Array.isArray(c.chat_messages) ? c.chat_messages : []
    if (messages.length === 0) continue
    const lines: string[] = [`# ${title}`, '']
    if (isoTimestamp) lines.push(`_Created: ${isoTimestamp}_`, '')
    let messageCount = 0
    for (const m of messages as any[]) {
      const sender = String(m?.sender || 'unknown')
      const text = String(m?.text || '').trim()
      if (!text) continue
      const heading = sender === 'human' ? '**You**' : (sender === 'assistant' ? '**Assistant**' : `**${sender}**`)
      lines.push(heading, '', text, '')
      messageCount++
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `claude_${c.uuid || out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'claude',
      timestamp: isoTimestamp,
      messageCount,
    })
  }
  return out
}

// ── Gemini ─────────────────────────────────────────────────────────────
// Gemini exports come via Google Takeout. There are several shapes; the most
// common one is an activity-stream JSON where each entry is a Search-style
// `{ title, time, header: "Gemini Apps" }` with an inline transcript. We
// parse defensively — anything we can't extract becomes a single-message
// markdown entry that still carries the prompt text.
function parseGemini(raw: unknown): NormalisedConversation[] {
  let items: any[] = []
  if (Array.isArray(raw)) items = raw
  else if (typeof raw === 'object' && raw !== null && Array.isArray((raw as any).activities)) {
    items = (raw as any).activities
  }
  const out: NormalisedConversation[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const i = item as Record<string, unknown>
    const header = String(i.header || '').toLowerCase()
    if (!header.includes('gemini') && !header.includes('bard')) continue
    const title = String(i.title || '').trim().slice(0, 120) || 'Gemini activity'
    const timestamp = typeof i.time === 'string' ? i.time : null
    const messages = Array.isArray(i.messages) ? i.messages : []
    const lines: string[] = [`# ${title}`, '']
    if (timestamp) lines.push(`_When: ${timestamp}_`, '')
    let messageCount = 0
    if (messages.length > 0) {
      for (const m of messages as any[]) {
        const role = String(m?.role || m?.author || 'unknown')
        const text = String(m?.text || m?.content || '').trim()
        if (!text) continue
        const heading = (role === 'user' || role === 'human') ? '**You**' : '**Assistant**'
        lines.push(heading, '', text, '')
        messageCount++
      }
    } else {
      // Single-prompt activity entry. Surface the title + body as one Q.
      lines.push('**You**', '', title, '')
      messageCount = 1
    }
    if (messageCount === 0) continue
    out.push({
      id: slugify(title, `gemini_${out.length}`),
      title,
      markdown: lines.join('\n').trim(),
      platform: 'gemini',
      timestamp,
      messageCount,
    })
  }
  return out
}

/** Parse a single JSON blob (already-decoded string). */
export function parseJsonText(text: string): ParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  const detected = detectPlatform(parsed)
  let convs: NormalisedConversation[] = []
  switch (detected) {
    case 'chatgpt': convs = parseChatGpt(parsed); break
    case 'claude': convs = parseClaude(parsed); break
    case 'gemini': convs = parseGemini(parsed); break
    default:
      // Last-ditch: try them all, return whichever produced the most output.
      const tries: Array<[ChatbotPlatform, NormalisedConversation[]]> = [
        ['chatgpt', parseChatGpt(parsed)],
        ['claude', parseClaude(parsed)],
        ['gemini', parseGemini(parsed)],
      ]
      tries.sort((a, b) => b[1].length - a[1].length)
      convs = tries[0][1]
      if (convs.length === 0) return { conversations: [], skipped: 1, detectedPlatform: 'unknown' }
  }
  const rawLen = Array.isArray(parsed) ? (parsed as unknown[]).length : 1
  const skipped = Math.max(0, rawLen - convs.length)
  return { conversations: convs, skipped, detectedPlatform: convs[0]?.platform || detected }
}

/** Parse a user-provided File (either .json or a .zip that contains conversations.json). */
export async function parseExportFile(file: File): Promise<ParseResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file)
    // Try common filenames in priority order.
    const candidates = ['conversations.json', 'data/conversations.json']
    for (const path of candidates) {
      const entry = zip.file(path)
      if (entry) {
        const text = await entry.async('string')
        return parseJsonText(text)
      }
    }
    // Fallback: pick the largest .json file inside the zip.
    let best: { path: string; size: number } | null = null
    zip.forEach((path, entry) => {
      if (!entry.dir && path.toLowerCase().endsWith('.json')) {
        const size = (entry as any)._data?.uncompressedSize || 0
        if (!best || size > best.size) best = { path, size }
      }
    })
    if (best) {
      const e = zip.file((best as { path: string; size: number }).path)
      if (e) {
        const text = await e.async('string')
        return parseJsonText(text)
      }
    }
    return { conversations: [], skipped: 0, detectedPlatform: 'unknown' }
  }
  // JSON path
  const text = await readFileAsText(file)
  return parseJsonText(text)
}

/** Convert a normalised conversation into a File the RAG uploader accepts. */
export function conversationToFile(conv: NormalisedConversation): File {
  const filename = `${conv.platform}_${conv.id}.md`
  const blob = new Blob([conv.markdown], { type: 'text/markdown' })
  return new File([blob], filename, { type: 'text/markdown' })
}
