
import { useEffect, useRef } from 'react'
import { cn } from './cn'

interface Props {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  onSubmit?: () => void
  maxHeight?: number
  autoFocus?: boolean
  className?: string
}

// Auto-grow textarea — grow logic ported from PromptInput.tsx:46-51.
export function PromptField({ value, onChange, placeholder, onSubmit, maxHeight = 220, autoFocus, className }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px'
  }, [value, maxHeight])

  return (
    <textarea
      ref={ref}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (onSubmit && (e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit() }
      }}
      placeholder={placeholder}
      rows={1}
      className={cn(
        't-body w-full resize-none bg-transparent outline-none text-gray-100 placeholder-gray-600 scrollbar-thin leading-relaxed',
        className,
      )}
      style={{ maxHeight }}
    />
  )
}