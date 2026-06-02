// Brand mark — the LU monogram painted in the v2.5.0 accent violet.
//
// The shipped asset (`/LU-monogram.svg`) is a VECTOR glyph (white-filled paths
// on transparent — vectorised from the old 512px bitmap whose binary 1-bit alpha
// rendered visibly jagged at every size). As a CSS mask it anti-aliases perfectly
// at any size. White fill = opaque under BOTH alpha- and luminance-mask modes
// (robust against WebView2 mask-mode ambiguity; black would invert under luminance).
// Instead of shipping a separate tinted asset (and keeping it in sync), we
// render the glyph through a CSS mask and fill it with the violet token —
// so the same source asset can be painted ANY colour, and it tracks the
// design-token palette automatically. WebView2 / Chromium support
// `-webkit-mask-image`; the unprefixed `mask-*` is set too for forward-compat.
//
// Used everywhere the brand mark appears (titlebar, header, empty state) so
// the "violet LU monogram, no wordmark" identity is defined in exactly one
// place (David, 2026-06-01: "LU logo überall aber lila, LUncensored weg").
export function LuLogo({
  size = 24,
  color = 'var(--color-violet-500)',
  className = '',
  title = 'Locally Uncensored',
}: {
  size?: number
  /** Any CSS colour. Defaults to the brand violet token. */
  color?: string
  className?: string
  /** Accessible label + native tooltip; the wordmark is intentionally gone. */
  title?: string
}) {
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={className}
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        backgroundColor: color,
        WebkitMaskImage: 'url(/LU-monogram.svg)',
        maskImage: 'url(/LU-monogram.svg)',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  )
}
