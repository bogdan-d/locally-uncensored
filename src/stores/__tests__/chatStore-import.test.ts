import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chatStore'
import type { Conversation } from '../../types/chat'

function conv(id: string, updatedAt: number, title = `chat ${id}`): Conversation {
  return {
    id,
    title,
    messages: [],
    model: 'm',
    systemPrompt: '',
    mode: 'lu',
    createdAt: 1,
    updatedAt,
    personaEnabled: false,
  } as Conversation
}

// chatStore.importConversations — konata backup restore (merge never drops chats).
describe('chatStore.importConversations', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: [], activeConversationId: null })
  })

  it('merge adds unseen conversations', () => {
    useChatStore.setState({ conversations: [conv('a', 10)] })
    const res = useChatStore.getState().importConversations([conv('b', 5), conv('c', 20)])
    expect(res).toEqual({ added: 2, skipped: 0 })
    expect(
      useChatStore
        .getState()
        .conversations.map((c) => c.id)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
  })

  it('merge skips duplicates that are not newer (existing is kept)', () => {
    useChatStore.setState({ conversations: [conv('a', 10, 'live')] })
    const res = useChatStore.getState().importConversations([conv('a', 10, 'stale')])
    expect(res).toEqual({ added: 0, skipped: 1 })
    expect(useChatStore.getState().conversations[0].title).toBe('live')
  })

  it('merge refreshes a conversation when the import is newer', () => {
    useChatStore.setState({ conversations: [conv('a', 10, 'old')] })
    const res = useChatStore.getState().importConversations([conv('a', 20, 'new')])
    expect(res).toEqual({ added: 1, skipped: 0 })
    expect(useChatStore.getState().conversations[0].title).toBe('new')
  })

  it('replace swaps the whole list', () => {
    useChatStore.setState({ conversations: [conv('a', 10)] })
    const res = useChatStore.getState().importConversations([conv('x', 1), conv('y', 2)], 'replace')
    expect(res.added).toBe(2)
    expect(
      useChatStore
        .getState()
        .conversations.map((c) => c.id)
        .sort(),
    ).toEqual(['x', 'y'])
  })

  it('sorts merged conversations by updatedAt desc', () => {
    useChatStore.setState({ conversations: [conv('a', 10)] })
    useChatStore.getState().importConversations([conv('b', 30), conv('c', 20)])
    expect(useChatStore.getState().conversations.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })
})
