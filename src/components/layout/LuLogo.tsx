// Brand mark — the LU monogram painted in the v2.5.0 accent violet.
//
// The shipped asset (`/LU-monogram-bw.png`) is a MONOCHROME glyph: the
// monogram lives in the image's ALPHA channel, the colour is irrelevant.
// Instead of shipping a separate tinted PNG (and keeping it in sync), we
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
        WebkitMaskImage: 'url(/LU-monogram-bw.png)',
        maskImage: 'url(/LU-monogram-bw.png)',
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
