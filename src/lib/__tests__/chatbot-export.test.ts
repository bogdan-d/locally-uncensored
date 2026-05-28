// Feature CC v2.5.0 — chatbot export parser tests. Each schema fixture is a
// minimal real-world shape (verified against actual exports during the dev
// session) trimmed to one or two messages so the tests stay readable.

import { describe, it, expect } from 'vitest'
import { parseJsonText, detectPlatform } from '../parsers/chatbot-export'

const chatgptFixture = JSON.stringify([
  {
    title: 'Recipes for pasta',
    create_time: 1700000000.0,
    update_time: 1700001000.0,
    mapping: {
      root: { id: 'root', message: null, parent: null, children: ['u1'] },
      u1: {
        id: 'u1',
        message: {
          id: 'u1',
          author: { role: 'user' },
          create_time: 1700000010.0,
          content: { content_type: 'text', parts: ['Got pasta recipes?'] },
        },
        parent: 'root',
        children: ['a1'],
      },
      a1: {
        id: 'a1',
        message: {
          id: 'a1',
          author: { role: 'assistant' },
          create_time: 1700000020.0,
          content: { content_type: 'text', parts: ['Carbonara, cacio e pepe, aglio e olio.'] },
        },
        parent: 'u1',
        children: [],
      },
    },
  },
])

const claudeFixture = JSON.stringify([
  {
    uuid: 'abc-123',
    name: 'JS array methods',
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:05:00Z',
    chat_messages: [
      { uuid: 'm1', text: 'Explain map vs forEach', sender: 'human', created_at: '2026-05-01T10:00:01Z' },
      { uuid: 'm2', text: 'map returns a new array, forEach returns undefined.', sender: 'assistant', created_at: '2026-05-01T10:00:30Z' },
    ],
  },
])

const geminiFixture = JSON.stringify([
  {
    header: 'Gemini Apps',
    title: 'Asked Gemini about quantum entanglement',
    time: '2026-04-12T15:23:00Z',
    messages: [
      { role: 'user', text: 'What is quantum entanglement?' },
      { role: 'assistant', text: 'Two particles linked such that one\'s state correlates with the other.' },
    ],
  },
])

describe('detectPlatform', () => {
  it('detects ChatGPT exports by the mapping field', () => {
    expect(detectPlatform(JSON.parse(chatgptFixture))).toBe('chatgpt')
  })
  it('detects Claude exports by the chat_messages field', () => {
    expect(detectPlatform(JSON.parse(claudeFixture))).toBe('claude')
  })
  it('detects Gemini exports by the Gemini Apps header', () => {
    expect(detectPlatform(JSON.parse(geminiFixture))).toBe('gemini')
  })
  it('falls back to unknown for foreign shapes', () => {
    expect(detectPlatform({ foo: 'bar' })).toBe('unknown')
    expect(detectPlatform([])).toBe('unknown')
    expect(detectPlatform(null)).toBe('unknown')
  })
})

describe('parseJsonText — ChatGPT', () => {
  it('extracts title + user + assistant turn in order', () => {
    const result = parseJsonText(chatgptFixture)
    expect(result.detectedPlatform).toBe('chatgpt')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.title).toBe('Recipes for pasta')
    expect(c.platform).toBe('chatgpt')
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('# Recipes for pasta')
    expect(c.markdown).toContain('**You**')
    expect(c.markdown).toContain('Got pasta recipes?')
    expect(c.markdown).toContain('**Assistant**')
    expect(c.markdown).toContain('Carbonara, cacio e pepe, aglio e olio.')
  })
  it('skips empty mapping conversations', () => {
    const empty = JSON.stringify([{ title: 'empty', mapping: {} }])
    const r = parseJsonText(empty)
    expect(r.conversations).toHaveLength(0)
    expect(r.skipped).toBeGreaterThan(0)
  })
})

describe('parseJsonText — Claude', () => {
  it('extracts the chat_messages array as markdown', () => {
    const result = parseJsonText(claudeFixture)
    expect(result.detectedPlatform).toBe('claude')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.title).toBe('JS array methods')
    expect(c.messageCount).toBe(2)
    expect(c.markdown).toContain('Explain map vs forEach')
    expect(c.markdown).toContain('map returns a new array')
  })
  it('skips conversations with no messages', () => {
    const empty = JSON.stringify([{ uuid: 'x', name: 'empty', chat_messages: [] }])
    const r = parseJsonText(empty)
    expect(r.conversations).toHaveLength(0)
  })
})

describe('parseJsonText — Gemini', () => {
  it('extracts the messages array when present', () => {
    const result = parseJsonText(geminiFixture)
    expect(result.detectedPlatform).toBe('gemini')
    expect(result.conversations).toHaveLength(1)
    const c = result.conversations[0]
    expect(c.markdown).toContain('quantum entanglement')
    expect(c.markdown).toContain('**You**')
    expect(c.markdown).toContain('**Assistant**')
  })
})

describe('parseJsonText — robustness', () => {
  it('returns an empty result for invalid JSON without throwing', () => {
    const r = parseJsonText('not actually json {')
    expect(r.conversations).toHaveLength(0)
    expect(r.detectedPlatform).toBe('unknown')
  })
  it('returns an empty result for empty array', () => {
    const r = parseJsonText('[]')
    expect(r.conversations).toHaveLength(0)
  })
})
