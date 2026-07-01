import { describe, it, expect } from 'vitest'
import { serializeAllConversations, parseImportedChats } from '../chat-export'
import type { Conversation } from '../../types/chat'

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `chat ${id}`,
    messages: [],
    model: 'llama3',
    systemPrompt: '',
    mode: 'lu',
    createdAt: 1,
    updatedAt: 1,
    personaEnabled: false,
    ...over,
  } as Conversation
}

// Chat backup export/import (konata 2026-06-28: web build has no store_backup.json).
describe('chat backup parse', () => {
  it('bundle roundtrips through serialize → parse', () => {
    const convs = [conv('a'), conv('b')]
    const parsed = parseImportedChats(serializeAllConversations(convs))
    expect(parsed.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('accepts a bare array export', () => {
    const parsed = parseImportedChats(JSON.stringify([conv('x')]))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('x')
  })

  it('accepts a single per-chat export object', () => {
    const parsed = parseImportedChats(JSON.stringify(conv('solo')))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].id).toBe('solo')
  })

  it('drops malformed entries but keeps valid ones', () => {
    const mixed = JSON.stringify({
      conversations: [conv('good'), { id: 5 }, null, { title: 'no messages' }],
    })
    const parsed = parseImportedChats(mixed)
    expect(parsed.map((c) => c.id)).toEqual(['good'])
  })

  it('throws on invalid JSON', () => {
    expect(() => parseImportedChats('{not json')).toThrow(/not valid JSON/i)
  })

  it('throws when nothing valid is found', () => {
    expect(() => parseImportedChats(JSON.stringify({ foo: 1 }))).toThrow(/no conversations/i)
    expect(() => parseImportedChats(JSON.stringify({ conversations: [{ id: 1 }] }))).toThrow(
      /no valid conversations/i,
    )
  })

  it('serializeAllConversations stamps a versioned bundle', () => {
    const bundle = JSON.parse(serializeAllConversations([conv('a')]))
    expect(bundle.app).toBe('locally-uncensored')
    expect(bundle.kind).toBe('chat-export')
    expect(bundle.version).toBe(1)
    expect(bundle.count).toBe(1)
  })
})
