/**
 * localStorage quota protection — prevents QuotaExceededError from
 * corrupting Zustand persisted stores.
 */

import type { StateStorage } from 'zustand/middleware'

const MAX_CONVERSATIONS = 100

function getLS(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

/** Estimate total localStorage usage in bytes. */
export function getStorageUsage(): { usedBytes: number; percentFull: number } {
  const ls = getLS()
  if (!ls) return { usedBytes: 0, percentFull: 0 }
  let total = 0
  for (let i = 0; i < ls.length; i++) {
    const key = ls.key(i)
    if (key) {
      total += key.length + (ls.getItem(key)?.length || 0)
    }
  }
  const usedBytes = total * 2
  const estimatedLimit = 5 * 1024 * 1024
  return { usedBytes, percentFull: usedBytes / estimatedLimit }
}

/** Prune oldest conversations from chat store to free space. */
function pruneOldConversations(): boolean {
  const ls = getLS()
  if (!ls) return false
  try {
    const raw = ls.getItem('chat-conversations')
    if (!raw) return false

    const data = JSON.parse(raw)
    if (!data?.state?.conversations || !Array.isArray(data.state.conversations)) return false

    const convs = data.state.conversations
    if (convs.length <= MAX_CONVERSATIONS) return false

    convs.sort((a: any, b: any) => (b.updatedAt || 0) - (a.updatedAt || 0))
    data.state.conversations = convs.slice(0, MAX_CONVERSATIONS)
    ls.setItem('chat-conversations', JSON.stringify(data))
    return true
  } catch {
    return false
  }
}

/**
 * Create a safe Zustand storage adapter that catches QuotaExceededError,
 * attempts to free space by pruning old conversations, and retries once.
 * Falls back to default localStorage behavior if unavailable (e.g., tests).
 */
export function createSafeStorage(): StateStorage {
  return {
    getItem(name: string): string | null {
      const ls = getLS()
      return ls ? ls.getItem(name) : null
    },
    setItem(name: string, value: string): void {
      const ls = getLS()
      if (!ls) return
      try {
        ls.setItem(name, value)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'QuotaExceededError') {
          const freed = pruneOldConversations()
          if (freed) {
            try {
              ls.setItem(name, value)
              return
            } catch {
              // Still full
            }
          }
          console.warn(`[storage-quota] QuotaExceededError for "${name}" — data not persisted`)
        } else {
          throw err
        }
      }
    },
    removeItem(name: string): void {
      const ls = getLS()
      if (ls) ls.removeItem(name)
    },
  }
}
